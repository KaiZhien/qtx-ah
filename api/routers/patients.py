"""Patient list and detail endpoints — reads from PostgreSQL via SQLAlchemy."""
from __future__ import annotations

import math
from typing import Any, List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

import deps
from db import get_db
from models.clinical import Patient, Session as ClinicalSession

router = APIRouter()


def _val(v: Any) -> Any:
    """Replace NaN / None / Decimal with JSON-safe values."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    # Convert Decimal (SQLAlchemy Numeric columns) to float
    if hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
        return float(v)
    return v


def _row_to_dict(patient: Patient, session: ClinicalSession | None) -> dict[str, Any]:
    """Flatten a Patient + Session pair into the flat dict the frontend expects."""
    d: dict[str, Any] = {}

    # Patient scalar fields
    for col in [
        "sn", "name", "gender", "age", "age_band", "cohort",
        "primary_indication", "record_type", "phone_number", "tags",
    ]:
        d[col] = _val(getattr(patient, col, None))

    # Patient boolean flags (all 47 of them)
    for col in [
        "has_oa", "has_diabetes", "has_stroke", "has_parkinsons", "has_sarcopenia",
        "has_frailty", "has_balance_issue", "has_post_surgery", "has_chronic_pain",
        "has_neuropathy", "has_cancer", "has_cardiovascular", "has_hypertension",
        "has_osteoporosis", "has_spinal_issue", "has_knee_issue", "has_hip_issue",
        "has_shoulder_issue", "has_neurological", "has_fracture", "has_autoimmune",
        "has_metabolic", "has_wellness_only", "has_fall_risk",
        "grp_joint_disease", "grp_spine_back", "grp_neurological", "grp_post_surgical",
        "grp_frailty_sarcopenia", "grp_balance_falls", "grp_metabolic", "grp_cardiovascular",
        "grp_oncology", "grp_autoimmune", "grp_softtissue_injury", "grp_generalised_pain",
        "grp_osteoporosis", "grp_wellness",
        "rgn_knee", "rgn_hip", "rgn_spine", "rgn_shoulder", "rgn_ankle_foot",
        "rgn_lower_limb", "rgn_upper_limb", "rgn_bilateral", "rgn_trunk",
    ]:
        d[col] = _val(getattr(patient, col, False))

    # Session fields
    if session is not None:
        for col in [
            "usage_frequency", "has_followup", "joined_with_pain", "pain_improved",
            "pain_location", "pre_vas", "post_vas", "vas_change",
            "pre_tug_s", "post_tug_s", "tug_change_s", "tug_change_pct",
            "pre_5xsst_s", "post_5xsst_s", "sst_change_s", "sst_change_pct",
            "pre_normal_time_s", "post_normal_time_s",
            "pre_normal_gs_ms", "post_normal_gs_ms", "normal_gs_change_ms", "normal_gs_change_pct",
            "pre_fast_time_s", "post_fast_time_s",
            "pre_fast_gs_ms", "post_fast_gs_ms", "fast_gs_change_ms", "fast_gs_change_pct",
            "baseline_sppb", "post_sppb", "sppb_change", "sppb_source",
            "n_pre_post_pairs", "composite_improvement", "overall_responder",
            "breadth_of_response", "is_dropout",
        ]:
            d[col] = _val(getattr(session, col, None))
    else:
        # No session: fill session keys with None so the frontend always sees the same shape
        for col in [
            "usage_frequency", "has_followup", "joined_with_pain", "pain_improved",
            "pain_location", "pre_vas", "post_vas", "vas_change",
            "pre_tug_s", "post_tug_s", "tug_change_s", "tug_change_pct",
            "pre_5xsst_s", "post_5xsst_s", "sst_change_s", "sst_change_pct",
            "pre_normal_time_s", "post_normal_time_s",
            "pre_normal_gs_ms", "post_normal_gs_ms", "normal_gs_change_ms", "normal_gs_change_pct",
            "pre_fast_time_s", "post_fast_time_s",
            "pre_fast_gs_ms", "post_fast_gs_ms", "fast_gs_change_ms", "fast_gs_change_pct",
            "baseline_sppb", "post_sppb", "sppb_change", "sppb_source",
            "n_pre_post_pairs", "composite_improvement", "overall_responder",
            "breadth_of_response", "is_dropout",
        ]:
            d[col] = None

    return d


def _check_db_ready():
    if not deps._db_ready:
        raise HTTPException(
            status_code=503,
            detail="Patient data not available — DB is empty or unreachable. Run scripts/11_seed_database.py.",
        )


@router.get("/patients")
def list_patients(
    cohort: List[str] = Query(default=[]),
    usage: List[str] = Query(default=[]),
    age_band: List[str] = Query(default=[]),
    gender: List[str] = Query(default=[]),
    fu_only: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return filtered patient records as flat dicts matching the original parquet shape."""
    _check_db_ready()

    query = (
        db.query(Patient, ClinicalSession)
        .join(ClinicalSession, ClinicalSession.patient_id == Patient.id)
        .filter(ClinicalSession.session_number == 1)
    )

    if cohort:
        query = query.filter(Patient.cohort.in_(cohort))
    if usage:
        query = query.filter(ClinicalSession.usage_frequency.in_(usage))
    if age_band:
        query = query.filter(Patient.age_band.in_(age_band))
    if gender:
        query = query.filter(Patient.gender.in_(gender))
    if fu_only:
        query = query.filter(ClinicalSession.is_dropout == False)  # noqa: E712

    rows = query.all()
    return [_row_to_dict(p, s) for p, s in rows]


@router.get("/patient/{sn}")
def get_patient(sn: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Return a single patient record by sn."""
    _check_db_ready()

    patient = db.query(Patient).filter(Patient.sn == sn).first()
    if patient is None:
        raise HTTPException(status_code=404, detail=f"Patient with sn={sn!r} not found")

    session = (
        db.query(ClinicalSession)
        .filter_by(patient_id=patient.id, session_number=1)
        .first()
    )
    return _row_to_dict(patient, session)
