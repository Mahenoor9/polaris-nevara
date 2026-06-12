import { fileChecksum, fileSize, getEvidenceRunDir, readJsonFile, writeJsonFile } from "../evidence/evidenceStorage";
import type { EvidenceManifest, MetricsJson, WorkflowRecord } from "../evidence/evidenceTypes";

export type ObservationCategory =
  | "vegetation"
  | "thermal"
  | "land_use"
  | "historical_change"
  | "hydrology"
  | "restoration"
  | "risk";

export type ObservationSeverity = "low" | "moderate" | "high" | "critical";

export interface EvidenceObservation {
  id: string;
  category: ObservationCategory;
  severity: ObservationSeverity;
  metric: string;
  value: number | string | null;
  threshold: number | string;
  status: string;
  finding: string;
  recommendation: string;
  confidence: number;
}

export interface ObservationsJson {
  schema_version: "1.0";
  methodology_version: "observation-rules-v1.0";
  run_id: string;
  project_id: string;
  generated_at: string;
  observations: EvidenceObservation[];
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(4));
}

function severityFromScore(score: number): ObservationSeverity {
  if (score >= 85) return "critical";
  if (score >= 70) return "high";
  if (score >= 40) return "moderate";
  return "low";
}

function observation(params: Omit<EvidenceObservation, "id">, index: number): EvidenceObservation {
  return {
    id: `obs-${String(index).padStart(3, "0")}`,
    ...params,
  };
}

export function generateObservationsFromMetrics(metrics: MetricsJson): ObservationsJson {
  const observations: EvidenceObservation[] = [];
  const push = (params: Omit<EvidenceObservation, "id">) => {
    observations.push(observation(params, observations.length + 1));
  };

  const ndvi = metrics.vegetation.ndvi_mean;
  if (ndvi !== null && ndvi !== undefined) {
    const degraded = ndvi < 0.3;
    push({
      category: "vegetation",
      severity: ndvi < 0.2 ? "high" : degraded ? "moderate" : "low",
      metric: "vegetation.ndvi_mean",
      value: round(ndvi),
      threshold: degraded ? "< 0.30" : ">= 0.30",
      status: degraded ? "vegetation_degradation" : "vegetation_stable",
      finding: degraded ? "NDVI_BELOW_VEGETATION_HEALTH_THRESHOLD" : "NDVI_WITHIN_ACCEPTABLE_RANGE",
      recommendation: degraded ? "PRIORITIZE_FIELD_VERIFICATION_AND_REVEGETATION_PLANNING" : "CONTINUE_STANDARD_VEGETATION_MONITORING",
      confidence: 90,
    });
  }

  const ndmi = metrics.vegetation.ndmi_mean;
  if (ndmi !== null && ndmi !== undefined) {
    const dry = ndmi < 0;
    push({
      category: "vegetation",
      severity: ndmi < -0.15 ? "high" : dry ? "moderate" : "low",
      metric: "vegetation.ndmi_mean",
      value: round(ndmi),
      threshold: dry ? "< 0.00" : ">= 0.00",
      status: dry ? "moisture_stress" : "moisture_condition_stable",
      finding: dry ? "NDMI_INDICATES_VEGETATION_MOISTURE_STRESS" : "NDMI_INDICATES_ACCEPTABLE_MOISTURE_CONDITION",
      recommendation: dry ? "REVIEW_WATER_RETENTION_AND_SOIL_MOISTURE_CONDITIONS" : "MAINTAIN_CURRENT_MOISTURE_MONITORING",
      confidence: 86,
    });
  }

  const bsi = metrics.vegetation.bsi_mean;
  if (bsi !== null && bsi !== undefined) {
    const exposed = bsi > 0.2;
    push({
      category: "vegetation",
      severity: bsi > 0.35 ? "high" : exposed ? "moderate" : "low",
      metric: "vegetation.bsi_mean",
      value: round(bsi),
      threshold: exposed ? "> 0.20" : "<= 0.20",
      status: exposed ? "bare_soil_signal" : "bare_soil_signal_low",
      finding: exposed ? "BSI_INDICATES_ELEVATED_BARE_SOIL_CONDITION" : "BSI_DOES_NOT_INDICATE_ELEVATED_BARE_SOIL_CONDITION",
      recommendation: exposed ? "TARGET_SOIL_STABILIZATION_AND_GROUND_COVER_REVIEW" : "CONTINUE_STANDARD_SOIL_SURFACE_MONITORING",
      confidence: 84,
    });
  }

  const lst = metrics.thermal?.lst_mean;
  if (lst !== null && lst !== undefined) {
    const heat = lst > 35;
    push({
      category: "thermal",
      severity: lst > 40 ? "high" : heat ? "moderate" : "low",
      metric: "thermal.lst_mean",
      value: round(lst),
      threshold: heat ? "> 35 C" : "<= 35 C",
      status: heat ? "heat_stress" : "thermal_condition_stable",
      finding: heat ? "LST_EXCEEDS_HEAT_STRESS_THRESHOLD" : "LST_WITHIN_ACCEPTABLE_MONITORING_RANGE",
      recommendation: heat ? "PRIORITIZE_CANOPY_COVER_AND_WATER_STRESS_REVIEW" : "CONTINUE_STANDARD_THERMAL_MONITORING",
      confidence: 82,
    });
  }

  const vegetationPct = metrics.lulc?.vegetation_pct;
  const builtupPct = metrics.lulc?.builtup_pct;
  const barrenPct = metrics.lulc?.barren_pct;
  if (vegetationPct !== null && vegetationPct !== undefined) {
    const lowCover = vegetationPct < 30;
    push({
      category: "land_use",
      severity: vegetationPct < 15 ? "high" : lowCover ? "moderate" : "low",
      metric: "lulc.vegetation_pct",
      value: round(vegetationPct),
      threshold: lowCover ? "< 30%" : ">= 30%",
      status: lowCover ? "low_vegetation_cover" : "vegetation_cover_present",
      finding: lowCover ? "LULC_INDICATES_LOW_VEGETATION_COVER" : "LULC_INDICATES_VEGETATION_COVER_PRESENT",
      recommendation: lowCover ? "REVIEW_RESTORATION_PLANTING_AND_PROTECTION_ZONES" : "MAINTAIN_LAND_COVER_MONITORING",
      confidence: 80,
    });
  }
  if ((builtupPct ?? 0) > 15 || (barrenPct ?? 0) > 35) {
    const dominantValue = Math.max(builtupPct ?? 0, barrenPct ?? 0);
    push({
      category: "land_use",
      severity: dominantValue > 50 ? "high" : "moderate",
      metric: "lulc.builtup_pct/lulc.barren_pct",
      value: round(dominantValue),
      threshold: "builtup > 15% OR barren > 35%",
      status: "land_use_pressure",
      finding: "LULC_INDICATES_LAND_USE_OR_EXPOSED_SURFACE_PRESSURE",
      recommendation: "VERIFY_LAND_USE_CHANGE_AND_PRIORITIZE_PROTECTION_MEASURES",
      confidence: 78,
    });
  }

  if (metrics.historical) {
    const declining = metrics.historical.trend_direction === "declining";
    push({
      category: "historical_change",
      severity: declining
        ? severityFromScore(clamp(55 + metrics.historical.trend_strength * 2000))
        : metrics.historical.trend_direction === "improving" ? "low" : "moderate",
      metric: "historical.trend_direction",
      value: metrics.historical.trend_direction,
      threshold: "declining trend",
      status: declining ? "historical_degradation" : `historical_${metrics.historical.trend_direction}`,
      finding: declining ? "HISTORICAL_NDVI_TREND_INDICATES_DECLINE" : "HISTORICAL_NDVI_TREND_DOES_NOT_INDICATE_DECLINE",
      recommendation: declining ? "ESCALATE_MONITORING_AND_REVIEW_DEGRADATION_DRIVERS" : "MAINTAIN_TREND_MONITORING",
      confidence: 84,
    });
  }

  if (metrics.hydrology) {
    const highRunoff = metrics.hydrology.runoff_risk === "high";
    push({
      category: "hydrology",
      severity: highRunoff ? "high" : metrics.hydrology.runoff_risk === "medium" ? "moderate" : "low",
      metric: "hydrology.runoff_risk",
      value: metrics.hydrology.runoff_risk,
      threshold: "high runoff risk",
      status: highRunoff ? "runoff_risk_high" : `runoff_risk_${metrics.hydrology.runoff_risk}`,
      finding: highRunoff ? "HYDROLOGY_INDICATES_HIGH_RUNOFF_RISK" : "HYDROLOGY_RUNOFF_RISK_NOT_HIGH",
      recommendation: highRunoff ? "PRIORITIZE_WATER_RETENTION_AND_DRAINAGE_INTERVENTIONS" : "CONTINUE_HYDROLOGY_MONITORING",
      confidence: 82,
    });

    const hydroStress = metrics.hydrology.hydro_stress_score;
    push({
      category: "hydrology",
      severity: severityFromScore(hydroStress),
      metric: "hydrology.hydro_stress_score",
      value: round(hydroStress),
      threshold: ">= 70 high stress",
      status: hydroStress >= 70 ? "hydro_stress_high" : hydroStress >= 40 ? "hydro_stress_moderate" : "hydro_stress_low",
      finding: hydroStress >= 70 ? "HYDROLOGICAL_STRESS_SCORE_IS_HIGH" : "HYDROLOGICAL_STRESS_SCORE_REQUIRES_ROUTINE_TRACKING",
      recommendation: hydroStress >= 70 ? "PRIORITIZE_HYDROLOGICAL_RESTORATION_MEASURES" : "TRACK_HYDROLOGICAL_STRESS_IN_NEXT_MONITORING_CYCLE",
      confidence: 82,
    });
  }

  if (metrics.restoration) {
    const lowSuitability = metrics.restoration.suitability_score < 40;
    push({
      category: "restoration",
      severity: lowSuitability ? "high" : metrics.restoration.suitability_score < 70 ? "moderate" : "low",
      metric: "restoration.suitability_score",
      value: round(metrics.restoration.suitability_score),
      threshold: lowSuitability ? "< 40" : ">= 40",
      status: lowSuitability ? "low_restoration_suitability" : `restoration_priority_${metrics.restoration.priority_level}`,
      finding: lowSuitability ? "RESTORATION_SUITABILITY_SCORE_IS_LOW" : "RESTORATION_SUITABILITY_SCORE_SUPPORTS_PRIORITIZATION",
      recommendation: lowSuitability ? "REVIEW_CONSTRAINTS_BEFORE_ACTIVE_RESTORATION" : "USE_PRIORITY_LEVEL_FOR_RESTORATION_PLANNING",
      confidence: 80,
    });
  }

  if (metrics.risk) {
    const riskScore = metrics.risk.overall_risk_score;
    push({
      category: "risk",
      severity: severityFromScore(riskScore),
      metric: "risk.overall_risk_score",
      value: round(riskScore),
      threshold: ">= 70 high risk",
      status: riskScore >= 70 ? "high_ecological_risk" : riskScore >= 40 ? "moderate_ecological_risk" : "low_ecological_risk",
      finding: riskScore >= 70 ? "OVERALL_ECOLOGICAL_RISK_IS_HIGH" : "OVERALL_ECOLOGICAL_RISK_IS_NOT_HIGH",
      recommendation: riskScore >= 70 ? "PRIORITIZE_INTERVENTION_AND_INTENSIVE_MONITORING" : "FOLLOW_ASSIGNED_MONITORING_PRIORITY",
      confidence: round(metrics.risk.confidence_score) ?? 75,
    });

    if (metrics.risk.intervention_urgency === "urgent") {
      push({
        category: "risk",
        severity: "critical",
        metric: "risk.intervention_urgency",
        value: metrics.risk.intervention_urgency,
        threshold: "urgent",
        status: "urgent_intervention_required",
        finding: "RISK_ENGINE_CLASSIFIES_INTERVENTION_AS_URGENT",
        recommendation: "ESCALATE_FOR_RESTORATION_INTERVENTION_REVIEW",
        confidence: round(metrics.risk.confidence_score) ?? 75,
      });
    }
  }

  return {
    schema_version: "1.0",
    methodology_version: "observation-rules-v1.0",
    run_id: metrics.run_id,
    project_id: metrics.project_id,
    generated_at: new Date().toISOString(),
    observations,
  };
}

export async function buildAndSaveObservations(projectId: string, runId: string): Promise<{ observationsPath: string; observations: ObservationsJson }> {
  const evidenceDir = getEvidenceRunDir(projectId, runId);
  const metrics = await readJsonFile<MetricsJson>(evidenceDir, "metrics.json");
  if (!metrics) throw new Error("metrics.json not found for observation generation");
  const observations = generateObservationsFromMetrics(metrics);
  const observationsPath = await writeJsonFile(evidenceDir, "observations.json", observations);
  return { observationsPath, observations };
}

export async function ensureObservationsArtifact(projectId: string, runId: string): Promise<{ observationsPath: string; observations: ObservationsJson }> {
  const evidenceDir = getEvidenceRunDir(projectId, runId);
  const result = await buildAndSaveObservations(projectId, runId);
  const manifest = await readJsonFile<EvidenceManifest>(evidenceDir, "evidence-manifest.json");
  if (!manifest) return result;

  const observationAsset = {
    filename: "observations.json",
    path: result.observationsPath,
    size_bytes: await fileSize(result.observationsPath),
    checksum_sha256: await fileChecksum(result.observationsPath),
    generated_at: new Date().toISOString(),
  };
  const workflows: WorkflowRecord[] = manifest.workflows.some((workflow) => workflow.workflow_id === "observation-engine")
    ? manifest.workflows.map((workflow) => workflow.workflow_id === "observation-engine"
        ? { ...workflow, status: "complete", outputs: ["observations.json"] }
        : workflow)
    : [
        ...manifest.workflows,
        {
          workflow_id: "observation-engine",
          name: "Deterministic Evidence Observation Engine",
          status: "complete",
          duration_ms: 0,
          outputs: ["observations.json"],
        },
      ];

  await writeJsonFile(evidenceDir, "evidence-manifest.json", {
    ...manifest,
    workflows,
    assets: [
      ...manifest.assets.filter((asset) => asset.filename !== "observations.json"),
      observationAsset,
    ],
  });
  return result;
}

export const observationEngine = {
  generateObservationsFromMetrics,
  buildAndSaveObservations,
  ensureObservationsArtifact,
};
