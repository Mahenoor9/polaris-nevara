import type { NormalizedPolygon } from "../gis/polygon-ingestion";

export type MonitoringState =
  | "DRAFT"
  | "POLYGON_SUBMITTED"
  | "GIS_ANALYSIS_PENDING"
  | "GIS_ANALYSIS_RUNNING"
  | "GIS_ANALYSIS_FAILED"
  | "BASELINE_COMPLETE"
  | "MONITORING_ACTIVE"
  | "MONITORING_PAUSED"
  | "ARCHIVED";

export type MonitoringTransition =
  | "SUBMIT_POLYGON"
  | "START_GIS_ANALYSIS"
  | "GIS_ANALYSIS_SUCCESS"
  | "GIS_ANALYSIS_FAIL"
  | "RETRY_GIS_ANALYSIS"
  | "START_MONITORING"
  | "PAUSE_MONITORING"
  | "RESUME_MONITORING"
  | "ARCHIVE";

export type MonitoringCycleType = "baseline" | "scheduled" | "manual" | "event_triggered";

export type MonitoringCycleStatus =
  | "pending"
  | "imagery_collection"
  | "analyzing"
  | "analysis_complete"
  | "under_review"
  | "verified"
  | "flagged"
  | "failed";

// Spectral index types supported by the multi-index pipeline
export type SpectralIndexType =
  | "ndvi"      // Normalized Difference Vegetation Index
  | "evi"       // Enhanced Vegetation Index
  | "savi"      // Soil-Adjusted Vegetation Index
  | "ndwi"      // Normalized Difference Water Index
  | "ndmi"      // Normalized Difference Moisture Index
  | "nbr"       // Normalized Burn Ratio
  | "bsi"       // Bare Soil Index
  | "mndwi";    // Modified NDWI

// Full set of observation types stored in environmental_observations
export type ObservationTypeExtended =
  | "ndvi"
  | "evi"
  | "savi"
  | "ndwi"
  | "ndmi"
  | "nbr"
  | "bsi"
  | "land_cover"
  | "moisture_index"
  | "surface_temp"
  | "vegetation_fraction"
  | "erosion_risk"
  | "ecosystem_health";

export interface AnalysisJobPayload {
  jobId: string;
  projectId: string;
  cycleType: MonitoringCycleType;
  polygon: NormalizedPolygon;
  cycleId?: string;
  triggeredBy: string;
  startDate: string;
  endDate: string;
  retryCount?: number;
  runId?: string;
  /** For monitoring cycles: the baseline observation record for delta computation */
  baselineSnapshot?: BaselineSnapshot;
  /** For trend/ecosystem analysis: prior monitoring snapshots */
  historicalSnapshots?: MonitoringSnapshot[];
}

/** Minimal baseline snapshot for delta calculations */
export interface BaselineSnapshot {
  observedAt: string;
  ndviMean: number | null;
  ndwiMean: number | null;
  ndmiMean: number | null;
  eviMean: number | null;
  saviMean: number | null;
  greenCoverPercent: number | null;
  bareLandPercent: number | null;
}

/** Compact monitoring snapshot for multi-cycle comparison and trend analysis */
export interface MonitoringSnapshot {
  cycleId: string;
  observedAt: string;
  ndviMean: number | null;
  ndmiMean: number | null;
  ndwiMean: number | null;
  eviMean: number | null;
  greenCoverPercent: number | null;
  bareLandPercent: number | null;
  waterAreaPercent: number | null;
}

/** Zonal statistics for a single spectral band/index */
export interface ZonalStats {
  mean: number | null;
  min: number | null;
  max: number | null;
  stddev: number | null;
  median: number | null;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
}

/** Dataset attribution record persisted with each observation */
export interface DatasetAttribution {
  datasetId: string;       // e.g. "COPERNICUS/S2_SR_HARMONIZED"
  datasetLabel: string;    // Human-readable label
  imageCount: number;
  dateRangeStart: string;
  dateRangeEnd: string;
  resolutionM: number;
  cloudThresholdPct: number;
  compositingMethod: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

export interface ObservationArtifact {
  rasterAssetPath: string;
  thumbnailPath: string;
  tileLayerPath: string;
  sourceDataset: string;
  sourceImageId?: string;
  sourceResolutionM: number;
  processingAlgorithm: string;
  processingParameters: Record<string, unknown>;
}

export interface PreparedObservation {
  observationType: ObservationTypeExtended;
  observedAt: Date;
  valueMean: number;
  valueMin: number;
  valueMax: number;
  valueStddev: number;
  valueMedian: number;
  /** Full zonal stats for richer report rendering */
  zonalStats?: ZonalStats;
  valueDistribution: Record<string, unknown>;
  valueUnit: string;
  spatialCoveragePct: number;
  confidence: number;
  qualityFlag: "good" | "acceptable" | "low" | "failed";
  artifact: ObservationArtifact;
  /** Dataset attribution for this observation */
  attribution?: DatasetAttribution;
}

/** Change detection result between two observations of the same type */
export interface ObservationDelta {
  observationType: ObservationTypeExtended;
  baselineValue: number | null;
  currentValue: number | null;
  absoluteChange: number | null;
  relativeChangePct: number | null;
  baselineDate: string;
  currentDate: string;
  direction: "improving" | "declining" | "stable" | "insufficient_data";
}

/** Multi-cycle comparison result */
export interface MultiCycleComparison {
  indicator: ObservationTypeExtended;
  cycles: Array<{
    cycleId: string;
    observedAt: string;
    value: number | null;
  }>;
  trend: {
    slope: number;
    direction: "improving" | "declining" | "stable";
    rSquared?: number;
  };
  peakCycle: string | null;
  peakValue: number | null;
  troughCycle: string | null;
  troughValue: number | null;
}

export interface GEEExecutionResult {
  projectId: string;
  cycleType: MonitoringCycleType;
  observations: PreparedObservation[];
  /** Change detection deltas from baseline */
  deltas?: ObservationDelta[];
  /** Ecosystem health index (0-100) computed from this cycle */
  ecosystemHealthIndex?: number;
  hooks: {
    cloudThresholdPct: number;
    fallbackUsed: boolean;
    datasets: string[];
    attributions?: DatasetAttribution[];
  };
  errors?: Array<{ module: string; error: string }>;
}
