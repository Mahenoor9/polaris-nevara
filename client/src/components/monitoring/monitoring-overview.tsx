/**
 * Monitoring Overview — PHASE OPS-1 (Phase 4 + Phase 7)
 * Summary cards + upcoming/overdue list with inline schedule controls.
 * Shared by the contributor dashboard and operations dashboard.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  CalendarClock,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Satellite,
  ChevronRight,
} from "lucide-react";
import {
  monitoringApi,
  formatCountdown,
  formatScheduleDate,
  FREQUENCY_LABEL,
  type MonitoringFrequency,
  type ScheduleSnapshot,
} from "@/lib/monitoring-api";
import { MonitoringStateChip, CountdownBadge } from "./monitoring-chips";

const FREQ_OPTIONS: MonitoringFrequency[] = ["weekly", "biweekly", "monthly", "quarterly", "yearly"];

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  tone: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur p-3 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tone}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <div className="text-lg font-bold leading-none tabular-nums">{value}</div>
        <div className="text-[11px] text-muted-foreground truncate">{label}</div>
      </div>
    </div>
  );
}

export function MonitoringOverview({
  linkBase = "/operations/project",
  linkSuffix = "",
  canEdit = true,
  title = "Monitoring Schedule",
}: {
  linkBase?: string;
  linkSuffix?: string;
  canEdit?: boolean;
  title?: string;
}) {
  const [, navigate] = useLocation();
  const openProject = (id: string) => navigate(`${linkBase}/${id}${linkSuffix}`);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["/api/monitoring/schedule"],
    queryFn: () => monitoringApi.getSchedule(),
    throwOnError: false,
  });

  const mutation = useMutation({
    mutationFn: ({ projectId, payload }: { projectId: string; payload: any }) =>
      monitoringApi.updateSchedule(projectId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitoring/schedule"] });
      queryClient.invalidateQueries({ queryKey: ["/api/monitoring/calendar"] });
      queryClient.invalidateQueries({ queryKey: ["/api/monitoring/queue"] });
    },
  });

  const summary = data?.summary;
  const snapshots = data?.snapshots ?? [];

  // Prioritised list: overdue & due soon first, then upcoming.
  const prioritised = [...snapshots]
    .filter((s) => s.state !== "disabled")
    .sort((a, b) => {
      const rank = (s: ScheduleSnapshot) =>
        s.state === "overdue" ? 0 : s.state === "due_soon" ? 1 : s.state === "running" ? 2 : 3;
      return rank(a) - rank(b) || a.daysUntilDue - b.daysUntilDue;
    })
    .slice(0, 8);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Satellite className="w-4 h-4 text-teal-400" />
          {title}
        </h3>
        {summary && summary.next && (
          <span className="text-[11px] text-muted-foreground">
            Next: <span className="font-medium text-foreground">{summary.next.projectName}</span> ·{" "}
            {formatCountdown(summary.next.daysUntilDue)}
          </span>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <StatCard icon={CalendarClock} label="Due Soon (7d)" value={summary?.dueSoonCount ?? 0} tone="bg-amber-500/12 text-amber-400" />
        <StatCard icon={AlertTriangle} label="Overdue" value={summary?.overdueCount ?? 0} tone="bg-red-500/12 text-red-400" />
        <StatCard icon={Loader2} label="Running" value={summary?.runningCount ?? 0} tone="bg-violet-500/12 text-violet-400" />
        <StatCard icon={CheckCircle2} label="Completed (7d)" value={summary?.completedCount ?? 0} tone="bg-emerald-500/12 text-emerald-400" />
      </div>

      {/* Overdue banner */}
      {summary && summary.overdueCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-xs text-red-300 page-enter">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            {summary.overdueCount} monitoring {summary.overdueCount === 1 ? "cycle is" : "cycles are"} overdue and need attention.
          </span>
        </div>
      )}

      {/* Upcoming / prioritised list */}
      <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur divide-y divide-border/40">
        {isLoading && (
          <div className="p-6 text-center text-xs text-muted-foreground animate-pulse">Loading monitoring schedule…</div>
        )}
        {!isLoading && prioritised.length === 0 && (
          <div className="p-6 text-center text-xs text-muted-foreground">No active monitoring schedules.</div>
        )}
        {prioritised.map((s) => (
          <div key={s.projectId} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/30 transition-colors group">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.colorTag }} />
            <button
              type="button"
              onClick={() => openProject(s.projectId)}
              className="flex-1 min-w-0 text-left"
            >
              <div className="text-xs font-semibold truncate group-hover:text-teal-400 transition-colors">
                {s.projectName}
              </div>
              <div className="text-[11px] text-muted-foreground truncate">
                {s.ecosystemType ?? "—"} · {formatScheduleDate(s.nextMonitoringDate)}
              </div>
            </button>

            <CountdownBadge daysUntilDue={s.daysUntilDue} className="hidden sm:inline-flex" />
            <MonitoringStateChip state={s.state} />

            {canEdit ? (
              <select
                value={s.frequency}
                disabled={mutation.isPending}
                onChange={(e) =>
                  mutation.mutate({
                    projectId: s.projectId,
                    payload: { monitoringFrequency: e.target.value as MonitoringFrequency },
                  })
                }
                className="hidden md:block text-[11px] bg-background border border-border/50 rounded-md px-1.5 py-1 focus-ring"
                aria-label="Monitoring frequency"
              >
                {FREQ_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_LABEL[f]}
                  </option>
                ))}
              </select>
            ) : (
              <span className="hidden md:inline text-[11px] text-muted-foreground">{FREQUENCY_LABEL[s.frequency]}</span>
            )}

            <ChevronRight
              className="w-4 h-4 text-muted-foreground/50 group-hover:text-foreground transition-colors cursor-pointer"
              onClick={() => openProject(s.projectId)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
