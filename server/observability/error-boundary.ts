/**
 * server/observability/error-boundary.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralized server-side error boundary:
 *   - Express global error handler middleware
 *   - Unhandled rejection + uncaught exception safety net
 *   - Structured error classification (operational vs programmer)
 *   - Audit event integration on 500-class errors
 *   - Sentry-compatible hook (optional)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Request, Response, NextFunction } from "express";
import { appendAuditEvent } from "./audit-event-store";
import { createLogger } from "./structured-logger";

const log = createLogger("ErrorBoundary");

// ─── Error classification ─────────────────────────────────────────────────────

interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean; // true = expected/handled; false = programmer error
  code?: string;
}

function classifyError(err: AppError): { statusCode: number; message: string; isOperational: boolean } {
  // Known HTTP errors from express/zod/drizzle
  if (err.statusCode && err.statusCode < 500) {
    return { statusCode: err.statusCode, message: err.message, isOperational: true };
  }
  // Postgres errors
  if ((err as any).code === "23505") {
    return { statusCode: 409, message: "Duplicate entry — resource already exists", isOperational: true };
  }
  if ((err as any).code === "23503") {
    return { statusCode: 409, message: "Foreign key constraint violation", isOperational: true };
  }
  if ((err as any).code === "22P02") {
    return { statusCode: 400, message: "Invalid input format", isOperational: true };
  }
  // Drizzle / DB connection errors
  if (err.message?.includes("ECONNREFUSED") || err.message?.includes("ETIMEDOUT")) {
    return { statusCode: 503, message: "Database unavailable", isOperational: true };
  }
  // Programmer / unknown error
  return { statusCode: 500, message: "Internal server error", isOperational: false };
}

// ─── Express error middleware ─────────────────────────────────────────────────

export function globalErrorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const { statusCode, message, isOperational } = classifyError(err);

  // Structured log
  if (statusCode >= 500) {
    log.error("Unhandled request error", {
      method: req.method,
      path: req.path,
      statusCode,
      isOperational,
      stack: err.stack,
    });
  } else if (statusCode >= 400) {
    log.warn("Client error", { method: req.method, path: req.path, statusCode, message });
  }

  // Audit critical server errors
  if (statusCode >= 500) {
    appendAuditEvent({
      category: "SYSTEM",
      severity: isOperational ? "WARN" : "ERROR",
      action: "request.error",
      detail: `${req.method} ${req.path} → ${statusCode}: ${err.message?.slice(0, 200)}`,
    });
  }

  // Never leak stack traces to clients in production
  const responseBody: Record<string, unknown> = {
    error: message,
    code: err.code,
  };
  if (process.env.NODE_ENV !== "production" && err.stack) {
    responseBody.stack = err.stack;
  }

  // Only send if headers not already sent
  if (!res.headersSent) {
    res.status(statusCode).json(responseBody);
  }
}

// ─── Process-level safety nets ────────────────────────────────────────────────

export function registerProcessErrorHandlers(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;

    log.error("Unhandled promise rejection", { reason: msg, stack });

    appendAuditEvent({
      category: "SYSTEM",
      severity: "ERROR",
      action: "process.unhandledRejection",
      detail: msg.slice(0, 500),
    });

    // Do NOT crash the process — let PM2/supervisor handle restart decisions
    // In a future iteration, use domain or AsyncLocalStorage for per-request tracking
  });

  process.on("uncaughtException", (err: Error) => {
    log.error("Uncaught exception — process will restart", {
      message: err.message,
      stack: err.stack,
    });

    appendAuditEvent({
      category: "SYSTEM",
      severity: "CRITICAL",
      action: "process.uncaughtException",
      detail: err.message.slice(0, 500),
    });

    // Flush audit events (best-effort) then exit — PM2 will restart
    setTimeout(() => process.exit(1), 1000);
  });

  process.on("SIGTERM", () => {
    log.info("SIGTERM received — initiating graceful shutdown");
    appendAuditEvent({
      category: "SYSTEM",
      severity: "INFO",
      action: "server.sigterm",
      detail: "Graceful shutdown initiated",
    });
    // Allow existing connections to drain (PM2 kill_timeout handles force kill)
    setTimeout(() => process.exit(0), 8000);
  });
}
