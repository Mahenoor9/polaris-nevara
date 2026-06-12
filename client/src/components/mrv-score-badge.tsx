import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, CheckCircle2, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Link } from 'wouter';

interface MRVScoreBadgeProps {
  projectId: string;
  compact?: boolean;
  className?: string;
}

export function MRVScoreBadge({ projectId, compact = false, className }: MRVScoreBadgeProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['/api/mrv', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/mrv/${projectId}`);
      if (!res.ok) throw new Error('Failed to fetch MRV score');
      return res.json();
    },
    refetchInterval: (query) => ((query?.state?.data as any)?.status === 'PENDING' ? 5000 : false),
  });

  if (isLoading) {
    return <Skeleton className={cn("h-6 w-24", className)} />;
  }

  if (error || !data?.data) {
    return (
      <Badge variant="secondary" className={cn("bg-slate-100 text-slate-500 gap-1", className)}>
        <Search className="h-3 w-3" />
        {data?.status === 'PENDING' ? 'MRV Scanning...' : 'MRV Pending'}
      </Badge>
    );
  }

  const score = data.data;
  const trustScore = score.trustScore;
  
  const getStatusColor = (s: number) => {
    if (s >= 80) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (s >= 60) return 'bg-teal-50 text-teal-700 border-teal-200';
    if (s >= 40) return 'bg-amber-50 text-amber-700 border-amber-200';
    return 'bg-red-50 text-red-700 border-red-200';
  };

  const statusClass = getStatusColor(trustScore);

  if (compact) {
    return (
      <div className={cn("flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-bold", statusClass, className)}>
        {trustScore}%
        {score.redFlag && <AlertTriangle className="h-3 w-3 text-red-500" />}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className={cn("flex items-center gap-2 px-3 py-1 rounded-md border font-medium", statusClass)}>
        {trustScore >= 60 ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <Search className="h-4 w-4" />
        )}
        <span>Trust Score: {trustScore}/100</span>
        {score.redFlag && (
          <Badge variant="destructive" className="ml-auto text-[10px] py-0 px-1.5 h-4">
            FLAGGED
          </Badge>
        )}
      </div>
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
          Confidence: {score.confidence}
        </span>
        {score.status !== 'PENDING' && (
          <Link 
            href={`/projects/${projectId}/mrv-report`}
            className="text-[10px] text-teal-600 hover:underline font-medium"
          >
            View Details
          </Link>
        )}
      </div>
    </div>
  );
}
