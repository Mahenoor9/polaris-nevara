import ee from "@google/earthengine";
import { geeInitialized } from "../geeService";
import { toEePolygonCoords } from "./polygon-util";

export type SlopeClass = "flat" | "gentle" | "moderate" | "steep";
export type RunoffRisk = "low" | "medium" | "high";

export interface HydrologyResult {
  mean_elevation: number | null;
  min_elevation: number | null;
  max_elevation: number | null;
  mean_slope: number | null;
  slope_class: SlopeClass;
  runoff_risk: RunoffRisk;
  water_retention_score: number;
  hydro_stress_score: number;
  dataset: string;
  methodology_version: string;
  fallback_used: boolean;
}

interface TerrainStats {
  meanElevation: number | null;
  minElevation: number | null;
  maxElevation: number | null;
  meanSlope: number | null;
}

const LOG = "[GEE] [DEM/Hydro]";
const DATASET = "USGS/SRTMGL1_003";
const METHODOLOGY_VERSION = "dem-hydrology-v1.0";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return parseFloat(value.toFixed(2));
}

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicUnit(input: string): number {
  return stableHash(input) / 0xffffffff;
}

function classifySlope(meanSlope: number | null): SlopeClass {
  if (meanSlope === null) return "gentle";
  if (meanSlope < 2) return "flat";
  if (meanSlope < 5) return "gentle";
  if (meanSlope < 15) return "moderate";
  return "steep";
}

function classifyRunoff(riskIndex: number): RunoffRisk {
  if (riskIndex >= 60) return "high";
  if (riskIndex >= 30) return "medium";
  return "low";
}

function buildResult(stats: TerrainStats, dataset: string, fallbackUsed: boolean): HydrologyResult {
  const meanSlope = stats.meanSlope;
  const relief =
    stats.minElevation !== null && stats.maxElevation !== null
      ? Math.max(0, stats.maxElevation - stats.minElevation)
      : 0;

  const runoffIndex = clamp((meanSlope ?? 3) * 4 + relief * 0.05, 0, 100);
  const waterRetention = round2(clamp(100 - runoffIndex, 0, 100));
  const hydroStress = round2(runoffIndex);

  return {
    mean_elevation: stats.meanElevation !== null ? round2(stats.meanElevation) : null,
    min_elevation: stats.minElevation !== null ? round2(stats.minElevation) : null,
    max_elevation: stats.maxElevation !== null ? round2(stats.maxElevation) : null,
    mean_slope: meanSlope !== null ? round2(meanSlope) : null,
    slope_class: classifySlope(meanSlope),
    runoff_risk: classifyRunoff(runoffIndex),
    water_retention_score: waterRetention,
    hydro_stress_score: hydroStress,
    dataset,
    methodology_version: METHODOLOGY_VERSION,
    fallback_used: fallbackUsed,
  };
}

function mockResult(polygon: any, reason: string): HydrologyResult {
  console.log(`${LOG} [Mock/${reason}] Returning deterministic DEM/Hydrology result`);
  const seed = JSON.stringify({ polygon });
  const meanElevation = 650 + deterministicUnit(`${seed}:elev`) * 450;
  const relief = 15 + deterministicUnit(`${seed}:relief`) * 85;
  const meanSlope = 1.5 + deterministicUnit(`${seed}:slope`) * 10;

  return buildResult(
    {
      meanElevation,
      minElevation: meanElevation - relief * 0.45,
      maxElevation: meanElevation + relief * 0.55,
      meanSlope,
    },
    "mock",
    true,
  );
}

/**
 * DEM & Hydrology workflow — GEE Script 4.
 *
 * Dataset: USGS/SRTMGL1_003 (SRTM 30 m DEM).
 * Method:  Terrain.slope(elevation), then reduce mean/min/max terrain stats
 *          over the project polygon. Runoff and hydrological stress are
 *          deterministic proxies derived from mean slope and local relief.
 */
export async function runDemHydrologyWorkflow(polygon: any): Promise<HydrologyResult> {
  if (!geeInitialized) return mockResult(polygon, "not_initialized");

  try {
    const region = ee.Geometry.Polygon(toEePolygonCoords(polygon)).simplify(100);
    const elevation = ee.Image(DATASET).select("elevation").clip(region);
    const slope = ee.Terrain.slope(elevation).rename("slope").clip(region);
    const terrain = ee.Image.cat([elevation.rename("elevation"), slope]);

    const stats = await new Promise<TerrainStats>((resolve, reject) => {
      terrain
        .reduceRegion({
          reducer: ee.Reducer.mean()
            .combine({ reducer2: ee.Reducer.minMax(), sharedInputs: true }),
          geometry: region,
          scale: 30,
          maxPixels: 1e9,
          bestEffort: true,
        })
        .evaluate((data: any, err: any) => {
          if (err) return reject(new Error(String(err)));
          resolve({
            meanElevation: typeof data?.elevation === "number" ? data.elevation : null,
            minElevation: typeof data?.elevation_min === "number" ? data.elevation_min : null,
            maxElevation: typeof data?.elevation_max === "number" ? data.elevation_max : null,
            meanSlope: typeof data?.slope === "number" ? data.slope : null,
          });
        });
    });

    const result = buildResult(stats, DATASET, false);
    console.log(`${LOG} Complete: elevation=${result.mean_elevation}m, slope=${result.mean_slope}°, runoff=${result.runoff_risk}`);
    return result;
  } catch (err: any) {
    console.warn(`${LOG} Error:`, err.message || err);
    return mockResult(polygon, "error");
  }
}
