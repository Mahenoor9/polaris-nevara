import { useQuery, useMutation } from '@tanstack/react-query';
import { useState, lazy, Suspense, useMemo } from 'react';
import { useLocation } from 'wouter';
import { format, formatDistanceToNow } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { SubtleOceanBackground } from '@/components/ocean-background';
import { StatusBadge } from '@/components/status-badge';
import { MRVScoreBadge } from '@/components/mrv-score-badge';
import { MRVWorkflow } from '@/components/mrv-workflow';
import { ActivityTimeline } from '@/components/activity-timeline';
import { useNotifications } from '@/components/notification-center';
import {
  Building2, Globe, FolderOpen, Clock, Satellite, FileCheck, Layers, Map as MapIcon,
  Search, ChevronDown, ChevronUp, FileText, CheckCircle, CheckCircle2, XCircle,
  MessageSquare, MapPin, Loader2, Activity, TreePine, RefreshCw,
  TrendingUp, ArrowRight, AlertTriangle, ShieldAlert, Zap,
} from 'lucide-react';
import type { Project } from '@shared/schema';
import { safeErrorMsg } from '@/lib/safe-error';
import { MonitoringQueuePanel } from '@/components/monitoring/monitoring-queue-panel';
import { MonitoringOverview } from '@/components/monitoring/monitoring-overview';
import { MonitoringCalendar } from '@/components/monitoring/monitoring-calendar';
import { useMonitoringReminders } from '@/hooks/use-monitoring-reminders';
import { ReviewInbox } from '@/components/review/review-inbox';
import { useReviewInboxNotifications } from '@/hooks/use-review-notifications';


const GISLandMap = lazy(() => import('@/components/gis-land-map'));

const REJECTION_REASON_CODES = [
  { value: 'RJ-01', label: 'RJ-01: Invalid Boundary / GIS Discrepancy' },
  { value: 'RJ-02', label: 'RJ-02: Incorrect Ecosystem Classification' },
  { value: 'RJ-03', label: 'RJ-03: Insufficient Documentation / Proof' },
  { value: 'RJ-04', label: 'RJ-04: Ownership / Land Title Unclear' },
  { value: 'RJ-05', label: 'RJ-05: Other (Specify in Comment)' },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getOrgInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

const ORG_COLORS = [
  'from-cyan-500 to-teal-600',
  'from-violet-500 to-purple-600',
  'from-emerald-500 to-green-600',
  'from-amber-500 to-orange-500',
  'from-sky-500 to-blue-600',
  'from-rose-500 to-pink-600',
  'from-indigo-500 to-blue-600',
];

function getOrgColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return ORG_COLORS[Math.abs(hash) % ORG_COLORS.length];
}

function formatHa(n: number): string {
  if (n >= 100_000) return `${(n / 1000).toFixed(0)}k ha`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k ha`;
  return `${n.toFixed(1)} ha`;
}

function projectArea(p: Project): number {
  return Number((p as any).areaHectares ?? p.area ?? 0);
}

interface OrgData {
  name: string;
  projects: Project[];
  pending: number;
  inProgress: number;
  completed: number;
  totalArea: number;
  lastActivity: Date | null;
}

function extractOrgName(description: string | null | undefined): string {
  if (!description) return '';
  const m = description.match(/Organization:\s*([^\n]+)/);
  return m ? m[1].trim() : '';
}

function buildOrgMap(projects: Project[] | undefined | null): OrgData[] {
  if (!Array.isArray(projects)) return [];
  const map = new Map<string, OrgData>();
  for (const p of projects) {
    const rawName = (p as any).organizationName;
    const name = rawName?.trim() || extractOrgName((p as any).description) || ((p as any).userName ? `${(p as any).userName} (Individual)` : 'Independent Contributor');
    if (!map.has(name)) {
      map.set(name, { name, projects: [], pending: 0, inProgress: 0, completed: 0, totalArea: 0, lastActivity: null });
    }
    const org = map.get(name)!;
    org.projects.push(p);
    if ((p.status as string) === 'pending' || (p.status as string) === 'needs_clarification') org.pending++;
    if ((p as any).mrvStatus === 'RUNNING' || (p as any).mrvStatus === 'PENDING') org.inProgress++;
    if ((p as any).mrvStatus === 'COMPLETED') org.completed++;
    org.totalArea += projectArea(p);
    const d = (p as any).submittedAt ? new Date((p as any).submittedAt) : null;
    if (d && (!org.lastActivity || d > org.lastActivity)) org.lastActivity = d;
  }
  return Array.from(map.values()).sort((a, b) => b.projects.length - a.projects.length);
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

interface KpiCardProps {
  icon: React.ElementType;
  label: string;
  value: number | string;
  sub?: string;
  iconColor: string;
  iconBg: string;
  isLoading?: boolean;
}

function KpiCard({ icon: Icon, label, value, sub, iconColor, iconBg, isLoading }: KpiCardProps) {
  return (
    <div className="rounded-2xl border bg-card p-5 shadow-sm hover:shadow-md transition-all duration-200 group">
      <div className="flex items-start justify-between mb-4">
        <div className={`w-10 h-10 rounded-xl ${iconBg} flex items-center justify-center`}>
          <Icon className={`w-5 h-5 ${iconColor}`} />
        </div>
      </div>
      {isLoading ? (
        <>
          <Skeleton className="h-8 w-20 mb-2" />
          <Skeleton className="h-3 w-28" />
        </>
      ) : (
        <>
          <p className="text-3xl font-bold tabular-nums tracking-tight">{value}</p>
          <p className="text-xs font-medium text-muted-foreground mt-1 uppercase tracking-wider">{label}</p>
          {sub && <p className="text-xs text-muted-foreground/70 mt-0.5">{sub}</p>}
        </>
      )}
    </div>
  );
}

// ─── Eco Distribution Bar ─────────────────────────────────────────────────────

function EcoBar({ ecosystem, count, area, pct }: { ecosystem: string; count: number; area: number; pct: number }) {
  const ecosystemColors: Record<string, string> = {
    mangrove: 'bg-cyan-500',
    forest: 'bg-emerald-500',
    wetland: 'bg-teal-500',
    grassland: 'bg-lime-500',
    savanna: 'bg-amber-500',
    peatland: 'bg-orange-500',
    coral: 'bg-pink-500',
    seagrass: 'bg-sky-500',
  };
  const color = ecosystemColors[ecosystem.toLowerCase()] ?? 'bg-violet-500';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold capitalize text-foreground">{ecosystem}</span>
        <span className="text-muted-foreground tabular-nums">{count} project{count !== 1 ? 's' : ''} · {formatHa(area)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all duration-700`}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
    </div>
  );
}

// ─── Ops Project Card ─────────────────────────────────────────────────────────

interface OpsProjectCardProps {
  project: Project;
  setSelectedProject: (p: Project) => void;
  mintingEnabled: boolean;
  intelligenceHubPath: string;
  compact?: boolean;
}

function OpsProjectCard({ project, setSelectedProject, mintingEnabled, intelligenceHubPath, compact }: OpsProjectCardProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const isRemoved = (project as any).isListed === false;

  const { data: mrvData } = useQuery({
    queryKey: ['/api/mrv', project.id],
    queryFn: async () => {
      const res = await fetch(`/api/mrv/${project.id}`);
      if (!res.ok) throw new Error('MRV fetch failed');
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('json')) return null;
      return res.json();
    },
    throwOnError: false,
    refetchInterval: (q: any) => (q?.state?.data?.status === 'PENDING' ? 3000 : false),
  });

  const mrvStatus = ((mrvData?.status || (project as any).mrvStatus || 'NONE') as string).toUpperCase();
  const hasScore = mrvData?.data != null;
  const isMrvComplete = mrvStatus === 'COMPLETED' && hasScore;

  const startMrvMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/mrv/trigger', { projectId: project.id });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: 'MRV Analysis Started', description: 'Satellite data pipeline initialised.' });
      queryClient.invalidateQueries({ queryKey: ['/api/mrv', project.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/projects/pending'] });
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
    },
    onError: (err: Error) => {
      toast({ title: 'MRV trigger failed', description: safeErrorMsg(err, 'Could not start the satellite analysis. Please try again.'), variant: 'destructive' });
    },
  });

  const area = projectArea(project);
  const eco = (project as any).ecosystemType || '—';
  const org = (project as any).organizationName || '—';
  const submitted = (project as any).submittedAt;

  if (compact) {
    return (
      <div className={`flex items-center justify-between gap-4 py-3 px-4 rounded-xl border bg-card hover:bg-muted/20 transition-colors ${isRemoved ? 'opacity-60' : ''}`}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm truncate">{(project as any).name}</span>
            <StatusBadge status={project.status} />
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{eco} · {formatHa(area)} · {org}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => setSelectedProject(project)}>
            <FileText className="w-3.5 h-3.5" />
          </Button>

          <Button size="sm" variant="ghost" className="h-8 px-2 text-xs"
            onClick={() => startMrvMutation.mutate()}
            disabled={startMrvMutation.isPending || mrvStatus === 'COMPLETED' || mrvStatus === 'RUNNING' || mrvStatus === 'PENDING'}>
            {mrvStatus === 'RUNNING' || mrvStatus === 'PENDING'
              ? <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-500" />
              : mrvStatus === 'COMPLETED'
                ? <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                : <Satellite className="w-3.5 h-3.5" />}
          </Button>

        </div>
      </div>
    );
  }

  return (
    <div className={`relative rounded-2xl border bg-card shadow-sm hover:shadow-lg transition-all duration-200 overflow-hidden ${isRemoved ? 'opacity-70' : ''}`}>
      {/* left accent bar */}
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${
        mrvStatus === 'COMPLETED' ? 'bg-emerald-500' :
        mrvStatus === 'RUNNING' || mrvStatus === 'PENDING' ? 'bg-teal-400 animate-pulse' :
        (project.status as string) === 'needs_clarification' ? 'bg-blue-400' :
        'bg-amber-400'
      }`} />
      <div className="pl-5 pr-5 py-5">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-5">
          <div className="flex-1 min-w-0 space-y-3">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="font-bold text-base tracking-tight truncate">{(project as any).name}</h3>
              <StatusBadge status={project.status} />
              {isRemoved && (
                <span className="px-2 py-0.5 text-[10px] bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 rounded-full font-bold uppercase">
                  Removed
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-[9px] uppercase font-bold tracking-wider text-muted-foreground/70 mb-0.5">Organization</p>
                <p className="font-semibold text-sm">{org}</p>
              </div>
              <div>
                <p className="text-[9px] uppercase font-bold tracking-wider text-muted-foreground/70 mb-0.5">Ecosystem</p>
                <p className="font-semibold text-sm">{eco}</p>
              </div>
              <div>
                <p className="text-[9px] uppercase font-bold tracking-wider text-muted-foreground/70 mb-0.5">Area</p>
                <p className="font-semibold text-sm">{area > 0 ? formatHa(area) : '—'}</p>
              </div>
              {(project as any).nextMonitoringDue ? (
                <div>
                  <p className="text-[9px] uppercase font-bold tracking-wider text-muted-foreground/70 mb-0.5">Next Due</p>
                  <p className="font-semibold text-sm text-teal-600 dark:text-teal-400">
                    {format(new Date((project as any).nextMonitoringDue), 'MMM d, yyyy')}
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-[9px] uppercase font-bold tracking-wider text-muted-foreground/70 mb-0.5">Submitted</p>
                  <p className="font-semibold text-sm">{submitted ? format(new Date(submitted), 'MMM d, yyyy') : '—'}</p>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 pt-1">
              <MRVScoreBadge projectId={project.id} compact />
              <MRVWorkflow project={project as any} compact onStart={() => {}} />
            </div>
          </div>

          <div className="flex flex-row lg:flex-col gap-2 w-full lg:w-44 border-t lg:border-t-0 lg:border-l pt-4 lg:pt-0 lg:pl-5 border-muted/20">
            <p className="text-[9px] uppercase font-bold text-muted-foreground/60 tracking-wider hidden lg:block">Actions</p>

            <Button variant="default" size="sm" onClick={() => setSelectedProject(project)}
              className="flex-1 lg:w-full bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 text-white text-xs">
              <FileText className="w-3.5 h-3.5 mr-1.5" />
              Review
            </Button>



            <Button variant="outline" size="sm"
              onClick={() => startMrvMutation.mutate()}
              disabled={startMrvMutation.isPending || mrvStatus === 'COMPLETED' || mrvStatus === 'RUNNING' || mrvStatus === 'PENDING'}
              className="flex-1 lg:w-full text-xs">
              {mrvStatus === 'RUNNING' || mrvStatus === 'PENDING' ? (
                <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin text-teal-500" />Running {mrvData?.progress ?? 0}%</>
              ) : mrvStatus === 'COMPLETED' ? (
                <><CheckCircle className="w-3.5 h-3.5 mr-1.5 text-emerald-500" />MRV Done</>
              ) : (
                <><Satellite className="w-3.5 h-3.5 mr-1.5" />Start MRV</>
              )}
            </Button>


          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function OperationsDashboard() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const { push: pushNotification } = useNotifications();

  // OPS-1: emit monitoring reminders into the notification centre.
  useMonitoringReminders({ linkBase: '/operations/project' });
  // OPS-2: emit clarification inbox reminders (responses + overdue).
  useReviewInboxNotifications({ linkBase: '/operations/project' });

  // Dialog state
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [showClarifyDialog, setShowClarifyDialog] = useState(false);
  const [rejectionReasonCode, setRejectionReasonCode] = useState('');
  const [rejectionComment, setRejectionComment] = useState('');
  const [clarificationNote, setClarificationNote] = useState('');
  const [verifierNote, setVerifierNote] = useState('');
  const [showCommandCenter, setShowCommandCenter] = useState(true);

  // Filter / search state
  const [queueSearch, setQueueSearch] = useState('');
  const [ecosystemFilter, setEcosystemFilter] = useState('all');
  const [orgSearch, setOrgSearch] = useState('');
  const [expandedOrgs, setExpandedOrgs] = useState<Set<string>>(new Set());
  const [portfolioSearch, setPortfolioSearch] = useState('');

  // ── Queries ──────────────────────────────────────────────────────────────────

  const { data: allProjects = [], isLoading: allLoading, refetch: refetchAll } = useQuery<Project[]>({
    queryKey: ['/api/projects'],
    refetchInterval: 30000,
    select: (response: any): Project[] => {
      // /api/projects returns { data: [...], pagination: {...} }
      if (Array.isArray(response)) return response;
      if (Array.isArray(response?.data)) return response.data;
      return [];
    },
  });

  const { data: pendingProjects = [], isLoading: pendingLoading, refetch: refetchPending } = useQuery<Project[]>({
    queryKey: ['/api/projects/pending'],
    refetchInterval: 30000,
    refetchOnMount: 'always',
    staleTime: 0,
  });

  const { data: stats } = useQuery<any>({
    queryKey: ['/api/stats'],
    refetchInterval: 30000,
  });

  const { data: verifierStatus } = useQuery<any>({
    queryKey: ['/api/verifier/status'],
    refetchInterval: 30000,
  });

  const mintingEnabled: boolean = verifierStatus?.approvalEnabled ?? verifierStatus?.mintingEnabled ?? false;

  // ── Review mutation ──────────────────────────────────────────────────────────

  const reviewMutation = useMutation({
    mutationFn: ({ projectId, action, rejectionReason, comment, clarificationNote }: any) =>
      apiRequest('POST', `/api/projects/${projectId}/review`, { action, rejectionReason, comment, clarificationNote }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['/api/projects/pending'] });
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
      queryClient.invalidateQueries({ queryKey: ['/api/verifier/status'] });
      setSelectedProject(null);
      setShowRejectDialog(false);
      setShowClarifyDialog(false);
      setRejectionReasonCode('');
      setRejectionComment('');
      setClarificationNote('');
      const labels: Record<string, { title: string; description: string; category: any }> = {
        approve: { title: 'Project approved', description: 'Verification complete and monitoring initialised', category: 'report_approved' },
        reject: { title: 'Project rejected', description: 'The contributor has been notified', category: 'report_rejected' },
        clarify: { title: 'Clarification requested', description: 'The contributor has been asked for more information', category: 'validation_failed' },
      };
      const l = labels[variables.action] ?? { title: 'Done', description: '', category: 'report_approved' };
      toast({ title: l.title, description: l.description });
      pushNotification({ category: l.category, title: l.title, body: `${(selectedProject as any)?.name ?? 'Project'}: ${l.description}` });
    },
    onError: (err: any) => {
      toast({ variant: 'destructive', title: 'Action failed', description: safeErrorMsg(err, 'Could not complete the review action. Please try again.') });
    },
  });

  const handleApprove = (projectId: string) => reviewMutation.mutate({ projectId, action: 'approve' });

  const handleReject = () => {
    if (!selectedProject || !rejectionReasonCode) {
      toast({ variant: 'destructive', title: 'Rejection reason required', description: 'Please select a rejection reason code' });
      return;
    }
    reviewMutation.mutate({ projectId: selectedProject.id, action: 'reject', rejectionReason: rejectionReasonCode, comment: rejectionComment || undefined });
  };

  const handleClarify = () => {
    if (!selectedProject || clarificationNote.trim().length < 10) {
      toast({ variant: 'destructive', title: 'Clarification note required', description: 'Minimum 10 characters' });
      return;
    }
    reviewMutation.mutate({ projectId: selectedProject.id, action: 'clarify', clarificationNote });
  };

  const handleRefresh = () => {
    refetchAll();
    refetchPending();
    toast({ title: 'Portfolio refreshed' });
  };

  // ── Derived data ─────────────────────────────────────────────────────────────

  const orgData = useMemo(() => buildOrgMap(allProjects), [allProjects]);

  const kpis = useMemo(() => {
    const totalOrgs = orgData.length;
    const activeOrgs = orgData.filter((o) =>
      o.projects.some((p) => (p as any).mrvStatus === 'RUNNING' || (p as any).mrvStatus === 'PENDING' || (p.status as string) === 'pending')
    ).length;
    const totalProjects = stats?.totalProjects ?? allProjects.length;
    const pendingReviews = pendingProjects.length;
    const activeMrv = allProjects.filter((p) => (p as any).mrvStatus === 'RUNNING' || (p as any).mrvStatus === 'PENDING').length;
    const completedReports = allProjects.filter((p) => (p as any).mrvStatus === 'COMPLETED').length;
    const totalArea = allProjects.reduce((s, p) => s + projectArea(p), 0);
    return { totalOrgs, activeOrgs, totalProjects, pendingReviews, activeMrv, completedReports, totalArea };
  }, [orgData, allProjects, pendingProjects, stats]);

  const ecosystemData = useMemo(() => {
    const map = new Map<string, { count: number; area: number }>();
    for (const p of allProjects) {
      const eco = ((p as any).ecosystemType || 'Unknown') as string;
      const existing = map.get(eco) ?? { count: 0, area: 0 };
      map.set(eco, { count: existing.count + 1, area: existing.area + projectArea(p) });
    }
    const total = allProjects.length || 1;
    return Array.from(map.entries())
      .map(([eco, { count, area }]) => ({ eco, count, area, pct: (count / total) * 100 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [allProjects]);

  const filteredPending = useMemo(() =>
    pendingProjects.filter((p) => {
      const text = `${(p as any).name} ${(p as any).location} ${(p as any).ecosystemType}`.toLowerCase();
      const textOk = !queueSearch || text.includes(queueSearch.toLowerCase());
      const ecoOk = ecosystemFilter === 'all' || ((p as any).ecosystemType || '').toLowerCase() === ecosystemFilter;
      return textOk && ecoOk;
    }), [pendingProjects, queueSearch, ecosystemFilter]);

  const ecosystems = useMemo(() =>
    Array.from(new Set(pendingProjects.map((p) => ((p as any).ecosystemType || '').toLowerCase()).filter(Boolean))),
    [pendingProjects]);

  const filteredOrgs = useMemo(() =>
    orgSearch ? orgData.filter((o) => o.name.toLowerCase().includes(orgSearch.toLowerCase())) : orgData,
    [orgData, orgSearch]);

  const portfolioOrgs = useMemo(() => {
    if (!portfolioSearch) return orgData;
    const s = portfolioSearch.toLowerCase();
    return orgData.map((org) => ({
      ...org,
      projects: org.projects.filter((p) =>
        ((p as any).name || '').toLowerCase().includes(s) ||
        ((p as any).ecosystemType || '').toLowerCase().includes(s) ||
        ((p as any).location || '').toLowerCase().includes(s)
      ),
    })).filter((org) => org.projects.length > 0 || org.name.toLowerCase().includes(s));
  }, [orgData, portfolioSearch]);

  const toggleOrg = (name: string) => {
    setExpandedOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const isLoading = allLoading || pendingLoading;

  // ── High-risk project detection ──────────────────────────────────────────────
  const highRiskProjects = useMemo(() => {
    return pendingProjects.filter((p) => {
      const area = projectArea(p);
      const hasNoProof = !(p as any).proofFileUrl;
      const isLargeArea = area > 50_000;
      const isNeedsClarification = (p.status as string) === 'needs_clarification';
      return hasNoProof || isLargeArea || isNeedsClarification;
    });
  }, [pendingProjects]);

  const mrvRunningProjects = useMemo(() =>
    allProjects.filter((p) => {
      const s = ((p as any).mrvStatus || '').toUpperCase();
      return s === 'RUNNING' || s === 'PENDING';
    }), [allProjects]);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen">
      <SubtleOceanBackground />
      <div className="container mx-auto px-6 py-8 space-y-10 max-w-screen-2xl page-enter">

        {/* ── Header ── */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />
              <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">NEVARA Operations</span>
            </div>
            <h1 className="text-3xl font-heading font-bold tracking-tight">Ecological Operations Center</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Monitoring portfolio · {allProjects.length} project{allProjects.length !== 1 ? 's' : ''} · {format(new Date(), 'EEEE, MMMM d yyyy')}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh} className="gap-2 shrink-0">
            <RefreshCw className="w-4 h-4" />
            Refresh
          </Button>
        </div>

        {/* ────────────────────────────────────────────────────────────────────
            SECTION 1 — Portfolio KPIs
        ──────────────────────────────────────────────────────────────────── */}
        <section>
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-4">
            <KpiCard icon={Building2} label="Organisations" value={isLoading ? '—' : kpis.totalOrgs}
              sub={`${kpis.activeOrgs} active`} iconColor="text-cyan-500" iconBg="bg-cyan-500/10" isLoading={isLoading} />
            <KpiCard icon={Globe} label="Active Orgs" value={isLoading ? '—' : kpis.activeOrgs}
              sub="with open projects" iconColor="text-teal-500" iconBg="bg-teal-500/10" isLoading={isLoading} />
            <KpiCard icon={FolderOpen} label="Total Projects" value={isLoading ? '—' : kpis.totalProjects}
              sub="across all orgs" iconColor="text-violet-500" iconBg="bg-violet-500/10" isLoading={isLoading} />
            <KpiCard icon={Clock} label="Pending Reviews" value={isLoading ? '—' : kpis.pendingReviews}
              sub="awaiting action" iconColor="text-amber-500" iconBg="bg-amber-500/10" isLoading={isLoading} />
            <KpiCard icon={Satellite} label="Active Monitoring Cycles" value={isLoading ? '—' : kpis.activeMrv}
              sub="analyses running" iconColor="text-sky-500" iconBg="bg-sky-500/10" isLoading={isLoading} />
            <KpiCard icon={FileCheck} label="Completed Reports" value={isLoading ? '—' : kpis.completedReports}
              sub="monitoring complete" iconColor="text-emerald-500" iconBg="bg-emerald-500/10" isLoading={isLoading} />
            <KpiCard icon={TreePine} label="Area Monitored" value={isLoading ? '—' : formatHa(kpis.totalArea)}
              sub="total hectares" iconColor="text-lime-600" iconBg="bg-lime-500/10" isLoading={isLoading} />
          </div>
        </section>

        {/* ────────────────────────────────────────────────────────────────────
            VERIFIER COMMAND CENTER — alerts + quick action queue
        ──────────────────────────────────────────────────────────────────── */}
        {(highRiskProjects.length > 0 || mrvRunningProjects.length > 0) && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-amber-500" />
                <span className="text-sm font-semibold">Verification Command Center</span>
                <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  {highRiskProjects.length} alert{highRiskProjects.length !== 1 ? 's' : ''}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowCommandCenter((v) => !v)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              >
                {showCommandCenter ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {showCommandCenter ? 'Collapse' : 'Expand'}
              </button>
            </div>

            {showCommandCenter && (
              <div className="space-y-3 anim-fade-up">
                {/* High-risk alert strip */}
                {highRiskProjects.length > 0 && (
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
                    <div className="flex items-center gap-2 px-5 py-3 border-b border-amber-500/15">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                      <span className="text-xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                        High-Priority Reviews
                      </span>
                      <span className="text-[10px] text-amber-600/70 dark:text-amber-400/70 ml-auto">
                        {highRiskProjects.length} project{highRiskProjects.length !== 1 ? 's' : ''} flagged
                      </span>
                    </div>
                    <div className="divide-y divide-amber-500/10">
                      {highRiskProjects.map((p) => {
                        const hasNoProof = !(p as any).proofFileUrl;
                        const isLargeArea = projectArea(p) > 50_000;
                        const isNeedsClarification = (p.status as string) === 'needs_clarification';
                        const flags = [
                          hasNoProof && 'No documentation',
                          isLargeArea && 'Large area (>50k ha)',
                          isNeedsClarification && 'Awaiting clarification',
                        ].filter(Boolean);
                        return (
                          <div key={p.id} className="flex items-center justify-between gap-4 px-5 py-3 hover:bg-amber-500/5 transition-colors">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-semibold truncate">{(p as any).name}</span>
                                {flags.map((f) => (
                                  <Badge key={f as string} variant="outline" className="text-[9px] px-1.5 h-4 border-amber-500/30 text-amber-600 dark:text-amber-400">
                                    {f}
                                  </Badge>
                                ))}
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {(p as any).ecosystemType} · {formatHa(projectArea(p))} · {(p as any).organizationName || '—'}
                              </p>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2.5 text-xs border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                                onClick={() => handleApprove(p.id)}
                                disabled={reviewMutation.isPending}
                              >
                                <CheckCircle2 className="w-3 h-3 mr-1" />
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2.5 text-xs border-red-500/30 text-red-500 hover:bg-red-500/10"
                                onClick={() => { setSelectedProject(p); setShowRejectDialog(true); }}
                              >
                                <XCircle className="w-3 h-3 mr-1" />
                                Reject
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2.5 text-xs"
                                onClick={() => setLocation(`/operations/project/${p.id}`)}
                              >
                                <Layers className="w-3 h-3 mr-1" />
                                Review
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Active MRV monitoring strip */}
                {mrvRunningProjects.length > 0 && (
                  <div className="rounded-2xl border border-teal-500/20 bg-teal-500/5 overflow-hidden">
                    <div className="flex items-center gap-2 px-5 py-3 border-b border-teal-500/15">
                      <Satellite className="w-3.5 h-3.5 text-teal-500 animate-pulse" />
                      <span className="text-xs font-bold uppercase tracking-wider text-teal-600 dark:text-teal-400">
                        Satellite Analyses In Progress
                      </span>
                      <span className="text-[10px] text-teal-600/70 dark:text-teal-400/70 ml-auto">
                        {mrvRunningProjects.length} active
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-0 divide-y md:divide-y-0 md:divide-x divide-teal-500/10">
                      {mrvRunningProjects.map((p) => (
                        <div key={p.id} className="flex items-center gap-3 px-5 py-3">
                          <Loader2 className="w-4 h-4 text-teal-500 animate-spin flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold truncate">{(p as any).name}</p>
                            <p className="text-xs text-muted-foreground">{(p as any).ecosystemType} · Analysis running</p>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs shrink-0"
                            onClick={() => setLocation(`/operations/project/${p.id}`)}
                          >
                            <Zap className="w-3 h-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* ────────────────────────────────────────────────────────────────────
            SECTION 1.5 — Monitoring Scheduler & Automation (PHASE OPS-1)
        ──────────────────────────────────────────────────────────────────── */}
        <section className="space-y-6">
          <MonitoringQueuePanel linkBase="/operations/project" />
          <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
            <div className="xl:col-span-2">
              <MonitoringOverview linkBase="/operations/project" canEdit title="Schedule Pipeline" />
            </div>
            <div className="xl:col-span-3">
              <MonitoringCalendar linkBase="/operations/project" />
            </div>
          </div>
        </section>

        {/* ────────────────────────────────────────────────────────────────────
            SECTION 1.6 — Review Inbox & Clarifications (PHASE OPS-2)
        ──────────────────────────────────────────────────────────────────── */}
        <section>
          <ReviewInbox linkBase="/operations/project" />
        </section>



        {/* ────────────────────────────────────────────────────────────────────
            SECTION 2 — Organisation Insights + Ecological Overview
        ──────────────────────────────────────────────────────────────────── */}
        <section className="grid grid-cols-1 xl:grid-cols-5 gap-6">

          {/* Organisation table */}
          <Card className="xl:col-span-3 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Building2 className="w-5 h-5 text-cyan-500" />
                    Organisation Insights
                  </CardTitle>
                  <CardDescription className="mt-0.5">Portfolio health by organisation</CardDescription>
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search organisations…"
                    value={orgSearch}
                    onChange={(e) => setOrgSearch(e.target.value)}
                    className="pl-8 h-8 text-xs w-44"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-6 space-y-3">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}
                </div>
              ) : filteredOrgs.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground text-sm">
                  <Building2 className="w-8 h-8 mx-auto mb-2 opacity-20" />
                  No organisations found
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-[10px] uppercase tracking-widest text-muted-foreground/60">
                        <th className="text-left px-6 py-3 font-bold">Organisation</th>
                        <th className="text-center px-3 py-3 font-bold">Projects</th>
                        <th className="text-center px-3 py-3 font-bold">Pending</th>
                        <th className="text-center px-3 py-3 font-bold">Active</th>
                        <th className="text-center px-3 py-3 font-bold">Done</th>
                        <th className="text-right px-6 py-3 font-bold">Area</th>
                        <th className="text-right px-6 py-3 font-bold hidden md:table-cell">Last Activity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-muted/30">
                      {filteredOrgs.map((org) => (
                        <tr key={org.name}
                          className="hover:bg-muted/30 transition-colors cursor-pointer group"
                          onClick={() => {
                            setExpandedOrgs((prev) => { const s = new Set(prev); s.add(org.name); return s; });
                            document.getElementById(`portfolio-org-${org.name.replace(/\s+/g, '-')}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                          }}
                        >
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${getOrgColor(org.name)} flex items-center justify-center text-white text-xs font-black shrink-0 shadow-sm`}>
                                {getOrgInitials(org.name)}
                              </div>
                              <div>
                                <p className="font-semibold leading-tight">{org.name}</p>
                                <p className="text-[10px] text-muted-foreground">{org.projects.length} project{org.projects.length !== 1 ? 's' : ''}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-4 text-center">
                            <span className="font-bold tabular-nums">{org.projects.length}</span>
                          </td>
                          <td className="px-3 py-4 text-center">
                            {org.pending > 0
                              ? <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-xs font-bold">{org.pending}</span>
                              : <span className="text-muted-foreground/40">—</span>}
                          </td>
                          <td className="px-3 py-4 text-center">
                            {org.inProgress > 0
                              ? <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400 text-xs font-bold">{org.inProgress}</span>
                              : <span className="text-muted-foreground/40">—</span>}
                          </td>
                          <td className="px-3 py-4 text-center">
                            {org.completed > 0
                              ? <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 text-xs font-bold">{org.completed}</span>
                              : <span className="text-muted-foreground/40">—</span>}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <span className="font-semibold tabular-nums text-sm">{formatHa(org.totalArea)}</span>
                          </td>
                          <td className="px-6 py-4 text-right text-xs text-muted-foreground hidden md:table-cell">
                            {org.lastActivity ? formatDistanceToNow(org.lastActivity, { addSuffix: true }) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Ecological Overview */}
          <div className="xl:col-span-2 space-y-4">
            <Card className="shadow-sm h-full">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <TreePine className="w-5 h-5 text-emerald-500" />
                  Ecological Overview
                </CardTitle>
                <CardDescription>Ecosystem distribution across portfolio</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {isLoading ? (
                  [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-8 w-full rounded" />)
                ) : ecosystemData.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">No ecosystem data yet</p>
                ) : (
                  <>
                    {ecosystemData.map(({ eco, count, area, pct }) => (
                      <EcoBar key={eco} ecosystem={eco} count={count} area={area} pct={pct} />
                    ))}
                    <div className="pt-3 mt-3 border-t border-muted/30 grid grid-cols-2 gap-3">
                      <div className="rounded-xl bg-muted/30 p-3">
                        <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-1">Total Area</p>
                        <p className="text-xl font-bold tabular-nums">{formatHa(kpis.totalArea)}</p>
                      </div>
                      <div className="rounded-xl bg-muted/30 p-3">
                        <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-1">Ecosystems</p>
                        <p className="text-xl font-bold tabular-nums">{ecosystemData.length}</p>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </section>

        {/* ────────────────────────────────────────────────────────────────────
            SECTION 3 — Priority Work Queue
        ──────────────────────────────────────────────────────────────────── */}
        <section>
          <Card className="shadow-sm">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Activity className="w-5 h-5 text-amber-500" />
                    Priority Work Queue
                    {kpis.pendingReviews > 0 && (
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-500 text-white text-xs font-black shadow-sm shadow-amber-500/20">
                        {kpis.pendingReviews}
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription>Projects awaiting review, MRV trigger, or analysis</CardDescription>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search projects, locations, ecosystems…"
                    value={queueSearch}
                    onChange={(e) => setQueueSearch(e.target.value)}
                    className="pl-8 text-sm"
                  />
                </div>
                <Select value={ecosystemFilter} onValueChange={setEcosystemFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All ecosystems" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All ecosystems</SelectItem>
                    {ecosystems.map((eco) => (
                      <SelectItem key={eco} value={eco} className="capitalize">{eco}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center text-xs text-muted-foreground border rounded-md px-3 py-2">
                  Showing {filteredPending.length} of {pendingProjects.length} projects
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {pendingLoading ? (
                [1, 2].map((i) => <Skeleton key={i} className="h-36 w-full rounded-2xl" />)
              ) : filteredPending.length === 0 ? (
                <div className="py-16 text-center">
                  <FileCheck className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-muted-foreground font-medium">No pending projects</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">All submissions are up to date</p>
                </div>
              ) : (
                filteredPending.map((project) => (
                  <OpsProjectCard
                    key={project.id}
                    project={project}
                    setSelectedProject={setSelectedProject}
                    mintingEnabled={mintingEnabled}
                    intelligenceHubPath={`/operations/project/${project.id}`}
                  />
                ))
              )}
            </CardContent>
          </Card>
        </section>

        {/* ────────────────────────────────────────────────────────────────────
            SECTION 4 — Portfolio Explorer
        ──────────────────────────────────────────────────────────────────── */}
        <section>
          <Card className="shadow-sm">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <FolderOpen className="w-5 h-5 text-violet-500" />
                    Portfolio Explorer
                  </CardTitle>
                  <CardDescription>All projects grouped by organisation</CardDescription>
                </div>
                <Button variant="ghost" size="sm" className="text-xs gap-1.5" onClick={() => {
                  if (expandedOrgs.size === orgData.length) setExpandedOrgs(new Set());
                  else setExpandedOrgs(new Set(orgData.map((o) => o.name)));
                }}>
                  {expandedOrgs.size === orgData.length ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  {expandedOrgs.size === orgData.length ? 'Collapse all' : 'Expand all'}
                </Button>
              </div>
              <div className="relative pt-1">
                <Search className="absolute left-3 top-1/2 translate-y-0.5 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  placeholder="Filter projects by name, ecosystem, or location…"
                  value={portfolioSearch}
                  onChange={(e) => setPortfolioSearch(e.target.value)}
                  className="pl-8 text-sm"
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              {isLoading ? (
                [1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)
              ) : portfolioOrgs.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground text-sm">
                  <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-20" />
                  No projects match your search
                </div>
              ) : (
                portfolioOrgs.map((org) => {
                  const isOpen = expandedOrgs.has(org.name);
                  const id = `portfolio-org-${org.name.replace(/\s+/g, '-')}`;
                  return (
                    <div key={org.name} id={id} className="rounded-2xl border overflow-hidden">
                      {/* Organisation header row */}
                      <button
                        type="button"
                        className="w-full flex items-center justify-between gap-4 px-5 py-4 bg-muted/20 hover:bg-muted/40 transition-colors text-left"
                        onClick={() => toggleOrg(org.name)}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${getOrgColor(org.name)} flex items-center justify-center text-white text-xs font-black shrink-0 shadow-sm`}>
                            {getOrgInitials(org.name)}
                          </div>
                          <div className="min-w-0">
                            <p className="font-bold text-sm">{org.name}</p>
                            <p className="text-xs text-muted-foreground">{org.projects.length} projects · {formatHa(org.totalArea)}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {org.pending > 0 && (
                            <span className="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-[10px] font-bold uppercase">
                              {org.pending} pending
                            </span>
                          )}
                          {org.inProgress > 0 && (
                            <span className="px-2 py-0.5 rounded-full bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400 text-[10px] font-bold uppercase">
                              {org.inProgress} active
                            </span>
                          )}
                          {org.completed > 0 && (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 text-[10px] font-bold uppercase">
                              {org.completed} done
                            </span>
                          )}
                          {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                        </div>
                      </button>

                      {/* Expanded project list */}
                      {isOpen && (
                        <div className="divide-y divide-muted/20 px-5 py-3 space-y-2">
                          {org.projects.length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center py-4">No projects match current filter</p>
                          ) : (
                            org.projects.map((project) => (
                              <OpsProjectCard
                                key={project.id}
                                project={project}
                                setSelectedProject={setSelectedProject}
                                mintingEnabled={mintingEnabled}
                                intelligenceHubPath={`/operations/project/${project.id}`}
                                compact
                              />
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </section>

        {/* ────────────────────────────────────────────────────────────────────
            SECTION 5 — Platform Activity Log
        ──────────────────────────────────────────────────────────────────── */}
        <section>
          <ActivityTimeline
            title="Platform Activity Log"
            limit={30}
            className="shadow-sm"
          />
        </section>

      </div>

      {/* ── Review Dialog ── */}
      <Dialog open={!!selectedProject && !showRejectDialog && !showClarifyDialog} onOpenChange={() => setSelectedProject(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {selectedProject && (() => {
            const isRemoved = (selectedProject as any).isListed === false;
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="text-2xl font-heading">{(selectedProject as any).name}</DialogTitle>
                </DialogHeader>
                {isRemoved && (
                  <div className="rounded-md border border-red-400/50 bg-red-50 dark:bg-red-950/20 px-4 py-3 text-sm font-medium text-red-700 dark:text-red-400 flex items-center gap-2">
                    <XCircle className="w-4 h-4 shrink-0" />
                    This project has been removed from the registry. Review actions are disabled.
                  </div>
                )}
                <div className="space-y-6">
                  <div>
                    <h3 className="font-semibold mb-2">Description</h3>
                    <p className="text-muted-foreground">{(selectedProject as any).description}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <h3 className="font-semibold mb-2">Location</h3>
                      <p className="text-muted-foreground text-sm">
                        {(selectedProject as any).location && (selectedProject as any).location !== 'PENDING_GEO_ENRICHMENT'
                          ? (selectedProject as any).location
                          : (selectedProject as any).centroid
                            ? (() => { try { const c = JSON.parse((selectedProject as any).centroid); return `${Number(c.lat).toFixed(4)}°, ${Number(c.lng).toFixed(4)}°`; } catch { return 'Coordinates pending'; } })()
                            : '—'}
                      </p>
                      {(selectedProject as any).country && (
                        <p className="text-xs text-slate-400 mt-0.5">{[(selectedProject as any).adminRegion, (selectedProject as any).country].filter(Boolean).join(', ')}</p>
                      )}
                    </div>
                    <div>
                      <h3 className="font-semibold mb-2">Ecosystem Type</h3>
                      <p className="text-muted-foreground">{(selectedProject as any).ecosystemType}</p>
                    </div>
                  </div>

                  <div className="rounded-lg border border-emerald-200/50 dark:border-emerald-800/30 bg-emerald-50/30 dark:bg-emerald-950/10 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <MapPin className="w-4 h-4 text-emerald-600" />
                      <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">GIS Spatial Metrics</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div>
                        <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-0.5">Land Area</p>
                        <p className="font-bold text-xl text-primary">
                          {(selectedProject as any).areaHectares != null
                            ? `${Number((selectedProject as any).areaHectares).toFixed(2)} ha`
                            : (selectedProject as any).area != null
                              ? `${Number((selectedProject as any).area).toFixed(2)} ha`
                              : '—'}
                        </p>
                        {(selectedProject as any).areaHectares != null && <p className="text-[10px] text-emerald-600 mt-0.5">GIS-computed</p>}
                      </div>
                      <div>
                        <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-0.5">Perimeter</p>
                        <p className="font-semibold">{(selectedProject as any).perimeterKm != null ? `${Number((selectedProject as any).perimeterKm).toFixed(3)} km` : '—'}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-0.5">Centroid</p>
                        <p className="font-semibold text-xs">
                          {(selectedProject as any).centroid
                            ? (() => { try { const c = JSON.parse((selectedProject as any).centroid); return `${Number(c.lat).toFixed(4)}°, ${Number(c.lng).toFixed(4)}°`; } catch { return '—'; } })()
                            : '—'}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-0.5">Country</p>
                        <p className="font-semibold text-xs">{(selectedProject as any).country || '—'}</p>
                        {(selectedProject as any).adminRegion && <p className="text-[10px] text-slate-400">{(selectedProject as any).adminRegion}</p>}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <h3 className="font-semibold mb-2">Organisation</h3>
                      <p className="text-xl font-bold text-slate-800 dark:text-slate-200">{(selectedProject as any).organizationName || '—'}</p>
                    </div>
                  </div>

                  {(selectedProject as any).landBoundary && (
                    <div>
                      <h3 className="font-semibold mb-2 flex items-center gap-2">
                        <MapIcon className="w-4 h-4 text-cyan-500" />
                        Phase 1 – GIS Verification
                      </h3>
                      <div className="bg-muted/30 p-3 rounded-lg border">
                        <div className="flex items-center gap-2 mb-2">
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                          <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">Completed</span>
                        </div>
                        <p className="text-xs text-muted-foreground mb-3">GIS boundary mapping confirms project area and ecosystem classification.</p>
                        <Suspense fallback={<div className="h-[300px] flex items-center justify-center border rounded-lg bg-muted/50"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>}>
                          <GISLandMap
                            initialBoundary={(() => { try { return JSON.parse((selectedProject as any).landBoundary); } catch { return []; } })()}
                            onBoundaryChange={() => {}}
                            readOnly
                          />
                        </Suspense>
                      </div>
                    </div>
                  )}

                  <div className="bg-muted/30 p-4 rounded-lg border">
                    <div className="flex items-center gap-2 mb-4">
                      <Satellite className="w-5 h-5 text-teal-500" />
                      <h3 className="font-semibold">Phase 2 – MRV Satellite Verification</h3>
                    </div>
                    <MRVScoreBadge projectId={selectedProject.id} className="mb-4" />
                    <p className="text-sm text-muted-foreground">
                      MRV satellite verification analyses historical vegetation (NDVI) and ecological trends using multi-year satellite imagery.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <h3 className="font-semibold mb-2">Submitted At</h3>
                      <p className="text-muted-foreground">{format(new Date((selectedProject as any).submittedAt), 'PPp')}</p>
                    </div>
                    {(selectedProject as any).proofFileUrl && (
                      <div>
                        <h3 className="font-semibold mb-2">Proof Document</h3>
                        <Button variant="outline" size="sm" asChild>
                          <a href={(selectedProject as any).proofFileUrl} target="_blank" rel="noopener noreferrer">
                            <FileText className="w-4 h-4 mr-2" />View Proof
                          </a>
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
                {/* Verifier Notes */}
                <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <MessageSquare className="w-3.5 h-3.5 text-violet-500" />
                    <span className="text-xs font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400">
                      Verifier Notes (Internal)
                    </span>
                  </div>
                  <Textarea
                    value={verifierNote}
                    onChange={(e) => setVerifierNote(e.target.value)}
                    placeholder="Add internal verification notes, risk observations, or compliance remarks… (not visible to contributors)"
                    rows={2}
                    className="text-xs bg-transparent border-violet-500/20 focus:border-violet-500/50 resize-none"
                  />
                </div>

                <DialogFooter className="mt-6 flex flex-col sm:flex-row gap-2 border-t pt-4">
                  <Button variant="outline" onClick={() => setSelectedProject(null)}>Close</Button>
                  <Button variant="outline" className="bg-blue-600 hover:bg-blue-700 text-white border-0"
                    onClick={() => setShowClarifyDialog(true)}
                    disabled={reviewMutation.isPending || isRemoved}>
                    <MessageSquare className="w-4 h-4 mr-2" />Request Clarification
                  </Button>
                  <Button variant="destructive" onClick={() => setShowRejectDialog(true)} disabled={reviewMutation.isPending || isRemoved}>
                    <XCircle className="w-4 h-4 mr-2" />Reject
                  </Button>
                  <Button onClick={() => { setSelectedProject(null); handleApprove(selectedProject.id); }}
                    disabled={reviewMutation.isPending || !mintingEnabled || isRemoved}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white">
                    <CheckCircle2 className="w-4 h-4 mr-2" />Approve &amp; Verify
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── Reject Dialog ── */}
      <Dialog open={showRejectDialog} onOpenChange={setShowRejectDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Project</DialogTitle>
            <DialogDescription>Select a standardised rejection reason code and optionally add a comment.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rejection-reason-code">Rejection Reason Code *</Label>
              <Select value={rejectionReasonCode} onValueChange={setRejectionReasonCode}>
                <SelectTrigger id="rejection-reason-code" data-testid="select-rejection-reason">
                  <SelectValue placeholder="Select a reason code…" />
                </SelectTrigger>
                <SelectContent>
                  {REJECTION_REASON_CODES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rejection-comment">Additional Comment (optional)</Label>
              <Textarea id="rejection-comment" value={rejectionComment} onChange={(e) => setRejectionComment(e.target.value)}
                placeholder="Provide additional context for the contributor…" rows={3} data-testid="input-rejection-comment" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRejectDialog(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleReject} disabled={reviewMutation.isPending || !rejectionReasonCode} data-testid="button-confirm-reject">
              {reviewMutation.isPending ? 'Rejecting…' : 'Confirm Rejection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Clarify Dialog ── */}
      <Dialog open={showClarifyDialog} onOpenChange={setShowClarifyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-blue-500" />
              Request Clarification
            </DialogTitle>
            <DialogDescription>
              Ask the contributor to provide additional information. The project status will change to "Needs Clarification".
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="clarification-note">Clarification Note *</Label>
              <Textarea id="clarification-note" value={clarificationNote} onChange={(e) => setClarificationNote(e.target.value)}
                placeholder="Describe exactly what information or documentation is needed…" rows={4} data-testid="input-clarification-note" />
              <p className="text-xs text-muted-foreground">Minimum 10 characters.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClarifyDialog(false)}>Cancel</Button>
            <Button onClick={handleClarify} disabled={reviewMutation.isPending || clarificationNote.trim().length < 10}
              className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-confirm-clarify">
              {reviewMutation.isPending ? 'Sending…' : 'Request Clarification'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
