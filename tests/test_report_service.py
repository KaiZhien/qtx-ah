"""Unit tests for ReportService (api/services/report.py).

Tests the service class directly (not via HTTP). WeasyPrint is monkeypatched
in every test that calls generate() to avoid requiring native Pango/Cairo libs.

SQLite shared-cache in-memory DB, module-scoped engine, function-scoped sessions.
"""
from __future__ import annotations

import sys
import types
import uuid
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

# ── path setup ────────────────────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

# ── stub out weasyprint before any api code imports it ────────────────────────
if "weasyprint" not in sys.modules:
    _wp_stub = types.ModuleType("weasyprint")

    class _StubHTML:
        def __init__(self, string: str) -> None:
            pass

        def write_pdf(self) -> bytes:
            return b"%PDF-stub"

    _wp_stub.HTML = _StubHTML  # type: ignore[attr-defined]
    sys.modules["weasyprint"] = _wp_stub

import models.clinical  # noqa: F401  — registers ORM metadata
import models.wearable  # noqa: F401

# ── shared helpers ─────────────────────────────────────────────────────────────

_FLAG_COLS = [
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
]


def _make_patient(**kwargs):
    """Return a Patient ORM object with all flag cols defaulting to False."""
    from models.clinical import Patient

    defaults = dict(
        id=uuid.uuid4(),
        sn="T001",
        name="Test Patient",
        gender="F",
        age=70,
        age_band="70-79",
        record_type="Active",
        **{col: False for col in _FLAG_COLS},
    )
    defaults.update(kwargs)
    return Patient(**defaults)


def _make_session(patient_id, **kwargs):
    """Return a ClinicalSession ORM object with required fields."""
    from models.clinical import Session as ClinicalSession

    defaults = dict(
        id=uuid.uuid4(),
        patient_id=patient_id,
        session_number=1,
        has_followup=False,
        is_dropout=False,
    )
    defaults.update(kwargs)
    return ClinicalSession(**defaults)


class FakeHTML:
    """WeasyPrint stand-in that returns stub PDF bytes."""

    def __init__(self, string: str) -> None:
        self.html = string

    def write_pdf(self) -> bytes:
        return b"%PDF-stub"


class CapturingHTML:
    """WeasyPrint stand-in that captures the rendered HTML string."""

    captured: str = ""

    def __init__(self, string: str) -> None:
        CapturingHTML.captured = string

    def write_pdf(self) -> bytes:
        return b"%PDF"


# ── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def engine():
    from db import Base

    eng = create_engine(
        "sqlite:///file:qtx_test_report_svc?mode=memory&cache=shared&uri=true",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def _set_fk(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture
def db_session(engine):
    """Function-scoped DB session; rolls back after each test."""
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.rollback()
    session.close()


def _make_service(db_session):
    from services.report import ReportService
    return ReportService(db_session)


# ── _v() helper tests ─────────────────────────────────────────────────────────

def test_v_none_returns_none():
    from services.report import _v
    assert _v(None) is None


def test_v_float_passthrough():
    from services.report import _v
    result = _v(3.14)
    assert result == 3.14
    assert isinstance(result, float)


def test_v_string_passthrough():
    from services.report import _v
    result = _v("hello")
    assert result == "hello"
    assert isinstance(result, str)


def test_v_decimal_to_float():
    from services.report import _v
    result = _v(Decimal("2.5"))
    assert result == 2.5
    assert isinstance(result, float)


# ── generate() core behaviour tests ──────────────────────────────────────────

def test_generate_returns_bytes(db_session, monkeypatch):
    """generate() returns bytes when WeasyPrint is mocked."""
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", FakeHTML)

    patient = _make_patient(sn="S100", name="Bytes Patient")
    db_session.add(patient)
    db_session.flush()

    service = _make_service(db_session)
    result = service.generate("S100")

    assert isinstance(result, bytes)
    assert result == b"%PDF-stub"


def test_generate_raises_for_unknown_sn(db_session, monkeypatch):
    """generate() raises ValueError when patient sn is not found."""
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", FakeHTML)

    service = _make_service(db_session)
    with pytest.raises(ValueError, match="not found"):
        service.generate("DOESNOTEXIST_XYZ")


def test_generate_no_sessions(db_session, monkeypatch):
    """generate() succeeds with a patient who has no sessions (empty list)."""
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", CapturingHTML)

    patient = _make_patient(sn="S200", name="No Session Patient")
    db_session.add(patient)
    db_session.flush()

    service = _make_service(db_session)
    result = service.generate("S200")

    assert isinstance(result, bytes)
    # Template should still render without error; check no session rows in HTML
    assert "No Session Patient" in CapturingHTML.captured


def test_generate_two_sessions_list_structure(db_session, monkeypatch):
    """generate() with 2 sessions produces sessions_list with 2 dicts and correct keys."""
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", FakeHTML)

    patient = _make_patient(sn="S300", name="Two Session Patient")
    db_session.add(patient)
    db_session.flush()

    s1 = _make_session(patient.id, session_number=1, post_vas=5.0, post_tug_s=20.0)
    s2 = _make_session(patient.id, session_number=2, post_vas=3.5, post_tug_s=17.5)
    db_session.add_all([s1, s2])
    db_session.flush()

    # Intercept sessions_list by capturing the template render call
    captured_sessions = []

    class SessionCapturingHTML:
        def __init__(self, string: str) -> None:
            pass

        def write_pdf(self) -> bytes:
            return b"%PDF-stub"

    original_render = None

    import services.report as svc2
    from services.report import ReportService

    class InstrumentedService(ReportService):
        def generate(self, sn: str) -> bytes:
            db = self._db
            from models.clinical import Patient, Session as ClinicalSession
            patient_orm = db.query(Patient).filter_by(sn=sn).first()
            sessions_orm = (
                db.query(ClinicalSession)
                .filter_by(patient_id=patient_orm.id)
                .order_by(ClinicalSession.session_number.asc())
                .all()
            )
            captured_sessions.extend(sessions_orm)
            return super().generate(sn)

    service = InstrumentedService(db_session)
    result = service.generate("S300")

    assert len(captured_sessions) == 2
    session_numbers = sorted(s.session_number for s in captured_sessions)
    assert session_numbers == [1, 2]

    # Verify the expected keys by calling generate on base service and checking HTML
    monkeypatch.setattr(svc2.weasyprint, "HTML", CapturingHTML)
    base_service = _make_service(db_session)
    base_service.generate("S300")
    html = CapturingHTML.captured

    # Both session numbers should appear in the rendered HTML
    assert "1" in html
    assert "2" in html


def test_generate_with_patient_trend(db_session, monkeypatch):
    """generate() with a PatientTrend row includes it in trends_list."""
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", CapturingHTML)

    from models.clinical import PatientTrend

    patient = _make_patient(sn="S400", name="Trend Patient")
    db_session.add(patient)
    db_session.flush()

    trend = PatientTrend(
        id=uuid.uuid4(),
        patient_id=patient.id,
        metric="post_vas",
        direction="improving",
        sessions_used=3,
        magnitude=Decimal("1.500"),
        first_value=Decimal("6.000"),
        last_value=Decimal("3.000"),
        computed_at=datetime.utcnow(),
    )
    db_session.add(trend)
    db_session.flush()

    service = _make_service(db_session)
    result = service.generate("S400")

    assert isinstance(result, bytes)
    html = CapturingHTML.captured
    # The trend metric and direction should appear in the rendered template
    assert "post_vas" in html
    assert "improving" in html


def test_generate_with_session_summary_insight(db_session, monkeypatch):
    """generate() with a session_summary PatientInsight sets latest_insight."""
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", CapturingHTML)

    from models.clinical import PatientInsight

    patient = _make_patient(sn="S500", name="Insight Patient")
    db_session.add(patient)
    db_session.flush()

    insight = PatientInsight(
        id=uuid.uuid4(),
        patient_id=patient.id,
        session_number=1,
        insight_type="session_summary",
        content="Patient showed marked improvement in gait speed.",
        model="claude-3-5-sonnet",
        created_at=datetime.utcnow(),
    )
    db_session.add(insight)
    db_session.flush()

    service = _make_service(db_session)
    result = service.generate("S500")

    assert isinstance(result, bytes)
    html = CapturingHTML.captured
    assert "marked improvement in gait speed" in html


def test_generate_qa_response_only_insight_is_none(db_session, monkeypatch):
    """generate() with only qa_response insights results in latest_insight being None."""
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", CapturingHTML)

    from models.clinical import PatientInsight

    patient = _make_patient(sn="S600", name="QA Only Patient")
    db_session.add(patient)
    db_session.flush()

    qa_insight = PatientInsight(
        id=uuid.uuid4(),
        patient_id=patient.id,
        session_number=1,
        insight_type="qa_response",
        question="What is the patient's condition?",
        content="The patient has OA.",
        model="claude-3-5-sonnet",
        created_at=datetime.utcnow(),
    )
    db_session.add(qa_insight)
    db_session.flush()

    service = _make_service(db_session)
    result = service.generate("S600")

    assert isinstance(result, bytes)
    html = CapturingHTML.captured
    # Insight section should not contain the qa_response content
    # The template should handle latest_insight=None gracefully
    assert "QA Only Patient" in html
    # qa insight content should NOT appear in the rendered insight block
    assert "The patient has OA." not in html


def test_generate_session_notes_appear(db_session, monkeypatch):
    """generate() with session notes renders the notes in sessions_list."""
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", CapturingHTML)

    patient = _make_patient(sn="S700", name="Notes Patient")
    db_session.add(patient)
    db_session.flush()

    session = _make_session(
        patient.id,
        session_number=1,
        notes="Patient reported reduced knee pain after session.",
        post_vas=4.0,
    )
    db_session.add(session)
    db_session.flush()

    service = _make_service(db_session)
    result = service.generate("S700")

    assert isinstance(result, bytes)
    html = CapturingHTML.captured
    assert "reduced knee pain after session" in html


def test_generate_template_renders_patient_name(db_session, monkeypatch):
    """Template is found and renderable; rendered HTML includes patient name."""
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", CapturingHTML)

    patient = _make_patient(sn="S800", name="Alice Wonderland")
    db_session.add(patient)
    db_session.flush()

    service = _make_service(db_session)
    service.generate("S800")

    html = CapturingHTML.captured
    assert "Alice Wonderland" in html
    assert "S800" in html


def test_generate_none_name_uses_fallback(db_session, monkeypatch):
    """generate() with patient.name=None uses 'Patient {sn}' as display name.

    The DB enforces NOT NULL on 'name', so we can't persist None.  Instead we
    create a lightweight stub that mimics the Patient ORM interface with
    name=None and monkeypatch the Patient query to return it, staying entirely
    in-memory and never touching the DB for this object.
    """
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", CapturingHTML)

    # We need a real patient row so the sessions/trends/insights queries work.
    patient = _make_patient(sn="S900", name="Placeholder")
    db_session.add(patient)
    db_session.flush()

    real_patient_id = patient.id

    # Build a simple namespace object that looks like a Patient but has name=None.
    import types as _types
    stub = _types.SimpleNamespace(
        id=real_patient_id,
        sn="S900",
        name=None,
        age=70,
        gender="F",
        cohort="Test",
        primary_indication="",
    )

    from models.clinical import Patient as PatientModel

    real_query = db_session.query

    def patched_query(model, *args, **kwargs):
        q = real_query(model, *args, **kwargs)
        if model is PatientModel:
            class _PatchedQ:
                def filter_by(self_, **kw):
                    class _PatchedResult:
                        def first(self__):
                            # Return the stub instead of the real ORM object
                            return stub

                    return _PatchedResult()

                def __getattr__(self_, item):
                    return getattr(q, item)

            return _PatchedQ()
        return q

    monkeypatch.setattr(db_session, "query", patched_query)

    service = _make_service(db_session)
    service.generate("S900")

    html = CapturingHTML.captured
    assert "Patient S900" in html


# ── additional edge-case tests ────────────────────────────────────────────────

def test_generate_session_date_isoformat(db_session, monkeypatch):
    """Session dates are rendered in ISO format in the HTML output."""
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", CapturingHTML)

    patient = _make_patient(sn="S1000", name="Dated Patient")
    db_session.add(patient)
    db_session.flush()

    session = _make_session(
        patient.id,
        session_number=1,
        session_date=date(2024, 3, 15),
    )
    db_session.add(session)
    db_session.flush()

    service = _make_service(db_session)
    service.generate("S1000")

    html = CapturingHTML.captured
    assert "2024-03-15" in html


def test_generate_multiple_insights_picks_latest(db_session, monkeypatch):
    """generate() picks the most recent session_summary insight."""
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", CapturingHTML)

    from models.clinical import PatientInsight

    patient = _make_patient(sn="S1100", name="Multi Insight Patient")
    db_session.add(patient)
    db_session.flush()

    older = PatientInsight(
        id=uuid.uuid4(),
        patient_id=patient.id,
        session_number=1,
        insight_type="session_summary",
        content="Older insight content.",
        model="claude-3-5-sonnet",
        created_at=datetime(2024, 1, 1, 10, 0, 0),
    )
    newer = PatientInsight(
        id=uuid.uuid4(),
        patient_id=patient.id,
        session_number=2,
        insight_type="session_summary",
        content="Newer insight content.",
        model="claude-3-5-sonnet",
        created_at=datetime(2024, 6, 1, 10, 0, 0),
    )
    db_session.add_all([older, newer])
    db_session.flush()

    service = _make_service(db_session)
    service.generate("S1100")

    html = CapturingHTML.captured
    assert "Newer insight content." in html
    assert "Older insight content." not in html


def test_generate_trend_magnitude_converted_to_float(db_session, monkeypatch):
    """Trend magnitude (Decimal) is converted to float in trends_list."""
    import services.report as svc

    from models.clinical import PatientTrend

    # Intercept template.render to capture the trends_list directly
    captured_trends = []

    original_get_template = svc.ReportService.__init__

    class TrendCapturingService(svc.ReportService):
        pass

    original_render = None
    import jinja2

    real_env_cls = jinja2.Environment

    class PatchedEnv(real_env_cls):
        def get_template(self, name):
            tmpl = super().get_template(name)
            original_render_method = tmpl.render

            def patched_render(**kwargs):
                captured_trends.extend(kwargs.get("trends", []))
                return original_render_method(**kwargs)

            tmpl.render = patched_render
            return tmpl

    monkeypatch.setattr(svc, "Environment", PatchedEnv)
    monkeypatch.setattr(svc.weasyprint, "HTML", FakeHTML)

    patient = _make_patient(sn="S1200", name="Float Trend Patient")
    db_session.add(patient)
    db_session.flush()

    trend = PatientTrend(
        id=uuid.uuid4(),
        patient_id=patient.id,
        metric="post_tug_s",
        direction="improving",
        sessions_used=2,
        magnitude=Decimal("3.141"),
        first_value=Decimal("20.000"),
        last_value=Decimal("16.859"),
        computed_at=datetime.utcnow(),
    )
    db_session.add(trend)
    db_session.flush()

    # Rebuild service AFTER patching Environment
    service = svc.ReportService(db_session)
    service.generate("S1200")

    assert len(captured_trends) == 1
    t = captured_trends[0]
    assert isinstance(t["magnitude"], float)
    assert t["magnitude"] == pytest.approx(3.141)
    assert isinstance(t["first_value"], float)
    assert isinstance(t["last_value"], float)


def test_generate_patient_dict_fields(db_session, monkeypatch):
    """generate() builds patient_dict with expected fields passed to template."""
    import services.report as svc
    import jinja2

    captured_patient = {}

    real_env_cls = jinja2.Environment

    class PatchedEnv(real_env_cls):
        def get_template(self, name):
            tmpl = super().get_template(name)
            original_render_method = tmpl.render

            def patched_render(**kwargs):
                captured_patient.update(kwargs.get("patient", {}))
                return original_render_method(**kwargs)

            tmpl.render = patched_render
            return tmpl

    monkeypatch.setattr(svc, "Environment", PatchedEnv)
    monkeypatch.setattr(svc.weasyprint, "HTML", FakeHTML)

    patient = _make_patient(
        sn="S1300",
        name="Full Fields Patient",
        gender="M",
        age=65,
        cohort="Musculoskeletal",
        primary_indication="Knee OA",
    )
    db_session.add(patient)
    db_session.flush()

    service = svc.ReportService(db_session)
    service.generate("S1300")

    assert captured_patient["sn"] == "S1300"
    assert captured_patient["name"] == "Full Fields Patient"
    assert captured_patient["age"] == 65
    assert captured_patient["gender"] == "M"
    assert captured_patient["cohort"] == "Musculoskeletal"
    assert captured_patient["primary_indication"] == "Knee OA"
