import { apiRequest } from "./queryClient";

export interface IntelligenceSummary {
  projectId: string;
  registryId: string | null;
  location: string | null;
  ecosystemType: string | null;
  baselineVsCurrent: any;
  trend: any;
  monitoringTimelineCount: number;
  status: string;
  ecosystemHealthIndex?: number | null;
  ecosystemTrajectory?: string | null;
  qualityScore?: any;
  multiCycleTrends?: any;
}

export interface TimelineEvent {
  type: string;
  date: string;
  title: string;
  description: string;
}

export interface SatelliteArtifact {
  observationType: string;
  observedAt: string;
  rasterAssetPath?: string | null;
  thumbnailPath?: string | null;
  tileLayerPath?: string | null;
  sourceDataset?: string | null;
}

export interface ReportRecord {
  id: string;
  reportType: string;
  version: number;
  title: string;
  status: string;
  generatedAt: string;
}

export interface EvidenceRun {
  runId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  evidencePath: string | null;
}

export interface EvidenceRunList {
  projectId: string;
  runCount: number;
  runs: EvidenceRun[];
  fsRunIds: string[];
}

export interface EvidencePackageDetail {
  run: any;
  manifest: any;
  metrics: any;
  observations?: any;
}

export interface EvidenceValidationDetail {
  validation: any;
  asset_inventory: any[];
  workflow_inventory: any[];
  metrics_inventory: any;
}

export interface EvidenceAssetInventory {
  imageCount: number;
  images: any[];
  assetDirectory: string;
  requiredAssets: string[];
  optionalAssets: string[];
  assets: any[];
  exportMetadata: any[];
}

export interface ReviewRecord {
  id?: string;
  projectId: string;
  runId: string;
  status: string;
  reviewNotes?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  publishedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReviewResponse {
  projectId: string;
  runId: string;
  review: ReviewRecord | null;
}

export type ReleaseStatus = "draft" | "approved" | "published" | "released" | "superseded";

export interface ReleaseRecord {
  releaseId: string;
  projectId: string;
  runId: string;
  reportVersion: number;
  isLatest: boolean;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseNotes: string | null;
  status: ReleaseStatus;
  reportPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AuditAction =
  | "review_started"
  | "changes_requested"
  | "approved"
  | "published"
  | "released"
  | "version_created"
  | "superseded";

export interface AuditEvent {
  id: string;
  projectId: string;
  runId: string;
  action: AuditAction;
  actor: string | null;
  notes: string | null;
  timestamp: string;
}

export interface ReleaseHistoryResponse {
  projectId: string;
  runId: string;
  releases: ReleaseRecord[];
  latest: ReleaseRecord | null;
  releaseCount: number;
}

export interface AuditHistoryResponse {
  projectId: string;
  runId: string;
  events: AuditEvent[];
  eventCount: number;
}

// ── Organization Release types (Feature 5 — hub read-only visibility) ────────

export type OrgReleaseStatus = "draft" | "approved" | "released" | "archived";

export interface OrgReleaseRecord {
  release_id: string;
  project_id: string;
  run_id: string;
  report_version: number;
  organization_id: string | null;
  release_status: OrgReleaseStatus;
  released_by: string | null;
  released_at: string | null;
  notes: string | null;
  report_path: string | null;
  review_status_at_release: string | null;
  validation_score_at_release: number | null;
  package_manifest_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrgReleaseHistoryEntry {
  version: number;
  release_date: string | null;
  operator: string | null;
  review_version: string | null;
  validation_score: number | null;
  status: OrgReleaseStatus;
  release_id: string;
}

export interface OrgReleaseSummary {
  projectId: string;
  runId: string;
  has_releases: boolean;
  latest_status: OrgReleaseStatus | null;
  latest_version: number | null;
  latest_released_at: string | null;
  release_count: number;
  history: OrgReleaseHistoryEntry[];
}

export interface ReleaseEligibilityResult {
  eligible: boolean;
  blocking_reasons: string[];
  validation_status: string | null;
  validation_score: number | null;
  review_status: string | null;
  docx_exists: boolean;
}

export interface KpiDelta {
  label: string;
  current: number | null;
  previous: number | null;
  delta: number | null;
  deltaPct: number | null;
  unit: string;
  direction: "up" | "down" | "stable" | "none";
  sentiment: "positive" | "negative" | "neutral";
}

export interface ChangeSummaryItem {
  category: string;
  label: string;
  direction: "improved" | "declined" | "stable" | "unknown";
  detail: string;
}

/** Returns fetch headers with Bearer token if present in localStorage */
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("bluecarbon_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Authenticated fetch wrapper for intelligence API calls */
async function authFetch(url: string, opts?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts?.headers ?? {}) } });
  return res;
}

/** Parse response as JSON only if content-type is JSON; throws a clean error otherwise. */
async function safeJson(res: Response): Promise<any> {
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) {
    throw new Error(`API route not found or returned non-JSON (status ${res.status})`);
  }
  return res.json();
}

/** POST with JSON body — returns parsed JSON */
async function authPost(url: string, body?: unknown): Promise<any> {
  const token = localStorage.getItem("bluecarbon_token");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI delta computation (client-side, deterministic, rule-based)
// ─────────────────────────────────────────────────────────────────────────────

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Computes KPI deltas between two evidence packages (current vs previous).
 * Entirely deterministic — no AI, no network.
 */
export function computeKpiDeltas(
  current: EvidencePackageDetail | undefined,
  previous: EvidencePackageDetail | undefined,
): KpiDelta[] {
  const cm = current?.metrics;
  const pm = previous?.metrics;

  const deltas: KpiDelta[] = [];

  function push(
    label: string,
    cur: any,
    prev: any,
    unit: string,
    positiveIsUp: boolean,
  ) {
    const curN = safeNum(cur);
    const prevN = safeNum(prev);
    const delta = curN != null && prevN != null ? curN - prevN : null;
    const deltaPct =
      delta != null && prevN != null && prevN !== 0
        ? (delta / Math.abs(prevN)) * 100
        : null;
    let direction: KpiDelta["direction"] = "none";
    let sentiment: KpiDelta["sentiment"] = "neutral";
    if (delta != null) {
      direction = delta > 0.001 ? "up" : delta < -0.001 ? "down" : "stable";
      if (direction === "stable") {
        sentiment = "neutral";
      } else {
        const isImprovement = positiveIsUp ? direction === "up" : direction === "down";
        sentiment = isImprovement ? "positive" : "negative";
      }
    }
    deltas.push({ label, current: curN, previous: prevN, delta, deltaPct, unit, direction, sentiment });
  }

  push("NDVI", cm?.vegetation?.ndvi_mean, pm?.vegetation?.ndvi_mean, "", true);
  push("Risk Score", cm?.risk?.overall_risk_score, pm?.risk?.overall_risk_score, "", false);
  push("Restoration Score", cm?.restoration?.suitability_score, pm?.restoration?.suitability_score, "", true);
  push("Temperature", cm?.thermal?.lst_mean, pm?.thermal?.lst_mean, "°C", false);
  push("Vegetation Cover", cm?.lulc?.vegetation_pct, pm?.lulc?.vegetation_pct, "%", true);

  return deltas;
}

// ─────────────────────────────────────────────────────────────────────────────
// Change detection (rule-based, deterministic)
// ─────────────────────────────────────────────────────────────────────────────

export function computeChangeSummary(
  current: EvidencePackageDetail | undefined,
  previous: EvidencePackageDetail | undefined,
): ChangeSummaryItem[] {
  const cm = current?.metrics;
  const pm = previous?.metrics;

  const items: ChangeSummaryItem[] = [];

  function ndviDir() {
    const c = safeNum(cm?.vegetation?.ndvi_mean);
    const p = safeNum(pm?.vegetation?.ndvi_mean);
    if (c == null || p == null) return "unknown";
    return c - p > 0.01 ? "improved" : c - p < -0.01 ? "declined" : "stable";
  }

  function riskDir() {
    const c = safeNum(cm?.risk?.overall_risk_score);
    const p = safeNum(pm?.risk?.overall_risk_score);
    if (c == null || p == null) return "unknown";
    // lower risk = improved
    return p - c > 2 ? "improved" : c - p > 2 ? "declined" : "stable";
  }

  function thermalDir() {
    const c = safeNum(cm?.thermal?.lst_mean);
    const p = safeNum(pm?.thermal?.lst_mean);
    if (c == null || p == null) return "unknown";
    return c - p > 0.5 ? "declined" : p - c > 0.5 ? "improved" : "stable";
  }

  function hydroDir() {
    const c = cm?.hydrology?.runoff_risk;
    const p = pm?.hydrology?.runoff_risk;
    if (!c || !p) return "unknown";
    if (c === p) return "stable";
    const rank: Record<string, number> = { low: 0, moderate: 1, high: 2, very_high: 3 };
    return (rank[c] ?? 1) < (rank[p] ?? 1) ? "improved" : "declined";
  }

  function restorationDir() {
    const c = safeNum(cm?.restoration?.suitability_score);
    const p = safeNum(pm?.restoration?.suitability_score);
    if (c == null || p == null) return "unknown";
    return c - p > 2 ? "improved" : c - p < -2 ? "declined" : "stable";
  }

  const vDir = ndviDir() as ChangeSummaryItem["direction"];
  items.push({
    category: "Vegetation",
    label: vDir === "improved" ? "Vegetation improved" : vDir === "declined" ? "Vegetation declined" : "Vegetation stable",
    direction: vDir,
    detail: `NDVI ${fmtDelta(cm?.vegetation?.ndvi_mean, pm?.vegetation?.ndvi_mean)}`,
  });

  const tDir = thermalDir() as ChangeSummaryItem["direction"];
  items.push({
    category: "Thermal",
    label: tDir === "declined" ? "Thermal stress increased" : tDir === "improved" ? "Thermal stress reduced" : "Thermal stress stable",
    direction: tDir,
    detail: `LST ${fmtDelta(cm?.thermal?.lst_mean, pm?.thermal?.lst_mean, "°C")}`,
  });

  const hDir = hydroDir() as ChangeSummaryItem["direction"];
  items.push({
    category: "Hydrology",
    label: `Hydrology ${hDir === "stable" ? "stable" : hDir === "improved" ? "improved" : hDir === "declined" ? "declined" : "status unknown"}`,
    direction: hDir,
    detail: `Runoff risk: ${cm?.hydrology?.runoff_risk ?? "—"}`,
  });

  const rDir = restorationDir() as ChangeSummaryItem["direction"];
  items.push({
    category: "Restoration",
    label: rDir === "improved" ? "Restoration suitability improved" : rDir === "declined" ? "Restoration priority increased" : "Restoration suitability stable",
    direction: rDir,
    detail: `Score ${fmtDelta(cm?.restoration?.suitability_score, pm?.restoration?.suitability_score)}`,
  });

  const rkDir = riskDir() as ChangeSummaryItem["direction"];
  items.push({
    category: "Risk",
    label: rkDir === "improved" ? "Ecological risk reduced" : rkDir === "declined" ? "Ecological risk increased" : "Ecological risk stable",
    direction: rkDir,
    detail: `Risk score ${fmtDelta(cm?.risk?.overall_risk_score, pm?.risk?.overall_risk_score)}`,
  });

  return items;
}

function fmtDelta(cur: any, prev: any, unit = ""): string {
  const c = safeNum(cur);
  const p = safeNum(prev);
  if (c == null) return "—";
  if (p == null) return `${c.toFixed(2)}${unit}`;
  const d = c - p;
  const sign = d > 0 ? "+" : "";
  return `${c.toFixed(2)}${unit} (${sign}${d.toFixed(2)}${unit})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// API surface
// ─────────────────────────────────────────────────────────────────────────────

export const intelligenceApi = {
  getSummary: async (projectId: string): Promise<IntelligenceSummary | null> => {
    try {
      const res = await authFetch(`/api/projects/${projectId}/environmental-summary`);
      if (!res.ok) return null;
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('json')) return null;
      return res.json();
    } catch {
      return null;
    }
  },

  getReports: async (projectId: string): Promise<ReportRecord[]> => {
    const res = await authFetch(`/api/projects/${projectId}/reports`);
    if (!res.ok) throw new Error(`Failed to fetch reports (${res.status})`);
    return safeJson(res);
  },

  getEvidenceRuns: async (projectId: string): Promise<EvidenceRunList> => {
    const res = await authFetch(`/api/evidence/${projectId}`);
    if (!res.ok) throw new Error(`Failed to fetch evidence runs (${res.status})`);
    return safeJson(res);
  },

  getEvidencePackage: async (projectId: string, runId: string): Promise<EvidencePackageDetail> => {
    const res = await authFetch(`/api/evidence/${projectId}/${runId}`);
    if (!res.ok) throw new Error(`Failed to fetch evidence package (${res.status})`);
    return safeJson(res);
  },

  getEvidenceValidation: async (projectId: string, runId: string): Promise<EvidenceValidationDetail> => {
    const res = await authFetch(`/api/evidence/${projectId}/${runId}/validation`);
    if (!res.ok) throw new Error(`Failed to fetch evidence validation (${res.status})`);
    return safeJson(res);
  },

  getEvidenceAssets: async (projectId: string, runId: string): Promise<EvidenceAssetInventory> => {
    const res = await authFetch(`/api/evidence/${projectId}/${runId}/assets`);
    if (!res.ok) throw new Error(`Failed to fetch evidence assets (${res.status})`);
    return safeJson(res);
  },

  getReportReview: async (projectId: string, runId: string): Promise<ReviewResponse> => {
    const res = await authFetch(`/api/reports/${projectId}/${runId}/review`);
    if (!res.ok) throw new Error(`Failed to fetch report review (${res.status})`);
    return safeJson(res);
  },

  buildEvidenceReport: async (projectId: string, runId: string) => {
    const res = await authFetch(`/api/reports/${projectId}/${runId}/build`);
    if (!res.ok) throw new Error(`Failed to build evidence report (${res.status})`);
    return safeJson(res);
  },

  // ── Review lifecycle mutations ────────────────────────────────────────────

  startReview: (projectId: string, runId: string, notes?: string) =>
    authPost(`/api/reports/${projectId}/${runId}/review/start`, notes ? { review_notes: notes } : undefined),

  requestChanges: (projectId: string, runId: string, notes?: string) =>
    authPost(`/api/reports/${projectId}/${runId}/review/request-changes`, notes ? { review_notes: notes } : undefined),

  approveReport: (projectId: string, runId: string, notes?: string) =>
    authPost(`/api/reports/${projectId}/${runId}/review/approve`, notes ? { review_notes: notes } : undefined),

  publishReport: (projectId: string, runId: string, notes?: string) =>
    authPost(`/api/reports/${projectId}/${runId}/review/publish`, notes ? { review_notes: notes } : undefined),

  // ── Legacy ───────────────────────────────────────────────────────────────

  generateReport: async (projectId: string, reportType: string) => {
    const res = await apiRequest("POST", `/api/projects/${projectId}/reports/generate`, { reportType });
    return res.json();
  },

  triggerMRV: async (projectId: string) => {
    const res = await apiRequest("POST", "/api/mrv/trigger", { projectId });
    return res.json();
  },

  getMRVStatus: async (projectId: string) => {
    const res = await authFetch(`/api/mrv/${projectId}`);
    if (!res.ok) throw new Error(`Failed to fetch MRV status (${res.status})`);
    return safeJson(res);
  },

  // ── Release & Audit APIs ─────────────────────────────────────────────────

  getReleases: async (projectId: string, runId: string): Promise<ReleaseHistoryResponse> => {
    const res = await authFetch(`/api/reports/${projectId}/${runId}/releases`);
    if (!res.ok) throw new Error(`Failed to fetch releases (${res.status})`);
    return safeJson(res);
  },

  getLatestRelease: async (projectId: string, runId: string): Promise<{ release: ReleaseRecord | null }> => {
    const res = await authFetch(`/api/reports/${projectId}/${runId}/releases/latest`);
    if (!res.ok) throw new Error(`Failed to fetch latest release (${res.status})`);
    return safeJson(res);
  },

  getAuditHistory: async (projectId: string, runId: string): Promise<AuditHistoryResponse> => {
    const res = await authFetch(`/api/reports/${projectId}/${runId}/audit`);
    if (!res.ok) throw new Error(`Failed to fetch audit history (${res.status})`);
    return safeJson(res);
  },

  createRelease: (projectId: string, runId: string, releaseNotes?: string) =>
    authPost(`/api/reports/${projectId}/${runId}/release`, releaseNotes ? { releaseNotes } : undefined),

  // ── Organization Release — read-only hub visibility (Feature 5) ───────────

  /** Check whether a release can be created for this run. */
  checkReleaseEligibility: async (projectId: string, runId: string): Promise<{ eligibility: ReleaseEligibilityResult }> => {
    const res = await authFetch(`/api/reports/${projectId}/${runId}/release/eligibility`);
    if (!res.ok) throw new Error(`Failed to check release eligibility (${res.status})`);
    return safeJson(res);
  },

  /** Get the latest org release record (singular /release/latest path). */
  getOrgLatestRelease: async (
    projectId: string,
    runId: string,
  ): Promise<{ release: OrgReleaseRecord | null; history: OrgReleaseHistoryEntry[] }> => {
    const res = await authFetch(`/api/reports/${projectId}/${runId}/release/latest`);
    if (!res.ok) throw new Error(`Failed to fetch latest org release (${res.status})`);
    return safeJson(res);
  },

  /** Get the org release summary for the hub release panel. */
  getOrgReleaseSummary: async (projectId: string, runId: string): Promise<OrgReleaseSummary> => {
    const res = await authFetch(`/api/reports/${projectId}/${runId}/release/summary`);
    if (!res.ok) throw new Error(`Failed to fetch org release summary (${res.status})`);
    return safeJson(res);
  },

  // ── Organization Release mutations (verifier/admin only) ─────────────────

  createOrgRelease: (projectId: string, runId: string, organizationId?: string, notes?: string) =>
    authPost(`/api/reports/${projectId}/${runId}/org-release`, { organization_id: organizationId ?? null, notes: notes ?? null }),

  approveOrgRelease: (projectId: string, runId: string, releaseId: string, notes?: string) =>
    authPost(`/api/reports/${projectId}/${runId}/org-release/${releaseId}/approve`, notes ? { notes } : undefined),

  publishOrgRelease: (projectId: string, runId: string, releaseId: string, notes?: string) =>
    authPost(`/api/reports/${projectId}/${runId}/org-release/${releaseId}/publish`, notes ? { notes } : undefined),

  archiveOrgRelease: (projectId: string, runId: string, releaseId: string, notes?: string) =>
    authPost(`/api/reports/${projectId}/${runId}/org-release/${releaseId}/archive`, notes ? { notes } : undefined),
};

