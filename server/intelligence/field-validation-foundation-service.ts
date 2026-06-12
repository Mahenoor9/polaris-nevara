import { sql } from "drizzle-orm";
import { historicalObservationQueryService } from "./historical-observation-query";

export interface FieldEvidenceInput {
  projectId: string;
  monitoringCycleId?: string | null;
  uploadedBy?: string | null;
  evidenceType: string;
  observationDate: string;
  latitude?: number;
  longitude?: number;
  measuredMetrics?: Record<string, unknown>;
  notes?: string;
  attachmentPath?: string;
  metadata?: Record<string, unknown>;
}

export interface ReviewNoteInput {
  projectId: string;
  monitoringCycleId?: string | null;
  verifierId?: string | null;
  noteType: string;
  severity?: "INFO" | "WARNING" | "CRITICAL";
  note: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface OverrideLogInput {
  projectId: string;
  monitoringCycleId?: string | null;
  verifierId?: string | null;
  overrideType: string;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  reason: string;
  metadata?: Record<string, unknown>;
}

async function isDbMode() {
  return process.env.USE_DATABASE === "true" && Boolean(process.env.DATABASE_URL);
}

export class FieldValidationFoundationService {
  private memoryEvidence = new Map<string, Record<string, unknown>[]>();
  private memoryNotes = new Map<string, Record<string, unknown>[]>();
  private memoryOverrides = new Map<string, Record<string, unknown>[]>();

  async addFieldEvidence(input: FieldEvidenceInput) {
    if (!(await isDbMode())) {
      const arr = this.memoryEvidence.get(input.projectId) ?? [];
      const rec = { id: `mem-${Date.now()}`, ...input, createdAt: new Date().toISOString() };
      arr.unshift(rec);
      this.memoryEvidence.set(input.projectId, arr);
      return { persisted: false, evidence: rec };
    }

    const { db } = await import("../db");
    const result = await db.execute(sql`
      INSERT INTO eco_monitoring.field_validation_evidence
        (
          project_id,
          monitoring_cycle_id,
          uploaded_by,
          evidence_type,
          observation_date,
          latitude,
          longitude,
          measured_metrics,
          notes,
          attachment_path,
          metadata
        )
      VALUES
        (
          ${input.projectId},
          ${input.monitoringCycleId ?? null}::uuid,
          ${input.uploadedBy ?? null},
          ${input.evidenceType},
          ${input.observationDate}::timestamptz,
          ${input.latitude ?? null},
          ${input.longitude ?? null},
          ${JSON.stringify(input.measuredMetrics ?? {})}::jsonb,
          ${input.notes ?? null},
          ${input.attachmentPath ?? null},
          ${JSON.stringify(input.metadata ?? {})}::jsonb
        )
      RETURNING id, created_at AS "createdAt"
    `);

    return { persisted: true, evidence: result.rows?.[0] ?? null };
  }

  async addReviewNote(input: ReviewNoteInput) {
    if (!(await isDbMode())) {
      const arr = this.memoryNotes.get(input.projectId) ?? [];
      const rec = { id: `mem-${Date.now()}`, ...input, createdAt: new Date().toISOString() };
      arr.unshift(rec);
      this.memoryNotes.set(input.projectId, arr);
      return { persisted: false, note: rec };
    }

    const { db } = await import("../db");
    const result = await db.execute(sql`
      INSERT INTO eco_monitoring.ecological_review_notes
        (
          project_id,
          monitoring_cycle_id,
          verifier_id,
          note_type,
          severity,
          note,
          tags,
          metadata
        )
      VALUES
        (
          ${input.projectId},
          ${input.monitoringCycleId ?? null}::uuid,
          ${input.verifierId ?? null},
          ${input.noteType},
          ${input.severity ?? "INFO"},
          ${input.note},
          ${JSON.stringify(input.tags ?? [])}::jsonb,
          ${JSON.stringify(input.metadata ?? {})}::jsonb
        )
      RETURNING id, created_at AS "createdAt"
    `);

    return { persisted: true, note: result.rows?.[0] ?? null };
  }

  async addOverrideLog(input: OverrideLogInput) {
    if (!(await isDbMode())) {
      const arr = this.memoryOverrides.get(input.projectId) ?? [];
      const rec = { id: `mem-${Date.now()}`, ...input, createdAt: new Date().toISOString() };
      arr.unshift(rec);
      this.memoryOverrides.set(input.projectId, arr);
      return { persisted: false, log: rec };
    }

    const { db } = await import("../db");
    const result = await db.execute(sql`
      INSERT INTO eco_monitoring.verifier_override_logs
        (
          project_id,
          monitoring_cycle_id,
          verifier_id,
          override_type,
          previous_value,
          new_value,
          reason,
          metadata
        )
      VALUES
        (
          ${input.projectId},
          ${input.monitoringCycleId ?? null}::uuid,
          ${input.verifierId ?? null},
          ${input.overrideType},
          ${JSON.stringify(input.previousValue ?? null)}::jsonb,
          ${JSON.stringify(input.newValue ?? null)}::jsonb,
          ${input.reason},
          ${JSON.stringify(input.metadata ?? {})}::jsonb
        )
      RETURNING id, created_at AS "createdAt"
    `);

    return { persisted: true, log: result.rows?.[0] ?? null };
  }

  async getFieldVsSatelliteComparison(projectId: string, indicator = "ndvi") {
    const satelliteRows = await historicalObservationQueryService.listByProject(projectId, indicator, 300);

    if (!(await isDbMode())) {
      const evidence = this.memoryEvidence.get(projectId) ?? [];
      return {
        projectId,
        indicator,
        evidenceCount: evidence.length,
        comparisons: [],
      };
    }

    const { db } = await import("../db");
    const evidenceResult = await db.execute(sql`
      SELECT
        id,
        observation_date AS "observationDate",
        measured_metrics AS "measuredMetrics",
        notes,
        attachment_path AS "attachmentPath"
      FROM eco_monitoring.field_validation_evidence
      WHERE project_id = ${projectId}
      ORDER BY observation_date DESC
      LIMIT 200
    `);

    const comparisons = (evidenceResult.rows ?? []).map((row) => {
      const obsDate = new Date(String((row as Record<string, unknown>).observationDate)).getTime();
      const nearest = satelliteRows
        .map((sat) => ({ ...sat, ts: new Date(sat.observedAt).getTime() }))
        .sort((a, b) => Math.abs(a.ts - obsDate) - Math.abs(b.ts - obsDate))[0];

      const metrics = ((row as Record<string, unknown>).measuredMetrics as Record<string, unknown> | null) ?? {};
      const fieldValue = typeof metrics[indicator] === "number" ? (metrics[indicator] as number) : null;
      const satValue = nearest?.valueMean ?? null;
      const delta = fieldValue !== null && satValue !== null ? fieldValue - satValue : null;

      return {
        evidenceId: (row as Record<string, unknown>).id,
        observationDate: (row as Record<string, unknown>).observationDate,
        fieldValue,
        satelliteValue: satValue,
        satelliteObservedAt: nearest?.observedAt ?? null,
        delta,
        absoluteDelta: delta === null ? null : Math.abs(delta),
        notes: (row as Record<string, unknown>).notes ?? null,
        attachmentPath: (row as Record<string, unknown>).attachmentPath ?? null,
      };
    });

    return {
      projectId,
      indicator,
      evidenceCount: comparisons.length,
      comparisons,
    };
  }
}

export const fieldValidationFoundationService = new FieldValidationFoundationService();
