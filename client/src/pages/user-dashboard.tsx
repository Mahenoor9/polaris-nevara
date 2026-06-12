import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  FileText, Clock, Download, Plus, FileCheck, Map, Loader2, AlertTriangle,
  ChevronRight, TrendingUp, TrendingDown, BarChart3, Globe, Layers, Leaf,
  ShieldCheck, Activity, Info, Bell, Award, Zap, Crosshair, TreePine,
  Droplets, Mountain, Waves, BarChart2, CheckCircle2, XCircle, FlaskConical,
  ChevronDown, Filter, RefreshCw, CalendarClock,
} from 'lucide-react';
import { MonitoringOverview } from '@/components/monitoring/monitoring-overview';
import { MonitoringCalendar } from '@/components/monitoring/monitoring-calendar';
import { useMonitoringReminders } from '@/hooks/use-monitoring-reminders';
import { ReviewDiscussion } from '@/components/review/review-discussion';
import { SubtleOceanBackground } from '@/components/ocean-background';
import { ComplianceDisclaimer } from '@/components/compliance-disclaimer';
import { StatusBadge } from '@/components/status-badge';
import { useAuth } from '@/lib/auth-context';
import { format } from 'date-fns';
import { useState, lazy, Suspense, useEffect, Component, useMemo } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { ProjectSubmissionForm } from '@/components/project-submission-form';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';
import type { Project } from '@shared/schema';
import { Link } from 'wouter';
import { portfolioApi } from '@/lib/portfolio-api';
import type {
  PortfolioOverview, EcosystemDistributionItem, PortfolioAlert,
  PortfolioInsight, GeoFeature, PortfolioRankings,
} from '@/lib/portfolio-api';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';

// ── Error boundary for the submission form ────────────────────────────────────
class SubmitFormErrorBoundary extends Component<
  { children: ReactNode; onReset: () => void },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: ReactNode; onReset: () => void }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message ?? 'Unknown error' };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Intentionally silent in production — error state is displayed in render()
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center py-10 text-center gap-4">
          <AlertTriangle className="w-10 h-10 text-destructive" />
          <div>
            <p className="font-semibold text-destructive mb-1">Form failed to load</p>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">{this.state.message}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => { this.setState({ hasError: false, message: '' }); this.props.onReset(); }}>
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

const GISLandMap = lazy(() => import('@/components/gis-land-map'));
const PortfolioMap = lazy(() => import('@/components/portfolio-map'));

// ── Ecosystem color map ───────────────────────────────────────────────────────
const ECOSYSTEM_COLORS: Record<string, string> = {
  'Mangrove Forest':           '#10b981',
  'Seagrass Meadow':           '#06b6d4',
  'Salt Marsh':                '#f59e0b',
  'Coastal Wetland':           '#3b82f6',
  'Freshwater Wetland':        '#0ea5e9',
  'Lake Restoration':          '#38bdf8',
  'River Restoration':         '#22d3ee',
  'Forest Restoration':        '#4ade80',
  'Agricultural Regeneration': '#a3e635',
  'Mixed Ecosystem':           '#e879f9',
  'Other / Unknown':           '#8b5cf6',
  'Mangrove':                  '#10b981',
  'Seagrass':                  '#06b6d4',
  'Coastal':                   '#3b82f6',
  'Other':                     '#8b5cf6',
};

function ecosystemColor(eco: string) {
  return ECOSYSTEM_COLORS[eco] ?? ECOSYSTEM_COLORS['Other / Unknown'] ?? '#8b5cf6';
}

// ── Dynamic insight computation ────────────────────────────────────────────────
function computeDynamicInsights(
  overview: PortfolioOverview | undefined,
  geoData: { features: GeoFeature[] } | undefined,
  rankingsData: PortfolioRankings | undefined,
  ecoData: { distribution: EcosystemDistributionItem[]; totalArea: number } | undefined,
  apiInsights: PortfolioInsight[],
): PortfolioInsight[] {
  const computed: PortfolioInsight[] = [];

  // Active monitoring
  if (overview?.monitoringRuns && overview.monitoringRuns > 0) {
    computed.push({
      type: 'health',
      text: `${overview.monitoringRuns} active monitoring cycle${overview.monitoringRuns !== 1 ? 's' : ''} running across the portfolio`,
    });
  }

  // Projects under review
  if (overview?.underReview && overview.underReview > 0) {
    computed.push({
      type: 'review',
      text: `${overview.underReview} project${overview.underReview !== 1 ? 's' : ''} currently awaiting verifier review`,
    });
  }

  // Dominant ecosystem
  if (ecoData?.distribution?.length) {
    const largest = ecoData.distribution.reduce((a, b) => (a.areaHa > b.areaHa ? a : b));
    computed.push({
      type: 'coverage',
      text: `Portfolio is ${largest.percentage}% ${largest.ecosystem.toLowerCase()} — spanning ${largest.areaHa.toFixed(1)} ha across ${largest.count} site${largest.count !== 1 ? 's' : ''}`,
    });
  }

  // Top health performer
  if (rankingsData?.topPerformers?.length) {
    const top = rankingsData.topPerformers[0];
    computed.push({
      type: 'verification',
      text: `Highest ecological health: ${top.name} scored ${top.trustScore}/100${top.ndviDeltaPct != null ? ` with ${top.ndviDeltaPct >= 0 ? '+' : ''}${top.ndviDeltaPct.toFixed(1)}% NDVI trend` : ''}`,
    });
  }

  // At-risk sites
  if (rankingsData?.atRisk?.length) {
    computed.push({
      type: 'carbon',
      text: `${rankingsData.atRisk.length} site${rankingsData.atRisk.length !== 1 ? 's' : ''} flagged for elevated ecological risk — verifier attention recommended`,
    });
  }

  // Evidence packages
  if (overview?.evidencePackages && overview.evidencePackages > 0) {
    computed.push({
      type: 'health',
      text: `${overview.evidencePackages} evidence package${overview.evidencePackages !== 1 ? 's' : ''} compiled and available for regulatory reporting`,
    });
  }

  // CO₂ summary
  if (overview?.totalCO2 && overview.totalCO2 > 0) {
    computed.push({
      type: 'carbon',
      text: `Estimated 20-year sequestration potential: ${overview.totalCO2.toLocaleString()} tonnes CO₂e across verified portfolio`,
    });
  }

  // Fallback to API insights
  return computed.length > 0 ? computed : apiInsights;
}

// ── Insight icon map ──────────────────────────────────────────────────────────
function InsightIcon({ type }: { type: string }) {
  const map: Record<string, ReactNode> = {
    coverage:     <Globe className="w-4 h-4" style={{ color: '#3b82f6' }} />,
    verification: <ShieldCheck className="w-4 h-4" style={{ color: '#10b981' }} />,
    review:       <Clock className="w-4 h-4" style={{ color: '#f59e0b' }} />,
    health:       <Activity className="w-4 h-4" style={{ color: '#0ea5e9' }} />,
    vegetation:   <Leaf className="w-4 h-4" style={{ color: '#4ade80' }} />,
    carbon:       <Zap className="w-4 h-4" style={{ color: '#a78bfa' }} />,
  };
  return <span className="shrink-0">{map[type] ?? <Info className="w-4 h-4 text-muted-foreground" />}</span>;
}

function InsightTypeBg(type: string): string {
  const map: Record<string, string> = {
    coverage:     'bg-blue-50/60 dark:bg-blue-950/20 border-blue-100 dark:border-blue-900/40',
    verification: 'bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-100 dark:border-emerald-900/40',
    review:       'bg-amber-50/60 dark:bg-amber-950/20 border-amber-100 dark:border-amber-900/40',
    health:       'bg-sky-50/60 dark:bg-sky-950/20 border-sky-100 dark:border-sky-900/40',
    vegetation:   'bg-green-50/60 dark:bg-green-950/20 border-green-100 dark:border-green-900/40',
    carbon:       'bg-violet-50/60 dark:bg-violet-950/20 border-violet-100 dark:border-violet-900/40',
  };
  return map[type] ?? 'bg-muted/40 border-border/50';
}

// ── Alert severity badge ──────────────────────────────────────────────────────
function AlertSeverityBadge({ severity }: { severity: string }) {
  if (severity === 'critical') return <Badge variant="destructive" className="text-[10px] uppercase tracking-wider shrink-0">Critical</Badge>;
  if (severity === 'warning') return <Badge className="bg-amber-100 text-amber-800 border border-amber-300 text-[10px] uppercase tracking-wider shrink-0">Warning</Badge>;
  return <Badge variant="outline" className="text-[10px] uppercase tracking-wider shrink-0">Info</Badge>;
}

// ── Premium KPI card ──────────────────────────────────────────────────────────
interface KpiCardProps {
  title: string;
  value: string | number;
  icon: React.ElementType;
  accent?: string;
  status?: 'good' | 'warning' | 'neutral' | 'critical';
  subtext?: string;
  trend?: 'up' | 'down' | 'flat';
}

function KpiCard({ title, value, icon: Icon, accent = '#10b981', status = 'neutral', subtext, trend }: KpiCardProps) {
  const statusRing = {
    good:     'ring-emerald-500/20',
    warning:  'ring-amber-500/20',
    critical: 'ring-red-500/20',
    neutral:  'ring-border/30',
  }[status];
  const statusDot = {
    good:     'bg-emerald-500',
    warning:  'bg-amber-500',
    critical: 'bg-red-500',
    neutral:  'bg-slate-400',
  }[status];

  return (
    <div className={`group relative rounded-xl border bg-card p-4 ring-1 ${statusRing} hover:shadow-md transition-all duration-200 overflow-hidden`}>
      {/* Subtle gradient accent bar */}
      <div className="absolute top-0 left-0 right-0 h-0.5 rounded-t-xl opacity-70" style={{ background: accent }} />

      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 truncate">{title}</p>
          <p className="text-2xl font-black font-heading leading-none truncate">{value}</p>
          {subtext && (
            <p className="text-[10px] text-muted-foreground mt-1.5 truncate">{subtext}</p>
          )}
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1.5">
          <div className="p-2 rounded-lg" style={{ background: `${accent}18` }}>
            <Icon className="w-4 h-4" style={{ color: accent }} />
          </div>
          {trend && (
            <div className={`flex items-center gap-0.5 text-[10px] font-semibold ${trend === 'up' ? 'text-emerald-500' : trend === 'down' ? 'text-red-400' : 'text-muted-foreground'}`}>
              {trend === 'up' ? <TrendingUp className="w-3 h-3" /> : trend === 'down' ? <TrendingDown className="w-3 h-3" /> : null}
            </div>
          )}
        </div>
      </div>

      {status !== 'neutral' && (
        <div className="absolute bottom-2.5 right-2.5">
          <span className={`w-1.5 h-1.5 rounded-full inline-block ${statusDot}`} />
        </div>
      )}
    </div>
  );
}

// ── Portfolio filter bar ──────────────────────────────────────────────────────
interface FilterState {
  ecosystem: string;
  status: string;
  risk: string;
}

const ALL = 'all';

function FilterChip({
  label, value, options, onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = value !== ALL;
  const activeLabel = options.find((o) => o.value === value)?.label ?? label;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-150 ${
          active
            ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
            : 'bg-background text-muted-foreground border-border hover:border-emerald-500/40 hover:text-foreground'
        }`}
      >
        {active ? activeLabel : label}
        <ChevronDown className={`w-3 h-3 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[1999]" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1.5 z-[2000] bg-popover border border-border rounded-xl shadow-xl overflow-hidden min-w-[160px]">
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); setOpen(false); }}
                className={`flex items-center gap-2 w-full px-3 py-2 text-xs text-left transition-colors ${
                  value === opt.value
                    ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 font-semibold'
                    : 'hover:bg-muted/50 text-foreground'
                }`}
              >
                {value === opt.value && <CheckCircle2 className="w-3 h-3 shrink-0" />}
                {value !== opt.value && <span className="w-3 shrink-0" />}
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Premium empty states ──────────────────────────────────────────────────────
function EmptyState({
  icon: Icon, title, description, action, actionLabel,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-14 gap-4 text-center">
      <div className="relative">
        <div className="w-16 h-16 rounded-2xl bg-muted/40 flex items-center justify-center">
          <Icon className="w-7 h-7 text-muted-foreground/50" />
        </div>
        <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-background border border-border flex items-center justify-center">
          <span className="text-[10px]">○</span>
        </div>
      </div>
      <div className="max-w-xs">
        <p className="font-semibold text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{description}</p>
      </div>
      {action && actionLabel && (
        <Button size="sm" onClick={action} className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-medium gap-2">
          <Plus className="w-3.5 h-3.5" /> {actionLabel}
        </Button>
      )}
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────
function SkeletonCard({ lines = 2 }: { lines?: number }) {
  return (
    <div className="rounded-xl border bg-card p-4 space-y-3 animate-pulse">
      <div className="h-3 bg-muted rounded w-1/3" />
      <div className="h-7 bg-muted rounded w-1/2" />
      {Array.from({ length: lines - 1 }).map((_, i) => (
        <div key={i} className="h-2 bg-muted/60 rounded w-2/3" />
      ))}
    </div>
  );
}

// ── Portfolio Tab ─────────────────────────────────────────────────────────────
function PortfolioTab({ userId, onNewProject }: { userId: string; onNewProject: () => void }) {
  const [filters, setFilters] = useState<FilterState>({ ecosystem: ALL, status: ALL, risk: ALL });
  const [mapFeature, setMapFeature] = useState<GeoFeature | null>(null);

  const { data: overview, isLoading: ovLoading } = useQuery<PortfolioOverview>({
    queryKey: ['/api/portfolio/overview'],
    queryFn: portfolioApi.getOverview,
    enabled: !!userId,
    throwOnError: false,
  });

  const { data: ecoData } = useQuery<{ distribution: EcosystemDistributionItem[]; totalArea: number }>({
    queryKey: ['/api/portfolio/ecosystem-distribution'],
    queryFn: portfolioApi.getEcosystemDistribution,
    enabled: !!userId,
    throwOnError: false,
  });

  const { data: rankingsData } = useQuery<PortfolioRankings>({
    queryKey: ['/api/portfolio/rankings'],
    queryFn: portfolioApi.getRankings,
    enabled: !!userId,
    throwOnError: false,
  });

  const { data: alertsData } = useQuery<{ alerts: PortfolioAlert[]; count: number }>({
    queryKey: ['/api/portfolio/alerts'],
    queryFn: portfolioApi.getAlerts,
    enabled: !!userId,
    throwOnError: false,
  });

  const { data: insightsData } = useQuery<{ insights: PortfolioInsight[] }>({
    queryKey: ['/api/portfolio/insights'],
    queryFn: portfolioApi.getInsights,
    enabled: !!userId,
    throwOnError: false,
  });

  const { data: geoData } = useQuery<{ features: GeoFeature[] }>({
    queryKey: ['/api/portfolio/projects-geo'],
    queryFn: portfolioApi.getProjectsGeo,
    enabled: !!userId,
    throwOnError: false,
  });

  // Compute rich insights combining API + derived
  const insights = useMemo(
    () => computeDynamicInsights(overview, geoData, rankingsData, ecoData, insightsData?.insights ?? []),
    [overview, geoData, rankingsData, ecoData, insightsData],
  );

  // Filter geo features for map
  const filteredFeatures = useMemo(() => {
    let feats = geoData?.features ?? [];
    if (filters.ecosystem !== ALL) feats = feats.filter((f) => f.ecosystemType === filters.ecosystem);
    if (filters.status !== ALL) feats = feats.filter((f) => f.status?.toLowerCase() === filters.status);
    if (filters.risk !== ALL) {
      feats = feats.filter((f) => {
        const s = f.trustScore;
        if (filters.risk === 'healthy') return s == null || s >= 70;
        if (filters.risk === 'warning') return s != null && s >= 45 && s < 70;
        if (filters.risk === 'critical') return s != null && s < 45;
        return true;
      });
    }
    return feats;
  }, [geoData, filters]);

  // Build filter options from data
  const ecoOptions = useMemo(() => {
    const ecosystems = [...new Set((geoData?.features ?? []).map((f) => f.ecosystemType))];
    return [
      { value: ALL, label: 'All Ecosystems' },
      ...ecosystems.map((e) => ({ value: e, label: e })),
    ];
  }, [geoData]);

  const statusOptions = [
    { value: ALL, label: 'All Status' },
    { value: 'pending', label: 'Pending' },
    { value: 'verified', label: 'Verified' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'needs_clarification', label: 'Needs Clarification' },
  ];

  const riskOptions = [
    { value: ALL, label: 'All Risk Levels' },
    { value: 'healthy', label: 'Healthy (≥70)' },
    { value: 'warning', label: 'Warning (45–69)' },
    { value: 'critical', label: 'At Risk (<45)' },
  ];

  const hasFilters = filters.ecosystem !== ALL || filters.status !== ALL || filters.risk !== ALL;

  // KPI data
  const totalProjects = overview?.totalProjects ?? 0;
  const totalArea = overview?.totalAreaHa ?? 0;
  const healthScore = overview?.avgHealthScore ?? 0;
  const underReview = overview?.underReview ?? 0;
  const verifiedCount = (rankingsData?.topPerformers?.length ?? 0);

  const chartData = (ecoData?.distribution ?? []).map((d) => ({
    name: d.ecosystem,
    value: d.areaHa,
    percentage: d.percentage,
    count: d.count,
  }));

  const criticalAlerts = (alertsData?.alerts ?? []).filter((a) => a.severity === 'critical');
  const warningAlerts = (alertsData?.alerts ?? []).filter((a) => a.severity === 'warning');
  const infoAlerts = (alertsData?.alerts ?? []).filter((a) => a.severity === 'info');

  if (ovLoading) {
    return (
      <div className="space-y-8">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
        <div className="h-72 rounded-xl bg-muted/20 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ── KPI Grid ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard
          title="Total Projects"
          value={totalProjects || '—'}
          icon={FileText}
          accent="#10b981"
          status={totalProjects > 0 ? 'good' : 'neutral'}
          trend={totalProjects > 0 ? 'up' : 'flat'}
        />
        <KpiCard
          title="Area Monitored"
          value={totalArea > 0 ? `${totalArea.toLocaleString()} ha` : '—'}
          icon={Globe}
          accent="#3b82f6"
          status={totalArea > 0 ? 'good' : 'neutral'}
          subtext={ecoData?.distribution?.length ? `${ecoData.distribution.length} ecosystem type${ecoData.distribution.length !== 1 ? 's' : ''}` : undefined}
        />
        <KpiCard
          title="Avg Health Score"
          value={healthScore > 0 ? `${healthScore}/100` : '—'}
          icon={Activity}
          accent={healthScore >= 70 ? '#10b981' : healthScore >= 45 ? '#f59e0b' : '#ef4444'}
          status={healthScore >= 70 ? 'good' : healthScore >= 45 ? 'warning' : healthScore > 0 ? 'critical' : 'neutral'}
          trend={healthScore >= 70 ? 'up' : healthScore > 0 ? 'down' : 'flat'}
        />
        <KpiCard
          title="Under Review"
          value={underReview || '—'}
          icon={Clock}
          accent={underReview > 0 ? '#f59e0b' : '#64748b'}
          status={underReview > 2 ? 'warning' : 'neutral'}
          subtext={underReview > 0 ? 'Awaiting verifier' : undefined}
        />
        <KpiCard
          title="Monitoring Cycles"
          value={overview?.monitoringRuns || '—'}
          icon={BarChart3}
          accent="#0ea5e9"
          status={(overview?.monitoringRuns ?? 0) > 0 ? 'good' : 'neutral'}
          trend={(overview?.monitoringRuns ?? 0) > 0 ? 'up' : 'flat'}
        />
        <KpiCard
          title="Evidence Packages"
          value={overview?.evidencePackages || '—'}
          icon={Layers}
          accent="#a78bfa"
          status={(overview?.evidencePackages ?? 0) > 0 ? 'good' : 'neutral'}
          subtext={(overview?.evidencePackages ?? 0) > 0 ? 'Ready for audit' : undefined}
        />
      </div>

      {/* ── CO₂ banner ── */}
      {overview?.totalCO2 != null && overview.totalCO2 > 0 && (
        <div className="relative rounded-xl border border-emerald-500/20 bg-gradient-to-r from-emerald-500/8 via-teal-500/8 to-cyan-500/8 px-6 py-4 flex items-center gap-4 overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_left,rgba(16,185,129,0.07),transparent_60%)]" />
          <div className="p-2 rounded-xl bg-emerald-500/15 shrink-0">
            <Leaf className="w-6 h-6 text-emerald-500" />
          </div>
          <div className="relative">
            <p className="text-xs font-bold uppercase tracking-widest text-emerald-600/70 dark:text-emerald-400/70 mb-0.5">
              Total Estimated CO₂ Sequestration Potential
            </p>
            <p className="text-2xl font-black text-emerald-700 dark:text-emerald-300 leading-none">
              {overview.totalCO2.toLocaleString()}{' '}
              <span className="text-sm font-semibold text-emerald-600/70 dark:text-emerald-400/70">tonnes CO₂e</span>
            </p>
          </div>
        </div>
      )}

      {/* ── Ecosystem Distribution + Executive Insights ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Ecosystem Distribution */}
        <Card className="border-border/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="w-4 h-4 text-muted-foreground" />
              Ecosystem Distribution
            </CardTitle>
            <CardDescription>Portfolio breakdown by ecosystem type</CardDescription>
          </CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <EmptyState
                icon={Layers}
                title="No ecosystem data yet"
                description="Submit projects with ecosystem types to see your portfolio distribution."
                action={onNewProject}
                actionLabel="Submit Project"
              />
            ) : (
              <div className="flex flex-col gap-4">
                <ResponsiveContainer width="100%" height={190}>
                  <PieChart>
                    <Pie
                      data={chartData}
                      cx="50%" cy="50%"
                      innerRadius={50} outerRadius={80}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {chartData.map((entry) => (
                        <Cell key={entry.name} fill={ecosystemColor(entry.name)} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#e2e8f0', fontSize: 11 }}
                      formatter={(value: any, name: string, props: any) => [
                        `${Number(value).toFixed(1)} ha (${props.payload.percentage}%)`,
                        props.payload.name,
                      ]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                  {chartData.map((d) => (
                    <div key={d.name} className="flex items-center justify-between text-sm py-1 border-b border-border/40 last:border-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: ecosystemColor(d.name) }} />
                        <span className="font-medium truncate">{d.name}</span>
                        <span className="text-muted-foreground text-xs shrink-0">×{d.count}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${d.percentage}%`, background: ecosystemColor(d.name) }} />
                        </div>
                        <span className="font-semibold text-xs w-10 text-right">{d.percentage}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Executive Insights */}
        <Card className="border-border/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Award className="w-4 h-4 text-muted-foreground" />
              Executive Insights
            </CardTitle>
            <CardDescription>Real-time portfolio intelligence</CardDescription>
          </CardHeader>
          <CardContent>
            {insights.length === 0 ? (
              <EmptyState
                icon={BarChart2}
                title="No insights available"
                description="Insights are generated once projects are verified and monitoring begins."
              />
            ) : (
              <ul className="space-y-2.5">
                {insights.slice(0, 6).map((ins, i) => (
                  <li
                    key={i}
                    className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${InsightTypeBg(ins.type)}`}
                  >
                    <InsightIcon type={ins.type} />
                    <p className="text-sm leading-relaxed text-foreground/90">{ins.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Geographic Portfolio Map ── */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Globe className="w-4 h-4 text-muted-foreground" />
                Geographic Portfolio Map
              </CardTitle>
              <CardDescription>All project boundaries — click a polygon for details</CardDescription>
            </div>
            {/* Filter bar */}
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <Filter className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <FilterChip
                label="Ecosystem"
                value={filters.ecosystem}
                options={ecoOptions}
                onChange={(v) => setFilters((f) => ({ ...f, ecosystem: v }))}
              />
              <FilterChip
                label="Status"
                value={filters.status}
                options={statusOptions}
                onChange={(v) => setFilters((f) => ({ ...f, status: v }))}
              />
              <FilterChip
                label="Risk Level"
                value={filters.risk}
                options={riskOptions}
                onChange={(v) => setFilters((f) => ({ ...f, risk: v }))}
              />
              {hasFilters && (
                <button
                  type="button"
                  onClick={() => setFilters({ ecosystem: ALL, status: ALL, risk: ALL })}
                  className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          {hasFilters && (
            <p className="text-xs text-muted-foreground mt-1">
              Showing {filteredFeatures.length} of {geoData?.features?.length ?? 0} sites
            </p>
          )}
        </CardHeader>
        <CardContent>
          <Suspense fallback={
            <div className="h-[420px] flex items-center justify-center bg-muted/20 rounded-xl border animate-pulse">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          }>
            <PortfolioMap
              features={filteredFeatures}
              height={420}
              onFeatureClick={setMapFeature}
            />
          </Suspense>

          {/* Selected map feature detail strip */}
          {mapFeature && (
            <div className="mt-3 flex items-center gap-4 px-4 py-3 rounded-xl border border-border/60 bg-muted/30">
              <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: ecosystemColor(mapFeature.ecosystemType) }} />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate">{mapFeature.name}</p>
                <p className="text-xs text-muted-foreground">{mapFeature.ecosystemType}</p>
              </div>
              {mapFeature.areaHa != null && (
                <div className="text-right shrink-0">
                  <p className="text-xs text-muted-foreground">Area</p>
                  <p className="font-bold text-sm">{Number(mapFeature.areaHa).toFixed(1)} ha</p>
                </div>
              )}
              {mapFeature.trustScore != null && (
                <div className="text-right shrink-0">
                  <p className="text-xs text-muted-foreground">Health</p>
                  <p
                    className="font-bold text-sm"
                    style={{ color: mapFeature.trustScore >= 70 ? '#10b981' : mapFeature.trustScore >= 45 ? '#f59e0b' : '#ef4444' }}
                  >
                    {mapFeature.trustScore}/100
                  </p>
                </div>
              )}
              <StatusBadge status={mapFeature.status} />
              <button
                type="button"
                onClick={() => setMapFeature(null)}
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Rankings ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Top Performers */}
        <Card className="border-border/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <TrendingUp className="w-4 h-4 text-emerald-500" />
              Top Performers
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!rankingsData?.topPerformers?.length ? (
              <EmptyState
                icon={TrendingUp}
                title="No scored projects yet"
                description="Health scores appear after verification and monitoring runs."
              />
            ) : (
              <ul className="space-y-0">
                {rankingsData.topPerformers.slice(0, 5).map((p, i) => (
                  <li key={p.id} className="flex items-center gap-3 py-2.5 border-b border-border/40 last:border-0 group">
                    <span className="text-xs font-bold text-muted-foreground w-5 shrink-0 text-center">#{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">{p.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{p.ecosystemType}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400">{p.trustScore}/100</p>
                      {p.ndviDeltaPct != null && (
                        <p className={`text-[10px] font-medium ${p.ndviDeltaPct >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                          {p.ndviDeltaPct >= 0 ? '+' : ''}{p.ndviDeltaPct.toFixed(1)}% NDVI
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* At Risk */}
        <Card className="border-border/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              Requires Attention
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!rankingsData?.atRisk?.length ? (
              <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
                <ShieldCheck className="w-8 h-8 text-emerald-500/50" />
                <p className="text-sm text-muted-foreground">Portfolio is healthy</p>
                <p className="text-xs text-muted-foreground/70">No sites flagged for risk</p>
              </div>
            ) : (
              <ul className="space-y-0">
                {rankingsData.atRisk.slice(0, 5).map((p) => (
                  <li key={p.id} className="flex items-center gap-3 py-2.5 border-b border-border/40 last:border-0">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{p.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{p.ecosystemType}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {p.redFlag && <Badge variant="destructive" className="text-[9px] px-1.5 py-0.5">Red Flag</Badge>}
                      {p.status === 'needs_clarification' && <Badge className="bg-amber-100 text-amber-700 border-amber-300 text-[9px] px-1.5">Clarification</Badge>}
                      {p.mrvStatus === 'FAILED' && <Badge variant="destructive" className="text-[9px] px-1.5">MRV Failed</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Most Improved */}
        <Card className="border-border/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <TrendingUp className="w-4 h-4 text-blue-500" />
              Most Improved
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!rankingsData?.mostImproved?.length ? (
              <EmptyState
                icon={BarChart3}
                title="No improvement data"
                description="NDVI delta trends appear after successive monitoring runs."
              />
            ) : (
              <ul className="space-y-0">
                {rankingsData.mostImproved.slice(0, 5).map((p, i) => (
                  <li key={p.id} className="flex items-center gap-3 py-2.5 border-b border-border/40 last:border-0 group">
                    <span className="text-xs font-bold text-muted-foreground w-5 shrink-0 text-center">#{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">{p.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{p.ecosystemType}</p>
                    </div>
                    {p.ndviDeltaPct != null && (
                      <span className="text-sm font-bold text-blue-600 dark:text-blue-400 shrink-0">
                        +{p.ndviDeltaPct.toFixed(1)}%
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Alerts Center ── */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="w-4 h-4 text-muted-foreground" />
            Alerts Center
            {alertsData && alertsData.count > 0 && (
              <Badge variant="destructive" className="ml-1 text-xs">{alertsData.count}</Badge>
            )}
          </CardTitle>
          <CardDescription>Centralized monitoring and verification alerts</CardDescription>
        </CardHeader>
        <CardContent>
          {!alertsData?.alerts?.length ? (
            <div className="flex items-center gap-3 py-5 justify-center">
              <div className="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-950/30 flex items-center justify-center">
                <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">All clear — portfolio is healthy</p>
                <p className="text-xs text-muted-foreground">No active alerts across monitored sites</p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {[...criticalAlerts, ...warningAlerts, ...infoAlerts].map((alert, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
                    alert.severity === 'critical'
                      ? 'bg-red-50/50 dark:bg-red-950/20 border-red-200 dark:border-red-900/40'
                      : alert.severity === 'warning'
                      ? 'bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/40'
                      : 'bg-blue-50/30 dark:bg-blue-950/10 border-blue-100 dark:border-blue-900/30'
                  }`}
                >
                  <AlertSeverityBadge severity={alert.severity} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium leading-snug">{alert.message}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{alert.projectName}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Projects Tab ──────────────────────────────────────────────────────────────
function ProjectsTab({
  projects, projectsLoading, projectsError,
  refetchProjects, setShowSubmitForm, setSelectedProject,
}: {
  projects: Project[];
  projectsLoading: boolean;
  projectsError: any;
  refetchProjects: () => void;
  setShowSubmitForm: (v: boolean) => void;
  setSelectedProject: (p: any) => void;
}) {
  const verifiedCount = projects.filter((p: any) => p.status?.toLowerCase() === 'verified').length;
  const pendingCount = projects.filter((p: any) => p.status?.toLowerCase() === 'pending').length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard title="Total Projects" value={projects.length || '—'} icon={FileText} accent="#10b981" status={projects.length > 0 ? 'good' : 'neutral'} />
        <KpiCard title="Verified" value={verifiedCount || '—'} icon={FileCheck} accent="#0ea5e9" status={verifiedCount > 0 ? 'good' : 'neutral'} />
        <KpiCard title="Pending Review" value={pendingCount || '—'} icon={Clock} accent="#f59e0b" status={pendingCount > 2 ? 'warning' : 'neutral'} />
      </div>

      <Card className="border-border/60">
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="w-4 h-4 text-muted-foreground" />
                My Projects
              </CardTitle>
              <CardDescription>All submitted ecological restoration projects</CardDescription>
            </div>
            <Button
              size="sm"
              onClick={() => setShowSubmitForm(true)}
              className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-medium gap-2"
            >
              <Plus className="w-3.5 h-3.5" />
              Submit Project
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {projectsLoading ? (
            <div className="space-y-2 py-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 bg-muted/30 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : projectsError ? (
            <div className="text-center py-10">
              <AlertTriangle className="w-8 h-8 text-destructive/50 mx-auto mb-3" />
              <p className="font-medium text-destructive mb-1">Could not load projects</p>
              <p className="text-sm text-muted-foreground mb-4">Check your connection and try again.</p>
              <Button variant="outline" size="sm" onClick={() => refetchProjects()} className="gap-2">
                <RefreshCw className="w-3.5 h-3.5" /> Retry
              </Button>
            </div>
          ) : projects.length === 0 ? (
            <EmptyState
              icon={TreePine}
              title="No projects submitted yet"
              description="Start your ecological intelligence portfolio by submitting your first restoration project. Include GIS boundaries for full monitoring capabilities."
              action={() => setShowSubmitForm(true)}
              actionLabel="Submit First Project"
            />
          ) : (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full min-w-[600px]">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-3 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Project</th>
                    <th className="pb-3 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                    <th className="pb-3 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ecosystem</th>
                    <th className="pb-3 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Area</th>
                    <th className="pb-3 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Submitted</th>
                    <th className="pb-3 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground" />
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project: any) => (
                    <tr
                      key={project.id}
                      className="border-b border-border/40 hover:bg-muted/30 transition-colors group"
                      data-testid={`row-project-${project.id}`}
                    >
                      <td className="py-3.5 px-1">
                        <p className="text-sm font-semibold group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">{project.name}</p>
                      </td>
                      <td className="py-3.5 px-1"><StatusBadge status={project.status} /></td>
                      <td className="py-3.5 px-1">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: ecosystemColor(project.ecosystemType) }} />
                          <span className="text-xs font-medium text-muted-foreground">{project.ecosystemType}</span>
                        </div>
                      </td>
                      <td className="py-3.5 px-1">
                        <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                          {project.area?.toFixed(2) || '0.00'} ha
                        </span>
                      </td>
                      <td className="py-3.5 px-1 text-xs text-muted-foreground">{format(new Date(project.submittedAt), 'PP')}</td>
                      <td className="py-3.5 px-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedProject(project)}
                          className="text-xs h-7 hover:border-emerald-500/40 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                          data-testid={`button-view-${project.id}`}
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Reports Tab ───────────────────────────────────────────────────────────────
function ReportsTab({ projects, projectsLoading }: { projects: Project[]; projectsLoading: boolean }) {
  const projectsWithReports = projects.filter(
    (p: any) => p.mrvStatus === 'COMPLETED' || p.status?.toLowerCase() === 'verified',
  );

  return (
    <div className="space-y-6">
      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileCheck className="w-4 h-4 text-emerald-500" />
            Monitoring Reports
          </CardTitle>
          <CardDescription>Generated MRV and ecological health audits</CardDescription>
        </CardHeader>
        <CardContent>
          {projectsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} lines={3} />)}
            </div>
          ) : projectsWithReports.length === 0 ? (
            <EmptyState
              icon={FlaskConical}
              title="No reports generated yet"
              description="MRV reports are compiled once a verifier validates the GIS boundary and the monitoring pipeline completes its first cycle."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {projectsWithReports.map((project: any) => (
                <div
                  key={project.id}
                  className="group rounded-xl border border-emerald-500/20 bg-gradient-to-br from-emerald-50/30 to-teal-50/10 dark:from-emerald-950/20 dark:to-teal-950/10 p-4 flex flex-col justify-between gap-3 hover:border-emerald-500/40 hover:shadow-sm transition-all duration-200"
                >
                  <div>
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full mb-2">
                      <CheckCircle2 className="w-2.5 h-2.5" /> MRV Completed
                    </span>
                    <h4 className="font-semibold text-sm leading-snug line-clamp-2 group-hover:text-emerald-700 dark:group-hover:text-emerald-300 transition-colors">{project.name}</h4>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {project.ecosystemType} · {project.area?.toFixed(1)} ha
                    </p>
                  </div>
                  <Link href={`/projects/${project.id}/mrv-report`}>
                    <Button size="sm" className="w-full gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs h-8">
                      View Full Report <ChevronRight className="w-3 h-3" />
                    </Button>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function UserDashboard() {
  const { user, refreshUser } = useAuth();
  const { toast } = useToast();

  useEffect(() => { refreshUser(); }, []);

  // OPS-1: surface monitoring reminders in the notification centre (deep-links to MRV report).
  useMonitoringReminders({ linkBase: '/projects', linkSuffix: '/mrv-report' });

  const [showSubmitForm, setShowSubmitForm] = useState(false);
  const [submitFormInstanceKey, setSubmitFormInstanceKey] = useState(0);
  const [selectedProject, setSelectedProject] = useState<any>(null);

  const {
    data: projects = [],
    isLoading: projectsLoading,
    error: projectsError,
    refetch: refetchProjects,
  } = useQuery<Project[]>({
    queryKey: ['/api/projects/my'],
    enabled: !!user?.id,
    refetchOnMount: 'always',
  });

  const { data: warnings = [] } = useQuery<any[]>({
    queryKey: [`/api/admin/warnings/${user?.id}`],
    enabled: !!user?.id,
  });

  const syncContributorDashboard = async (createdProject?: Project) => {
    if (createdProject) {
      queryClient.setQueryData<Project[]>(['/api/projects/my'], (current = []) => {
        const withoutDuplicate = current.filter((p) => p.id !== createdProject.id);
        return [createdProject, ...withoutDuplicate];
      });
    }
    setShowSubmitForm(false);
    setSubmitFormInstanceKey((k) => k + 1);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['/api/projects/my'] }),
      queryClient.invalidateQueries({ queryKey: ['/api/projects/pending'] }),
      queryClient.invalidateQueries({ queryKey: ['/api/stats'] }),
      queryClient.invalidateQueries({ queryKey: ['/api/portfolio/overview'] }),
      queryClient.invalidateQueries({ queryKey: ['/api/portfolio/ecosystem-distribution'] }),
      queryClient.invalidateQueries({ queryKey: ['/api/portfolio/rankings'] }),
      queryClient.invalidateQueries({ queryKey: ['/api/portfolio/alerts'] }),
      queryClient.invalidateQueries({ queryKey: ['/api/portfolio/insights'] }),
      queryClient.invalidateQueries({ queryKey: ['/api/portfolio/projects-geo'] }),
      refetchProjects(),
    ]);
  };

  return (
    <div className="min-h-screen">
      <SubtleOceanBackground />

      <div className="container mx-auto px-4 sm:px-6 py-8 space-y-6 page-enter">
        <ComplianceDisclaimer variant="inline" />

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-heading font-bold tracking-tight">Project Portfolio</h1>
            <p className="text-muted-foreground mt-1 text-sm">Ecological restoration projects · satellite monitoring · carbon intelligence</p>
          </div>
          <Button
            onClick={() => setShowSubmitForm(true)}
            className="shrink-0 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold gap-2"
            data-testid="button-submit-project"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Submit Project</span>
            <span className="sm:hidden">New</span>
          </Button>
        </div>

        {/* Admin warnings */}
        {warnings.length > 0 && (
          <Card className="border-amber-600/20 bg-amber-50/50 dark:bg-amber-950/10">
            <CardHeader className="pb-3 border-b border-amber-600/10">
              <CardTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-400 text-base">
                <AlertTriangle className="w-4 h-4" />
                Administrative Notices
              </CardTitle>
              <CardDescription className="text-amber-600/80">Review and address the follow-up actions below.</CardDescription>
            </CardHeader>
            <CardContent className="pt-4 space-y-2">
              {warnings.map((w: any, i: number) => (
                <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-background/60 border border-amber-200/60 dark:border-amber-800/30">
                  <div className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${w.severity === 'Critical' ? 'bg-red-500' : w.severity === 'Medium' ? 'bg-amber-500' : 'bg-blue-500'}`} />
                  <div>
                    <p className="text-sm font-semibold">{w.message}</p>
                    <p className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground mt-0.5">
                      {format(new Date(w.date), 'PPP')} · Severity: {w.severity}
                    </p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Main tabs */}
        <Tabs defaultValue="portfolio">
          <TabsList className="h-10 mb-1">
            <TabsTrigger value="portfolio" className="gap-2 text-xs font-semibold">
              <BarChart3 className="w-3.5 h-3.5" />
              Portfolio Intelligence
            </TabsTrigger>
            <TabsTrigger value="projects" className="gap-2 text-xs font-semibold">
              <FileText className="w-3.5 h-3.5" />
              My Projects
              {projects.length > 0 && (
                <Badge variant="secondary" className="ml-0.5 text-[10px] px-1.5 py-0">{projects.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="monitoring" className="gap-2 text-xs font-semibold">
              <CalendarClock className="w-3.5 h-3.5" />
              Monitoring
            </TabsTrigger>
            <TabsTrigger value="reports" className="gap-2 text-xs font-semibold">
              <FileCheck className="w-3.5 h-3.5" />
              Reports
            </TabsTrigger>
          </TabsList>

          <TabsContent value="portfolio" className="mt-4">
            <PortfolioTab userId={user?.id ?? ''} onNewProject={() => setShowSubmitForm(true)} />
          </TabsContent>

          <TabsContent value="projects" className="mt-4">
            <ProjectsTab
              projects={projects}
              projectsLoading={projectsLoading}
              projectsError={projectsError}
              refetchProjects={refetchProjects}
              setShowSubmitForm={setShowSubmitForm}
              setSelectedProject={setSelectedProject}
            />
          </TabsContent>

          <TabsContent value="monitoring" className="mt-4">
            <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
              <div className="xl:col-span-2">
                <MonitoringOverview
                  linkBase="/projects"
                  linkSuffix="/mrv-report"
                  canEdit={false}
                  title="My Monitoring Schedule"
                />
              </div>
              <div className="xl:col-span-3">
                <MonitoringCalendar linkBase="/projects" linkSuffix="/mrv-report" />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="reports" className="mt-4">
            <ReportsTab projects={projects} projectsLoading={projectsLoading} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Submit Project Dialog */}
      <Dialog
        open={showSubmitForm}
        onOpenChange={(open) => {
          setShowSubmitForm(open);
          if (!open) setSubmitFormInstanceKey((k) => k + 1);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl font-heading">Submit New Project</DialogTitle>
          </DialogHeader>
          <SubmitFormErrorBoundary onReset={() => setSubmitFormInstanceKey((k) => k + 1)}>
            {showSubmitForm ? (
              <ProjectSubmissionForm
                key={submitFormInstanceKey}
                onSuccess={(payload) => { void syncContributorDashboard(payload); }}
              />
            ) : null}
          </SubmitFormErrorBoundary>
        </DialogContent>
      </Dialog>

      {/* Project Detail Dialog */}
      <Dialog open={!!selectedProject} onOpenChange={() => setSelectedProject(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {selectedProject && (
            <>
              <DialogHeader>
                <DialogTitle className="text-xl font-heading">{selectedProject.name}</DialogTitle>
              </DialogHeader>
              <div className="space-y-5 pt-1">
                <p className="text-muted-foreground text-sm leading-relaxed">{selectedProject.description}</p>

                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Status', value: <StatusBadge status={selectedProject.status} /> },
                    { label: 'Monitoring', value: <span className="text-sm font-semibold capitalize">{selectedProject.mrvStatus || 'NONE'}</span> },
                    { label: 'Ecosystem', value: <span className="text-sm">{selectedProject.ecosystemType || '—'}</span> },
                    { label: 'Frequency', value: <span className="text-sm capitalize">{selectedProject.monitoringFrequency || 'monthly'}</span> },
                    { label: 'Area', value: <span className="text-sm font-semibold">{selectedProject.area ? `${selectedProject.area} ha` : '—'}</span> },
                    { label: 'Location', value: <span className="text-sm">{selectedProject.location || '—'}</span> },
                    ...(selectedProject.areaHectares != null ? [{ label: 'Verified GIS Area', value: <span className="text-sm font-semibold">{selectedProject.areaHectares.toFixed(4)} ha</span> }] : []),
                    ...(selectedProject.perimeterKm != null ? [{ label: 'GIS Perimeter', value: <span className="text-sm">{selectedProject.perimeterKm.toFixed(3)} km</span> }] : []),
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-muted/30 rounded-lg p-3 border border-border/40">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">{label}</p>
                      {value}
                    </div>
                  ))}
                </div>

                {selectedProject.landBoundary && (
                  <div className="border-t pt-4">
                    <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
                      <Map className="w-4 h-4 text-muted-foreground" />
                      Land Boundary
                    </h3>
                    <Suspense fallback={
                      <div className="h-[280px] flex items-center justify-center border rounded-xl bg-muted/20 animate-pulse">
                        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                      </div>
                    }>
                      <GISLandMap
                        initialBoundary={(() => { try { return JSON.parse(selectedProject.landBoundary); } catch { return []; } })()}
                        onBoundaryChange={() => {}}
                        readOnly={true}
                      />
                    </Suspense>
                  </div>
                )}

                {selectedProject.rejectionReason && (
                  <div className="border-t pt-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Rejection Reason</p>
                    <p className="text-sm text-destructive font-medium">{selectedProject.rejectionReason}</p>
                  </div>
                )}

                {selectedProject.proofFileUrl && (
                  <div className="border-t pt-4">
                    <Button variant="outline" size="sm" asChild className="gap-2">
                      <a href={selectedProject.proofFileUrl} target="_blank" rel="noopener noreferrer">
                        <FileText className="w-3.5 h-3.5" /> View Proof Document
                      </a>
                    </Button>
                  </div>
                )}



                {/* OPS-2: Review & Discussion — respond to verifier clarifications */}
                <div className="border-t pt-4">
                  <ReviewDiscussion
                    projectId={selectedProject.id}
                    deepLink={`/dashboard`}
                  />
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
