/**
 * Review & Discussion — PHASE OPS-2 (Phases 1–3, 7, 9)
 * Threaded collaborative verification UI: clarification cards + general
 * discussion, role-aware actions, attachments, and audit-safe transitions.
 * Designed in the NEVARA institutional language (not a chat app).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare,
  HelpCircle,
  Paperclip,
  Send,
  CheckCircle2,
  RotateCcw,
  Eye,
  ShieldCheck,
  CornerDownRight,
  Loader2,
  FileText,
} from "lucide-react";
import {
  reviewApi,
  CLARIFICATION_CATEGORY_META,
  CLARIFICATION_STATUS_META,
  ROLE_META,
  formatReviewTime,
  initialsOf,
  type CommentView,
  type ClarificationCategory,
} from "@/lib/review-api";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/hooks/use-toast";
import { useNotifications } from "@/components/notification-center";
import { emitThreadNotifications } from "@/hooks/use-review-notifications";

const CATEGORIES: ClarificationCategory[] = ["boundary", "ecosystem", "monitoring", "evidence", "document"];

function RoleChip({ role }: { role: string }) {
  const meta = ROLE_META[role] ?? ROLE_META.contributor;
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${meta.bg} ${meta.text}`}>
      {meta.label}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const meta = CLARIFICATION_STATUS_META[status] ?? CLARIFICATION_STATUS_META.open;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.bg} ${meta.text} ${meta.border}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {meta.label}
    </span>
  );
}

function CategoryChip({ category }: { category: string | null }) {
  if (!category) return null;
  const meta = CLARIFICATION_CATEGORY_META[category] ?? { label: category, text: "text-muted-foreground", bg: "bg-muted/40" };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${meta.bg} ${meta.text}`}>
      {meta.label}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-teal-500/30 to-sky-500/20 border border-border/50 flex items-center justify-center text-[10px] font-bold text-foreground/80 shrink-0">
      {initialsOf(name) || "?"}
    </div>
  );
}

function AttachmentList({ attachments }: { attachments: CommentView["attachments"] }) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {attachments.map((a, i) =>
        a.url ? (
          <a
            key={i}
            href={a.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/40 px-2 py-1 text-[11px] hover:bg-muted/70 transition-colors"
          >
            <FileText className="w-3 h-3" />
            {a.name}
          </a>
        ) : (
          <span key={i} className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground" title="Stored reference">
            <Paperclip className="w-3 h-3" />
            {a.name}
          </span>
        ),
      )}
    </div>
  );
}

// ── Reply composer ───────────────────────────────────────────────────────────

function Composer({
  placeholder,
  onSubmit,
  allowAttachments = true,
  submitLabel = "Send",
  compact = false,
}: {
  placeholder: string;
  onSubmit: (body: string, files: File[]) => Promise<void>;
  allowAttachments?: boolean;
  submitLabel?: string;
  compact?: boolean;
}) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(body.trim(), files);
      setBody("");
      setFiles([]);
      if (fileRef.current) fileRef.current.value = "";
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`rounded-lg border border-border/50 bg-background/60 ${compact ? "p-2" : "p-3"}`}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        rows={compact ? 2 : 3}
        className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
      />
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-2">
          {allowAttachments && (
            <>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <Paperclip className="w-3.5 h-3.5" />
                Attach
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                className="hidden"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
              {files.length > 0 && (
                <span className="text-[11px] text-muted-foreground">{files.length} file(s)</span>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!body.trim() || busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-teal-600 hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold px-3 py-1.5 transition-colors"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── Single comment bubble ──────────────────────────────────────────────────────

function CommentBubble({ comment, isReply = false }: { comment: CommentView; isReply?: boolean }) {
  const isSystem = comment.kind === "system";
  return (
    <div className={`flex gap-2.5 ${isReply ? "pl-4" : ""}`}>
      {isReply && <CornerDownRight className="w-3.5 h-3.5 text-muted-foreground/50 mt-2 shrink-0" />}
      <Avatar name={comment.authorName} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold">{comment.authorName}</span>
          <RoleChip role={comment.authorRole} />
          <span className="text-[10px] text-muted-foreground">{formatReviewTime(comment.createdAt)}</span>
        </div>
        <p className={`text-sm mt-1 whitespace-pre-wrap break-words ${isSystem ? "italic text-muted-foreground" : ""}`}>
          {comment.body}
        </p>
        <AttachmentList attachments={comment.attachments} />
      </div>
    </div>
  );
}

// ── Clarification card ─────────────────────────────────────────────────────────

function ClarificationCard({
  clarification,
  isStaff,
  onMutate,
}: {
  clarification: CommentView;
  isStaff: boolean;
  onMutate: () => void;
}) {
  // Both contributors and staff may post replies; contributors are the primary responders.
  const canRespond = true;
  const { toast } = useToast();
  const [showReply, setShowReply] = useState(false);
  const status = clarification.status ?? "open";

  const act = async (fn: () => Promise<unknown>, successMsg: string) => {
    try {
      await fn();
      toast({ title: successMsg });
      onMutate();
    } catch (e: any) {
      toast({ title: "Action failed", description: e?.message ?? "Please try again", variant: "destructive" });
    }
  };

  return (
    <div className={`rounded-xl border bg-card/60 backdrop-blur p-3.5 ${status === "resolved" ? "border-emerald-500/30" : status === "responded" ? "border-sky-500/30" : "border-amber-500/30"}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 text-xs font-bold">
            <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
            Clarification
          </span>
          <CategoryChip category={clarification.clarificationCategory} />
        </div>
        <StatusChip status={status} />
      </div>

      <CommentBubble comment={clarification} />

      {/* Replies */}
      {clarification.replies.length > 0 && (
        <div className="mt-3 space-y-3 border-l border-border/40 ml-3 pl-1">
          {clarification.replies.map((r) => (
            <CommentBubble key={r.id} comment={r} isReply />
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {canRespond && status !== "resolved" && (
          <button
            type="button"
            onClick={() => setShowReply((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-400 hover:text-teal-300 transition-colors"
          >
            <CornerDownRight className="w-3.5 h-3.5" />
            Respond
          </button>
        )}
        {isStaff && status === "responded" && (
          <button
            type="button"
            onClick={() => act(() => reviewApi.acknowledge(clarification.id), "Response acknowledged")}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-400 hover:text-sky-300 transition-colors"
          >
            <Eye className="w-3.5 h-3.5" />
            Acknowledge
          </button>
        )}
        {isStaff && status !== "resolved" && (
          <button
            type="button"
            onClick={() => act(() => reviewApi.resolve(clarification.id), "Clarification resolved")}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Resolve
          </button>
        )}
        {isStaff && status === "resolved" && (
          <button
            type="button"
            onClick={() => act(() => reviewApi.reopen(clarification.id), "Clarification reopened")}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-400 hover:text-amber-300 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reopen
          </button>
        )}
      </div>

      {showReply && canRespond && (
        <div className="mt-2">
          <Composer
            compact
            placeholder="Write your response and attach supporting evidence…"
            submitLabel="Submit response"
            onSubmit={async (body, files) => {
              await act(async () => {
                await reviewApi.respond(clarification.id, body, files);
                setShowReply(false);
              }, "Response submitted");
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function ReviewDiscussion({ projectId, deepLink }: { projectId: string; deepLink?: string }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { push } = useNotifications();
  const queryClient = useQueryClient();
  const isStaff = user?.role === "verifier" || user?.role === "admin";

  const [showRequest, setShowRequest] = useState(false);
  const [category, setCategory] = useState<ClarificationCategory>("boundary");

  const { data: thread, isLoading } = useQuery({
    queryKey: ["/api/projects", projectId, "review-thread"],
    queryFn: () => reviewApi.getThread(projectId),
    throwOnError: false,
    refetchInterval: 60_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "review-thread"] });
    queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "review-timeline"] });
    queryClient.invalidateQueries({ queryKey: ["/api/review/inbox"] });
  };

  // Emit notifications for activity from others (Phase 5).
  useEffect(() => {
    if (thread && user?.id) {
      emitThreadNotifications({
        thread,
        currentUserId: user.id,
        push,
        href: deepLink ?? `/operations/project/${projectId}`,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, user?.id]);

  const requestMutation = useMutation({
    mutationFn: (body: string) => reviewApi.requestClarification(projectId, body, category),
    onSuccess: () => {
      toast({ title: "Clarification requested" });
      setShowRequest(false);
      invalidate();
    },
    onError: (e: any) => toast({ title: "Failed", description: e?.message, variant: "destructive" }),
  });

  const counts = thread?.counts;
  const sortedClarifications = useMemo(() => {
    const order: Record<string, number> = { open: 0, responded: 1, resolved: 2 };
    return [...(thread?.clarifications ?? [])].sort(
      (a, b) => (order[a.status ?? "open"] ?? 0) - (order[b.status ?? "open"] ?? 0),
    );
  }, [thread]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-teal-500/12 flex items-center justify-center">
            <ShieldCheck className="w-4 h-4 text-teal-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold leading-tight">Review & Discussion</h3>
            <p className="text-[11px] text-muted-foreground leading-tight">
              Collaborative ecological verification — permanently attached to this project
            </p>
          </div>
        </div>
        {counts && (
          <div className="flex items-center gap-2 text-[11px]">
            {counts.openClarifications > 0 && (
              <span className="rounded-full bg-amber-500/12 text-amber-400 px-2 py-0.5 font-semibold">{counts.openClarifications} open</span>
            )}
            {counts.respondedClarifications > 0 && (
              <span className="rounded-full bg-sky-500/12 text-sky-400 px-2 py-0.5 font-semibold">{counts.respondedClarifications} responded</span>
            )}
            {counts.resolvedClarifications > 0 && (
              <span className="rounded-full bg-emerald-500/12 text-emerald-400 px-2 py-0.5 font-semibold">{counts.resolvedClarifications} resolved</span>
            )}
          </div>
        )}
      </div>

      {/* Clarifications section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Clarifications</h4>
          {isStaff && (
            <button
              type="button"
              onClick={() => setShowRequest((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-400 text-[11px] font-semibold px-2.5 py-1 hover:bg-amber-500/20 transition-colors"
            >
              <HelpCircle className="w-3.5 h-3.5" />
              Request Clarification
            </button>
          )}
        </div>

        {showRequest && isStaff && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.04] p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">Category:</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as ClarificationCategory)}
                className="text-[11px] bg-background border border-border/50 rounded-md px-2 py-1 focus-ring"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CLARIFICATION_CATEGORY_META[c]?.label ?? c}
                  </option>
                ))}
              </select>
            </div>
            <Composer
              compact
              allowAttachments={false}
              placeholder="Describe what needs clarification from the contributor…"
              submitLabel="Send request"
              onSubmit={async (body) => {
                await requestMutation.mutateAsync(body);
              }}
            />
          </div>
        )}

        {isLoading && <div className="text-xs text-muted-foreground animate-pulse py-2">Loading discussion…</div>}
        {!isLoading && sortedClarifications.length === 0 && !showRequest && (
          <div className="rounded-xl border border-dashed border-border/50 p-5 text-center text-xs text-muted-foreground">
            No clarifications requested yet.
          </div>
        )}
        {sortedClarifications.map((c) => (
          <ClarificationCard
            key={c.id}
            clarification={c}
            isStaff={isStaff}
            onMutate={invalidate}
          />
        ))}
      </section>

      {/* General discussion */}
      <section className="space-y-3">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5" />
          Discussion
        </h4>

        <div className="space-y-4">
          {(thread?.comments ?? []).map((c) => (
            <div key={c.id} className="rounded-xl border border-border/50 bg-card/40 p-3.5">
              <CommentBubble comment={c} />
              {c.replies.length > 0 && (
                <div className="mt-3 space-y-3 border-l border-border/40 ml-3 pl-1">
                  {c.replies.map((r) => (
                    <CommentBubble key={r.id} comment={r} isReply />
                  ))}
                </div>
              )}
              <div className="mt-2">
                <ReplyToggle commentId={c.id} projectId={projectId} onDone={invalidate} />
              </div>
            </div>
          ))}
          {!isLoading && (thread?.comments?.length ?? 0) === 0 && (
            <div className="text-xs text-muted-foreground">Start the discussion below.</div>
          )}
        </div>

        <Composer
          placeholder="Add a comment to the review discussion…"
          onSubmit={async (body, files) => {
            try {
              await reviewApi.addComment(projectId, body, undefined, files);
              invalidate();
            } catch (e: any) {
              toast({ title: "Failed to post comment", description: e?.message, variant: "destructive" });
            }
          }}
        />
      </section>
    </div>
  );
}

function ReplyToggle({ commentId, projectId, onDone }: { commentId: string; projectId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <CornerDownRight className="w-3.5 h-3.5" />
        Reply
      </button>
    );
  }
  return (
    <Composer
      compact
      placeholder="Write a reply…"
      submitLabel="Reply"
      onSubmit={async (body, files) => {
        try {
          await reviewApi.addComment(projectId, body, commentId, files);
          setOpen(false);
          onDone();
        } catch (e: any) {
          toast({ title: "Failed to reply", description: e?.message, variant: "destructive" });
        }
      }}
    />
  );
}
