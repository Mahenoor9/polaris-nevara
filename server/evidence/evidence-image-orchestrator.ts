/**
 * Evidence Image Orchestrator
 * ─────────────────────────────────────────────────────────────────────────────
 * Produces the evidence PNG set, preferring REAL Google Earth Engine satellite
 * imagery and gracefully falling back to the deterministic procedural generator
 * per-asset when GEE is offline or has no clear scenes.
 *
 * Real (satellite): boundary-overview, true-color, ndvi, ndwi, lst, lulc
 * Procedural only:  historical-trend (chart), restoration, hydrology, risk
 *                   (derived analytics, not a single satellite layer)
 *
 * This module isolates the GEE dependency so `imageExportService` stays
 * dependency-free, and never throws into the MRV pipeline.
 */
import type { AssetRecord } from "./evidenceTypes";
import type { LULCResult } from "../gee/workflow-06-lulc";
import type { HistoricalResult } from "../gee/workflow-05-historical";
import type { RestorationResult } from "../gee/workflow-03-restoration";
import type { HydrologyResult } from "../gee/workflow-04-dem-hydro";
import type { RiskEngineResult } from "../intelligence/workflow-risk-engine";
import {
  exportBoundaryOverviewImage,
  exportTrueColorImage,
  exportNdviImage,
  exportNdwiImage,
  exportLstImage,
  exportLulcImage,
  exportHistoricalTrendImage,
  exportHydrologyImage,
  exportRestorationImage,
  exportRiskImage,
} from "./imageExportService";
import { exportRealSatelliteImage, type RealAssetType } from "../gee/satellite-image-service";

const LOG = "[Evidence] [Image]";

export interface EvidenceImageParams {
  polygon: any;
  startDate: string;
  endDate: string;
  ndvi_mean: number | null;
  ndwi_mean: number | null;
  lst_mean: number | null;
  lulcResult?: LULCResult;
  historicalResult?: HistoricalResult;
  hydrologyResult?: HydrologyResult;
  restorationResult?: RestorationResult;
  riskResult?: RiskEngineResult;
  /** Master switch — set false to force procedural (e.g. for tests). */
  enableRealGee?: boolean;
  // Cartographic labels for overlays
  projectName?: string | null;
  ecosystemType?: string | null;
}

function asProcedural(record: AssetRecord): AssetRecord {
  return { ...record, source: record.source ?? "procedural" };
}

export interface EvidenceImageResult {
  assets: AssetRecord[];
  realCount: number;
  proceduralCount: number;
}

/**
 * Build all evidence images. Each asset is isolated: a real-image failure falls
 * back to procedural, and a procedural failure simply skips that asset.
 */
export async function exportEvidenceImages(
  evidenceDir: string,
  params: EvidenceImageParams,
): Promise<EvidenceImageResult> {
  const assets: AssetRecord[] = [];
  let realCount = 0;
  let proceduralCount = 0;
  const enableReal = params.enableRealGee !== false;

  // Try a real GEE image first; fall back to the procedural builder on null.
  const realOrFallback = async (
    assetType: RealAssetType,
    fallback: () => Promise<AssetRecord>,
    label: string,
  ) => {
    try {
      if (enableReal) {
        const real = await exportRealSatelliteImage(evidenceDir, assetType, {
          polygon: params.polygon,
          startDate: params.startDate,
          endDate: params.endDate,
          projectName: params.projectName ?? null,
          ecosystemType: params.ecosystemType ?? null,
        });
        if (real) {
          assets.push(real);
          realCount += 1;
          return;
        }
      }
      assets.push(asProcedural(await fallback()));
      proceduralCount += 1;
    } catch (err) {
      console.warn(`${LOG} ${label} export failed:`, err instanceof Error ? err.message : err);
    }
  };

  // Procedural-only assets (charts / derived analytics).
  const proceduralOnly = async (fn: () => Promise<AssetRecord>, label: string) => {
    try {
      assets.push(asProcedural(await fn()));
      proceduralCount += 1;
    } catch (err) {
      console.warn(`${LOG} ${label} export failed:`, err instanceof Error ? err.message : err);
    }
  };

  await realOrFallback("boundary-overview", () => exportBoundaryOverviewImage(evidenceDir, params.polygon), "boundary-overview.png");
  await realOrFallback("true-color", () => exportTrueColorImage(evidenceDir, params.ndvi_mean, params.ndwi_mean, params.lulcResult), "true-color.png");
  await realOrFallback("ndvi", () => exportNdviImage(evidenceDir, params.ndvi_mean), "ndvi.png");
  await realOrFallback("ndwi", () => exportNdwiImage(evidenceDir, params.ndwi_mean), "ndwi.png");
  await realOrFallback("lst", () => exportLstImage(evidenceDir, params.lst_mean), "lst.png");
  await realOrFallback("lulc", () => exportLulcImage(evidenceDir, params.lulcResult), "lulc.png");

  await proceduralOnly(() => exportHistoricalTrendImage(evidenceDir, params.historicalResult), "historical-trend.png");
  await proceduralOnly(() => exportHydrologyImage(evidenceDir, params.hydrologyResult), "hydrology.png");
  await proceduralOnly(() => exportRestorationImage(evidenceDir, params.restorationResult), "restoration.png");
  await proceduralOnly(() => exportRiskImage(evidenceDir, params.riskResult), "risk.png");

  console.log(`${LOG} produced ${assets.length} asset(s): ${realCount} real GEE, ${proceduralCount} procedural`);
  return { assets, realCount, proceduralCount };
}
