-- migrations/0004_mrv_system.sql
-- Enable PostGIS extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS postgis;

-- Table: ndvi_measurements
CREATE TABLE ndvi_measurements (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  measured_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ndvi_mean DECIMAL(6,4) NOT NULL, -- e.g. 0.7823
  ndvi_min  DECIMAL(6,4),
  ndvi_max  DECIMAL(6,4),
  cloud_cover_pct DECIMAL(5,2),
  satellite_source VARCHAR(50) DEFAULT 'Sentinel-2',
  polygon GEOMETRY(POLYGON,4326), -- PostGIS spatial type (WGS84)
  raw_gee_response JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_ndvi_project_id ON ndvi_measurements(project_id);
CREATE INDEX idx_ndvi_measured_at ON ndvi_measurements(measured_at);
CREATE INDEX idx_ndvi_polygon ON ndvi_measurements USING GIST(polygon);

-- Table: mrv_scores
CREATE TABLE mrv_scores (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scored_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  trust_score INTEGER NOT NULL CHECK (trust_score BETWEEN 0 AND 100),
  confidence VARCHAR(10) CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  baseline_ndvi DECIMAL(6,4),
  current_ndvi DECIMAL(6,4),
  ndvi_delta_pct DECIMAL(6,2),
  canopy_pct DECIMAL(5,2),
  ecosystem_factor DECIMAL(4,2),
  area_ha DECIMAL(12,4),
  red_flag BOOLEAN DEFAULT FALSE,
  data_gap_months INTEGER DEFAULT 0,
  report_pdf_url TEXT,
  report_html TEXT,
  input_hash VARCHAR(64),
  output_hash VARCHAR(64),
  scoring_version VARCHAR(20) DEFAULT 'v1.0'
);
CREATE INDEX idx_mrv_project ON mrv_scores(project_id);
CREATE INDEX idx_mrv_scored_at ON mrv_scores(scored_at DESC);
CREATE UNIQUE INDEX idx_mrv_latest ON mrv_scores(project_id, scored_at DESC);

-- Table: mrv_audit_log (append‑only)
CREATE TABLE mrv_audit_log (
  id BIGSERIAL PRIMARY KEY,
  logged_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  project_id INTEGER NOT NULL,
  event_type VARCHAR(50) NOT NULL, -- 'MRV_TRIGGERED' | 'SCORE_COMPUTED' | 'REPORT_GENERATED' | 'BLOCKCHAIN_LOGGED'
  payload JSONB NOT NULL,
  sha256_hash VARCHAR(64) NOT NULL,
  prev_hash VARCHAR(64),
  scorer_version VARCHAR(20)
);
-- Make table truly append‑only
REVOKE UPDATE, DELETE ON mrv_audit_log FROM nevara_app_user;
