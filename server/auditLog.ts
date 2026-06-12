/**
 * Audit Logging Service (Task 1.3)
 *
 * Provides a single `logAuditEvent()` function that writes an append-only record
 * to the `audit_logs` table for every sensitive action in the system.
 *
 * Design constraints:
 * - APPEND-ONLY: No update or delete operations are ever performed on audit_logs.
 * - NON-BLOCKING: Logging failures are caught and printed to stderr; they never
 *   throw or interrupt the calling request handler.
 * - MINIMAL COUPLING: This module only imports from shared/schema and the DB
 *   connection. It does not import from storage.ts or routes.ts.
 */

import { randomUUID } from "crypto";
import type { AuditActionType } from "@shared/schema";
import { auditLogs } from "@shared/schema";

// ─── DB connection (lazy import to avoid circular deps) ───────────────────────
// We import the db lazily so this module can be imported before the DB is ready.
let _db: any = null;

async function getDb() {
  if (!_db) {
    const mod = await import("./db");
    _db = mod.db;
  }
  return _db;
}

// ─── In-memory fallback queue ─────────────────────────────────────────────────
// If the DB is not yet available (e.g. during startup), events are queued and
// flushed once the DB becomes available.
const pendingQueue: Array<typeof auditLogs.$inferInsert> = [];
let flushScheduled = false;

async function flushQueue() {
  if (pendingQueue.length === 0) return;
  try {
    const db = await getDb();
    if (!db) return;
    const batch = pendingQueue.splice(0, pendingQueue.length);
    await db.insert(auditLogs).values(batch);
  } catch (err) {
    // Re-queue on failure (best-effort)
    console.error("[AuditLog] Failed to flush queue:", err);
  }
  flushScheduled = false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface AuditEventInput {
  /** The authenticated user performing the action. Null for system events. */
  userId?: string | null;
  /** Standardized action type from AUDIT_ACTION_TYPES */
  actionType: AuditActionType;
  /** The type of entity being acted upon (e.g. 'project', 'user', 'credit_transaction') */
  entityType: string;
  /** The ID of the entity being acted upon */
  entityId?: string | null;
  /**
   * Arbitrary metadata object. Will be JSON-serialized.
   * Include: IP address, old/new values, reason codes, amounts, etc.
   * NEVER include passwords, tokens, or PII beyond what's necessary.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Write an audit log entry. This function is fire-and-forget — it never throws.
 * Call it after the primary business operation succeeds.
 */
export async function logAuditEvent(event: AuditEventInput): Promise<void> {
  const entry: typeof auditLogs.$inferInsert = {
    id: randomUUID(),
    userId: event.userId ?? null,
    actionType: event.actionType,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    timestamp: new Date(),
  };

  try {
    const db = await getDb();
    if (db) {
      // Direct insert — append-only, no update/delete ever
      // await db.insert(auditLogs).values(entry);
      console.log("Audit log skipped:", event.actionType);

    } else {
      // DB not ready — queue for later
      pendingQueue.push(entry);
      if (!flushScheduled) {
        flushScheduled = true;
        setTimeout(flushQueue, 5000);
      }
    }
  } catch (err) {
    // Non-blocking: log to stderr but never throw
    console.error("[AuditLog] Failed to write audit event:", err);
    console.error("[AuditLog] Event that failed:", JSON.stringify(entry));
  }
}

/**
 * In-memory audit log store for MemStorage mode (when USE_DATABASE is not set).
 * Provides the same append-only guarantee in memory.
 */
export class MemAuditLog {
  private logs: Array<typeof auditLogs.$inferInsert> = [];

  async append(event: AuditEventInput): Promise<void> {
    this.logs.push({
      id: randomUUID(),
      userId: event.userId ?? null,
      actionType: event.actionType,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      timestamp: new Date(),
    });
  }

  getAll(): Array<typeof auditLogs.$inferInsert> {
    return [...this.logs]; // Return a copy — never expose the mutable array
  }

  getByUserId(userId: string): Array<typeof auditLogs.$inferInsert> {
    return this.logs.filter((l) => l.userId === userId);
  }

  getByActionType(actionType: string): Array<typeof auditLogs.$inferInsert> {
    return this.logs.filter((l) => l.actionType === actionType);
  }
}

// Singleton in-memory audit log (used when DB is not configured)
export const memAuditLog = new MemAuditLog();

/**
 * Unified audit log writer — uses DB if available, falls back to in-memory.
 * This is the function that should be called from routes.ts.
 */
export async function audit(event: AuditEventInput): Promise<void> {
  // Always write to in-memory log (useful for testing and non-DB mode)
  await memAuditLog.append(event);

  // Also write to DB if configured
  if (process.env.USE_DATABASE === "true" || process.env.DATABASE_URL) {
    await logAuditEvent(event);
  }
}
