-- migrations/0006_foundation_monitoring_and_observations.sql
-- Depends on: 0005_foundation_postgis_and_project_geometry.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- Foundational environmental profile table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eco_monitoring.project_site_profiles (
  id BIGSERIAL PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  profile_version INTEGER NOT NULL,
  detected_ecosystem_type VARCHAR(100),
  land_cover_composition JSONB NOT NULL DEFAULT '{}'::jsonb,
  dominant_land_cover VARCHAR(100),
  elevation_min_m NUMERIC(10, 2),
  elevation_max_m NUMERIC(10, 2),
  elevation_mean_m NUMERIC(10, 2),
  slope_mean_deg NUMERIC(8, 3),
  slope_max_deg NUMERIC(8, 3),
  aspect_dominant VARCHAR(32),
  nearest_water_body_name TEXT,
  nearest_water_body_distance_m NUMERIC(12, 2),
  nearest_water_body_type VARCHAR(32),
  climate_zone VARCHAR(64),
  annual_rainfall_mm NUMERIC(10, 2),
  soil_type_estimate VARCHAR(128),
  flood_risk_class VARCHAR(32),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_datasets JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence_score NUMERIC(5, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, profile_version)
);

CREATE INDEX IF NOT EXISTS idx_project_site_profiles_project_id
  ON eco_monitoring.project_site_profiles (project_id);

CREATE INDEX IF NOT EXISTS idx_project_site_profiles_computed_at
  ON eco_monitoring.project_site_profiles (computed_at DESC);

-- ---------------------------------------------------------------------------
-- Monitoring cycle table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eco_monitoring.monitoring_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  cycle_number INTEGER NOT NULL CHECK (cycle_number >= 0),
  cycle_type eco_monitoring.monitoring_cycle_type NOT NULL,
  status eco_monitoring.monitoring_cycle_status NOT NULL DEFAULT 'pending',
  triggered_by VARCHAR(128),
  started_at TIMESTAMPTZ,
  imagery_acquired_at TIMESTAMPTZ,
  analysis_completed_at TIMESTAMPTZ,
  review_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  satellite_imagery_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  cloud_cover_pct NUMERIC(5, 2),
  quality_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_log TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, cycle_number)
);

CREATE INDEX IF NOT EXISTS idx_monitoring_cycles_project_status
  ON eco_monitoring.monitoring_cycles (project_id, status);

CREATE INDEX IF NOT EXISTS idx_monitoring_cycles_created_at
  ON eco_monitoring.monitoring_cycles (created_at DESC);

-- ---------------------------------------------------------------------------
-- Observation system (partitioned for long-term scale)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eco_monitoring.environmental_observations (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  project_id VARCHAR NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  monitoring_cycle_id UUID NOT NULL REFERENCES eco_monitoring.monitoring_cycles(id) ON DELETE CASCADE,
  observation_type eco_monitoring.observation_type NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  value_mean NUMERIC(12, 6),
  value_min NUMERIC(12, 6),
  value_max NUMERIC(12, 6),
  value_stddev NUMERIC(12, 6),
  value_median NUMERIC(12, 6),
  value_distribution JSONB,
  value_unit VARCHAR(64),
  spatial_coverage_pct NUMERIC(5, 2),
  raster_asset_path TEXT,
  thumbnail_path TEXT,
  tile_layer_path TEXT,
  source_dataset VARCHAR(128),
  source_image_id VARCHAR(256),
  source_date DATE,
  source_resolution_m INTEGER,
  processing_algorithm VARCHAR(128),
  processing_parameters JSONB,
  confidence NUMERIC(5, 2),
  quality_flag eco_monitoring.observation_quality_flag,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, observed_at)
) PARTITION BY RANGE (observed_at);

CREATE INDEX IF NOT EXISTS idx_env_obs_project_type_observed_at
  ON eco_monitoring.environmental_observations (project_id, observation_type, observed_at);

CREATE INDEX IF NOT EXISTS idx_env_obs_monitoring_cycle_id
  ON eco_monitoring.environmental_observations (monitoring_cycle_id);

-- Partitions: baseline years + catch-all default for forward compatibility
CREATE TABLE IF NOT EXISTS eco_monitoring.env_obs_2024
  PARTITION OF eco_monitoring.environmental_observations
  FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

CREATE TABLE IF NOT EXISTS eco_monitoring.env_obs_2025
  PARTITION OF eco_monitoring.environmental_observations
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

CREATE TABLE IF NOT EXISTS eco_monitoring.env_obs_2026
  PARTITION OF eco_monitoring.environmental_observations
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

CREATE TABLE IF NOT EXISTS eco_monitoring.env_obs_2027
  PARTITION OF eco_monitoring.environmental_observations
  FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

CREATE TABLE IF NOT EXISTS eco_monitoring.env_obs_default
  PARTITION OF eco_monitoring.environmental_observations DEFAULT;

COMMIT;
