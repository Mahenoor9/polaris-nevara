/**
 * Monitoring Schedule Service — PHASE OPS-1
 * ─────────────────────────────────────────────────────────────────────────────
 * Isolated, dependency-free scheduling engine for NEVARA's operational
 * monitoring workflow. This module is intentionally PURE: it imports no storage,
 * no orchestrator, and performs no side effects. It only derives schedule
 * snapshots, lifecycle states, calendar events, and queue structures from plain
 * project records.
 *
 * Design goals:
 *   - cron-safe   → all date math is deterministic and timezone-stable (UTC day math)
 *   - queue-ready → exposes MonitoringQueueItem structures for a future AWS worker
 *   - additive    → does NOT trigger MRV; only prepares/derives
 *
 * The existing `monitoring-scheduler.ts` (node-cron) and
 * `monitoring-orchestrator.ts` (execution) remain untouched. This service is the
 * read/derivation layer that powers the calendar, dashboards, and reminders.
 */

import type { Project } from "@shared/schema";

// ─── Frequency model ────────────────────────────────────────────────────────

export type MonitoringFrequency =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "yearly";

/** Canonical interval lengths in days. Backward compatible with legacy values. */
export const FREQUENCY_INTERVAL_DAYS: Record<MonitoringFrequency, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 90,
  yearly: 365,
};

export const MONITORING_FREQUENCIES: MonitoringFrequency[] = [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
];

/** Default applied to projects with no explicit frequency. */
export const DEFAULT_FREQUENCY: MonitoringFrequency = "quarterly";

/** "Due soon" horizon in days (Phase 2 rule). */
export const DUE_SOON_DAYS = 7;

/** Window during which a finished run is surfaced as "completed". */
const RECENTLY_COMPLETED_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeFrequency(value: string | null | undefined): MonitoringFrequency {
  if (value && (MONITORING_FREQUENCIES as string[]).includes(value)) {
    return value as MonitoringFrequency;
  }
  return DEFAULT_FREQUENCY;
}

export function frequencyToDays(value: string | null | undefined): number {
  return FREQUENCY_INTERVAL_DAYS[normalizeFrequency(value)];
}

/** Compute the next monitoring date by adding one interval to an anchor date. */
export function computeNextMonitoringDate(
  from: Date,
  frequency: string | null | undefined,
): Date {
  return new Date(from.getTime() + frequencyToDays(frequency) * DAY_MS);
}

/**
 * Cron-safe helper: translate a frequency into a coarse cron expression.
 * Used only to document the cadence for future workers — not wired to execution.
 */
export function frequencyToCron(frequency: string | null | undefined): string {
  switch (normalizeFrequency(frequency)) {
    case "weekly":
      return "0 6 * * 1"; // Mondays 06:00
    case "biweekly":
      return "0 6 1,15 * *"; // 1st & 15th 06:00
    case "monthly":
      return "0 6 1 * *"; // 1st of month 06:00
    case "quarterly":
      return "0 6 1 1,4,7,10 *"; // quarter starts 06:00
    case "yearly":
      return "0 6 1 1 *"; // Jan 1st 06:00
  }
}

// ─── Lifecycle state model (Phase 2) ────────────────────────────────────────

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
  /** Project verification status (pending/verified/...). */
  projectStatus: string;
  monitoringEnabled: boolean;
  frequency: MonitoringFrequency;
  /** Effective next monitoring date (derived if not explicitly stored). */
  nextMonitoringDate: string; // ISO
  /** Whether nextMonitoringDate was derived rather than explicitly scheduled. */
  nextDateDerived: boolean;
  lastMonitoringDate: string | null; // ISO
  /** Whole days until due. Negative = overdue. */
  daysUntilDue: number;
  state: MonitoringLifecycleState;
  isOverdue: boolean;
  recentlyCompleted: boolean;
  mrvStatus: string;
  /** Stable colour tag for calendar/legend (hsl). */
  colorTag: string;
  cron: string;
}

// Deterministic colour palette keyed by ecosystem type (falls back to hash).
const ECOSYSTEM_COLORS: Record<string, string> = {
  Mangrove: "hsl(168 70% 42%)",
  Seagrass: "hsl(190 72% 45%)",
  "Salt Marsh": "hsl(150 55% 48%)",
  "Tidal Wetland": "hsl(200 65% 50%)",
  Peatland: "hsl(28 60% 50%)",
  Mudflat: "hsl(35 45% 52%)",
  "Coastal Forest": "hsl(140 50% 40%)",
  Estuary: "hsl(205 60% 52%)",
  "Coral Reef": "hsl(330 65% 58%)",
  Kelp: "hsl(95 50% 42%)",
};

function colorForProject(ecosystemType: string | null, projectId: string): string {
  if (ecosystemType && ECOSYSTEM_COLORS[ecosystemType]) {
    return ECOSYSTEM_COLORS[ecosystemType];
  }
  // Deterministic hue from id so each project keeps a stable tag.
  let hash = 0;
  for (let i = 0; i < projectId.length; i++) {
    hash = (hash * 31 + projectId.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 60% 48%)`;
}

/** Floor of day difference (b - a) in whole days. */
function diffInDays(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / DAY_MS);
}

/**
 * Resolve the effective next monitoring date for a project.
 * Priority:
 *   1. Explicit nextMonitoringDue (rolled forward if a later run completed)
 *   2. lastMonitoringDate + interval
 *   3. baselineCompletedAt + interval
 *   4. submittedAt + interval
 */
function resolveNextDate(
  project: Project,
  frequency: string | null | undefined,
): { date: Date; derived: boolean } {
  const last = project.lastMonitoringDate ? new Date(project.lastMonitoringDate) : null;
  const explicit = project.nextMonitoringDue ? new Date(project.nextMonitoringDue) : null;

  if (explicit && !Number.isNaN(explicit.getTime())) {
    // If a run completed after the scheduled date, roll forward from completion.
    if (last && !Number.isNaN(last.getTime()) && last.getTime() >= explicit.getTime()) {
      return { date: computeNextMonitoringDate(last, frequency), derived: true };
    }
    return { date: explicit, derived: false };
  }

  const anchor =
    (last && !Number.isNaN(last.getTime()) && last) ||
    (project.baselineCompletedAt && new Date(project.baselineCompletedAt)) ||
    (project.submittedAt && new Date(project.submittedAt)) ||
    new Date();

  return { date: computeNextMonitoringDate(anchor as Date, frequency), derived: true };
}

/**
 * Derive a full schedule snapshot for a single project.
 * All state is computed; nothing is persisted.
 */
export function deriveScheduleSnapshot(project: Project, now: Date = new Date()): ScheduleSnapshot {
  const frequency = normalizeFrequency(project.monitoringFrequency);
  const monitoringEnabled = project.monitoringEnabled !== false;
  const mrvStatus = (project.mrvStatus ?? "NONE").toUpperCase();

  const { date: nextDate, derived } = resolveNextDate(project, frequency);
  const daysUntilDue = diffInDays(now, nextDate);

  const last = project.lastMonitoringDate ? new Date(project.lastMonitoringDate) : null;
  const recentlyCompleted =
    !!last &&
    !Number.isNaN(last.getTime()) &&
    mrvStatus === "COMPLETED" &&
    diffInDays(last, now) <= RECENTLY_COMPLETED_DAYS &&
    diffInDays(last, now) >= 0;

  const isRunning = mrvStatus === "PENDING" || mrvStatus === "RUNNING";
  const isFailed = mrvStatus === "FAILED";
  const isOverdue = monitoringEnabled && !isRunning && daysUntilDue < 0;

  // Precedence: disabled → running → failed → overdue → completed → due_soon → upcoming
  let state: MonitoringLifecycleState;
  if (!monitoringEnabled) state = "disabled";
  else if (isRunning) state = "running";
  else if (isFailed) state = "failed";
  else if (daysUntilDue < 0) state = "overdue";
  else if (recentlyCompleted) state = "completed";
  else if (daysUntilDue <= DUE_SOON_DAYS) state = "due_soon";
  else state = "upcoming";

  return {
    projectId: project.id,
    projectName: project.name,
    ecosystemType: project.ecosystemType ?? null,
    location: project.location ?? null,
    projectStatus: project.status,
    monitoringEnabled,
    frequency,
    nextMonitoringDate: nextDate.toISOString(),
    nextDateDerived: derived,
    lastMonitoringDate: last && !Number.isNaN(last.getTime()) ? last.toISOString() : null,
    daysUntilDue,
    state,
    isOverdue,
    recentlyCompleted,
    mrvStatus,
    colorTag: colorForProject(project.ecosystemType ?? null, project.id),
    cron: frequencyToCron(frequency),
  };
}

export function deriveScheduleSnapshots(projects: Project[], now: Date = new Date()): ScheduleSnapshot[] {
  return projects
    .filter((p) => !p.deletedAt && !p.archivedAt)
    .map((p) => deriveScheduleSnapshot(p, now))
    .sort((a, b) => new Date(a.nextMonitoringDate).getTime() - new Date(b.nextMonitoringDate).getTime());
}

// ─── Calendar (Phase 3) ─────────────────────────────────────────────────────

export type CalendarEventType = "due" | "completed";

export interface MonitoringCalendarEvent {
  projectId: string;
  projectName: string;
  ecosystemType: string | null;
  date: string; // ISO (day of event)
  type: CalendarEventType;
  state: MonitoringLifecycleState;
  colorTag: string;
  daysUntilDue: number;
  frequency: MonitoringFrequency;
}

/**
 * Build calendar events from snapshots. Emits one "due" event per active
 * project plus a "completed" event for recently finished runs so the calendar
 * can show completed badges alongside upcoming reminders.
 */
export function buildCalendarEvents(snapshots: ScheduleSnapshot[]): MonitoringCalendarEvent[] {
  const events: MonitoringCalendarEvent[] = [];
  for (const s of snapshots) {
    events.push({
      projectId: s.projectId,
      projectName: s.projectName,
      ecosystemType: s.ecosystemType,
      date: s.nextMonitoringDate,
      type: "due",
      state: s.state,
      colorTag: s.colorTag,
      daysUntilDue: s.daysUntilDue,
      frequency: s.frequency,
    });
    if (s.lastMonitoringDate && s.mrvStatus === "COMPLETED") {
      events.push({
        projectId: s.projectId,
        projectName: s.projectName,
        ecosystemType: s.ecosystemType,
        date: s.lastMonitoringDate,
        type: "completed",
        state: "completed",
        colorTag: s.colorTag,
        daysUntilDue: s.daysUntilDue,
        frequency: s.frequency,
      });
    }
  }
  return events;
}

// ─── Queue model (Phase 4 + Phase 6) ────────────────────────────────────────

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

export function buildMonitoringQueue(snapshots: ScheduleSnapshot[]): MonitoringQueue {
  const queue: MonitoringQueue = {
    overdue: [],
    dueSoon: [],
    upcoming: [],
    running: [],
    completed: [],
    failed: [],
    disabled: [],
    counts: {
      upcoming: 0,
      due_soon: 0,
      running: 0,
      completed: 0,
      overdue: 0,
      failed: 0,
      disabled: 0,
      total: snapshots.length,
    },
  };

  for (const s of snapshots) {
    queue.counts[s.state] += 1;
    switch (s.state) {
      case "overdue":
        queue.overdue.push(s);
        break;
      case "due_soon":
        queue.dueSoon.push(s);
        break;
      case "running":
        queue.running.push(s);
        break;
      case "completed":
        queue.completed.push(s);
        break;
      case "failed":
        queue.failed.push(s);
        break;
      case "disabled":
        queue.disabled.push(s);
        break;
      default:
        queue.upcoming.push(s);
    }
  }

  return queue;
}

// ─── Queue-ready execution preparation (Phase 6) ────────────────────────────
// NOTE: This prepares work items for a FUTURE AWS worker. It does NOT trigger
// any MRV run. The orchestrator remains the single execution authority.

export interface MonitoringQueueItem {
  projectId: string;
  projectName: string;
  frequency: MonitoringFrequency;
  scheduledFor: string; // ISO
  reason: "overdue" | "due";
  priority: number; // higher = more urgent
  cron: string;
}

/**
 * Select projects eligible for scheduled execution. Pure selection only — the
 * caller decides whether/how to enqueue. Safe for a cron tick or queue drain.
 */
export function selectDueForExecution(
  snapshots: ScheduleSnapshot[],
  limit = 50,
): MonitoringQueueItem[] {
  return snapshots
    .filter((s) => s.monitoringEnabled && (s.state === "overdue" || s.state === "due_soon") && s.daysUntilDue <= 0)
    .map<MonitoringQueueItem>((s) => ({
      projectId: s.projectId,
      projectName: s.projectName,
      frequency: s.frequency,
      scheduledFor: s.nextMonitoringDate,
      reason: s.daysUntilDue < 0 ? "overdue" : "due",
      priority: s.daysUntilDue < 0 ? 100 - s.daysUntilDue : 50,
      cron: s.cron,
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}

// ─── Contributor / Operations summaries (Phase 4) ───────────────────────────

export interface MonitoringSummary {
  total: number;
  overdueCount: number;
  dueSoonCount: number;
  runningCount: number;
  completedCount: number;
  /** The single next scheduled snapshot (soonest non-disabled). */
  next: ScheduleSnapshot | null;
  recentlyCompleted: ScheduleSnapshot[];
}

export function buildMonitoringSummary(snapshots: ScheduleSnapshot[]): MonitoringSummary {
  const active = snapshots.filter((s) => s.monitoringEnabled);
  const upcomingOrDue = active
    .filter((s) => s.state === "upcoming" || s.state === "due_soon" || s.state === "overdue")
    .sort((a, b) => new Date(a.nextMonitoringDate).getTime() - new Date(b.nextMonitoringDate).getTime());

  return {
    total: snapshots.length,
    overdueCount: snapshots.filter((s) => s.state === "overdue").length,
    dueSoonCount: snapshots.filter((s) => s.state === "due_soon").length,
    runningCount: snapshots.filter((s) => s.state === "running").length,
    completedCount: snapshots.filter((s) => s.recentlyCompleted).length,
    next: upcomingOrDue[0] ?? null,
    recentlyCompleted: snapshots
      .filter((s) => s.recentlyCompleted)
      .sort(
        (a, b) =>
          new Date(b.lastMonitoringDate ?? 0).getTime() - new Date(a.lastMonitoringDate ?? 0).getTime(),
      ),
  };
}
