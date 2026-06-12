/**
 * Review Service — PHASE OPS-2
 * Business logic for collaborative ecological verification: threaded discussion,
 * clarification lifecycle, review inbox, and the immutable review timeline.
 *
 * All mutations are additive and audited. Nothing here deletes data.
 */
import { reviewRepository, type CreateCommentInput } from "./review-repository";
import { audit } from "../auditLog";
import { memAuditLog } from "../auditLog";
import { AUDIT_ACTION_TYPES, type ReviewComment } from "@shared/schema";

export interface Author {
  id: string;
  name: string;
  role: string;
}

export interface Attachment {
  name: string;
  url: string | null;
  size?: number;
  mimetype?: string;
}

// ─── View models ────────────────────────────────────────────────────────────

export interface CommentView extends Omit<ReviewComment, "attachments"> {
  attachments: Attachment[];
  replies: CommentView[];
}

export interface ThreadView {
  projectId: string;
  comments: CommentView[];       // top-level general comments (with replies)
  clarifications: CommentView[]; // top-level clarification cards (with replies)
  counts: {
    openClarifications: number;
    respondedClarifications: number;
    resolvedClarifications: number;
    totalComments: number;
  };
}

export interface TimelineEntry {
  id: string;
  type: string;
  title: string;
  detail?: string;
  actor?: string | null;
  timestamp: string;
}

export interface InboxItem {
  projectId: string;
  clarificationId: string;
  category: string | null;
  status: string;
  body: string;
  author: string;
  ageDays: number;
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewInbox {
  awaitingContributor: InboxItem[]; // status open
  awaitingVerifier: InboxItem[];    // status responded
  resolved: InboxItem[];            // status resolved
  overdue: InboxItem[];             // open and aged past threshold
  counts: { awaitingContributor: number; awaitingVerifier: number; resolved: number; overdue: number; total: number };
}

const OVERDUE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseAttachments(raw: string | null): Attachment[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as Attachment[]) : [];
  } catch {
    return [];
  }
}

function toView(comment: ReviewComment, replies: ReviewComment[]): CommentView {
  return {
    ...comment,
    attachments: parseAttachments(comment.attachments),
    replies: replies
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => toView(r, [])),
  };
}

export class ReviewService {
  // ── Thread assembly ────────────────────────────────────────────────────────

  async getThread(projectId: string): Promise<ThreadView> {
    const all = await reviewRepository.listByProject(projectId);
    const repliesByParent = new Map<string, ReviewComment[]>();
    for (const c of all) {
      if (c.parentId) {
        if (!repliesByParent.has(c.parentId)) repliesByParent.set(c.parentId, []);
        repliesByParent.get(c.parentId)!.push(c);
      }
    }

    const roots = all.filter((c) => !c.parentId && !c.archivedAt);
    const comments: CommentView[] = [];
    const clarifications: CommentView[] = [];
    for (const root of roots) {
      const view = toView(root, repliesByParent.get(root.id) ?? []);
      if (root.kind === "clarification") clarifications.push(view);
      else comments.push(view);
    }

    const counts = {
      openClarifications: clarifications.filter((c) => c.status === "open").length,
      respondedClarifications: clarifications.filter((c) => c.status === "responded").length,
      resolvedClarifications: clarifications.filter((c) => c.status === "resolved").length,
      totalComments: all.filter((c) => !c.archivedAt).length,
    };

    return { projectId, comments, clarifications, counts };
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  async addComment(params: {
    projectId: string;
    projectName: string;
    author: Author;
    body: string;
    parentId?: string | null;
    attachments?: Attachment[];
  }): Promise<ReviewComment> {
    const input: CreateCommentInput = {
      projectId: params.projectId,
      parentId: params.parentId ?? null,
      authorId: params.author.id,
      authorName: params.author.name,
      authorRole: params.author.role,
      body: params.body,
      kind: "comment",
      attachments: params.attachments ?? null,
    };
    const comment = await reviewRepository.create(input);
    await audit({
      userId: params.author.id,
      actionType: AUDIT_ACTION_TYPES.REVIEW_COMMENT_ADDED,
      entityType: "project",
      entityId: params.projectId,
      metadata: { commentId: comment.id, parentId: params.parentId ?? null, role: params.author.role },
    });
    return comment;
  }

  async requestClarification(params: {
    projectId: string;
    author: Author;
    body: string;
    category: string;
  }): Promise<ReviewComment> {
    const comment = await reviewRepository.create({
      projectId: params.projectId,
      authorId: params.author.id,
      authorName: params.author.name,
      authorRole: params.author.role,
      body: params.body,
      kind: "clarification",
      clarificationCategory: params.category,
      status: "open",
    });
    await audit({
      userId: params.author.id,
      actionType: AUDIT_ACTION_TYPES.REVIEW_CLARIFICATION_REQUESTED,
      entityType: "project",
      entityId: params.projectId,
      metadata: { clarificationId: comment.id, category: params.category },
    });
    return comment;
  }

  async submitResponse(params: {
    clarificationId: string;
    author: Author;
    body: string;
    attachments?: Attachment[];
  }): Promise<{ response: ReviewComment; clarification: ReviewComment } | null> {
    const clarification = await reviewRepository.getById(params.clarificationId);
    if (!clarification || clarification.kind !== "clarification") return null;

    const response = await reviewRepository.create({
      projectId: clarification.projectId,
      parentId: clarification.id,
      authorId: params.author.id,
      authorName: params.author.name,
      authorRole: params.author.role,
      body: params.body,
      kind: "response",
      attachments: params.attachments ?? null,
    });

    // Only move open → responded; never override a resolved clarification.
    let updated = clarification;
    if (clarification.status === "open") {
      updated = (await reviewRepository.update(clarification.id, { status: "responded" })) ?? clarification;
    }

    await audit({
      userId: params.author.id,
      actionType: AUDIT_ACTION_TYPES.REVIEW_CLARIFICATION_RESPONDED,
      entityType: "project",
      entityId: clarification.projectId,
      metadata: { clarificationId: clarification.id, responseId: response.id },
    });
    return { response, clarification: updated };
  }

  async resolveClarification(clarificationId: string, actor: Author): Promise<ReviewComment | null> {
    const clarification = await reviewRepository.getById(clarificationId);
    if (!clarification || clarification.kind !== "clarification") return null;
    const updated = await reviewRepository.update(clarificationId, {
      status: "resolved",
      resolvedBy: actor.id,
      resolvedAt: new Date(),
    });
    await audit({
      userId: actor.id,
      actionType: AUDIT_ACTION_TYPES.REVIEW_CLARIFICATION_RESOLVED,
      entityType: "project",
      entityId: clarification.projectId,
      metadata: { clarificationId },
    });
    return updated ?? null;
  }

  async reopenClarification(clarificationId: string, actor: Author): Promise<ReviewComment | null> {
    const clarification = await reviewRepository.getById(clarificationId);
    if (!clarification || clarification.kind !== "clarification") return null;
    const updated = await reviewRepository.update(clarificationId, { status: "open" });
    await audit({
      userId: actor.id,
      actionType: AUDIT_ACTION_TYPES.REVIEW_CLARIFICATION_REOPENED,
      entityType: "project",
      entityId: clarification.projectId,
      metadata: { clarificationId },
    });
    return updated ?? null;
  }

  /** Acknowledge a contributor response without resolving (posts a system note). */
  async acknowledgeClarification(clarificationId: string, actor: Author): Promise<ReviewComment | null> {
    const clarification = await reviewRepository.getById(clarificationId);
    if (!clarification || clarification.kind !== "clarification") return null;
    await reviewRepository.create({
      projectId: clarification.projectId,
      parentId: clarification.id,
      authorId: actor.id,
      authorName: actor.name,
      authorRole: actor.role,
      body: "Acknowledged the response. Reviewing the supporting evidence.",
      kind: "system",
    });
    await audit({
      userId: actor.id,
      actionType: AUDIT_ACTION_TYPES.REVIEW_CLARIFICATION_ACKNOWLEDGED,
      entityType: "project",
      entityId: clarification.projectId,
      metadata: { clarificationId },
    });
    return clarification;
  }

  /** Audit-safe archive — hides a thread from the active view but retains the row. */
  async archiveComment(commentId: string, actor: Author): Promise<ReviewComment | null> {
    const comment = await reviewRepository.getById(commentId);
    if (!comment) return null;
    const updated = await reviewRepository.update(commentId, { archivedAt: new Date() });
    await audit({
      userId: actor.id,
      actionType: AUDIT_ACTION_TYPES.REVIEW_COMMENT_ARCHIVED,
      entityType: "project",
      entityId: comment.projectId,
      metadata: { commentId },
    });
    return updated ?? null;
  }

  // ── Review inbox (ops) ───────────────────────────────────────────────────────

  async getInbox(): Promise<ReviewInbox> {
    const clarifications = await reviewRepository.listAllClarifications();
    const now = Date.now();
    const items: InboxItem[] = clarifications.map((c) => {
      const ageDays = Math.floor((now - c.createdAt.getTime()) / DAY_MS);
      return {
        projectId: c.projectId,
        clarificationId: c.id,
        category: c.clarificationCategory,
        status: c.status ?? "open",
        body: c.body,
        author: c.authorName,
        ageDays,
        overdue: c.status === "open" && ageDays >= OVERDUE_DAYS,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      };
    });

    const awaitingContributor = items.filter((i) => i.status === "open");
    const awaitingVerifier = items.filter((i) => i.status === "responded");
    const resolved = items.filter((i) => i.status === "resolved");
    const overdue = items.filter((i) => i.overdue);

    return {
      awaitingContributor,
      awaitingVerifier,
      resolved,
      overdue,
      counts: {
        awaitingContributor: awaitingContributor.length,
        awaitingVerifier: awaitingVerifier.length,
        resolved: resolved.length,
        overdue: overdue.length,
        total: items.length,
      },
    };
  }

  // ── Immutable review timeline (Phase 4) ──────────────────────────────────────

  async getTimeline(projectId: string): Promise<TimelineEntry[]> {
    const entries: TimelineEntry[] = [];

    // 1. Audit events for this project (append-only source of truth).
    const auditTitleMap: Record<string, string> = {
      [AUDIT_ACTION_TYPES.PROJECT_SUBMITTED]: "Project Submitted",
      [AUDIT_ACTION_TYPES.PROJECT_APPROVED]: "Project Approved",
      [AUDIT_ACTION_TYPES.PROJECT_REJECTED]: "Project Rejected",
      [AUDIT_ACTION_TYPES.PROJECT_CLARIFICATION_REQUESTED]: "Clarification Requested",
      [AUDIT_ACTION_TYPES.VERIFIER_ASSIGNED]: "Verifier Assigned",
      [AUDIT_ACTION_TYPES.REVIEW_COMMENT_ADDED]: "Comment Added",
      [AUDIT_ACTION_TYPES.REVIEW_CLARIFICATION_REQUESTED]: "Clarification Requested",
      [AUDIT_ACTION_TYPES.REVIEW_CLARIFICATION_RESPONDED]: "Contributor Replied",
      [AUDIT_ACTION_TYPES.REVIEW_CLARIFICATION_RESOLVED]: "Clarification Resolved",
      [AUDIT_ACTION_TYPES.REVIEW_CLARIFICATION_REOPENED]: "Clarification Reopened",
      [AUDIT_ACTION_TYPES.REVIEW_CLARIFICATION_ACKNOWLEDGED]: "Response Acknowledged",
    };

    for (const log of memAuditLog.getAll()) {
      if (log.entityId !== projectId) continue;
      const title = auditTitleMap[log.actionType];
      if (!title) continue;
      entries.push({
        id: log.id ?? `${log.actionType}-${log.timestamp?.toISOString?.() ?? ""}`,
        type: log.actionType,
        title,
        actor: log.userId ?? null,
        timestamp: (log.timestamp instanceof Date ? log.timestamp : new Date(log.timestamp as any)).toISOString(),
      });
    }

    return entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }
}

export const reviewService = new ReviewService();
