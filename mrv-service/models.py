from sqlalchemy import (
    Column,
    Integer,
    String,
    Float,
    DateTime,
    Boolean,
    Text,
    JSON,
    ForeignKey,
    UniqueConstraint,
    Index,
    func,
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship

Base = declarative_base()

class NDVIMeasurement(Base):
    __tablename__ = 'ndvi_measurements'
    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(String(36), ForeignKey('projects.id', ondelete='CASCADE'), nullable=False)
    measured_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    ndvi_mean = Column(Float, nullable=False)
    ndvi_min = Column(Float)
    ndvi_max = Column(Float)
    cloud_cover_pct = Column(Float)
    satellite_source = Column(String(50), default='Sentinel-2')
    polygon = Column(JSON)  # store GeoJSON; could use PostGIS geometry type with geoalchemy2
    raw_gee_response = Column(JSON)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index('idx_ndvi_project_id', 'project_id'),
        Index('idx_ndvi_measured_at', 'measured_at'),
    )

class MRVScore(Base):
    __tablename__ = 'mrv_scores'
    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(String(36), ForeignKey('projects.id', ondelete='CASCADE'), nullable=False)
    scored_at = Column(DateTime(timezone=True), server_default=func.now())
    trust_score = Column(Integer, nullable=False)
    confidence = Column(String(10))
    baseline_ndvi = Column(Float)
    current_ndvi = Column(Float)
    ndvi_delta_pct = Column(Float)
    canopy_pct = Column(Float)
    ecosystem_factor = Column(Float)
    area_ha = Column(Float)
    red_flag = Column(Boolean, default=False)
    data_gap_months = Column(Integer, default=0)
    report_pdf_url = Column(Text)
    report_html = Column(Text)
    input_hash = Column(String(64))
    output_hash = Column(String(64))
    scoring_version = Column(String(20), default='v1.0')

    __table_args__ = (
        Index('idx_mrv_project', 'project_id'),
        Index('idx_mrv_scored_at', 'scored_at', postgresql_using='btree', postgresql_desc=True),
        UniqueConstraint('project_id', 'scored_at', name='idx_mrv_latest'),
    )

class MRVAuditLog(Base):
    __tablename__ = 'mrv_audit_log'
    id = Column(Integer, primary_key=True, autoincrement=True)
    logged_at = Column(DateTime(timezone=True), server_default=func.now())
    project_id = Column(String(36), nullable=False)
    event_type = Column(String(50), nullable=False)
    payload = Column(JSON, nullable=False)
    sha256_hash = Column(String(64), nullable=False)
    prev_hash = Column(String(64))
    scorer_version = Column(String(20))

    # Append‑only: prevent UPDATE/DELETE via DB grants (handled outside SQL)

    __table_args__ = (
        Index('idx_audit_project', 'project_id'),
    )
