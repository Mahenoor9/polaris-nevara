import { sql } from "drizzle-orm";
import type { Project } from "@shared/schema";
import { parsePolygonFromLandBoundary } from "../gis/polygon-ingestion";
import { validatePolygonGeometry } from "../gis/geometry-validation";
import {
  buildEcosystemDetectionHookPayload,
  computeSpatialMetrics,
  deriveInitialEcosystemType,
} from "../gis/spatial-service";
import { buildBaselineObservationInputs } from "./observation-ingestion";

export interface EcologicalInitializationResult {
  initialized: boolean;
  mode: "database" | "memory";
  warnings: string[];
  spatial: {
    areaHectares: number;
    perimeterKm: number;
    centroid: { lat: number; lng: number };
    bbox: [number, number, number, number];
  } | null;
}

function hasDatabaseEcologyPersistence() {
  return process.env.USE_DATABASE === "true" && Boolean(process.env.DATABASE_URL);
}

async function createOrGetBaselineCycleId(db: any, projectId: string): Promise<string> {
  const cycleResult: any = await db.execute(sql`
    INSERT INTO eco_monitoring.monitoring_cycles
      (project_id, cycle_number, cycle_type, status, triggered_by)
    VALUES
      (${projectId}, 0, CAST('baseline' AS eco_monitoring.monitoring_cycle_type), CAST('analysis_complete' AS eco_monitoring.monitoring_cycle_status), 'system:project_create')
    ON CONFLICT (project_id, cycle_number)
    DO UPDATE SET
      status = CAST('analysis_complete' AS eco_monitoring.monitoring_cycle_status)
    RETURNING id
  `);

  const row = cycleResult?.rows?.[0];
  if (!row?.id) {
    throw new Error("Failed to create or fetch baseline monitoring cycle.");
  }
  return row.id as string;
}

export class EcologicalInitializationService {
  async initializeProject(project: Project): Promise<EcologicalInitializationResult> {
    if (!project.landBoundary) {
      return {
        initialized: false,
        mode: hasDatabaseEcologyPersistence() ? "database" : "memory",
        warnings: ["Skipped ecological initialization: project has no polygon boundary."],
        spatial: null,
      };
    }

    const ingestion = parsePolygonFromLandBoundary(project.landBoundary);
    const validation = validatePolygonGeometry(ingestion.polygon);
    if (!validation.valid) {
      throw new Error(`Polygon validation failed: ${validation.errors.join(" ")}`);
    }

    const spatial = computeSpatialMetrics(ingestion.polygon);
    const detectionHooks = buildEcosystemDetectionHookPayload(project.id, ingestion.polygon);
    const inferredEcosystem = deriveInitialEcosystemType(project.ecosystemType, {
      tree: 0.2,
      water: 0.1,
      wetland: 0.05,
    });
    const mode = hasDatabaseEcologyPersistence() ? "database" : "memory";

    if (mode === "memory") {
      return {
        initialized: true,
        mode,
        warnings: [
          ...ingestion.warnings,
          ...validation.warnings,
          "Ecological tables not persisted in memory mode; hooks prepared only.",
        ],
        spatial,
      };
    }

    const { db } = await import("../db");

    await db.execute(sql`
      UPDATE public.projects
      SET
        polygon = ST_SetSRID(ST_GeomFromGeoJSON(${ingestion.geojsonText}), 4326),
        monitoring_frequency = COALESCE(monitoring_frequency, 'monthly'),
        next_monitoring_due = COALESCE(next_monitoring_due, NOW() + INTERVAL '30 days')
      WHERE id = ${project.id}
    `);

    const baselineCycleId = await createOrGetBaselineCycleId(db, project.id);

    await db.execute(sql`
      INSERT INTO eco_monitoring.project_site_profiles
        (
          project_id,
          profile_version,
          detected_ecosystem_type,
          land_cover_composition,
          dominant_land_cover,
          nearest_water_body_name,
          nearest_water_body_distance_m,
          nearest_water_body_type,
          source_datasets,
          confidence_score
        )
      VALUES
        (
          ${project.id},
          1,
          ${inferredEcosystem},
          ${JSON.stringify({ pending: true, source: detectionHooks.landCoverPreparation.datasets })}::jsonb,
          ${inferredEcosystem},
          ${"PENDING_WATERBODY_CLASSIFICATION"},
          ${5000},
          ${"unknown"},
          ${JSON.stringify([
            { name: "ESA/WorldCover/v200", status: "prepared" },
            { name: "GOOGLE/DYNAMICWORLD/V1", status: "prepared" },
            { name: "JRC/GSW1_4/GlobalSurfaceWater", status: "prepared" },
          ])}::jsonb,
          ${0.55}
        )
      ON CONFLICT (project_id, profile_version)
      DO UPDATE SET
        detected_ecosystem_type = EXCLUDED.detected_ecosystem_type,
        land_cover_composition = EXCLUDED.land_cover_composition,
        dominant_land_cover = EXCLUDED.dominant_land_cover,
        source_datasets = EXCLUDED.source_datasets,
        confidence_score = EXCLUDED.confidence_score
    `);

    const baselineInputs = buildBaselineObservationInputs({
      projectId: project.id,
      monitoringCycleId: baselineCycleId,
      polygon: ingestion.polygon,
    });

    for (const input of baselineInputs) {
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
            source_resolution_m,
            processing_algorithm,
            processing_parameters,
            confidence,
            quality_flag
          )
        VALUES
          (
            ${input.projectId},
            ${input.monitoringCycleId},
            CAST(${input.observationType} AS eco_monitoring.observation_type),
            ${input.observedAt},
            ${input.valueMean},
            ${input.valueMin},
            ${input.valueMax},
            ${input.valueStddev},
            ${input.valueMedian},
            ${JSON.stringify(input.valueDistribution)}::jsonb,
            ${input.valueUnit},
            ${Number(input.valueDistribution.coveragePct ?? 0)},
            ${input.metadata.rasterAssetPath},
            ${input.metadata.thumbnailPath},
            ${input.metadata.tileLayerPath},
            ${input.metadata.sourceDataset},
            ${input.metadata.sourceResolutionM},
            ${input.metadata.processingAlgorithm},
            ${JSON.stringify(input.metadata.processingParameters)}::jsonb,
            ${input.confidence},
            CAST(${input.qualityFlag} AS eco_monitoring.observation_quality_flag)
          )
      `);
    }

    await db.execute(sql`
      UPDATE public.projects
      SET baseline_completed_at = NOW()
      WHERE id = ${project.id}
    `);

    return {
      initialized: true,
      mode,
      warnings: [...ingestion.warnings, ...validation.warnings],
      spatial,
    };
  }
}

export const ecologicalInitializationService = new EcologicalInitializationService();

