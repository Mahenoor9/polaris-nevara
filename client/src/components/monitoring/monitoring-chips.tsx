/**
 * Monitoring UX chips & badges — PHASE OPS-1 (Phase 7 polish)
 * Small, reusable presentational pieces for monitoring state across the app.
 */
import { Clock, CalendarClock, AlertTriangle, CheckCircle2, Loader2, XCircle, PauseCircle } from "lucide-react";
import {
  STATE_META,
  FREQUENCY_LABEL,
  formatCountdown,
  type MonitoringLifecycleState,
  type MonitoringFrequency,
} from "@/lib/monitoring-api";

const STATE_ICON: Record<MonitoringLifecycleState, React.ElementType> = {
  upcoming: CalendarClock,
  due_soon: Clock,
  running: Loader2,
  completed: CheckCircle2,
  overdue: AlertTriangle,
  failed: XCircle,
  disabled: PauseCircle,
};

/** Pill showing the derived monitoring lifecycle state. */
export function MonitoringStateChip({
  state,
  className = "",
}: {
  state: MonitoringLifecycleState;
  className?: string;
}) {
  const meta = STATE_META[state];
  const Icon = STATE_ICON[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${meta.bg} ${meta.text} ${meta.border} ${className}`}
    >
      <Icon className={`w-3 h-3 ${state === "running" ? "animate-spin" : ""}`} />
      {meta.label}
    </span>
  );
}

/** Countdown badge with subtle urgency cue. */
export function CountdownBadge({
  daysUntilDue,
  className = "",
}: {
  daysUntilDue: number;
  className?: string;
}) {
  const overdue = daysUntilDue < 0;
  const urgent = daysUntilDue >= 0 && daysUntilDue <= 7;
  const tone = overdue
    ? "text-red-400 bg-red-500/10 border-red-500/40"
    : urgent
    ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
    : "text-muted-foreground bg-muted/40 border-border/50";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium tabular-nums ${tone} ${className}`}
    >
      <Clock className={`w-3 h-3 ${overdue ? "animate-pulse" : ""}`} />
      {formatCountdown(daysUntilDue)}
    </span>
  );
}

/** Frequency chip with a colour dot. */
export function FrequencyChip({
  frequency,
  colorTag,
  className = "",
}: {
  frequency: MonitoringFrequency;
  colorTag?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground ${className}`}
    >
      {colorTag && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colorTag }} />}
      {FREQUENCY_LABEL[frequency]}
    </span>
  );
}
