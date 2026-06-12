import dotenv from "dotenv";
dotenv.config();

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import express, { type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

// ─── Sentry Error Tracking (Task 5.3) ───────────────────────────────────────────
// Initialize Sentry only in production when SENTRY_DSN is available
// Using dynamic require to avoid build errors when package is not installed
const SENTRY_DSN = process.env.SENTRY_DSN;
const isProduction = process.env.NODE_ENV === "production";

async function initSentry() {
  if (isProduction && SENTRY_DSN) {
    try {
      // Dynamic import for optional dependency
      const Sentry = await import("@sentry/node");
      Sentry.default.init({
        dsn: SENTRY_DSN,
        tracesSampleRate: 1.0,
        environment: process.env.NODE_ENV || "production",
        release: "bluecarbon-ledger@1.0.0",
      });
      console.log("✅ Sentry error tracking enabled for production");
    } catch (err) {
      console.warn("⚠️ Sentry package not available:", err);
    }
  } else if (isProduction && !SENTRY_DSN) {
    console.warn("⚠️ Production mode but SENTRY_DSN not set - Sentry disabled");
  }
}

initSentry();

import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { initGEE } from "./geeService";
import { startMRVInfrastructure } from "./mrv/bootstrap";
import { getValidatedEnv } from "./observability/env-validator";
import { appendAuditEvent } from "./observability/audit-event-store";
import { globalErrorHandler, registerProcessErrorHandlers } from "./observability/error-boundary";
import { requestTimingMiddleware } from "./observability/performance-profiler";


const app = express();

// ─── Security Headers (Task 1.2) ─────────────────────────────────────────────
// helmet sets X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security,
// Content-Security-Policy, and more — all production-grade defaults.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false
  })
);
// ─── Rate Limiting (Task 1.2) ─────────────────────────────────────────────────
// Strict limit on auth endpoints to prevent brute-force attacks.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 20,                   // max 20 attempts per window per IP
  standardHeaders: true,     // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false,
  message: {
    error: "Too many requests from this IP. Please try again after 15 minutes.",
  },
  // Skip rate limiting in test environments
  skip: () => process.env.NODE_ENV === "test",
});

// General API rate limit — prevents scraping and DoS
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1-minute window
  max: 200,                  // 200 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
  skip: () => process.env.NODE_ENV === "test",
});

// Apply auth limiter to authentication routes
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);

// Apply general limiter to all other API routes
app.use("/api", apiLimiter);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: false }));

// ─── Request timing (performance profiler) ────────────────────────────────────
app.use(requestTimingMiddleware);

// ─── MRV Reports Static Serving ──────────────────────────────────────────────
app.use('/mrv-reports', express.static(path.join(__dirname, '../mrv-service/reports')));

// ─── Request Logger + Slow API Alert (Task 5.4) ───────────────────────────────
// Logs all API requests with duration. Emits a WARNING for responses > 500ms.
const SLOW_RESPONSE_THRESHOLD_MS = 500;

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      // ⚠️  Slow API alert — logs a warning for any response exceeding threshold
      if (duration > SLOW_RESPONSE_THRESHOLD_MS) {
        console.warn(
          `⚠️  SLOW API ALERT: ${req.method} ${path} took ${duration}ms (threshold: ${SLOW_RESPONSE_THRESHOLD_MS}ms)`
        );
      }

      log(logLine);
    }
  });

  next();
});

// ─── CORS ──────────────────────────────────────────────────────────────
// In production set CORS_ORIGINS to a comma-separated list of allowed origins.
// Falls back to wildcard only in development.
// Trust only the first proxy hop (load balancer/nginx). "true" trusts all proxies
// which allows IP spoofing; 1 trusts only the immediate upstream proxy.
app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : false);
app.use((req, res, next) => {
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
    : null;
  const origin = req.headers.origin ?? "";
  const allowOrigin =
    !allowedOrigins || allowedOrigins.includes(origin) ? origin || "*" : "";
  if (allowOrigin) res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

(async () => {
  // Validate environment first — throws in production if critical vars missing
  const env = getValidatedEnv();

  appendAuditEvent({
    category: "SYSTEM",
    severity: "INFO",
    action: "server.startup",
    detail: `Server starting in ${env.nodeEnv} mode on port ${env.port}`,
  });

  try {
    await initGEE();
  } catch (err) {
    console.error("Failed to initialize GEE:", err);
  }

  try {
    await startMRVInfrastructure();
  } catch (err) {
    console.error("Failed to initialize MRV infrastructure:", err);
  }

  // Register process-level error handlers (unhandledRejection, uncaughtException, SIGTERM)
  registerProcessErrorHandlers();

  const server = await registerRoutes(app);

  // Centralized error boundary — must be registered AFTER routes
  app.use(globalErrorHandler);

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  const isDevelopment = process.env.NODE_ENV !== "production";
  log(`Environment: ${process.env.NODE_ENV || "development (default)"}`);
  if (isDevelopment) {
    log("Setting up Vite for development");
    await setupVite(app, server);
  } else {
    log("Serving static files for production");
    serveStatic(app);
  }
  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5002", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
    }
  );
})();
