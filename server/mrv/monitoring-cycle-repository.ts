import { sql } from "drizzle-orm";
import type { MonitoringCycleStatus, MonitoringCycleType, PreparedObservation } from "./types";
import { isDatabaseModeEnabled } from "../db";
import { randomUUID } from "crypto";
import { storage } from "../storage";

interface DueProjectRow {
  id: string;
  monitoring_frequency: string | null;
  next_monitoring_due: Date | null;
  land_boundary: string | null;
}
interface IdRow {
  id: string;
}

// In-memory store for development when USE_DATABASE=false
const memoryCycles = new Map<string, any>();
const memoryObservations = new Map<string, any[]>();

export class MonitoringCycleRepository {
  private async db() {
    const { db } = await import("../db");
    return db;
  }

  async createCycle(params: {
    projectId: string;
    cycleType: MonitoringCycleType;
    triggeredBy: string;
    status?: MonitoringCycleStatus;
    fixedCycleNumber?: number;
  }): Promise<string> {
    if (!isDatabaseModeEnabled()) {
      const cycleId = randomUUID();
      memoryCycles.set(cycleId, {
        id: cycleId,
        projectId: params.projectId,
        cycleType: params.cycleType,
        status: params.status ?? "pending",
        triggeredBy: params.triggeredBy,
        startedAt: new Date()
      });
      return cycleId;
    }

    const db = await this.db();

    const cycleNumberSql = params.fixedCycleNumber !== undefined
      ? sql`${params.fixedCycleNumber}`
      : sql`COALESCE((SELECT MAX(cycle_number) + 1 FROM eco_monitoring.monitoring_cycles WHERE project_id = ${params.projectId}), 1)`;

    const result = await db.execute(sql`
      INSERT INTO eco_monitoring.monitoring_cycles
        (project_id, cycle_number, cycle_type, status, triggered_by, started_at)
      VALUES
        (
          ${params.projectId},
          ${cycleNumberSql},
          CAST(${params.cycleType} AS eco_monitoring.monitoring_cycle_type),
          CAST(${params.status ?? "pending"} AS eco_monitoring.monitoring_cycle_status),
          ${params.triggeredBy},
          NOW()
        )
      ON CONFLICT (project_id, cycle_number)
      DO UPDATE SET
        status = EXCLUDED.status,
        triggered_by = EXCLUDED.triggered_by,
        started_at = COALESCE(eco_monitoring.monitoring_cycles.started_at, NOW())
      RETURNING id
    `);

    const id = (result.rows?.[0] as unknown as IdRow | undefined)?.id;
    if (!id) {
      throw new Error("Failed to create monitoring cycle.");
    }
    return id;
  }

  async updateCycleStatus(cycleId: string, status: MonitoringCycleStatus, errorLog?: string): Promise<void> {
    if (!isDatabaseModeEnabled()) {
      const cycle = memoryCycles.get(cycleId);
      if (cycle) {
        cycle.status = status;
        if (errorLog) cycle.errorLog = errorLog;
      }
      return;
    }

    const db = await this.db();

    await db.execute(sql`
      UPDATE eco_monitoring.monitoring_cycles
      SET
        status = CAST(${status} AS eco_monitoring.monitoring_cycle_status),
        imagery_acquired_at = CASE WHEN ${status} = 'imagery_collection' THEN NOW() ELSE imagery_acquired_at END,
        analysis_completed_at = CASE WHEN ${status} = 'analysis_complete' THEN NOW() ELSE analysis_completed_at END,
        completed_at = CASE WHEN ${status} IN ('analysis_complete', 'failed', 'verified', 'flagged') THEN NOW() ELSE completed_at END,
        error_log = COALESCE(${errorLog ?? null}, error_log)
      WHERE id = ${cycleId}
    `);
  }

  async storeObservation(projectId: string, cycleId: string, observation: PreparedObservation): Promise<void> {
    if (!isDatabaseModeEnabled()) {
      if (!memoryObservations.has(cycleId)) {
        memoryObservations.set(cycleId, []);
      }
      memoryObservations.get(cycleId)!.push({ ...observation, projectId, cycleId });
      return;
    }

    const db = await this.db();

    await db.execute(sql`
      INSERT INTO eco_monitoring.environmental_observations
        (
          project_id,
          monitoring_cycle_id,
          observation_type,
          observed_at,
          value_mean,
          value_min,
          value_max,
          value_stddev,
          value_median,
          value_distribution,
          value_unit,
          spatial_coverage_pct,
          raster_asset_path,
          thumbnail_path,
          tile_layer_path,
          source_dataset,
          source_image_id,
          source_resolution_m,
          processing_algorithm,
          processing_parameters,
          confidence,
          quality_flag
        )
      VALUES
        (
          ${projectId},
          ${cycleId},
          CAST(${observation.observationType} AS eco_monitoring.observation_type),
          ${observation.observedAt},
          ${observation.valueMean},
          ${observation.valueMin},
          ${observation.valueMax},
          ${observation.valueStddev},
          ${observation.valueMedian},
          ${JSON.stringify(observation.valueDistribution)}::jsonb,
          ${observation.valueUnit},
          ${observation.spatialCoveragePct},
          ${observation.artifact.rasterAssetPath},
          ${observation.artifact.thumbnailPath},
          ${observation.artifact.tileLayerPath},
          ${observation.artifact.sourceDataset},
          ${observation.artifact.sourceImageId ?? null},
          ${observation.artifact.sourceResolutionM},
          ${observation.artifact.processingAlgorithm},
          ${JSON.stringify(observation.artifact.processingParameters)}::jsonb,
          ${observation.confidence},
          CAST(${observation.qualityFlag} AS eco_monitoring.observation_quality_flag)
        )
    `);
  }

  getMemoryObservationsByProject(projectId: string, observationType?: string): any[] {
    const results: any[] = [];
    for (const [cycleId, cycle] of memoryCycles) {
      if (cycle.projectId !== projectId) continue;
      const obs = memoryObservations.get(cycleId) ?? [];
      for (const o of obs) {
        if (!observationType || o.observationType === observationType) {
          results.push(o);
        }
      }
    }
    results.sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime());
    return results;
  }

  getMemoryCyclesByProject(projectId: string): any[] {
    const results: any[] = [];
    for (const [, cycle] of memoryCycles) {
      if (cycle.projectId === projectId) results.push(cycle);
    }
    results.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
    return results;
  }

  async getDueProjects(limit = 50): Promise<Array<{ id: string; monitoringFrequency: string | null; nextMonitoringDue: Date | null; landBoundary: string | null }>> {
    if (!isDatabaseModeEnabled()) {
      return [];
    }

    const db = await this.db();

    const result = await db.execute(sql`
      SELECT
        id,
        monitoring_frequency,
        next_monitoring_due,
        land_boundary
      FROM public.projects
      WHERE archived_at IS NULL
        AND monitoring_frequency IS NOT NULL
        AND next_monitoring_due IS NOT NULL
        AND next_monitoring_due <= NOW()
      ORDER BY next_monitoring_due ASC
      LIMIT ${limit}
    `);

    const rows = (result.rows ?? []) as unknown as DueProjectRow[];
    return rows.map((row) => ({
      id: row.id,
      monitoringFrequency: row.monitoring_frequency,
      nextMonitoringDue: row.next_monitoring_due,
      landBoundary: row.land_boundary,
    }));
  }

  async scheduleNextMonitoring(projectId: string, frequency: string | null): Promise<void> {
    if (!isDatabaseModeEnabled()) {
      return;
    }

    const db = await this.db();
    const interval = frequency === "biweekly" ? "14 days" : frequency === "quarterly" ? "90 days" : "30 days";

    await db.execute(sql`
      UPDATE public.projects
      SET next_monitoring_due = NOW() + ${interval}::interval
      WHERE id = ${projectId}
    `);
  }
}

export const monitoringCycleRepository = new MonitoringCycleRepository();
