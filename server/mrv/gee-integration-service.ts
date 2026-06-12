/**
 * gee-integration-service.ts
 *
 * Façade that bridges the MRV orchestrator with the multi-index GEE pipeline.
 *
 * Responsibilities:
 *  - Execute baseline and scheduled monitoring analyses via the multi-index pipeline
 *  - Load baseline/historical snapshots and attach them to monitoring jobs
 *  - Run change detection deltas and ecosystem health scoring after each cycle
 *  - Notify the external lifecycle endpoint (Python MRV service) of job events
 *  - Improved GEE failure recovery: progressive retry with exponential backoff
 *
 * Isolation contract:
 *  - Does NOT import from routes.ts
 *  - All heavy computation delegated to gee-multi-index-pipeline.ts
 *  - Change detection delegated to change-detection-engine.ts
 */

import axios from "axios";
import { runMultiIndexPipeline } from "./gee-multi-index-pipeline";
import {
  computeAllDeltas,
  computeEcosystemHealthIndex,
  buildAllMultiCycleComparisons,
} from "./change-detection-engine";
import { historicalAnalysisService } from "../intelligence/historical-analysis-service";
import type { AnalysisJobPayload, GEEExecutionResult } from "./types";

const GEE_SERVICE_URL =
  process.env.GEE_SERVICE_URL || process.env.MRV_SERVICE_URL || "";

const LOG = "[MRV] [GEE]";

// ─── Exponential backoff helper ───────────────────────────────────────────────

async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  retries: number,
  baseDelayMs = 2000,
  label = "operation"
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt + Math.random() * 500;
        console.warn(`${LOG} ${label} attempt ${attempt + 1} failed, retrying in ${delay.toFixed(0)}ms:`, err instanceof Error ? err.message : err);
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }
  throw lastError;
}

// ─── Main service ─────────────────────────────────────────────────────────────

export class GEEIntegrationService {
  /**
   * Run a baseline analysis cycle.
   * Loads NDVI/EVI/SAVI/NDWI/NDMI/NBR/BSI multi-index observations and
   * computes ecosystem health index. No baseline snapshot available for delta
   * calculation at this stage (this IS the baseline).
   */
  async runBaselineAnalysis(job: AnalysisJobPayload): Promise<GEEExecutionResult> {
    console.log(`${LOG} Running baseline multi-index analysis for ${job.projectId}`);

    const pipelineResult = await withExponentialBackoff(
      () =>
        runMultiIndexPipeline({
          projectId: job.projectId,
          polygon: {
            type: "Polygon",
            coordinates: job.polygon.coordinates,
          } as unknown as { coordinates: unknown[][] },
          startDate: job.startDate,
          endDate: job.endDate,
          cycleType: "baseline",
          cloudThresholdPct: 30,
        }),
      2, // 2 internal retries inside the service
      3000,
      "baseline_multi_index_pipeline"
    );

    // For a baseline cycle, the EHI is computed from the current point only
    const ndviObs = pipelineResult.observations.find((o) => o.observationType === "ndvi");
    const ndmiObs = pipelineResult.observations.find((o) => o.observationType === "ndmi");
    const ehi = computeEcosystemHealthIndex([
      {
        cycleId: job.cycleId ?? "baseline",
        observedAt: job.endDate,
        ndviMean: ndviObs?.valueMean ?? null,
        ndmiMean: ndmiObs?.valueMean ?? null,
        ndwiMean: pipelineResult.observations.find((o) => o.observationType === "ndwi")?.valueMean ?? null,
        eviMean: pipelineResult.observations.find((o) => o.observationType === "evi")?.valueMean ?? null,
        greenCoverPercent: null,
        bareLandPercent: null,
        waterAreaPercent: null,
      },
    ]);

    return {
      projectId: job.projectId,
      cycleType: job.cycleType,
      observations: pipelineResult.observations,
      ecosystemHealthIndex: ehi.ecosystemHealthIndex,
      hooks: {
        cloudThresholdPct: 30,
        fallbackUsed: pipelineResult.mrvServiceUsed ? false : true,
        datasets: [...new Set(pipelineResult.attributions.map((a) => a.datasetId))],
        attributions: pipelineResult.attributions,
      },
      errors: pipelineResult.errors,
    };
  }

  /**
   * Run a scheduled monitoring analysis cycle.
   * Loads baseline snapshot from DB to compute change deltas.
   * Loads all historical snapshots to compute ecosystem health trend.
   */
  async runScheduledMonitoringAnalysis(job: AnalysisJobPayload): Promise<GEEExecutionResult> {
    console.log(`${LOG} Running scheduled monitoring multi-index analysis for ${job.projectId}`);

    // Load historical context in parallel with pipeline execution
    const [pipelineResult, baseline, historicalSnapshots] = await Promise.all([
      withExponentialBackoff(
        () =>
          runMultiIndexPipeline({
            projectId: job.projectId,
            polygon: {
              type: "Polygon",
              coordinates: job.polygon.coordinates,
            } as unknown as { coordinates: unknown[][] },
            startDate: job.startDate,
            endDate: job.endDate,
            cycleType: "monitoring",
            cloudThresholdPct: 30,
          }),
        2,
        3000,
        "monitoring_multi_index_pipeline"
      ),
      historicalAnalysisService.getBaselineSnapshot(job.projectId),
      historicalAnalysisService.getHistoricalSnapshots(job.projectId, 50),
    ]);

    const ndviObs  = pipelineResult.observations.find((o) => o.observationType === "ndvi");
    const ndwiObs  = pipelineResult.observations.find((o) => o.observationType === "ndwi");
    const ndmiObs  = pipelineResult.observations.find((o) => o.observationType === "ndmi");
    const eviObs   = pipelineResult.observations.find((o) => o.observationType === "evi");

    // Compute deltas from baseline
    const deltas = baseline
      ? computeAllDeltas(
          baseline,
          ndviObs?.valueMean ?? null,
          ndwiObs?.valueMean ?? null,
          ndmiObs?.valueMean ?? null,
          eviObs?.valueMean ?? null,
          job.endDate
        )
      : [];

    // Add current cycle to historical snapshots for EHI computation
    const currentSnapshot = {
      cycleId: job.cycleId ?? "current",
      observedAt: job.endDate,
      ndviMean: ndviObs?.valueMean ?? null,
      ndmiMean: ndmiObs?.valueMean ?? null,
      ndwiMean: ndwiObs?.valueMean ?? null,
      eviMean: eviObs?.valueMean ?? null,
      greenCoverPercent: null,
      bareLandPercent: null,
      waterAreaPercent: null,
    };
    const allSnapshots = [...historicalSnapshots, currentSnapshot];

    const ehi = computeEcosystemHealthIndex(allSnapshots);
    const multiCycleComparisons = buildAllMultiCycleComparisons(allSnapshots);

    if (multiCycleComparisons.length > 0) {
      console.log(
        `${LOG} Multi-cycle comparison computed across ${allSnapshots.length} snapshots for ${job.projectId}`
      );
    }

    return {
      projectId: job.projectId,
      cycleType: job.cycleType,
      observations: pipelineResult.observations,
      deltas,
      ecosystemHealthIndex: ehi.ecosystemHealthIndex,
      hooks: {
        cloudThresholdPct: 30,
        fallbackUsed: pipelineResult.mrvServiceUsed ? false : true,
        datasets: [...new Set(pipelineResult.attributions.map((a) => a.datasetId))],
        attributions: pipelineResult.attributions,
      },
      errors: pipelineResult.errors,
    };
  }

  /**
   * Notify the external Python MRV service of lifecycle events.
   * Non-blocking: failures are logged only, not propagated.
   */
  async notifyExternalLifecycle(
    event: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!GEE_SERVICE_URL) return;
    try {
      await axios.post(
        `${GEE_SERVICE_URL}/internal/mrv-events`,
        { event, payload },
        { timeout: 10_000 }
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`${LOG} lifecycle notify failed (${event}): ${message}`);
    }
  }
}

export const geeIntegrationService = new GEEIntegrationService();
