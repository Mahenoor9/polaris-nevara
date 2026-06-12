import path from "path";
import { randomUUID } from "crypto";
import type { GEEExecutionResult, AnalysisJobPayload } from "../mrv/types";
import type {
  MetricsJson,
  ThermalMetrics,
  LULCMetrics,
  HistoricalMetrics,
  RestorationMetrics,
  HydrologyMetrics,
  RiskMetrics,
  EvidenceManifest,
  WorkflowRecord,
  AssetRecord,
  ExportAsset,
  EvidenceRunStatus,
} from "./evidenceTypes";
import type { LSTResult } from "../gee/workflow-02-lst";
import type { LULCResult } from "../gee/workflow-06-lulc";
import type { HistoricalResult } from "../gee/workflow-05-historical";
import type { RestorationResult } from "../gee/workflow-03-restoration";
import type { HydrologyResult } from "../gee/workflow-04-dem-hydro";
import type { RiskEngineResult } from "../intelligence/workflow-risk-engine";
import { buildAndSaveObservations } from "../intelligence/observation-engine";
import { buildManifestExportAssets } from "../gee/export-engine";
import {
  ensureEvidenceDir,
  writeJsonFile,
  readJsonFile,
  fileChecksum,
  fileSize,
  listRunIds as fsListRunIds,
  getEvidenceRunDir,
} from "./evidenceStorage";
import { validateEvidencePackage } from "./evidence-validator";

export function generateRunId(): string {
  const now = new Date();
  const ts =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0") +
    "T" +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0") +
    String(now.getUTCSeconds()).padStart(2, "0");
  const shortUuid = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${ts}-${shortUuid}`;
}

function buildMetrics(
  runId: string,
  projectId: string,
  payload: AnalysisJobPayload,
  geeResult: GEEExecutionResult,
  project: { area?: number | null; areaHectares?: number | null; perimeterKm?: number | null; centroid?: string | null } | null,
  mrvScore: { trustScore?: number; confidence?: string; ndviDeltaPct?: number; baselineNdvi?: number } | null,
  lstResult?: LSTResult,
  lulcResult?: LULCResult,
  historicalResult?: HistoricalResult,
  hydrologyResult?: HydrologyResult,
  restorationResult?: RestorationResult,
  riskResult?: RiskEngineResult,
): MetricsJson {
  const obs = geeResult.observations;
  const getObs = (type: string) => obs.find((o) => o.observationType === type);

  const ndvi = getObs("ndvi");
  const evi = getObs("evi");
  const savi = getObs("savi");
  const ndwi = getObs("ndwi");
  const ndmi = getObs("ndmi");
  const nbr = getObs("nbr");
  const bsi = getObs("bsi");

  let centroidLat: number | null = null;
  let centroidLng: number | null = null;
  if (project?.centroid) {
    try {
      const c = JSON.parse(project.centroid as string);
      if (Array.isArray(c)) {
        centroidLng = c[0] ?? null;
        centroidLat = c[1] ?? null;
      } else if (c && typeof c === "object") {
        centroidLat = c.lat ?? c.latitude ?? null;
        centroidLng = c.lng ?? c.lon ?? c.longitude ?? null;
      }
    } catch { /* leave null */ }
  }

  const areaHa = project?.areaHectares ?? project?.area ?? null;

  const thermal: ThermalMetrics | undefined = lstResult
    ? {
        lst_mean: lstResult.lst_mean,
        lst_min: lstResult.lst_min,
        lst_max: lstResult.lst_max,
        dataset: lstResult.dataset,
        acquisition_date: lstResult.acquisition_date,
      }
    : undefined;

  const lulc: LULCMetrics | undefined = lulcResult
    ? {
        vegetation_pct: lulcResult.vegetation_pct,
        water_pct: lulcResult.water_pct,
        barren_pct: lulcResult.barren_pct,
        builtup_pct: lulcResult.builtup_pct,
        other_pct: lulcResult.other_pct,
        dataset: lulcResult.dataset,
      }
    : undefined;

  const historical: HistoricalMetrics | undefined = historicalResult
    ? {
        baseline_year: historicalResult.baseline_year,
        current_year: historicalResult.current_year,
        trend_direction: historicalResult.trend_direction,
        trend_strength: historicalResult.trend_strength,
        yearly_metrics: historicalResult.yearly_metrics,
        dataset: historicalResult.dataset,
      }
    : undefined;

  const restoration: RestorationMetrics | undefined = restorationResult
    ? {
        suitability_score: restorationResult.suitability_score,
        vegetation_condition: restorationResult.vegetation_condition,
        moisture_condition: restorationResult.moisture_condition,
        soil_condition: restorationResult.soil_condition,
        slope_condition: restorationResult.slope_condition,
        priority_level: restorationResult.priority_level,
        methodology_version: restorationResult.methodology_version,
      }
    : undefined;

  const hydrology: HydrologyMetrics | undefined = hydrologyResult
    ? {
        mean_elevation: hydrologyResult.mean_elevation,
        min_elevation: hydrologyResult.min_elevation,
        max_elevation: hydrologyResult.max_elevation,
        mean_slope: hydrologyResult.mean_slope,
        slope_class: hydrologyResult.slope_class,
        runoff_risk: hydrologyResult.runoff_risk,
        water_retention_score: hydrologyResult.water_retention_score,
        hydro_stress_score: hydrologyResult.hydro_stress_score,
        dataset: hydrologyResult.dataset,
        methodology_version: hydrologyResult.methodology_version,
      }
    : undefined;

  const risk: RiskMetrics | undefined = riskResult
    ? {
        overall_risk_score: riskResult.overall_risk_score,
        vegetation_risk: riskResult.vegetation_risk,
        moisture_risk: riskResult.moisture_risk,
        thermal_risk: riskResult.thermal_risk,
        soil_risk: riskResult.soil_risk,
        hydrology_risk: riskResult.hydrology_risk,
        trend_risk: riskResult.trend_risk,
        restoration_priority: riskResult.restoration_priority,
        intervention_urgency: riskResult.intervention_urgency,
        monitoring_priority: riskResult.monitoring_priority,
        confidence_score: riskResult.confidence_score,
        methodology_version: riskResult.methodology_version,
      }
    : undefined;

  return {
    schema_version: "1.5",
    run_id: runId,
    project_id: projectId,
    generated_at: new Date().toISOString(),
    boundary: {
      area_ha: areaHa,
      area_sqm: areaHa != null ? areaHa * 10_000 : null,
      perimeter_km: project?.perimeterKm ?? null,
      centroid_lat: centroidLat,
      centroid_lng: centroidLng,
    },
    vegetation: {
      ndvi_mean: ndvi?.valueMean ?? null,
      ndvi_min: ndvi?.valueMin ?? null,
      ndvi_max: ndvi?.valueMax ?? null,
      evi_mean: evi?.valueMean ?? null,
      savi_mean: savi?.valueMean ?? null,
      ndwi_mean: ndwi?.valueMean ?? null,
      ndmi_mean: ndmi?.valueMean ?? null,
      nbr_mean: nbr?.valueMean ?? null,
      bsi_mean: bsi?.valueMean ?? null,
    },
    trust: {
      trust_score: mrvScore?.trustScore ?? null,
      confidence: mrvScore?.confidence ?? null,
      ecosystem_health_index: geeResult.ecosystemHealthIndex ?? null,
      ndvi_delta_pct: mrvScore?.ndviDeltaPct ?? null,
      baseline_ndvi: mrvScore?.baselineNdvi ?? null,
    },
    monitoring: {
      cycle_type: payload.cycleType,
      cycle_id: payload.cycleId ?? null,
      triggered_by: payload.triggeredBy,
      start_date: payload.startDate,
      end_date: payload.endDate,
      satellite_source: ndvi?.attribution?.datasetLabel ?? geeResult.hooks.datasets[0] ?? "Sentinel-2",
      cloud_cover_pct: geeResult.hooks.cloudThresholdPct ?? null,
      fallback_used: geeResult.hooks.fallbackUsed,
      observation_count: geeResult.observations.length,
    },
    ...(thermal ? { thermal } : {}),
    ...(lulc ? { lulc } : {}),
    ...(historical ? { historical } : {}),
    ...(hydrology ? { hydrology } : {}),
    ...(restoration ? { restoration } : {}),
    ...(risk ? { risk } : {}),
  };
}

async function buildManifest(
  runId: string,
  projectId: string,
  evidenceDir: string,
  status: EvidenceRunStatus,
  startedAt: Date,
  geeResult: GEEExecutionResult,
  metricsPath: string,
  observationsPath: string | null,
  lstResult?: LSTResult,
  lulcResult?: LULCResult,
  historicalResult?: HistoricalResult,
  hydrologyResult?: HydrologyResult,
  restorationResult?: RestorationResult,
  riskResult?: RiskEngineResult,
  imageAssets?: AssetRecord[],
  exportAssets?: ExportAsset[],
): Promise<EvidenceManifest> {
  const completedAt = new Date();
  const elapsed = completedAt.getTime() - startedAt.getTime();
  const imageAssetNames = new Set((imageAssets ?? []).map((asset) => asset.filename));
  const staticEvidenceOutputs = ["boundary-overview.png", "true-color.png", "ndwi.png"]
    .filter((filename) => imageAssetNames.has(filename));

  const metricsAsset: AssetRecord = {
    filename: "metrics.json",
    path: metricsPath,
    size_bytes: await fileSize(metricsPath),
    checksum_sha256: await fileChecksum(metricsPath),
    generated_at: completedAt.toISOString(),
  };
  const observationAsset: AssetRecord | null = observationsPath
    ? {
        filename: "observations.json",
        path: observationsPath,
        size_bytes: await fileSize(observationsPath),
        checksum_sha256: await fileChecksum(observationsPath),
        generated_at: completedAt.toISOString(),
      }
    : null;

  const workflows: WorkflowRecord[] = [
    {
      workflow_id: "workflow-01-multi-index",
      name: "Multi-Index Spectral Analysis (NDVI/EVI/SAVI/NDWI/NDMI/NBR/BSI)",
      status: geeResult.observations.length > 0 ? "complete" : "failed",
      duration_ms: elapsed,
      outputs: ["metrics.json"],
    },
    {
      workflow_id: "workflow-02-lst",
      name: "Landsat Surface Temperature (LST)",
      status: lstResult ? "complete" : "skipped",
      duration_ms: 0,
      outputs: lstResult ? ["thermal section in metrics.json", "lst.png"] : [],
    },
    {
      workflow_id: "workflow-06-lulc",
      name: "Land Use / Land Cover Classification (Dynamic World)",
      status: lulcResult ? "complete" : "skipped",
      duration_ms: 0,
      outputs: lulcResult ? ["lulc section in metrics.json", "lulc.png"] : [],
    },
    {
      workflow_id: "workflow-05-historical",
      name: "Historical NDVI Change Analysis (Sentinel-2 2020–present)",
      status: historicalResult ? "complete" : "skipped",
      duration_ms: 0,
      outputs: historicalResult
        ? ["historical section in metrics.json", "historical-trend.png"]
        : [],
    },
    {
      workflow_id: "workflow-04-dem-hydro",
      name: "DEM & Hydrology Terrain Analysis",
      status: hydrologyResult ? "complete" : "skipped",
      duration_ms: 0,
      outputs: hydrologyResult
        ? ["hydrology section in metrics.json", "hydrology.png"]
        : [],
    },
    {
      workflow_id: "workflow-03-restoration",
      name: "Restoration Suitability Engine",
      status: restorationResult ? "complete" : "skipped",
      duration_ms: 0,
      outputs: restorationResult
        ? ["restoration section in metrics.json", "restoration.png"]
        : [],
    },
    {
      workflow_id: "workflow-risk-engine",
      name: "Ecological Risk & Priority Engine",
      status: riskResult ? "complete" : "skipped",
      duration_ms: 0,
      outputs: riskResult
        ? ["risk section in metrics.json", "risk.png"]
        : [],
    },
    {
      workflow_id: "observation-engine",
      name: "Deterministic Evidence Observation Engine",
      status: observationAsset ? "complete" : "skipped",
      duration_ms: 0,
      outputs: observationAsset ? ["observations.json"] : [],
    },
    {
      workflow_id: "workflow-static-evidence",
      name: "Boundary Overview & Static Evidence Completeness",
      status: staticEvidenceOutputs.length > 0 ? "complete" : "skipped",
      duration_ms: 0,
      outputs: staticEvidenceOutputs,
    },
  ];

  return {
    schema_version: "1.0",
    run_id: runId,
    project_id: projectId,
    created_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    status,
    evidence_path: evidenceDir,
    execution_duration_ms: elapsed,
    workflows,
    assets: [metricsAsset, ...(observationAsset ? [observationAsset] : []), ...(imageAssets ?? [])],
    ...(exportAssets ? { export_assets: exportAssets } : {}),
    gee_execution: {
      fallback_used: geeResult.hooks.fallbackUsed,
      datasets: geeResult.hooks.datasets,
      cloud_threshold_pct: geeResult.hooks.cloudThresholdPct,
      observation_count: geeResult.observations.length,
    },
  };
}

export class EvidenceService {
  async prepareRunDirectory(projectId: string, runId: string): Promise<string> {
    return ensureEvidenceDir(projectId, runId);
  }

  async buildAndSavePackage(params: {
    runId: string;
    projectId: string;
    payload: AnalysisJobPayload;
    geeResult: GEEExecutionResult;
    project: { area?: number | null; areaHectares?: number | null; perimeterKm?: number | null; centroid?: string | null } | null;
    mrvScore: { trustScore?: number; confidence?: string; ndviDeltaPct?: number; baselineNdvi?: number } | null;
    startedAt: Date;
    /** Phase 2A: optional LST result to include in metrics.json thermal section */
    lstResult?: LSTResult;
    /** Phase 2A: optional LULC result to include in metrics.json lulc section */
    lulcResult?: LULCResult;
    /** Phase 2B: optional historical NDVI result to include in metrics.json historical section */
    historicalResult?: HistoricalResult;
    /** Phase 2D: optional DEM/Hydrology result to include in metrics.json hydrology section */
    hydrologyResult?: HydrologyResult;
    /** Phase 2C: optional restoration suitability result to include in metrics.json restoration section */
    restorationResult?: RestorationResult;
    /** Phase 2E: optional ecological risk result to include in metrics.json risk section */
    riskResult?: RiskEngineResult;
    /** Phase 2A+: pre-exported image asset records to include in manifest */
    imageAssets?: AssetRecord[];
    /** Phase 3A: standardized real/local export metadata to include in manifest */
    exportAssets?: ExportAsset[];
  }): Promise<{ metricsPath: string; manifestPath: string; evidenceDir: string }> {
    const { runId, projectId, payload, geeResult, project, mrvScore, startedAt, lstResult, lulcResult, historicalResult, hydrologyResult, restorationResult, riskResult, imageAssets } = params;

    const evidenceDir = await ensureEvidenceDir(projectId, runId);

    const metrics = buildMetrics(runId, projectId, payload, geeResult, project, mrvScore, lstResult, lulcResult, historicalResult, hydrologyResult, restorationResult, riskResult);
    const metricsPath = await writeJsonFile(evidenceDir, "metrics.json", metrics);
    let observationsPath: string | null = null;
    try {
      const observationResult = await buildAndSaveObservations(projectId, runId);
      observationsPath = observationResult.observationsPath;
    } catch (error) {
      console.warn("[evidence] observation generation skipped", error);
    }
    const exportAssets = params.exportAssets ?? buildManifestExportAssets({
      runId,
      imageAssets: imageAssets ?? [],
      geeResult,
    });

    const manifest = await buildManifest(
      runId,
      projectId,
      evidenceDir,
      "complete",
      startedAt,
      geeResult,
      metricsPath,
      observationsPath,
      lstResult,
      lulcResult,
      historicalResult,
      hydrologyResult,
      restorationResult,
      riskResult,
      imageAssets,
      exportAssets,
    );
    const manifestPath = await writeJsonFile(evidenceDir, "evidence-manifest.json", manifest);

    try {
      const validationReport = await validateEvidencePackage(projectId, runId);
      await writeJsonFile(evidenceDir, "evidence-manifest.json", {
        ...manifest,
        validation: validationReport.validation,
      });
    } catch (error) {
      console.warn("[evidence] validation skipped after package creation", error);
    }

    return { metricsPath, manifestPath, evidenceDir };
  }

  async getMetrics(projectId: string, runId: string): Promise<MetricsJson | null> {
    const dir = getEvidenceRunDir(projectId, runId);
    return readJsonFile<MetricsJson>(dir, "metrics.json");
  }

  async getManifest(projectId: string, runId: string): Promise<EvidenceManifest | null> {
    const dir = getEvidenceRunDir(projectId, runId);
    return readJsonFile<EvidenceManifest>(dir, "evidence-manifest.json");
  }

  async listRunIds(projectId: string): Promise<string[]> {
    return fsListRunIds(projectId);
  }

  async validateRun(projectId: string, runId: string) {
    return validateEvidencePackage(projectId, runId);
  }

  async getSummary(projectId: string, runId: string) {
    const [manifest, metrics, validationReport] = await Promise.all([
      this.getManifest(projectId, runId),
      this.getMetrics(projectId, runId),
      validateEvidencePackage(projectId, runId),
    ]);

    return {
      runId,
      projectId,
      metrics_version: metrics?.schema_version ?? null,
      workflows_executed: (manifest?.workflows ?? []).map((workflow) => ({
        workflow_id: workflow.workflow_id,
        name: workflow.name,
        status: workflow.status,
        outputs: workflow.outputs,
      })),
      assets_generated: validationReport.validation.generated_assets,
      export_metadata: manifest?.export_assets ?? [],
      timestamps: {
        manifest_created_at: manifest?.created_at ?? null,
        manifest_completed_at: manifest?.completed_at ?? null,
        metrics_generated_at: metrics?.generated_at ?? null,
        validation_checked_at: validationReport.validation.validated_at,
      },
      validation_state: validationReport.validation,
      inventory: {
        assets: validationReport.asset_inventory,
        workflows: validationReport.workflow_inventory,
        metrics: validationReport.metrics_inventory,
      },
    };
  }

  getEvidencePath(projectId: string, runId: string): string {
    return getEvidenceRunDir(projectId, runId);
  }
}

export const evidenceService = new EvidenceService();
