"""Shared timeline payload builder for Claude prompt construction.

This is the single implementation behind the per-router _build_timeline_dict
helpers that were previously copy-pasted in routers/sessions.py, routers/ask.py
and routers/plan.py. The three call sites genuinely use different field sets,
so the builder is parameterized by ``variant``:

  - "session"  (POST /patient/{sn}/session insight generation + GET timeline):
      full gait key names (pre_normal_gs_ms, ...), pain detail flags
      (has_followup, joined_with_pain, pain_improved, pain_location), notes.
  - "ask"      (POST /ask, POST /prepare_session):
      short gait key names (pre_normal_gs, ...), notes, no pain detail flags.
  - "plan"     (POST /suggest_plan):
      like "ask" but without notes, and an extended patient phenotype block
      (has_fall_risk/has_oa/... instead of pre_tandem_s/has_parkinsons).

Field sets are behavior-preserving with the pre-consolidation code — see
tests/test_timeline_builder.py which pins them exactly.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session as DBSession

from models.clinical import Patient, PatientTrend, Session as ClinicalSession

_VARIANTS = ("session", "ask", "plan")


def _v(val: Any) -> Any:
    """Convert SQLAlchemy Numeric values to float; pass everything else through."""
    if val is None:
        return None
    if hasattr(val, "__float__"):
        return float(val)
    return val


def trend_to_dict(t: Any) -> dict:
    """Serialise a TrendResult or PatientTrend ORM row to a plain dict."""
    return {
        "metric":        t.metric,
        "direction":     t.direction,
        "sessions_used": t.sessions_used,
        "magnitude":     float(t.magnitude) if t.magnitude is not None else None,
        "first_value":   float(t.first_value) if t.first_value is not None else None,
        "last_value":    float(t.last_value) if t.last_value is not None else None,
    }


def session_to_dict(s: ClinicalSession, variant: str = "session") -> dict:
    """Serialise a Session ORM row for the given timeline variant."""
    if variant not in _VARIANTS:
        raise ValueError(f"Unknown timeline variant: {variant!r}")

    d: dict = {
        "session_number":  s.session_number,
        "session_date":    s.session_date.isoformat() if s.session_date else None,
        "usage_frequency": s.usage_frequency,
    }
    if variant in ("session", "ask"):
        d["notes"] = s.notes
    if variant == "session":
        d["has_followup"]     = s.has_followup
        d["joined_with_pain"] = s.joined_with_pain
        d["pain_improved"]    = s.pain_improved
        d["pain_location"]    = s.pain_location

    # The create-session prompt historically used the full column names
    # (pre_normal_gs_ms); ask/plan used shortened ones (pre_normal_gs).
    gait = "_ms" if variant == "session" else ""
    d.update({
        "pre_vas":               _v(s.pre_vas),
        "post_vas":              _v(s.post_vas),
        "vas_change":            _v(s.vas_change),
        "pre_tug_s":             _v(s.pre_tug_s),
        "post_tug_s":            _v(s.post_tug_s),
        "tug_change_pct":        _v(s.tug_change_pct),
        "pre_5xsst_s":           _v(s.pre_5xsst_s),
        "post_5xsst_s":          _v(s.post_5xsst_s),
        "sst_change_pct":        _v(s.sst_change_pct),
        f"pre_normal_gs{gait}":  _v(s.pre_normal_gs_ms),
        f"post_normal_gs{gait}": _v(s.post_normal_gs_ms),
        "normal_gs_change_pct":  _v(s.normal_gs_change_pct),
        f"pre_fast_gs{gait}":    _v(s.pre_fast_gs_ms),
        f"post_fast_gs{gait}":   _v(s.post_fast_gs_ms),
        "fast_gs_change_pct":    _v(s.fast_gs_change_pct),
        "baseline_sppb":         s.baseline_sppb,
        "post_sppb":             s.post_sppb,
        "sppb_change":           s.sppb_change,
        "post_tandem_s":         _v(s.post_tandem_s),
        "composite_improvement": _v(s.composite_improvement),
        "overall_responder":     s.overall_responder,
        "is_dropout":            s.is_dropout,
    })
    return d


def _patient_to_dict(patient: Patient, variant: str) -> dict:
    d: dict = {
        "sn":                 patient.sn,
        "age":                patient.age,
        "age_band":           patient.age_band,
        "gender":             patient.gender,
        "cohort":             patient.cohort,
        "primary_indication": patient.primary_indication,
        "baseline_sppb":      patient.baseline_sppb,
    }
    if variant == "plan":
        d.update({
            "has_frailty":       patient.has_frailty,
            "has_diabetes":      patient.has_diabetes,
            "has_neurological":  patient.has_neurological,
            "has_stroke":        patient.has_stroke,
            "has_fall_risk":     patient.has_fall_risk,
            "has_oa":            patient.has_oa,
            "has_balance_issue": patient.has_balance_issue,
            "has_chronic_pain":  patient.has_chronic_pain,
            "has_knee_issue":    patient.has_knee_issue,
            "has_spinal_issue":  patient.has_spinal_issue,
        })
    else:
        d.update({
            "pre_tandem_s": float(patient.pre_tandem_s) if patient.pre_tandem_s is not None else None,
            # Key phenotype flags for RAISE-validated response patterns
            "has_frailty":      patient.has_frailty,
            "has_diabetes":     patient.has_diabetes,
            "has_neurological": patient.has_neurological,
            "has_stroke":       patient.has_stroke,
            "has_parkinsons":   patient.has_parkinsons,
        })
    return d


def build_timeline_dict(patient: Patient, db: DBSession, variant: str = "session") -> dict:
    """Build the timeline payload that InsightService passes to Claude."""
    if variant not in _VARIANTS:
        raise ValueError(f"Unknown timeline variant: {variant!r}")

    sessions = (
        db.query(ClinicalSession)
        .filter_by(patient_id=patient.id)
        .order_by(ClinicalSession.session_number.asc())
        .all()
    )
    trends = db.query(PatientTrend).filter_by(patient_id=patient.id).all()
    return {
        "patient":  _patient_to_dict(patient, variant),
        "sessions": [session_to_dict(s, variant) for s in sessions],
        "trends":   [trend_to_dict(t) for t in trends],
    }
