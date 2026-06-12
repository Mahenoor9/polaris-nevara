-- migrations/0007_verifier_reporting_foundation.sql
-- Depends on: 0005, 0006

BEGIN;

CREATE TABLE IF NOT EXISTS eco_monitoring.verifier_review_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  verifier_id VARCHAR NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  decision VARCHAR(64) NOT NULL,
  confidence_score INTEGER CHECK (confidence_score >= 0 AND confidence_score <= 100),
  overall_notes TEXT,
  review_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_review_recommendation VARCHAR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verifier_review_project
  ON eco_monitoring.verifier_review_records (project_id);

CREATE INDEX IF NOT EXISTS idx_verifier_review_verifier
  ON eco_monitoring.verifier_review_records (verifier_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eco_monitoring.project_timeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_project_timeline_project_time
  ON eco_monitoring.project_timeline_events (project_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS eco_monitoring.report_metadata (
  id VARCHAR(200) PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  report_type VARCHAR(64) NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title VARCHAR(300) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'generated',
  file_path_pdf TEXT NOT NULL,
  file_path_html TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_report_project_type_version
  ON eco_monitoring.report_metadata (project_id, report_type, version);

CREATE INDEX IF NOT EXISTS idx_report_project_generated_at
  ON eco_monitoring.report_metadata (project_id, generated_at DESC);

COMMIT;

