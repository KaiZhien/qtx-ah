"""Anomaly detection service for post-session clinical flag evaluation.

AnomalyDetector evaluates four rules against the latest session data,
trend signals, and ML predictions. When flags fire, it calls Claude to
produce a brief clinical warning and persists the result as a
PatientInsight row with insight_type="anomaly_warning".

Stub mode: if ANTHROPIC_API_KEY is not set and flags fire, a placeholder
string is persisted with model="stub". No exception is raised.

No flags: check_and_warn returns None immediately; no DB write, no Claude call.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session as DBSession

from models.clinical import PatientInsight
from services.claude_client import call_claude as _call_claude_fn
from services.insight import _SYSTEM_PROMPT
from services.trend import TrendResult

if TYPE_CHECKING:
    from models.clinical import Patient, Session as ClinicalSession

logger = logging.getLogger(__name__)

_SEDENTARY_RISK_THRESHOLD = 80.0   # % of day sedentary (30d rolling avg)

_WARNING_TEMPLATE = """\
Anomaly flags detected after session {session_number}:
{flag_list}

Session measurements: pre_tug={pre_tug_s}, post_tug={post_tug_s},
pre_vas={pre_vas}, post_vas={post_vas},
composite_improvement={composite_improvement},
responder_probability={responder_probability},
dropout_probability={dropout_probability}.{cadence_line}

In 2-3 sentences, explain what these flags mean clinically and what the \
treating physiotherapist should monitor or investigate at the next session. \
Be specific to the flags listed above."""


class AnomalyDetector:
    STUB_RESPONSE = "[Anomaly detection unavailable — ANTHROPIC_API_KEY not configured]"
    MODEL = "claude-sonnet-4-6"

    def __init__(self, db: DBSession) -> None:
        self._db = db
        self._api_key = os.environ.get("ANTHROPIC_API_KEY")

    # ------------------------------------------------------------------
    # Pure rule evaluation — no I/O
    # ------------------------------------------------------------------

    def _detect_flags(
        self,
        patient: "Patient",
        session: "ClinicalSession",
        trends: list[TrendResult],
        predictions: dict | None,
        wearable_feats: dict | None = None,
    ) -> list[str]:
        """Evaluate all anomaly rules and return a list of flag strings.

        This is a pure function: it reads arguments only and performs no I/O.
        """
        flags: list[str] = []

        # Rule 1: metric_declining
        for trend in trends:
            if trend.direction == "declining":
                flags.append(f"metric_declining:{trend.metric}")

        # Rule 2: pain_worsened — clinical threshold is a 1.0-point increase
        if session.post_vas is not None and session.pre_vas is not None:
            if float(session.post_vas) > float(session.pre_vas) + 1.0:
                flags.append("pain_worsened")

        # Rule 3: responder_mismatch
        if (
            session.composite_improvement is not None
            and float(session.composite_improvement) < 0
            and predictions is not None
            and float(predictions.get("responder_probability", 0)) > 0.5
        ):
            flags.append("responder_mismatch")

        # Rule 4: high_dropout_risk
        if (
            predictions is not None
            and float(predictions.get("dropout_probability", 0)) > 0.75
        ):
            flags.append("high_dropout_risk")

        # Rule 5: fall_risk_unregistered
        if (
            session.post_tug_s is not None
            and float(session.post_tug_s) > 12.0
            and patient.has_fall_risk is False
        ):
            flags.append("fall_risk_unregistered")

        # Rule 6: low_cadence_risk (wearable)
        if wearable_feats is not None:
            cadence = wearable_feats.get("wearable_cadence_avg_30d")
            if cadence is not None and cadence < 80.0:
                flags.append("low_cadence_risk")

        # Rule 7: high_sedentary_risk
        if wearable_feats is not None:
            sedentary_pct = wearable_feats.get("wearable_sedentary_pct_30d")
            if sedentary_pct is not None and sedentary_pct > _SEDENTARY_RISK_THRESHOLD:
                flags.append("high_sedentary_risk")

        # Rule 8: fall_event_recorded
        if wearable_feats is not None:
            fall_count = wearable_feats.get("wearable_fall_events_90d")
            if fall_count is not None and int(fall_count) > 0:
                flags.append("fall_event_recorded")

        return flags

    # ------------------------------------------------------------------
    # Prompt construction
    # ------------------------------------------------------------------

    def _build_warning_prompt(
        self,
        flags: list[str],
        session: "ClinicalSession",
        predictions: dict | None,
        session_number: int,
        wearable_feats: dict | None = None,
    ) -> str:
        """Format the Claude user message for anomaly warning generation."""
        def _fmt(val, unit=""):
            return f"{val}{unit}" if val is not None else "N/A"

        flag_list = "\n".join(f"- {f}" for f in flags)
        responder_probability = (
            predictions.get("responder_probability") if predictions else None
        )
        dropout_probability = (
            predictions.get("dropout_probability") if predictions else None
        )
        cadence = wearable_feats.get("wearable_cadence_avg_30d") if wearable_feats else None
        cadence_line = f"\ncadence_avg_30d={_fmt(cadence, ' steps/min')}," if cadence is not None else ""
        return _WARNING_TEMPLATE.format(
            session_number=session_number,
            flag_list=flag_list,
            pre_tug_s=_fmt(session.pre_tug_s, "s"),
            post_tug_s=_fmt(session.post_tug_s, "s"),
            pre_vas=_fmt(session.pre_vas),
            post_vas=_fmt(session.post_vas),
            composite_improvement=_fmt(session.composite_improvement),
            responder_probability=_fmt(responder_probability),
            dropout_probability=_fmt(dropout_probability),
            cadence_line=cadence_line,
        )

    # ------------------------------------------------------------------
    # Claude call — delegates to shared client helper
    # ------------------------------------------------------------------

    def _call_claude(self, user_message: str) -> str:
        """Call the Anthropic API and return the text response."""
        return _call_claude_fn(user_message, _SYSTEM_PROMPT, max_tokens=256)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _save_warning(
        self,
        patient_id: uuid.UUID,
        content: str,
        session_number: int,
        model: str,
    ) -> None:
        """Persist a PatientInsight row with insight_type="anomaly_warning"."""
        row = PatientInsight(
            id=uuid.uuid4(),
            patient_id=patient_id,
            session_number=session_number,
            insight_type="anomaly_warning",
            question=None,
            content=content,
            model=model,
            created_at=datetime.now(timezone.utc),
            embedding=None,
        )
        self._db.add(row)
        self._db.flush()

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def check_and_warn(
        self,
        patient: "Patient",
        session: "ClinicalSession",
        trends: list[TrendResult],
        predictions: dict | None,
        session_number: int,
        wearable_feats: dict | None = None,
    ) -> str | None:
        """Evaluate anomaly rules and, if flags fire, generate a clinical warning.

        Returns:
            The warning text (str) when flags fired and content was generated.
            None when no flags fired — no DB write, no Claude call.

        Must be called inside an open transaction — caller commits or rolls back.
        """
        flags = self._detect_flags(patient, session, trends, predictions, wearable_feats)
        if not flags:
            return None

        # Stub mode: persist placeholder and return without calling Claude
        if not self._api_key:
            self._save_warning(
                patient_id=patient.id,
                content=self.STUB_RESPONSE,
                session_number=session_number,
                model="stub",
            )
            return self.STUB_RESPONSE

        user_message = self._build_warning_prompt(flags, session, predictions, session_number, wearable_feats)
        try:
            content = self._call_claude(user_message)
            model = self.MODEL
        except Exception as exc:
            logger.warning("AnomalyDetector Claude call failed: %s", exc)
            content = self.STUB_RESPONSE
            model = "api_error"

        self._save_warning(
            patient_id=patient.id,
            content=content,
            session_number=session_number,
            model=model,
        )
        return content
