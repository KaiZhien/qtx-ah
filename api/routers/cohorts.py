"""Cohort response curve endpoint."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session as DBSession

from db import get_db
from deps import verify_api_key
from models.clinical import CohortResponseCurve

router = APIRouter()


@router.get("/cohort/{grp_flag}/response_curves", dependencies=[Depends(verify_api_key)])
def get_response_curves(
    grp_flag: str,
    metric: str | None = None,
    db: DBSession = Depends(get_db),
):
    q = db.query(CohortResponseCurve).filter_by(grp_flag=grp_flag)
    if metric:
        q = q.filter_by(metric=metric)
    rows = q.order_by(CohortResponseCurve.metric, CohortResponseCurve.session_number).all()
    if not rows:
        raise HTTPException(status_code=404, detail="No curve data for this group")

    curves: dict[str, list] = {}
    for r in rows:
        curves.setdefault(r.metric, []).append({
            "session_number": r.session_number,
            "p25": float(r.p25) if r.p25 is not None else None,
            "p50": float(r.p50) if r.p50 is not None else None,
            "p75": float(r.p75) if r.p75 is not None else None,
            "n": r.n,
        })

    return {
        "grp_flag": grp_flag,
        "curves": [{"metric": m, "points": pts} for m, pts in curves.items()],
    }
