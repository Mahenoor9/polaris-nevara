import fs from "fs";
import path from "path";
import type {
  AssetRecord,
  EvidenceManifest,
  EvidenceValidationSummary,
  MetricsJson,
  WorkflowRecord,
} from "./evidenceTypes";
import { fileSize, getEvidenceRunDir, readJsonFile } from "./evidenceStorage";
import {
  EVIDENCE_ASSETS_DIRNAME,
  REQUIRED_EVIDENCE_ASSET_FILENAMES,
} from "../gee/evidence-export-service";
import type { ObservationsJson } from "../intelligence/observation-engine";

export interface AssetInventoryItem {
  filename: string;
  path: string;
  manifest_recorded: boolean;
  exists: boolean;
  size_bytes: number;
  image_readable?: boolean;
  image_width?: number;
  image_height?: number;
  checksum_sha256?: string;
  generated_at?: string;
}

export interface WorkflowInventoryItem {
  workflow_id: string;
  name: string;
  status: WorkflowRecord["status"];
  outputs: string[];
}

export interface MetricsInventory {
  schema_version: string | null;
  sections: string[];
  generated_at: string | null;
  run_id: string | null;
  project_id: string | null;
}

export interface EvidenceValidationReport {
  validation: EvidenceValidationSummary;
  asset_inventory: AssetInventoryItem[];
  workflow_inventory: WorkflowInventoryItem[];
  metrics_inventory: MetricsInventory;
}

const REQUIRED_FILES = [
  "metrics.json",
  "observations.json",
  "evidence-manifest.json",
];

const REQUIRED_IMAGE_ASSETS = [
  ...REQUIRED_EVIDENCE_ASSET_FILENAMES,
  "historical-trend.png",
];

const REQUIRED_ASSET_KEYS = [
  ...REQUIRED_FILES,
  ...REQUIRED_IMAGE_ASSETS,
];

const LEGACY_REQUIRED_IMAGES = [
  "ndvi.png",
  "lst.png",
  "lulc.png",
  "hydrology.png",
  "restoration.png",
  "risk.png",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function readPngDimensions(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24) return null;
  if (data[0] !== 0x89 || data.toString("ascii", 1, 4) !== "PNG") return null;
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

async function imageMetadata(filePath: string): Promise<{ readable: boolean; width?: number; height?: number }> {
  try {
    const data = await fs.promises.readFile(filePath);
    const dimensions = readPngDimensions(data);
    if (!dimensions) return { readable: false };
    return { readable: true, width: dimensions.width, height: dimensions.height };
  } catch {
    return { readable: false };
  }
}

function metricsInventory(metrics: MetricsJson | null): MetricsInventory {
  if (!metrics) {
    return {
      schema_version: null,
      sections: [],
      generated_at: null,
      run_id: null,
      project_id: null,
    };
  }
  return {
    schema_version: metrics.schema_version,
    sections: Object.keys(metrics).filter((key) => isObject((metrics as any)[key])),
    generated_at: metrics.generated_at,
    run_id: metrics.run_id,
    project_id: metrics.project_id,
  };
}

async function buildAssetInventory(
  evidenceDir: string,
  manifest: EvidenceManifest | null,
): Promise<AssetInventoryItem[]> {
  const manifestAssets = new Map<string, AssetRecord>();
  for (const asset of manifest?.assets ?? []) {
    manifestAssets.set(asset.filename, asset);
  }

  const assetsDir = path.join(evidenceDir, EVIDENCE_ASSETS_DIRNAME);
  const filenames = new Set<string>([
    ...REQUIRED_ASSET_KEYS,
    ...LEGACY_REQUIRED_IMAGES,
    ...Array.from(manifestAssets.keys()),
    ...(await listFiles(evidenceDir)),
    ...(await listFiles(assetsDir)),
  ]);

  const inventory: AssetInventoryItem[] = [];
  for (const filename of Array.from(filenames).sort()) {
    const manifestAsset = manifestAssets.get(filename);
    const materializedPath = path.join(assetsDir, filename);
    const rootPath = path.join(evidenceDir, filename);
    const filePath = manifestAsset?.path
      ?? ((await pathExists(materializedPath)) ? materializedPath : rootPath);
    const exists = await pathExists(filePath);
    const imageInfo: { readable?: boolean; width?: number; height?: number } = filename.endsWith(".png") && exists
      ? await imageMetadata(filePath)
      : {};
    inventory.push({
      filename,
      path: filePath,
      manifest_recorded: Boolean(manifestAsset),
      exists,
      size_bytes: exists ? await fileSize(filePath) : 0,
      image_readable: imageInfo.readable,
      image_width: imageInfo.width,
      image_height: imageInfo.height,
      checksum_sha256: manifestAsset?.checksum_sha256,
      generated_at: manifestAsset?.generated_at,
    });
  }

  return inventory;
}

function scoreValidation(params: {
  errors: string[];
  warnings: string[];
  missingAssets: string[];
  emptyOutputs: string[];
}): number {
  const penalty =
    params.errors.length * 20 +
    params.missingAssets.length * 10 +
    params.emptyOutputs.length * 8 +
    params.warnings.length * 3;
  return Math.max(0, Math.min(100, 100 - penalty));
}

export async function validateEvidencePackage(
  projectId: string,
  runId: string,
): Promise<EvidenceValidationReport> {
  const evidenceDir = getEvidenceRunDir(projectId, runId);
  const metrics = await readJsonFile<MetricsJson>(evidenceDir, "metrics.json");
  const observations = await readJsonFile<ObservationsJson>(evidenceDir, "observations.json");
  const manifest = await readJsonFile<EvidenceManifest>(evidenceDir, "evidence-manifest.json");
  const assetInventory = await buildAssetInventory(evidenceDir, manifest);

  const warnings: string[] = [];
  const errors: string[] = [];

  if (!metrics) errors.push("metrics.json is missing or invalid JSON");
  if (!observations) errors.push("observations.json is missing or invalid JSON");
  if (!manifest) errors.push("evidence-manifest.json is missing or invalid JSON");

  if (metrics) {
    if (!metrics.schema_version) errors.push("metrics.json missing schema_version");
    if (metrics.run_id !== runId) errors.push("metrics.json run_id does not match requested runId");
    if (metrics.project_id !== projectId) errors.push("metrics.json project_id does not match requested projectId");
    for (const section of ["boundary", "vegetation", "trust", "monitoring"]) {
      if (!isObject((metrics as any)[section])) errors.push(`metrics.json missing required ${section} section`);
    }
  }

  if (observations) {
    if (observations.schema_version !== "1.0") errors.push("observations.json has unsupported schema_version");
    if (observations.run_id !== runId) errors.push("observations.json run_id does not match requested runId");
    if (observations.project_id !== projectId) errors.push("observations.json project_id does not match requested projectId");
    if (!Array.isArray(observations.observations)) errors.push("observations.json observations must be an array");
    else if (observations.observations.length === 0) errors.push("observations.json observations array is empty");
    for (const [index, item] of (observations.observations ?? []).entries()) {
      if (!isObject(item)) {
        errors.push(`observations.json observation ${index} is invalid`);
        continue;
      }
      for (const field of ["id", "category", "severity", "metric", "value", "threshold", "status", "finding", "recommendation", "confidence"]) {
        if (!(field in item)) errors.push(`observations.json observation ${index} missing ${field}`);
      }
    }
  }

  if (manifest) {
    if (manifest.run_id !== runId) errors.push("evidence-manifest.json run_id does not match requested runId");
    if (manifest.project_id !== projectId) errors.push("evidence-manifest.json project_id does not match requested projectId");
    if (!Array.isArray(manifest.assets)) errors.push("evidence-manifest.json assets must be an array");
    if (!Array.isArray(manifest.workflows)) errors.push("evidence-manifest.json workflows must be an array");
  }

  const missingAssets: string[] = [];
  const emptyOutputs: string[] = [];
  const inventoryByName = new Map(assetInventory.map((item) => [item.filename, item]));
  for (const filename of REQUIRED_ASSET_KEYS) {
    const item = inventoryByName.get(filename);
    if (!item?.exists) missingAssets.push(filename);
    else if (item.size_bytes <= 0) emptyOutputs.push(filename);
  }

  for (const item of assetInventory) {
    if (item.exists && item.size_bytes <= 0 && !emptyOutputs.includes(item.filename)) {
      emptyOutputs.push(item.filename);
    }
    if (item.exists && !item.manifest_recorded && item.filename !== "evidence-manifest.json") {
      warnings.push(`${item.filename} exists on disk but is not listed in manifest assets`);
    }
    if (item.exists && item.filename.endsWith(".png")) {
      if (!item.image_readable) {
        errors.push(`${item.filename} is not a readable PNG image`);
      } else if (!item.image_width || !item.image_height || item.image_width <= 0 || item.image_height <= 0) {
        errors.push(`${item.filename} has invalid image dimensions`);
      }
    }
  }

  for (const filename of emptyOutputs) {
    errors.push(`${filename} exists but is empty`);
  }

  if (manifest?.workflows?.some((workflow) => workflow.status === "failed")) {
    warnings.push("One or more workflows are marked failed in evidence-manifest.json");
  }

  if (manifest && !manifest.export_assets) {
    warnings.push("Manifest has no export_assets metadata; package predates Phase 3A or export metadata was skipped");
  }

  for (const assetExport of manifest?.asset_exports ?? []) {
    if (assetExport.localPath && !(await pathExists(assetExport.localPath))) {
      warnings.push(`${assetExport.filename} asset_exports localPath does not exist`);
    }
    if (assetExport.status === "failed") {
      warnings.push(`${assetExport.filename} real export failed; fallback may be required`);
    }
  }

  const score = scoreValidation({ errors, warnings, missingAssets, emptyOutputs });
  const status: EvidenceValidationSummary["status"] =
    errors.length > 0 || missingAssets.length > 0
      ? "fail"
      : warnings.length > 0
        ? "warning"
        : "pass";

  const generatedAssets = assetInventory
    .filter((asset) => asset.exists && asset.size_bytes > 0)
    .map((asset) => asset.filename);

  return {
    validation: {
      status,
      score,
      warnings,
      errors,
      missing_assets: missingAssets,
      generated_assets: generatedAssets,
      validated_at: new Date().toISOString(),
    },
    asset_inventory: assetInventory,
    workflow_inventory: (manifest?.workflows ?? []).map((workflow) => ({
      workflow_id: workflow.workflow_id,
      name: workflow.name,
      status: workflow.status,
      outputs: workflow.outputs,
    })),
    metrics_inventory: metricsInventory(metrics),
  };
}

export const evidenceValidator = { validateEvidencePackage };
