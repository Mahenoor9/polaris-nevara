/**
 * sse-manager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-Sent Events (SSE) manager for real-time MRV progress streaming.
 *
 * Architecture:
 *   - Each verifier client subscribes to /api/sse/mrv-progress?projectId=<id>
 *   - SSEManager holds a registry of active Response objects keyed by projectId
 *   - mrvEventBus → SSEManager.pushProgress() → all subscribed clients
 *   - auditEventBus → SSEManager.pushAuditEvent() → admin subscribers
 *   - Heartbeat (30s) prevents proxy/load-balancer timeouts
 *   - Automatic cleanup on client disconnect
 *
 * Security:
 *   - Route handler applies requireAuth + requireRole before registering SSE
 *   - Each client only receives events for the projectId they subscribed to
 *   - Admin audit stream requires "admin" role
 *
 * Limitations:
 *   - In-process only (single Node.js instance); for multi-instance use Redis pub/sub
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Response } from "express";
import { createLogger } from "../observability/structured-logger";
import type { AuditEvent } from "../observability/audit-event-store";

const logger = createLogger("SSEManager");

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_EVENTS_PER_MINUTE_PER_PROJECT = 240;

export interface SSEProgressPayload {
  projectId: string;
  progress: number;
  step: string;
  status: string;
  label: string;
  ts: string;
}

// Map<projectId, Set<Response>>
const _subscribers = new Map<string, Set<Response>>();
// Admin audit subscribers
const _adminSubscribers = new Set<Response>();
const _projectEmitWindow = new Map<string, { minute: number; count: number; dropped: number }>();

// Heartbeat timer refs for cleanup
const _heartbeats = new WeakMap<Response, ReturnType<typeof setInterval>>();

function sendSSEMessage(res: Response, event: string, data: unknown) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Client likely disconnected — will be cleaned up on 'close' event
  }
}

function setupSSEHeaders(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Nginx proxy buffering disable
  res.flushHeaders();
}

function startHeartbeat(res: Response) {
  const timer = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(timer);
    }
  }, HEARTBEAT_INTERVAL_MS);
  _heartbeats.set(res, timer);
}

function stopHeartbeat(res: Response) {
  const timer = _heartbeats.get(res);
  if (timer) clearInterval(timer);
}

// ─── Project progress stream ──────────────────────────────────────────────────

export function registerProjectSubscriber(projectId: string, res: Response) {
  setupSSEHeaders(res);
  startHeartbeat(res);

  if (!_subscribers.has(projectId)) {
    _subscribers.set(projectId, new Set());
  }
  _subscribers.get(projectId)!.add(res);

  logger.debug("SSE subscriber registered", {
    projectId,
    total: _subscribers.get(projectId)!.size,
  });

  // Send initial connected event
  sendSSEMessage(res, "connected", { projectId, ts: new Date().toISOString() });

  res.on("close", () => {
    stopHeartbeat(res);
    const subs = _subscribers.get(projectId);
    if (subs) {
      subs.delete(res);
      if (subs.size === 0) _subscribers.delete(projectId);
    }
    logger.debug("SSE subscriber disconnected", { projectId });
  });
}

export function pushProgressEvent(payload: SSEProgressPayload) {
  const subs = _subscribers.get(payload.projectId);
  if (!subs || subs.size === 0) return;
  const minute = Math.floor(Date.now() / 60_000);
  const window = _projectEmitWindow.get(payload.projectId);
  if (!window || window.minute !== minute) {
    _projectEmitWindow.set(payload.projectId, { minute, count: 0, dropped: 0 });
  }
  const activeWindow = _projectEmitWindow.get(payload.projectId)!;
  if (activeWindow.count >= MAX_EVENTS_PER_MINUTE_PER_PROJECT) {
    activeWindow.dropped += 1;
    if (activeWindow.dropped === 1) {
      logger.warn("SSE project event rate limited", {
        projectId: payload.projectId,
        dropped: activeWindow.dropped,
        cap: MAX_EVENTS_PER_MINUTE_PER_PROJECT,
      });
    }
    return;
  }
  activeWindow.count += 1;

  for (const res of subs) {
    sendSSEMessage(res, "progress", payload);
  }

  logger.debug("SSE progress pushed", {
    projectId: payload.projectId,
    progress: payload.progress,
    subscribers: subs.size,
  });
}

// ─── Admin audit stream ───────────────────────────────────────────────────────

export function registerAdminSubscriber(res: Response) {
  setupSSEHeaders(res);
  startHeartbeat(res);
  _adminSubscribers.add(res);

  logger.info("Admin SSE subscriber registered", {
    total: _adminSubscribers.size,
  });

  sendSSEMessage(res, "connected", {
    stream: "audit",
    ts: new Date().toISOString(),
  });

  res.on("close", () => {
    stopHeartbeat(res);
    _adminSubscribers.delete(res);
    logger.debug("Admin SSE subscriber disconnected");
  });
}

export function pushAuditEvent(event: AuditEvent) {
  if (_adminSubscribers.size === 0) return;
  for (const res of _adminSubscribers) {
    sendSSEMessage(res, "audit", event);
  }
}

// ─── Status snapshot ──────────────────────────────────────────────────────────

export function getSSEStats() {
  const projectCount = _subscribers.size;
  let clientCount = 0;
  _subscribers.forEach((s) => (clientCount += s.size));
  return {
    projectSubscribers: projectCount,
    totalClients: clientCount,
    adminClients: _adminSubscribers.size,
  };
}
