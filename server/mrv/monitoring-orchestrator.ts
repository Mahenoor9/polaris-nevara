import { parsePolygonFromLandBoundary } from "../gis/polygon-ingestion";
import { geeIntegrationService } from "./gee-integration-service";
import { mrvEventBus } from "./lifecycle-events";
import { MonitoringStateMachine } from "./monitoring-state-machine";
import { monitoringProgressTracker } from "./progress-tracker";
import { analysisQueueService } from "./analysis-queue";
import { monitoringCycleRepository } from "./monitoring-cycle-repository";
import { observationProcessingService } from "./observation-processing-service";
import type { AnalysisJobPayload, MonitoringState, MonitoringTransition, MonitoringCycleType } from "./types";
import { storage } from "../storage";
import { computeNextMonitoringDate } from "../scheduler/monitoring-schedule-service";
import { invalidateProjectCache } from "../observability/intelligence-cache";

import { evidenceService, generateRunId } from "../evidence/evidenceService";
import { runLSTWorkflow } from "../gee/workflow-02-lst";
import { runLULCWorkflow } from "../gee/workflow-06-lulc";
import { runHistoricalWorkflow } from "../gee/workflow-05-historical";
import { runDemHydrologyWorkflow } from "../gee/workflow-04-dem-hydro";
import { runRestorationWorkflow } from "../gee/workflow-03-restoration";
import { runRiskEngine } from "../intelligence/workflow-risk-engine";
import { exportEvidenceImages } from "../evidence/evidence-image-orchestrator";

import type { LSTResult } from "../gee/workflow-02-lst";
import type { LULCResult } from "../gee/workflow-06-lulc";
import type { HistoricalResult } from "../gee/workflow-05-historical";
import type { HydrologyResult } from "../gee/workflow-04-dem-hydro";
import type { RestorationResult } from "../gee/workflow-03-restoration";
import type { RiskEngineResult } from "../intelligence/workflow-risk-engine";
import type { AssetRecord } from "../evidence/evidenceTypes";
import { oplog, newCorrelationId } from "../observability/operational-logger";

const DEFAULT_RETRY_LIMIT = 3;
const LOG_PREFIX = "[MRV] [ORCHESTRATOR]";

class MonitoringStateStore {
  private states = new Map<string, MonitoringState>();

  get(projectId: string): MonitoringState {
    return this.states.get(projectId) ?? "DRAFT";
  }

  transition(projectId: string, transition: MonitoringTransition): MonitoringState {
    const current = this.get(projectId);
    if (!MonitoringStateMachine.canTransition(current, transition)) {
      throw new Error(`Invalid monitoring transition ${transition} from ${current}`);
    }
    const next = MonitoringStateMachine.getNextState(current, transition);
    this.states.set(projectId, next);
    return next;
  }

  force(projectId: string, state: MonitoringState) {
    this.states.set(projectId, state);
  }
}

export class MonitoringOrchestratorService {
  private stateStore = new MonitoringStateStore();
  private started = false;

  async startWorkers(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await analysisQueueService.initialize();
    await analysisQueueService.registerProcessor((payload) => this.processAnalysisJob(payload));
  }

  async triggerBaselineAnalysis(params: {
    projectId: string;
    landBoundary: string;
    triggeredBy: string;
  }): Promise<{ jobId: string; queueMode: "bull" | "memory" }> {
    console.log(`[MRV] [GIS] Parsing land boundary for baseline project ${params.projectId}`);
    const parsed = parsePolygonFromLandBoundary(params.landBoundary);
    if (parsed.warnings.length > 0) {
      console.warn(`[MRV] [GIS] Warnings during polygon ingestion for ${params.projectId}:`, parsed.warnings);
    }
    this.stateStore.force(params.projectId, "POLYGON_SUBMITTED");
    this.stateStore.transition(params.projectId, "START_GIS_ANALYSIS");

    const cycleId = await monitoringCycleRepository.createCycle({
      projectId: params.projectId,
      cycleType: "baseline",
      triggeredBy: params.triggeredBy,
      status: "pending",
      fixedCycleNumber: 0,
    });

    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(now.getDate() - 45);

    const runId = generateRunId();
    void (async () => {
      try {
        await storage.createAnalysisRun({ runId, projectId: params.projectId });
      } catch (err) {
        console.warn(`${LOG_PREFIX} createAnalysisRun failed (non-blocking):`, err instanceof Error ? err.message : err);
      }
    })();

    const queued = await analysisQueueService.enqueue({
      projectId: params.projectId,
      cycleType: "baseline",
      cycleId,
      polygon: parsed.polygon,
      triggeredBy: params.triggeredBy,
      startDate: startDate.toISOString().slice(0, 10),
      endDate: now.toISOString().slice(0, 10),
      runId,
    });

    monitoringProgressTracker.set(params.projectId, 10, "queued", "RUNNING");
    await storage.updateProjectMrvStatus(params.projectId, "RUNNING");
    return { jobId: queued.jobId, queueMode: queued.mode };
  }

  async triggerScheduledMonitoring(params: {
    projectId: string;
    landBoundary: string;
    triggeredBy: string;
  }): Promise<{ jobId: string; queueMode: "bull" | "memory" }> {
    console.log(`[MRV] [GIS] Parsing land boundary for scheduled project ${params.projectId}`);
    const parsed = parsePolygonFromLandBoundary(params.landBoundary);
    if (parsed.warnings.length > 0) {
      console.warn(`[MRV] [GIS] Warnings during polygon ingestion for ${params.projectId}:`, parsed.warnings);
    }
    const cycleId = await monitoringCycleRepository.createCycle({
      projectId: params.projectId,
      cycleType: "scheduled",
      triggeredBy: params.triggeredBy,
      status: "pending",
    });

    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(now.getDate() - 45);

    const runId = generateRunId();
    void (async () => {
      try {
        await storage.createAnalysisRun({ runId, projectId: params.projectId });
      } catch (err) {
        console.warn(`${LOG_PREFIX} createAnalysisRun failed (non-blocking):`, err instanceof Error ? err.message : err);
      }
    })();

    const queued = await analysisQueueService.enqueue({
      projectId: params.projectId,
      cycleType: "scheduled",
      cycleId,
      polygon: parsed.polygon,
      triggeredBy: params.triggeredBy,
      startDate: startDate.toISOString().slice(0, 10),
      endDate: now.toISOString().slice(0, 10),
      runId,
    });

    monitoringProgressTracker.set(params.projectId, 10, "queued", "RUNNING");
    await storage.updateProjectMrvStatus(params.projectId, "RUNNING");
    return { jobId: queued.jobId, queueMode: queued.mode };
  }

  async getStatus(projectId: string): Promise<{ status: string; progress: number; step: string }> {
    const project = await storage.getProject(projectId);
    const snapshot = monitoringProgressTracker.get(projectId);
    return {
      status: project?.mrvStatus?.toUpperCase() || "IDLE",
      progress: snapshot?.progress ?? (project?.mrvStatus?.toUpperCase() === "COMPLETED" ? 100 : 0),
      step: snapshot?.label ?? (project?.mrvStatus?.toUpperCase() || "Not started"),
    };
  }

  async cancel(projectId: string): Promise<void> {
    monitoringProgressTracker.set(projectId, 0, "cancelled", "CANCELLED");
    await storage.updateProjectMrvStatus(projectId, "CANCELLED");
  }

  async processDueProjects(limit = 50): Promise<{ processed: number }> {
    const dueProjects = await monitoringCycleRepository.getDueProjects(limit);
    let processed = 0;
    for (const project of dueProjects) {
      if (!project.landBoundary) continue;
      await this.triggerScheduledMonitoring({
        projectId: project.id,
        landBoundary: project.landBoundary,
        triggeredBy: "system:scheduler",
      });
      processed += 1;
    }
    return { processed };
  }

  private async processAnalysisJob(payload: AnalysisJobPayload): Promise<void> {
    const correlationId = newCorrelationId("mrv");
    const log = oplog({
      operationName: "mrv_job",
      correlationId,
      projectId: payload.projectId,
      runId: payload.runId ?? null,
      jobId: payload.jobId,
      triggeredBy: payload.triggeredBy,
    });
    log.info("job.started", { cycleType: payload.cycleType, retryCount: payload.retryCount ?? 0 });
    console.log(`[MRV] [ORCHESTRATOR] [Workflow Started] Job ${payload.jobId} for project ${payload.projectId} cid=${correlationId}`);
    const retryCount = payload.retryCount ?? 0;
    mrvEventBus.publish({ type: "job.started", payload });
    this.setProgress(payload.projectId, 20, "collecting imagery", "RUNNING");

    if (payload.cycleType === "baseline" && retryCount === 0) {
      try {
        this.stateStore.transition(payload.projectId, "START_GIS_ANALYSIS");
      } catch {
        this.stateStore.force(payload.projectId, "GIS_ANALYSIS_RUNNING");
      }
    }

    if (payload.cycleId) {
      await monitoringCycleRepository.updateCycleStatus(payload.cycleId, "imagery_collection");
    }

    try {
      await geeIntegrationService.notifyExternalLifecycle("analysis.started", {
        projectId: payload.projectId,
        cycleType: payload.cycleType,
      });

      this.setProgress(payload.projectId, 45, "analyzing", "RUNNING");
      if (payload.cycleId) {
        await monitoringCycleRepository.updateCycleStatus(payload.cycleId, "analyzing");
      }

      console.log(`[MRV_TRACE] GEE pipeline ENTER — project=${payload.projectId} jobId=${payload.jobId} cycleType=${payload.cycleType}`);
      const geeStartedAt = Date.now();
      const geeResult = payload.cycleType === "scheduled"
        ? await geeIntegrationService.runScheduledMonitoringAnalysis(payload)
        : await geeIntegrationService.runBaselineAnalysis(payload);
      console.log(`[MRV_TRACE] GEE pipeline EXIT — project=${payload.projectId} duration=${Date.now() - geeStartedAt}ms observations=${geeResult.observations.length} mrvServiceUsed=false fallback=${geeResult.hooks.fallbackUsed}`);

      console.log(`[MRV] [ANALYSIS] Computing deltas and EHI for project ${payload.projectId}`);
      this.setProgress(payload.projectId, 80, "persisting observations", "RUNNING");
      if (!payload.cycleId) {
        throw new Error("Missing cycleId for observation persistence.");
      }
      await observationProcessingService.persistResult(payload.projectId, payload.cycleId, geeResult);

      // Find NDVI observation to save measurements & MRV scores in standard storage
      const ndviObs = geeResult.observations.find((o) => o.observationType === "ndvi");
      const ndviMean = ndviObs?.valueMean ?? 0.0;

      console.log(`[MRV] [ORCHESTRATOR] Creating NDVI measurement for project ${payload.projectId} with mean=${ndviMean}`);
      await storage.createNdviMeasurement({
        projectId: payload.projectId,
        ndviMean,
        ndviMin: ndviObs?.valueMin ?? null,
        ndviMax: ndviObs?.valueMax ?? null,
        cloudCoverPct: geeResult.hooks.cloudThresholdPct ?? 30.0,
        satelliteSource: ndviObs?.attribution?.datasetLabel ?? "Sentinel-2",
        polygon: JSON.stringify(payload.polygon),
        rawGeeResponse: JSON.stringify({
          current: {
            tileUrl: ndviObs?.artifact.tileLayerPath ?? null,
          }
        }),
      });

      const priorScore = await storage.getMrvScore(payload.projectId);
      const baselineNdvi = payload.cycleType === "baseline"
        ? ndviMean
        : (priorScore?.baselineNdvi ?? ndviMean);

      const ndviDelta = geeResult.deltas?.find((d) => d.observationType === "ndvi");
      const ndviDeltaPct = ndviDelta?.relativeChangePct ?? (payload.cycleType === "baseline" ? 0.0 : baselineNdvi !== 0.0 ? ((ndviMean - baselineNdvi) / Math.abs(baselineNdvi)) * 100.0 : 0.0);

      const ehiVal = geeResult.ecosystemHealthIndex ?? 85.0;
      let confidenceStr: "HIGH" | "MEDIUM" | "LOW" = "HIGH";
      if (ndviObs) {
        if (ndviObs.confidence >= 0.8) confidenceStr = "HIGH";
        else if (ndviObs.confidence >= 0.5) confidenceStr = "MEDIUM";
        else confidenceStr = "LOW";
      }

      const project = await storage.getProject(payload.projectId);
      const areaHa = project?.area ?? 10.0;
      const canopyPct = Math.max(0.0, Math.min(100.0, ndviMean * 100.0)) || 60.0;

      console.log(`[MRV] [ORCHESTRATOR] Creating MRV Score for project ${payload.projectId} with trustScore=${Math.round(ehiVal)}`);
      await storage.createMrvScore({
        projectId: payload.projectId,
        trustScore: Math.round(ehiVal),
        confidence: confidenceStr,
        baselineNdvi,
        currentNdvi: ndviMean,
        ndviDeltaPct,
        canopyPct,
        ecosystemFactor: 0.8,
        areaHa,
      });

      await monitoringCycleRepository.updateCycleStatus(payload.cycleId, "analysis_complete");
      await storage.updateProjectMrvStatus(payload.projectId, "COMPLETED");

      // OPS-1: stamp completion + roll the recurring schedule forward (additive).
      try {
        const completedProject = await storage.getProject(payload.projectId);
        const now = new Date();
        await storage.updateProject(payload.projectId, {
          lastMonitoringDate: now,
          nextMonitoringDue: computeNextMonitoringDate(now, completedProject?.monitoringFrequency),
        });
      } catch {
        // Schedule roll-forward must never fail an MRV run.
      }

      // ── Evidence package (fire-and-forget, never fails MRV) ─────────────────
      if (payload.runId) {
        const runId = payload.runId;
        const jobStartedAt = new Date(Date.now() - 5000);
        void (async () => {
          const evLog = oplog({ operationName: "evidence_package", correlationId, projectId: payload.projectId, runId });
          evLog.info("evidence.started");
          try {
            await storage.updateAnalysisRun(runId, { status: "running" });

            // Prepare evidence directory before isolated workflow execution.
            const evidenceDir = await evidenceService.prepareRunDirectory(payload.projectId, runId);

            // Step 1 — Script 2: LST (isolated, never fails MRV)
            let lstResult: LSTResult | undefined;
            try {
              lstResult = await runLSTWorkflow(payload.polygon, payload.startDate, payload.endDate);
              console.log(`${LOG_PREFIX} [LST] complete (fallback=${lstResult.fallback_used}, mean=${lstResult.lst_mean}°C)`);
            } catch (err) {
              console.warn(`${LOG_PREFIX} [LST] failed (non-blocking):`, err instanceof Error ? err.message : err);
            }

            // Step 2 — Script 6: LULC (isolated, never fails MRV)
            let lulcResult: LULCResult | undefined;
            try {
              lulcResult = await runLULCWorkflow(payload.polygon, payload.startDate, payload.endDate);
              console.log(`${LOG_PREFIX} [LULC] complete (fallback=${lulcResult.fallback_used}, veg=${lulcResult.vegetation_pct}%)`);
            } catch (err) {
              console.warn(`${LOG_PREFIX} [LULC] failed (non-blocking):`, err instanceof Error ? err.message : err);
            }

            // Step 3 — Script 5: Historical NDVI (isolated, never fails MRV)
            let historicalResult: HistoricalResult | undefined;
            try {
              historicalResult = await runHistoricalWorkflow(payload.polygon);
              console.log(`${LOG_PREFIX} [Historical] complete (fallback=${historicalResult.fallback_used}, trend=${historicalResult.trend_direction}, years=${historicalResult.yearly_metrics.length})`);
            } catch (err) {
              console.warn(`${LOG_PREFIX} [Historical] failed (non-blocking):`, err instanceof Error ? err.message : err);
            }

            // Step 4 — Script 4: DEM/Hydrology (isolated, never fails MRV)
            let hydrologyResult: HydrologyResult | undefined;
            try {
              hydrologyResult = await runDemHydrologyWorkflow(payload.polygon);
              console.log(`${LOG_PREFIX} [Hydrology] complete (fallback=${hydrologyResult.fallback_used}, slope=${hydrologyResult.mean_slope}°, runoff=${hydrologyResult.runoff_risk})`);
            } catch (err) {
              console.warn(`${LOG_PREFIX} [Hydrology] failed (non-blocking):`, err instanceof Error ? err.message : err);
            }

            // Step 5 — Script 3: Restoration Suitability (isolated, never fails MRV)
            let restorationResult: RestorationResult | undefined;
            try {
              restorationResult = await runRestorationWorkflow(payload.polygon, payload.startDate, payload.endDate, hydrologyResult);
              console.log(`${LOG_PREFIX} [Restoration] complete (fallback=${restorationResult.fallback_used}, score=${restorationResult.suitability_score}, priority=${restorationResult.priority_level})`);
            } catch (err) {
              console.warn(`${LOG_PREFIX} [Restoration] failed (non-blocking):`, err instanceof Error ? err.message : err);
            }

            // Step 6 — Ecological Risk Engine (isolated, never fails MRV)
            let riskResult: RiskEngineResult | undefined;
            try {
              riskResult = runRiskEngine({
                geeResult,
                lstResult,
                lulcResult,
                historicalResult,
                hydrologyResult,
                restorationResult,
              });
              console.log(`${LOG_PREFIX} [Risk] complete (score=${riskResult.overall_risk_score}, urgency=${riskResult.intervention_urgency}, confidence=${riskResult.confidence_score})`);
            } catch (err) {
              console.warn(`${LOG_PREFIX} [Risk] failed (non-blocking):`, err instanceof Error ? err.message : err);
            }

            // Step 7 — PNG image exports: REAL GEE satellite imagery first,
            // procedural fallback per-asset (isolated, never fails MRV).
            let imageAssets: AssetRecord[] = [];
            try {
              const ndviMean = geeResult.observations.find((o) => o.observationType === "ndvi")?.valueMean ?? null;
              const ndwiMean = geeResult.observations.find((o) => o.observationType === "ndwi")?.valueMean ?? null;
              const imageResult = await exportEvidenceImages(evidenceDir, {
                polygon: payload.polygon,
                startDate: payload.startDate,
                endDate: payload.endDate,
                ndvi_mean: ndviMean,
                ndwi_mean: ndwiMean,
                lst_mean: lstResult?.lst_mean ?? null,
                lulcResult,
                historicalResult,
                hydrologyResult,
                restorationResult,
                riskResult,
                projectName: project?.name ?? null,
                ecosystemType: project?.ecosystemType ?? null,
              });
              imageAssets = imageResult.assets;
              console.log(`${LOG_PREFIX} Exported ${imageAssets.length} PNG asset(s) (${imageResult.realCount} real GEE, ${imageResult.proceduralCount} procedural): ${imageAssets.map((a) => a.filename).join(", ")}`);
            } catch (err) {
              console.warn(`${LOG_PREFIX} PNG export failed (non-blocking):`, err instanceof Error ? err.message : err);
            }

            // Step 8 — metrics.json (v1.5)
            // Step 9 — evidence-manifest.json
            const latestScore = await storage.getMrvScore(payload.projectId);
            await evidenceService.buildAndSavePackage({
              runId,
              projectId: payload.projectId,
              payload,
              geeResult,
              project: project ?? null,
              mrvScore: latestScore
                ? {
                    trustScore: latestScore.trustScore,
                    confidence: latestScore.confidence ?? undefined,
                    ndviDeltaPct: latestScore.ndviDeltaPct ?? undefined,
                    baselineNdvi: latestScore.baselineNdvi ?? undefined,
                  }
                : null,
              startedAt: jobStartedAt,
              lstResult,
              lulcResult,
              historicalResult,
              hydrologyResult,
              restorationResult,
              riskResult,
              imageAssets,
            });

            await storage.updateAnalysisRun(runId, {
              status: "complete",
              completedAt: new Date(),
              evidencePath: evidenceDir,
            });
            evLog.done("evidence.saved", { evidenceDir });


          } catch (err) {
            evLog.error("evidence.failed", err);
            try {
              await storage.updateAnalysisRun(runId, { status: "failed", completedAt: new Date() });
            } catch { /* ignore */ }
          }
        })();
      }

      // ── Lifecycle automation ────────────────────────────────────────────────
      // Compute nextMonitoringDue (default 90 days / quarterly if no frequency set)
      const freq = project?.monitoringFrequency ?? "quarterly";
      const intervalDays = freq === "biweekly" ? 14 : freq === "quarterly" ? 90 : 30;
      const nextMonitoringDue = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000);

      const lifecycleUpdates: Partial<typeof project & { nextMonitoringDue: Date; monitoringFrequency: string; baselineCompletedAt: Date }> = {
        nextMonitoringDue,
        ...(!project?.monitoringFrequency ? { monitoringFrequency: "quarterly" } : {}),
        ...(payload.cycleType === "baseline" ? { baselineCompletedAt: new Date() } : {}),
      };
      console.log(`${LOG_PREFIX} Setting lifecycle fields for project ${payload.projectId}:`, Object.keys(lifecycleUpdates).join(", "));
      await storage.updateProject(payload.projectId, lifecycleUpdates as any);

      if (payload.cycleType === "baseline") {
        this.stateStore.transition(payload.projectId, "GIS_ANALYSIS_SUCCESS");
        this.stateStore.transition(payload.projectId, "START_MONITORING");
      }

      // scheduleNextMonitoring handles DB-mode SQL update; storage.updateProject above covers memory mode
      await monitoringCycleRepository.scheduleNextMonitoring(payload.projectId, freq);



      this.setProgress(payload.projectId, 100, "complete", "COMPLETED");
      log.done("job.completed", { observations: geeResult.observations.length });
      invalidateProjectCache(payload.projectId);
      mrvEventBus.publish({ type: "job.completed", payload: { projectId: payload.projectId, result: geeResult } });
      await geeIntegrationService.notifyExternalLifecycle("analysis.completed", {
        projectId: payload.projectId,
        observationCount: geeResult.observations.length,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "analysis failed";
      log.error("job.failed", error, { willRetry: (payload.retryCount ?? 0) + 1 < DEFAULT_RETRY_LIMIT });
      const nextRetryCount = retryCount + 1;
      mrvEventBus.publish({
        type: "job.failed",
        payload: {
          projectId: payload.projectId,
          error: message,
          retryCount: nextRetryCount,
        },
      });

      if (payload.cycleId) {
        await monitoringCycleRepository.updateCycleStatus(payload.cycleId, "failed", message);
      }

      if (nextRetryCount < DEFAULT_RETRY_LIMIT) {
        this.setProgress(payload.projectId, 15, `retry ${nextRetryCount}/${DEFAULT_RETRY_LIMIT - 1}`, "RUNNING");
        await analysisQueueService.enqueue({
          projectId: payload.projectId,
          cycleType: payload.cycleType,
          cycleId: payload.cycleId,
          polygon: payload.polygon,
          triggeredBy: payload.triggeredBy,
          startDate: payload.startDate,
          endDate: payload.endDate,
          retryCount: nextRetryCount,
        });
      } else {
        if (payload.cycleType === "baseline") {
          try {
            this.stateStore.transition(payload.projectId, "GIS_ANALYSIS_FAIL");
          } catch {
            this.stateStore.force(payload.projectId, "GIS_ANALYSIS_FAILED");
          }
        }
        this.setProgress(payload.projectId, 0, "failed", "FAILED");
        await storage.updateProjectMrvStatus(payload.projectId, "FAILED");
      }

      await geeIntegrationService.notifyExternalLifecycle("analysis.failed", {
        projectId: payload.projectId,
        error: message,
        retryCount: nextRetryCount,
      });
      console.warn(`${LOG_PREFIX} analysis failed`, { projectId: payload.projectId, retryCount: nextRetryCount, error: message });
    }
  }

  private setProgress(projectId: string, progress: number, label: string, status: string) {
    monitoringProgressTracker.set(projectId, progress, label, status);
    mrvEventBus.publish({
      type: "job.progress",
      payload: {
        projectId,
        progress,
        label,
        status: status === "FAILED" ? "failed" : status === "COMPLETED" ? "analysis_complete" : "analyzing",
      },
    });
  }
}

export const monitoringOrchestratorService = new MonitoringOrchestratorService();
