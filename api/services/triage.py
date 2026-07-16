"""Clinician triage rollup — cross-patient attention worklist.

Pure aggregation: a few flat queries assembled in Python (house style — no SQL
views/CTEs). Returns the triage envelope for GET /api/triage. Read-only.

A patient appears in the worklist iff at least one signal is active:
  * anomaly     — latest `anomaly_warning` insight, but only if it is on the
                  patient's most-recent session (older warnings age out).
  * declining   — every `PatientTrend` row with direction == 'declining'.
  * divergence  — |actual - predicted| >= threshold on the latest session.
"""
from __future__ import annotations

import os
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy.orm import Session as DBSession

from models.clinical import (
    Patient,
    Session,
    PatientTrend,
    PatientInsight,
    SessionPrediction,
)

_DEFAULT_DIVERGENCE_THRESHOLD = 0.15


def _to_float(value):
    """Coerce a Numeric/Decimal column (or None) to a plain float/None."""
    if value is None:
        return None
    return float(value)


def _divergence_threshold() -> float:
    """Read QTX_TRIAGE_DIVERGENCE_THRESHOLD at request time; default 0.15.

    Falls back to the default when the var is unset OR empty.
    """
    raw = os.environ.get("QTX_TRIAGE_DIVERGENCE_THRESHOLD", "").strip()
    return float(raw) if raw else _DEFAULT_DIVERGENCE_THRESHOLD


def build_triage(db: DBSession) -> dict:
    """Assemble the triage worklist envelope from the current DB state."""
    threshold = _divergence_threshold()

    patients = db.query(Patient).all()

    # ── Latest session per patient (max session_number) ───────────────────────
    latest_session: dict = {}
    for s in db.query(Session).all():
        cur = latest_session.get(s.patient_id)
        if cur is None or s.session_number > cur.session_number:
            latest_session[s.patient_id] = s

    # ── Latest prediction per latest-session id (by predicted_at) ─────────────
    latest_session_ids = {s.id for s in latest_session.values()}
    latest_pred_by_session: dict = {}
    if latest_session_ids:
        preds = (
            db.query(SessionPrediction)
            .filter(SessionPrediction.session_id.in_(latest_session_ids))
            .all()
        )
        for p in preds:
            cur = latest_pred_by_session.get(p.session_id)
            if cur is None or p.predicted_at > cur.predicted_at:
                latest_pred_by_session[p.session_id] = p

    # ── Declining trends per patient ──────────────────────────────────────────
    declining_by_patient: dict = defaultdict(list)
    for t in db.query(PatientTrend).filter(PatientTrend.direction == "declining").all():
        declining_by_patient[t.patient_id].append(t)

    # ── Latest active-candidate anomaly per patient ───────────────────────────
    # Exclude api_error rows and NULL-session rows (defensive: NULL never
    # matches a max session_number anyway). Order: session_number desc,
    # created_at desc; take the first seen per patient.
    latest_anomaly: dict = {}
    anomalies = (
        db.query(PatientInsight)
        .filter(
            PatientInsight.insight_type == "anomaly_warning",
            PatientInsight.model != "api_error",
            PatientInsight.session_number.isnot(None),
        )
        .order_by(
            PatientInsight.session_number.desc(),
            PatientInsight.created_at.desc(),
        )
        .all()
    )
    for a in anomalies:
        if a.patient_id not in latest_anomaly:
            latest_anomaly[a.patient_id] = a

    # ── Assemble one entry per patient with at least one active signal ────────
    entries: list = []  # (sort_key, item)
    for patient in patients:
        session = latest_session.get(patient.id)
        max_session_number = session.session_number if session is not None else None

        # Anomaly signal: active only on the patient's latest session.
        anomaly_signal = None
        a = latest_anomaly.get(patient.id)
        if (
            a is not None
            and max_session_number is not None
            and a.session_number == max_session_number
        ):
            anomaly_signal = {
                "session_number": a.session_number,
                "content": a.content,
                "created_at": a.created_at.isoformat(),
            }

        # Declining trends: all declining rows (sorted by metric for determinism).
        declining_trends = [
            {
                "metric": t.metric,
                "magnitude": _to_float(t.magnitude),
                "sessions_used": t.sessions_used,
            }
            for t in sorted(
                declining_by_patient.get(patient.id, []), key=lambda r: r.metric
            )
        ]

        # Divergence: latest session only, both values present, |delta| >= thr.
        divergence_signal = None
        if session is not None:
            actual = _to_float(session.composite_improvement)
            pred = latest_pred_by_session.get(session.id)
            predicted = (
                _to_float(pred.predicted_composite_improvement)
                if pred is not None
                else None
            )
            if actual is not None and predicted is not None:
                delta = round(abs(actual - predicted), 4)
                if delta >= threshold:
                    divergence_signal = {
                        "session_number": session.session_number,
                        "predicted": predicted,
                        "actual": actual,
                        "delta": delta,
                    }

        signal_count = (
            (1 if anomaly_signal is not None else 0)
            + (1 if declining_trends else 0)
            + (1 if divergence_signal is not None else 0)
        )
        if signal_count == 0:
            continue

        last_date = session.session_date if session is not None else None

        item = {
            "sn": patient.sn,
            "name": patient.name,
            "last_session_number": max_session_number,
            "last_session_date": last_date.isoformat() if last_date is not None else None,
            "signals": {
                "anomaly": anomaly_signal,
                "declining_trends": declining_trends,
                "divergence": divergence_signal,
            },
        }

        # Sort key (all ascending; invert to get the required descending orders):
        #   1. anomaly-bearing first
        #   2. active signal-type count descending
        #   3. last_session_date descending, nulls last
        #   4. sn ascending (tie-break for determinism)
        date_key = (0, -last_date.toordinal()) if last_date is not None else (1, 0)
        sort_key = (
            0 if anomaly_signal is not None else 1,
            -signal_count,
            date_key,
            patient.sn,
        )
        entries.append((sort_key, item))

    entries.sort(key=lambda e: e[0])
    items = [item for _, item in entries]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total": len(items),
        "items": items,
    }
