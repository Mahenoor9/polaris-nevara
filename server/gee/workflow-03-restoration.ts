import ee from "@google/earthengine";
import { geeInitialized } from "../geeService";
import { toEePolygonCoords } from "./polygon-util";
import type { HydrologyResult } from "./workflow-04-dem-hydro";

export type RestorationPriorityLevel = "high" | "medium" | "low";

export interface RestorationResult {
  suitability_score: number;
  vegetation_condition: number;
  moisture_condition: number;
  soil_condition: number;
  slope_condition: number;
  priority_level: RestorationPriorityLevel;
  methodology_version: string;
  dataset: string;
  fallback_used: boolean;
}

interface SpectralIndicators {
  ndvi_mean: number | null;
  ndmi_mean: number | null;
  bsi_mean: number | null;
}

const LOG = "[GEE] [Restoration]";
const METHODOLOGY_VERSION = "restoration-suitability-v2.0";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return parseFloat(value.toFixed(2));
}

function priorityLevel(score: number): RestorationPriorityLevel {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function scoreVegetation(ndvi: number | null): number {
  if (ndvi === null) return 50;
  return round2(clamp(((ndvi + 0.1) / 0.8) * 100, 0, 100));
}

function scoreMoisture(ndmi: number | null): number {
  if (ndmi === null) return 50;
  return round2(clamp(((ndmi + 0.3) / 0.8) * 100, 0, 100));
}

function scoreSoil(bsi: number | null): number {
  if (bsi === null) return 50;
  return round2(clamp((1 - ((bsi + 0.4) / 0.9)) * 100, 0, 100));
}

function scoreSlope(meanSlope: number | null): number {
  if (meanSlope === null) return 50;
  return round2(clamp(100 - meanSlope * 5, 0, 100));
}

function buildResult(
  indicators: SpectralIndicators,
  dataset: string,
  fallbackUsed: boolean,
  hydrologyResult?: HydrologyResult,
): RestorationResult {
  const vegetation = scoreVegetation(indicators.ndvi_mean);
  const moisture = scoreMoisture(indicators.ndmi_mean);
  const soil = scoreSoil(indicators.bsi_mean);
  const slope = scoreSlope(hydrologyResult?.mean_slope ?? null);

  const suitability = round2(
    vegetation * 0.35 +
    moisture * 0.25 +
    soil * 0.25 +
    slope * 0.15,
  );

  return {
    suitability_score: suitability,
    vegetation_condition: vegetation,
    moisture_condition: moisture,
    soil_condition: soil,
    slope_condition: slope,
    priority_level: priorityLevel(suitability),
    methodology_version: METHODOLOGY_VERSION,
    dataset,
    fallback_used: fallbackUsed,
  };
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

function mockResult(
  polygon: any,
  startDate: string,
  endDate: string,
  reason: string,
  hydrologyResult?: HydrologyResult,
): RestorationResult {
  console.log(`${LOG} [Mock/${reason}] Returning deterministic restoration result`);
  const seed = JSON.stringify({ polygon, startDate, endDate });
  const indicators: SpectralIndicators = {
    ndvi_mean: round2(0.28 + deterministicUnit(`${seed}:ndvi`) * 0.32),
    ndmi_mean: round2(-0.05 + deterministicUnit(`${seed}:ndmi`) * 0.35),
    bsi_mean: round2(-0.2 + deterministicUnit(`${seed}:bsi`) * 0.45),
  };
  return buildResult(indicators, "mock", true, hydrologyResult);
}

/**
 * Restoration Suitability workflow — GEE Script 3.
 *
 * Dataset: COPERNICUS/S2_SR_HARMONIZED
 * Indicators:
 *   NDVI = (B8 − B4) / (B8 + B4)      vegetation condition
 *   NDMI = (B8 − B11) / (B8 + B11)    moisture condition
 *   BSI  = ((B11+B4)−(B8+B2))/...     bare soil condition
 *   slope_condition = 100 − slope×5   terrain suitability from DEM/Hydrology
 */
export async function runRestorationWorkflow(
  polygon: any,
  startDate: string,
  endDate: string,
  hydrologyResult?: HydrologyResult,
): Promise<RestorationResult> {
  if (!geeInitialized) return mockResult(polygon, startDate, endDate, "not_initialized", hydrologyResult);

  try {
    const region = ee.Geometry.Polygon(toEePolygonCoords(polygon)).simplify(100);

    const collection = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
      .filterBounds(region)
      .filterDate(startDate, endDate)
      .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30));

    const imageCount = await new Promise<number>((resolve) => {
      collection.size().evaluate((n: number, err: any) => resolve(err ? 0 : (n ?? 0)));
    });

    if (imageCount === 0) return mockResult(polygon, startDate, endDate, "no_imagery", hydrologyResult);

    const composite = collection.median().clip(region);
    const indicatorsImage = ee.Image.cat([
      composite.normalizedDifference(["B8", "B4"]).rename("NDVI"),
      composite.normalizedDifference(["B8", "B11"]).rename("NDMI"),
      composite
        .expression(
          "((SWIR + RED) - (NIR + BLUE)) / ((SWIR + RED) + (NIR + BLUE))",
          {
            SWIR: composite.select("B11"),
            RED: composite.select("B4"),
            NIR: composite.select("B8"),
            BLUE: composite.select("B2"),
          },
        )
        .rename("BSI"),
    ]);

    const stats = await new Promise<SpectralIndicators>((resolve, reject) => {
      indicatorsImage
        .reduceRegion({
          reducer: ee.Reducer.mean(),
          geometry: region,
          scale: 10,
          maxPixels: 1e9,
          bestEffort: true,
        })
        .evaluate((data: any, err: any) => {
          if (err) return reject(new Error(String(err)));
          resolve({
            ndvi_mean: typeof data?.NDVI === "number" ? data.NDVI : null,
            ndmi_mean: typeof data?.NDMI === "number" ? data.NDMI : null,
            bsi_mean: typeof data?.BSI === "number" ? data.BSI : null,
          });
        });
    });

    const result = buildResult(stats, "COPERNICUS/S2_SR_HARMONIZED", false, hydrologyResult);
    console.log(`${LOG} Complete: score=${result.suitability_score}, priority=${result.priority_level}`);
    return result;
  } catch (err: any) {
    console.warn(`${LOG} Error:`, err.message || err);
    return mockResult(polygon, startDate, endDate, "error", hydrologyResult);
  }
}
