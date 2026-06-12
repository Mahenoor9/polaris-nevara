-- Phase 4C: Report Review & Approval Workflow
-- Adds internal review lifecycle records for evidence-based draft reports.

CREATE TABLE IF NOT EXISTS public.report_reviews (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES public.analysis_runs(run_id) ON DELETE CASCADE,
  report_path   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'under_review', 'changes_requested', 'approved', 'published')),
  review_notes  TEXT,
  reviewed_by   TEXT REFERENCES public.users(id),
  reviewed_at   TIMESTAMPTZ,
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT report_reviews_project_run_unique UNIQUE (project_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_report_reviews_project_id ON public.report_reviews(project_id);
CREATE INDEX IF NOT EXISTS idx_report_reviews_run_id ON public.report_reviews(run_id);
CREATE INDEX IF NOT EXISTS idx_report_reviews_status ON public.report_reviews(status);
