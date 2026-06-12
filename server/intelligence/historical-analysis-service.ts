/**
 * historical-analysis-service.ts
 *
 * Implements temporal analysis workflows:
 *  - Retrieve historical observation records from DB grouped by indicator
 *  - Compute NDVI timeline (yearly annual medians)
 *  - Detect degradation period (peak/trough detection from time series)
 *  - Build multi-indicator trend preparation bundles
 *  - Load historical snapshots for multi-cycle comparison engine
 *
 * Isolation contract:
 *  - Reads from eco_monitoring.environmental_observations only
 *  - No write operations
 *  - Designed to be called by the intelligence aggregation layer and report generator
 */

import { sql } from "drizzle-orm";
import type { MonitoringSnapshot, BaselineSnapshot } from "../mrv/types";
import type { HistoricalObservationRow } from "./historical-observation-query";
import { historicalObservationQueryService } from "./historical-observation-query";
import {
  computeLinearTrend,
  classifyDegradation,
  type DegradationClass,
  type TrendDirection,
} from "../mrv/change-detection-engine";

const LOG = "[Intel:HistoricalAnalysis]";

// ─── Yearly NDVI timeline ─────────────────────────────────────────────────────

export interface YearlyNdviPoint {
  year: number;
  ndviMean: number | null;
  ndviStddev: number | null;
  imageCount: number | null;
  source: "db" | "estimated";
}

/**
 * Build a year-by-year NDVI timeline from persisted environmental_observations.
 * Groups observations by year, returns the mean of means per year.
 */
async function buildYearlyNdviTimeline(
  projectId: string,
  startYear: number,
  endYear: number
): Promise<YearlyNdviPoint[]> {
  const rows = await historicalObservationQueryService.listByProject(projectId, "ndvi", 1000);
  if (rows.length === 0) return [];

  // Group by year
  const byYear: Record<number, number[]> = {};
  for (const row of rows) {
    if (row.valueMean === null) continue;
    const year = new Date(row.observedAt).getUTCFullYear();
    if (year < startYear || year > endYear) continue;
    (byYear[year] ??= []).push(row.valueMean);
  }

  const timeline: YearlyNdviPoint[] = [];
  for (let year = startYear; year <= endYear; year++) {
    const values = byYear[year] ?? [];
    if (values.length > 0) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const stddev = values.length > 1
        ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
        : 0;
      timeline.push({
        year,
        ndviMean: parseFloat(mean.toFixed(4)),
        ndviStddev: parseFloat(stddev.toFixed(4)),
        imageCount: values.length,
        source: "db",
      });
    } else {
      timeline.push({ year, ndviMean: null, ndviStddev: null, imageCount: 0, source: "db" });
    }
  }
  return timeline;
}

// ─── Degradation period detection ─────────────────────────────────────────────

export interface DegradationAnalysis {
  detected: boolean;
  peakYear: number | null;
  peakValue: number | null;
  currentYear: number | null;
  currentValue: number | null;
  totalChangePct: number | null;
  degradationClass: DegradationClass | null;
  trendDirection: TrendDirection;
  trendSlope: number;
  trendRSquared: number;
  worstDeclineYear: number | null;
  worstDeclineMagnitude: number | null;
  yearsAnalyzed: number;
}

function detectDegradationFromTimeline(timeline: YearlyNdviPoint[]): DegradationAnalysis {
  const valid = timeline.filter((p) => p.ndviMean !== null);

  if (valid.length < 3) {
    return {
      detected: false,
      peakYear: null, peakValue: null, currentYear: null, currentValue: null,
      totalChangePct: null, degradationClass: null,
      trendDirection: "stable", trendSlope: 0, trendRSquared: 0,
      worstDeclineYear: null, worstDeclineMagnitude: null,
      yearsAnalyzed: valid.length,
    };
  }

  const values = valid.map((p) => p.ndviMean as number);
  const years = valid.map((p) => p.year);

  const peakIdx = values.indexOf(Math.max(...values));
  const peakValue = values[peakIdx];
  const peakYear = years[peakIdx];
  const currentValue = values[values.length - 1];
  const currentYear = years[years.length - 1];
  const totalChange = currentValue - peakValue;
  const totalChangePct = peakValue !== 0 ? (totalChange / peakValue) * 100 : 0;

  // Worst year-over-year decline
  let worstDeclineYear: number | null = null;
  let worstDeclineMagnitude: number | null = null;
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (worstDeclineMagnitude === null || diff < worstDeclineMagnitude) {
      worstDeclineMagnitude = diff;
      worstDeclineYear = years[i];
    }
  }

  const trend = computeLinearTrend(values);
  const degradationClass = classifyDegradation(totalChangePct);

  return {
    detected: true,
    peakYear, peakValue,
    currentYear, currentValue,
    totalChangePct: parseFloat(totalChangePct.toFixed(1)),
    degradationClass,
    trendDirection: trend.direction,
    trendSlope: trend.slope,
    trendRSquared: trend.rSquared,
    worstDeclineYear,
    worstDeclineMagnitude: worstDeclineMagnitude !== null ? parseFloat(worstDeclineMagnitude.toFixed(4)) : null,
    yearsAnalyzed: valid.length,
  };
}

// ─── Trend preparation bundle ─────────────────────────────────────────────────

export interface TrendPreparationBundle {
  indicator: string;
  dataPoints: Array<{ date: string; value: number | null }>;
  trendSlope: number;
  trendDirection: TrendDirection;
  trendRSquared: number;
  firstObservation: string | null;
  latestObservation: string | null;
  totalPoints: number;
}

async function buildTrendPreparationBundle(
  projectId: string,
  indicator: string
): Promise<TrendPreparationBundle> {
  const rows = await historicalObservationQueryService.listByProject(projectId, indicator, 500);
  const points = rows.map((r) => ({ date: r.observedAt, value: r.valueMean }));
  const values = points.map((p) => p.value);
  const trend = computeLinearTrend(values);

  return {
    indicator,
    dataPoints: points,
    trendSlope: trend.slope,
    trendDirection: trend.direction,
    trendRSquared: trend.rSquared,
    firstObservation: rows[0]?.observedAt ?? null,
    latestObservation: rows[rows.length - 1]?.observedAt ?? null,
    totalPoints: rows.length,
  };
}

// ─── Historical snapshots loader ──────────────────────────────────────────────

/**
 * Load persisted monitoring cycle snapshots from DB for multi-cycle comparison.
 * Returns compact MonitoringSnapshot records suitable for the change detection engine.
 */
async function loadHistoricalSnapshots(projectId: string, limit = 50): Promise<MonitoringSnapshot[]> {
  const isDb = process.env.USE_DATABASE === "true" && Boolean(process.env.DATABASE_URL);
  if (!isDb) return [];

  const { db } = await import("../db");

  try {
    const result = await db.execute(sql`
      SELECT
        mc.id AS "cycleId",
        obs.observed_at AS "observedAt",
        MAX(CASE WHEN obs.observation_type = 'ndvi'  THEN obs.value_mean END) AS "ndviMean",
        MAX(CASE WHEN obs.observation_type = 'ndmi'  THEN obs.value_mean END) AS "ndmiMean",
        MAX(CASE WHEN obs.observation_type = 'ndwi'  THEN obs.value_mean END) AS "ndwiMean",
        MAX(CASE WHEN obs.observation_type = 'evi'   THEN obs.value_mean END) AS "eviMean",
        -- green cover from vegetation_fraction observation if available
        MAX(CASE WHEN obs.observation_type = 'vegetation_fraction' THEN obs.value_mean END) AS "greenCoverPercent",
        -- bare land from bsi
        MAX(CASE WHEN obs.observation_type = 'bsi'   THEN obs.value_mean END) AS "bsiMean",
        -- water area from ndwi proxy
        MAX(CASE WHEN obs.observation_type = 'ndwi'  THEN obs.value_mean END) AS "waterAreaPercent"
      FROM eco_monitoring.monitoring_cycles mc
      JOIN eco_monitoring.environmental_observations obs
        ON obs.project_id = mc.project_id
        AND obs.monitoring_cycle_id = mc.id
      WHERE mc.project_id = ${projectId}
        AND mc.status = 'analysis_complete'
      GROUP BY mc.id, obs.observed_at
      ORDER BY obs.observed_at ASC
      LIMIT ${limit}
    `);

    return (result.rows ?? []) as unknown as MonitoringSnapshot[];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG} Could not load historical snapshots for ${projectId}: ${message}`);
    return [];
  }
}

/**
 * Load the baseline snapshot for a project (first completed baseline cycle).
 */
async function loadBaselineSnapshot(projectId: string): Promise<BaselineSnapshot | null> {
  const isDb = process.env.USE_DATABASE === "true" && Boolean(process.env.DATABASE_URL);
  if (!isDb) return null;

  const { db } = await import("../db");

  try {
    const result = await db.execute(sql`
      SELECT
        obs.observed_at AS "observedAt",
        MAX(CASE WHEN obs.observation_type = 'ndvi'  THEN obs.value_mean END) AS "ndviMean",
        MAX(CASE WHEN obs.observation_type = 'ndwi'  THEN obs.value_mean END) AS "ndwiMean",
        MAX(CASE WHEN obs.observation_type = 'ndmi'  THEN obs.value_mean END) AS "ndmiMean",
        MAX(CASE WHEN obs.observation_type = 'evi'   THEN obs.value_mean END) AS "eviMean",
        MAX(CASE WHEN obs.observation_type = 'savi'  THEN obs.value_mean END) AS "saviMean",
        MAX(CASE WHEN obs.observation_type = 'vegetation_fraction' THEN obs.value_mean END) AS "greenCoverPercent",
        MAX(CASE WHEN obs.observation_type = 'bsi'   THEN obs.value_mean END) AS "bareLandPercent"
      FROM eco_monitoring.monitoring_cycles mc
      JOIN eco_monitoring.environmental_observations obs
        ON obs.project_id = mc.project_id
        AND obs.monitoring_cycle_id = mc.id
      WHERE mc.project_id = ${projectId}
        AND mc.cycle_type = 'baseline'
        AND mc.status = 'analysis_complete'
      GROUP BY obs.observed_at
      ORDER BY obs.observed_at ASC
      LIMIT 1
    `);

    if ((result.rows ?? []).length === 0) return null;
    return (result.rows ?? [])[0] as unknown as BaselineSnapshot;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG} Could not load baseline snapshot for ${projectId}: ${message}`);
    return null;
  }
}

// ─── Public service class ─────────────────────────────────────────────────────

export class HistoricalAnalysisService {
  async getNdviTimeline(
    projectId: string,
    startYear = 2017,
    endYear: number = new Date().getFullYear()
  ): Promise<YearlyNdviPoint[]> {
    return buildYearlyNdviTimeline(projectId, startYear, endYear);
  }

  async getDegradationAnalysis(
    projectId: string,
    startYear = 2017
  ): Promise<DegradationAnalysis> {
    const endYear = new Date().getFullYear();
    const timeline = await buildYearlyNdviTimeline(projectId, startYear, endYear);
    return detectDegradationFromTimeline(timeline);
  }

  async getMultiIndicatorTrends(
    projectId: string
  ): Promise<TrendPreparationBundle[]> {
    const indicators = ["ndvi", "evi", "ndmi", "ndwi", "nbr", "bsi"];
    const bundles = await Promise.all(
      indicators.map((ind) => buildTrendPreparationBundle(projectId, ind))
    );
    return bundles.filter((b) => b.totalPoints > 0);
  }

  async getHistoricalSnapshots(
    projectId: string,
    limit = 50
  ): Promise<MonitoringSnapshot[]> {
    return loadHistoricalSnapshots(projectId, limit);
  }

  async getBaselineSnapshot(projectId: string): Promise<BaselineSnapshot | null> {
    return loadBaselineSnapshot(projectId);
  }

  /**
   * Full temporal analysis package — used by report generator for baseline reports.
   */
  async getFullTemporalAnalysis(projectId: string): Promise<{
    ndviTimeline: YearlyNdviPoint[];
    degradationAnalysis: DegradationAnalysis;
    multiIndicatorTrends: TrendPreparationBundle[];
    historicalSnapshots: MonitoringSnapshot[];
    baseline: BaselineSnapshot | null;
  }> {
    const [ndviTimeline, historicalSnapshots, baseline] = await Promise.all([
      this.getNdviTimeline(projectId),
      this.getHistoricalSnapshots(projectId),
      this.getBaselineSnapshot(projectId),
    ]);

    const degradationAnalysis = detectDegradationFromTimeline(ndviTimeline);

    const multiIndicatorTrends = await this.getMultiIndicatorTrends(projectId);

    return {
      ndviTimeline,
      degradationAnalysis,
      multiIndicatorTrends,
      historicalSnapshots,
      baseline,
    };
  }
}

export const historicalAnalysisService = new HistoricalAnalysisService();
