/**
 * Review Repository — PHASE OPS-2
 * ─────────────────────────────────────────────────────────────────────────────
 * Data access for review threads & clarifications. Mirrors the established
 * monitoring-cycle-repository pattern: an in-memory Map fallback when
 * USE_DATABASE is off, and Drizzle SQL when DB mode is enabled.
 *
 * AUDIT SAFETY (Phase 8): there is intentionally NO delete operation. Rows are
 * only ever inserted or transitioned (resolve / archive / supersede).
 */
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { isDatabaseModeEnabled } from "../db";
import type { ReviewComment } from "@shared/schema";

export interface CreateCommentInput {
  projectId: string;
  parentId?: string | null;
  authorId: string;
  authorName: string;
  authorRole: string;
  body: string;
  kind: "comment" | "clarification" | "response" | "system";
  clarificationCategory?: string | null;
  status?: string | null;
  attachments?: unknown[] | null;
}

function nowIso(): Date {
  return new Date();
}

export class ReviewRepository {
  // In-memory store for development (USE_DATABASE=false).
  private memory = new Map<string, ReviewComment>();

  private async db() {
    const { db } = await import("../db");
    return db;
  }

  private rowToComment(row: any): ReviewComment {
    return {
      id: String(row.id),
      projectId: String(row.project_id ?? row.projectId),
      parentId: row.parent_id ?? row.parentId ?? null,
      authorId: String(row.author_id ?? row.authorId),
      authorName: String(row.author_name ?? row.authorName ?? "Unknown"),
      authorRole: String(row.author_role ?? row.authorRole ?? "contributor"),
      body: String(row.body ?? ""),
      kind: String(row.kind ?? "comment"),
      clarificationCategory: row.clarification_category ?? row.clarificationCategory ?? null,
      status: row.status ?? null,
      attachments: row.attachments ?? null,
      resolvedBy: row.resolved_by ?? row.resolvedBy ?? null,
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : row.resolvedAt ?? null,
      archivedAt: row.archived_at ? new Date(row.archived_at) : row.archivedAt ?? null,
      supersededById: row.superseded_by_id ?? row.supersededById ?? null,
      supersededAt: row.superseded_at ? new Date(row.superseded_at) : row.supersededAt ?? null,
      createdAt: row.created_at ? new Date(row.created_at) : row.createdAt ?? new Date(),
      updatedAt: row.updated_at ? new Date(row.updated_at) : row.updatedAt ?? new Date(),
    };
  }

  async create(input: CreateCommentInput): Promise<ReviewComment> {
    const id = randomUUID();
    const created = nowIso();
    const attachmentsJson = input.attachments ? JSON.stringify(input.attachments) : null;

    if (!isDatabaseModeEnabled()) {
      const record: ReviewComment = {
        id,
        projectId: input.projectId,
        parentId: input.parentId ?? null,
        authorId: input.authorId,
        authorName: input.authorName,
        authorRole: input.authorRole,
        body: input.body,
        kind: input.kind,
        clarificationCategory: input.clarificationCategory ?? null,
        status: input.status ?? null,
        attachments: attachmentsJson,
        resolvedBy: null,
        resolvedAt: null,
        archivedAt: null,
        supersededById: null,
        supersededAt: null,
        createdAt: created,
        updatedAt: created,
      };
      this.memory.set(id, record);
      return record;
    }

    const db = await this.db();
    const result = await db.execute(sql`
      INSERT INTO public.review_comments
        (id, project_id, parent_id, author_id, author_name, author_role, body, kind,
         clarification_category, status, attachments, created_at, updated_at)
      VALUES
        (${id}, ${input.projectId}, ${input.parentId ?? null}, ${input.authorId},
         ${input.authorName}, ${input.authorRole}, ${input.body}, ${input.kind},
         ${input.clarificationCategory ?? null}, ${input.status ?? null}, ${attachmentsJson},
         ${created}, ${created})
      RETURNING *
    `);
    const row = (result.rows ?? [])[0];
    return row ? this.rowToComment(row) : this.rowToComment({ id, project_id: input.projectId, author_id: input.authorId, author_name: input.authorName, author_role: input.authorRole, body: input.body, kind: input.kind, created_at: created, updated_at: created });
  }

  async getById(id: string): Promise<ReviewComment | undefined> {
    if (!isDatabaseModeEnabled()) {
      return this.memory.get(id);
    }
    const db = await this.db();
    const result = await db.execute(sql`SELECT * FROM public.review_comments WHERE id = ${id} LIMIT 1`);
    const row = (result.rows ?? [])[0];
    return row ? this.rowToComment(row) : undefined;
  }

  async listByProject(projectId: string): Promise<ReviewComment[]> {
    if (!isDatabaseModeEnabled()) {
      return Array.from(this.memory.values())
        .filter((c) => c.projectId === projectId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }
    const db = await this.db();
    const result = await db.execute(sql`
      SELECT * FROM public.review_comments
      WHERE project_id = ${projectId}
      ORDER BY created_at ASC
    `);
    return (result.rows ?? []).map((r) => this.rowToComment(r));
  }

  /** All non-archived clarification roots across all projects (for the ops inbox). */
  async listAllClarifications(): Promise<ReviewComment[]> {
    if (!isDatabaseModeEnabled()) {
      return Array.from(this.memory.values())
        .filter((c) => c.kind === "clarification" && !c.archivedAt)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
    const db = await this.db();
    const result = await db.execute(sql`
      SELECT * FROM public.review_comments
      WHERE kind = 'clarification' AND archived_at IS NULL
      ORDER BY created_at DESC
    `);
    return (result.rows ?? []).map((r) => this.rowToComment(r));
  }

  /** Apply a partial transition. NEVER deletes — only updates lifecycle fields. */
  async update(
    id: string,
    updates: Partial<Pick<ReviewComment, "status" | "resolvedBy" | "resolvedAt" | "archivedAt" | "supersededById" | "supersededAt">>,
  ): Promise<ReviewComment | undefined> {
    const updatedAt = nowIso();

    if (!isDatabaseModeEnabled()) {
      const record = this.memory.get(id);
      if (!record) return undefined;
      const next = { ...record, ...updates, updatedAt };
      this.memory.set(id, next);
      return next;
    }

    const db = await this.db();
    const result = await db.execute(sql`
      UPDATE public.review_comments
      SET
        status = COALESCE(${updates.status ?? null}, status),
        resolved_by = COALESCE(${updates.resolvedBy ?? null}, resolved_by),
        resolved_at = COALESCE(${updates.resolvedAt ?? null}, resolved_at),
        archived_at = COALESCE(${updates.archivedAt ?? null}, archived_at),
        superseded_by_id = COALESCE(${updates.supersededById ?? null}, superseded_by_id),
        superseded_at = COALESCE(${updates.supersededAt ?? null}, superseded_at),
        updated_at = ${updatedAt}
      WHERE id = ${id}
      RETURNING *
    `);
    const row = (result.rows ?? [])[0];
    return row ? this.rowToComment(row) : undefined;
  }
}

export const reviewRepository = new ReviewRepository();
