import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Clock, XCircle, MessageSquare, Shield, Satellite } from 'lucide-react';

// Task 2.1: Added 'needs_clarification' status
// Dual-Layer: Added 'verified_phase1' and 'full_verified' for Phase 1 + Phase 2 verification
export type ProjectStatus = 'pending' | 'verified' | 'verified_phase1' | 'full_verified' | 'rejected' | 'needs_clarification';

interface StatusBadgeProps {
  status: ProjectStatus | string;
  className?: string;
}

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  const config: Record<string, {
    icon: React.ElementType;
    label: string;
    className: string;
  }> = {
    pending: {
      icon: Clock,
      label: 'Pending',
      className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    },
    verified: {
      icon: CheckCircle2,
      label: 'Verified',
      className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
    },
    // Phase 1 verification - GIS boundary mapping complete
    verified_phase1: {
      icon: Shield,
      label: 'Verified – Phase 1',
      className: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-400',
    },
    // Full verification - Phase 1 (GIS) + Phase 2 (MRV) complete
    full_verified: {
      icon: Satellite,
      label: 'Full Verified',
      className: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
    },
    rejected: {
      icon: XCircle,
      label: 'Rejected',
      className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    },
    // Task 2.1: Distinct visual treatment for clarification-needed projects
    needs_clarification: {
      icon: MessageSquare,
      label: 'Needs Clarification',
      className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    },
    // MRV pipeline states
    RUNNING: {
      icon: Satellite,
      label: 'MRV Running',
      className: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400',
    },
    COMPLETED: {
      icon: CheckCircle2,
      label: 'MRV Complete',
      className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
    },
    FAILED: {
      icon: XCircle,
      label: 'MRV Failed',
      className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    },
    CANCELLED: {
      icon: XCircle,
      label: 'Cancelled',
      className: 'bg-slate-100 text-slate-600 dark:bg-slate-900/30 dark:text-slate-400',
    },
    IDLE: {
      icon: Clock,
      label: 'Awaiting MRV',
      className: 'bg-slate-100 text-slate-600 dark:bg-slate-900/30 dark:text-slate-400',
    },
  };

  // Fallback for unknown statuses
  const statusConfig = config[status] ?? {
    icon: Clock,
    label: status,
    className: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400',
  };

  const { icon: Icon, label, className: statusClassName } = statusConfig;

  return (
    <Badge
      variant="secondary"
      className={`gap-1 ${statusClassName} ${className}`}
      data-testid={`badge-status-${status}`}
    >
      <Icon className="w-3 h-3" />
      {label}
    </Badge>
  );
}
