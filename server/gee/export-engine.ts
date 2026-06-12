import ee from "@google/earthengine";
import { geeInitialized } from "../geeService";
import type { AssetRecord, ExportAsset, ExportAssetType, ExportMethod } from "../evidence/evidenceTypes";
import type { GEEExecutionResult } from "../mrv/types";

export interface GeeVisualizationParams {
  bands?: string[];
  min?: number;
  max?: number;
  palette?: string[];
  dimensions?: number | string;
  format?: "png" | "jpg";
}

export interface GeeExportRequest {
  image: any;
  region: any;
  assetType: ExportAssetType;
  sourceDataset: string;
  visualization: GeeVisualizationParams;
  scale?: number;
  fileFormat?: "PNG" | "GeoTIFF";
}

const ASSET_FILENAME_MAP: Record<string, ExportAssetType | undefined> = {
  "true-color.png": "true-color",
  "ndvi.png": "ndvi",
  "ndwi.png": "ndwi",
  "lulc.png": "lulc",
  "lst.png": "lst",
  "hydrology.png": "hydrology",
  "restoration.png": "restoration",
  "risk.png": "risk",
};

const DEFAULT_DATASETS: Record<ExportAssetType, string> = {
  "true-color": "COPERNICUS/S2_SR_HARMONIZED",
  ndvi: "COPERNICUS/S2_SR_HARMONIZED",
  ndwi: "COPERNICUS/S2_SR_HARMONIZED",
  lulc: "GOOGLE/DYNAMICWORLD/V1",
  lst: "LANDSAT/LC08+LC09/C02/T1_L2",
  hydrology: "USGS/SRTMGL1_003",
  restoration: "COPERNICUS/S2_SR_HARMONIZED+USGS/SRTMGL1_003",
  risk: "derived:evidence-metrics",
};

export const GEE_VISUALIZATIONS: Record<ExportAssetType, GeeVisualizationParams> = {
  "true-color": { bands: ["B4", "B3", "B2"], min: 0, max: 0.3, dimensions: 1024, format: "png" },
  ndvi: {
    min: -0.1,
    max: 0.8,
    palette: ["#d73027", "#f46d43", "#fdae61", "#fee08b", "#ffffbf", "#d9ef8b", "#a6d96a", "#66bd63", "#1a9850"],
    dimensions: 1024,
    format: "png",
  },
  ndwi: {
    min: -0.5,
    max: 0.5,
    palette: ["#8b4513", "#deb887", "#fffacd", "#87ceeb", "#1e90ff", "#00008b"],
    dimensions: 1024,
    format: "png",
  },
  lulc: {
    min: 0,
    max: 8,
    palette: ["#419bdf", "#397d49", "#88b053", "#7a87c6", "#e49635", "#dfc35a", "#c4281b", "#a59b8f", "#b39fe1"],
    dimensions: 1024,
    format: "png",
  },
  lst: {
    min: 20,
    max: 45,
    palette: ["#4472c4", "#78c8f0", "#f0c832", "#f07828", "#dc3232"],
    dimensions: 1024,
    format: "png",
  },
  hydrology: {
    min: 0,
    max: 30,
    palette: ["#2c7bb6", "#abd9e9", "#ffffbf", "#fdae61", "#d7191c"],
    dimensions: 1024,
    format: "png",
  },
  restoration: {
    min: 0,
    max: 100,
    palette: ["#c83737", "#e6be2d", "#228b22"],
    dimensions: 1024,
    format: "png",
  },
  risk: {
    min: 0,
    max: 100,
    palette: ["#28914b", "#e6be2d", "#c83737"],
    dimensions: 1024,
    format: "png",
  },
};

function assetId(runId: string, assetType: ExportAssetType): string {
  return `${runId}:${assetType}`;
}

function exportMethodFor(assetType: ExportAssetType, hasThumbnailUrl: boolean): ExportMethod {
  if (hasThumbnailUrl) return "gee-thumbnail";
  if (assetType === "risk") return "local-deterministic";
  return "local-deterministic";
}

export async function generateThumbnailUrl(request: GeeExportRequest): Promise<string | null> {
  if (!geeInitialized) return null;
  return new Promise((resolve) => {
    try {
      const params = {
        ...request.visualization,
        region: request.region,
        dimensions: request.visualization.dimensions ?? 1024,
        format: request.visualization.format ?? "png",
      };
      request.image.getThumbURL(params, (url: string, err: unknown) => {
        if (err || !url) return resolve(null);
        resolve(url);
      });
    } catch {
      resolve(null);
    }
  });
}

export async function requestExportUrl(request: GeeExportRequest): Promise<string | null> {
  if (!geeInitialized) return null;
  return new Promise((resolve) => {
    try {
      request.image.getDownloadURL(
        {
          region: request.region,
          scale: request.scale ?? 30,
          format: request.fileFormat ?? "GeoTIFF",
        },
        (url: string, err: unknown) => {
          if (err || !url) return resolve(null);
          resolve(url);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

export function createExportAsset(params: {
  runId: string;
  assetType: ExportAssetType;
  sourceDataset?: string;
  localPath?: string | null;
  thumbnailUrl?: string | null;
  exportMethod?: ExportMethod;
  geeMetadata?: Record<string, unknown>;
}): ExportAsset {
  const sourceDataset = params.sourceDataset ?? DEFAULT_DATASETS[params.assetType];
  const thumbnailUrl = params.thumbnailUrl ?? null;
  return {
    assetId: assetId(params.runId, params.assetType),
    runId: params.runId,
    assetType: params.assetType,
    sourceDataset,
    exportMethod: params.exportMethod ?? exportMethodFor(params.assetType, Boolean(thumbnailUrl)),
    generatedAt: new Date().toISOString(),
    localPath: params.localPath ?? null,
    thumbnailUrl,
    geeMetadata: {
      visualization: GEE_VISUALIZATIONS[params.assetType],
      geeInitialized,
      ...params.geeMetadata,
    },
  };
}

export function buildManifestExportAssets(params: {
  runId: string;
  imageAssets: AssetRecord[];
  geeResult: GEEExecutionResult;
}): ExportAsset[] {
  const observationByType = new Map<string, GEEExecutionResult["observations"][number]>(
    params.geeResult.observations.map((obs) => [obs.observationType, obs]),
  );
  const exported: ExportAsset[] = [];

  for (const imageAsset of params.imageAssets) {
    const assetType = ASSET_FILENAME_MAP[imageAsset.filename];
    if (!assetType) continue;
    const observation = observationByType.get(assetType);
    exported.push(createExportAsset({
      runId: params.runId,
      assetType,
      localPath: imageAsset.path,
      thumbnailUrl: observation?.artifact?.tileLayerPath?.startsWith("http")
        ? observation.artifact.tileLayerPath
        : null,
      sourceDataset: observation?.attribution?.datasetId ?? DEFAULT_DATASETS[assetType],
      geeMetadata: {
        filename: imageAsset.filename,
        localChecksumSha256: imageAsset.checksum_sha256,
        localSizeBytes: imageAsset.size_bytes,
        observationType: observation?.observationType ?? null,
        exportReady: assetType !== "risk",
      },
    }));
  }

  return exported;
}

export async function buildSpectralThumbnailExport(params: {
  runId: string;
  assetType: "true-color" | "ndvi" | "ndwi";
  polygon: any;
  startDate: string;
  endDate: string;
  localPath?: string | null;
}): Promise<ExportAsset> {
  const region = ee.Geometry.Polygon(params.polygon).simplify(100);
  const collection = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
    .filterBounds(region)
    .filterDate(params.startDate, params.endDate)
    .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30))
    .map((img: any) => img.divide(10000).select(["B2", "B3", "B4", "B8"]));
  const composite = collection.median().clip(region);
  const image =
    params.assetType === "ndvi"
      ? composite.normalizedDifference(["B8", "B4"]).rename("NDVI")
      : params.assetType === "ndwi"
        ? composite.normalizedDifference(["B3", "B8"]).rename("NDWI")
        : composite.select(["B4", "B3", "B2"]);
  const thumbnailUrl = await generateThumbnailUrl({
    image,
    region,
    assetType: params.assetType,
    sourceDataset: DEFAULT_DATASETS[params.assetType],
    visualization: GEE_VISUALIZATIONS[params.assetType],
    scale: 10,
  });
  return createExportAsset({
    runId: params.runId,
    assetType: params.assetType,
    localPath: params.localPath,
    thumbnailUrl,
    exportMethod: thumbnailUrl ? "gee-thumbnail" : "local-deterministic",
    geeMetadata: { requestedRealGeeThumbnail: true },
  });
}
