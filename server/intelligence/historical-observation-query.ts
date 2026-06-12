import { sql } from "drizzle-orm";
import { monitoringCycleRepository } from "../mrv/monitoring-cycle-repository";

export interface HistoricalObservationRow {
  observationType: string;
  observedAt: string;
  valueMean: number | null;
  valueMin: number | null;
  valueMax: number | null;
  valueMedian: number | null;
  valueStddev: number | null;
  valueUnit: string | null;
  confidence: number | null;
  qualityFlag: string | null;
  rasterAssetPath: string | null;
  thumbnailPath: string | null;
  tileLayerPath: string | null;
  sourceDataset: string | null;
}

export interface ObservationArtifactRow {
  observationType: string;
  observedAt: string;
  rasterAssetPath: string | null;
  thumbnailPath: string | null;
  tileLayerPath: string | null;
  sourceDataset: string | null;
}
export class HistoricalObservationQueryService {
  private async db() {
    const { db } = await import("../db");
    return db;
  }

  async listByProject(projectId: string, observationType?: string, limit = 300): Promise<HistoricalObservationRow[]> {
    if (!(process.env.USE_DATABASE === "true" && process.env.DATABASE_URL)) {
      const rows = monitoringCycleRepository.getMemoryObservationsByProject(projectId, observationType);
      return rows.slice(0, limit).map((o: any) => ({
        observationType: o.observationType,
        observedAt: o.observedAt instanceof Date ? o.observedAt.toISOString() : String(o.observedAt),
        valueMean: o.valueMean ?? null,
        valueMin: o.valueMin ?? null,
        valueMax: o.valueMax ?? null,
        valueMedian: o.valueMedian ?? null,
        valueStddev: o.valueStddev ?? null,
        valueUnit: o.valueUnit ?? null,
        confidence: o.confidence ?? null,
        qualityFlag: o.qualityFlag ?? null,
        rasterAssetPath: o.artifact?.rasterAssetPath ?? null,
        thumbnailPath: o.artifact?.thumbnailPath ?? null,
        tileLayerPath: o.artifact?.tileLayerPath ?? null,
        sourceDataset: o.artifact?.sourceDataset ?? null,
      }));
    }
    const db = await this.db();
    const result = observationType
      ? await db.execute(sql`
          SELECT
            observation_type AS "observationType",
            observed_at AS "observedAt",
            value_mean AS "valueMean",
            value_min AS "valueMin",
            value_max AS "valueMax",
            value_median AS "valueMedian",
            value_stddev AS "valueStddev",
            value_unit AS "valueUnit",
            confidence,
            quality_flag AS "qualityFlag",
            raster_asset_path AS "rasterAssetPath",
            thumbnail_path AS "thumbnailPath",
            tile_layer_path AS "tileLayerPath",
            source_dataset AS "sourceDataset"
          FROM eco_monitoring.environmental_observations
          WHERE project_id = ${projectId}
            AND observation_type = CAST(${observationType} AS eco_monitoring.observation_type)
          ORDER BY observed_at ASC
          LIMIT ${limit}
        `)
      : await db.execute(sql`
          SELECT
            observation_type AS "observationType",
            observed_at AS "observedAt",
            value_mean AS "valueMean",
            value_min AS "valueMin",
            value_max AS "valueMax",
            value_median AS "valueMedian",
            value_stddev AS "valueStddev",
            value_unit AS "valueUnit",
            confidence,
            quality_flag AS "qualityFlag",
            raster_asset_path AS "rasterAssetPath",
            thumbnail_path AS "thumbnailPath",
            tile_layer_path AS "tileLayerPath",
            source_dataset AS "sourceDataset"
          FROM eco_monitoring.environmental_observations
          WHERE project_id = ${projectId}
          ORDER BY observed_at ASC
          LIMIT ${limit}
        `);
    return ((result.rows ?? []) as unknown as HistoricalObservationRow[]);
  }

  async listArtifactsByProject(projectId: string, limit = 250): Promise<ObservationArtifactRow[]> {
    if (!(process.env.USE_DATABASE === "true" && process.env.DATABASE_URL)) {
      const rows = monitoringCycleRepository.getMemoryObservationsByProject(projectId);
      return rows.slice(0, limit).map((o: any) => ({
        observationType: o.observationType,
        observedAt: o.observedAt instanceof Date ? o.observedAt.toISOString() : String(o.observedAt),
        rasterAssetPath: o.artifact?.rasterAssetPath ?? null,
        thumbnailPath: o.artifact?.thumbnailPath ?? null,
        tileLayerPath: o.artifact?.tileLayerPath ?? null,
        sourceDataset: o.artifact?.sourceDataset ?? null,
      }));
    }
    const db = await this.db();
    const result = await db.execute(sql`
      SELECT
        observation_type AS "observationType",
        observed_at AS "observedAt",
        raster_asset_path AS "rasterAssetPath",
        thumbnail_path AS "thumbnailPath",
        tile_layer_path AS "tileLayerPath",
        source_dataset AS "sourceDataset"
      FROM eco_monitoring.environmental_observations
      WHERE project_id = ${projectId}
      ORDER BY observed_at DESC
      LIMIT ${limit}
    `);
    return ((result.rows ?? []) as unknown as ObservationArtifactRow[]).reverse();
  }
}

export const historicalObservationQueryService = new HistoricalObservationQueryService();
