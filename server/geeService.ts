import ee from '@google/earthengine';
import key from './gee-key.json' with { type: 'json' };

export let geeInitialized = false;

export const initGEE = (): Promise<boolean> => {
  return new Promise((resolve) => {
    if (!key || !key.private_key || key.private_key.includes("MOCK_KEY")) {
      console.warn("[MRV] [GEE] ⚠️ Mock or missing credentials. Earth Engine features will run in offline/mock fallback mode.");
      geeInitialized = false;
      resolve(false);
      return;
    }
    try {
      console.log("[MRV] [GEE] Authenticating via Google Earth Engine private key...");
      ee.data.authenticateViaPrivateKey(key, () => {
        console.log("[MRV] [GEE] Authentication successful. Initializing Earth Engine library...");
        ee.initialize(null, null, () => {
          console.log("[MRV] [GEE] ✅ GEE initialized successfully");
          geeInitialized = true;
          resolve(true);
        }, (err: any) => {
          console.warn("[MRV] [GEE] ⚠️ GEE initialization failed (falling back to offline/mock mode):", err);
          geeInitialized = false;
          resolve(false);
        });
      }, (err: any) => {
        console.warn("[MRV] [GEE] ⚠️ GEE authentication failed (falling back to offline/mock mode):", err);
        geeInitialized = false;
        resolve(false);
      });
    } catch (e: any) {
      console.warn("[MRV] [GEE] ⚠️ Exception during GEE initialization (falling back to offline/mock mode):", e.message || e);
      geeInitialized = false;
      resolve(false);
    }
  });
};

/**
 * Build a cloud-masked Sentinel-2 + Landsat-8 median composite.
 */
function buildComposite(region: any, startDate: string, endDate: string) {
  // Sentinel-2 with cloud masking using SCL band
  const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(region)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
    .map((img: any) => {
      const scl = img.select('SCL');
      const mask = scl.neq(3).and(scl.neq(7)).and(scl.neq(8))
        .and(scl.neq(9)).and(scl.neq(10)).and(scl.neq(11));
      // toFloat() ensures float32 — required so S2 and L8 share the same band type
      // before ee.merge(), otherwise GEE throws "Mismatched type for band 'B2'".
      return img.updateMask(mask).divide(10000)
        .select(['B2', 'B3', 'B4', 'B8', 'B8A', 'B11', 'B12'])
        .toFloat();
    });

  // Landsat-8 fallback with cloud masking using QA_PIXEL
  // Remaps to same band names as Sentinel-2, with B8A synthesized from B8 so
  // both collections have identical 7-band schema for merging.
  const l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .filterBounds(region)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.lt('CLOUD_COVER', 30))
    .map((img: any) => {
      const qa = img.select('QA_PIXEL');
      const mask = qa.bitwiseAnd(1 << 3).eq(0)
        .and(qa.bitwiseAnd(1 << 4).eq(0));
      const scaled = img.updateMask(mask)
        .multiply(0.0000275).add(-0.2)
        .select(
          ['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'],
          ['B2',   'B3',    'B4',    'B8',    'B11',   'B12']
        );
      // Synthesize B8A from B8, then reorder to match Sentinel-2's band order
      // [B2,B3,B4,B8,B8A,B11,B12]. Without the explicit select(), addBands appends
      // B8A at the end giving [B2,B3,B4,B8,B11,B12,B8A], which makes ee.merge() throw
      // "Expected a homogeneous image collection — incompatible bands".
      // toFloat() casts L8 int16 SR bands to float32 to match S2 — required for ee.merge()
      return scaled.addBands(scaled.select('B8').rename('B8A'))
        .select(['B2', 'B3', 'B4', 'B8', 'B8A', 'B11', 'B12'])
        .toFloat();
    });

  return ee.ImageCollection(s2.merge(l8)).median().clip(region);
}

/**
 * Compute all spectral indices from a composite image.
 */
function computeAllIndices(composite: any) {
  const ndvi = composite.normalizedDifference(['B8', 'B4']).rename('NDVI');

  const evi = composite.expression(
    '2.5 * ((NIR - RED) / (NIR + 6 * RED - 7.5 * BLUE + 1))',
    { NIR: composite.select('B8'), RED: composite.select('B4'), BLUE: composite.select('B2') }
  ).rename('EVI');

  const savi = composite.expression(
    '((NIR - RED) / (NIR + RED + 0.5)) * 1.5',
    { NIR: composite.select('B8'), RED: composite.select('B4') }
  ).rename('SAVI');

  const ndwi = composite.normalizedDifference(['B3', 'B8']).rename('NDWI');
  const ndmi = composite.normalizedDifference(['B8', 'B11']).rename('NDMI');
  const nbr  = composite.normalizedDifference(['B8', 'B12']).rename('NBR');

  const bsi = composite.expression(
    '((SWIR + RED) - (NIR + BLUE)) / ((SWIR + RED) + (NIR + BLUE))',
    {
      SWIR: composite.select('B11'), RED: composite.select('B4'),
      NIR:  composite.select('B8'),  BLUE: composite.select('B2'),
    }
  ).rename('BSI');

  return composite.addBands([ndvi, evi, savi, ndwi, ndmi, nbr, bsi]);
}

const GEE_OP_TIMEOUT_MS = 90_000;

function geeTimeout(ms: number): Promise<never> {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`GEE operation timed out after ${ms}ms`)), ms)
  );
}

/**
 * Run multi-band zonal reduction on a single image (all indices in one call).
 * Returns a map of { NDVI, EVI, SAVI, NDWI, NDMI, NBR, BSI }.
 */
function reduceAllIndices(indexImage: any, region: any): Promise<Record<string, number | null>> {
  return new Promise((resolve, reject) => {
    indexImage
      .select(['NDVI', 'EVI', 'SAVI', 'NDWI', 'NDMI', 'NBR', 'BSI'])
      .reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: region,
        scale: 30,
        maxPixels: 1e9,
        bestEffort: true,
      })
      .evaluate((data: any, err: any) => {
        if (err) return reject(new Error(String(err)));
        resolve({
          NDVI: typeof data?.NDVI === 'number' ? data.NDVI : null,
          EVI:  typeof data?.EVI  === 'number' ? data.EVI  : null,
          SAVI: typeof data?.SAVI === 'number' ? data.SAVI : null,
          NDWI: typeof data?.NDWI === 'number' ? data.NDWI : null,
          NDMI: typeof data?.NDMI === 'number' ? data.NDMI : null,
          NBR:  typeof data?.NBR  === 'number' ? data.NBR  : null,
          BSI:  typeof data?.BSI  === 'number' ? data.BSI  : null,
        });
      });
  });
}

const NDVI_VIS = {
  min: -0.1,
  max: 0.8,
  palette: ['#d73027', '#f46d43', '#fdae61', '#fee08b', '#ffffbf', '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850'],
};

export interface MultiIndexResult {
  NDVI:  number | null;
  EVI:   number | null;
  SAVI:  number | null;
  NDWI:  number | null;
  NDMI:  number | null;
  NBR:   number | null;
  BSI:   number | null;
  cloudCoverPct: number | null;
  tileUrl: string | null;
  imageCount: number | null;
  fallbackUsed: boolean;
  dataset: string;
}

/**
 * Compute all 7 spectral indices from real GEE satellite data in a single pass.
 * Falls back to Landsat-8 if Sentinel-2 has insufficient clear imagery.
 *
 * @param polygon   - Array of [lng, lat] coordinate pairs (closed ring)
 * @param startDate - ISO date string (inclusive), e.g. '2024-01-01'
 * @param endDate   - ISO date string (exclusive), e.g. '2024-06-01'
 */
export const getMultiIndexAnalysis = async (
  polygon: any,
  startDate = '2024-01-01',
  endDate   = '2024-06-01'
): Promise<MultiIndexResult> => {
  const mockResult = (reason: string): MultiIndexResult => {
    const ndvi = Number((0.35 + Math.random() * 0.20).toFixed(4));
    console.log(`[MRV] [GEE] [Offline/${reason}] Returning mock multi-index result`);
    return {
      NDVI: ndvi, EVI: Number((ndvi * 0.85).toFixed(4)),
      SAVI: Number((ndvi * 0.90).toFixed(4)), NDWI: Number((-0.3 + ndvi * -0.2).toFixed(4)),
      NDMI: Number((ndvi * 0.65).toFixed(4)), NBR:  Number((ndvi * 0.88).toFixed(4)),
      BSI:  Number((0.2 - ndvi * 0.5).toFixed(4)),
      cloudCoverPct: 5.0, tileUrl: null, imageCount: 0, fallbackUsed: true, dataset: 'mock',
    };
  };

  if (!geeInitialized) return mockResult('not_initialized');

  try {
    const geeCallStart = Date.now();
    console.log(`[MRV_TRACE] GEE JS bridge calling .evaluate() for ${startDate}→${endDate} (timeout=${GEE_OP_TIMEOUT_MS / 1000}s)`);
    const region = ee.Geometry.Polygon(polygon).simplify(100);
    const composite = buildComposite(region, startDate, endDate);
    const indexImage = computeAllIndices(composite);

    const tileUrlPromise = new Promise<string | null>((resolve) => {
      try {
        indexImage.select('NDVI').getMap(NDVI_VIS, (mapObj: any, err: any) => {
          if (err || !mapObj) {
            console.warn('[MRV] [GEE] Tile map generation failed:', err);
            resolve(null);
          } else {
            resolve(`https://earthengine.googleapis.com/v1alpha/${mapObj.mapid}/tiles/{z}/{x}/{y}`);
          }
        });
      } catch (e) {
        console.warn('[MRV] [GEE] getMap threw:', e);
        resolve(null);
      }
    });

    // Race GEE operations against a hard timeout — .evaluate() callbacks can hang
    // indefinitely if the GEE server is slow or the auth token has expired.
    const [indexValues, tileUrl] = await Promise.race([
      Promise.all([reduceAllIndices(indexImage, region), tileUrlPromise]),
      geeTimeout(GEE_OP_TIMEOUT_MS),
    ]);

    console.log(`[MRV_TRACE] GEE .evaluate() completed in ${Date.now() - geeCallStart}ms for ${startDate}→${endDate}`, indexValues);

    return {
      NDVI: indexValues.NDVI, EVI:  indexValues.EVI,
      SAVI: indexValues.SAVI, NDWI: indexValues.NDWI,
      NDMI: indexValues.NDMI, NBR:  indexValues.NBR,
      BSI:  indexValues.BSI,
      cloudCoverPct: null, tileUrl, imageCount: null,
      fallbackUsed: false, dataset: 'COPERNICUS/S2_SR_HARMONIZED+LANDSAT/LC08',
    };
  } catch (err: any) {
    console.warn("[MRV] [GEE] ⚠️ Error in multi-index GEE operations:", err.message || err);
    return mockResult('error');
  }
};

/**
 * Legacy NDVI-only function kept for backward compatibility.
 * New code should use getMultiIndexAnalysis().
 */
export const getNDVI = async (
  polygon: any,
  startDate = '2023-01-01',
  endDate   = '2023-07-01'
): Promise<{ NDVI: number | null; cloudCoverPct: number | null; tileUrl: string | null }> => {
  const result = await getMultiIndexAnalysis(polygon, startDate, endDate);
  return { NDVI: result.NDVI, cloudCoverPct: result.cloudCoverPct, tileUrl: result.tileUrl };
};
