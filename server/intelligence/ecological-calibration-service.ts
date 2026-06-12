import { sql } from "drizzle-orm";

export type EcosystemPresetKey = "lakes" | "wetlands" | "mangroves" | "barren_restoration";

export interface CalibrationProfile {
  profileKey: EcosystemPresetKey | "custom";
  ecosystemKey: string;
  thresholdOverrides: {
    suddenVegetationLossPct?: number;
    abnormalNdviDeltaPct?: number;
    floodNdwiIncrease?: number;
    stressNdmiDrop?: number;
  };
  anomalyWeights: {
    anomalyLoad?: number;
    ndviDeclineTrend?: number;
    moistureDeclineTrend?: number;
  };
  seasonalTuning: {
    sensitivityMultiplier?: number;
    minSeasonalCoverage?: number;
  };
  confidenceTuning: {
    anomalyPenaltyMultiplier?: number;
    fieldEvidenceBoost?: number;
  };
}

export interface EffectiveCalibration {
  source: "default" | "organization" | "project";
  scopeId: string | null;
  profile: CalibrationProfile;
}

const PRESETS: Record<EcosystemPresetKey, CalibrationProfile> = {
  lakes: {
    profileKey: "lakes",
    ecosystemKey: "lakes",
    thresholdOverrides: {
      suddenVegetationLossPct: 16,
      abnormalNdviDeltaPct: 20,
      floodNdwiIncrease: 0.08,
      stressNdmiDrop: 0.09,
    },
    anomalyWeights: {
      anomalyLoad: 0.35,
      ndviDeclineTrend: 0.25,
      moistureDeclineTrend: 0.4,
    },
    seasonalTuning: { sensitivityMultiplier: 0.9, minSeasonalCoverage: 2 },
    confidenceTuning: { anomalyPenaltyMultiplier: 0.8, fieldEvidenceBoost: 0.1 },
  },
  wetlands: {
    profileKey: "wetlands",
    ecosystemKey: "wetlands",
    thresholdOverrides: {
      suddenVegetationLossPct: 20,
      abnormalNdviDeltaPct: 24,
      floodNdwiIncrease: 0.14,
      stressNdmiDrop: 0.08,
    },
    anomalyWeights: {
      anomalyLoad: 0.32,
      ndviDeclineTrend: 0.23,
      moistureDeclineTrend: 0.45,
    },
    seasonalTuning: { sensitivityMultiplier: 0.85, minSeasonalCoverage: 3 },
    confidenceTuning: { anomalyPenaltyMultiplier: 0.75, fieldEvidenceBoost: 0.12 },
  },
  mangroves: {
    profileKey: "mangroves",
    ecosystemKey: "mangroves",
    thresholdOverrides: {
      suddenVegetationLossPct: 14,
      abnormalNdviDeltaPct: 18,
      floodNdwiIncrease: 0.1,
      stressNdmiDrop: 0.07,
    },
    anomalyWeights: {
      anomalyLoad: 0.42,
      ndviDeclineTrend: 0.4,
      moistureDeclineTrend: 0.18,
    },
    seasonalTuning: { sensitivityMultiplier: 0.95, minSeasonalCoverage: 2 },
    confidenceTuning: { anomalyPenaltyMultiplier: 0.9, fieldEvidenceBoost: 0.14 },
  },
  barren_restoration: {
    profileKey: "barren_restoration",
    ecosystemKey: "barren_restoration",
    thresholdOverrides: {
      suddenVegetationLossPct: 26,
      abnormalNdviDeltaPct: 30,
      floodNdwiIncrease: 0.18,
      stressNdmiDrop: 0.13,
    },
    anomalyWeights: {
      anomalyLoad: 0.28,
      ndviDeclineTrend: 0.52,
      moistureDeclineTrend: 0.2,
    },
    seasonalTuning: { sensitivityMultiplier: 1.12, minSeasonalCoverage: 3 },
    confidenceTuning: { anomalyPenaltyMultiplier: 1.05, fieldEvidenceBoost: 0.2 },
  },
};

function normalizePreset(ecosystemType: string | null | undefined): EcosystemPresetKey {
  const v = (ecosystemType ?? "").toLowerCase();
  if (v.includes("lake")) return "lakes";
  if (v.includes("wetland")) return "wetlands";
  if (v.includes("mangrove")) return "mangroves";
  return "barren_restoration";
}

async function isDbMode() {
  return process.env.USE_DATABASE === "true" && Boolean(process.env.DATABASE_URL);
}

export class EcologicalCalibrationService {
  private memoryProfiles = new Map<string, EffectiveCalibration>();

  private key(scopeType: string, scopeId: string, ecosystemKey: string) {
    return `${scopeType}:${scopeId}:${ecosystemKey}`;
  }

  async getPresetForProject(projectId: string): Promise<CalibrationProfile> {
    const { storage } = await import("../storage");
    const project = await storage.getProject(projectId);
    const preset = normalizePreset(project?.ecosystemType);
    return PRESETS[preset];
  }

  async getEffectiveCalibration(projectId: string): Promise<EffectiveCalibration> {
    const { storage } = await import("../storage");
    const project = await storage.getProject(projectId);
    const ecosystemKey = (project?.ecosystemType ?? "barren_restoration").toLowerCase();

    const basePreset = await this.getPresetForProject(projectId);
    const defaultCal: EffectiveCalibration = {
      source: "default",
      scopeId: null,
      profile: { ...basePreset, ecosystemKey },
    };

    if (!(await isDbMode())) {
      const projectKey = this.key("project", projectId, ecosystemKey);
      return this.memoryProfiles.get(projectKey) ?? defaultCal;
    }

    const { db } = await import("../db");

    const projectResult = await db.execute(sql`
      SELECT *
      FROM eco_monitoring.ecological_calibration_profiles
      WHERE scope_type = 'project'
        AND scope_id = ${projectId}
        AND active = TRUE
      ORDER BY updated_at DESC
      LIMIT 1
    `);

    // Foundation mode: use owner userId as organization scope surrogate until dedicated organization entity is present.
    const orgId = project?.userId ? String(project.userId) : null;
    const orgResult = orgId
      ? await db.execute(sql`
          SELECT *
          FROM eco_monitoring.ecological_calibration_profiles
          WHERE scope_type = 'organization'
            AND scope_id = ${orgId}
            AND active = TRUE
          ORDER BY updated_at DESC
          LIMIT 1
        `)
      : { rows: [] };

    const chosen = (projectResult.rows?.[0] ?? orgResult.rows?.[0]) as Record<string, unknown> | undefined;
    if (!chosen) return defaultCal;

    const source = chosen.scope_type === "project" ? "project" : "organization";
    const merged: CalibrationProfile = {
      ...basePreset,
      ecosystemKey,
      profileKey: (String(chosen.profile_key || basePreset.profileKey) as CalibrationProfile["profileKey"]),
      thresholdOverrides: { ...basePreset.thresholdOverrides, ...(chosen.threshold_overrides as Record<string, unknown> ?? {}) },
      anomalyWeights: { ...basePreset.anomalyWeights, ...(chosen.anomaly_weights as Record<string, unknown> ?? {}) },
      seasonalTuning: { ...basePreset.seasonalTuning, ...(chosen.seasonal_tuning as Record<string, unknown> ?? {}) },
      confidenceTuning: { ...basePreset.confidenceTuning, ...(chosen.confidence_tuning as Record<string, unknown> ?? {}) },
    };

    return {
      source,
      scopeId: String(chosen.scope_id ?? ""),
      profile: merged,
    };
  }

  async upsertCalibrationProfile(params: {
    scopeType: "project" | "organization";
    scopeId: string;
    ecosystemKey: string;
    profileKey: CalibrationProfile["profileKey"];
    thresholdOverrides?: CalibrationProfile["thresholdOverrides"];
    anomalyWeights?: CalibrationProfile["anomalyWeights"];
    seasonalTuning?: CalibrationProfile["seasonalTuning"];
    confidenceTuning?: CalibrationProfile["confidenceTuning"];
    createdBy?: string;
  }) {
    const fallbackProfile: CalibrationProfile = {
      ...(PRESETS[(params.profileKey === "custom" ? "barren_restoration" : params.profileKey) as EcosystemPresetKey]),
      ecosystemKey: params.ecosystemKey,
      profileKey: params.profileKey,
      thresholdOverrides: params.thresholdOverrides ?? {},
      anomalyWeights: params.anomalyWeights ?? {},
      seasonalTuning: params.seasonalTuning ?? {},
      confidenceTuning: params.confidenceTuning ?? {},
    };

    if (!(await isDbMode())) {
      this.memoryProfiles.set(this.key(params.scopeType, params.scopeId, params.ecosystemKey.toLowerCase()), {
        source: params.scopeType,
        scopeId: params.scopeId,
        profile: fallbackProfile,
      });
      return { persisted: false, profile: fallbackProfile };
    }

    const { db } = await import("../db");

    await db.execute(sql`
      UPDATE eco_monitoring.ecological_calibration_profiles
      SET active = FALSE,
          updated_at = NOW()
      WHERE scope_type = ${params.scopeType}
        AND scope_id = ${params.scopeId}
        AND ecosystem_key = ${params.ecosystemKey.toLowerCase()}
        AND active = TRUE
    `);

    await db.execute(sql`
      INSERT INTO eco_monitoring.ecological_calibration_profiles
        (
          scope_type,
          scope_id,
          ecosystem_key,
          profile_key,
          active,
          threshold_overrides,
          anomaly_weights,
          seasonal_tuning,
          confidence_tuning,
          created_by
        )
      VALUES
        (
          ${params.scopeType},
          ${params.scopeId},
          ${params.ecosystemKey.toLowerCase()},
          ${params.profileKey},
          TRUE,
          ${JSON.stringify(params.thresholdOverrides ?? {})}::jsonb,
          ${JSON.stringify(params.anomalyWeights ?? {})}::jsonb,
          ${JSON.stringify(params.seasonalTuning ?? {})}::jsonb,
          ${JSON.stringify(params.confidenceTuning ?? {})}::jsonb,
          ${params.createdBy ?? null}
        )
    `);

    return { persisted: true, profile: fallbackProfile };
  }

  listPresetProfiles() {
    return PRESETS;
  }
}

export const ecologicalCalibrationService = new EcologicalCalibrationService();
