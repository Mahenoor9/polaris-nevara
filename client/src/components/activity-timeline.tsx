/**
 * NEVARA Activity & Audit Timeline — PROD-2
 *
 * Consumes /api/ops/audit-events (admin/verifier only) and renders an
 * institutional, compliance-grade activity feed.
 *
 * Props:
 *   projectId? — filter to a single project's events
 *   limit?     — max rows to show (default 50)
 *   compact?   — condensed view for sidebar widgets
 *   title?     — section heading override
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth-context';
import { formatDistanceToNow, format } from 'date-fns';
import {
  Activity,
  MapPin,
  Satellite,
  FileText,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  UserCheck,
  FolderCheck,
  Download,
  Shield,
  RefreshCw,
  LogIn,
  Info,
  ChevronRight,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

// ── Server event shape ─────────────────────────────────────────────────────────

interface AuditEvent {
  id: string;
  timestamp: string;
  category: string;       // MRV | GIS | VERIFIER | REPORT | SYSTEM | SCHEDULER
  severity: string;       // INFO | WARN | ERROR | CRITICAL
  message: string;
  projectId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

// ── Icon / colour mapping ──────────────────────────────────────────────────────

function eventMeta(category: string, severity: string) {
  const sev = severity?.toUpperCase();
  if (sev === 'CRITICAL' || sev === 'ERROR') {
    return { icon: AlertTriangle, color: 'text-red-400',    bg: 'bg-red-500/10',    dot: 'bg-red-500' };
  }
  if (sev === 'WARN') {
    return { icon: AlertTriangle, color: 'text-amber-400',  bg: 'bg-amber-500/10',  dot: 'bg-amber-400' };
  }

  switch (category?.toUpperCase()) {
    case 'MRV':       return { icon: Satellite,   color: 'text-teal-400',    bg: 'bg-teal-500/10',    dot: 'bg-teal-400' };
    case 'GIS':       return { icon: MapPin,       color: 'text-sky-400',     bg: 'bg-sky-500/10',     dot: 'bg-sky-400' };
    case 'VERIFIER':  return { icon: UserCheck,    color: 'text-violet-400',  bg: 'bg-violet-500/10',  dot: 'bg-violet-400' };
    case 'REPORT':    return { icon: FileText,     color: 'text-emerald-400', bg: 'bg-emerald-500/10', dot: 'bg-emerald-400' };
    case 'SCHEDULER': return { icon: RefreshCw,    color: 'text-indigo-400',  bg: 'bg-indigo-500/10',  dot: 'bg-indigo-400' };
    case 'SYSTEM':    return { icon: Shield,       color: 'text-slate-400',   bg: 'bg-slate-500/10',   dot: 'bg-slate-400' };
    default:          return { icon: Info,         color: 'text-muted-foreground', bg: 'bg-muted/40', dot: 'bg-muted-foreground' };
  }
}

function severityBadge(severity: string) {
  switch (severity?.toUpperCase()) {
    case 'CRITICAL': return <Badge variant="destructive" className="text-[9px] px-1.5 py-0.5 h-auto">Critical</Badge>;
    case 'ERROR':    return <Badge variant="destructive" className="text-[9px] px-1.5 py-0.5 h-auto opacity-80">Error</Badge>;
    case 'WARN':     return <Badge className="text-[9px] px-1.5 py-0.5 h-auto bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20">Warning</Badge>;
    default:         return null;
  }
}

// ── Main Component ─────────────────────────────────────────────────────────────

interface ActivityTimelineProps {
  projectId?: string;
  limit?: number;
  compact?: boolean;
  title?: string;
  className?: string;
}

export function ActivityTimeline({
  projectId,
  limit = 50,
  compact = false,
  title = 'Activity Log',
  className = '',
}: ActivityTimelineProps) {
  const { user } = useAuth();
  const canView = user?.role === 'admin' || user?.role === 'verifier';

  const { data, isLoading, error, refetch } = useQuery<{ events: AuditEvent[]; total: number }>({
    queryKey: ['/api/ops/audit-events', projectId, limit],
    queryFn: async () => {
      const token = localStorage.getItem('bluecarbon_token');
      const params = new URLSearchParams({ limit: String(limit) });
      if (projectId) params.set('projectId', projectId);
      const res = await fetch(`/api/ops/audit-events?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 404 || res.status === 403) return { events: [], total: 0 };
      if (!res.ok) return { events: [], total: 0 };
      return res.json();
    },
    enabled: canView,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  if (!canView) return null;

  const events = data?.events ?? [];

  return (
    <div className={`rounded-2xl border bg-card shadow-sm overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
            <Activity className="w-3.5 h-3.5 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            {!isLoading && data?.total !== undefined && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {data.total} total events
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted/60 text-muted-foreground transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="overflow-y-auto" style={{ maxHeight: compact ? 280 : 480 }}>
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="w-7 h-7 rounded-lg flex-shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
            <AlertTriangle className="w-5 h-5 opacity-40" />
            <p className="text-xs">Unable to load activity log</p>
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
            <Activity className="w-5 h-5 opacity-30" />
            <p className="text-xs">No activity recorded yet</p>
          </div>
        ) : (
          <div className="relative p-4 space-y-0">
            {events.slice(0, limit).map((event, i) => {
              const meta = eventMeta(event.category, event.severity);
              const Icon = meta.icon;
              const isLast = i === Math.min(events.length, limit) - 1;

              return (
                <div key={event.id ?? i} className="relative flex gap-3 pb-4">
                  {/* Connector */}
                  {!isLast && (
                    <div
                      className="absolute left-[13px] top-7 bottom-0 w-px bg-border/40"
                      style={{ zIndex: 0 }}
                    />
                  )}

                  {/* Icon */}
                  <div className={`relative z-10 flex-shrink-0 w-7 h-7 rounded-lg ${meta.bg} flex items-center justify-center mt-0.5`}>
                    <Icon className={`w-3 h-3 ${meta.color}`} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0 pt-0.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className={`text-[12px] font-medium leading-snug ${compact ? 'line-clamp-1' : ''}`}>
                          {event.message}
                        </p>
                        {severityBadge(event.severity)}
                      </div>
                      <span className="text-[10px] text-muted-foreground/60 flex-shrink-0 tabular-nums whitespace-nowrap">
                        {event.timestamp && !isNaN(new Date(event.timestamp).getTime())
                          ? formatDistanceToNow(new Date(event.timestamp), { addSuffix: true })
                          : '—'}
                      </span>
                    </div>

                    {!compact && (
                      <div className="flex items-center gap-2 mt-1">
                        <span className="section-header opacity-70">{event.category}</span>
                        {event.projectId && (
                          <span className="text-[9px] text-muted-foreground/50 font-mono">
                            proj:{event.projectId.slice(0, 8)}
                          </span>
                        )}
                        <span className="text-[9px] text-muted-foreground/40 tabular-nums ml-auto">
                          {event.timestamp && !isNaN(new Date(event.timestamp).getTime())
                            ? format(new Date(event.timestamp), 'MMM d, HH:mm')
                            : '—'}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Compact widget version for sidebar/dashboard panels ───────────────────────

export function ActivityFeedWidget({ className = '' }: { className?: string }) {
  return (
    <ActivityTimeline
      compact
      limit={10}
      title="Recent Activity"
      className={className}
    />
  );
}
