/**
 * Monitoring Calendar — PHASE OPS-1 (Phase 3)
 * Institutional monthly calendar of monitoring events with project colour tags,
 * overdue highlighting, completed badges, and click-to-open navigation.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, CalendarDays, CheckCircle2, AlertTriangle } from "lucide-react";
import { monitoringApi, type MonitoringCalendarEvent } from "@/lib/monitoring-api";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function isToday(d: Date) {
  return sameDay(d, new Date());
}

export function MonitoringCalendar({
  linkBase = "/operations/project",
  linkSuffix = "",
}: {
  linkBase?: string;
  linkSuffix?: string;
}) {
  const [, navigate] = useLocation();
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));

  const { data, isLoading } = useQuery({
    queryKey: ["/api/monitoring/calendar"],
    queryFn: () => monitoringApi.getCalendar(),
    throwOnError: false,
  });

  const eventsByDay = useMemo(() => {
    const map = new Map<string, MonitoringCalendarEvent[]>();
    for (const ev of data?.events ?? []) {
      const d = new Date(ev.date);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ev);
    }
    return map;
  }, [data]);

  // Build the 6x7 grid of days for the current month view.
  const cells = useMemo(() => {
    const first = startOfMonth(cursor);
    const startOffset = first.getDay();
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - startOffset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      return d;
    });
  }, [cursor]);

  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur p-4 sm:p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-teal-500/12 flex items-center justify-center">
            <CalendarDays className="w-4 h-4 text-teal-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold leading-tight">Monitoring Calendar</h3>
            <p className="text-[11px] text-muted-foreground leading-tight">Scheduled & completed monitoring</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-border/50 hover:bg-muted/60 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs font-semibold min-w-[120px] text-center tabular-nums">{monthLabel}</span>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-border/50 hover:bg-muted/60 transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setCursor(startOfMonth(new Date()))}
            className="ml-1 text-[11px] font-medium px-2 h-8 rounded-lg border border-border/50 hover:bg-muted/60 transition-colors"
          >
            Today
          </button>
        </div>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-[10px] font-semibold text-muted-foreground text-center py-1 uppercase tracking-wide">
            {w}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, idx) => {
          const inMonth = day.getMonth() === cursor.getMonth();
          const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
          const dayEvents = eventsByDay.get(key) ?? [];
          const hasOverdue = dayEvents.some((e) => e.type === "due" && e.state === "overdue");
          return (
            <div
              key={idx}
              className={`group relative min-h-[68px] rounded-lg border p-1.5 transition-colors ${
                inMonth ? "border-border/40 bg-background/40" : "border-transparent bg-transparent opacity-40"
              } ${hasOverdue ? "ring-1 ring-red-500/40 bg-red-500/[0.04]" : ""} ${
                isToday(day) ? "border-teal-500/50 bg-teal-500/[0.05]" : ""
              } hover:border-border`}
            >
              <div
                className={`text-[10px] font-semibold mb-1 ${
                  isToday(day) ? "text-teal-400" : "text-muted-foreground"
                }`}
              >
                {day.getDate()}
              </div>
              <div className="space-y-0.5">
                {dayEvents.slice(0, 3).map((ev, i) => (
                  <button
                    key={i}
                    type="button"
                    title={`${ev.projectName} — ${ev.type === "completed" ? "Completed" : "Monitoring due"}`}
                    onClick={() => navigate(`${linkBase}/${ev.projectId}${linkSuffix}`)}
                    className={`w-full flex items-center gap-1 rounded px-1 py-[3px] text-[10px] font-medium truncate transition-transform hover:scale-[1.02] ${
                      ev.state === "overdue"
                        ? "bg-red-500/15 text-red-300"
                        : ev.type === "completed"
                        ? "bg-emerald-500/12 text-emerald-300"
                        : "text-foreground/90"
                    }`}
                    style={
                      ev.state !== "overdue" && ev.type !== "completed"
                        ? { backgroundColor: ev.colorTag.replace(")", " / 0.14)") }
                        : undefined
                    }
                  >
                    {ev.type === "completed" ? (
                      <CheckCircle2 className="w-2.5 h-2.5 shrink-0" />
                    ) : ev.state === "overdue" ? (
                      <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: ev.colorTag }} />
                    )}
                    <span className="truncate">{ev.projectName}</span>
                  </button>
                ))}
                {dayEvents.length > 3 && (
                  <div className="text-[9px] text-muted-foreground pl-1">+{dayEvents.length - 3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-4 pt-3 border-t border-border/40 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-400" /> Upcoming</span>
        <span className="inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-red-400" /> Overdue</span>
        <span className="inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-emerald-400" /> Completed</span>
        {isLoading && <span className="ml-auto animate-pulse">Loading…</span>}
        {!isLoading && (data?.events?.length ?? 0) === 0 && <span className="ml-auto">No monitoring events</span>}
      </div>
    </div>
  );
}
