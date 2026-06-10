"""PDF report generation service using Jinja2 + WeasyPrint."""
from __future__ import annotations

from datetime import date
from pathlib import Path

import weasyprint

from jinja2 import Environment, FileSystemLoader
from sqlalchemy.orm import Session as DBSession

from models.clinical import Patient, Session as ClinicalSession, PatientTrend, PatientInsight

_TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"


def _v(val):
    """Convert Decimal/numeric to float, pass None through."""
    if val is None:
        return None
    if hasattr(val, "__float__"):
        return float(val)
    return val


class ReportService:
    def __init__(self, db: DBSession) -> None:
        self._db = db
        self._env = Environment(
            loader=FileSystemLoader(str(_TEMPLATES_DIR)),
            autoescape=True,
        )

    def generate(self, sn: str) -> bytes:
        """Query patient data and render a PDF. Returns raw PDF bytes."""
        db = self._db

        patient = db.query(Patient).filter_by(sn=sn).first()
        if patient is None:
            raise ValueError(f"Patient sn={sn!r} not found")

        sessions_orm = (
            db.query(ClinicalSession)
            .filter_by(patient_id=patient.id)
            .order_by(ClinicalSession.session_number.asc())
            .all()
        )

        trends_orm = (
            db.query(PatientTrend)
            .filter_by(patient_id=patient.id)
            .all()
        )

        latest_insight_orm = (
            db.query(PatientInsight)
            .filter_by(patient_id=patient.id, insight_type="session_summary")
            .order_by(PatientInsight.created_at.desc())
            .first()
        )

        patient_dict = {
            "sn":                patient.sn,
            "name":              patient.name or f"Patient {patient.sn}",
            "age":               patient.age,
            "gender":            patient.gender or "—",
            "cohort":            patient.cohort or "—",
            "primary_indication": patient.primary_indication or "",
        }

        sessions_list = [
            {
                "session_number":    s.session_number,
                "session_date":      s.session_date.isoformat() if s.session_date else None,
                "notes":             s.notes,
                "post_vas":          _v(s.post_vas),
                "post_tug_s":        _v(s.post_tug_s),
                "post_5xsst_s":      _v(s.post_5xsst_s),
                "post_normal_gs_ms": _v(s.post_normal_gs_ms),
                "post_sppb":         s.post_sppb,
                "overall_responder": s.overall_responder,
            }
            for s in sessions_orm
        ]

        trends_list = [
            {
                "metric":        t.metric,
                "direction":     t.direction,
                "sessions_used": t.sessions_used,
                "magnitude":     float(t.magnitude) if t.magnitude is not None else None,
                "first_value":   float(t.first_value) if t.first_value is not None else None,
                "last_value":    float(t.last_value) if t.last_value is not None else None,
            }
            for t in trends_orm
        ]

        latest_insight_dict = None
        if latest_insight_orm:
            latest_insight_dict = {
                "session_number": latest_insight_orm.session_number,
                "content":        latest_insight_orm.content,
                "model":          latest_insight_orm.model,
                "created_at":     latest_insight_orm.created_at.isoformat(),
            }

        template = self._env.get_template("patient_report.html")
        html = template.render(
            patient=patient_dict,
            sessions=sessions_list,
            trends=trends_list,
            latest_insight=latest_insight_dict,
            generated_date=date.today().isoformat(),
        )

        return weasyprint.HTML(string=html).write_pdf()
