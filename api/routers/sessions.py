"""Session creation and patient timeline endpoints."""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session as DBSession

import deps
from db import get_db
from models.clinical import Patient, Session as ClinicalSession, PatientTrend, PatientInsight
from services.trend import TrendEngine
from services.insight import InsightService

router = APIRouter()


def _check_db_ready() -> None:
    if not deps._db_ready:
        raise HTTPException(
            status_code=503,
            detail="Patient data not available — DB is empty or unreachable.",
        )


class NewSessionRequest(BaseModel):
    session_date:         date | None  = None
    usage_frequency:      str | None   = None
    notes:                str | None   = None
    has_followup:         bool         = False
    is_dropout:           bool         = False
    joined_with_pain:     bool | None  = None
    pain_improved:        bool | None  = None
    pain_location:        str | None   = None
    pre_vas:              float | None = None
    post_vas:             float | None = None
    vas_change:           float | None = None
    pre_tug_s:            float | None = None
    post_tug_s:           float | None = None
    tug_change_s:         float | None = None
    tug_change_pct:       float | None = None
    pre_5xsst_s:          float | None = None
    post_5xsst_s:         float | None = None
    sst_change_s:         float | None = None
    sst_change_pct:       float | None = None
    pre_normal_time_s:    float | None = None
    post_normal_time_s:   float | None = None
    pre_normal_gs_ms:     float | None = None
    post_normal_gs_ms:    float | None = None
    normal_gs_change_ms:  float | None = None
    normal_gs_change_pct: float | None = None
    pre_fast_time_s:      float | None = None
    post_fast_time_s:     float | None = None
    pre_fast_gs_ms:       float | None = None
    post_fast_gs_ms:      float | None = None
    fast_gs_change_ms:    float | None = None
    fast_gs_change_pct:   float | None = None
    baseline_sppb:        int | None   = None
    post_sppb:            int | None   = None
    sppb_change:          int | None   = None
    sppb_source:          str | None   = None
    n_pre_post_pairs:     int | None   = None
    composite_improvement: float | None = None
    overall_responder:    bool | None  = None
    breadth_of_response:  float | None = None


def _trend_to_dict(t: Any) -> dict:
    """Serialise a TrendResult or PatientTrend ORM row to a plain dict."""
    return {
        "metric":        t.metric,
        "direction":     t.direction,
        "sessions_used": t.sessions_used,
        "magnitude":     float(t.magnitude) if t.magnitude is not None else None,
        "first_value":   float(t.first_value) if t.first_value is not None else None,
        "last_value":    float(t.last_value) if t.last_value is not None else None,
    }


def _session_to_dict(s: ClinicalSession) -> dict:
    """Serialise a Session ORM row to a plain dict for the timeline response."""
    def _v(val):
        if val is None:
            return None
        if hasattr(val, "__float__"):
            return float(val)
        return val

    return {
        "session_number":       s.session_number,
        "session_date":         s.session_date.isoformat() if s.session_date else None,
        "notes":                s.notes,
        "has_followup":         s.has_followup,
        "is_dropout":           s.is_dropout,
        "usage_frequency":      s.usage_frequency,
        "joined_with_pain":     s.joined_with_pain,
        "pain_improved":        s.pain_improved,
        "pain_location":        s.pain_location,
        "pre_vas":              _v(s.pre_vas),
        "post_vas":             _v(s.post_vas),
        "pre_tug_s":            _v(s.pre_tug_s),
        "post_tug_s":           _v(s.post_tug_s),
        "pre_5xsst_s":          _v(s.pre_5xsst_s),
        "post_5xsst_s":         _v(s.post_5xsst_s),
        "pre_normal_gs_ms":     _v(s.pre_normal_gs_ms),
        "post_normal_gs_ms":    _v(s.post_normal_gs_ms),
        "pre_fast_gs_ms":       _v(s.pre_fast_gs_ms),
        "post_fast_gs_ms":      _v(s.post_fast_gs_ms),
        "baseline_sppb":        s.baseline_sppb,
        "post_sppb":            s.post_sppb,
        "composite_improvement": _v(s.composite_improvement),
        "overall_responder":    s.overall_responder,
    }


def _build_timeline_dict(patient: Patient, db: DBSession) -> dict:
    """Build the timeline payload that InsightService passes to Claude."""
    sessions = (
        db.query(ClinicalSession)
        .filter_by(patient_id=patient.id)
        .order_by(ClinicalSession.session_number.asc())
        .all()
    )
    trends = db.query(PatientTrend).filter_by(patient_id=patient.id).all()
    return {
        "patient": {
            "sn":                patient.sn,
            "name":              patient.name,
            "age":               patient.age,
            "gender":            patient.gender,
            "cohort":            patient.cohort,
            "primary_indication": patient.primary_indication,
        },
        "sessions": [_session_to_dict(s) for s in sessions],
        "trends":   [_trend_to_dict(t) for t in trends],
    }


@router.post("/patient/{sn}/session", status_code=201)
def create_session(
    sn: str,
    payload: NewSessionRequest,
    db: DBSession = Depends(get_db),
) -> dict:
    """Create a new session for an existing patient.

    Automatically assigns the next session_number (max existing + 1).
    Computes and persists trend signals within the same transaction.
    Returns the new session_number and updated trends.
    """
    _check_db_ready()

    patient = db.query(Patient).filter_by(sn=sn).first()
    if patient is None:
        raise HTTPException(status_code=404, detail=f"Patient sn={sn!r} not found")

    max_sn = (
        db.query(func.max(ClinicalSession.session_number))
        .filter_by(patient_id=patient.id)
        .scalar()
    ) or 0
    new_sn = max_sn + 1

    session = ClinicalSession(
        id=uuid.uuid4(),
        patient_id=patient.id,
        session_number=new_sn,
        **payload.model_dump(),
    )
    db.add(session)
    db.flush()

    trends = TrendEngine(db).compute_and_save(patient.id)
    db.commit()  # commit session + trends before calling external API

    timeline = _build_timeline_dict(patient, db)
    insight_text = InsightService(db).generate_session_insight(
        timeline, patient.id, new_sn
    )
    db.commit()  # commit PatientInsight row

    return {
        "sn":             sn,
        "session_number": new_sn,
        "trends":         [_trend_to_dict(t) for t in trends],
        "insight":        insight_text,
    }


@router.get("/patient/{sn}/timeline")
def get_timeline(
    sn: str,
    db: DBSession = Depends(get_db),
) -> dict:
    """Return the full longitudinal history and current trends for a patient.

    This is the primary payload consumed by the AI reasoning layer (Sub-project 3).
    Sessions are ordered by session_number ascending.
    """
    _check_db_ready()

    patient = db.query(Patient).filter_by(sn=sn).first()
    if patient is None:
        raise HTTPException(status_code=404, detail=f"Patient sn={sn!r} not found")

    sessions = (
        db.query(ClinicalSession)
        .filter_by(patient_id=patient.id)
        .order_by(ClinicalSession.session_number.asc())
        .all()
    )

    trends = (
        db.query(PatientTrend)
        .filter_by(patient_id=patient.id)
        .all()
    )

    return {
        "patient": {
            "sn":                patient.sn,
            "name":              patient.name,
            "age":               patient.age,
            "gender":            patient.gender,
            "cohort":            patient.cohort,
            "primary_indication": patient.primary_indication,
        },
        "sessions": [_session_to_dict(s) for s in sessions],
        "trends":   [_trend_to_dict(t) for t in trends],
    }
