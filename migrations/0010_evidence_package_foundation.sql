-- Phase 1: Evidence Package Foundation
-- Creates analysis_runs table for immutable per-run evidence tracking

CREATE TABLE IF NOT EXISTS public.analysis_runs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL UNIQUE,
  project_id    TEXT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'created'
                  CHECK (status IN ('created', 'running', 'complete', 'failed')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  evidence_path TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analysis_runs_project_id ON public.analysis_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_run_id ON public.analysis_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_status ON public.analysis_runs(status);
