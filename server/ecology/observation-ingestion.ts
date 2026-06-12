import type { NormalizedPolygon } from "../gis/polygon-ingestion";
import { computeSpatialMetrics } from "../gis/spatial-service";

export type ObservationType =
  | "land_cover"
  | "moisture_index"
  | "surface_temp"
  | "vegetation_fraction";

export interface RasterTileMetadata {
  rasterAssetPath: string;
  thumbnailPath: string;
  tileLayerPath: string;
  sourceDataset: string;
  sourceResolutionM: number;
  processingAlgorithm: string;
  processingParameters: Record<string, unknown>;
}

export interface BaselineObservationInput {
  projectId: string;
  monitoringCycleId: string;
  observationType: ObservationType;
  observedAt: Date;
  valueMean: number;
  valueMin: number;
  valueMax: number;
  valueMedian: number;
  valueStddev: number;
  valueUnit: string;
  qualityFlag: "good" | "acceptable" | "low" | "failed";
  confidence: number;
  valueDistribution: Record<string, unknown>;
  metadata: RasterTileMetadata;
}

function buildRasterMetadata(projectId: string, observationType: ObservationType, observedAt: Date): RasterTileMetadata {
  const stamp = observedAt.toISOString().slice(0, 10);
  return {
    rasterAssetPath: `rasters/${projectId}/${observationType}/${stamp}.tif`,
    thumbnailPath: `thumbnails/${projectId}/${observationType}/${stamp}.png`,
    tileLayerPath: `tiles/${projectId}/${observationType}/${stamp}/{z}/{x}/{y}.png`,
    sourceDataset: "PREPARED_PLACEHOLDER_DATASET",
    sourceResolutionM: 10,
    processingAlgorithm: "baseline_preparation_stub_v1",
    processingParameters: {
      source: "initialization_hook",
      pendingComputation: true,
    },
  };
}

export function buildBaselineObservationInputs(params: {
  projectId: string;
  monitoringCycleId: string;
  polygon: NormalizedPolygon;
  observedAt?: Date;
}): BaselineObservationInput[] {
  const observedAt = params.observedAt ?? new Date();
  const metrics = computeSpatialMetrics(params.polygon);
  const coverageEstimate = Number(Math.min(100, Math.max(70, metrics.areaHectares / 20)).toFixed(2));

  const baselineTemplates: Array<{
    type: ObservationType;
    mean: number;
    min: number;
    max: number;
    median: number;
    stddev: number;
    unit: string;
  }> = [
    { type: "land_cover", mean: 1, min: 0, max: 1, median: 1, stddev: 0, unit: "class_index" },
    { type: "moisture_index", mean: 0.25, min: -0.1, max: 0.6, median: 0.24, stddev: 0.08, unit: "index" },
    { type: "surface_temp", mean: 27.5, min: 20.1, max: 33.4, median: 27.2, stddev: 2.9, unit: "degC" },
    { type: "vegetation_fraction", mean: 0.42, min: 0.12, max: 0.81, median: 0.4, stddev: 0.11, unit: "fraction" },
  ];

  return baselineTemplates.map((template) => ({
    projectId: params.projectId,
    monitoringCycleId: params.monitoringCycleId,
    observationType: template.type,
    observedAt,
    valueMean: template.mean,
    valueMin: template.min,
    valueMax: template.max,
    valueMedian: template.median,
    valueStddev: template.stddev,
    valueUnit: template.unit,
    qualityFlag: "acceptable",
    confidence: 0.55,
    valueDistribution: {
      bins: [template.min, template.mean, template.max],
      coveragePct: coverageEstimate,
      placeholder: true,
    },
    metadata: buildRasterMetadata(params.projectId, template.type, observedAt),
  }));
}

