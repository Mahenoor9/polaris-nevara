/**
 * Satellite Image Service — REAL Google Earth Engine imagery for evidence.
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds genuine satellite-derived images (Sentinel-2 true-colour/NDVI/NDWI,
 * Landsat LST, Dynamic World land-cover, and a true-colour boundary overview
 * with the project polygon painted server-side) and downloads the GEE
 * `getThumbURL` PNG straight into the evidence directory.
 *
 * Every function is isolated and returns `null` on any failure (GEE offline,
 * no clear imagery, network error) so the caller can fall back to the
 * deterministic procedural generator. This NEVER throws into the MRV pipeline.
 */
import ee from "@google/earthengine";
import fs from "fs";
import path from "path";
import axios from "axios";
import { geeInitialized } from "../geeService";
import { toEePolygonCoords, flattenLngLat } from "./polygon-util";
import { fileChecksum, fileSize } from "../evidence/evidenceStorage";
import { postProcessImage, type LegendItem } from "../evidence/image-post-processor";
import type { AssetRecord, ExportAssetType } from "../evidence/evidenceTypes";

const LOG = "[Evidence] [GEE-Image]";
const THUMB_DIMENSIONS = 1024;
const DOWNLOAD_TIMEOUT_MS = 45_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export type RealAssetType = "true-color" | "ndvi" | "ndwi" | "lst" | "lulc" | "boundary-overview";

export interface RealImageOptions {
  polygon: any;
  startDate: string;
  endDate: string;
  // Cartographic metadata (used for overlay labels)
  projectName?: string | null;
  ecosystemType?: string | null;
}

// ── Coordinate helpers ───────────────────────────────────────────────────────

/** Padded rectangular region around the polygon for the boundary overview. */
function paddedRectangle(polygon: any): any {
  const coords = flattenLngLat(polygon);
  if (coords.length === 0) return ee.Geometry.Polygon(toEePolygonCoords(polygon)).bounds();
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const padLng = Math.max((maxLng - minLng) * 0.35, 0.002);
  const padLat = Math.max((maxLat - minLat) * 0.35, 0.002);
  return ee.Geometry.Rectangle([minLng - padLng, minLat - padLat, maxLng + padLng, maxLat + padLat]);
}

// ── GEE primitives ───────────────────────────────────────────────────────────

/** Cloud-masked Sentinel-2 surface-reflectance median composite (0–1 scaled). */
function s2Composite(region: any, startDate: string, endDate: string) {
  return ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
    .filterBounds(region)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 40))
    .map((img: any) => {
      const scl = img.select("SCL");
      const mask = scl.neq(3).and(scl.neq(7)).and(scl.neq(8)).and(scl.neq(9)).and(scl.neq(10)).and(scl.neq(11));
      return img.updateMask(mask).divide(10000).select(["B2", "B3", "B4", "B8"]);
    })
    .median()
    .clip(region);
}

async function collectionSize(collection: any): Promise<number> {
  return new Promise((resolve) => {
    try {
      collection.size().evaluate((n: number, err: any) => resolve(err ? 0 : n ?? 0));
    } catch {
      resolve(0);
    }
  });
}

/** Resolve a GEE thumbnail URL for a visualised image. */
function getThumbUrl(image: any, region: any): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      image.getThumbURL(
        { region, dimensions: THUMB_DIMENSIONS, format: "png" },
        (url: string, err: unknown) => resolve(err || !url ? null : url),
      );
    } catch {
      resolve(null);
    }
  });
}

/** Download a PNG to disk; returns false if not a valid PNG or on error. */
async function downloadPng(url: string, filePath: string): Promise<boolean> {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxContentLength: 30 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const buf = Buffer.from(res.data);
    if (buf.length < 8 || !buf.subarray(0, 4).equals(PNG_SIGNATURE)) {
      console.warn(`${LOG} downloaded asset is not a valid PNG (${buf.length} bytes)`);
      return false;
    }
    await fs.promises.writeFile(filePath, buf);
    return true;
  } catch (err) {
    console.warn(`${LOG} download failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

async function buildAssetRecord(
  filePath: string,
  filename: string,
  dataset: string,
  acquisitionDate: string | null,
): Promise<AssetRecord> {
  return {
    filename,
    path: filePath,
    size_bytes: await fileSize(filePath),
    checksum_sha256: await fileChecksum(filePath),
    generated_at: new Date().toISOString(),
    source: "gee",
    dataset,
    acquisition_date: acquisitionDate,
  };
}

// ── Visualised image builders ────────────────────────────────────────────────

const NDVI_PALETTE = ["#d73027", "#f46d43", "#fdae61", "#fee08b", "#ffffbf", "#d9ef8b", "#a6d96a", "#66bd63", "#1a9850"];
const NDWI_PALETTE = ["#8b4513", "#deb887", "#fffacd", "#87ceeb", "#1e90ff", "#00008b"];
const LST_PALETTE = ["#4472c4", "#78c8f0", "#f0c832", "#f07828", "#dc3232"];
const DW_PALETTE = ["#419bdf", "#397d49", "#88b053", "#7a87c6", "#e49635", "#dfc35a", "#c4281b", "#a59b8f", "#b39fe1"];

function visualizeSpectral(region: any, startDate: string, endDate: string, assetType: "true-color" | "ndvi" | "ndwi") {
  const composite = s2Composite(region, startDate, endDate);
  if (assetType === "true-color") {
    return composite.visualize({ bands: ["B4", "B3", "B2"], min: 0, max: 0.3 });
  }
  if (assetType === "ndvi") {
    return composite.normalizedDifference(["B8", "B4"]).visualize({ min: -0.1, max: 0.8, palette: NDVI_PALETTE });
  }
  return composite.normalizedDifference(["B3", "B8"]).visualize({ min: -0.5, max: 0.5, palette: NDWI_PALETTE });
}

function visualizeLst(region: any, startDate: string, endDate: string) {
  const cloudMask = (img: any) => {
    const qa = img.select("QA_PIXEL");
    return img.updateMask(qa.bitwiseAnd(1 << 3).eq(0).and(qa.bitwiseAnd(1 << 4).eq(0)));
  };
  const toC = (img: any) =>
    img.select("ST_B10").multiply(0.00341802).add(149.0).subtract(273.15).rename("LST");
  const l8 = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2").filterBounds(region).filterDate(startDate, endDate).filter(ee.Filter.lt("CLOUD_COVER", 40)).map(cloudMask).map(toC);
  const l9 = ee.ImageCollection("LANDSAT/LC09/C02/T1_L2").filterBounds(region).filterDate(startDate, endDate).filter(ee.Filter.lt("CLOUD_COVER", 40)).map(cloudMask).map(toC);
  const merged = l8.merge(l9);
  return {
    collection: merged,
    image: merged.median().clip(region).visualize({ min: 20, max: 45, palette: LST_PALETTE }),
  };
}

function visualizeDynamicWorld(region: any, startDate: string, endDate: string) {
  const collection = ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1").filterBounds(region).filterDate(startDate, endDate);
  const image = collection.select("label").mode().clip(region).visualize({ min: 0, max: 8, palette: DW_PALETTE });
  return { collection, image };
}

/** True-colour basemap over a padded region with the polygon outline painted in. */
function visualizeBoundaryOverview(polygon: any, region: any, startDate: string, endDate: string) {
  const base = s2Composite(region, startDate, endDate).visualize({ bands: ["B4", "B3", "B2"], min: 0, max: 0.3 });
  const fc = ee.FeatureCollection([ee.Feature(ee.Geometry.Polygon(toEePolygonCoords(polygon)))]);
  const outline = ee.Image().byte().paint({ featureCollection: fc, color: 1, width: 3 });
  return base.blend(outline.visualize({ palette: ["#FFE600"] }));
}

// ── Public API ───────────────────────────────────────────────────────────────

const DATASET_LABEL: Record<RealAssetType, string> = {
  "true-color": "COPERNICUS/S2_SR_HARMONIZED",
  ndvi: "COPERNICUS/S2_SR_HARMONIZED",
  ndwi: "COPERNICUS/S2_SR_HARMONIZED",
  lst: "LANDSAT/LC08+LC09/C02/T1_L2",
  lulc: "GOOGLE/DYNAMICWORLD/V1",
  "boundary-overview": "COPERNICUS/S2_SR_HARMONIZED",
};

/**
 * Generate one real satellite image and write it to `<evidenceDir>/<asset>.png`.
 * Returns the AssetRecord, or null if GEE is offline / no imagery / failure.
 */
export async function exportRealSatelliteImage(
  evidenceDir: string,
  assetType: RealAssetType,
  opts: RealImageOptions,
): Promise<AssetRecord | null> {
  if (!geeInitialized) return null;
  const filename = `${assetType}.png`;
  const filePath = path.join(evidenceDir, filename);

  try {
    const region = assetType === "boundary-overview"
      ? paddedRectangle(opts.polygon)
      : ee.Geometry.Polygon(toEePolygonCoords(opts.polygon)).simplify(50);

    let image: any;
    let collection: any = null;

    switch (assetType) {
      case "true-color":
      case "ndvi":
      case "ndwi":
        image = visualizeSpectral(region, opts.startDate, opts.endDate, assetType);
        collection = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
          .filterBounds(region).filterDate(opts.startDate, opts.endDate)
          .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 40));
        break;
      case "lst": {
        const r = visualizeLst(region, opts.startDate, opts.endDate);
        image = r.image; collection = r.collection;
        break;
      }
      case "lulc": {
        const r = visualizeDynamicWorld(region, opts.startDate, opts.endDate);
        image = r.image; collection = r.collection;
        break;
      }
      case "boundary-overview":
        image = visualizeBoundaryOverview(opts.polygon, region, opts.startDate, opts.endDate);
        break;
    }

    // Guard: if the underlying collection has no scenes, fall back to procedural.
    if (collection) {
      const size = await collectionSize(collection);
      if (size === 0) {
        console.warn(`${LOG} ${assetType}: no clear imagery in ${opts.startDate}→${opts.endDate}; using fallback`);
        return null;
      }
    }

    const url = await getThumbUrl(image, region);
    if (!url) {
      console.warn(`${LOG} ${assetType}: thumbnail URL generation failed; using fallback`);
      return null;
    }

    const ok = await downloadPng(url, filePath);
    if (!ok) return null;

    // Apply professional cartographic overlay to every downloaded GEE image.
    const titleMap: Record<RealAssetType, string> = {
      "boundary-overview": "Project Boundary Overview",
      "true-color": "True Colour Composite",
      "ndvi": "NDVI — Vegetation Density",
      "ndwi": "NDWI — Surface Water / Moisture",
      "lst": "Land Surface Temperature",
      "lulc": "Land Use / Land Cover Classification",
    };
    const subtitleMap: Record<RealAssetType, string> = {
      "boundary-overview": "Sentinel-2 SR · Yellow = project boundary",
      "true-color": "Sentinel-2 SR · Bands B4/B3/B2",
      "ndvi": "Sentinel-2 SR · B8/B4 · Green = dense vegetation",
      "ndwi": "Sentinel-2 SR · B3/B8 · Blue = water / high moisture",
      "lst": "Landsat 8/9 · ST_B10 · Blue = cool, Red = heat stress",
      "lulc": "Google Dynamic World v1 · Land classification",
    };
    const legendMap: Record<RealAssetType, LegendItem[]> = {
      "boundary-overview": [],
      "true-color": [],
      "ndvi": [
        { r: 215, g: 48, b: 39, label: "< 0.1 Bare" },
        { r: 116, g: 196, b: 118, label: "0.3–0.5 Moderate" },
        { r: 0, g: 104, b: 55, label: "> 0.5 Dense" },
      ],
      "ndwi": [
        { r: 139, g: 69, b: 19, label: "< -0.2 Dry" },
        { r: 135, g: 206, b: 235, label: "0.0–0.2 Wet" },
        { r: 0, g: 0, b: 139, label: "> 0.2 Water" },
      ],
      "lst": [
        { r: 68, g: 114, b: 196, label: "< 25°C Cool" },
        { r: 240, g: 200, b: 50, label: "28–35°C Warm" },
        { r: 220, g: 50, b: 50, label: "> 40°C Hot" },
      ],
      "lulc": [
        { r: 57, g: 125, b: 73, label: "Vegetation" },
        { r: 65, g: 155, b: 223, label: "Water" },
        { r: 136, g: 176, b: 83, label: "Trees" },
        { r: 196, g: 150, b: 90, label: "Bare" },
        { r: 196, g: 40, b: 27, label: "Built" },
      ],
    };

    const dateStr = `${opts.startDate} → ${opts.endDate}`;
    await postProcessImage(filePath, {
      title: titleMap[assetType] ?? assetType.toUpperCase(),
      subtitle: subtitleMap[assetType] ?? DATASET_LABEL[assetType],
      captureDate: dateStr,
      projectName: opts.projectName ?? null,
      ecosystemType: opts.ecosystemType ?? null,
      legend: legendMap[assetType] ?? [],
      polygon: assetType !== "boundary-overview" ? opts.polygon : null,
    });

    console.log(`${LOG} ${assetType}: real GEE image saved + cartographic overlay applied`);
    return buildAssetRecord(filePath, filename, DATASET_LABEL[assetType], dateStr);
  } catch (err) {
    console.warn(`${LOG} ${assetType} failed (non-blocking):`, err instanceof Error ? err.message : err);
    return null;
  }
}

export const REAL_ASSET_TYPES: RealAssetType[] = ["boundary-overview", "true-color", "ndvi", "ndwi", "lst", "lulc"];

export function isRealAssetType(t: ExportAssetType | string): t is RealAssetType {
  return (REAL_ASSET_TYPES as string[]).includes(t);
}
