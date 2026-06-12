import { EventEmitter } from "events";
import type { AnalysisJobPayload, GEEExecutionResult, MonitoringCycleStatus } from "./types";

export type MRVLifecycleEvent =
  | { type: "job.enqueued"; payload: AnalysisJobPayload }
  | { type: "job.started"; payload: AnalysisJobPayload }
  | { type: "job.progress"; payload: { projectId: string; progress: number; label: string; status: MonitoringCycleStatus } }
  | { type: "job.completed"; payload: { projectId: string; result: GEEExecutionResult } }
  | { type: "job.failed"; payload: { projectId: string; error: string; retryCount: number } };

class MRVEventBus extends EventEmitter {
  publish(event: MRVLifecycleEvent) {
    this.emit(event.type, event.payload);
    this.emit("all", event);
  }
}

export const mrvEventBus = new MRVEventBus();

