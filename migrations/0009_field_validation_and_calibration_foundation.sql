-- migrations/0009_field_validation_and_calibration_foundation.sql
-- Depends on: 0005, 0006, 0007, 0008

BEGIN;

CREATE TABLE IF NOT EXISTS eco_monitoring.ecological_calibration_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type VARCHAR(24) NOT NULL CHECK (scope_type IN ('organization', 'project')),
  scope_id VARCHAR NOT NULL,
  ecosystem_key VARCHAR(64) NOT NULL,
  profile_key VARCHAR(64) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  threshold_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  anomaly_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  seasonal_tuning JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence_tuning JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by VARCHAR REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_scope_active
  ON eco_monitoring.ecological_calibration_profiles (scope_type, scope_id, ecosystem_key, active)
  WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS eco_monitoring.field_validation_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  monitoring_cycle_id UUID REFERENCES eco_monitoring.monitoring_cycles(id) ON DELETE SET NULL,
  uploaded_by VARCHAR REFERENCES public.users(id) ON DELETE SET NULL,
  evidence_type VARCHAR(64) NOT NULL,
  observation_date TIMESTAMPTZ NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  measured_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  attachment_path TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_field_evidence_project_date
  ON eco_monitoring.field_validation_evidence (project_id, observation_date DESC);

CREATE TABLE IF NOT EXISTS eco_monitoring.ecological_review_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  monitoring_cycle_id UUID REFERENCES eco_monitoring.monitoring_cycles(id) ON DELETE SET NULL,
  verifier_id VARCHAR REFERENCES public.users(id) ON DELETE SET NULL,
  note_type VARCHAR(64) NOT NULL,
  severity VARCHAR(16) NOT NULL DEFAULT 'INFO',
  note TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_notes_project_time
  ON eco_monitoring.ecological_review_notes (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eco_monitoring.verifier_override_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  monitoring_cycle_id UUID REFERENCES eco_monitoring.monitoring_cycles(id) ON DELETE SET NULL,
  verifier_id VARCHAR REFERENCES public.users(id) ON DELETE SET NULL,
  override_type VARCHAR(64) NOT NULL,
  previous_value JSONB,
  new_value JSONB,
  reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_override_logs_project_time
  ON eco_monitoring.verifier_override_logs (project_id, created_at DESC);

COMMIT;
