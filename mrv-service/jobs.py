import logging
import httpx
import asyncio
from pathlib import Path
from datetime import datetime
from tenacity import retry, stop_after_attempt, wait_exponential
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from ndvi_pipeline import NDVIPipeline
from scoring_engine import ScoringEngine
from report_generator import ReportGenerator
from audit_logger import AuditLogger
from config import settings
from models import MRVScore, NDVIMeasurement

logger = logging.getLogger("mrv-jobs")

# Database setup for worker
engine = create_engine(settings.DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

@retry(stop=stop_after_attempt(5), wait=wait_exponential(multiplier=1, min=4, max=30))
def notify_backend_sync(payload: dict):
    """Synchronous version of notify_backend for the RQ worker."""
    webhook_url = f"{settings.NEVARA_BACKEND_URL}/api/mrv/webhook"
    # Use the same API Key for back-channel security if needed
    headers = {"X-MRV-API-Key": settings.MRV_API_KEY}
    
    with httpx.Client(timeout=15.0) as client:
        logger.info(f"Sending webhook to {webhook_url}: {payload.get('status')}")
        response = client.post(webhook_url, json=payload, headers=headers)
        response.raise_for_status()
        return response.json()

def run_mrv_analysis(project_id: str, polygon_geojson: dict, ecosystem_type: str, area_ha: float, project_age_years: float):
    """
    Core MRV processing logic intended to run in a background worker.
    """
    logger.info(f"🛰️  Processing MRV for project {project_id}")
    audit = AuditLogger(project_id)
    audit.log_trigger({"project_id": project_id, "ecosystem": ecosystem_type})

    try:
        # 1. Fetch NDVI
        pipeline = NDVIPipeline()
        ndvi_data = pipeline.fetch_monthly_ndvi(polygon_geojson)
        audit.log_ndvi_fetched(len(ndvi_data))

        # 2. Score
        engine_calc = ScoringEngine()
        score_result = engine_calc.calculate_score(
            ecosystem_type=ecosystem_type,
            area_ha=area_ha,
            ndvi_data=ndvi_data,
            project_age_years=project_age_years
        )
        audit.log_score_computed(score_result)

        # 3. Report
        generator = ReportGenerator()
        pdf_path, html_path = generator.generate_report(
            project_id=project_id,
            score=score_result,
            ndvi_data=ndvi_data,
            polygon_geojson=polygon_geojson
        )
        audit.log_report_generated(pdf_path, html_path)

        # 4. Persistence
        db = SessionLocal()
        try:
            pdf_url = f"/mrv-reports/{Path(pdf_path).name}"
            html_url = f"/mrv-reports/{Path(html_path).name}"

            mrv_score = MRVScore(
                project_id=project_id,
                trust_score=score_result.trust_score,
                confidence=score_result.confidence,
                baseline_ndvi=score_result.baseline_ndvi,
                current_ndvi=score_result.current_ndvi,
                ndvi_delta_pct=score_result.ndvi_delta_pct,
                canopy_pct=score_result.canopy_pct,
                ecosystem_factor=score_result.ecosystem_factor,
                area_ha=area_ha,
                red_flag=score_result.red_flag,
                data_gap_months=score_result.data_gap_months,
                report_pdf_url=pdf_url,
                report_html=html_url,
                input_hash=score_result.input_hash,
                output_hash=score_result.output_hash
            )
            db.add(mrv_score)

            for d in ndvi_data:
                try:
                    m_at = datetime.strptime(d['month'], '%Y-%m')
                except:
                    m_at = datetime.utcnow()
                
                db.add(NDVIMeasurement(
                    project_id=project_id,
                    ndvi_mean=d['ndvi_mean'],
                    cloud_cover_pct=d['cloud_cover_pct'],
                    measured_at=m_at
                ))
            
            db.commit()
            logger.info(f"✅ Data persisted for {project_id}")
        finally:
            db.close()

        # 5. Notify Backend
        notify_backend_sync({
            "projectId": project_id,
            "status": "COMPLETED",
            "trustScore": score_result.trust_score
        })

    except Exception as e:
        logger.error(f"❌ MRV Job failed for {project_id}: {str(e)}", exc_info=True)
        try:
            notify_backend_sync({
                "projectId": project_id,
                "status": "FAILED",
                "error": str(e)
            })
        except:
            pass
