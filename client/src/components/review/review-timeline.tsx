/**
 * Review Timeline — PHASE OPS-2 (Phase 4)
 * Chronological, immutable history of the project's verification lifecycle,
 * sourced from the append-only audit log.
 */
import { useQuery } from "@tanstack/react-query";
import {
  FilePlus,
  ShieldCheck,
  HelpCircle,
  Reply,
  CheckCircle2,
  RotateCcw,
  Eye,
  XCircle,
  UserCheck,
  MessageSquare,
  History,
} from "lucide-react";
import { reviewApi, formatReviewTime, type TimelineEntry } from "@/lib/review-api";

const ICONS: Record<string, { icon: React.ElementType; tone: string }> = {
  PROJECT_SUBMITTED: { icon: FilePlus, tone: "text-sky-400 bg-sky-500/12" },
  PROJECT_APPROVED: { icon: ShieldCheck, tone: "text-emerald-400 bg-emerald-500/12" },
  PROJECT_REJECTED: { icon: XCircle, tone: "text-red-400 bg-red-500/12" },
  PROJECT_CLARIFICATION_REQUESTED: { icon: HelpCircle, tone: "text-amber-400 bg-amber-500/12" },
  VERIFIER_ASSIGNED: { icon: UserCheck, tone: "text-violet-400 bg-violet-500/12" },
  REVIEW_COMMENT_ADDED: { icon: MessageSquare, tone: "text-sky-400 bg-sky-500/12" },
  REVIEW_CLARIFICATION_REQUESTED: { icon: HelpCircle, tone: "text-amber-400 bg-amber-500/12" },
  REVIEW_CLARIFICATION_RESPONDED: { icon: Reply, tone: "text-sky-400 bg-sky-500/12" },
  REVIEW_CLARIFICATION_RESOLVED: { icon: CheckCircle2, tone: "text-emerald-400 bg-emerald-500/12" },
  REVIEW_CLARIFICATION_REOPENED: { icon: RotateCcw, tone: "text-amber-400 bg-amber-500/12" },
  REVIEW_CLARIFICATION_ACKNOWLEDGED: { icon: Eye, tone: "text-violet-400 bg-violet-500/12" },
};

function entryIcon(type: string) {
  return ICONS[type] ?? { icon: History, tone: "text-muted-foreground bg-muted/40" };
}

export function ReviewTimeline({ projectId }: { projectId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/projects", projectId, "review-timeline"],
    queryFn: () => reviewApi.getTimeline(projectId),
    throwOnError: false,
    refetchInterval: 60_000,
  });

  const timeline: TimelineEntry[] = data?.timeline ?? [];

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur p-4">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-lg bg-teal-500/12 flex items-center justify-center">
          <History className="w-4 h-4 text-teal-400" />
        </div>
        <div>
          <h3 className="text-sm font-semibold leading-tight">Review Timeline</h3>
          <p className="text-[11px] text-muted-foreground leading-tight">Chronological & immutable verification history</p>
        </div>
      </div>

      {isLoading && <div className="text-xs text-muted-foreground animate-pulse py-2">Loading timeline…</div>}
      {!isLoading && timeline.length === 0 && (
        <div className="text-xs text-muted-foreground py-2">No review activity recorded yet.</div>
      )}

      <ol className="relative space-y-4">
        {timeline.map((entry, idx) => {
          const { icon: Icon, tone } = entryIcon(entry.type);
          const isLast = idx === timeline.length - 1;
          return (
            <li key={entry.id} className="relative flex gap-3">
              {!isLast && <span className="absolute left-[15px] top-8 bottom-[-16px] w-px bg-border/50" />}
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${tone}`}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0 pt-1">
                <div className="text-xs font-semibold">{entry.title}</div>
                {entry.detail && <div className="text-[11px] text-muted-foreground">{entry.detail}</div>}
                <div className="text-[10px] text-muted-foreground/80 mt-0.5">{formatReviewTime(entry.timestamp)}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
