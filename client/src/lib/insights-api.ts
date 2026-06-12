/**
 * Grounded Ecological Insights API client — PHASE AI-1
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

export type InsightCategory =
  | "vegetation" | "water" | "thermal" | "restoration" | "hydrology" | "risk" | "monitoring" | "overall";
export type InsightSignal = "positive" | "neutral" | "risk" | "opportunity";
export type InsightSeverity = "positive" | "info" | "watch" | "warning" | "critical";

export interface EvidenceSource { path: string; label: string; value: number | string | null; unit?: string | null; }
export interface ThresholdCheck { name: string; operator: string; threshold: number | string; actual: number | string | null; triggered: boolean; }
export interface InsightWhy { rule_id: string; metrics_used: EvidenceSource[]; observations_used: string[]; thresholds: ThresholdCheck[]; }

export interface Insight {
  id: string;
  category: InsightCategory;
  signal: InsightSignal;
  severity: InsightSeverity;
  title: string;
  summary: string;
  recommendation: string | null;
  evidence_sources: EvidenceSource[];
  confidence: number;
  generated_at: string;
  why: InsightWhy;
}

export interface ExecutiveSummary {
  current_condition: string;
  key_improvements: string[];
  key_risks: string[];
  recommended_attention: string[];
  monitoring_outlook: string;
  narrative: string;
  word_count: number;
}

export interface InsightsJson {
  schema_version: string;
  rule_version: string;
  generation_method: string;
  run_id: string;
  project_id: string;
  generated_at: string;
  insight_count: number;
  insights: Insight[];
  executive_summary: ExecutiveSummary;
  source_digest: Record<string, number | string | null>;
}

export interface InsightDiffEntry { id: string; category: string; title: string; severity: string; }
export interface InsightDiff {
  hasPrevious: boolean;
  previousRunId: string | null;
  newRisks: InsightDiffEntry[];
  resolvedRisks: InsightDiffEntry[];
  improvedIndicators: InsightDiffEntry[];
  emergingTrends: InsightDiffEntry[];
}

export interface PortfolioHeadline { kind: "positive" | "watch" | "risk" | "opportunity"; text: string; count: number; }
export interface PortfolioInsights {
  generated_at: string;
  project_count: number;
  headlines: PortfolioHeadline[];
  projects: Array<{
    projectId: string;
    projectName: string;
    runId: string;
    signals: { positive: number; risk: number; opportunity: number };
    topRisk: string | null;
  }>;
}

export const insightsApi = {
  get: async (projectId: string, runId: string) =>
    safeJson<InsightsJson>(await fetch(`/api/insights/${projectId}/${runId}`, { headers: getAuthHeaders() })),
  diff: async (projectId: string, runId: string) =>
    safeJson<InsightDiff>(await fetch(`/api/insights/${projectId}/${runId}/diff`, { headers: getAuthHeaders() })),
  portfolio: async () =>
    safeJson<PortfolioInsights>(await fetch(`/api/insights/portfolio`, { headers: getAuthHeaders() })),
};

export const SIGNAL_META: Record<InsightSignal, { label: string; text: string; bg: string; border: string }> = {
  positive: { label: "Positive", text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
  opportunity: { label: "Opportunity", text: "text-teal-400", bg: "bg-teal-500/10", border: "border-teal-500/30" },
  neutral: { label: "Neutral", text: "text-sky-400", bg: "bg-sky-500/10", border: "border-sky-500/30" },
  risk: { label: "Risk", text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30" },
};

export const SEVERITY_META: Record<InsightSeverity, { label: string; text: string; dot: string }> = {
  positive: { label: "Positive", text: "text-emerald-400", dot: "bg-emerald-400" },
  info: { label: "Info", text: "text-sky-400", dot: "bg-sky-400" },
  watch: { label: "Watch", text: "text-amber-400", dot: "bg-amber-400" },
  warning: { label: "Warning", text: "text-orange-400", dot: "bg-orange-400" },
  critical: { label: "Critical", text: "text-red-400", dot: "bg-red-400" },
};
