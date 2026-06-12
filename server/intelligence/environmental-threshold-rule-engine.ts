/**
 * environmental-threshold-rule-engine.ts
 *
 * Configurable ecological rule engine used by intelligence services.
 * Purpose:
 *  - avoid fixed assumptions in anomaly/risk scoring modules
 *  - provide production-safe default thresholds with optional runtime overrides
 */

export interface EnvironmentalThresholdConfig {
  suddenVegetationLossPct: number;
  abnormalNdviDeltaPct: number;
  floodNdwiIncrease: number;
  stressNdmiDrop: number;
  severeTrendSlopePerCycle: number;
  moderateTrendSlopePerCycle: number;
  anomalyConfidencePenalty: number;
}

export interface SeasonalWindow {
  key: "q1" | "q2" | "q3" | "q4";
  months: number[];
}

const DEFAULT_CONFIG: EnvironmentalThresholdConfig = {
  suddenVegetationLossPct: 18,
  abnormalNdviDeltaPct: 22,
  floodNdwiIncrease: 0.12,
  stressNdmiDrop: 0.1,
  severeTrendSlopePerCycle: -0.02,
  moderateTrendSlopePerCycle: -0.01,
  anomalyConfidencePenalty: 0.08,
};

const SEASON_WINDOWS: SeasonalWindow[] = [
  { key: "q1", months: [1, 2, 3] },
  { key: "q2", months: [4, 5, 6] },
  { key: "q3", months: [7, 8, 9] },
  { key: "q4", months: [10, 11, 12] },
];

function parseFloatEnv(name: string): number | null {
  const v = process.env[name];
  if (!v) return null;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : null;
}

export class EnvironmentalThresholdRuleEngine {
  constructor(private readonly overrideConfig: Partial<EnvironmentalThresholdConfig> = {}) {}

  getConfig(): EnvironmentalThresholdConfig {
    return {
      suddenVegetationLossPct:
        this.overrideConfig.suddenVegetationLossPct ??
        parseFloatEnv("INTEL_SUDDEN_VEG_LOSS_PCT") ??
        DEFAULT_CONFIG.suddenVegetationLossPct,
      abnormalNdviDeltaPct:
        this.overrideConfig.abnormalNdviDeltaPct ??
        parseFloatEnv("INTEL_ABNORMAL_NDVI_DELTA_PCT") ??
        DEFAULT_CONFIG.abnormalNdviDeltaPct,
      floodNdwiIncrease:
        this.overrideConfig.floodNdwiIncrease ??
        parseFloatEnv("INTEL_FLOOD_NDWI_INCREASE") ??
        DEFAULT_CONFIG.floodNdwiIncrease,
      stressNdmiDrop:
        this.overrideConfig.stressNdmiDrop ??
        parseFloatEnv("INTEL_STRESS_NDMI_DROP") ??
        DEFAULT_CONFIG.stressNdmiDrop,
      severeTrendSlopePerCycle:
        this.overrideConfig.severeTrendSlopePerCycle ??
        parseFloatEnv("INTEL_SEVERE_TREND_SLOPE") ??
        DEFAULT_CONFIG.severeTrendSlopePerCycle,
      moderateTrendSlopePerCycle:
        this.overrideConfig.moderateTrendSlopePerCycle ??
        parseFloatEnv("INTEL_MODERATE_TREND_SLOPE") ??
        DEFAULT_CONFIG.moderateTrendSlopePerCycle,
      anomalyConfidencePenalty:
        this.overrideConfig.anomalyConfidencePenalty ??
        parseFloatEnv("INTEL_ANOMALY_CONFIDENCE_PENALTY") ??
        DEFAULT_CONFIG.anomalyConfidencePenalty,
    };
  }

  getSeasonWindows(): SeasonalWindow[] {
    return SEASON_WINDOWS;
  }

  classifyLongTermTrajectory(slopePerCycle: number):
    | "STRONG_RECOVERY"
    | "MODERATE_RECOVERY"
    | "STABLE"
    | "MODERATE_DEGRADATION"
    | "SEVERE_DEGRADATION" {
    const cfg = this.getConfig();
    if (slopePerCycle >= Math.abs(cfg.moderateTrendSlopePerCycle)) return "STRONG_RECOVERY";
    if (slopePerCycle > 0.003) return "MODERATE_RECOVERY";
    if (slopePerCycle <= cfg.severeTrendSlopePerCycle) return "SEVERE_DEGRADATION";
    if (slopePerCycle <= cfg.moderateTrendSlopePerCycle) return "MODERATE_DEGRADATION";
    return "STABLE";
  }
}

export const environmentalThresholdRuleEngine = new EnvironmentalThresholdRuleEngine();
