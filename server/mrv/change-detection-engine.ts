/**
 * change-detection-engine.ts
 *
 * Implements:
 *  - Observation delta calculations (absolute + relative change per indicator)
 *  - Multi-cycle comparison (trend across all monitoring snapshots)
 *  - Degradation/recovery classification
 *  - Ecosystem Health Index (EHI) computation
 *
 * This module is pure computation — no DB/route dependencies.
 * It operates on pre-fetched observation data passed by the orchestrator.
 */

import type {
  MonitoringSnapshot,
  BaselineSnapshot,
  ObservationDelta,
  MultiCycleComparison,
  ObservationTypeExtended,
} from "./types";

export type TrendDirection = "improving" | "declining" | "stable";

// ─── Linear trend regression ──────────────────────────────────────────────────

interface TrendResult {
  slope: number;
  direction: TrendDirection;
  rSquared: number;
}

/**
 * Compute OLS linear trend for a numeric series (index = time proxy).
 */
export function computeLinearTrend(values: (number | null)[]): TrendResult {
  const valid = values
    .map((v, i) => ({ x: i, y: v }))
    .filter((p): p is { x: number; y: number } => p.y !== null);

  if (valid.length < 2) {
    return { slope: 0, direction: "stable", rSquared: 0 };
  }

  const n = valid.length;
  const sx = valid.reduce((a, p) => a + p.x, 0);
  const sy = valid.reduce((a, p) => a + p.y, 0);
  const sxy = valid.reduce((a, p) => a + p.x * p.y, 0);
  const sx2 = valid.reduce((a, p) => a + p.x * p.x, 0);

  const denom = n * sx2 - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;

  // R² computation
  const yMean = sy / n;
  const ssTot = valid.reduce((a, p) => a + (p.y - yMean) ** 2, 0);
  const ssRes = valid.reduce((a, p) => a + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Threshold: significant only if slope exceeds 0.002/obs for NDVI-scale indices
  const direction: TrendDirection =
    slope > 0.002 ? "improving" : slope < -0.002 ? "declining" : "stable";

  return {
    slope: parseFloat(slope.toFixed(6)),
    direction,
    rSquared: parseFloat(rSquared.toFixed(4)),
  };
}

// ─── Observation delta calculation ────────────────────────────────────────────

/**
 * Compute change metrics between a baseline and current observation value.
 */
export function computeObservationDelta(params: {
  observationType: ObservationTypeExtended;
  baselineValue: number | null;
  currentValue: number | null;
  baselineDate: string;
  currentDate: string;
}): ObservationDelta {
  const { observationType, baselineValue, currentValue, baselineDate, currentDate } = params;

  if (baselineValue === null || currentValue === null) {
    return {
      observationType,
      baselineValue,
      currentValue,
      absoluteChange: null,
      relativeChangePct: null,
      baselineDate,
      currentDate,
      direction: "insufficient_data",
    };
  }

  const absoluteChange = parseFloat((currentValue - baselineValue).toFixed(6));
  const relativeChangePct =
    baselineValue !== 0
      ? parseFloat(((absoluteChange / Math.abs(baselineValue)) * 100).toFixed(2))
      : null;

  // Direction: use 1% threshold for relative change to filter noise
  let direction: TrendDirection | "insufficient_data";
  if (relativeChangePct === null) {
    direction = absoluteChange > 0.002 ? "improving" : absoluteChange < -0.002 ? "declining" : "stable";
  } else {
    direction = relativeChangePct > 1.0 ? "improving" : relativeChangePct < -1.0 ? "declining" : "stable";
  }

  return {
    observationType,
    baselineValue,
    currentValue,
    absoluteChange,
    relativeChangePct,
    baselineDate,
    currentDate,
    direction,
  };
}

/**
 * Compute deltas for all shared indicators between a baseline snapshot and current observations.
 */
export function computeAllDeltas(
  baseline: BaselineSnapshot,
  currentNdvi: number | null,
  currentNdwi: number | null,
  currentNdmi: number | null,
  currentEvi: number | null,
  currentDate: string
): ObservationDelta[] {
  const deltas: ObservationDelta[] = [];

  const indicatorPairs: Array<{
    type: ObservationTypeExtended;
    baselineVal: number | null;
    currentVal: number | null;
  }> = [
    { type: "ndvi", baselineVal: baseline.ndviMean, currentVal: currentNdvi },
    { type: "ndwi", baselineVal: baseline.ndwiMean, currentVal: currentNdwi },
    { type: "ndmi", baselineVal: baseline.ndmiMean, currentVal: currentNdmi },
    { type: "evi",  baselineVal: baseline.eviMean,  currentVal: currentEvi  },
  ];

  for (const pair of indicatorPairs) {
    deltas.push(computeObservationDelta({
      observationType: pair.type,
      baselineValue: pair.baselineVal,
      currentValue: pair.currentVal,
      baselineDate: baseline.observedAt,
      currentDate,
    }));
  }

  return deltas;
}

// ─── Multi-cycle comparison ───────────────────────────────────────────────────

/**
 * Build multi-cycle comparison for a single indicator across all historical snapshots.
 */
export function buildMultiCycleComparison(
  indicator: ObservationTypeExtended,
  snapshots: MonitoringSnapshot[],
  getValue: (s: MonitoringSnapshot) => number | null
): MultiCycleComparison {
  const cycles = snapshots.map((s) => ({
    cycleId: s.cycleId,
    observedAt: s.observedAt,
    value: getValue(s),
  }));

  const validCycles = cycles.filter((c) => c.value !== null);
  const values = cycles.map((c) => c.value);
  const trend = computeLinearTrend(values);

  const peakCycle = validCycles.reduce<typeof validCycles[number] | null>(
    (best, c) => (best === null || (c.value ?? -Infinity) > (best.value ?? -Infinity) ? c : best),
    null
  );
  const troughCycle = validCycles.reduce<typeof validCycles[number] | null>(
    (worst, c) => (worst === null || (c.value ?? Infinity) < (worst.value ?? Infinity) ? c : worst),
    null
  );

  return {
    indicator,
    cycles,
    trend,
    peakCycle: peakCycle?.cycleId ?? null,
    peakValue: peakCycle?.value ?? null,
    troughCycle: troughCycle?.cycleId ?? null,
    troughValue: troughCycle?.value ?? null,
  };
}

/**
 * Build multi-cycle comparison for the main NDVI, NDMI, and NDWI indicators.
 */
export function buildAllMultiCycleComparisons(
  snapshots: MonitoringSnapshot[]
): MultiCycleComparison[] {
  if (snapshots.length < 2) return [];

  return [
    buildMultiCycleComparison("ndvi", snapshots, (s) => s.ndviMean),
    buildMultiCycleComparison("ndmi", snapshots, (s) => s.ndmiMean),
    buildMultiCycleComparison("ndwi", snapshots, (s) => s.ndwiMean),
    buildMultiCycleComparison("evi",  snapshots, (s) => s.eviMean),
  ];
}

// ─── Degradation classification ───────────────────────────────────────────────

export type DegradationClass = "SEVERE" | "MODERATE" | "MILD" | "STABLE" | "RECOVERING";

export function classifyDegradation(totalChangePct: number): DegradationClass {
  if (totalChangePct < -30) return "SEVERE";
  if (totalChangePct < -15) return "MODERATE";
  if (totalChangePct < -5)  return "MILD";
  if (totalChangePct > 5)   return "RECOVERING";
  return "STABLE";
}

// ─── Recovery trajectory ──────────────────────────────────────────────────────

export type RecoveryTrajectory =
  | "STRONG_RECOVERY"
  | "MODERATE_RECOVERY"
  | "STABLE"
  | "MODERATE_DECLINE"
  | "SIGNIFICANT_DECLINE";

export function classifyRecoveryTrajectory(ndviChange: number): RecoveryTrajectory {
  if (ndviChange > 0.10) return "STRONG_RECOVERY";
  if (ndviChange > 0.03) return "MODERATE_RECOVERY";
  if (ndviChange > -0.03) return "STABLE";
  if (ndviChange > -0.10) return "MODERATE_DECLINE";
  return "SIGNIFICANT_DECLINE";
}

// ─── Ecosystem Health Index ───────────────────────────────────────────────────

export interface EcosystemHealthResult {
  ecosystemHealthIndex: number;     // 0–100
  overallTrajectory: TrendDirection;
  ndviTrend: TrendResult;
  ndmiTrend: TrendResult;
  bareTrend: TrendResult;
  snapshotsAnalyzed: number;
  confidence: number;
  interpretation: string;
}

/**
 * Compute the Ecosystem Health Index (EHI) from historical monitoring snapshots.
 *
 * EHI components (weights from architecture doc section 6.12):
 *  - NDVI score        → 30% weight
 *  - NDMI score        → 20% weight
 *  - Green cover score → 25% weight
 *  - Bare soil penalty → 25% weight
 *  - Center offset     → +25 (to avoid negative results)
 */
export function computeEcosystemHealthIndex(
  snapshots: MonitoringSnapshot[]
): EcosystemHealthResult {
  if (snapshots.length === 0) {
    return {
      ecosystemHealthIndex: 0,
      overallTrajectory: "stable",
      ndviTrend: { slope: 0, direction: "stable", rSquared: 0 },
      ndmiTrend: { slope: 0, direction: "stable", rSquared: 0 },
      bareTrend: { slope: 0, direction: "stable", rSquared: 0 },
      snapshotsAnalyzed: 0,
      confidence: 0,
      interpretation: "No monitoring history available.",
    };
  }

  const latest = snapshots[snapshots.length - 1];

  // Component scores
  const ndviScore  = Math.max(0, Math.min(100, ((latest.ndviMean ?? 0) + 0.2) / 1.0 * 100)) * 0.30;
  const ndmiScore  = Math.max(0, Math.min(100, ((latest.ndmiMean ?? 0) + 0.5) / 1.0 * 100)) * 0.20;
  const greenScore = Math.min(100, latest.greenCoverPercent ?? 0) * 0.25;
  const barePenalty = Math.max(0, latest.bareLandPercent ?? 0) * 0.25;

  const ehi = Math.max(0, Math.min(100, ndviScore + ndmiScore + greenScore - barePenalty + 25));

  // Trends
  const ndviTrend = computeLinearTrend(snapshots.map((s) => s.ndviMean));
  const ndmiTrend = computeLinearTrend(snapshots.map((s) => s.ndmiMean));
  const bareTrend = computeLinearTrend(snapshots.map((s) => s.bareLandPercent));

  const improvingCount = [ndviTrend, ndmiTrend].filter((t) => t.direction === "improving").length;
  const decliningCount = [ndviTrend, ndmiTrend, bareTrend].filter((t) => t.direction === "declining").length;

  const overallTrajectory: TrendDirection =
    improvingCount >= 2 ? "improving" : decliningCount >= 2 ? "declining" : "stable";

  const confidence = Math.min(0.5 + snapshots.length * 0.05, 0.95);

  const interpretation =
    `Ecosystem Health Index: ${ehi.toFixed(1)}/100. ` +
    `Overall trajectory: ${overallTrajectory.toUpperCase()}. ` +
    `Vegetation trend: ${ndviTrend.direction.toUpperCase()} ` +
    `(${ndviTrend.slope > 0 ? "+" : ""}${(ndviTrend.slope * 30).toFixed(4)}/month). ` +
    `Moisture trend: ${ndmiTrend.direction.toUpperCase()}. ` +
    `Based on ${snapshots.length} monitoring snapshot${snapshots.length !== 1 ? "s" : ""}.`;

  return {
    ecosystemHealthIndex: parseFloat(ehi.toFixed(1)),
    overallTrajectory,
    ndviTrend,
    ndmiTrend,
    bareTrend,
    snapshotsAnalyzed: snapshots.length,
    confidence: parseFloat(confidence.toFixed(3)),
    interpretation,
  };
}

// ─── Environmental quality score ──────────────────────────────────────────────

export interface EnvironmentalQualityScore {
  /** 0–100 composite score reflecting vegetation, water, and coverage quality */
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  components: {
    vegetationScore: number;
    moistureScore: number;
    coverageScore: number;
    dataQualityScore: number;
  };
}

/**
 * Compute an environmental quality score from current observation values.
 * Suitable for report cover pages and executive summaries.
 */
export function computeEnvironmentalQualityScore(params: {
  ndviMean: number | null;
  ndmiMean: number | null;
  ndwiMean: number | null;
  greenCoverPct: number | null;
  spatialCoveragePct: number;
  confidence: number;
}): EnvironmentalQualityScore {
  // Vegetation score: NDVI > 0.5 = excellent, < 0.1 = degraded
  const ndvi = params.ndviMean ?? 0;
  const vegetationScore = Math.max(0, Math.min(100, (ndvi + 0.2) * 100));

  // Moisture score: NDMI -0.5 to 0.6 range
  const ndmi = params.ndmiMean ?? 0;
  const moistureScore = Math.max(0, Math.min(100, (ndmi + 0.5) * 100));

  // Coverage score: % of site covered by valid satellite data
  const coverageScore = Math.max(0, Math.min(100, params.greenCoverPct ?? 0));

  // Data quality score: based on coverage + confidence
  const dataQualityScore = (params.spatialCoveragePct * 0.5 + params.confidence * 100 * 0.5);

  const overall = parseFloat(
    (vegetationScore * 0.35 + moistureScore * 0.25 + coverageScore * 0.25 + dataQualityScore * 0.15).toFixed(1)
  );

  const grade: EnvironmentalQualityScore["grade"] =
    overall >= 80 ? "A" : overall >= 65 ? "B" : overall >= 50 ? "C" : overall >= 35 ? "D" : "F";

  return {
    score: overall,
    grade,
    components: {
      vegetationScore: parseFloat(vegetationScore.toFixed(1)),
      moistureScore: parseFloat(moistureScore.toFixed(1)),
      coverageScore: parseFloat(coverageScore.toFixed(1)),
      dataQualityScore: parseFloat(dataQualityScore.toFixed(1)),
    },
  };
}
