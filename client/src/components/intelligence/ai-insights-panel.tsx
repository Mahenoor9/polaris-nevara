/**
 * AI Ecological Insights Panel — PHASE AI-1 (Phases 4, 6, 7)
 * Grounded, evidence-backed insights with full "Why am I seeing this?"
 * transparency and current-vs-previous diffing. No free-form AI text.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Sparkles, Leaf, Droplets, Thermometer, Sprout, Waves, ShieldAlert, CalendarClock, Gauge,
  ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, TrendingUp, TrendingDown, Info, FileSearch,
} from "lucide-react";
import {
  insightsApi, SEVERITY_META,
  type Insight, type InsightCategory,
} from "@/lib/insights-api";

const CATEGORY_ICON: Record<InsightCategory, React.ElementType> = {
  vegetation: Leaf, water: Droplets, thermal: Thermometer, restoration: Sprout,
  hydrology: Waves, risk: ShieldAlert, monitoring: CalendarClock, overall: Gauge,
};

function WhyExpander({ insight }: { insight: Insight }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <FileSearch className="w-3 h-3" />
        Why am I seeing this?
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-border/50 bg-background/60 p-3 space-y-2.5 text-[11px]">
          <div>
            <div className="font-semibold text-muted-foreground uppercase tracking-wide mb-1">Rule</div>
            <code className="text-[10px] bg-muted/60 rounded px-1.5 py-0.5">{insight.why.rule_id}</code>
          </div>
          <div>
            <div className="font-semibold text-muted-foreground uppercase tracking-wide mb-1">Metrics used</div>
            <ul className="space-y-0.5">
              {insight.why.metrics_used.map((m, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <code className="text-[10px] text-muted-foreground truncate">{m.path}</code>
                  <span className="font-medium tabular-nums shrink-0">
                    {m.value === null ? "n/a" : `${m.value}${m.unit ? ` ${m.unit}` : ""}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="font-semibold text-muted-foreground uppercase tracking-wide mb-1">Thresholds evaluated</div>
            <ul className="space-y-0.5">
              {insight.why.thresholds.map((t, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.triggered ? "bg-amber-400" : "bg-muted-foreground/40"}`} />
                  <span className="flex-1">{t.name}</span>
                  <span className="text-muted-foreground tabular-nums">{t.operator} {String(t.threshold)} (actual {t.actual === null ? "n/a" : String(t.actual)})</span>
                </li>
              ))}
            </ul>
          </div>
          {insight.why.observations_used.length > 0 && (
            <div>
              <div className="font-semibold text-muted-foreground uppercase tracking-wide mb-1">Observations referenced</div>
              <div className="flex flex-wrap gap-1">
                {insight.why.observations_used.map((o) => (
                  <code key={o} className="text-[10px] bg-muted/60 rounded px-1.5 py-0.5">{o}</code>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InsightCard({ insight }: { insight: Insight }) {
  const Icon = CATEGORY_ICON[insight.category] ?? Info;
  const sev = SEVERITY_META[insight.severity];
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur p-3.5">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
          <Icon className={`w-4 h-4 ${sev.text}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold">{insight.title}</h4>
            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold ${sev.text}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${sev.dot}`} />{sev.label}
            </span>
            <span className="text-[10px] text-muted-foreground">· {Math.round(insight.confidence * 100)}% confidence</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{insight.summary}</p>
          {insight.recommendation && (
            <p className="text-[11px] mt-1.5 text-foreground/90"><span className="font-semibold text-teal-400">Recommendation:</span> {insight.recommendation}</p>
          )}
          {/* Evidence references */}
          <div className="flex flex-wrap gap-1 mt-2">
            {insight.evidence_sources.map((s, i) => (
              <span key={i} title={s.path} className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 text-[10px]">
                <span className="text-muted-foreground">{s.label}:</span>
                <span className="font-medium tabular-nums">{s.value === null ? "n/a" : `${s.value}${s.unit ? ` ${s.unit}` : ""}`}</span>
              </span>
            ))}
          </div>
          <WhyExpander insight={insight} />
        </div>
      </div>
    </div>
  );
}

function Section({ title, icon: Icon, insights, emptyLabel }: { title: string; icon: React.ElementType; insights: Insight[]; emptyLabel: string }) {
  return (
    <div className="space-y-2.5">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5" /> {title}
        <span className="text-[10px] font-normal">({insights.length})</span>
      </h3>
      {insights.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">{emptyLabel}</p>
      ) : (
        <div className="space-y-2.5">{insights.map((i) => <InsightCard key={i.id} insight={i} />)}</div>
      )}
    </div>
  );
}

export function AiInsightsPanel({ projectId, runId }: { projectId: string; runId: string | undefined }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["/api/insights", projectId, runId],
    queryFn: () => insightsApi.get(projectId, runId!),
    enabled: !!projectId && !!runId,
    throwOnError: false,
    staleTime: 30_000,
  });

  const { data: diff } = useQuery({
    queryKey: ["/api/insights", projectId, runId, "diff"],
    queryFn: () => insightsApi.diff(projectId, runId!),
    enabled: !!projectId && !!runId,
    throwOnError: false,
    staleTime: 30_000,
  });

  if (!runId) {
    return <div className="text-sm text-muted-foreground p-6 text-center">Select an evidence run to view ecological insights.</div>;
  }
  if (isLoading) {
    return <div className="text-sm text-muted-foreground p-6 text-center animate-pulse">Generating grounded ecological insights…</div>;
  }
  if (error || !data) {
    return <div className="text-sm text-muted-foreground p-6 text-center">Insights are unavailable for this run. Generate an evidence package first.</div>;
  }

  const ins = data.insights;
  const keyFindings = ins.filter((i) => i.category === "overall" || i.severity === "critical" || i.severity === "warning");
  const positive = ins.filter((i) => i.signal === "positive");
  const risks = ins.filter((i) => i.signal === "risk");
  const opportunities = ins.filter((i) => i.signal === "opportunity");
  const monitoring = ins.filter((i) => i.category === "monitoring" || i.recommendation);
  const es = data.executive_summary;

  return (
    <div className="space-y-6">
      {/* Provenance banner */}
      <div className="flex items-center gap-2 rounded-lg border border-teal-500/30 bg-teal-500/[0.05] px-3 py-2 text-[11px] text-teal-300">
        <Sparkles className="w-3.5 h-3.5 shrink-0" />
        <span>
          {data.insight_count} grounded insights · every statement traceable to evidence ·
          rules <code className="bg-muted/40 rounded px-1">{data.rule_version}</code> ·
          method {data.generation_method}
        </span>
      </div>

      {/* Executive Summary */}
      <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur p-4">
        <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-teal-400" /> Executive Ecological Summary
          <span className="text-[10px] font-normal text-muted-foreground">({es.word_count} words)</span>
        </h3>
        <p className="text-xs leading-relaxed text-foreground/90 mb-3">{es.narrative}</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
          <SummaryList title="Key Improvements" icon={TrendingUp} tone="text-emerald-400" items={es.key_improvements} empty="None this cycle" />
          <SummaryList title="Key Risks" icon={TrendingDown} tone="text-amber-400" items={es.key_risks} empty="None this cycle" />
          <SummaryList title="Recommended Attention" icon={AlertTriangle} tone="text-orange-400" items={es.recommended_attention} empty="No urgent actions" />
          <div>
            <div className="font-semibold uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1"><CalendarClock className="w-3 h-3" /> Monitoring Outlook</div>
            <p className="text-muted-foreground">{es.monitoring_outlook}</p>
          </div>
        </div>
      </div>

      {/* Diff vs previous run */}
      {diff?.hasPrevious && (
        <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur p-4">
          <h3 className="text-sm font-semibold flex items-center gap-2 mb-3"><Gauge className="w-4 h-4 text-violet-400" /> Change Since Previous Run</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-[11px]">
            <DiffList title="New Risks" tone="text-red-400" entries={diff.newRisks} />
            <DiffList title="Resolved Risks" tone="text-emerald-400" entries={diff.resolvedRisks} />
            <DiffList title="Improved Indicators" tone="text-emerald-400" entries={diff.improvedIndicators} />
            <DiffList title="Emerging Trends" tone="text-amber-400" entries={diff.emergingTrends} />
          </div>
        </div>
      )}

      {/* Sections */}
      <Section title="Key Findings" icon={Sparkles} insights={keyFindings} emptyLabel="No critical findings this cycle." />
      <Section title="Positive Signals" icon={CheckCircle2} insights={positive} emptyLabel="No positive signals detected this cycle." />
      <Section title="Risk Signals" icon={ShieldAlert} insights={risks} emptyLabel="No elevated risk signals this cycle." />
      <Section title="Restoration Opportunities" icon={Sprout} insights={opportunities} emptyLabel="No restoration opportunities flagged." />
      <Section title="Monitoring Recommendations" icon={CalendarClock} insights={monitoring} emptyLabel="No specific monitoring recommendations." />
    </div>
  );
}

function SummaryList({ title, icon: Icon, tone, items, empty }: { title: string; icon: React.ElementType; tone: string; items: string[]; empty: string }) {
  return (
    <div>
      <div className={`font-semibold uppercase tracking-wide mb-1 flex items-center gap-1 ${tone}`}><Icon className="w-3 h-3" /> {title}</div>
      {items.length === 0 ? (
        <p className="text-muted-foreground italic">{empty}</p>
      ) : (
        <ul className="space-y-0.5 list-disc list-inside text-muted-foreground">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
      )}
    </div>
  );
}

function DiffList({ title, tone, entries }: { title: string; tone: string; entries: { id: string; title: string }[] }) {
  return (
    <div>
      <div className={`font-semibold uppercase tracking-wide mb-1 ${tone}`}>{title} ({entries.length})</div>
      {entries.length === 0 ? (
        <p className="text-muted-foreground italic">—</p>
      ) : (
        <ul className="space-y-0.5 text-muted-foreground">{entries.map((e) => <li key={e.id}>{e.title}</li>)}</ul>
      )}
    </div>
  );
}
