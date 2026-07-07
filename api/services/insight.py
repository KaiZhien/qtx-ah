"""AI insight generation service using Anthropic Claude.

InsightService builds prompts from patient timeline data, calls
claude-sonnet-4-6, and persists the generated text in patient_insights.

Stub mode: if ANTHROPIC_API_KEY is not set, returns a placeholder string
and saves a row with model="stub". No exception is raised.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session as DBSession

logger = logging.getLogger(__name__)

from models.clinical import PatientInsight
from services.claude_client import call_claude as _call_claude_fn
from services.voyage import VoyageEmbedder

_SYSTEM_PROMPT = (
    "You are a clinical physiotherapy assistant reviewing longitudinal data for a single patient. "
    "Reason only from the data provided. Do not compare this patient to others. "
    "Be concise and clinically relevant. Never speculate beyond what the data supports. "
    "Where model predictions are provided, reference them explicitly — flag when actual "
    "measurements diverge significantly from what was predicted. "
    "Clinical reference thresholds (apply when interpreting session data): "
    "TUG MCID = 3.5 s, fall-risk flag > 12 s; "
    "5xSTS MCID = 2.3 s; "
    "Gait speed frailty threshold < 0.6 m/s; "
    "VAS pain MCID = 1.5–2 points (0–10 scale); "
    "SPPB MCID = 1 point. "
    "Population-level response patterns (RAISE multi-centre validation, n=206, observational): "
    "Frail patients (has_frailty=true or baseline SPPB ≤8) show ~5× greater SPPB improvement than higher-functioning patients — "
    "frame expectations accordingly and highlight even modest gains in this group as clinically meaningful. "
    "Diabetes (has_diabetes=true): diabetic patients showed significantly greater SPPB improvement (+1.25 pts, ANCOVA-adjusted p=0.015) "
    "— flag as likely high-responder and note if results diverge from this pattern. "
    "Dementia / cognitive impairment (has_neurological=true with dementia context): a non-significant directional decline "
    "was observed in this subgroup (n=29) — monitor closely and explicitly note any functional regression. "
    "Age response: 70–79-year-olds showed peak gait speed improvement (+0.194 m/s); 80+ patients still achieve meaningful SPPB gains "
    "(+0.418 pts) — advanced age alone is not a contraindication. "
    "SPPB ceiling: patients near SPPB 12 have limited improvement headroom — a stable score in this range is a positive finding, not a failure. "
    "Tandem Balance Score (post_tandem_s): improvement correlates with reduced fall risk — note direction of change if data present. "
    "Walking cadence (wearable, 30-day avg, if present): below 80 steps/min is associated with elevated fall risk — flag any value in this range."
)

_SESSION_SUMMARY_TEMPLATE = """\
Patient timeline data:
{timeline_json}

The patient just completed session {session_number}. In 3-5 bullet points, summarise:
1. Overall progress trajectory across all sessions
2. Notable changes in this session compared to prior sessions
3. Any measurements that warrant clinician attention"""

_QA_TEMPLATE = """\
Patient timeline data:
{timeline_json}

Clinician question: {question}

Answer the question in 2-4 sentences based only on this patient's data above."""

_PRE_SESSION_BRIEF_TEMPLATE = """\
Patient timeline data:
{timeline_json}

The patient is about to begin session {next_session_number}. Produce a pre-session briefing for the physiotherapist using EXACTLY this structure (include the bold headers verbatim):

**Last Session Summary** (2 sentences max) — what happened in the most recent session
**Current Trajectory** (2 sentences max) — which metrics are improving, plateauing, or declining
**Watch For Today** — 3 bullet points listing the most important things to observe in today's session
**Suggested Questions** — 2 bullet points listing specific questions to ask the patient at session start

Be concise. Base every statement only on the data provided."""

_TREATMENT_PLAN_TEMPLATE = """\
Patient phenotype and context:
{patient_json}

Session timeline and trends:
{timeline_json}

ML prediction signals:
{predictions_json}

{focus_line}Generate a {plan_sessions}-session treatment plan using EXACTLY this structure (include the bold headers verbatim):

**Session Focus:** [one sentence describing the overarching rehabilitation goal for this plan]

**Session-by-Session Plan:**
{session_bullets}

**Key Metrics to Monitor:**
- [metric] — target: [MCID-based value or directional goal]
- [metric] — target: [MCID-based value or directional goal]
- [metric] — target: [MCID-based value or directional goal]

**Risk Flags:**
- [phenotype-specific caution or contraindication]
- [phenotype-specific caution or contraindication]

**Dosage Recommendation:** [from model signal or clinical judgement if unavailable]

Base every recommendation on the patient data and ML signals provided. Reference MCID thresholds where applicable."""


def _format_predictions(predictions: dict) -> dict:
    """Format model prediction dict for inclusion in timeline JSON sent to Claude."""
    result: dict = {}
    pci = predictions.get("predicted_composite_improvement")
    if pci is not None:
        result["predicted_composite_improvement"] = round(float(pci), 2)
    rp = predictions.get("responder_probability")
    if rp is not None:
        result["responder_probability"] = round(float(rp), 2)
    dp = predictions.get("dropout_probability")
    if dp is not None:
        result["dropout_risk"] = f"{'HIGH' if dp > 0.5 else 'LOW'} ({dp:.2f})"
    dr = predictions.get("dosage_recommendation")
    if dr is not None:
        result["dosage_recommendation"] = dr
    return result


class InsightService:
    STUB_RESPONSE = "[AI insights unavailable — ANTHROPIC_API_KEY not configured]"
    MODEL = "claude-sonnet-4-6"

    def __init__(self, db: DBSession) -> None:
        self._db = db
        self._api_key = os.environ.get("ANTHROPIC_API_KEY")

    def _call_claude(self, user_message: str) -> str:
        """Call the Anthropic API and return the text response."""
        return _call_claude_fn(user_message, _SYSTEM_PROMPT, max_tokens=1024)

    def _save_insight(
        self,
        patient_id: uuid.UUID,
        content: str,
        model: str,
        insight_type: str,
        session_number: int | None = None,
        question: str | None = None,
        embedding: list[float] | None = None,
    ) -> None:
        row = PatientInsight(
            id=uuid.uuid4(),
            patient_id=patient_id,
            session_number=session_number,
            insight_type=insight_type,
            question=question,
            content=content,
            model=model,
            created_at=datetime.now(timezone.utc),
            embedding=embedding,
        )
        self._db.add(row)
        self._db.flush()

    def _retrieve_relevant(
        self,
        patient_id: uuid.UUID,
        question: str,
        k: int = 5,
    ) -> list[PatientInsight]:
        embedding = VoyageEmbedder().embed(question, input_type="query")
        if embedding is None:
            return []
        try:
            rows = (
                self._db.query(PatientInsight)
                .filter(PatientInsight.patient_id == patient_id)
                .filter(PatientInsight.embedding.isnot(None))
                .order_by(PatientInsight.embedding.op("<=>") (embedding))
                .limit(k)
                .all()
            )
            return rows
        except Exception as exc:
            logger.warning("_retrieve_relevant query failed: %s", exc)
            return []

    def generate_session_insight(
        self,
        timeline: dict,
        patient_id: uuid.UUID,
        session_number: int,
        predictions: dict | None = None,
    ) -> str:
        """Generate a session summary insight and persist it.

        Returns the generated text (or STUB_RESPONSE if no API key).
        Must be called inside an open transaction — caller commits.
        """
        if not self._api_key:
            self._save_insight(
                patient_id=patient_id,
                content=self.STUB_RESPONSE,
                model="stub",
                insight_type="session_summary",
                session_number=session_number,
            )
            return self.STUB_RESPONSE

        tl = dict(timeline)
        if predictions:
            tl["model_predictions"] = _format_predictions(predictions)
        user_message = _SESSION_SUMMARY_TEMPLATE.format(
            timeline_json=json.dumps(tl, indent=2),
            session_number=session_number,
        )
        try:
            content = self._call_claude(user_message)
        except Exception as exc:
            from fastapi import HTTPException
            raise HTTPException(status_code=502, detail="AI service unavailable") from exc

        embedding = VoyageEmbedder().embed(content, input_type="document")
        self._save_insight(
            patient_id=patient_id,
            content=content,
            model=self.MODEL,
            insight_type="session_summary",
            session_number=session_number,
            embedding=embedding,
        )
        return content

    def _get_latest_predictions(self, patient_id: uuid.UUID) -> dict | None:
        """Query the latest SessionPrediction row for a patient."""
        from models.clinical import SessionPrediction
        try:
            row = (
                self._db.query(SessionPrediction)
                .filter_by(patient_id=patient_id)
                .order_by(SessionPrediction.predicted_at.desc())
                .first()
            )
            if row is None:
                return None
            return {
                "predicted_composite_improvement": float(row.predicted_composite_improvement) if row.predicted_composite_improvement is not None else None,
                "responder_probability": float(row.responder_probability) if row.responder_probability is not None else None,
                "dropout_probability": float(row.dropout_probability) if row.dropout_probability is not None else None,
                "dosage_recommendation": row.dosage_recommendation,
            }
        except Exception as exc:
            logger.warning("_get_latest_predictions failed: %s", exc)
            return None

    def generate_pre_session_brief(
        self,
        timeline: dict,
        patient_id: uuid.UUID,
        session_number: int,
    ) -> str:
        """Generate a pre-session briefing and persist it.

        session_number is the latest completed session; the brief is framed
        around the upcoming (session_number + 1) session.
        Must be called inside an open transaction — caller commits.
        """
        if not self._api_key:
            self._save_insight(
                patient_id=patient_id,
                content=self.STUB_RESPONSE,
                model="stub",
                insight_type="pre_session_brief",
                session_number=session_number,
            )
            return self.STUB_RESPONSE

        user_message = _PRE_SESSION_BRIEF_TEMPLATE.format(
            timeline_json=json.dumps(timeline, indent=2),
            next_session_number=session_number + 1,
        )
        try:
            content = _call_claude_fn(user_message, _SYSTEM_PROMPT, max_tokens=512)
        except Exception as exc:
            from fastapi import HTTPException
            raise HTTPException(status_code=502, detail="AI service unavailable") from exc

        self._save_insight(
            patient_id=patient_id,
            content=content,
            model=self.MODEL,
            insight_type="pre_session_brief",
            session_number=session_number,
        )
        return content

    def generate_treatment_plan(
        self,
        timeline: dict,
        patient_id: uuid.UUID,
        predictions: dict | None = None,
        clinician_focus: str | None = None,
        plan_sessions: int = 4,
    ) -> str:
        """Generate a structured treatment plan and persist it.

        Returns the generated text (or STUB_RESPONSE if no API key).
        Must be called inside an open transaction — caller commits.
        """
        patient_data = timeline.get("patient", {})
        sessions_data = timeline.get("sessions", [])
        trends_data = timeline.get("trends", [])

        session_bullets = "\n".join(
            f"- Session {i}: [specific focus and exercises]"
            for i in range(1, plan_sessions + 1)
        )
        focus_line = f"Clinician focus: {clinician_focus}\n\n" if clinician_focus else ""

        predictions_payload = _format_predictions(predictions) if predictions else {}

        if not self._api_key:
            self._save_insight(
                patient_id=patient_id,
                content=self.STUB_RESPONSE,
                model="stub",
                insight_type="treatment_plan",
            )
            return self.STUB_RESPONSE

        user_message = _TREATMENT_PLAN_TEMPLATE.format(
            patient_json=json.dumps(patient_data, indent=2),
            timeline_json=json.dumps({"sessions": sessions_data, "trends": trends_data}, indent=2),
            predictions_json=json.dumps(predictions_payload, indent=2),
            focus_line=focus_line,
            plan_sessions=plan_sessions,
            session_bullets=session_bullets,
        )
        try:
            content = _call_claude_fn(user_message, _SYSTEM_PROMPT, max_tokens=1500)
        except Exception as exc:
            from fastapi import HTTPException
            raise HTTPException(status_code=502, detail="AI service unavailable") from exc

        self._save_insight(
            patient_id=patient_id,
            content=content,
            model=self.MODEL,
            insight_type="treatment_plan",
        )
        return content

    def answer_question(
        self,
        timeline: dict,
        patient_id: uuid.UUID,
        question: str,
    ) -> str:
        """Answer a clinician question and persist the response.

        Returns the generated text (or STUB_RESPONSE if no API key).
        Must be called inside an open transaction — caller commits.
        """
        if not self._api_key:
            self._save_insight(
                patient_id=patient_id,
                content=self.STUB_RESPONSE,
                model="stub",
                insight_type="qa_response",
                question=question,
            )
            return self.STUB_RESPONSE

        predictions = self._get_latest_predictions(patient_id)

        relevant = self._retrieve_relevant(patient_id, question)

        if relevant:
            insight_lines = "\n".join(
                f"- [{r.insight_type}, {r.created_at.date()}] {r.content}"
                for r in relevant
            )
            tl = dict(timeline)
            if predictions:
                tl["model_predictions"] = _format_predictions(predictions)
            user_message = (
                f"Relevant past insights for this patient:\n{insight_lines}\n\n"
                + _QA_TEMPLATE.format(
                    timeline_json=json.dumps(tl, indent=2),
                    question=question,
                )
            )
        else:
            tl = dict(timeline)
            if predictions:
                tl["model_predictions"] = _format_predictions(predictions)
            user_message = _QA_TEMPLATE.format(
                timeline_json=json.dumps(tl, indent=2),
                question=question,
            )
        try:
            content = self._call_claude(user_message)
        except Exception as exc:
            from fastapi import HTTPException
            raise HTTPException(status_code=502, detail="AI service unavailable") from exc

        embedding = VoyageEmbedder().embed(content, input_type="document")
        self._save_insight(
            patient_id=patient_id,
            content=content,
            model=self.MODEL,
            insight_type="qa_response",
            question=question,
            embedding=embedding,
        )
        return content

