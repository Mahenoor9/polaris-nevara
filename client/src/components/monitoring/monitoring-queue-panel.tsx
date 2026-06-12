/**
 * Monitoring Queue Panel — PHASE OPS-1 (Phase 4)
 * Operations-only view of the monitoring pipeline: overdue, due soon, running,
 * and upcoming. Backed by the queue endpoint (verifier/admin).
 */
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, Clock, Loader2, CalendarClock, ListChecks } from "lucide-react";
import {
  monitoringApi,
  formatCountdown,
  formatScheduleDate,
  type ScheduleSnapshot,
} from "@/lib/monitoring-api";

function QueueColumn({
  title,
  icon: Icon,
  tone,
  items,
  emptyLabel,
  onOpen,
}: {
  title: string;
  icon: React.ElementType;
  tone: string;
  items: ScheduleSnapshot[];
  emptyLabel: string;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/40">
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${tone}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
        <span className="text-xs font-semibold">{title}</span>
        <span className="ml-auto text-[11px] font-bold tabular-nums text-muted-foreground">{items.length}</span>
      </div>
      <div className="divide-y divide-border/30 max-h-[280px] overflow-y-auto">
        {items.length === 0 && <div className="p-4 text-center text-[11px] text-muted-foreground">{emptyLabel}</div>}
        {items.map((s) => (
          <button
            key={s.projectId}
            type="button"
            onClick={() => onOpen(s.projectId)}
            className="w-full text-left px-3 py-2 hover:bg-muted/30 transition-colors group"
          >
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.colorTag }} />
              <span className="text-xs font-medium truncate flex-1 group-hover:text-teal-400 transition-colors">
                {s.projectName}
              </span>
            </div>
            <div className="flex items-center justify-between mt-1 pl-4">
              <span className="text-[10px] text-muted-foreground">{formatScheduleDate(s.nextMonitoringDate)}</span>
              <span
                className={`text-[10px] font-medium ${
                  s.daysUntilDue < 0 ? "text-red-400" : s.daysUntilDue <= 7 ? "text-amber-400" : "text-muted-foreground"
                }`}
              >
                {formatCountdown(s.daysUntilDue)}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export function MonitoringQueuePanel({ linkBase = "/operations/project" }: { linkBase?: string }) {
  const [, navigate] = useLocation();
  const { data, isLoading } = useQuery({
    queryKey: ["/api/monitoring/queue"],
    queryFn: () => monitoringApi.getQueue(),
    throwOnError: false,
  });

  const queue = data?.queue;
  const open = (id: string) => navigate(`${linkBase}/${id}`);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-teal-400" />
          Monitoring Queue
        </h3>
        {data?.pending && data.pending.length > 0 && (
          <span className="text-[11px] text-amber-400 font-medium">
            {data.pending.length} ready for scheduled run
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-border/60 bg-card/60 p-6 text-center text-xs text-muted-foreground animate-pulse">
          Loading monitoring queue…
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <QueueColumn
            title="Overdue"
            icon={AlertTriangle}
            tone="bg-red-500/12 text-red-400"
            items={queue?.overdue ?? []}
            emptyLabel="Nothing overdue"
            onOpen={open}
          />
          <QueueColumn
            title="Due Soon"
            icon={Clock}
            tone="bg-amber-500/12 text-amber-400"
            items={queue?.dueSoon ?? []}
            emptyLabel="Nothing due soon"
            onOpen={open}
          />
          <QueueColumn
            title="Running"
            icon={Loader2}
            tone="bg-violet-500/12 text-violet-400"
            items={queue?.running ?? []}
            emptyLabel="No active jobs"
            onOpen={open}
          />
          <QueueColumn
            title="Upcoming"
            icon={CalendarClock}
            tone="bg-sky-500/12 text-sky-400"
            items={queue?.upcoming ?? []}
            emptyLabel="Nothing upcoming"
            onOpen={open}
          />
        </div>
      )}
    </div>
  );
}
