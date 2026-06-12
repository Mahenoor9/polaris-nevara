/**
 * Monitoring Scheduler API client — PHASE OPS-1
 * Typed fetchers + display helpers for the operational monitoring layer.
 */

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("bluecarbon_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function safeJson<T>(res: Response): Promise<T> {
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  if (!ct.includes("application/json")) throw new Error("Unexpected non-JSON response");
  return res.json() as Promise<T>;
}

// ─── Types (mirror server scheduler service) ────────────────────────────────

export type MonitoringFrequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";

export type MonitoringLifecycleState =
  | "upcoming"
  | "due_soon"
  | "running"
  | "completed"
  | "overdue"
  | "failed"
  | "disabled";

export interface ScheduleSnapshot {
  projectId: string;
  projectName: string;
  ecosystemType: string | null;
  location: string | null;
  projectStatus: string;
  monitoringEnabled: boolean;
  frequency: MonitoringFrequency;
  nextMonitoringDate: string;
  nextDateDerived: boolean;
  lastMonitoringDate: string | null;
  daysUntilDue: number;
  state: MonitoringLifecycleState;
  isOverdue: boolean;
  recentlyCompleted: boolean;
  mrvStatus: string;
  colorTag: string;
  cron: string;
}

export interface MonitoringSummary {
  total: number;
  overdueCount: number;
  dueSoonCount: number;
  runningCount: number;
  completedCount: number;
  next: ScheduleSnapshot | null;
  recentlyCompleted: ScheduleSnapshot[];
}

export type CalendarEventType = "due" | "completed";

export interface MonitoringCalendarEvent {
  projectId: string;
  projectName: string;
  ecosystemType: string | null;
  date: string;
  type: CalendarEventType;
  state: MonitoringLifecycleState;
  colorTag: string;
  daysUntilDue: number;
  frequency: MonitoringFrequency;
}

export interface MonitoringQueueItem {
  projectId: string;
  projectName: string;
  frequency: MonitoringFrequency;
  scheduledFor: string;
  reason: "overdue" | "due";
  priority: number;
  cron: string;
}

export interface MonitoringQueue {
  overdue: ScheduleSnapshot[];
  dueSoon: ScheduleSnapshot[];
  upcoming: ScheduleSnapshot[];
  running: ScheduleSnapshot[];
  completed: ScheduleSnapshot[];
  failed: ScheduleSnapshot[];
  disabled: ScheduleSnapshot[];
  counts: Record<MonitoringLifecycleState, number> & { total: number };
}

// ─── Fetchers ───────────────────────────────────────────────────────────────

export const monitoringApi = {
  getSchedule: async () =>
    safeJson<{ snapshots: ScheduleSnapshot[]; summary: MonitoringSummary; frequencies: MonitoringFrequency[] }>(
      await fetch("/api/monitoring/schedule", { headers: getAuthHeaders() }),
    ),
  getCalendar: async () =>
    safeJson<{ events: MonitoringCalendarEvent[] }>(
      await fetch("/api/monitoring/calendar", { headers: getAuthHeaders() }),
    ),
  getQueue: async () =>
    safeJson<{ queue: MonitoringQueue; pending: MonitoringQueueItem[]; summary: MonitoringSummary }>(
      await fetch("/api/monitoring/queue", { headers: getAuthHeaders() }),
    ),
  updateSchedule: async (
    projectId: string,
    payload: { monitoringFrequency?: MonitoringFrequency; monitoringEnabled?: boolean; nextMonitoringDue?: string },
  ) => {
    const res = await fetch(`/api/projects/${projectId}/monitoring-schedule`, {
      method: "PATCH",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return safeJson<{ ok: boolean; snapshot: ScheduleSnapshot | null }>(res);
  },
};

// ─── Display helpers (shared across calendar, dashboards, chips) ─────────────

export const STATE_META: Record<
  MonitoringLifecycleState,
  { label: string; text: string; bg: string; border: string; dot: string }
> = {
  upcoming: { label: "Upcoming", text: "text-sky-400", bg: "bg-sky-500/10", border: "border-sky-500/30", dot: "bg-sky-400" },
  due_soon: { label: "Due Soon", text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30", dot: "bg-amber-400" },
  running: { label: "Running", text: "text-violet-400", bg: "bg-violet-500/10", border: "border-violet-500/30", dot: "bg-violet-400" },
  completed: { label: "Completed", text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30", dot: "bg-emerald-400" },
  overdue: { label: "Overdue", text: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/40", dot: "bg-red-400" },
  failed: { label: "Failed", text: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/30", dot: "bg-rose-400" },
  disabled: { label: "Paused", text: "text-muted-foreground", bg: "bg-muted/40", border: "border-border/50", dot: "bg-muted-foreground" },
};

export const FREQUENCY_LABEL: Record<MonitoringFrequency, string> = {
  weekly: "Weekly",
  biweekly: "Bi-weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

/** Human countdown string from whole-day difference. */
export function formatCountdown(daysUntilDue: number): string {
  if (daysUntilDue < 0) {
    const d = Math.abs(daysUntilDue);
    return d === 1 ? "1 day overdue" : `${d} days overdue`;
  }
  if (daysUntilDue === 0) return "Due today";
  if (daysUntilDue === 1) return "Due tomorrow";
  if (daysUntilDue < 7) return `In ${daysUntilDue} days`;
  if (daysUntilDue < 14) return "In 1 week";
  if (daysUntilDue < 30) return `In ${Math.round(daysUntilDue / 7)} weeks`;
  if (daysUntilDue < 60) return "In 1 month";
  return `In ${Math.round(daysUntilDue / 30)} months`;
}

export function formatScheduleDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
