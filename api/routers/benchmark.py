"""GET /api/patient/{sn}/benchmark — cohort percentile for a patient."""
from __future__ import annotations
import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session as DBSession
from sqlalchemy import text
import deps
from db import get_db
from deps import verify_api_key

router = APIRouter()
logger = logging.getLogger(__name__)

@router.get("/patient/{sn}/benchmark", dependencies=[Depends(verify_api_key)])
def get_benchmark(sn: str, db: DBSession = Depends(get_db)) -> dict:
    """Return patient's composite improvement percentile rank within their cohort."""
    if not deps._db_ready:
        raise HTTPException(status_code=503, detail="Patient data not available.")

    result = db.execute(text("""
        WITH latest_per_patient AS (
            SELECT DISTINCT ON (patient_id)
                patient_id,
                composite_improvement
            FROM sessions
            WHERE composite_improvement IS NOT NULL
              AND (ingested_from IS NULL OR ingested_from NOT ILIKE '%raise%')
            ORDER BY patient_id, session_number DESC
        ),
        ranked AS (
            SELECT
                l.patient_id,
                PERCENT_RANK() OVER (
                    PARTITION BY p.cohort
                    ORDER BY l.composite_improvement
                ) AS pct_rank
            FROM latest_per_patient l
            JOIN patients p ON p.id = l.patient_id
        )
        SELECT ROUND(r.pct_rank * 100)::int AS cohort_percentile
        FROM ranked r
        JOIN patients p ON p.id = r.patient_id
        WHERE p.sn = :sn
    """), {"sn": sn}).first()

    if result is None:
        return {"cohort_percentile": None}

    return {"cohort_percentile": int(result._mapping["cohort_percentile"])}
