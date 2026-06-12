/**
 * intelligence-cache.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * In-process LRU cache for intelligence query results and report metadata.
 *
 * Strategy:
 *   - TTL-based expiry (default 5 min for summaries, 30 min for reports)
 *   - LRU eviction at capacity (max 500 entries per namespace)
 *   - Cache-aside pattern: caller checks → miss → fetch → store
 *   - Cache invalidation: by key or by projectId prefix
 *   - Redis-ready: interface abstracted so Redis backend can be swapped in
 *
 * Cache namespaces (key prefixes):
 *   "summary:{projectId}"         → environmental summary (5 min)
 *   "timeline:{projectId}"        → project timeline events (5 min)
 *   "history:{projectId}:{ind}"   → indicator time-series (10 min)
 *   "artifacts:{projectId}"       → satellite artifact list (10 min)
 *   "reports:{projectId}"         → report metadata list (30 min)
 *   "registry:{projectId}"        → registry record (15 min)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createLogger } from "./structured-logger";

const logger = createLogger("IntelligenceCache");

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  hits: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 500;

class LRUTTLCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private accessOrder: string[] = [];

  get<T>(key: string): T | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return null;
    }
    entry.hits++;
    // Move to end (most recently used)
    this.bumpAccess(key);
    return entry.value;
  }

  set<T>(key: string, value: T, ttlMs = DEFAULT_TTL_MS) {
    if (this.store.size >= MAX_ENTRIES) {
      this.evictLRU();
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      hits: 0,
    });
    this.bumpAccess(key);
  }

  delete(key: string) {
    this.store.delete(key);
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
  }

  /** Invalidate all keys matching a prefix */
  invalidatePrefix(prefix: string) {
    let count = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
        this.delete(key);
        count++;
      }
    }
    if (count > 0) {
      logger.debug("Cache prefix invalidated", { prefix, count });
    }
  }

  getStats() {
    let totalHits = 0;
    let expired = 0;
    const now = Date.now();
    for (const entry of this.store.values()) {
      totalHits += entry.hits;
      if (now > entry.expiresAt) expired++;
    }
    return {
      size: this.store.size,
      maxEntries: MAX_ENTRIES,
      totalHits,
      expired,
    };
  }

  private bumpAccess(key: string) {
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(key);
  }

  private evictLRU() {
    const oldest = this.accessOrder.shift();
    if (oldest) {
      this.store.delete(oldest);
      logger.debug("LRU eviction", { key: oldest });
    }
  }
}

// Singleton cache instance
export const intelligenceCache = new LRUTTLCache();

// ─── TTL constants by namespace ───────────────────────────────────────────────
export const CACHE_TTL = {
  SUMMARY: 5 * 60 * 1000,        // 5 min
  TIMELINE: 5 * 60 * 1000,       // 5 min
  HISTORY: 10 * 60 * 1000,       // 10 min
  ARTIFACTS: 10 * 60 * 1000,     // 10 min
  REPORTS: 30 * 60 * 1000,       // 30 min
  REGISTRY: 15 * 60 * 1000,      // 15 min
  CHANGES: 10 * 60 * 1000,       // 10 min
} as const;

// ─── Cache key builders ───────────────────────────────────────────────────────
export const cacheKey = {
  summary: (projectId: string) => `summary:${projectId}`,
  timeline: (projectId: string) => `timeline:${projectId}`,
  history: (projectId: string, indicator: string) => `history:${projectId}:${indicator}`,
  artifacts: (projectId: string) => `artifacts:${projectId}`,
  reports: (projectId: string) => `reports:${projectId}`,
  registry: (projectId: string) => `registry:${projectId}`,
  changes: (projectId: string) => `changes:${projectId}`,
};

/**
 * Cache-aside helper.
 * Usage: const result = await withCache(key, ttl, () => expensiveQuery())
 */
export async function withCache<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const cached = intelligenceCache.get<T>(key);
  if (cached !== null) {
    logger.debug("Cache hit", { key });
    return cached;
  }

  const value = await fetcher();
  intelligenceCache.set(key, value, ttlMs);
  logger.debug("Cache miss → stored", { key, ttlMs });
  return value;
}

/** Invalidate all cached data for a project (call after MRV cycle completes) */
export function invalidateProjectCache(projectId: string) {
  intelligenceCache.invalidatePrefix(`summary:${projectId}`);
  intelligenceCache.invalidatePrefix(`timeline:${projectId}`);
  intelligenceCache.invalidatePrefix(`monitoring-timeline:${projectId}`);
  intelligenceCache.invalidatePrefix(`history:${projectId}`);
  intelligenceCache.invalidatePrefix(`hist-obs:${projectId}`);
  intelligenceCache.invalidatePrefix(`artifacts:${projectId}`);
  intelligenceCache.invalidatePrefix(`reports:${projectId}`);
  intelligenceCache.invalidatePrefix(`registry:${projectId}`);
  intelligenceCache.invalidatePrefix(`changes:${projectId}`);
  intelligenceCache.invalidatePrefix(`bvc:${projectId}`);
  intelligenceCache.invalidatePrefix(`trend-anomalies:${projectId}`);
  intelligenceCache.invalidatePrefix(`risk-score:${projectId}`);
  intelligenceCache.invalidatePrefix(`monitoring-alerts:${projectId}`);
  intelligenceCache.invalidatePrefix(`auto-insights:${projectId}`);
  intelligenceCache.invalidatePrefix(`trajectory:${projectId}`);
  intelligenceCache.invalidatePrefix(`seasonal-patterns:${projectId}`);
  intelligenceCache.invalidatePrefix(`notification-foundations:${projectId}`);
  intelligenceCache.invalidatePrefix(`monitoring-recommendations:${projectId}`);
  intelligenceCache.invalidatePrefix(`effective-calibration:${projectId}`);
  intelligenceCache.invalidatePrefix(`field-vs-sat:${projectId}`);
  logger.info("Project cache invalidated", { projectId });
}
