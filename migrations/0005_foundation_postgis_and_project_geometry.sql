-- migrations/0005_foundation_postgis_and_project_geometry.sql
-- Foundation Layer (safe, additive, backward compatible)

BEGIN;

-- Spatial and UUID support used by foundation tables
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Isolated namespace for ecological monitoring architecture
CREATE SCHEMA IF NOT EXISTS eco_monitoring;

-- ---------------------------------------------------------------------------
-- Additive project geometry + monitoring metadata (legacy marketplace/minting untouched)
-- ---------------------------------------------------------------------------
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS polygon geometry(Polygon, 4326),
  ADD COLUMN IF NOT EXISTS centroid geometry(Point, 4326),
  ADD COLUMN IF NOT EXISTS bbox geometry(Polygon, 4326),
  ADD COLUMN IF NOT EXISTS area_hectares NUMERIC(14, 4),
  ADD COLUMN IF NOT EXISTS perimeter_km NUMERIC(14, 4),
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS admin_region TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT,
  ADD COLUMN IF NOT EXISTS monitoring_frequency TEXT,
  ADD COLUMN IF NOT EXISTS next_monitoring_due TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS baseline_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registry_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_projects_polygon_gist
  ON public.projects USING GIST (polygon);

CREATE INDEX IF NOT EXISTS idx_projects_centroid_gist
  ON public.projects USING GIST (centroid);

CREATE INDEX IF NOT EXISTS idx_projects_next_monitoring_due
  ON public.projects (next_monitoring_due);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_registry_id_unique
  ON public.projects (registry_id);

-- Keep allowed values constrained while staying backward-compatible (nullable text column)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'projects_monitoring_frequency_check'
      AND conrelid = 'public.projects'::regclass
  ) THEN
    ALTER TABLE public.projects
      ADD CONSTRAINT projects_monitoring_frequency_check
      CHECK (
        monitoring_frequency IS NULL
        OR monitoring_frequency IN ('biweekly', 'monthly', 'quarterly')
      );
  END IF;
END $$;

-- Auto-compute centroid/bbox/area/perimeter from incoming polygon
CREATE OR REPLACE FUNCTION eco_monitoring.compute_project_spatial_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.polygon IS NOT NULL THEN
    NEW.polygon := ST_SetSRID(ST_MakeValid(NEW.polygon), 4326);
    NEW.centroid := ST_Centroid(NEW.polygon);
    NEW.bbox := ST_Envelope(NEW.polygon);
    NEW.area_hectares := ST_Area(NEW.polygon::geography) / 10000.0;
    NEW.perimeter_km := ST_Perimeter(NEW.polygon::geography) / 1000.0;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_projects_spatial_fields'
  ) THEN
    CREATE TRIGGER trg_projects_spatial_fields
      BEFORE INSERT OR UPDATE OF polygon ON public.projects
      FOR EACH ROW
      EXECUTE FUNCTION eco_monitoring.compute_project_spatial_fields();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Foundation enums in isolated schema
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'monitoring_cycle_type'
      AND n.nspname = 'eco_monitoring'
  ) THEN
    CREATE TYPE eco_monitoring.monitoring_cycle_type AS ENUM (
      'baseline',
      'scheduled',
      'manual',
      'event_triggered'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'monitoring_cycle_status'
      AND n.nspname = 'eco_monitoring'
  ) THEN
    CREATE TYPE eco_monitoring.monitoring_cycle_status AS ENUM (
      'pending',
      'imagery_collection',
      'analyzing',
      'analysis_complete',
      'under_review',
      'verified',
      'flagged',
      'failed'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'observation_type'
      AND n.nspname = 'eco_monitoring'
  ) THEN
    CREATE TYPE eco_monitoring.observation_type AS ENUM (
      'ndvi',
      'evi',
      'savi',
      'ndwi',
      'ndmi',
      'nbr',
      'bsi',
      'land_cover',
      'surface_temp',
      'sar_backscatter',
      'biomass_estimate',
      'flood_extent',
      'moisture_index',
      'canopy_height',
      'erosion_indicator',
      'water_turbidity',
      'vegetation_fraction',
      'phenology_metric'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'observation_quality_flag'
      AND n.nspname = 'eco_monitoring'
  ) THEN
    CREATE TYPE eco_monitoring.observation_quality_flag AS ENUM (
      'good',
      'acceptable',
      'low',
      'failed'
    );
  END IF;
END $$;

COMMIT;
