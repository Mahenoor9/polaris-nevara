-- =============================================================================
-- Migration: 0008_gee_reporting_phase.sql
-- Phase: Advanced Environmental Analysis + Production Reporting
-- =============================================================================
-- 
-- Overview:
--   This migration extends the eco_monitoring schema with:
--   1. observation_type enum extensions for multi-index support
--   2. Enriched report_metadata columns (content_hash, pdf_rendered, etc.)
--   3. Report version lifecycle table
--   4. Dataset attribution metadata table
--   5. Environmental quality scores table (observation-level confidence)
--   6. Indexes for reporting queries
--
-- Safety:
--   - Additive only: no existing columns/tables dropped or renamed
--   - All new columns are nullable or have defaults
--   - Enum additions use DO $$ blocks for idempotency
--   - Backward compatible: existing observations not touched
--
-- Dependencies:
--   - 0007_verifier_reporting_foundation.sql must be applied first
--     (creates eco_monitoring.report_metadata)
-- =============================================================================

BEGIN;

-- ─── 1. Extend observation_type enum ─────────────────────────────────────────
--
-- The foundation migration (0006) created the observation_type enum with a basic set.
-- We extend it to support the full multi-index pipeline output types.
-- Each DO block is idempotent: it only adds the value if it does not already exist.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'evi'
      AND enumtypid = 'eco_monitoring.observation_type'::regtype
  ) THEN
    ALTER TYPE eco_monitoring.observation_type ADD VALUE 'evi';
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'savi'
      AND enumtypid = 'eco_monitoring.observation_type'::regtype
  ) THEN
    ALTER TYPE eco_monitoring.observation_type ADD VALUE 'savi';
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'ndwi'
      AND enumtypid = 'eco_monitoring.observation_type'::regtype
  ) THEN
    ALTER TYPE eco_monitoring.observation_type ADD VALUE 'ndwi';
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'ndmi'
      AND enumtypid = 'eco_monitoring.observation_type'::regtype
  ) THEN
    ALTER TYPE eco_monitoring.observation_type ADD VALUE 'ndmi';
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'nbr'
      AND enumtypid = 'eco_monitoring.observation_type'::regtype
  ) THEN
    ALTER TYPE eco_monitoring.observation_type ADD VALUE 'nbr';
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'bsi'
      AND enumtypid = 'eco_monitoring.observation_type'::regtype
  ) THEN
    ALTER TYPE eco_monitoring.observation_type ADD VALUE 'bsi';
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'ecosystem_health'
      AND enumtypid = 'eco_monitoring.observation_type'::regtype
  ) THEN
    ALTER TYPE eco_monitoring.observation_type ADD VALUE 'ecosystem_health';
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

-- ─── 2. Extend report_metadata table ─────────────────────────────────────────

ALTER TABLE eco_monitoring.report_metadata
  ADD COLUMN IF NOT EXISTS content_hash       TEXT,
  ADD COLUMN IF NOT EXISTS pdf_rendered       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS file_size_bytes    BIGINT,
  ADD COLUMN IF NOT EXISTS superseded_at      TIMESTAMPTZ;

COMMENT ON COLUMN eco_monitoring.report_metadata.content_hash
  IS 'SHA-256 hash of the rendered PDF for integrity verification';
COMMENT ON COLUMN eco_monitoring.report_metadata.pdf_rendered
  IS 'TRUE if Puppeteer rendered a real PDF; FALSE if HTML-only fallback';
COMMENT ON COLUMN eco_monitoring.report_metadata.file_size_bytes
  IS 'Size in bytes of the PDF artifact';
COMMENT ON COLUMN eco_monitoring.report_metadata.superseded_at
  IS 'Timestamp when a newer version of this report was generated';

-- ─── 3. Report version history table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS eco_monitoring.report_versions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id         TEXT NOT NULL,
  project_id        VARCHAR NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  report_type       TEXT NOT NULL,
  version           INTEGER NOT NULL,
  file_path_pdf     TEXT,
  file_path_html    TEXT,
  content_hash      TEXT,
  pdf_rendered      BOOLEAN NOT NULL DEFAULT FALSE,
  file_size_bytes   BIGINT,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  generator_version TEXT NOT NULL DEFAULT 'v2',
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE eco_monitoring.report_versions
  IS 'Immutable snapshot of every report version ever generated. Reports are never overwritten; new versions append here.';

CREATE INDEX IF NOT EXISTS idx_report_versions_report_id
  ON eco_monitoring.report_versions (report_id);
CREATE INDEX IF NOT EXISTS idx_report_versions_project_id
  ON eco_monitoring.report_versions (project_id, generated_at DESC);

-- ─── 4. Dataset attribution metadata table ────────────────────────────────────

CREATE TABLE IF NOT EXISTS eco_monitoring.dataset_attributions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            VARCHAR NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  monitoring_cycle_id   UUID NOT NULL REFERENCES eco_monitoring.monitoring_cycles(id) ON DELETE CASCADE,
  dataset_id            TEXT NOT NULL,
  dataset_label         TEXT NOT NULL,
  image_count           INTEGER NOT NULL DEFAULT 0,
  date_range_start      DATE NOT NULL,
  date_range_end        DATE NOT NULL,
  resolution_m          SMALLINT NOT NULL,
  cloud_threshold_pct   SMALLINT NOT NULL DEFAULT 30,
  compositing_method    TEXT NOT NULL DEFAULT 'median',
  fallback_used         BOOLEAN NOT NULL DEFAULT FALSE,
  fallback_reason       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE eco_monitoring.dataset_attributions
  IS 'Persistent record of every satellite dataset used in each monitoring cycle, for report provenance and audit trails.';

CREATE INDEX IF NOT EXISTS idx_dataset_attributions_project_id
  ON eco_monitoring.dataset_attributions (project_id);
CREATE INDEX IF NOT EXISTS idx_dataset_attributions_cycle_id
  ON eco_monitoring.dataset_attributions (monitoring_cycle_id);

-- ─── 5. Environmental quality scores table ────────────────────────────────────

CREATE TABLE IF NOT EXISTS eco_monitoring.environmental_quality_scores (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            VARCHAR NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  monitoring_cycle_id   UUID NOT NULL REFERENCES eco_monitoring.monitoring_cycles(id) ON DELETE CASCADE,
  composite_score       NUMERIC(5,2) NOT NULL,
  grade                 CHAR(1) NOT NULL CHECK (grade IN ('A','B','C','D','F')),
  vegetation_score      NUMERIC(5,2),
  moisture_score        NUMERIC(5,2),
  coverage_score        NUMERIC(5,2),
  data_quality_score    NUMERIC(5,2),
  ecosystem_health_idx  NUMERIC(5,2),
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE eco_monitoring.environmental_quality_scores
  IS 'Composite environmental quality score computed per monitoring cycle. A=excellent, F=severely degraded.';

CREATE INDEX IF NOT EXISTS idx_env_quality_scores_project
  ON eco_monitoring.environmental_quality_scores (project_id, computed_at DESC);

-- ─── 6. Add monitoring_cycle_id FK to environmental_observations ──────────────
--
-- Foundation migration stores project_id only. Adding cycle FK for join efficiency.
-- Safe: nullable column, no data migration required.

ALTER TABLE eco_monitoring.environmental_observations
  ADD COLUMN IF NOT EXISTS monitoring_cycle_id UUID
    REFERENCES eco_monitoring.monitoring_cycles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_env_obs_cycle_id
  ON eco_monitoring.environmental_observations (monitoring_cycle_id)
  WHERE monitoring_cycle_id IS NOT NULL;

-- ─── 7. Indexes for reporting queries ─────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_env_obs_type_project
  ON eco_monitoring.environmental_observations (project_id, observation_type, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_monitoring_cycles_status
  ON eco_monitoring.monitoring_cycles (project_id, status, started_at DESC);

COMMIT;
