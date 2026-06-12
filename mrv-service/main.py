import uuid
import redis
import logging
from typing import Optional
from fastapi import FastAPI, HTTPException, Security, Depends
from fastapi.security.api_key import APIKeyHeader
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from rq import Queue
from prometheus_fastapi_instrumentator import Instrumentator

from config import settings
from jobs import run_mrv_analysis

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mrv-api")

app = FastAPI(title='NEVARA MRV API', version='2.0.0')

# Infrastructure Setup
redis_conn = redis.from_url(settings.REDIS_URL)
mrv_queue = Queue(connection=redis_conn)

# Prometheus Monitoring
Instrumentator().instrument(app).expose(app)

# Security: API Key Header
API_KEY_NAME = "X-MRV-API-Key"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

async def get_api_key(api_key: str = Depends(api_key_header)):
    if api_key == settings.MRV_API_KEY:
        return api_key
    raise HTTPException(status_code=403, detail="Invalid MRV API Key")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

class MRVTriggerRequest(BaseModel):
    project_id: str
    polygon_geojson: Optional[dict] = None
    ecosystem_type: str
    area_ha: float
    project_age_years: float = 0.0

class MRVTriggerResponse(BaseModel):
    job_id: str
    message: str = "Job enqueued to production queue"

@app.post('/mrv/trigger', response_model=MRVTriggerResponse)
async def trigger_mrv(req: MRVTriggerRequest, api_key: str = Depends(get_api_key)):
    """
    Production entry point: Enqueues an MRV job into Redis.
    The job will be picked up by a dedicated worker process.
    """
    logger.info(f"Enqueuing MRV job for project {req.project_id}")
    
    job = mrv_queue.enqueue(
        run_mrv_analysis,
        project_id=req.project_id,
        polygon_geojson=req.polygon_geojson,
        ecosystem_type=req.ecosystem_type,
        area_ha=req.area_ha,
        project_age_years=req.project_age_years,
        job_timeout='10m' # Allow up to 10 mins for GEE processing
    )
    
    return MRVTriggerResponse(job_id=job.get_id())

class RunMRVRequest(BaseModel):
    projectId: str
    ndvi: float | dict | list | None = None

@app.post("/run-mrv")
async def run_mrv(req: RunMRVRequest):
    data = req.dict()
    print("MRV processing started")
    logger.info("MRV processing started")
    
    # simulate processing
    def compute_score(ndvi):
        return {"trust_score": 90, "confidence": "HIGH"}
        
    result = compute_score(data.get("ndvi"))
    
    # callback to Node backend
    import requests
    try:
        print("Sending webhook")
        logger.info("Sending webhook")
        requests.post("http://localhost:5002/api/mrv/webhook", json={
            "projectId": data["projectId"],
            "score": result
        })
    except Exception as e:
        logger.error(f"Failed to call webhook: {e}")

    return {"status": "processing"}


@app.get('/health')
async def health():
    # Simple check for Redis connectivity
    try:
        redis_conn.ping()
        return {"status": "healthy", "queue": "connected"}
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return {"status": "unhealthy", "error": str(e)}

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=settings.MRV_SERVICE_PORT)
