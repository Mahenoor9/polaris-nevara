import json
import hashlib
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import create_engine, select, desc
from sqlalchemy.orm import Session

from config import settings
from models import MRVAuditLog, Base

# Initialize DB engine (reuse settings.DATABASE_URL)
engine = create_engine(settings.DATABASE_URL, echo=False, future=True)
# Ensure tables exist (in production migrations handle this)
Base.metadata.create_all(engine)

class AuditLogger:
    """Append‑only audit logger with chain‑linked SHA‑256 hashes.

    Each audit entry stores a ``sha256_hash`` of its payload and a ``prev_hash``
    linking to the previous entry for the same project. This creates an
    immutable audit trail suitable for verification and blockchain anchoring.
    """

    def __init__(self, project_id: str):
        self.project_id = project_id
        # Retrieve the most recent hash for this project (if any)
        try:
            with Session(engine) as session:
                stmt = select(MRVAuditLog.sha256_hash).where(MRVAuditLog.project_id == self.project_id).order_by(desc(MRVAuditLog.logged_at)).limit(1)
                result = session.execute(stmt).scalar_one_or_none()
                self.prev_hash = result
        except Exception:
            # Fallback if table doesn't exist yet or connection fails
            self.prev_hash = None

    def _hash_payload(self, payload: Dict[str, Any]) -> str:
        """Return SHA‑256 hex digest of a JSON‑canonicalised payload."""
        # Ensure deterministic ordering
        payload_str = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload_str.encode("utf-8")).hexdigest()

    def log_event(self, event_type: str, payload: Dict[str, Any], scorer_version: Optional[str] = None) -> str:
        """Create a new audit row and return its hash.

        Args:
            event_type: Type identifier like ``MRV_TRIGGERED``.
            payload: Arbitrary JSON‑serialisable data describing the event.
            scorer_version: Optional version string for scoring events.
        """
        payload_hash = self._hash_payload(payload)
        # Combine payload hash with previous hash to form chain hash
        combined = f"{payload_hash}:{self.prev_hash or ''}".encode("utf-8")
        chain_hash = hashlib.sha256(combined).hexdigest()

        audit_entry = MRVAuditLog(
            project_id=self.project_id,
            event_type=event_type,
            payload=payload,
            sha256_hash=chain_hash,
            prev_hash=self.prev_hash,
            scorer_version=scorer_version,
        )
        with Session(engine) as session:
            session.add(audit_entry)
            session.commit()
        # Update prev_hash for subsequent entries in the same process
        self.prev_hash = chain_hash
        return chain_hash

    # Convenience wrappers matching the FastAPI code paths
    def log_trigger(self, payload: Dict[str, Any]) -> str:
        return self.log_event("MRV_TRIGGERED", payload)

    def log_ndvi_fetched(self, data_points: int) -> str:
        return self.log_event("NDVI_FETCHED", {"data_points": data_points})

    def log_score_computed(self, score_result: Any) -> str:
        # ``score_result`` is a dataclass; convert to dict safely
        payload = score_result.__dict__ if hasattr(score_result, "__dict__") else dict(score_result)
        return self.log_event("SCORE_COMPUTED", payload, scorer_version=getattr(score_result, "scoring_version", None))

    def log_report_generated(self, pdf_path: str, html_path: str) -> str:
        return self.log_event("REPORT_GENERATED", {"pdf_path": pdf_path, "html_path": html_path})
