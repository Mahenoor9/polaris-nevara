-- Migration 0013: Organization Releases
-- Creates the external org-delivery release layer separate from the internal
-- report versioning (report_releases / report_audit_events from 0012).
--
-- Organization releases track the delivery of approved reports to client
-- organisations with statuses: draft → approved → released → archived.

-- ── organization_releases ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.organization_releases (
  release_id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                  TEXT          NOT NULL,
  run_id                      TEXT          NOT NULL,
  report_version              INTEGER       NOT NULL DEFAULT 1,
  organization_id             TEXT          NULL,
  release_status              TEXT          NOT NULL DEFAULT 'draft'
    CONSTRAINT org_release_status_check CHECK (release_status IN ('draft','approved','released','archived')),
  released_by                 TEXT          NULL,
  released_at                 TIMESTAMPTZ   NULL,
  notes                       TEXT          NULL,
  report_path                 TEXT          NULL,
  review_status_at_release    TEXT          NULL,
  validation_score_at_release NUMERIC(5,2)  NULL,
  package_manifest_path       TEXT          NULL,
  created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Composite index for per-project+run lookups
CREATE INDEX IF NOT EXISTS idx_org_releases_project_run
  ON public.organization_releases (project_id, run_id);

-- Index for latest released version per organisation
CREATE INDEX IF NOT EXISTS idx_org_releases_org_status
  ON public.organization_releases (organization_id, release_status);

-- ── org_release_audit_events ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.org_release_audit_events (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  TEXT          NOT NULL,
  run_id      TEXT          NOT NULL,
  event_type  TEXT          NOT NULL
    CONSTRAINT org_release_event_type_check CHECK (
      event_type IN ('release_created','release_approved','release_published','release_archived')
    ),
  actor       TEXT          NULL,
  notes       TEXT          NULL,
  release_id  UUID          NOT NULL,
  timestamp   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Append-only index: chronological event retrieval per project+run
CREATE INDEX IF NOT EXISTS idx_org_release_events_project_run_ts
  ON public.org_release_audit_events (project_id, run_id, timestamp ASC);

-- ── Comments ─────────────────────────────────────────────────────────────────

COMMENT ON TABLE public.organization_releases IS
  'External org-delivery release records. Distinct from internal report_releases (0012). '
  'Tracks the lifecycle of a report delivery package addressed to a client organisation.';

COMMENT ON TABLE public.org_release_audit_events IS
  'Append-only audit log for organization release lifecycle events. '
  'Event types: release_created, release_approved, release_published, release_archived.';

COMMENT ON COLUMN public.organization_releases.organization_id IS
  'The client organisation this release is addressed to. Null = unassigned.';

COMMENT ON COLUMN public.organization_releases.validation_score_at_release IS
  'Snapshot of the evidence validation score at the time this release record was created.';

COMMENT ON COLUMN public.organization_releases.review_status_at_release IS
  'Snapshot of the report review status at the time this release record was created.';

COMMENT ON COLUMN public.organization_releases.package_manifest_path IS
  'Filesystem path to the client-package-vN.json manifest generated for this release.';
