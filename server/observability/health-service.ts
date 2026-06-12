/**
 * health-service.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * System health check service for operational monitoring.
 *
 * Exposes:
 *   GET /api/health          → basic liveness (always fast, no DB)
 *   GET /api/health/full     → detailed readiness (DB + queue + GEE ping)
 *   GET /api/ops/status      → operational panel (admin only)
 *
 * Checks:
 *   - Database connectivity (SQL SELECT 1)
 *   - Queue worker status (in-memory or Bull)
 *   - GEE service reachability (HTTP GET /health)
 *   - SSE subscriber counts
 *   - Cache stats
 *   - Scheduler next-run info
 *   - Audit event stats
 *   - Memory usage
 *   - Uptime
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createLogger } from "./structured-logger";
import { intelligenceCache } from "./intelligence-cache";
import { getEventStats } from "./audit-event-store";
import { getSSEStats } from "../realtime/sse-manager";

const logger = createLogger("HealthService");

export interface LivenessResult {
  status: "ok";
  ts: string;
  uptime: number;
  version: string;
}

export interface HealthCheck {
  name: string;
  status: "ok" | "degraded" | "down";
  latencyMs?: number;
  detail?: string;
}

export interface FullHealthResult {
  status: "healthy" | "degraded" | "unhealthy";
  ts: string;
  uptime: number;
  version: string;
  checks: HealthCheck[];
  memory: NodeJS.MemoryUsage;
}

export interface OpsStatusResult {
  health: FullHealthResult;
  cache: ReturnType<typeof intelligenceCache.getStats>;
  sse: ReturnType<typeof getSSEStats>;
  auditEvents: ReturnType<typeof getEventStats>;
  scheduler: {
    running: boolean;
    lastCheckAt: string | null;
  };
}

const START_TIME = Date.now();
const VERSION = process.env.npm_package_version ?? "1.0.0";

// ─── Liveness (fast) ─────────────────────────────────────────────────────────

export function getLivenessResult(): LivenessResult {
  return {
    status: "ok",
    ts: new Date().toISOString(),
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    version: VERSION,
  };
}

// ─── DB check ────────────────────────────────────────────────────────────────

async function checkDatabase(): Promise<HealthCheck> {
  if (process.env.USE_DATABASE !== "true") {
    return { name: "database", status: "degraded", detail: "USE_DATABASE=false; DB checks skipped" };
  }
  const start = Date.now();
  try {
    const { db } = await import("../db");
    await db.execute("SELECT 1");
    return { name: "database", status: "ok", latencyMs: Date.now() - start };
  } catch (err: any) {
    logger.error("DB health check failed", { error: err.message });
    return { name: "database", status: "down", detail: err.message };
  }
}

// ─── GEE service check ────────────────────────────────────────────────────────

async function checkGEEService(): Promise<HealthCheck> {
  const geeUrl = process.env.GEE_SERVICE_URL;
  if (!geeUrl) {
    return { name: "gee_service", status: "degraded", detail: "GEE_SERVICE_URL not configured" };
  }
  const start = Date.now();
  try {
    const { default: axios } = await import("axios");
    await axios.get(`${geeUrl}/health`, { timeout: 5000 });
    return { name: "gee_service", status: "ok", latencyMs: Date.now() - start };
  } catch (err: any) {
    return { name: "gee_service", status: "down", detail: err.message };
  }
}

// ─── Queue check ─────────────────────────────────────────────────────────────

async function checkQueue(): Promise<HealthCheck> {
  try {
    const { analysisQueue } = await import("../mrv/analysis-queue");
    const stats = analysisQueue.getStats();
    const status = stats.mode === "bull"
      ? "ok"
      : stats.mode === "memory"
        ? "degraded"
        : "down";
    return {
      name: "mrv_queue",
      status,
      detail: `mode=${stats.mode} pending=${stats.pending} active=${stats.active}`,
    };
  } catch (err: any) {
    return { name: "mrv_queue", status: "down", detail: err.message };
  }
}

// ─── Full readiness ───────────────────────────────────────────────────────────

export async function getFullHealthResult(): Promise<FullHealthResult> {
  const [dbCheck, geeCheck, queueCheck] = await Promise.allSettled([
    checkDatabase(),
    checkGEEService(),
    checkQueue(),
  ]);

  const checks: HealthCheck[] = [
    dbCheck.status === "fulfilled" ? dbCheck.value : { name: "database", status: "down" as const },
    geeCheck.status === "fulfilled" ? geeCheck.value : { name: "gee_service", status: "down" as const },
    queueCheck.status === "fulfilled" ? queueCheck.value : { name: "mrv_queue", status: "down" as const },
  ];

  const hasDown = checks.some((c) => c.status === "down");
  const hasDegraded = checks.some((c) => c.status === "degraded");
  const overallStatus = hasDown ? "unhealthy" : hasDegraded ? "degraded" : "healthy";

  return {
    status: overallStatus,
    ts: new Date().toISOString(),
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    version: VERSION,
    checks,
    memory: process.memoryUsage(),
  };
}

// ─── Ops status ───────────────────────────────────────────────────────────────

let _lastSchedulerCheckAt: string | null = null;
let _schedulerRunning = false;

export function setSchedulerStatus(running: boolean, lastCheckAt: string | null) {
  _schedulerRunning = running;
  _lastSchedulerCheckAt = lastCheckAt;
}

export async function getOpsStatus(): Promise<OpsStatusResult> {
  const health = await getFullHealthResult();
  return {
    health,
    cache: intelligenceCache.getStats(),
    sse: getSSEStats(),
    auditEvents: getEventStats(),
    scheduler: {
      running: _schedulerRunning,
      lastCheckAt: _lastSchedulerCheckAt,
    },
  };
}
