import type { GEEExecutionResult } from "../mrv/types";
import type { LSTResult } from "../gee/workflow-02-lst";
import type { LULCResult } from "../gee/workflow-06-lulc";
import type { HistoricalResult } from "../gee/workflow-05-historical";
import type { HydrologyResult } from "../gee/workflow-04-dem-hydro";
import type { RestorationResult } from "../gee/workflow-03-restoration";

export type RiskLevel = "low" | "moderate" | "high";
export type InterventionUrgency = "routine" | "elevated" | "urgent";
export type MonitoringPriority = "standard" | "increased" | "intensive";

export interface RiskEngineResult {
  overall_risk_score: number;
  vegetation_risk: number;
  moisture_risk: number;
  thermal_risk: number;
  soil_risk: number;
  hydrology_risk: number;
  trend_risk: number;
  restoration_priority: RiskLevel;
  intervention_urgency: InterventionUrgency;
  monitoring_priority: MonitoringPriority;
  confidence_score: number;
  methodology_version: string;
}

interface RiskInputs {
  geeResult: GEEExecutionResult;
  lstResult?: LSTResult;
  lulcResult?: LULCResult;
  historicalResult?: HistoricalResult;
  hydrologyResult?: HydrologyResult;
  restorationResult?: RestorationResult;
}

const METHODOLOGY_VERSION = "ecological-risk-v1.0";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return parseFloat(value.toFixed(2));
}

function observationMean(geeResult: GEEExecutionResult, type: string): number | null {
  return geeResult.observations.find((o) => o.observationType === type)?.valueMean ?? null;
}

function inverseIndexRisk(value: number | null, min: number, max: number): number {
  if (value === null) return 50;
  return round2(clamp((1 - ((value - min) / (max - min))) * 100, 0, 100));
}

function positiveIndexRisk(value: number | null, min: number, max: number): number {
  if (value === null) return 50;
  return round2(clamp(((value - min) / (max - min)) * 100, 0, 100));
}

function vegetationRisk(geeResult: GEEExecutionResult, lulcResult?: LULCResult): number {
  const ndviRisk = inverseIndexRisk(observationMean(geeResult, "ndvi"), 0.1, 0.7);
  const eviRisk = inverseIndexRisk(observationMean(geeResult, "evi"), 0.05, 0.55);
  const saviRisk = inverseIndexRisk(observationMean(geeResult, "savi"), 0.1, 0.65);
  const vegetationPct = lulcResult?.vegetation_pct ?? null;
  const lulcVegetationRisk = vegetationPct === null ? 50 : round2(clamp(100 - vegetationPct, 0, 100));
  return round2(ndviRisk * 0.4 + eviRisk * 0.25 + saviRisk * 0.2 + lulcVegetationRisk * 0.15);
}

function moistureRisk(geeResult: GEEExecutionResult, lulcResult?: LULCResult): number {
  const ndmiRisk = inverseIndexRisk(observationMean(geeResult, "ndmi"), -0.2, 0.45);
  const waterPct = lulcResult?.water_pct ?? null;
  const waterRisk = waterPct === null ? 50 : round2(clamp(80 - waterPct * 2, 0, 100));
  return round2(ndmiRisk * 0.75 + waterRisk * 0.25);
}

function thermalRisk(lstResult?: LSTResult): number {
  return positiveIndexRisk(lstResult?.lst_mean ?? null, 25, 45);
}

function soilRisk(geeResult: GEEExecutionResult, lulcResult?: LULCResult): number {
  const bsiRisk = positiveIndexRisk(observationMean(geeResult, "bsi"), -0.2, 0.45);
  const barrenPct = lulcResult?.barren_pct ?? null;
  const barrenRisk = barrenPct === null ? 50 : round2(clamp(barrenPct * 2, 0, 100));
  return round2(bsiRisk * 0.7 + barrenRisk * 0.3);
}

function hydrologyRisk(hydrologyResult?: HydrologyResult): number {
  if (!hydrologyResult) return 50;
  return round2(clamp(hydrologyResult.hydro_stress_score, 0, 100));
}

function trendRisk(historicalResult?: HistoricalResult): number {
  if (!historicalResult) return 50;
  if (historicalResult.trend_direction === "declining") {
    return round2(clamp(55 + historicalResult.trend_strength * 2000, 55, 100));
  }
  if (historicalResult.trend_direction === "improving") {
    return round2(clamp(45 - historicalResult.trend_strength * 1500, 0, 45));
  }
  return 45;
}

function classifyRisk(score: number): RiskLevel {
  if (score >= 70) return "high";
  if (score >= 40) return "moderate";
  return "low";
}

function classifyUrgency(score: number): InterventionUrgency {
  if (score >= 70) return "urgent";
  if (score >= 40) return "elevated";
  return "routine";
}

function classifyMonitoring(score: number, trend: number): MonitoringPriority {
  if (score >= 70 || trend >= 70) return "intensive";
  if (score >= 40 || trend >= 55) return "increased";
  return "standard";
}

function confidenceScore(inputs: RiskInputs): number {
  const components = [
    inputs.geeResult.observations.some((o) => o.observationType === "ndvi"),
    inputs.geeResult.observations.some((o) => o.observationType === "evi"),
    inputs.geeResult.observations.some((o) => o.observationType === "savi"),
    inputs.geeResult.observations.some((o) => o.observationType === "ndmi"),
    inputs.geeResult.observations.some((o) => o.observationType === "bsi"),
    Boolean(inputs.lstResult),
    Boolean(inputs.lulcResult),
    Boolean(inputs.historicalResult),
    Boolean(inputs.hydrologyResult),
    Boolean(inputs.restorationResult),
  ];
  const dataCompleteness = components.filter(Boolean).length / components.length;
  const fallbackPenalty = [
    inputs.geeResult.hooks.fallbackUsed,
    inputs.lstResult?.fallback_used,
    inputs.lulcResult?.fallback_used,
    inputs.historicalResult?.fallback_used,
    inputs.hydrologyResult?.fallback_used,
    inputs.restorationResult?.fallback_used,
  ].filter(Boolean).length * 5;
  return round2(clamp(dataCompleteness * 100 - fallbackPenalty, 0, 100));
}

export function runRiskEngine(inputs: RiskInputs): RiskEngineResult {
  const vegetation = vegetationRisk(inputs.geeResult, inputs.lulcResult);
  const moisture = moistureRisk(inputs.geeResult, inputs.lulcResult);
  const thermal = thermalRisk(inputs.lstResult);
  const soil = soilRisk(inputs.geeResult, inputs.lulcResult);
  const hydrology = hydrologyRisk(inputs.hydrologyResult);
  const trend = trendRisk(inputs.historicalResult);
  const restorationSuitability = inputs.restorationResult?.suitability_score ?? null;
  const restorationRisk = restorationSuitability === null ? 50 : clamp(100 - restorationSuitability, 0, 100);

  const overall = round2(
    vegetation * 0.22 +
    moisture * 0.16 +
    thermal * 0.14 +
    soil * 0.16 +
    hydrology * 0.14 +
    trend * 0.12 +
    restorationRisk * 0.06,
  );

  return {
    overall_risk_score: overall,
    vegetation_risk: vegetation,
    moisture_risk: moisture,
    thermal_risk: thermal,
    soil_risk: soil,
    hydrology_risk: hydrology,
    trend_risk: trend,
    restoration_priority: classifyRisk(restorationRisk),
    intervention_urgency: classifyUrgency(overall),
    monitoring_priority: classifyMonitoring(overall, trend),
    confidence_score: confidenceScore(inputs),
    methodology_version: METHODOLOGY_VERSION,
  };
}
