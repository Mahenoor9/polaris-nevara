/**
 * bootstrap.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MRV Infrastructure bootstrap.
 * - Starts queue workers + scheduler
 * - Wires mrvEventBus → SSE push (real-time frontend updates)
 * - Wires mrvEventBus → AuditEventStore (persistent lifecycle log)
 * - Initialises monitoring progress tracker
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { monitoringOrchestratorService } from "./monitoring-orchestrator";
import { monitoringSchedulerService } from "../scheduler/monitoring-scheduler";
import { mrvEventBus } from "./lifecycle-events";
import { monitoringProgressTracker } from "./progress-tracker";
import { pushProgressEvent } from "../realtime/sse-manager";
import { appendAuditEvent } from "../observability/audit-event-store";
import { createLogger } from "../observability/structured-logger";
import type { MRVLifecycleEvent } from "./lifecycle-events";
import type { MonitoringCycleStatus } from "./types";

const logger = createLogger("MRV:Bootstrap");

let initialized = false;
interface ProgressEventPayload {
  projectId: string;
  progress: number;
  label: string;
  status: MonitoringCycleStatus;
}

export async function startMRVInfrastructure(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await monitoringOrchestratorService.startWorkers();
  await monitoringSchedulerService.start();

  // ── Wire progress tracker ─────────────────────────────────────────────────
  mrvEventBus.on("job.progress", (payload: ProgressEventPayload) => {
    monitoringProgressTracker.set(payload.projectId, payload.progress, payload.label, payload.status);

    // Push to SSE subscribers watching this project
    pushProgressEvent({
      projectId: payload.projectId,
      progress: payload.progress,
      step: payload.label,
      status: payload.status,
      label: payload.label,
      ts: new Date().toISOString(),
    });
  });

  // ── Wire audit event store ────────────────────────────────────────────────
  mrvEventBus.on("all", (event: MRVLifecycleEvent) => {
    const projectId = "projectId" in event.payload ? event.payload.projectId : undefined;

    let action = event.type;
    let detail = "";
    let severity: "INFO" | "WARN" | "ERROR" = "INFO";

    switch (event.type) {
      case "job.enqueued":
        detail = `Analysis job enqueued for project ${projectId}`;
        break;
      case "job.started":
        detail = `Analysis started for project ${projectId}`;
        break;
      case "job.progress":
        detail = `Progress ${event.payload.progress}% — ${event.payload.label}`;
        break;
      case "job.completed":
        detail = `Analysis completed for project ${projectId}`;
        break;
      case "job.failed":
        detail = `Analysis FAILED: ${"error" in event.payload ? event.payload.error : "unknown"} (retry ${"retryCount" in event.payload ? event.payload.retryCount : 0})`;
        severity = "ERROR";
        break;
    }

    appendAuditEvent({
      category: "MRV",
      severity,
      projectId,
      action,
      detail,
    });

    logger.info(`[Event] ${event.type}`, { projectId, detail });
  });

  logger.info("Infrastructure started (queue + orchestrator + scheduler + SSE + audit).");
}
