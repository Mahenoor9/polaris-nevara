/**
 * observation-processing-service.ts
 *
 * Persists GEE execution results (multi-index observations) to
 * eco_monitoring.environmental_observations.
 *
 * Changes from the foundation version:
 *  - Handles all spectral index observation types (ndvi, evi, savi, ndwi, ndmi, nbr, bsi, etc.)
 *  - Persists dataset attribution metadata into the observation payload
 *  - Persists observation deltas (change detection) into the distribution payload
 *  - Persists ecosystem health index as an ecosystem_health observation
 *  - All DB operations are safe fallbacks (non-DB mode skips silently)
 */

import type { GEEExecutionResult, PreparedObservation, ObservationDelta } from "./types";
import { monitoringCycleRepository } from "./monitoring-cycle-repository";

const LOG = "[MRV:ObservationProcessing]";

// ─── Observation type → DB enum guard ────────────────────────────────────────

/**
 * The eco_monitoring.observation_type enum is defined in the foundation migration.
 * Values not in the enum will cause a DB constraint error; we map safely.
 */
const DB_VALID_OBSERVATION_TYPES = new Set([
  "ndvi", "land_cover", "moisture_index", "surface_temp", "vegetation_fraction",
]);

/**
 * Extended observation types supported by this service — stored in the type
 * column if the DB enum supports them, otherwise stored in distribution payload.
 *
 * When the DB enum is extended (migration 0008 or later), this list can grow.
 */
const EXTENDED_TYPES_AS_DISTRIBUTION = new Set([
  "evi", "savi", "ndwi", "ndmi", "nbr", "bsi",
  "erosion_risk", "ecosystem_health",
]);

function resolvePersistStrategy(
  observationType: string
): { dbType: string; embedAsDistribution: boolean } {
  if (DB_VALID_OBSERVATION_TYPES.has(observationType)) {
    return { dbType: observationType, embedAsDistribution: false };
  }
  if (EXTENDED_TYPES_AS_DISTRIBUTION.has(observationType)) {
    // Store as moisture_index with observation type in distribution metadata
    // until the DB enum is extended
    return { dbType: "moisture_index", embedAsDistribution: true };
  }
  return { dbType: "land_cover", embedAsDistribution: true };
}

// ─── Observation persistence ──────────────────────────────────────────────────

export class ObservationProcessingService {
  async persistResult(
    projectId: string,
    cycleId: string,
    geeResult: GEEExecutionResult
  ): Promise<void> {
    console.log(
      `${LOG} Persisting ${geeResult.observations.length} observations for ${projectId} cycle ${cycleId}`
    );

    // Gather deltas by observation type for embedding
    const deltasByType: Record<string, ObservationDelta> = {};
    for (const delta of geeResult.deltas ?? []) {
      deltasByType[delta.observationType] = delta;
    }

    for (const observation of geeResult.observations) {
      await this.persistSingleObservation(projectId, cycleId, observation, deltasByType);
    }

    // Persist ecosystem health index as a synthetic observation if available
    if (geeResult.ecosystemHealthIndex !== undefined) {
      await this.persistEcosystemHealthObservation(
        projectId,
        cycleId,
        geeResult.ecosystemHealthIndex,
        geeResult.observations[0]?.observedAt ?? new Date()
      );
    }

    console.log(`${LOG} Observation persistence complete for cycle ${cycleId}`);
  }

  private async persistSingleObservation(
    projectId: string,
    cycleId: string,
    observation: PreparedObservation,
    deltasByType: Record<string, ObservationDelta>
  ): Promise<void> {
    const { dbType, embedAsDistribution } = resolvePersistStrategy(observation.observationType);

    // Build enriched distribution payload with:
    //  - original observation type for extended types
    //  - zonal stats (p10, p25, p75, p90)
    //  - delta from baseline if available
    //  - dataset attribution
    const enrichedDistribution: Record<string, unknown> = {
      ...observation.valueDistribution,
      ...(observation.zonalStats
        ? {
            zonalStats: {
              p10: observation.zonalStats.p10,
              p25: observation.zonalStats.p25,
              p75: observation.zonalStats.p75,
              p90: observation.zonalStats.p90,
            },
          }
        : {}),
      ...(observation.attribution
        ? {
            datasetAttribution: {
              datasetId: observation.attribution.datasetId,
              datasetLabel: observation.attribution.datasetLabel,
              imageCount: observation.attribution.imageCount,
              compositingMethod: observation.attribution.compositingMethod,
              fallbackUsed: observation.attribution.fallbackUsed,
              fallbackReason: observation.attribution.fallbackReason,
            },
          }
        : {}),
      ...(deltasByType[observation.observationType]
        ? {
            delta: {
              absoluteChange: deltasByType[observation.observationType].absoluteChange,
              relativeChangePct: deltasByType[observation.observationType].relativeChangePct,
              direction: deltasByType[observation.observationType].direction,
              baselineDate: deltasByType[observation.observationType].baselineDate,
            },
          }
        : {}),
      ...(embedAsDistribution ? { originalObservationType: observation.observationType } : {}),
    };

    try {
      await monitoringCycleRepository.storeObservation(projectId, cycleId, {
        observationType: dbType as PreparedObservation["observationType"],
        observedAt: observation.observedAt,
        valueMean: observation.valueMean,
        valueMin: observation.valueMin,
        valueMax: observation.valueMax,
        valueStddev: observation.valueStddev,
        valueMedian: observation.valueMedian,
        valueDistribution: enrichedDistribution,
        valueUnit: observation.valueUnit,
        spatialCoveragePct: observation.spatialCoveragePct,
        confidence: observation.confidence,
        qualityFlag: observation.qualityFlag,
        artifact: observation.artifact,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `${LOG} Failed to persist observation type=${observation.observationType} for cycle=${cycleId}: ${message}`
      );
    }
  }

  private async persistEcosystemHealthObservation(
    projectId: string,
    cycleId: string,
    ehi: number,
    observedAt: Date
  ): Promise<void> {
    const { dbType } = resolvePersistStrategy("ecosystem_health");
    try {
      await monitoringCycleRepository.storeObservation(projectId, cycleId, {
        observationType: dbType as PreparedObservation["observationType"],
        observedAt,
        valueMean: ehi / 100, // normalize to 0-1 range consistent with other indices
        valueMin: 0,
        valueMax: 1,
        valueStddev: 0,
        valueMedian: ehi / 100,
        valueDistribution: {
          originalObservationType: "ecosystem_health",
          ecosystemHealthIndex: ehi,
          scale: "0-100",
        },
        valueUnit: "health_index",
        spatialCoveragePct: 100,
        confidence: 0.75,
        qualityFlag: "acceptable",
        artifact: {
          rasterAssetPath: "",
          thumbnailPath: "",
          tileLayerPath: "",
          sourceDataset: "derived",
          sourceResolutionM: 0,
          processingAlgorithm: "ecosystem_health_index",
          processingParameters: {},
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG} Failed to persist ecosystem health observation for cycle=${cycleId}: ${message}`);
    }
  }
}

export const observationProcessingService = new ObservationProcessingService();
