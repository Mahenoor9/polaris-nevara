/**
 * env-validator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Production-safe environment variable validation.
 *
 * Called once at startup (before route registration).
 * - In production: WARNS for missing recommended variables, THROWS for required ones
 * - In development: only warns; never throws
 * - Provides a typed config object consumed by services
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createLogger } from "./structured-logger";

const logger = createLogger("EnvValidator");

export interface ValidatedEnv {
  nodeEnv: string;
  port: number;
  useDatabase: boolean;
  databaseUrl: string | null;
  redisUrl: string | null;
  geeServiceUrl: string | null;
  jwtSecret: string;
  sentryDsn: string | null;
  logLevel: string;
  // Feature flags derived from env
  features: {
    redis: boolean;
    gee: boolean;
    sentry: boolean;
    pdfRendering: boolean;
  };
}

interface EnvSpec {
  key: string;
  required: boolean;
  productionOnly?: boolean;
  description: string;
  default?: string;
  redact?: boolean;
}

const ENV_SPECS: EnvSpec[] = [
  {
    key: "DATABASE_URL",
    required: false,
    productionOnly: true,
    description: "PostgreSQL connection string for primary DB",
    redact: true,
  },
  {
    key: "JWT_SECRET",
    required: true,
    description: "JWT signing secret (min 32 chars in production)",
    redact: true,
  },
  {
    key: "REDIS_URL",
    required: false,
    description: "Redis connection URL for queue + cache",
    redact: true,
  },
  {
    key: "GEE_SERVICE_URL",
    required: false,
    description: "Internal URL of the Python GEE microservice",
  },
  {
    key: "SENTRY_DSN",
    required: false,
    productionOnly: true,
    description: "Sentry error tracking DSN",
    redact: true,
  },
  {
    key: "NODE_ENV",
    required: false,
    description: "Node environment (development | production)",
    default: "development",
  },
  {
    key: "LOG_LEVEL",
    required: false,
    description: "Logging level (debug | info | warn | error)",
    default: "info",
  },
];

export function validateEnvironment(): ValidatedEnv {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const isProd = nodeEnv === "production";
  const issues: string[] = [];
  const warnings: string[] = [];

  for (const spec of ENV_SPECS) {
    const val = process.env[spec.key];
    const isSet = val !== undefined && val.trim() !== "";

    if (spec.required && !isSet) {
      issues.push(`${spec.key} is required — ${spec.description}`);
    } else if (!isSet && spec.productionOnly && isProd) {
      warnings.push(`${spec.key} not set in production — ${spec.description}`);
    } else if (!isSet && !spec.required) {
      // Optional — no noise
    }

    // Weak secret detection
    if (spec.key === "JWT_SECRET" && isSet && isProd) {
      if ((val?.length ?? 0) < 32) {
        issues.push("JWT_SECRET must be at least 32 characters in production");
      }
    }
  }

  // Log warnings
  for (const w of warnings) {
    logger.warn("Missing recommended env var", { warning: w });
  }

  // In production, throw on hard errors
  if (isProd && issues.length > 0) {
    for (const issue of issues) {
      logger.error("Critical env validation failure", { issue });
    }
    throw new Error(
      `[EnvValidator] Production startup blocked — fix environment:\n${issues.join("\n")}`
    );
  } else if (issues.length > 0) {
    for (const issue of issues) {
      logger.warn("Env validation issue (dev mode — continuing)", { issue });
    }
  }

  const redisUrl = process.env.REDIS_URL ?? null;
  const geeUrl = process.env.GEE_SERVICE_URL ?? null;
  const sentryDsn = process.env.SENTRY_DSN ?? null;
  const databaseUrl = process.env.DATABASE_URL ?? null;

  const config: ValidatedEnv = {
    nodeEnv,
    port: parseInt(process.env.PORT ?? "5002", 10),
    useDatabase: process.env.USE_DATABASE === "true",
    databaseUrl,
    redisUrl,
    geeServiceUrl: geeUrl,
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-in-production",
    sentryDsn,
    logLevel: process.env.LOG_LEVEL ?? "info",
    features: {
      redis: !!redisUrl,
      gee: !!geeUrl,
      sentry: isProd && !!sentryDsn,
      pdfRendering: true, // always attempt; graceful fallback in pdf-renderer
    },
  };

  logger.info("Environment validated", {
    nodeEnv,
    features: config.features,
    useDatabase: config.useDatabase,
  });

  return config;
}

// Singleton — call once at startup
let _config: ValidatedEnv | null = null;

export function getValidatedEnv(): ValidatedEnv {
  if (!_config) {
    _config = validateEnvironment();
  }
  return _config;
}
