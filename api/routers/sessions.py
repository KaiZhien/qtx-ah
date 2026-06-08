"""Session creation and patient timeline endpoints."""
from __future__ import annotations

import logging
import uuid
from datetime import date
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session as DBSession

import deps
from db import get_db
from models.clinical import Patient, Session as ClinicalSession, PatientTrend, PatientInsight
from services.anomaly import AnomalyDetector
from services.trend import TrendEngine
from services.insight import InsightService
from services.prediction import PredictionService
from services.retrain import RetrainService
from services.calibration import CalibrationService
from services.wearable_features import get_patient_features as _get_wearable_features

logger = logging.getLogger(__name__)

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
        "vas_change":           _v(s.vas_change),
        "pre_tug_s":            _v(s.pre_tug_s),
        "post_tug_s":           _v(s.post_tug_s),
        "tug_change_pct":       _v(s.tug_change_pct),
        "pre_5xsst_s":          _v(s.pre_5xsst_s),
        "post_5xsst_s":         _v(s.post_5xsst_s),
        "sst_change_pct":       _v(s.sst_change_pct),
        "pre_normal_gs_ms":     _v(s.pre_normal_gs_ms),
        "post_normal_gs_ms":    _v(s.post_normal_gs_ms),
        "normal_gs_change_pct": _v(s.normal_gs_change_pct),
        "pre_fast_gs_ms":       _v(s.pre_fast_gs_ms),
        "post_fast_gs_ms":      _v(s.post_fast_gs_ms),
        "fast_gs_change_pct":   _v(s.fast_gs_change_pct),
        "baseline_sppb":        s.baseline_sppb,
        "post_sppb":            s.post_sppb,
        "sppb_change":          s.sppb_change,
        "post_tandem_s":        _v(s.post_tandem_s),
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
            "age_band":          patient.age_band,
            "gender":            patient.gender,
            "cohort":            patient.cohort,
            "primary_indication": patient.primary_indication,
            "baseline_sppb":     patient.baseline_sppb,
            "pre_tandem_s":      float(patient.pre_tandem_s) if patient.pre_tandem_s is not None else None,
            # Key phenotype flags for RAISE-validated response patterns
            "has_frailty":       patient.has_frailty,
            "has_diabetes":      patient.has_diabetes,
            "has_neurological":  patient.has_neurological,
            "has_stroke":        patient.has_stroke,
            "has_parkinsons":    patient.has_parkinsons,
        },
        "sessions": [_session_to_dict(s) for s in sessions],
        "trends":   [_trend_to_dict(t) for t in trends],
    }


@router.post("/patient/{sn}/session", status_code=201)
def create_session(
    sn: str,
    payload: NewSessionRequest,
    background_tasks: BackgroundTasks,
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

    predictions = None
    if deps.models:
        predictions = PredictionService(db, deps.models).run(patient, session)
        db.commit()  # commit SessionPrediction row

    wearable_feats: dict = {}
    try:
        wearable_feats = _get_wearable_features(str(patient.id), db)
    except Exception as exc:
        logger.warning("Wearable feature fetch failed: %s", exc)

    timeline = _build_timeline_dict(patient, db)
    timeline["wearable"] = {
        "cadence_avg_30d": wearable_feats.get("wearable_cadence_avg_30d"),
        "steps_avg_7d": wearable_feats.get("wearable_steps_30d_avg"),
    }
    insight_text = InsightService(db).generate_session_insight(
        timeline, patient.id, new_sn, predictions=predictions
    )
    db.commit()  # commit PatientInsight row

    # Step 3 — anomaly detection (non-blocking)
    try:
        AnomalyDetector(db).check_and_warn(
            patient, session, trends, predictions, new_sn,
            wearable_feats=wearable_feats,
        )
        db.commit()
    except Exception as exc:
        logger.warning("Anomaly detection failed: %s", exc)

    # Non-blocking retrain trigger — queues background task when threshold met
    try:
        session_count = db.query(func.count(ClinicalSession.id)).scalar() or 0
        RetrainService().check_and_trigger(session_count, background_tasks)
        CalibrationService.check_and_trigger(db, background_tasks)
    except Exception as exc:
        logger.warning("Retrain trigger failed: %s", exc)

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
            "age_band":          patient.age_band,
            "gender":            patient.gender,
            "cohort":            patient.cohort,
            "primary_indication": patient.primary_indication,
            "baseline_sppb":     patient.baseline_sppb,
            "pre_tandem_s":      float(patient.pre_tandem_s) if patient.pre_tandem_s is not None else None,
            "has_frailty":       patient.has_frailty,
            "has_diabetes":      patient.has_diabetes,
            "has_neurological":  patient.has_neurological,
            "has_stroke":        patient.has_stroke,
            "has_parkinsons":    patient.has_parkinsons,
        },
        "sessions": [_session_to_dict(s) for s in sessions],
        "trends":   [_trend_to_dict(t) for t in trends],
    }


@router.get("/patient/{sn}/predictions/latest")
def get_latest_predictions(
    sn: str,
    db: DBSession = Depends(get_db),
) -> dict:
    """Return the most recent SessionPrediction row for a patient, or {} if none exists."""
    _check_db_ready()

    from models.clinical import SessionPrediction

    patient = db.query(Patient).filter_by(sn=sn).first()
    if patient is None:
        raise HTTPException(status_code=404, detail=f"Patient sn={sn!r} not found")

    row = (
        db.query(SessionPrediction)
        .filter_by(patient_id=patient.id)
        .order_by(SessionPrediction.predicted_at.desc())
        .first()
    )
    if row is None:
        return {}

    def _fv(v):
        return float(v) if v is not None else None

    return {
        "predicted_composite_improvement": _fv(row.predicted_composite_improvement),
        "responder_probability":           _fv(row.responder_probability),
        "dropout_probability":             _fv(row.dropout_probability),
        "dosage_recommendation":           row.dosage_recommendation,
        "predicted_at":                    row.predicted_at.isoformat() if row.predicted_at else None,
        "shap_top5":                       row.shap_top5,
        "bias_correction":                 float(row.bias_correction) if row.bias_correction is not None else None,
    }
