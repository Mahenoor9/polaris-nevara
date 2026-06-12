import { sql } from "drizzle-orm";
import { historicalObservationQueryService } from "./historical-observation-query";
import { historicalAnalysisService } from "./historical-analysis-service";
import { environmentalThresholdRuleEngine } from "./environmental-threshold-rule-engine";
import { computeLinearTrend } from "../mrv/change-detection-engine";
import { ecologicalCalibrationService } from "./ecological-calibration-service";
import { fieldValidationFoundationService } from "./field-validation-foundation-service";

type AlertSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface TrendAnomalyMarker {
  date: string;
  indicator: string;
  markerType: "SUDDEN_VEGETATION_LOSS" | "ABNORMAL_NDVI_DELTA" | "FLOOD_SIGNAL" | "MOISTURE_STRESS";
  severity: AlertSeverity;
  value: number;
  baseline?: number | null;
  deltaPct?: number | null;
  explanation: string;
}

export interface RestorationRiskFoundation {
  score: number;
  level: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  factors: Array<{ key: string; weight: number; value: number; impact: number }>;
  confidenceAdjustedScore: number;
}

export interface SeasonalPatternComparison {
  season: "q1" | "q2" | "q3" | "q4";
  ndviMean: number | null;
  ndmiMean: number | null;
  ndwiMean: number | null;
  sampleCount: number;
}

export interface MonitoringAlert {
  type: string;
  severity: AlertSeverity;
  title: string;
  description: string;
  observedAt: string;
  metadata: Record<string, unknown>;
}

export interface AutomatedInsight {
  insightType: "RISK" | "RECOVERY" | "SEASONAL" | "QUALITY";
  title: string;
  detail: string;
  recommendation: string;
  confidence: number;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function levelFromScore(score: number): RestorationRiskFoundation["level"] {
  if (score >= 75) return "CRITICAL";
  if (score >= 55) return "HIGH";
  if (score >= 30) return "MODERATE";
  return "LOW";
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export class AnomalyDetectionFoundationService {
  private async persistTimelineEvents(projectId: string, alerts: MonitoringAlert[]): Promise<void> {
    if (!(process.env.USE_DATABASE === "true" && process.env.DATABASE_URL)) return;
    if (alerts.length === 0) return;

    const { db } = await import("../db");
    for (const alert of alerts) {
      await db.execute(sql`
        INSERT INTO eco_monitoring.project_timeline_events
          (project_id, event_type, title, description, payload)
        VALUES
          (
            ${projectId},
            'ANOMALY_ALERT',
            ${alert.title},
            ${alert.description},
            ${JSON.stringify({ severity: alert.severity, type: alert.type, ...alert.metadata })}::jsonb
          )
      `);
    }
  }

  async detectTrendAnomalyMarkers(projectId: string): Promise<TrendAnomalyMarker[]> {
    const cfg = environmentalThresholdRuleEngine.getConfig();
    const calibration = await ecologicalCalibrationService.getEffectiveCalibration(projectId);
    const seasonalMultiplier = calibration.profile.seasonalTuning.sensitivityMultiplier ?? 1;

    const suddenLossThreshold = (calibration.profile.thresholdOverrides.suddenVegetationLossPct ?? cfg.suddenVegetationLossPct) * seasonalMultiplier;
    const abnormalNdviThreshold = (calibration.profile.thresholdOverrides.abnormalNdviDeltaPct ?? cfg.abnormalNdviDeltaPct) * seasonalMultiplier;
    const floodThreshold = (calibration.profile.thresholdOverrides.floodNdwiIncrease ?? cfg.floodNdwiIncrease) * seasonalMultiplier;
    const stressThreshold = (calibration.profile.thresholdOverrides.stressNdmiDrop ?? cfg.stressNdmiDrop) * seasonalMultiplier;
    const ndviRows = await historicalObservationQueryService.listByProject(projectId, "ndvi", 400);
    const ndmiRows = await historicalObservationQueryService.listByProject(projectId, "ndmi", 400);
    const ndwiRows = await historicalObservationQueryService.listByProject(projectId, "ndwi", 400);

    const markers: TrendAnomalyMarker[] = [];

    for (let i = 1; i < ndviRows.length; i++) {
      const prev = ndviRows[i - 1].valueMean;
      const curr = ndviRows[i].valueMean;
      if (prev === null || curr === null || prev === 0) continue;
      const deltaPct = ((curr - prev) / Math.abs(prev)) * 100;

      if (deltaPct <= -suddenLossThreshold) {
        markers.push({
          date: ndviRows[i].observedAt,
          indicator: "ndvi",
          markerType: "SUDDEN_VEGETATION_LOSS",
          severity: deltaPct <= -(suddenLossThreshold * 1.5) ? "HIGH" : "MEDIUM",
          value: curr,
          baseline: prev,
          deltaPct: Number(deltaPct.toFixed(2)),
          explanation: `NDVI dropped ${Math.abs(deltaPct).toFixed(1)}% between consecutive cycles.`,
        });
      }
    }

    if (ndviRows.length >= 2) {
      const baseline = ndviRows[0].valueMean;
      const latest = ndviRows[ndviRows.length - 1].valueMean;
      if (baseline !== null && latest !== null && baseline !== 0) {
        const deltaPct = ((latest - baseline) / Math.abs(baseline)) * 100;
        if (Math.abs(deltaPct) >= abnormalNdviThreshold) {
          markers.push({
            date: ndviRows[ndviRows.length - 1].observedAt,
            indicator: "ndvi",
            markerType: "ABNORMAL_NDVI_DELTA",
            severity: Math.abs(deltaPct) >= abnormalNdviThreshold * 1.5 ? "HIGH" : "MEDIUM",
            value: latest,
            baseline,
            deltaPct: Number(deltaPct.toFixed(2)),
            explanation: `NDVI shifted ${deltaPct.toFixed(1)}% from baseline threshold expectations.`,
          });
        }
      }
    }

    if (ndwiRows.length >= 2) {
      const prev = ndwiRows[ndwiRows.length - 2].valueMean;
      const latest = ndwiRows[ndwiRows.length - 1].valueMean;
      if (prev !== null && latest !== null) {
        const inc = latest - prev;
        if (inc >= floodThreshold) {
          markers.push({
            date: ndwiRows[ndwiRows.length - 1].observedAt,
            indicator: "ndwi",
            markerType: "FLOOD_SIGNAL",
            severity: inc >= floodThreshold * 1.5 ? "HIGH" : "MEDIUM",
            value: latest,
            baseline: prev,
            explanation: `NDWI increased by ${inc.toFixed(3)}, suggesting flood/water expansion signal.`,
          });
        }
      }
    }

    if (ndmiRows.length >= 2) {
      const prev = ndmiRows[ndmiRows.length - 2].valueMean;
      const latest = ndmiRows[ndmiRows.length - 1].valueMean;
      if (prev !== null && latest !== null) {
        const drop = prev - latest;
        if (drop >= stressThreshold) {
          markers.push({
            date: ndmiRows[ndmiRows.length - 1].observedAt,
            indicator: "ndmi",
            markerType: "MOISTURE_STRESS",
            severity: drop >= stressThreshold * 1.5 ? "HIGH" : "MEDIUM",
            value: latest,
            baseline: prev,
            explanation: `NDMI decreased by ${drop.toFixed(3)}, indicating moisture stress risk.`,
          });
        }
      }
    }

    // False-positive reduction: dampen severity if seasonal coverage is insufficient.
    const seasonal = await this.compareSeasonalPatterns(projectId);
    const coveredSeasons = seasonal.filter((s) => s.sampleCount > 0).length;
    const minCoverage = calibration.profile.seasonalTuning.minSeasonalCoverage ?? 2;
    const reduced = coveredSeasons < minCoverage
      ? markers.map((m) => ({
          ...m,
          severity: (m.severity === "HIGH" ? "MEDIUM" : m.severity === "MEDIUM" ? "LOW" : m.severity) as AlertSeverity,
          explanation: `${m.explanation} Severity reduced due to limited seasonal coverage (${coveredSeasons}/${minCoverage}).`,
        }))
      : markers;

    return reduced.sort((a, b) => a.date.localeCompare(b.date));
  }

  async computeRestorationRiskScore(projectId: string): Promise<RestorationRiskFoundation> {
    const markers = await this.detectTrendAnomalyMarkers(projectId);
    const snapshots = await historicalAnalysisService.getHistoricalSnapshots(projectId, 60);

    const ndviTrend = computeLinearTrend(snapshots.map((s) => s.ndviMean));
    const ndmiTrend = computeLinearTrend(snapshots.map((s) => s.ndmiMean));
    const cfg = environmentalThresholdRuleEngine.getConfig();
    const calibration = await ecologicalCalibrationService.getEffectiveCalibration(projectId);

    const anomalyLoad = Math.min(1, markers.length / 6);
    const trendRisk = ndviTrend.slope < 0 ? Math.min(1, Math.abs(ndviTrend.slope) / Math.abs(cfg.moderateTrendSlopePerCycle)) : 0;
    const moistureTrendRisk = ndmiTrend.slope < 0 ? Math.min(1, Math.abs(ndmiTrend.slope) / 0.02) : 0;
    const wAnomaly = calibration.profile.anomalyWeights.anomalyLoad ?? 0.45;
    const wNdvi = calibration.profile.anomalyWeights.ndviDeclineTrend ?? 0.35;
    const wMoist = calibration.profile.anomalyWeights.moistureDeclineTrend ?? 0.20;
    const totalWeight = wAnomaly + wNdvi + wMoist || 1;

    const factors = [
      { key: "anomaly_load", weight: wAnomaly / totalWeight, value: anomalyLoad, impact: anomalyLoad * ((wAnomaly / totalWeight) * 100) },
      { key: "ndvi_decline_trend", weight: wNdvi / totalWeight, value: trendRisk, impact: trendRisk * ((wNdvi / totalWeight) * 100) },
      { key: "moisture_decline_trend", weight: wMoist / totalWeight, value: moistureTrendRisk, impact: moistureTrendRisk * ((wMoist / totalWeight) * 100) },
    ];

    const score = factors.reduce((acc, f) => acc + f.impact, 0);
    const penaltyMultiplier = calibration.profile.confidenceTuning.anomalyPenaltyMultiplier ?? 1;
    const fieldBoost = calibration.profile.confidenceTuning.fieldEvidenceBoost ?? 0;
    const fieldComparisons = await fieldValidationFoundationService.getFieldVsSatelliteComparison(projectId, "ndvi");
    const hasFieldEvidence = fieldComparisons.evidenceCount > 0;
    const markerConfidence = 1 - Math.min(0.35, markers.length * cfg.anomalyConfidencePenalty * penaltyMultiplier);
    const confidenceAdjustedScore = Math.max(
      0,
      Math.min(100, score * markerConfidence + (hasFieldEvidence ? fieldBoost * 100 : 0))
    );

    return {
      score: Number(score.toFixed(1)),
      level: levelFromScore(score),
      factors: factors.map((f) => ({ ...f, value: Number(f.value.toFixed(3)), impact: Number(f.impact.toFixed(2)) })),
      confidenceAdjustedScore: Number(confidenceAdjustedScore.toFixed(1)),
    };
  }

  async classifyLongTermTrajectory(projectId: string) {
    const snapshots = await historicalAnalysisService.getHistoricalSnapshots(projectId, 80);
    const trend = computeLinearTrend(snapshots.map((s) => s.ndviMean));
    return {
      slopePerCycle: trend.slope,
      direction: trend.direction,
      rSquared: trend.rSquared,
      trajectory: environmentalThresholdRuleEngine.classifyLongTermTrajectory(trend.slope),
      snapshotsAnalyzed: snapshots.length,
    };
  }

  async compareSeasonalPatterns(projectId: string): Promise<SeasonalPatternComparison[]> {
    const ndvi = await historicalObservationQueryService.listByProject(projectId, "ndvi", 1200);
    const ndmi = await historicalObservationQueryService.listByProject(projectId, "ndmi", 1200);
    const ndwi = await historicalObservationQueryService.listByProject(projectId, "ndwi", 1200);

    const seasons = environmentalThresholdRuleEngine.getSeasonWindows();
    return seasons.map((season) => {
      const extractValues = (rows: Array<{ observedAt: string; valueMean: number | null }>) =>
        rows
          .filter((row) => season.months.includes(new Date(row.observedAt).getUTCMonth() + 1))
          .map((row) => row.valueMean)
          .filter((v): v is number => typeof v === "number");

      const ndviVals = extractValues(ndvi);
      const ndmiVals = extractValues(ndmi);
      const ndwiVals = extractValues(ndwi);
      const sampleCount = Math.max(ndviVals.length, ndmiVals.length, ndwiVals.length);

      return {
        season: season.key,
        ndviMean: average(ndviVals),
        ndmiMean: average(ndmiVals),
        ndwiMean: average(ndwiVals),
        sampleCount,
      };
    });
  }

  async generateMonitoringAlerts(projectId: string, persistToTimeline = false): Promise<MonitoringAlert[]> {
    const markers = await this.detectTrendAnomalyMarkers(projectId);

    const alerts: MonitoringAlert[] = markers.map((marker) => ({
      type: marker.markerType,
      severity: marker.severity,
      title: marker.markerType.replaceAll("_", " "),
      description: marker.explanation,
      observedAt: marker.date,
      metadata: {
        indicator: marker.indicator,
        value: marker.value,
        baseline: marker.baseline ?? null,
        deltaPct: marker.deltaPct ?? null,
      },
    }));

    if (persistToTimeline) {
      await this.persistTimelineEvents(projectId, alerts);
    }

    return alerts;
  }

  async generateAutomatedInsights(projectId: string): Promise<AutomatedInsight[]> {
    const [risk, trajectory, seasonal, alerts] = await Promise.all([
      this.computeRestorationRiskScore(projectId),
      this.classifyLongTermTrajectory(projectId),
      this.compareSeasonalPatterns(projectId),
      this.generateMonitoringAlerts(projectId, false),
    ]);

    const insights: AutomatedInsight[] = [];

    insights.push({
      insightType: "RISK",
      title: `Restoration risk is ${risk.level}`,
      detail: `Composite risk score ${risk.score}/100 (confidence-adjusted ${risk.confidenceAdjustedScore}/100).`,
      recommendation:
        risk.level === "CRITICAL" || risk.level === "HIGH"
          ? "Prioritize field validation and accelerate mitigation sampling before next cycle."
          : "Continue scheduled monitoring and maintain data quality controls.",
      confidence: clamp01(1 - risk.confidenceAdjustedScore / 150),
    });

    insights.push({
      insightType: "RECOVERY",
      title: `Trajectory classified as ${trajectory.trajectory}`,
      detail: `NDVI slope per cycle: ${trajectory.slopePerCycle.toFixed(4)} (R² ${trajectory.rSquared.toFixed(3)}).`,
      recommendation:
        trajectory.trajectory.includes("DEGRADATION")
          ? "Review restoration interventions and check disturbance drivers in affected zones."
          : "Sustain current restoration strategy and track seasonal consistency.",
      confidence: clamp01(0.55 + trajectory.rSquared * 0.4),
    });

    const seasonalSpread = seasonal
      .map((s) => s.ndviMean)
      .filter((v): v is number => typeof v === "number");
    const seasonalVolatility = seasonalSpread.length > 1 ? Math.max(...seasonalSpread) - Math.min(...seasonalSpread) : 0;

    insights.push({
      insightType: "SEASONAL",
      title: "Seasonal pattern comparison ready",
      detail: `NDVI seasonal spread: ${seasonalVolatility.toFixed(3)} across quarterly windows.`,
      recommendation:
        seasonalVolatility > 0.15
          ? "Use quarter-specific baselines to avoid false-positive anomalies during high-variance seasons."
          : "Current seasonal variance is moderate; global thresholds remain acceptable.",
      confidence: clamp01(0.5 + Math.min(0.4, seasonal.length * 0.08)),
    });

    insights.push({
      insightType: "QUALITY",
      title: "Monitoring alert readiness",
      detail: `${alerts.length} alert candidate(s) generated from threshold/rule engine foundations.`,
      recommendation:
        alerts.length > 0
          ? "Route high-severity alerts to verifier queue and attach latest raster artifacts."
          : "No high-priority alert signals detected; continue standard cadence.",
      confidence: clamp01(0.65),
    });

    return insights.map((insight) => ({ ...insight, confidence: Number(insight.confidence.toFixed(3)) }));
  }

  async getNotificationEventFoundations(projectId: string) {
    const alerts = await this.generateMonitoringAlerts(projectId, false);
    const events = alerts.map((alert, idx) => ({
      id: `${projectId}-${idx}-${new Date(alert.observedAt).getTime()}`,
      channel: alert.severity === "CRITICAL" || alert.severity === "HIGH" ? "verifier_priority" : "verifier_digest",
      triggerType: alert.type,
      severity: alert.severity,
      payload: alert,
      createdAt: new Date().toISOString(),
    }));

    return {
      projectId,
      count: events.length,
      events,
    };
  }

  async getIntelligentMonitoringRecommendations(projectId: string) {
    const [risk, trajectory, seasonal, calibration] = await Promise.all([
      this.computeRestorationRiskScore(projectId),
      this.classifyLongTermTrajectory(projectId),
      this.compareSeasonalPatterns(projectId),
      ecologicalCalibrationService.getEffectiveCalibration(projectId),
    ]);

    const recommendations: Array<{ priority: "HIGH" | "MEDIUM" | "LOW"; recommendation: string; rationale: string }> = [];

    if (risk.level === "CRITICAL" || risk.level === "HIGH") {
      recommendations.push({
        priority: "HIGH",
        recommendation: "Increase monitoring cadence for next 2 cycles.",
        rationale: `Risk score ${risk.score}/100 indicates elevated ecological instability signals.`,
      });
    }

    if (trajectory.trajectory.includes("DEGRADATION")) {
      recommendations.push({
        priority: "HIGH",
        recommendation: "Trigger focused verifier review on recent raster deltas.",
        rationale: `Long-term trajectory is ${trajectory.trajectory}.`,
      });
    }

    const seasonalCoverage = seasonal.reduce((acc, s) => acc + (s.sampleCount > 0 ? 1 : 0), 0);
    if (seasonalCoverage < 3) {
      recommendations.push({
        priority: "MEDIUM",
        recommendation: "Collect broader seasonal observation coverage before tightening thresholds.",
        rationale: "Seasonal comparison has limited coverage windows.",
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        priority: "LOW",
        recommendation: "Maintain standard schedule and continue drift monitoring.",
        rationale: "No high-risk anomalies detected under current rule configuration.",
      });
    }

    recommendations.push({
      priority: "LOW",
      recommendation: "Apply verifier calibration controls before finalizing high-impact overrides.",
      rationale: `Current calibration profile: ${calibration.profile.profileKey} (${calibration.source}).`,
    });

    return { projectId, calibrationSource: calibration.source, calibrationProfileKey: calibration.profile.profileKey, recommendations };
  }
}

export const anomalyDetectionFoundationService = new AnomalyDetectionFoundationService();
