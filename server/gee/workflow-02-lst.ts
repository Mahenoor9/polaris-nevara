import ee from "@google/earthengine";
import { geeInitialized } from "../geeService";
import { toEePolygonCoords } from "./polygon-util";

export interface LSTResult {
  lst_mean: number | null;
  lst_min: number | null;
  lst_max: number | null;
  dataset: string;
  acquisition_date: string | null;
  fallback_used: boolean;
}

const LOG = "[GEE] [LST]";

function mockResult(reason: string): LSTResult {
  const base = 30 + Math.random() * 6;
  console.log(`${LOG} [Mock/${reason}] Returning mock LST result`);
  return {
    lst_mean: parseFloat(base.toFixed(2)),
    lst_min: parseFloat((base - 4).toFixed(2)),
    lst_max: parseFloat((base + 6).toFixed(2)),
    dataset: "mock",
    acquisition_date: null,
    fallback_used: true,
  };
}

/**
 * Landsat 8/9 Surface Temperature workflow.
 * ST_B10 scale: kelvin = pixel * 0.00341802 + 149.0 → celsius = kelvin - 273.15
 * Uses LC08 + LC09 Collection 2 Level-2 merged and cloud-filtered.
 */
export async function runLSTWorkflow(
  polygon: any,
  startDate: string,
  endDate: string,
): Promise<LSTResult> {
  if (!geeInitialized) return mockResult("not_initialized");

  try {
    const region = ee.Geometry.Polygon(toEePolygonCoords(polygon)).simplify(100);

    const cloudFilter = (img: any) => {
      const qa = img.select("QA_PIXEL");
      const mask = qa.bitwiseAnd(1 << 3).eq(0).and(qa.bitwiseAnd(1 << 4).eq(0));
      return img.updateMask(mask);
    };

    const toLstCelsius = (img: any) =>
      img.select("ST_B10")
        .multiply(0.00341802)
        .add(149.0)
        .subtract(273.15)
        .rename("LST")
        .copyProperties(img, ["system:time_start"]);

    const l8 = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2")
      .filterBounds(region)
      .filterDate(startDate, endDate)
      .filter(ee.Filter.lt("CLOUD_COVER", 30))
      .map(cloudFilter)
      .map(toLstCelsius);

    const l9 = ee.ImageCollection("LANDSAT/LC09/C02/T1_L2")
      .filterBounds(region)
      .filterDate(startDate, endDate)
      .filter(ee.Filter.lt("CLOUD_COVER", 30))
      .map(cloudFilter)
      .map(toLstCelsius);

    const merged = l8.merge(l9).sort("system:time_start", false);
    const imageCount = await new Promise<number>((resolve) => {
      merged.size().evaluate((n: number, err: any) => resolve(err ? 0 : (n ?? 0)));
    });

    if (imageCount === 0) return mockResult("no_imagery");

    const lstMedian = merged.median().clip(region);

    const stats = await new Promise<{ mean: number | null; min: number | null; max: number | null }>(
      (resolve, reject) => {
        lstMedian
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
              mean: typeof data?.LST === "number" ? data.LST : null,
              min: typeof data?.LST_min === "number" ? data.LST_min : null,
              max: typeof data?.LST_max === "number" ? data.LST_max : null,
            });
          });
      },
    );

    // Acquisition date of the most recent image in the window
    let acquisitionDate: string | null = null;
    try {
      const first = merged.first();
      acquisitionDate = await new Promise<string | null>((resolve) => {
        first.date().format("YYYY-MM-dd").evaluate((d: string, err: any) => {
          resolve(err ? null : (d ?? null));
        });
      });
    } catch { /* non-critical */ }

    console.log(`${LOG} Stats: mean=${stats.mean?.toFixed(2)}°C, min=${stats.min?.toFixed(2)}°C, max=${stats.max?.toFixed(2)}°C`);

    return {
      lst_mean: stats.mean !== null ? parseFloat(stats.mean.toFixed(2)) : null,
      lst_min: stats.min !== null ? parseFloat(stats.min.toFixed(2)) : null,
      lst_max: stats.max !== null ? parseFloat(stats.max.toFixed(2)) : null,
      dataset: "LANDSAT/LC08+LC09/C02/T1_L2",
      acquisition_date: acquisitionDate,
      fallback_used: false,
    };
  } catch (err: any) {
    console.warn(`${LOG} Error:`, err.message || err);
    return mockResult("error");
  }
}
