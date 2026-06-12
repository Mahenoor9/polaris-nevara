import ee from "@google/earthengine";
import { geeInitialized } from "../geeService";
import { toEePolygonCoords } from "./polygon-util";

export interface YearlyNdvi {
  year: number;
  ndvi_mean: number | null;
  delta: number | null;
}

export interface HistoricalResult {
  baseline_year: number;
  current_year: number;
  trend_direction: "improving" | "declining" | "stable";
  trend_strength: number;
  yearly_metrics: YearlyNdvi[];
  dataset: string;
  fallback_used: boolean;
}

const LOG = "[GEE] [Historical]";
const DEFAULT_START_YEAR = 2020;

function currentYear(): number {
  return new Date().getFullYear();
}

/**
 * Linear regression over valid (non-null) NDVI points.
 * slope > 0.005  → improving
 * slope < -0.005 → declining
 * else           → stable
 * trend_strength = |slope| rounded to 4 decimal places
 */
function computeTrend(metrics: YearlyNdvi[]): {
  direction: "improving" | "declining" | "stable";
  strength: number;
} {
  const valid = metrics.filter((m) => m.ndvi_mean !== null);
  if (valid.length < 2) return { direction: "stable", strength: 0 };

  const n = valid.length;
  const xs = valid.map((_, i) => i);
  const ys = valid.map((m) => m.ndvi_mean as number);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((s, x, i) => s + (x - xMean) * ((ys[i] as number) - yMean), 0);
  const den = xs.reduce((s, x) => s + (x - xMean) ** 2, 0);
  const slope = den === 0 ? 0 : num / den;

  const direction: "improving" | "declining" | "stable" =
    slope > 0.005 ? "improving" : slope < -0.005 ? "declining" : "stable";
  return { direction, strength: parseFloat(Math.abs(slope).toFixed(4)) };
}

function mockResult(startYear: number, endYear: number, reason: string): HistoricalResult {
  console.log(`${LOG} [Mock/${reason}] Returning mock historical result`);
  const baseNdvi = 0.38 + Math.random() * 0.08;
  const yearly: YearlyNdvi[] = [];
  let prev: number | null = null;
  for (let yr = startYear; yr <= endYear; yr++) {
    const ndvi = parseFloat(
      (baseNdvi + (yr - startYear) * 0.015 + (Math.random() - 0.5) * 0.02).toFixed(4),
    );
    yearly.push({
      year: yr,
      ndvi_mean: ndvi,
      delta: prev !== null ? parseFloat((ndvi - prev).toFixed(4)) : null,
    });
    prev = ndvi;
  }
  const trend = computeTrend(yearly);
  return {
    baseline_year: startYear,
    current_year: endYear,
    trend_direction: trend.direction,
    trend_strength: trend.strength,
    yearly_metrics: yearly,
    dataset: "mock",
    fallback_used: true,
  };
}

/**
 * Historical NDVI Change Analysis — GEE Script 5.
 *
 * Dataset: COPERNICUS/S2_SR_HARMONIZED (Sentinel-2 L2A harmonised, 10 m)
 * Method:  Annual median NDVI composite per year.
 *          NDVI = (B8 − B4) / (B8 + B4).
 *          Cloud filter: CLOUDY_PIXEL_PERCENTAGE < 30.
 * Output:  yearly_metrics[], trend_direction, trend_strength (linear regression slope).
 *
 * Each year is processed in a sequential GEE evaluate() call.
 * Mock fallback activates when GEE is not initialised or an error occurs.
 */
export async function runHistoricalWorkflow(
  polygon: any,
  startYear = DEFAULT_START_YEAR,
  endYear = currentYear(),
): Promise<HistoricalResult> {
  if (!geeInitialized) return mockResult(startYear, endYear, "not_initialized");

  try {
    const region = ee.Geometry.Polygon(toEePolygonCoords(polygon)).simplify(100);
    const yearly: YearlyNdvi[] = [];
    let prev: number | null = null;

    for (let yr = startYear; yr <= endYear; yr++) {
      const yearStart = `${yr}-01-01`;
      const yearEnd = `${yr}-12-31`;

      const ndviMean = await new Promise<number | null>((resolve) => {
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
          .filterBounds(region)
          .filterDate(yearStart, yearEnd)
          .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30))
          .map((img: any) =>
            img.normalizedDifference(["B8", "B4"]).rename("NDVI"),
          )
          .median()
          .reduceRegion({
            reducer: ee.Reducer.mean(),
            geometry: region,
            scale: 10,
            maxPixels: 1e9,
            bestEffort: true,
          })
          .evaluate((data: any, err: any) => {
            if (err || data === null) return resolve(null);
            const val = typeof data?.NDVI === "number" ? data.NDVI : null;
            resolve(val !== null ? parseFloat(val.toFixed(4)) : null);
          });
      });

      yearly.push({
        year: yr,
        ndvi_mean: ndviMean,
        delta:
          ndviMean !== null && prev !== null
            ? parseFloat((ndviMean - prev).toFixed(4))
            : null,
      });
      prev = ndviMean;
    }

    const trend = computeTrend(yearly);
    console.log(
      `${LOG} Complete: ${yearly.length} years, trend=${trend.direction}, strength=${trend.strength}`,
    );

    return {
      baseline_year: startYear,
      current_year: endYear,
      trend_direction: trend.direction,
      trend_strength: trend.strength,
      yearly_metrics: yearly,
      dataset: "COPERNICUS/S2_SR_HARMONIZED",
      fallback_used: false,
    };
  } catch (err: any) {
    console.warn(`${LOG} Error:`, err.message || err);
    return mockResult(startYear, endYear, "error");
  }
}
