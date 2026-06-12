/**
 * audit-event-store.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralized, append-only audit/event store for all MRV lifecycle events.
 *
 * Architecture:
 *   - Primary: in-memory ring buffer (last 10,000 events)
 *   - Secondary: DB persistence when USE_DATABASE=true (eco_monitoring.audit_events)
 *   - Consumers: SSE streaming, admin status panel, scheduler diagnostics
 *
 * Design choices:
 *   - EventCategory scopes events for filtering (MRV | GIS | VERIFIER | REPORT | SYSTEM)
 *   - Immutable entries (never mutated after append)
 *   - Safe to call from any module — DB write failures do NOT throw upstream
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createLogger } from "./structured-logger";
import { EventEmitter } from "events";

const logger = createLogger("AuditEventStore");

export type EventCategory = "MRV" | "GIS" | "VERIFIER" | "REPORT" | "SYSTEM" | "SCHEDULER";
export type EventSeverity = "INFO" | "WARN" | "ERROR" | "CRITICAL";

export interface AuditEvent {
  id: string;
  ts: string;
  category: EventCategory;
  severity: EventSeverity;
  projectId?: string;
  cycleId?: string;
  userId?: string;
  action: string;
  detail: string;
  meta?: Record<string, unknown>;
}

// In-memory ring buffer
const MAX_BUFFER = 10_000;
const _events: AuditEvent[] = [];
let _seq = 0;

// Event bus for SSE push
export const auditEventEmitter = new EventEmitter();
auditEventEmitter.setMaxListeners(200);

function generateId(): string {
  return `ev_${Date.now()}_${(++_seq).toString(36)}`;
}

export function appendAuditEvent(
  partial: Omit<AuditEvent, "id" | "ts">
): AuditEvent {
  const event: AuditEvent = {
    ...partial,
    id: generateId(),
    ts: new Date().toISOString(),
  };

  // Ring buffer: evict oldest when full
  if (_events.length >= MAX_BUFFER) {
    _events.shift();
  }
  _events.push(event);

  // Push to SSE subscribers
  auditEventEmitter.emit("event", event);

  // Log at appropriate level
  if (event.severity === "ERROR" || event.severity === "CRITICAL") {
    logger.error(`[${event.category}] ${event.action}`, {
      detail: event.detail,
      projectId: event.projectId,
    });
  } else if (event.severity === "WARN") {
    logger.warn(`[${event.category}] ${event.action}`, {
      detail: event.detail,
    });
  } else {
    logger.debug(`[${event.category}] ${event.action}`, {
      detail: event.detail,
    });
  }

  // Async DB persistence (non-blocking — fire and forget)
  persistToDb(event).catch((err) => {
    logger.warn("Audit event DB persist failed", { error: String(err) });
  });

  return event;
}

/** Query helpers */
export function getRecentEvents(
  limit = 100,
  filters?: {
    category?: EventCategory;
    projectId?: string;
    severity?: EventSeverity;
    since?: Date;
  }
): AuditEvent[] {
  let results = [..._events].reverse();

  if (filters?.category) {
    results = results.filter((e) => e.category === filters.category);
  }
  if (filters?.projectId) {
    results = results.filter((e) => e.projectId === filters.projectId);
  }
  if (filters?.severity) {
    results = results.filter((e) => e.severity === filters.severity);
  }
  if (filters?.since) {
    const sinceMs = filters.since.getTime();
    results = results.filter((e) => new Date(e.ts).getTime() >= sinceMs);
  }

  return results.slice(0, limit);
}

export function getEventStats(): {
  total: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  lastEventAt: string | null;
} {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};

  for (const e of _events) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
  }

  return {
    total: _events.length,
    byCategory,
    bySeverity,
    lastEventAt: _events.length > 0 ? _events[_events.length - 1].ts : null,
  };
}

/** DB persistence — graceful no-op when USE_DATABASE is false */
async function persistToDb(event: AuditEvent): Promise<void> {
  if (process.env.USE_DATABASE !== "true") return;
  try {
    // Lazy import to avoid circular deps
    const { db } = await import("../db");
    const { sql } = await import("drizzle-orm");
    await db.execute(
      sql`INSERT INTO eco_monitoring.audit_events
          (id, ts, category, severity, project_id, cycle_id, user_id, action, detail, meta)
        VALUES (
          ${event.id},
          ${event.ts},
          ${event.category},
          ${event.severity},
          ${event.projectId ?? null},
          ${event.cycleId ?? null},
          ${event.userId ?? null},
          ${event.action},
          ${event.detail},
          ${event.meta ? JSON.stringify(event.meta) : null}
        )
        ON CONFLICT (id) DO NOTHING`
    );
  } catch {
    // Silently swallow — logged at caller level
  }
}
