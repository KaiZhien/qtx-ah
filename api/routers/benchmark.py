"""GET /api/patient/{sn}/benchmark — cohort percentile ranks per metric."""
from __future__ import annotations
import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session as DBSession
from sqlalchemy import text
import deps
from db import get_db
from deps import verify_api_key
from models.clinical import Patient

router = APIRouter()
logger = logging.getLogger(__name__)

def _ordinal(n: int) -> str:
    if 11 <= (n % 100) <= 13:
        return f"{n}th"
    return f"{n}{['th', 'st', 'nd', 'rd', 'th'][min(n % 10, 4)]}"

_METRICS = [
    ("composite_improvement", "composite_improvement", "pct_composite", "n_composite", True),
    ("tug_change_pct",        "tug_change_pct",        "pct_tug",       "n_tug",       False),
    ("sst_change_pct",        "sst_change_pct",        "pct_sst",       "n_sst",       False),
    ("sppb_change",           "sppb_change",           "pct_sppb",      "n_sppb",      True),
    ("vas_change",            "vas_change",            "pct_vas",       "n_vas",       False),
    ("normal_gs_change_pct",  "normal_gs_change_pct",  "pct_normal_gs", "n_normal_gs", True),
    ("fast_gs_change_pct",    "fast_gs_change_pct",    "pct_fast_gs",   "n_fast_gs",   True),
]

@router.get("/patient/{sn}/benchmark", dependencies=[Depends(verify_api_key)])
def get_benchmark(sn: str, db: DBSession = Depends(get_db)) -> dict:
    if not deps._db_ready:
        raise HTTPException(status_code=503, detail="Patient data not available.")
    patient = db.query(Patient).filter_by(sn=sn).first()
    if patient is None:
        raise HTTPException(status_code=404, detail=f"Patient sn={sn!r} not found")
    result = db.execute(text("""
        WITH latest AS (
            SELECT DISTINCT ON (s.patient_id)
                s.patient_id, s.composite_improvement, s.tug_change_pct, s.sst_change_pct,
                s.sppb_change, s.vas_change, s.normal_gs_change_pct, s.fast_gs_change_pct,
                p.cohort, p.sn,
                COUNT(*) OVER (PARTITION BY p.cohort) AS cohort_n
            FROM sessions s JOIN patients p ON p.id = s.patient_id
            WHERE (s.ingested_from IS NULL OR s.ingested_from NOT ILIKE '%raise%')
            ORDER BY s.patient_id, s.session_number DESC
        ),
        ranked AS (
            SELECT *,
                PERCENT_RANK() OVER (PARTITION BY cohort ORDER BY composite_improvement  NULLS LAST) AS pct_composite,
                PERCENT_RANK() OVER (PARTITION BY cohort ORDER BY tug_change_pct       DESC NULLS LAST) AS pct_tug,
                PERCENT_RANK() OVER (PARTITION BY cohort ORDER BY sst_change_pct       DESC NULLS LAST) AS pct_sst,
                PERCENT_RANK() OVER (PARTITION BY cohort ORDER BY sppb_change          NULLS LAST) AS pct_sppb,
                PERCENT_RANK() OVER (PARTITION BY cohort ORDER BY vas_change           DESC NULLS LAST) AS pct_vas,
                PERCENT_RANK() OVER (PARTITION BY cohort ORDER BY normal_gs_change_pct NULLS LAST) AS pct_normal_gs,
                PERCENT_RANK() OVER (PARTITION BY cohort ORDER BY fast_gs_change_pct   NULLS LAST) AS pct_fast_gs,
                COUNT(composite_improvement)  OVER (PARTITION BY cohort) AS n_composite,
                COUNT(tug_change_pct)         OVER (PARTITION BY cohort) AS n_tug,
                COUNT(sst_change_pct)         OVER (PARTITION BY cohort) AS n_sst,
                COUNT(sppb_change)            OVER (PARTITION BY cohort) AS n_sppb,
                COUNT(vas_change)             OVER (PARTITION BY cohort) AS n_vas,
                COUNT(normal_gs_change_pct)   OVER (PARTITION BY cohort) AS n_normal_gs,
                COUNT(fast_gs_change_pct)     OVER (PARTITION BY cohort) AS n_fast_gs
            FROM latest
        )
        SELECT * FROM ranked WHERE sn = :sn
    """), {"sn": sn}).first()
    if result is None:
        return {"cohort": None, "cohort_n": 0, "cohort_percentile": None, "benchmarks": []}
    m = result._mapping
    pct_raw = m.get("pct_composite")
    cohort_percentile = int(round(pct_raw * 100)) if pct_raw is not None else None
    benchmarks = []
    for key, val_col, pct_col, n_col, higher in _METRICS:
        v = m.get(val_col)
        if v is None: continue
        p = m.get(pct_col)
        if p is None: continue
        pf = float(p)
        benchmarks.append({"metric": key, "patient_value": float(v), "percentile": pf,
            "percentile_display": _ordinal(int(round(pf * 100))), "n_compared": int(m.get(n_col) or 0), "higher_is_better": higher})
    return {"cohort": m["cohort"], "cohort_n": int(m["cohort_n"]), "cohort_percentile": cohort_percentile, "benchmarks": benchmarks}
