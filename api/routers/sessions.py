"""Session creation and patient timeline endpoints."""
from __future__ import annotations

import logging
import uuid
from datetime import date

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session as DBSession

import deps
from db import get_db
from models.clinical import Patient, Session as ClinicalSession, PatientTrend
from services.anomaly import AnomalyDetector
from services.trend import TrendEngine
from services.insight import InsightService
from services.prediction import PredictionService
from services.rate_limit import rate_limit
from services.retrain import RetrainService
from services.calibration import CalibrationService
from services.timeline import build_timeline_dict, session_to_dict, trend_to_dict
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


# Serialisation helpers are shared with routers/ask.py and routers/plan.py —
# see services/timeline.py. The local names are kept for test/back-compat.
_trend_to_dict = trend_to_dict


def _session_to_dict(s: ClinicalSession) -> dict:
    return session_to_dict(s, variant="session")


def _build_timeline_dict(patient: Patient, db: DBSession) -> dict:
    """Build the timeline payload that InsightService passes to Claude."""
    return build_timeline_dict(patient, db, variant="session")


def _generate_session_ai(
    db: DBSession,
    patient_id: uuid.UUID,
    session_id: uuid.UUID,
    session_number: int,
    predictions: dict | None,
    trends: list,
) -> None:
    """Background task: generate the session insight and anomaly warning.

    Runs after the HTTP response is sent (FastAPI BackgroundTasks), so a slow
    or failing Claude/Voyage/Terra call can never fail or delay session
    creation. Each stage commits independently and swallows its own errors:
    the session + prediction rows are already committed by the request
    handler, the insight row commits on its own, and the anomaly row commits
    on its own.

    The request-scoped Session object is reused here; FastAPI closes it during
    dependency teardown before background tasks run, but a closed SQLAlchemy
    Session is reusable and transparently re-connects (rows are re-fetched by
    primary key below).
    """
    try:
        patient = db.get(Patient, patient_id)
        session = db.get(ClinicalSession, session_id)
        if patient is None or session is None:
            logger.warning(
                "Post-session AI skipped — rows not found (patient=%s session=%s)",
                patient_id, session_id,
            )
            return

        wearable_feats: dict = {}
        try:
            wearable_feats = _get_wearable_features(patient.id, db) or {}
        except Exception as exc:
            logger.warning("Wearable feature fetch failed: %s", exc)

        # Insight generation — commits independently. InsightService itself
        # persists a model="api_error" row when Claude is unreachable.
        try:
            timeline = _build_timeline_dict(patient, db)
            timeline["wearable"] = {
                "cadence_avg_30d": wearable_feats.get("wearable_cadence_avg_30d"),
                "steps_avg_7d": wearable_feats.get("wearable_steps_30d_avg"),
            }
            InsightService(db).generate_session_insight(
                timeline, patient.id, session_number, predictions=predictions
            )
            db.commit()
        except Exception as exc:
            logger.warning("Insight generation failed: %s", exc)
            db.rollback()

        # Anomaly detection — commits independently.
        try:
            AnomalyDetector(db).check_and_warn(
                patient, session, trends, predictions, session_number,
                wearable_feats=wearable_feats,
            )
            db.commit()
        except Exception as exc:
            logger.warning("Anomaly detection failed: %s", exc)
            db.rollback()
    except Exception as exc:
        logger.warning("Post-session AI task failed: %s", exc)
    finally:
        db.close()


@router.post(
    "/patient/{sn}/session",
    status_code=201,
    dependencies=[Depends(rate_limit("session"))],
)
def create_session(
    sn: str,
    payload: NewSessionRequest,
    background_tasks: BackgroundTasks,
    db: DBSession = Depends(get_db),
) -> dict:
    """Create a new session for an existing patient.

    Automatically assigns the next session_number (max existing + 1).
    Session, trends and ML prediction are persisted in a single transaction;
    AI insight + anomaly generation run as a background task after the
    response is sent (the web UI re-fetches insights via GET
    /patient/{sn}/insights, so nothing blocks on Claude). The response's
    "insight" field is therefore null with insight_status="scheduled".
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

    # ML prediction joins the same transaction; a model failure is rolled
    # back to the savepoint and never blocks session creation.
    predictions = None
    if deps.models:
        try:
            with db.begin_nested():
                predictions = PredictionService(db, deps.models).run(patient, session)
        except Exception as exc:
            logger.warning("Prediction failed for sn=%s session=%d: %s", sn, new_sn, exc)
            predictions = None

    patient_id, session_id = patient.id, session.id
    db.commit()  # single atomic commit: session + trends + prediction

    # AI generation (Claude insight + anomaly warning) is deferred until after
    # the response is sent — a Claude outage can never fail this request.
    background_tasks.add_task(
        _generate_session_ai, db, patient_id, session_id, new_sn, predictions, trends,
    )

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
        "insight":        None,
        "insight_status": "scheduled",
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
