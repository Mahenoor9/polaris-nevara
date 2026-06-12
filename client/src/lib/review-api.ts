/**
 * Review Threads & Clarification API client — PHASE OPS-2
 */

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("bluecarbon_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function safeJson<T>(res: Response): Promise<T> {
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    if (ct.includes("application/json")) {
      try {
        const body = await res.json();
        message = body.error || body.message || message;
      } catch {
        /* ignore */
      }
    }
    throw new Error(message);
  }
  if (!ct.includes("application/json")) throw new Error("Unexpected non-JSON response");
  return res.json() as Promise<T>;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type ClarificationCategory = "boundary" | "ecosystem" | "monitoring" | "evidence" | "document";
export type ClarificationStatus = "open" | "responded" | "resolved";
export type ReviewCommentKind = "comment" | "clarification" | "response" | "system";

export interface Attachment {
  name: string;
  url: string | null;
  size?: number;
  mimetype?: string;
}

export interface CommentView {
  id: string;
  projectId: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  authorRole: string;
  body: string;
  kind: ReviewCommentKind;
  clarificationCategory: string | null;
  status: string | null;
  attachments: Attachment[];
  resolvedBy: string | null;
  resolvedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  replies: CommentView[];
}

export interface ThreadView {
  projectId: string;
  comments: CommentView[];
  clarifications: CommentView[];
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
  awaitingContributor: InboxItem[];
  awaitingVerifier: InboxItem[];
  resolved: InboxItem[];
  overdue: InboxItem[];
  counts: { awaitingContributor: number; awaitingVerifier: number; resolved: number; overdue: number; total: number };
}

// ─── Fetchers ───────────────────────────────────────────────────────────────

export const reviewApi = {
  getThread: async (projectId: string) =>
    safeJson<ThreadView>(await fetch(`/api/projects/${projectId}/review-thread`, { headers: getAuthHeaders() })),

  getTimeline: async (projectId: string) =>
    safeJson<{ projectId: string; timeline: TimelineEntry[] }>(
      await fetch(`/api/projects/${projectId}/review-timeline`, { headers: getAuthHeaders() }),
    ),

  getInbox: async () =>
    safeJson<ReviewInbox>(await fetch(`/api/review/inbox`, { headers: getAuthHeaders() })),

  addComment: async (projectId: string, body: string, parentId?: string, files?: File[]) => {
    const fd = new FormData();
    fd.append("body", body);
    if (parentId) fd.append("parentId", parentId);
    (files ?? []).forEach((f) => fd.append("attachments", f));
    return safeJson<{ comment: CommentView }>(
      await fetch(`/api/projects/${projectId}/review-comments`, { method: "POST", headers: getAuthHeaders(), body: fd }),
    );
  },

  requestClarification: async (projectId: string, body: string, category: ClarificationCategory) =>
    safeJson<{ clarification: CommentView }>(
      await fetch(`/api/projects/${projectId}/clarifications`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ body, category }),
      }),
    ),

  respond: async (clarificationId: string, body: string, files?: File[]) => {
    const fd = new FormData();
    fd.append("body", body);
    (files ?? []).forEach((f) => fd.append("attachments", f));
    return safeJson<{ response: CommentView; clarification: CommentView }>(
      await fetch(`/api/clarifications/${clarificationId}/respond`, { method: "POST", headers: getAuthHeaders(), body: fd }),
    );
  },

  resolve: async (clarificationId: string) =>
    safeJson<{ clarification: CommentView }>(
      await fetch(`/api/clarifications/${clarificationId}/resolve`, { method: "POST", headers: getAuthHeaders() }),
    ),

  reopen: async (clarificationId: string) =>
    safeJson<{ clarification: CommentView }>(
      await fetch(`/api/clarifications/${clarificationId}/reopen`, { method: "POST", headers: getAuthHeaders() }),
    ),

  acknowledge: async (clarificationId: string) =>
    safeJson<{ clarification: CommentView }>(
      await fetch(`/api/clarifications/${clarificationId}/acknowledge`, { method: "POST", headers: getAuthHeaders() }),
    ),

  archive: async (commentId: string) =>
    safeJson<{ comment: CommentView }>(
      await fetch(`/api/review-comments/${commentId}/archive`, { method: "POST", headers: getAuthHeaders() }),
    ),
};

// ─── Display helpers ────────────────────────────────────────────────────────

export const CLARIFICATION_CATEGORY_META: Record<string, { label: string; text: string; bg: string }> = {
  boundary: { label: "Boundary", text: "text-sky-400", bg: "bg-sky-500/12" },
  ecosystem: { label: "Ecosystem", text: "text-emerald-400", bg: "bg-emerald-500/12" },
  monitoring: { label: "Monitoring", text: "text-teal-400", bg: "bg-teal-500/12" },
  evidence: { label: "Evidence", text: "text-violet-400", bg: "bg-violet-500/12" },
  document: { label: "Document", text: "text-amber-400", bg: "bg-amber-500/12" },
};

export const CLARIFICATION_STATUS_META: Record<string, { label: string; text: string; bg: string; border: string }> = {
  open: { label: "Open", text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30" },
  responded: { label: "Responded", text: "text-sky-400", bg: "bg-sky-500/10", border: "border-sky-500/30" },
  resolved: { label: "Resolved", text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
};

export const ROLE_META: Record<string, { label: string; text: string; bg: string }> = {
  contributor: { label: "Contributor", text: "text-sky-400", bg: "bg-sky-500/12" },
  verifier: { label: "Verifier", text: "text-violet-400", bg: "bg-violet-500/12" },
  admin: { label: "Admin", text: "text-rose-400", bg: "bg-rose-500/12" },
};

export function formatReviewTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}
