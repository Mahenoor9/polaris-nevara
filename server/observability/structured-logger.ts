/**
 * structured-logger.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralized structured logging for the MRV / Ecological Monitoring system.
 * - Emits JSON in production (machine-parseable by log aggregators)
 * - Emits colored human-readable text in development
 * - Supports named sub-loggers (child loggers) with module context tags
 * - Severity levels: debug | info | warn | error
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  data?: Record<string, unknown>;
}

const LEVEL_RANKS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined) ??
  (process.env.NODE_ENV === "production" ? "info" : "debug");

const IS_PROD = process.env.NODE_ENV === "production";

const DEV_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m",  // green
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

function emit(entry: LogEntry) {
  if (LEVEL_RANKS[entry.level] < LEVEL_RANKS[MIN_LEVEL]) return;

  if (IS_PROD) {
    process.stdout.write(JSON.stringify(entry) + "\n");
    return;
  }

  const color = DEV_COLORS[entry.level];
  const tag = `[${entry.ts.slice(11, 23)}] ${color}${entry.level.toUpperCase().padEnd(5)}${RESET} [${entry.module}]`;
  const dataStr = entry.data ? " " + JSON.stringify(entry.data) : "";
  console.log(`${tag} ${entry.msg}${dataStr}`);
}

export class StructuredLogger {
  constructor(private readonly module: string) {}

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>) {
    emit({
      ts: new Date().toISOString(),
      level,
      module: this.module,
      msg,
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    });
  }

  debug(msg: string, data?: Record<string, unknown>) {
    this.log("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>) {
    this.log("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>) {
    this.log("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>) {
    this.log("error", msg, data);
  }

  /** Create a child logger that inherits module name with a sub-suffix */
  child(subModule: string): StructuredLogger {
    return new StructuredLogger(`${this.module}:${subModule}`);
  }
}

/** Factory — use this in every module */
export function createLogger(module: string): StructuredLogger {
  return new StructuredLogger(module);
}
