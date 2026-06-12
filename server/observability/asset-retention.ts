/**
 * server/observability/asset-retention.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Asset cleanup and retention policy enforcement.
 *
 * Policy:
 *   - XYZ tile directories: kept for 90 days (re-generatable from rasters)
 *   - Temporary report artifacts (intermediate HTML): kept for 7 days
 *   - Raster thumbnails: kept permanently (small, high value)
 *   - Full GeoTIFFs: kept for 365 days (large, expensive to regenerate)
 *   - Audit/log files: kept for 180 days
 *
 * Safe to run as a daily cron job:
 *   0 2 * * * tsx server/observability/asset-retention.ts >> /var/log/nevara/cleanup.log 2>&1
 *
 * OR triggered via: GET /api/ops/cleanup (admin only, returns dry-run by default)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readdir, stat, rm } from "fs/promises";
import { join } from "path";
import { appendAuditEvent } from "./audit-event-store";
import { createLogger } from "./structured-logger";

const log = createLogger("AssetRetention");

// ─── Policy definitions ───────────────────────────────────────────────────────

const RETENTION_POLICIES: Array<{
  subdir: string;
  pattern: RegExp;
  maxAgeDays: number;
  description: string;
}> = [
  {
    subdir: "tiles",
    pattern: /^.*$/,
    maxAgeDays: 90,
    description: "XYZ tile directories (re-generatable from rasters)",
  },
  {
    subdir: "reports/tmp",
    pattern: /\.html$/,
    maxAgeDays: 7,
    description: "Intermediate HTML report artifacts",
  },
  {
    subdir: "rasters",
    pattern: /\.tif$/,
    maxAgeDays: 365,
    description: "GeoTIFF rasters",
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CleanupResult {
  policy: string;
  scanned: number;
  deleted: number;
  freedBytes: number;
  errors: string[];
  dryRun: boolean;
}

// ─── Core cleanup logic ───────────────────────────────────────────────────────

async function cleanupDirectory(
  baseDir: string,
  policy: (typeof RETENTION_POLICIES)[0],
  dryRun: boolean
): Promise<CleanupResult> {
  const dir = join(baseDir, policy.subdir);
  const result: CleanupResult = {
    policy: policy.description,
    scanned: 0,
    deleted: 0,
    freedBytes: 0,
    errors: [],
    dryRun,
  };

  const cutoffMs = Date.now() - policy.maxAgeDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist — skip silently
    return result;
  }

  for (const entry of entries) {
    if (!policy.pattern.test(entry)) continue;

    const fullPath = join(dir, entry);
    result.scanned++;

    try {
      const fileStat = await stat(fullPath);
      const ageMs = Date.now() - fileStat.mtimeMs;

      if (ageMs > cutoffMs) {
        result.freedBytes += fileStat.size;

        if (!dryRun) {
          await rm(fullPath, { recursive: true, force: true });
          log.info("Deleted expired asset", {
            path: fullPath,
            ageDays: (ageMs / 86_400_000).toFixed(1),
            size: fileStat.size,
          });
        } else {
          log.info("[DRY RUN] Would delete expired asset", {
            path: fullPath,
            ageDays: (ageMs / 86_400_000).toFixed(1),
            size: fileStat.size,
          });
        }
        result.deleted++;
      }
    } catch (err: any) {
      result.errors.push(`${entry}: ${err.message}`);
    }
  }

  return result;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runAssetCleanup(options: {
  baseDir?: string;
  dryRun?: boolean;
}): Promise<CleanupResult[]> {
  const baseDir = options.baseDir ?? process.env.PRIVATE_OBJECT_DIR ?? "./data/nevara";
  const dryRun = options.dryRun ?? true; // Default: safe dry-run mode

  log.info("Starting asset retention cleanup", { baseDir, dryRun, policies: RETENTION_POLICIES.length });

  const results = await Promise.all(
    RETENTION_POLICIES.map((policy) => cleanupDirectory(baseDir, policy, dryRun))
  );

  const totalDeleted = results.reduce((s, r) => s + r.deleted, 0);
  const totalFreed = results.reduce((s, r) => s + r.freedBytes, 0);

  log.info("Asset cleanup complete", {
    totalDeleted,
    totalFreedMb: (totalFreed / 1024 / 1024).toFixed(2),
    dryRun,
  });

  appendAuditEvent({
    category: "SYSTEM",
    severity: "INFO",
    action: dryRun ? "retention.dryRun" : "retention.cleanup",
    detail: `Deleted ${totalDeleted} files, freed ${(totalFreed / 1024 / 1024).toFixed(1)}MB`,
  });

  return results;
}
