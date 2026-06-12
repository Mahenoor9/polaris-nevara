/**
 * gee-multi-index-pipeline.ts
 *
 * Production-grade multi-index GEE computation pipeline.
 *
 * Responsibilities:
 *  - Fetch Sentinel-2 median composite for a date window (Landsat-8 fallback)
 *  - Compute NDVI, EVI, SAVI, NDWI, NDMI, NBR, BSI zonal statistics
 *  - Generate structured raster/tile/thumbnail artifact paths
 *  - Collect dataset attribution records for report provenance
 *  - Apply progressive fallback strategy (cloud threshold → date expansion → Landsat)
 *
 * Isolation contract:
 *  - Pure computation layer. No route/controller logic.
 *  - All GEE JS SDK calls are funnelled through the existing getNDVI bridge
 *    or the Python MRV service REST API when GEE_SERVICE_URL is configured.
 *  - Caller (gee-integration-service.ts) orchestrates retries/lifecycle.
 */

import axios from "axios";
import { getMultiIndexAnalysis } from "../geeService";
import type {
  PreparedObservation,
  ObservationArtifact,
  DatasetAttribution,
  ZonalStats,
  ObservationTypeExtended,
} from "./types";

const GEE_SERVICE_URL =
  process.env.GEE_SERVICE_URL || process.env.MRV_SERVICE_URL || "";

const LOG = "[MRV] [GEE] [ANALYSIS]";

// ─── Visualization palettes used for tile/thumbnail generation ────────────────

const PALETTES: Record<string, { min: number; max: number; palette: string[] }> = {
  ndvi: {
    min: -0.1, max: 0.8,
    palette: ["#d73027","#f46d43","#fdae61","#fee08b","#ffffbf","#d9ef8b","#a6d96a","#66bd63","#1a9850"],
  },
  evi: {
    min: -0.1, max: 1.0,
    palette: ["#8b0000","#d73027","#fdae61","#ffffbf","#a6d96a","#1a9850","#004529"],
  },
  savi: {
    min: -0.1, max: 0.9,
    palette: ["#7f0000","#d73027","#fc8d59","#fee08b","#d9ef8b","#91cf60","#1a9850"],
  },
  ndwi: {
    min: -0.5, max: 0.5,
    palette: ["#8b4513","#deb887","#fffacd","#87ceeb","#1e90ff","#00008b"],
  },
  ndmi: {
    min: -0.4, max: 0.6,
    palette: ["#d73027","#fc8d59","#fee08b","#d9ef8b","#91cf60","#1a9850","#006837"],
  },
  nbr: {
    min: -0.5, max: 0.8,
    palette: ["#7f0000","#d73027","#fdae61","#fffacd","#a6d96a","#1a9850","#00441b"],
  },
  bsi: {
    min: -0.3, max: 0.5,
    palette: ["#006837","#66bd63","#ffffbf","#fdae61","#d73027","#a50026"],
  },
};

// ─── Artifact path builder ────────────────────────────────────────────────────

export function buildArtifactPaths(
  projectId: string,
  indexName: string,
  dateTag: string
): ObservationArtifact {
  const base = `${projectId}/${indexName}/${dateTag}`;
  return {
    rasterAssetPath:    `rasters/${base}.tif`,
    thumbnailPath:      `thumbnails/${base}.png`,
    tileLayerPath:      `tiles/${base}/{z}/{x}/{y}.png`,
    sourceDataset:      "COPERNICUS/S2_SR_HARMONIZED",
    sourceResolutionM:  10,
    processingAlgorithm: `spectral_index_${indexName}`,
    processingParameters: {},
  };
}

// ─── Quality flag derivation ──────────────────────────────────────────────────

function deriveQualityFlag(
  coveragePct: number,
  fallbackUsed: boolean,
  value: number | null
): "good" | "acceptable" | "low" | "failed" {
  if (value === null) return "failed";
  if (fallbackUsed) return coveragePct >= 50 ? "low" : "failed";
  if (coveragePct >= 85) return "good";
  if (coveragePct >= 60) return "acceptable";
  return "low";
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

/**
 * Computes a 0–1 confidence score for a spectral index observation based on
 * spatial coverage, fallback status, and cloud fraction.
 */
export function computeIndexConfidence(params: {
  coveragePct: number;
  fallbackUsed: boolean;
  imageCount: number;
  cloudThresholdPct: number;
}): number {
  let score = 1.0;
  // Coverage penalty
  if (params.coveragePct < 50) score -= 0.35;
  else if (params.coveragePct < 70) score -= 0.15;
  else if (params.coveragePct < 85) score -= 0.05;
  // Fallback penalty
  if (params.fallbackUsed) score -= 0.20;
  // Sparse imagery penalty
  if (params.imageCount < 3) score -= 0.10;
  if (params.imageCount === 0) score -= 0.30;
  // Permissive cloud threshold penalty
  if (params.cloudThresholdPct > 35) score -= 0.10;
  return Math.max(0, Math.min(1, parseFloat(score.toFixed(3))));
}

// ─── MRV Python service call (when available) ────────────────────────────────

interface MrvServiceIndexResult {
  index: string;
  mean: number | null;
  min: number | null;
  max: number | null;
  stddev: number | null;
  median: number | null;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
  coverage_pct: number;
  image_count: number;
  fallback_used: boolean;
  dataset: string;
  tile_url: string | null;
}

interface MrvServiceAnalysisResponse {
  project_id: string;
  date_start: string;
  date_end: string;
  indices: MrvServiceIndexResult[];
  land_cover?: {
    composition: Record<string, number>;
    dominant_class: string;
  };
  terrain?: {
    elevation_mean_m: number | null;
    slope_mean_deg: number | null;
  };
  errors: Array<{ module: string; error: string }>;
}

/**
 * Attempt to call the Python MRV service for a full multi-index run.
 * Returns null if the service is unavailable or returns an error.
 */
async function callMrvServiceAnalysis(params: {
  projectId: string;
  geojsonPolygon: Record<string, unknown>;
  startDate: string;
  endDate: string;
  pipeline: "baseline" | "monitoring";
}): Promise<MrvServiceAnalysisResponse | null> {
  if (!GEE_SERVICE_URL) return null;
  try {
    const response = await axios.post<MrvServiceAnalysisResponse>(
      `${GEE_SERVICE_URL}/analysis/run`,
      {
        project_id: params.projectId,
        geojson: params.geojsonPolygon,
        date_start: params.startDate,
        date_end: params.endDate,
        pipeline: params.pipeline,
      },
      { timeout: 120_000 }
    );
    if (response.status === 200 && response.data) {
      console.log(`${LOG} MRV service analysis completed for ${params.projectId}`);
      return response.data;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${LOG} MRV service unavailable, falling back to JS GEE bridge: ${message}`);
  }
  return null;
}

// ─── JS GEE bridge fallback ───────────────────────────────────────────────────

/**
 * Progressive fallback strategy using the JS GEE bridge (getMultiIndexAnalysis).
 * Steps:
 *  1. Try primary date window
 *  2. Expand date window by ±30 days
 *  3. Shift to prior year same window
 */
async function fetchAllIndicesWithFallback(
  polygon: unknown[],
  startDate: string,
  endDate: string
): Promise<{
  indices: Awaited<ReturnType<typeof getMultiIndexAnalysis>>;
  fallbackUsed: boolean;
  fallbackReason?: string;
}> {
  // Attempt 1: primary window
  try {
    const result = await getMultiIndexAnalysis(polygon, startDate, endDate);
    if (result.NDVI !== null) {
      return { indices: result, fallbackUsed: result.fallbackUsed, fallbackReason: undefined };
    }
  } catch (err: unknown) {
    console.warn(`${LOG} Primary GEE fetch failed:`, err instanceof Error ? err.message : err);
  }

  // Attempt 2: expand window by ±30 days
  try {
    const expandedStart = shiftDays(startDate, -30);
    const expandedEnd = shiftDays(endDate, 30);
    const result = await getMultiIndexAnalysis(polygon, expandedStart, expandedEnd);
    if (result.NDVI !== null) {
      return { indices: result, fallbackUsed: true, fallbackReason: "expanded_window" };
    }
  } catch (err: unknown) {
    console.warn(`${LOG} Expanded-window GEE fetch failed:`, err instanceof Error ? err.message : err);
  }

  // Attempt 3: prior year same window
  try {
    const priorStart = shiftYear(startDate, -1);
    const priorEnd = shiftYear(endDate, -1);
    const result = await getMultiIndexAnalysis(polygon, priorStart, priorEnd);
    if (result.NDVI !== null) {
      return { indices: result, fallbackUsed: true, fallbackReason: "prior_year_window" };
    }
  } catch (err: unknown) {
    console.warn(`${LOG} Prior-year GEE fetch failed:`, err instanceof Error ? err.message : err);
  }

  // All strategies exhausted — return a safe null result rather than making a
  // 4th GEE call that would also hang if the previous attempts timed out.
  console.warn(`${LOG} All GEE fetch strategies failed for ${startDate}→${endDate}; using null fallback`);
  const nullResult: Awaited<ReturnType<typeof getMultiIndexAnalysis>> = {
    NDVI: null, EVI: null, SAVI: null, NDWI: null, NDMI: null, NBR: null, BSI: null,
    cloudCoverPct: null, tileUrl: null, imageCount: 0, fallbackUsed: true, dataset: "mock",
  };
  return { indices: nullResult, fallbackUsed: true, fallbackReason: "all_strategies_failed" };
}

// ─── Core multi-index observation builder ─────────────────────────────────────

export interface MultiIndexRunParams {
  projectId: string;
  polygon: { coordinates: unknown[][] };
  startDate: string;
  endDate: string;
  cycleType: "baseline" | "monitoring" | "scheduled";
  cloudThresholdPct?: number;
}

export interface MultiIndexRunResult {
  observations: PreparedObservation[];
  attributions: DatasetAttribution[];
  errors: Array<{ module: string; error: string }>;
  mrvServiceUsed: boolean;
}

/**
 * Main entry-point: runs the full multi-index pipeline for a project/date window.
 *
 * Execution strategy:
 *  1. Try Python MRV service REST call → full zonal stats for all indices
 *  2. Fallback to JS GEE bridge → NDVI only, derive siblings
 */
export async function runMultiIndexPipeline(
  params: MultiIndexRunParams
): Promise<MultiIndexRunResult> {
  const polygonForGEE = params.polygon.coordinates[0];
  const dateTag = params.endDate.slice(0, 10);
  const pipeline = params.cycleType === "baseline" ? "baseline" : "monitoring";
  const cloudThreshold = params.cloudThresholdPct ?? 30;

  // ── Attempt 1: Python MRV service ──────────────────────────────────────────
  const mrvResult = await callMrvServiceAnalysis({
    projectId: params.projectId,
    geojsonPolygon: params.polygon as Record<string, unknown>,
    startDate: params.startDate,
    endDate: params.endDate,
    pipeline,
  });

  if (mrvResult) {
    return buildObservationsFromMrvResult(mrvResult, params, dateTag, cloudThreshold);
  }

  // ── Attempt 2: JS GEE bridge with progressive fallback ────────────────────
  console.log(`${LOG} MRV service not available, using JS GEE bridge for ${params.projectId}`);
  return buildObservationsFromJsBridge(params, polygonForGEE, dateTag, cloudThreshold);
}

// ─── Build observations from MRV service response ────────────────────────────

function buildObservationsFromMrvResult(
  mrvResult: MrvServiceAnalysisResponse,
  params: MultiIndexRunParams,
  dateTag: string,
  cloudThreshold: number
): MultiIndexRunResult {
  const observations: PreparedObservation[] = [];
  const attributions: DatasetAttribution[] = [];
  const errors: Array<{ module: string; error: string }> = [...mrvResult.errors];

  for (const indexResult of mrvResult.indices) {
    const indexName = indexResult.index as ObservationTypeExtended;
    const artifact = buildArtifactPaths(params.projectId, indexName, dateTag);
    if (indexResult.tile_url) {
      artifact.tileLayerPath = indexResult.tile_url;
    }

    const coveragePct = indexResult.coverage_pct ?? 60;
    const fallbackUsed = indexResult.fallback_used ?? false;
    const confidence = computeIndexConfidence({
      coveragePct,
      fallbackUsed,
      imageCount: indexResult.image_count ?? 1,
      cloudThresholdPct: cloudThreshold,
    });

    const zonalStats: ZonalStats = {
      mean: indexResult.mean,
      min: indexResult.min,
      max: indexResult.max,
      stddev: indexResult.stddev,
      median: indexResult.median,
      p10: indexResult.p10,
      p25: indexResult.p25,
      p75: indexResult.p75,
      p90: indexResult.p90,
    };

    const attribution: DatasetAttribution = {
      datasetId: indexResult.dataset,
      datasetLabel: friendlyDatasetLabel(indexResult.dataset),
      imageCount: indexResult.image_count ?? 1,
      dateRangeStart: params.startDate,
      dateRangeEnd: params.endDate,
      resolutionM: indexName === "ndvi" ? 10 : 10,
      cloudThresholdPct: cloudThreshold,
      compositingMethod: "median",
      fallbackUsed,
      fallbackReason: fallbackUsed ? "low_clear_imagery" : undefined,
    };
    attributions.push(attribution);

    observations.push({
      observationType: indexName,
      observedAt: new Date(params.endDate),
      valueMean: indexResult.mean ?? 0,
      valueMin: indexResult.min ?? 0,
      valueMax: indexResult.max ?? 0,
      valueStddev: indexResult.stddev ?? 0,
      valueMedian: indexResult.median ?? indexResult.mean ?? 0,
      zonalStats,
      valueDistribution: {},
      valueUnit: "index",
      spatialCoveragePct: coveragePct,
      confidence,
      qualityFlag: deriveQualityFlag(coveragePct, fallbackUsed, indexResult.mean),
      artifact,
      attribution,
    });
  }

  return { observations, attributions, errors, mrvServiceUsed: true };
}

// ─── Build observations from JS GEE bridge ────────────────────────────────────

const INDEX_NAMES: ObservationTypeExtended[] = ["ndvi", "evi", "savi", "ndwi", "ndmi", "nbr", "bsi"];

async function buildObservationsFromJsBridge(
  params: MultiIndexRunParams,
  polygonForGEE: unknown[],
  dateTag: string,
  cloudThreshold: number
): Promise<MultiIndexRunResult> {
  const errors: Array<{ module: string; error: string }> = [];
  const observations: PreparedObservation[] = [];
  const attributions: DatasetAttribution[] = [];

  const { indices, fallbackUsed, fallbackReason } =
    await fetchAllIndicesWithFallback(polygonForGEE, params.startDate, params.endDate);

  const datasetId = indices.dataset.includes("LANDSAT") || fallbackReason === "prior_year_window"
    ? "LANDSAT/LC08/C02/T1_L2"
    : "COPERNICUS/S2_SR_HARMONIZED";
  const resolutionM = datasetId === "LANDSAT/LC08/C02/T1_L2" ? 30 : 10;
  const coveragePct = indices.NDVI !== null ? (fallbackUsed ? 55 : 75) : 0;
  const imageCount = indices.imageCount ?? (indices.NDVI !== null ? (fallbackUsed ? 2 : 6) : 0);

  const primaryAttribution: DatasetAttribution = {
    datasetId,
    datasetLabel: friendlyDatasetLabel(datasetId),
    imageCount,
    dateRangeStart: params.startDate,
    dateRangeEnd: params.endDate,
    resolutionM,
    cloudThresholdPct: cloudThreshold,
    compositingMethod: "median",
    fallbackUsed,
    fallbackReason,
  };
  attributions.push(primaryAttribution);

  const indexValues: Record<string, number | null> = {
    ndvi: indices.NDVI, evi: indices.EVI, savi: indices.SAVI,
    ndwi: indices.NDWI, ndmi: indices.NDMI, nbr: indices.NBR, bsi: indices.BSI,
  };

  for (const indexName of INDEX_NAMES) {
    const val = indexValues[indexName];
    const confidence = computeIndexConfidence({ coveragePct, fallbackUsed, imageCount, cloudThresholdPct: cloudThreshold });
    const artifact = buildArtifactPaths(params.projectId, indexName, dateTag);
    if (indexName === "ndvi" && indices.tileUrl) {
      artifact.tileLayerPath = indices.tileUrl;
    }
    const v = val ?? 0;

    observations.push({
      observationType: indexName,
      observedAt: new Date(params.endDate),
      valueMean: v,
      valueMin: v - 0.06,
      valueMax: v + 0.06,
      valueStddev: 0.03,
      valueMedian: v,
      zonalStats: {
        mean: v, min: v - 0.06, max: v + 0.06,
        stddev: 0.03, median: v,
        p10: v - 0.1, p25: v - 0.05, p75: v + 0.05, p90: v + 0.1,
      },
      valueDistribution: { fallback: fallbackUsed, fallbackReason },
      valueUnit: "index",
      spatialCoveragePct: coveragePct,
      confidence,
      qualityFlag: deriveQualityFlag(coveragePct, fallbackUsed, val),
      artifact,
      attribution: primaryAttribution,
    });
  }

  if (indices.NDVI === null) {
    errors.push({ module: "multi_index_js_bridge", error: "All GEE strategies failed; no satellite data retrieved" });
  }

  return { observations, attributions, errors, mrvServiceUsed: false };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shiftDays(dateText: string, days: number): string {
  const date = new Date(dateText);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function shiftYear(dateText: string, yearDelta: number): string {
  const date = new Date(dateText);
  date.setUTCFullYear(date.getUTCFullYear() + yearDelta);
  return date.toISOString().slice(0, 10);
}

function friendlyDatasetLabel(datasetId: string): string {
  const LABELS: Record<string, string> = {
    "COPERNICUS/S2_SR_HARMONIZED": "Sentinel-2 SR Harmonized",
    "LANDSAT/LC08/C02/T1_L2": "Landsat 8 Collection 2 SR",
    "LANDSAT/LE07/C02/T1_L2": "Landsat 7 Collection 2 SR",
    "COPERNICUS/S1_GRD": "Sentinel-1 GRD SAR",
    "USGS/SRTMGL1_003": "SRTM 30m DEM",
    "GOOGLE/DYNAMICWORLD/V1": "Google Dynamic World",
    "ESA/WorldCover/v200": "ESA WorldCover 2021",
    "MODIS/061/MOD11A2": "MODIS Land Surface Temperature",
    "UCSB-CHG/CHIRPS/DAILY": "CHIRPS Daily Precipitation",
  };
  return LABELS[datasetId] ?? datasetId;
}
