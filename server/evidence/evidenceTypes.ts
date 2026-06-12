export type EvidenceRunStatus = "created" | "running" | "complete" | "failed";

export interface VegetationMetrics {
  ndvi_mean: number | null;
  ndvi_min: number | null;
  ndvi_max: number | null;
  evi_mean: number | null;
  savi_mean: number | null;
  ndwi_mean: number | null;
  ndmi_mean: number | null;
  nbr_mean: number | null;
  bsi_mean: number | null;
}

export interface BoundaryMetrics {
  area_ha: number | null;
  area_sqm: number | null;
  perimeter_km: number | null;
  centroid_lat: number | null;
  centroid_lng: number | null;
}

export interface MonitoringMetadata {
  cycle_type: string;
  cycle_id: string | null;
  triggered_by: string;
  start_date: string;
  end_date: string;
  satellite_source: string;
  cloud_cover_pct: number | null;
  fallback_used: boolean;
  observation_count: number;
}

export interface TrustMetrics {
  trust_score: number | null;
  confidence: string | null;
  ecosystem_health_index: number | null;
  ndvi_delta_pct: number | null;
  baseline_ndvi: number | null;
}

// ── Phase 2A additions ───────────────────────────────────────────────────────


export interface ThermalMetrics {
  lst_mean: number | null;
  lst_min: number | null;
  lst_max: number | null;
  dataset: string | null;
  acquisition_date: string | null;
}

export interface LULCMetrics {
  vegetation_pct: number | null;
  water_pct: number | null;
  barren_pct: number | null;
  builtup_pct: number | null;
  other_pct: number | null;
  dataset: string | null;
}

// ── Phase 2B additions ───────────────────────────────────────────────────────

export interface YearlyNdviMetric {
  year: number;
  ndvi_mean: number | null;
  delta: number | null;
}

export interface HistoricalMetrics {
  baseline_year: number;
  current_year: number;
  trend_direction: "improving" | "declining" | "stable";
  trend_strength: number;
  yearly_metrics: YearlyNdviMetric[];
  dataset: string | null;
}

// ── Phase 2C additions ───────────────────────────────────────────────────────

export interface RestorationMetrics {
  suitability_score: number;
  vegetation_condition: number;
  moisture_condition: number;
  soil_condition: number;
  slope_condition: number;
  priority_level: "high" | "medium" | "low";
  methodology_version: string;
}

// ── Phase 2D additions ───────────────────────────────────────────────────────

export interface HydrologyMetrics {
  mean_elevation: number | null;
  min_elevation: number | null;
  max_elevation: number | null;
  mean_slope: number | null;
  slope_class: "flat" | "gentle" | "moderate" | "steep";
  runoff_risk: "low" | "medium" | "high";
  water_retention_score: number;
  hydro_stress_score: number;
  dataset: string | null;
  methodology_version: string;
}

// ── Phase 2E additions ───────────────────────────────────────────────────────

export interface RiskMetrics {
  overall_risk_score: number;
  vegetation_risk: number;
  moisture_risk: number;
  thermal_risk: number;
  soil_risk: number;
  hydrology_risk: number;
  trend_risk: number;
  restoration_priority: "low" | "moderate" | "high";
  intervention_urgency: "routine" | "elevated" | "urgent";
  monitoring_priority: "standard" | "increased" | "intensive";
  confidence_score: number;
  methodology_version: string;
}

// ── MetricsJson v1.5 (backward compatible — all new fields are optional) ─────

export interface MetricsJson {
  schema_version: "1.0" | "1.1" | "1.2" | "1.3" | "1.4" | "1.5";
  run_id: string;
  project_id: string;
  generated_at: string;
  boundary: BoundaryMetrics;
  vegetation: VegetationMetrics;
  trust: TrustMetrics;
  monitoring: MonitoringMetadata;
  /** v1.1+: Landsat thermal (LST) section. Absent in v1.0 runs. */
  thermal?: ThermalMetrics;
  /** v1.1+: Land use / land cover classification. Absent in v1.0 runs. */
  lulc?: LULCMetrics;
  /** v1.2+: Multi-year NDVI change analysis. Absent in v1.0 and v1.1 runs. */
  historical?: HistoricalMetrics;
  /** v1.3+: Restoration suitability scoring. Absent in v1.0-v1.2 runs. */
  restoration?: RestorationMetrics;
  /** v1.4+: DEM terrain and hydrology proxy metrics. Absent in v1.0-v1.3 runs. */
  hydrology?: HydrologyMetrics;
  /** v1.5+: Unified ecological risk assessment. Absent in v1.0-v1.4 runs. */
  risk?: RiskMetrics;
}

export interface AssetRecord {
  filename: string;
  path: string;
  size_bytes: number;
  checksum_sha256: string;
  generated_at: string;
  // Provenance (OPS — real satellite imagery). Optional for backward compatibility.
  source?: "gee" | "procedural";
  dataset?: string | null;
  acquisition_date?: string | null;
}

export type ExportAssetType =
  | "true-color"
  | "ndvi"
  | "ndwi"
  | "lulc"
  | "lst"
  | "hydrology"
  | "restoration"
  | "risk";

export type ExportMethod =
  | "gee-thumbnail"
  | "gee-download-url"
  | "local-deterministic"
  | "unsupported";

export interface ExportAsset {
  assetId: string;
  runId: string;
  assetType: ExportAssetType;
  sourceDataset: string;
  exportMethod: ExportMethod;
  generatedAt: string;
  localPath: string | null;
  thumbnailUrl: string | null;
  geeMetadata: Record<string, unknown>;
}

export type EvidenceAssetExportStatus = "exported" | "fallback" | "missing" | "failed";

export interface EvidenceAssetExportRecord {
  filename: string;
  assetType: string;
  status: EvidenceAssetExportStatus;
  assetSource: "gee" | "local-fallback" | "legacy-root" | "unavailable";
  geeDataset: string | null;
  exportMethod: ExportMethod | "copy-fallback" | "none";
  generatedAt: string;
  localPath: string | null;
  sourcePath: string | null;
  generationDurationMs: number;
  error?: string;
}

export type EvidenceValidationStatus = "pass" | "warning" | "fail";

export interface EvidenceValidationSummary {
  status: EvidenceValidationStatus;
  score: number;
  warnings: string[];
  errors: string[];
  missing_assets: string[];
  generated_assets: string[];
  validated_at: string;
}

export interface WorkflowRecord {
  workflow_id: string;
  name: string;
  status: "complete" | "skipped" | "failed";
  duration_ms: number;
  outputs: string[];
}

export interface EvidenceManifest {
  schema_version: "1.0";
  run_id: string;
  project_id: string;
  created_at: string;
  completed_at: string | null;
  status: EvidenceRunStatus;
  evidence_path: string;
  execution_duration_ms: number;
  workflows: WorkflowRecord[];
  assets: AssetRecord[];
  /** Phase 3A+: standardized GEE/local export metadata. Optional for older manifests. */
  export_assets?: ExportAsset[];
  /** Phase 4B+: materialized report-consumable asset export state. Optional for older manifests. */
  asset_exports?: EvidenceAssetExportRecord[];
  /** Phase 3B+: evidence package validation summary. Optional for older manifests. */
  validation?: EvidenceValidationSummary;
  gee_execution: {
    fallback_used: boolean;
    datasets: string[];
    cloud_threshold_pct: number;
    observation_count: number;
  };
}

export interface AnalysisRunRecord {
  id: string;
  runId: string;
  projectId: string;
  status: EvidenceRunStatus;
  startedAt: Date;
  completedAt: Date | null;
  evidencePath: string | null;
  createdAt: Date;
}
