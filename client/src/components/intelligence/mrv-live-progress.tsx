/**
 * MRVLiveProgress.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-time MRV analysis progress indicator using SSE.
 * Renders a minimal progress bar + status label that updates live.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useMRVProgress } from '@/hooks/useMRVProgress';
import { Progress } from '@/components/ui/progress';
import { Loader2, CheckCircle2, AlertTriangle, Wifi, WifiOff } from 'lucide-react';

interface Props {
  projectId: string;
  /** Show only when analysis is running */
  onlyWhenActive?: boolean;
}

export function MRVLiveProgress({ projectId, onlyWhenActive = true }: Props) {
  const { progress, step, status, label, isConnected, error } = useMRVProgress(projectId);

  const isActive = ['RUNNING', 'QUEUED', 'STARTED'].includes(status);
  const isCompleted = status === 'COMPLETED';
  const isFailed = status === 'FAILED';

  if (onlyWhenActive && !isActive && !isFailed) return null;

  return (
    <div className="rounded-xl border p-4 space-y-3 bg-muted/20">
      {/* Connection indicator */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isActive ? (
            <Loader2 className="w-4 h-4 animate-spin text-cyan-500" />
          ) : isCompleted ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          ) : isFailed ? (
            <AlertTriangle className="w-4 h-4 text-red-500" />
          ) : null}
          <span className="text-sm font-semibold">
            {isActive ? 'Analysis Running' : isCompleted ? 'Analysis Complete' : isFailed ? 'Analysis Failed' : 'MRV Status'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {isConnected ? (
            <Wifi className="w-3 h-3 text-emerald-500" />
          ) : (
            <WifiOff className="w-3 h-3 text-muted-foreground" />
          )}
          <span className="text-[10px] text-muted-foreground">
            {isConnected ? 'Live' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <Progress value={progress} className="h-2" />

      {/* Step label */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label || step || 'Waiting...'}</span>
        <span className="font-mono font-bold">{progress}%</span>
      </div>

      {/* Error message */}
      {error && (
        <p className="text-xs text-red-500">⚠ {error}</p>
      )}
    </div>
  );
}
