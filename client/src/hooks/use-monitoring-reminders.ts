/**
 * useMonitoringReminders — PHASE OPS-1 (Phase 5)
 * Derives monitoring reminder notifications from the schedule snapshots and
 * pushes them into the persistent notification centre. Deduplicated per
 * (project, category, cycle) so a reminder fires once per monitoring cycle.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { monitoringApi, type ScheduleSnapshot } from "@/lib/monitoring-api";
import {
  useNotifications,
  type NotificationCategory,
} from "@/components/notification-center";

const DEDUP_KEY = "nevara_monitoring_reminders_v1";
const MAX_KEYS = 300;

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
    const arr = Array.from(seen).slice(-MAX_KEYS);
    localStorage.setItem(DEDUP_KEY, JSON.stringify(arr));
  } catch {
    // ignore quota
  }
}

/** Decide which (if any) reminder a snapshot should emit. */
function reminderFor(
  s: ScheduleSnapshot,
): { category: NotificationCategory; title: string; body: string } | null {
  // Cycle bucket = the date this monitoring is scheduled for; changes each cycle.
  if (s.state === "failed") {
    return {
      category: "monitoring_failed",
      title: "Monitoring failed",
      body: `The latest monitoring run for "${s.projectName}" failed and needs attention.`,
    };
  }
  if (s.recentlyCompleted) {
    return {
      category: "monitoring_completed",
      title: "Monitoring completed",
      body: `A monitoring cycle for "${s.projectName}" completed successfully.`,
    };
  }
  if (!s.monitoringEnabled) return null;
  if (s.daysUntilDue < 0) {
    return {
      category: "monitoring_overdue",
      title: "Monitoring overdue",
      body: `Monitoring for "${s.projectName}" is ${Math.abs(s.daysUntilDue)} day(s) overdue.`,
    };
  }
  if (s.daysUntilDue === 1) {
    return {
      category: "monitoring_due_tomorrow",
      title: "Monitoring due tomorrow",
      body: `Monitoring for "${s.projectName}" is scheduled for tomorrow.`,
    };
  }
  if (s.daysUntilDue >= 2 && s.daysUntilDue <= 7) {
    return {
      category: "monitoring_due_soon",
      title: "Monitoring due soon",
      body: `Monitoring for "${s.projectName}" is due in ${s.daysUntilDue} days.`,
    };
  }
  return null;
}

export function useMonitoringReminders(
  options: { linkBase?: string; linkSuffix?: string; enabled?: boolean } = {},
) {
  const { linkBase = "/operations/project", linkSuffix = "", enabled = true } = options;
  const { push } = useNotifications();

  const { data } = useQuery({
    queryKey: ["/api/monitoring/schedule"],
    queryFn: () => monitoringApi.getSchedule(),
    throwOnError: false,
    enabled,
    refetchInterval: 5 * 60 * 1000, // re-check every 5 minutes
  });

  useEffect(() => {
    if (!data?.snapshots?.length) return;
    const seen = loadSeen();
    let changed = false;

    for (const s of data.snapshots) {
      const reminder = reminderFor(s);
      if (!reminder) continue;
      // Cycle key: project + category + the scheduled cycle date (or completion date).
      const cycleStamp =
        reminder.category === "monitoring_completed"
          ? s.lastMonitoringDate ?? s.nextMonitoringDate
          : s.nextMonitoringDate;
      const key = `${s.projectId}:${reminder.category}:${cycleStamp.slice(0, 10)}`;
      if (seen.has(key)) continue;

      push({
        category: reminder.category,
        title: reminder.title,
        body: reminder.body,
        href: `${linkBase}/${s.projectId}${linkSuffix}`,
      });
      seen.add(key);
      changed = true;
    }

    if (changed) saveSeen(seen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, linkBase, linkSuffix]);
}
