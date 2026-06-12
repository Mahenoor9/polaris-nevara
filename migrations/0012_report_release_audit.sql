-- Migration: Report Release Records & Audit Event Log
-- Phase: Report Release Audit
-- Date: 2026-05-24
--
-- This migration adds two tables:
--   1. report_releases   — persistent release records with versioning
--   2. report_audit_events — immutable chronological audit event log
--
-- Both tables are safe to add incrementally alongside the existing
-- report_reviews table. Neither modifies existing tables or constraints.

-- ── report_releases ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.report_releases (
    release_id    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    TEXT          NOT NULL,
    run_id        TEXT          NOT NULL,
    report_version INTEGER      NOT NULL DEFAULT 1,
    is_latest     BOOLEAN       NOT NULL DEFAULT true,
    released_by   TEXT          NULL,
    released_at   TIMESTAMPTZ   NULL,
    release_notes TEXT          NULL,
    status        TEXT          NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','approved','published','released','superseded')),
    report_path   TEXT          NULL,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_report_releases_project_run
    ON public.report_releases (project_id, run_id);

CREATE INDEX IF NOT EXISTS idx_report_releases_is_latest
    ON public.report_releases (project_id, run_id, is_latest);

-- ── report_audit_events ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.report_audit_events (
    id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  TEXT          NOT NULL,
    run_id      TEXT          NOT NULL,
    action      TEXT          NOT NULL
                CHECK (action IN (
                    'review_started',
                    'changes_requested',
                    'approved',
                    'published',
                    'released',
                    'version_created',
                    'superseded'
                )),
    actor       TEXT          NULL,
    notes       TEXT          NULL,
    timestamp   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_report_audit_events_project_run
    ON public.report_audit_events (project_id, run_id, timestamp ASC);
