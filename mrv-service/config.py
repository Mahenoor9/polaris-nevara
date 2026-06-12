from pydantic_settings import BaseSettings
from typing import Optional

class Settings(BaseSettings):
    DATABASE_URL: str
    
    # Redis for Job Queue
    REDIS_URL: str = "redis://localhost:6379/0"
    
    # GEE Auth
    GEE_SERVICE_ACCOUNT: str
    GEE_PRIVATE_KEY_FILE: Optional[str] = None
    GEE_PRIVATE_KEY_JSON: Optional[str] = None
    
    # Security: Service-to-Service Authentication
    MRV_API_KEY: str # Secret key for Node.js -> Python auth
    
    # Infrastructure
    GCS_BUCKET: Optional[str] = None
    MRV_SERVICE_PORT: int = 8001
    NEVARA_BACKEND_URL: str = 'http://localhost:5002'
    
    # Reliability
    MAX_RETRIES: int = 5
    RETRY_DELAY_SEC: int = 60
    GEE_PROJECT_ID: Optional[str] = None

    class Config:
        env_file = ".env"
        extra = "allow"

settings = Settings()
