/**
 * Structured Operational Logger — PHASE PROD-3
 * Emits JSON-structured log lines for all long-running operations.
 * Carries correlation IDs, project/run IDs, and timing so log aggregators
 * (CloudWatch, Datadog, etc.) can trace a full MRV+evidence+insight pipeline.
 */

export type LogLevel = "info" | "warn" | "error" | "debug";

export type OperationName =
  | "mrv_job"
  | "evidence_package"
  | "insight_generation"
  | "portfolio_intelligence"
  | "report_build"
  | "satellite_image"
  | "gee_workflow"
  | "scheduler_tick";

export interface OperationContext {
  operationName: OperationName;
  correlationId: string;
  projectId?: string | null;
  runId?: string | null;
  jobId?: string | null;
  triggeredBy?: string | null;
}

interface LogPayload {
  level: LogLevel;
  operation: OperationName;
  correlationId: string;
  projectId?: string | null;
  runId?: string | null;
  jobId?: string | null;
  event: string;
  durationMs?: number;
  data?: Record<string, unknown>;
  error?: string;
  ts: string;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
function shouldLog(level: LogLevel): boolean {
  const configured = (process.env.LOG_LEVEL ?? "info") as LogLevel;
  return LOG_LEVEL_PRIORITY[level] >= (LOG_LEVEL_PRIORITY[configured] ?? 1);
}

function emit(payload: LogPayload): void {
  if (!shouldLog(payload.level)) return;
  if (process.env.NODE_ENV === "development") {
    // Human-readable in dev
    const tag = `[${payload.operation}][${payload.correlationId.slice(-8)}]`;
    const parts = [tag, payload.event];
    if (payload.projectId) parts.push(`project=${payload.projectId.slice(0, 8)}`);
    if (payload.runId) parts.push(`run=${payload.runId.slice(0, 16)}`);
    if (payload.durationMs !== undefined) parts.push(`${payload.durationMs}ms`);
    if (payload.error) parts.push(`error="${payload.error}"`);
    const fn = payload.level === "error" ? console.error : payload.level === "warn" ? console.warn : console.log;
    fn(`[PROD-3][${payload.level.toUpperCase()}] ${parts.join(" ")}`);
  } else {
    // Structured JSON in production
    console.log(JSON.stringify(payload));
  }
}

export class OperationLogger {
  private ctx: OperationContext;
  private startMs: number;

  constructor(ctx: OperationContext) {
    this.ctx = ctx;
    this.startMs = Date.now();
  }

  private base(): Omit<LogPayload, "level" | "event"> {
    return {
      operation: this.ctx.operationName,
      correlationId: this.ctx.correlationId,
      projectId: this.ctx.projectId ?? null,
      runId: this.ctx.runId ?? null,
      jobId: this.ctx.jobId ?? null,
      ts: new Date().toISOString(),
    };
  }

  elapsed(): number {
    return Date.now() - this.startMs;
  }

  info(event: string, data?: Record<string, unknown>): void {
    emit({ level: "info", ...this.base(), event, data });
  }

  warn(event: string, data?: Record<string, unknown>): void {
    emit({ level: "warn", ...this.base(), event, data });
  }

  error(event: string, err: unknown, data?: Record<string, unknown>): void {
    const error = err instanceof Error ? err.message : String(err);
    emit({ level: "error", ...this.base(), event, error, data });
  }

  done(event: string, data?: Record<string, unknown>): void {
    emit({ level: "info", ...this.base(), event, durationMs: this.elapsed(), data });
  }
}

/** Create a logger for an operation. correlationId ties all sub-steps together. */
export function oplog(ctx: OperationContext): OperationLogger {
  return new OperationLogger(ctx);
}

/** Generate a short correlation ID: operation prefix + timestamp + random. */
export function newCorrelationId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
