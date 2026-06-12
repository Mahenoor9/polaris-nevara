/**
 * Review Inbox — PHASE OPS-2 (Phase 6)
 * Operations-wide triage of clarifications: awaiting verifier, awaiting
 * contributor, resolved, and overdue — with category filtering.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Inbox, AlertTriangle, Clock, Reply, CheckCircle2, ChevronRight } from "lucide-react";
import {
  reviewApi,
  CLARIFICATION_CATEGORY_META,
  formatReviewTime,
  type InboxItem,
} from "@/lib/review-api";

type Filter = "awaitingVerifier" | "awaitingContributor" | "overdue" | "resolved";

const TABS: { key: Filter; label: string; icon: React.ElementType; tone: string }[] = [
  { key: "awaitingVerifier", label: "Awaiting Verifier", icon: Reply, tone: "text-sky-400 bg-sky-500/12" },
  { key: "awaitingContributor", label: "Awaiting Contributor", icon: Clock, tone: "text-amber-400 bg-amber-500/12" },
  { key: "overdue", label: "Overdue", icon: AlertTriangle, tone: "text-red-400 bg-red-500/12" },
  { key: "resolved", label: "Resolved", icon: CheckCircle2, tone: "text-emerald-400 bg-emerald-500/12" },
];

const CATEGORY_OPTIONS = ["all", "boundary", "ecosystem", "monitoring", "evidence", "document"];

export function ReviewInbox({ linkBase = "/operations/project" }: { linkBase?: string }) {
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<Filter>("awaitingVerifier");
  const [category, setCategory] = useState<string>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["/api/review/inbox"],
    queryFn: () => reviewApi.getInbox(),
    throwOnError: false,
    refetchInterval: 60_000,
  });

  const items: InboxItem[] = useMemo(() => {
    const list = (data?.[filter] ?? []) as InboxItem[];
    return category === "all" ? list : list.filter((i) => i.category === category);
  }, [data, filter, category]);

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 p-4 border-b border-border/40 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-teal-500/12 flex items-center justify-center">
            <Inbox className="w-4 h-4 text-teal-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold leading-tight">Review Inbox</h3>
            <p className="text-[11px] text-muted-foreground leading-tight">Clarification triage across all projects</p>
          </div>
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="text-[11px] bg-background border border-border/50 rounded-md px-2 py-1.5 focus-ring"
          aria-label="Filter by category"
        >
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {c === "all" ? "All Categories" : CLARIFICATION_CATEGORY_META[c]?.label ?? c}
            </option>
          ))}
        </select>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-2 border-b border-border/40 overflow-x-auto">
        {TABS.map((tab) => {
          const count = data?.counts?.[tab.key] ?? 0;
          const active = filter === tab.key;
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter(tab.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold whitespace-nowrap transition-colors ${
                active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"
              }`}
            >
              <Icon className={`w-3.5 h-3.5 ${active ? "" : "opacity-70"}`} />
              {tab.label}
              <span className={`rounded-full px-1.5 text-[10px] ${tab.tone}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* List */}
      <div className="divide-y divide-border/30 max-h-[420px] overflow-y-auto">
        {isLoading && <div className="p-6 text-center text-xs text-muted-foreground animate-pulse">Loading inbox…</div>}
        {!isLoading && items.length === 0 && (
          <div className="p-8 text-center text-xs text-muted-foreground">Nothing here. 🎉</div>
        )}
        {items.map((item) => {
          const catMeta = item.category ? CLARIFICATION_CATEGORY_META[item.category] : null;
          return (
            <button
              key={item.clarificationId}
              type="button"
              onClick={() => navigate(`${linkBase}/${item.projectId}`)}
              className="w-full text-left px-4 py-3 hover:bg-muted/30 transition-colors group flex items-start gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  {catMeta && (
                    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${catMeta.bg} ${catMeta.text}`}>
                      {catMeta.label}
                    </span>
                  )}
                  {item.overdue && (
                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-red-500/12 text-red-400">
                      <AlertTriangle className="w-2.5 h-2.5" />
                      {item.ageDays}d overdue
                    </span>
                  )}
                </div>
                <p className="text-xs text-foreground/90 line-clamp-2 group-hover:text-teal-400 transition-colors">{item.body}</p>
                <div className="text-[10px] text-muted-foreground mt-1">
                  by {item.author} · {formatReviewTime(item.createdAt)}
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-foreground transition-colors mt-1 shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
