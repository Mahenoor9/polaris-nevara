import ee from "@google/earthengine";
import { geeInitialized } from "../geeService";
import { toEePolygonCoords } from "./polygon-util";

export interface LULCResult {
  vegetation_pct: number | null;
  water_pct: number | null;
  barren_pct: number | null;
  builtup_pct: number | null;
  other_pct: number | null;
  dataset: string;
  fallback_used: boolean;
}

const LOG = "[GEE] [LULC]";

function mockResult(reason: string): LULCResult {
  const veg = 40 + Math.random() * 15;
  const water = 15 + Math.random() * 10;
  const barren = 12 + Math.random() * 8;
  const built = 10 + Math.random() * 8;
  const other = Math.max(0, 100 - veg - water - barren - built);
  console.log(`${LOG} [Mock/${reason}] Returning mock LULC result`);
  return {
    vegetation_pct: parseFloat(veg.toFixed(2)),
    water_pct: parseFloat(water.toFixed(2)),
    barren_pct: parseFloat(barren.toFixed(2)),
    builtup_pct: parseFloat(built.toFixed(2)),
    other_pct: parseFloat(other.toFixed(2)),
    dataset: "mock",
    fallback_used: true,
  };
}

/**
 * Dynamic World LULC classification workflow.
 * Uses GOOGLE/DYNAMICWORLD/V1 — 10m resolution, 9 classes.
 *
 * Class indices:
 *   0: water          → water_pct
 *   1: trees          ↘
 *   2: grass          ↘
 *   3: flooded_veg    → vegetation_pct
 *   4: crops          ↗
 *   5: shrub_and_scrub↗
 *   6: built          → builtup_pct
 *   7: bare           → barren_pct
 *   8: snow_and_ice   → other_pct
 */
export async function runLULCWorkflow(
  polygon: any,
  startDate: string,
  endDate: string,
): Promise<LULCResult> {
  if (!geeInitialized) return mockResult("not_initialized");

  try {
    const region = ee.Geometry.Polygon(toEePolygonCoords(polygon)).simplify(100);

    const dw = ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1")
      .filterBounds(region)
      .filterDate(startDate, endDate)
      .select("label");

    const imageCount = await new Promise<number>((resolve) => {
      dw.size().evaluate((n: number, err: any) => resolve(err ? 0 : (n ?? 0)));
    });

    if (imageCount === 0) return mockResult("no_imagery");

    // Mode composite: dominant land class per pixel
    const modeImg = dw.mode().clip(region);

    const histogram = await new Promise<Record<string, number>>((resolve, reject) => {
      modeImg
        .reduceRegion({
          reducer: ee.Reducer.frequencyHistogram(),
          geometry: region,
          scale: 10,
          maxPixels: 1e9,
          bestEffort: true,
        })
        .evaluate((data: any, err: any) => {
          if (err) return reject(new Error(String(err)));
          resolve(data?.label ?? {});
        });
    });

    const get = (k: string) => histogram[k] ?? 0;

    // Aggregate into 5 categories
    const vegCount = get("1") + get("2") + get("3") + get("4") + get("5");
    const waterCount = get("0");
    const builtCount = get("6");
    const bareCount = get("7");
    const otherCount = get("8");
    const total = vegCount + waterCount + builtCount + bareCount + otherCount;

    if (total === 0) return mockResult("zero_total");

    const pct = (n: number) => parseFloat(((n / total) * 100).toFixed(2));

    console.log(`${LOG} veg=${pct(vegCount)}% water=${pct(waterCount)}% built=${pct(builtCount)}% bare=${pct(bareCount)}%`);

    return {
      vegetation_pct: pct(vegCount),
      water_pct: pct(waterCount),
      barren_pct: pct(bareCount),
      builtup_pct: pct(builtCount),
      other_pct: pct(otherCount),
      dataset: "GOOGLE/DYNAMICWORLD/V1",
      fallback_used: false,
    };
  } catch (err: any) {
    console.warn(`${LOG} Error:`, err.message || err);
    return mockResult("error");
  }
}
