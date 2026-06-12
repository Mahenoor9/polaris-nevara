import React, { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2, MapPin, Activity, FileCheck, Eye, ShieldCheck, AlertCircle, Satellite, TrendingUp, Map, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { safeErrorMsg } from '@/lib/safe-error';

const GISLandMap = lazy(() => import('@/components/gis-land-map'));

interface Project {
  id: string;
  status: string;
  mrvStatus?: string;
  userId: string;
  verifierId?: string | null;
  landBoundary?: string | null;
  [key: string]: any;
}

interface MRVWorkflowProps {
  project: Project;
  className?: string;
  compact?: boolean;
  onStart?: () => void;
}

// Workflow step config — these are the PROJECT-level workflow stages (not MRV sub-steps)
const WORKFLOW_STEPS = [
  { id: 1, label: 'GIS Submitted',    description: 'Land boundary defined',     icon: MapPin     },
  { id: 2, label: 'MRV Analysis',     description: 'Satellite data processed',  icon: Activity   },
  { id: 3, label: 'Score Generated',  description: 'Ecological trust score ready',  icon: FileCheck  },
  { id: 4, label: 'Verifier Review',  description: 'Manual verification',        icon: Eye        },
  { id: 5, label: 'Approved & Verified', description: 'Monitoring completed',     icon: ShieldCheck },
];

export function MRVWorkflow({ project, className, compact = false, onStart }: MRVWorkflowProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Poll /api/mrv/:id — returns { status (mrvStatus), progress, step, ndvi, baselineNdvi, ndviTileUrl }
  const { data: mrvData } = useQuery({
    queryKey: ['/api/mrv', project.id],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/mrv/${project.id}`);
      return res.json();
    },
    enabled: !!project.id,
    throwOnError: false,
    refetchInterval: (query) => {
      const status = (query.state.data as any)?.status?.toUpperCase();
      if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') return false;
      return 2000;
    },
  });

  const cancelMrvMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/mrv/cancel', { projectId: project.id });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: 'MRV Analysis Cancelled', description: 'The job has been stopped.' });
      queryClient.invalidateQueries({ queryKey: ['/api/mrv', project.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/projects/my'] });
    },
    onError: (error: Error) => {
      toast({ title: 'Cancel failed', description: safeErrorMsg(error, 'Could not cancel the analysis. Please try again.'), variant: 'destructive' });
    },
  });

  const triggerMrvMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/mrv/trigger', { projectId: project.id });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: 'MRV Analysis Started', description: 'Satellite data is being fetched…' });
      queryClient.invalidateQueries({ queryKey: ['/api/mrv', project.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/projects/my'] });
      if (onStart) onStart();
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to trigger MRV', description: safeErrorMsg(error, 'Could not start the satellite analysis. Please try again.'), variant: 'destructive' });
    },
  });

  // ── Derived state ───────────────────────────────────────────────────────────
  const mrvStatus    = (mrvData?.status || project.mrvStatus || 'IDLE').toUpperCase();
  const progress     = mrvData?.progress ?? (mrvStatus === 'COMPLETED' ? 100 : 0);
  const stepLabel    = mrvData?.step ?? (mrvStatus === 'IDLE' ? 'Not started' : mrvStatus);
  const hasScore     = mrvData?.data != null;
  const ndviValue    = mrvData?.ndvi ?? mrvData?.data?.currentNdvi ?? null;
  const baselineNdvi = mrvData?.baselineNdvi ?? mrvData?.data?.baselineNdvi ?? null;
  const trustScore   = mrvData?.data?.trustScore ?? null;
  const ndviTileUrl  = mrvData?.ndviTileUrl ?? null;

  const isRunning    = mrvStatus === 'RUNNING';
  const isComplete   = mrvStatus === 'COMPLETED';
  const isFailed     = mrvStatus === 'FAILED';
  const isCancelled  = mrvStatus === 'CANCELLED';
  const isIdle       = mrvStatus === 'IDLE' || mrvStatus === 'NONE' || (!isRunning && !isComplete && !isFailed && !isCancelled);

  // Parse polygon for overlay
  const ndviPolygon: { lat: number; lng: number }[] | null = (() => {
    if (!project.landBoundary) return null;
    try {
      const parsed = JSON.parse(project.landBoundary);
      if (!Array.isArray(parsed)) return null;
      if (parsed.length > 0 && typeof parsed[0] === 'object' && 'lat' in parsed[0]) {
        return parsed as { lat: number; lng: number }[];
      }
      return parsed.map(([lat, lng]: [number, number]) => ({ lat, lng }));
    } catch { return null; }
  })();

  // ── Workflow step for visual progress bar ────────────────────────────────────
  const projectStatus = project.status?.toLowerCase();
  let currentWorkflowStep = 1;
  if (isRunning || isComplete || isFailed || isCancelled) currentWorkflowStep = 2;
  if (isComplete && hasScore) currentWorkflowStep = 3;
  if (projectStatus === 'needs_clarification' || projectStatus === 'rejected') currentWorkflowStep = 4;
  if (projectStatus === 'verified') currentWorkflowStep = 5;

  const getStepStatus = (stepId: number) => {
    if (stepId < currentWorkflowStep) return 'completed';
    if (stepId === currentWorkflowStep) {
      if (stepId === 2 && isRunning)    return 'running';
      if (stepId === 2 && isFailed)     return 'error';
      if (stepId === 2 && isCancelled)  return 'warning';
      if (stepId === 4 && projectStatus === 'needs_clarification') return 'warning';
      if (stepId === 4 && projectStatus === 'rejected') return 'error';
      return 'active';
    }
    return 'upcoming';
  };

  // ── NDVI Results + Map ───────────────────────────────────────────────────────
  const NDVIPanel = () => {
    if (ndviValue === null && !isComplete) return null;
    return (
      <div className="mt-4 rounded-lg border border-teal-100 bg-teal-50/60 p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-700 flex items-center gap-1.5">
          <Satellite className="h-3.5 w-3.5" /> Satellite Analysis Results
        </p>
        <div className="grid grid-cols-2 gap-3">
          {ndviValue !== null && (
            <div className="rounded-md bg-white border border-teal-100 p-2.5">
              <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Current NDVI (2023)</p>
              <p className="text-xl font-bold text-teal-700 mt-0.5">{ndviValue.toFixed(4)}</p>
            </div>
          )}
          {baselineNdvi !== null && (
            <div className="rounded-md bg-white border border-teal-100 p-2.5">
              <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Baseline NDVI (2022)</p>
              <p className="text-xl font-bold text-slate-600 mt-0.5">{baselineNdvi.toFixed(4)}</p>
            </div>
          )}
          {trustScore !== null && (
            <div className="rounded-md bg-white border border-teal-100 p-2.5 col-span-2">
              <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider flex items-center gap-1">
                <TrendingUp className="h-3 w-3" /> Ecological Trust Score
              </p>
              <div className="flex items-end gap-2 mt-0.5">
                <p className="text-2xl font-bold text-emerald-700">{trustScore}</p>
                <p className="text-sm text-slate-400 pb-0.5">/100</p>
                <div className="ml-auto flex items-center gap-1 text-xs">
                  <span className={cn(
                    'px-2 py-0.5 rounded-full font-semibold',
                    trustScore >= 70 ? 'bg-emerald-100 text-emerald-700' :
                    trustScore >= 40 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-600'
                  )}>
                    {mrvData?.data?.confidence || 'MEDIUM'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* NDVI Map Overlay */}
        {isComplete && (ndviTileUrl || ndviPolygon) && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-teal-700 flex items-center gap-1.5 mb-2">
              <Map className="h-3.5 w-3.5" />
              {ndviTileUrl ? 'NDVI Heatmap (Sentinel-2 + Landsat)' : 'Project Boundary'}
            </p>
            <div className="rounded-lg overflow-hidden border border-teal-200 shadow-sm" style={{ height: '320px' }}>
              <Suspense fallback={
                <div className="h-full flex items-center justify-center bg-slate-50">
                  <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
                </div>
              }>
                <GISLandMap
                  onBoundaryChange={() => {}}
                  readOnly
                  initialBoundary={ndviPolygon ?? undefined}
                  ndviTileUrl={ndviTileUrl}
                  ndviPolygon={ndviPolygon}
                />
              </Suspense>
            </div>
            {ndviTileUrl && (
              <p className="text-[10px] text-slate-400 mt-1.5 flex items-center gap-3">
                <span>🟢 Dense vegetation</span>
                <span>🟡 Sparse</span>
                <span>🔴 Bare/Water</span>
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Progress bar (shown while RUNNING) ──────────────────────────────────────
  const ProgressBar = () => {
    if (!isRunning) return null;
    return (
      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-slate-700">{stepLabel}</span>
          <span className="text-slate-400 font-mono">{progress}%</span>
        </div>
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-teal-500 to-emerald-400 rounded-full transition-all duration-700 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1 text-xs" disabled>
            <Loader2 className="h-3 w-3 mr-2 animate-spin" /> Analysing…
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="text-xs"
            onClick={() => cancelMrvMutation.mutate()}
            disabled={cancelMrvMutation.isPending}
          >
            {cancelMrvMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            Cancel
          </Button>
        </div>
      </div>
    );
  };

  // ── Compact view ─────────────────────────────────────────────────────────────
  if (compact) {
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <div className="flex items-center justify-between text-xs font-medium text-slate-500">
          <span>Step {currentWorkflowStep}/5 — {WORKFLOW_STEPS[currentWorkflowStep - 1]?.label}</span>
          {isRunning && <span className="text-teal-600 font-mono">{progress}%</span>}
        </div>
        <div className="flex gap-1">
          {WORKFLOW_STEPS.map((step) => {
            const status = getStepStatus(step.id);
            return (
              <div key={step.id} className={cn(
                'h-1.5 flex-1 rounded-full transition-all',
                status === 'completed'               ? 'bg-teal-500' :
                status === 'running' || status === 'active' ? 'bg-teal-400 animate-pulse' :
                status === 'warning'                 ? 'bg-amber-400' :
                status === 'error'                   ? 'bg-red-400' : 'bg-slate-200'
              )} title={step.label} />
            );
          })}
        </div>
        {isRunning && (
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-teal-500 to-emerald-400 rounded-full transition-all duration-700"
              style={{ width: `${progress}%` }} />
          </div>
        )}
        {isRunning && (
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{stepLabel}</span>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-red-500 text-xs"
              onClick={() => cancelMrvMutation.mutate()} disabled={cancelMrvMutation.isPending}>
              Cancel
            </Button>
          </div>
        )}
        {isIdle && (
          <Button size="sm" className="w-full text-xs mt-2"
            onClick={() => triggerMrvMutation.mutate()} disabled={triggerMrvMutation.isPending}>
            {triggerMrvMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
            Start MRV
          </Button>
        )}
      </div>
    );
  }

  // ── Full view ─────────────────────────────────────────────────────────────────
  return (
    <div className={cn('bg-white border rounded-xl p-6 shadow-sm', className)}>
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-sm font-semibold text-slate-800 uppercase tracking-wider">Monitoring Workflow</h3>
        {isRunning && (
          <span className="text-xs font-mono bg-teal-50 text-teal-700 px-2 py-0.5 rounded-full border border-teal-200">
            {progress}% — {stepLabel}
          </span>
        )}
      </div>

      {/* Progress bar (RUNNING only) */}
      <ProgressBar />

      {/* Workflow steps */}
      <div className="relative mt-4">
        <div className="absolute top-5 left-6 bottom-5 w-0.5 bg-slate-100" />
        <div className="space-y-6">
          {WORKFLOW_STEPS.map((step) => {
            const status = getStepStatus(step.id);
            const Icon = step.icon;
            return (
              <div key={step.id} className="relative flex items-start gap-4">
                <div className={cn(
                  'relative z-10 flex items-center justify-center w-12 h-12 rounded-full border-2 bg-white',
                  status === 'completed' ? 'border-teal-500 bg-teal-50 text-teal-600' :
                  status === 'running'   ? 'border-teal-400 bg-teal-50/60 text-teal-500' :
                  status === 'active'    ? 'border-slate-800 bg-slate-50 text-slate-800' :
                  status === 'warning'   ? 'border-amber-400 bg-amber-50 text-amber-600' :
                  status === 'error'     ? 'border-red-400 bg-red-50 text-red-600' :
                  'border-slate-200 text-slate-300'
                )}>
                  {status === 'completed' ? <Check className="h-5 w-5" /> :
                   status === 'running'   ? <Loader2 className="h-5 w-5 animate-spin" /> :
                   (status === 'warning' || status === 'error') ? <AlertCircle className="h-5 w-5" /> :
                   <Icon className="h-5 w-5" />}
                </div>

                <div className="pt-1 flex-1 min-w-0">
                  <h4 className={cn(
                    'text-sm font-semibold',
                    status === 'upcoming' ? 'text-slate-400' :
                    status === 'warning'  ? 'text-amber-700' :
                    status === 'error'    ? 'text-red-700' : 'text-slate-900'
                  )}>
                    {step.label}
                  </h4>
                  <p className={cn('text-xs mt-0.5', status === 'upcoming' ? 'text-slate-400' : 'text-slate-500')}>
                    {step.id === 2 && isRunning ? stepLabel :
                     step.id === 2 && isComplete ? `NDVI: ${ndviValue?.toFixed(3) ?? '—'}` :
                     step.id === 3 && hasScore ? `Trust Score: ${trustScore}/100` :
                     step.description}
                  </p>

                  {/* Step 2 action buttons */}
                  {step.id === 2 && isIdle && (
                    <Button size="sm" variant="outline" className="mt-2 text-xs"
                      onClick={() => triggerMrvMutation.mutate()} disabled={triggerMrvMutation.isPending}>
                      {triggerMrvMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                      Start MRV
                    </Button>
                  )}
                  {step.id === 2 && (isFailed || isCancelled) && (
                    <Button size="sm" variant="outline" className="mt-2 text-xs"
                      onClick={() => triggerMrvMutation.mutate()} disabled={triggerMrvMutation.isPending}>
                      {triggerMrvMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                      Retry MRV
                    </Button>
                  )}
                  {step.id === 3 && isComplete && hasScore && (
                    <Link href={`/projects/${project.id}/mrv-report`}>
                      <Button size="sm" variant="ghost" className="mt-1 h-auto p-0 text-teal-600 text-xs font-medium hover:bg-transparent">
                        View Detailed Report →
                      </Button>
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* NDVI Results + Map */}
      <NDVIPanel />
    </div>
  );
}
