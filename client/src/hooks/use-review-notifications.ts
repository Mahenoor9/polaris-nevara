/**
 * Review notifications — PHASE OPS-2 (Phase 5)
 * - useReviewInboxNotifications(): staff-wide polling of the clarification inbox,
 *   notifying verifiers when contributors respond and when items go overdue.
 * - emitThreadNotifications(): per-thread emitter used inside the discussion panel
 *   to notify the current user about new activity from other participants.
 *
 * All emissions are deduplicated via localStorage so a notification fires once.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { reviewApi, type ThreadView } from "@/lib/review-api";
import { useNotifications } from "@/components/notification-center";

const DEDUP_KEY = "nevara_review_notifications_v1";
const MAX_KEYS = 400;

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(DEDUP_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>) {
  try {
    localStorage.setItem(DEDUP_KEY, JSON.stringify(Array.from(seen).slice(-MAX_KEYS)));
  } catch {
    /* ignore quota */
  }
}

/** Staff-wide inbox watcher (verifier/admin). */
export function useReviewInboxNotifications(options: { enabled?: boolean; linkBase?: string } = {}) {
  const { enabled = true, linkBase = "/operations/project" } = options;
  const { push } = useNotifications();

  const { data } = useQuery({
    queryKey: ["/api/review/inbox"],
    queryFn: () => reviewApi.getInbox(),
    throwOnError: false,
    enabled,
    refetchInterval: 3 * 60 * 1000,
  });

  useEffect(() => {
    if (!data) return;
    const seen = loadSeen();
    let changed = false;

    for (const item of data.awaitingVerifier) {
      const key = `respond:${item.clarificationId}:${item.updatedAt.slice(0, 16)}`;
      if (seen.has(key)) continue;
      push({
        category: "clarification_responded",
        title: "Contributor response submitted",
        body: `A clarification (${item.category ?? "general"}) has a new response awaiting your review.`,
        href: `${linkBase}/${item.projectId}`,
      });
      seen.add(key);
      changed = true;
    }

    for (const item of data.overdue) {
      const key = `overdue:${item.clarificationId}:${item.ageDays}`;
      if (seen.has(key)) continue;
      push({
        category: "clarification_requested",
        title: "Clarification overdue",
        body: `A ${item.category ?? "general"} clarification has been awaiting a contributor response for ${item.ageDays} days.`,
        href: `${linkBase}/${item.projectId}`,
      });
      seen.add(key);
      changed = true;
    }

    if (changed) saveSeen(seen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, linkBase]);
}

/**
 * Emit notifications for new thread activity authored by others, relative to the
 * current user. Call once per fetched thread.
 */
export function emitThreadNotifications(params: {
  thread: ThreadView | undefined;
  currentUserId: string;
  push: ReturnType<typeof useNotifications>["push"];
  href: string;
}) {
  const { thread, currentUserId, push, href } = params;
  if (!thread) return;
  const seen = loadSeen();
  let changed = false;

  const consider = (
    id: string,
    authorId: string,
    category: "review_comment" | "clarification_requested" | "clarification_responded",
    title: string,
    body: string,
  ) => {
    if (authorId === currentUserId) return;
    const key = `thread:${id}`;
    if (seen.has(key)) return;
    push({ category, title, body, href });
    seen.add(key);
    changed = true;
  };

  for (const c of thread.clarifications) {
    consider(c.id, c.authorId, "clarification_requested", "Clarification requested", c.body.slice(0, 120));
    for (const r of c.replies) {
      consider(r.id, r.authorId, "clarification_responded", "New reply on clarification", r.body.slice(0, 120));
    }
  }
  for (const c of thread.comments) {
    consider(c.id, c.authorId, "review_comment", "New review comment", c.body.slice(0, 120));
    for (const r of c.replies) {
      consider(r.id, r.authorId, "review_comment", "New reply", r.body.slice(0, 120));
    }
  }

  if (changed) saveSeen(seen);
}
