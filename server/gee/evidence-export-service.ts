import fs from "fs";
import path from "path";
import type {
  EvidenceAssetExportRecord,
  EvidenceManifest,
  ExportAsset,
} from "../evidence/evidenceTypes";
import {
  fileChecksum,
  fileSize,
  getEvidenceRunDir,
  readJsonFile,
  writeJsonFile,
} from "../evidence/evidenceStorage";

export const EVIDENCE_ASSETS_DIRNAME = "assets";

export const REQUIRED_EVIDENCE_ASSET_FILENAMES = [
  "true-color.png",
  "ndvi.png",
  "ndwi.png",
  "lst.png",
  "lulc.png",
  "boundary-overview.png",
] as const;

export const OPTIONAL_EVIDENCE_ASSET_FILENAMES = [
  "hydrology.png",
  "restoration.png",
  "risk.png",
] as const;

const ASSET_TYPE_BY_FILENAME: Record<string, string> = {
  "true-color.png": "true-color",
  "ndvi.png": "ndvi",
  "ndwi.png": "ndwi",
  "lst.png": "lst",
  "lulc.png": "lulc",
  "boundary-overview.png": "boundary-overview",
  "hydrology.png": "hydrology",
  "restoration.png": "restoration",
  "risk.png": "risk",
};

export interface EvidenceAssetPipelineResult {
  projectId: string;
  runId: string;
  assetsDir: string;
  requiredAssets: string[];
  optionalAssets: string[];
  assets: EvidenceAssetExportRecord[];
}

function assetsDir(projectId: string, runId: string): string {
  return path.join(getEvidenceRunDir(projectId, runId), EVIDENCE_ASSETS_DIRNAME);
}

function filenameForExportAsset(asset: ExportAsset): string {
  return `${asset.assetType}.png`;
}

function exportMetadataForFilename(manifest: EvidenceManifest | null, filename: string): ExportAsset | undefined {
  return manifest?.export_assets?.find((asset) => filenameForExportAsset(asset) === filename);
}

function legacyPathForFilename(manifest: EvidenceManifest | null, evidenceDir: string, filename: string): string | null {
  const manifestPath = manifest?.assets.find((asset) => asset.filename === filename)?.path;
  if (manifestPath && fs.existsSync(manifestPath)) return manifestPath;
  const rootPath = path.join(evidenceDir, filename);
  return fs.existsSync(rootPath) ? rootPath : null;
}

async function copyFallback(sourcePath: string, destinationPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.promises.copyFile(sourcePath, destinationPath);
}

async function downloadWithRetries(url: string, destinationPath: string, retries: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !contentType.includes("image")) {
        throw new Error(`Unexpected content-type ${contentType}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const data = Buffer.from(arrayBuffer);
      if (data.length === 0) throw new Error("Downloaded image is empty");
      await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.promises.writeFile(destinationPath, data);
      return;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("GEE image download failed");
}

async function assetRecord(params: {
  filename: string;
  status: EvidenceAssetExportRecord["status"];
  assetSource: EvidenceAssetExportRecord["assetSource"];
  geeDataset: string | null;
  exportMethod: EvidenceAssetExportRecord["exportMethod"];
  localPath: string | null;
  sourcePath: string | null;
  startedAt: number;
  error?: string;
}): Promise<EvidenceAssetExportRecord> {
  return {
    filename: params.filename,
    assetType: ASSET_TYPE_BY_FILENAME[params.filename] ?? params.filename.replace(/\.png$/, ""),
    status: params.status,
    assetSource: params.assetSource,
    geeDataset: params.geeDataset,
    exportMethod: params.exportMethod,
    generatedAt: new Date().toISOString(),
    localPath: params.localPath,
    sourcePath: params.sourcePath,
    generationDurationMs: Date.now() - params.startedAt,
    ...(params.error ? { error: params.error } : {}),
  };
}

async function manifestAssetRecord(filePath: string, filename: string, prior?: { source?: string; dataset?: string | null; acquisition_date?: string | null }) {
  return {
    filename,
    path: filePath,
    size_bytes: await fileSize(filePath),
    checksum_sha256: await fileChecksum(filePath),
    generated_at: new Date().toISOString(),
    // Preserve real-imagery provenance through the assets/ copy.
    ...(prior?.source ? { source: prior.source } : {}),
    ...(prior?.dataset ? { dataset: prior.dataset } : {}),
    ...(prior?.acquisition_date ? { acquisition_date: prior.acquisition_date } : {}),
  };
}

export class EvidenceExportService {
  getAssetsDir(projectId: string, runId: string): string {
    return assetsDir(projectId, runId);
  }

  async materializeAssets(params: {
    projectId: string;
    runId: string;
    attemptRemoteExports?: boolean;
    retries?: number;
  }): Promise<EvidenceAssetPipelineResult> {
    const evidenceDir = getEvidenceRunDir(params.projectId, params.runId);
    const outputDir = assetsDir(params.projectId, params.runId);
    const manifest = await readJsonFile<EvidenceManifest>(evidenceDir, "evidence-manifest.json");
    const filenames = [
      ...REQUIRED_EVIDENCE_ASSET_FILENAMES,
      ...OPTIONAL_EVIDENCE_ASSET_FILENAMES,
    ];
    const records: EvidenceAssetExportRecord[] = [];

    await fs.promises.mkdir(outputDir, { recursive: true });

    for (const filename of filenames) {
      const startedAt = Date.now();
      const outputPath = path.join(outputDir, filename);
      const exportMetadata = exportMetadataForFilename(manifest, filename);
      const legacyPath = legacyPathForFilename(manifest, evidenceDir, filename);

      if (params.attemptRemoteExports && exportMetadata?.thumbnailUrl) {
        try {
          await downloadWithRetries(exportMetadata.thumbnailUrl, outputPath, params.retries ?? 1);
          records.push(await assetRecord({
            filename,
            status: "exported",
            assetSource: "gee",
            geeDataset: exportMetadata.sourceDataset,
            exportMethod: exportMetadata.exportMethod,
            localPath: outputPath,
            sourcePath: exportMetadata.thumbnailUrl,
            startedAt,
          }));
          continue;
        } catch (error) {
          if (legacyPath) {
            await copyFallback(legacyPath, outputPath);
            records.push(await assetRecord({
              filename,
              status: "fallback",
              assetSource: "local-fallback",
              geeDataset: exportMetadata.sourceDataset,
              exportMethod: "copy-fallback",
              localPath: outputPath,
              sourcePath: legacyPath,
              startedAt,
              error: error instanceof Error ? error.message : "GEE export failed",
            }));
            continue;
          }
          records.push(await assetRecord({
            filename,
            status: "failed",
            assetSource: "unavailable",
            geeDataset: exportMetadata.sourceDataset,
            exportMethod: exportMetadata.exportMethod,
            localPath: null,
            sourcePath: exportMetadata.thumbnailUrl,
            startedAt,
            error: error instanceof Error ? error.message : "GEE export failed",
          }));
          continue;
        }
      }

      if (legacyPath) {
        await copyFallback(legacyPath, outputPath);
        // Preserve real-imagery provenance: if the root asset was a real GEE
        // download, surface it as such rather than a generic legacy copy.
        const priorAsset = manifest?.assets.find((a) => a.filename === filename) as any;
        const isRealGee = priorAsset?.source === "gee";
        records.push(await assetRecord({
          filename,
          status: isRealGee ? "exported" : "fallback",
          assetSource: isRealGee ? "gee" : "legacy-root",
          geeDataset: priorAsset?.dataset ?? exportMetadata?.sourceDataset ?? null,
          exportMethod: isRealGee ? "gee-thumbnail" : "copy-fallback",
          localPath: outputPath,
          sourcePath: legacyPath,
          startedAt,
        }));
        continue;
      }

      records.push(await assetRecord({
        filename,
        status: "missing",
        assetSource: "unavailable",
        geeDataset: exportMetadata?.sourceDataset ?? null,
        exportMethod: exportMetadata?.exportMethod ?? "none",
        localPath: null,
        sourcePath: null,
        startedAt,
      }));
    }

    if (manifest) {
      const existingAssets = manifest.assets.filter((asset) => !asset.path.includes(`${path.sep}${EVIDENCE_ASSETS_DIRNAME}${path.sep}`));
      const priorByFilename = new Map(manifest.assets.map((a) => [a.filename, a as any]));
      const materializedAssets = await Promise.all(
        records
          .filter((record) => record.localPath && fs.existsSync(record.localPath))
          .map((record) => manifestAssetRecord(record.localPath!, record.filename, priorByFilename.get(record.filename))),
      );
      await writeJsonFile(evidenceDir, "evidence-manifest.json", {
        ...manifest,
        assets: [...existingAssets, ...materializedAssets],
        asset_exports: records,
      });
    }

    return {
      projectId: params.projectId,
      runId: params.runId,
      assetsDir: outputDir,
      requiredAssets: [...REQUIRED_EVIDENCE_ASSET_FILENAMES],
      optionalAssets: [...OPTIONAL_EVIDENCE_ASSET_FILENAMES],
      assets: records,
    };
  }

  async getAssetInventory(projectId: string, runId: string): Promise<EvidenceAssetPipelineResult> {
    const evidenceDir = getEvidenceRunDir(projectId, runId);
    const outputDir = assetsDir(projectId, runId);
    const manifest = await readJsonFile<EvidenceManifest>(evidenceDir, "evidence-manifest.json");
    const existing = new Map((manifest?.asset_exports ?? []).map((asset) => [asset.filename, asset]));
    const filenames = [
      ...REQUIRED_EVIDENCE_ASSET_FILENAMES,
      ...OPTIONAL_EVIDENCE_ASSET_FILENAMES,
    ];

    const assets = filenames.map((filename): EvidenceAssetExportRecord => {
      const previous = existing.get(filename);
      if (previous) return previous;
      const localPath = path.join(outputDir, filename);
      const legacyPath = legacyPathForFilename(manifest, evidenceDir, filename);
      if (fs.existsSync(localPath)) {
        return {
          filename,
          assetType: ASSET_TYPE_BY_FILENAME[filename] ?? filename.replace(/\.png$/, ""),
          status: "exported",
          assetSource: "gee",
          geeDataset: exportMetadataForFilename(manifest, filename)?.sourceDataset ?? null,
          exportMethod: exportMetadataForFilename(manifest, filename)?.exportMethod ?? "gee-thumbnail",
          generatedAt: new Date().toISOString(),
          localPath,
          sourcePath: null,
          generationDurationMs: 0,
        };
      }
      if (legacyPath) {
        return {
          filename,
          assetType: ASSET_TYPE_BY_FILENAME[filename] ?? filename.replace(/\.png$/, ""),
          status: "fallback",
          assetSource: "legacy-root",
          geeDataset: exportMetadataForFilename(manifest, filename)?.sourceDataset ?? null,
          exportMethod: "copy-fallback",
          generatedAt: new Date().toISOString(),
          localPath: legacyPath,
          sourcePath: legacyPath,
          generationDurationMs: 0,
        };
      }
      return {
        filename,
        assetType: ASSET_TYPE_BY_FILENAME[filename] ?? filename.replace(/\.png$/, ""),
        status: "missing",
        assetSource: "unavailable",
        geeDataset: exportMetadataForFilename(manifest, filename)?.sourceDataset ?? null,
        exportMethod: "none",
        generatedAt: new Date().toISOString(),
        localPath: null,
        sourcePath: null,
        generationDurationMs: 0,
      };
    });

    return {
      projectId,
      runId,
      assetsDir: outputDir,
      requiredAssets: [...REQUIRED_EVIDENCE_ASSET_FILENAMES],
      optionalAssets: [...OPTIONAL_EVIDENCE_ASSET_FILENAMES],
      assets,
    };
  }
}

export const evidenceExportService = new EvidenceExportService();
