interface ProgressSnapshot {
  progress: number;
  label: string;
  status: string;
  updatedAt: Date;
}

class MonitoringProgressTracker {
  private snapshots = new Map<string, ProgressSnapshot>();

  set(projectId: string, progress: number, label: string, status: string) {
    this.snapshots.set(projectId, {
      progress,
      label,
      status,
      updatedAt: new Date(),
    });
  }

  get(projectId: string): ProgressSnapshot | null {
    return this.snapshots.get(projectId) ?? null;
  }

  clear(projectId: string) {
    this.snapshots.delete(projectId);
  }
}

export const monitoringProgressTracker = new MonitoringProgressTracker();

