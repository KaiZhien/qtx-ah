"""Tests for GET /api/patient/{sn}/report.pdf.

Uses SQLite in-memory with shared-cache URI (same pattern as test_patients_db.py).
WeasyPrint is monkeypatched to return b"%PDF-stub" — no system Pango/Cairo required.
"""
from __future__ import annotations

import os
import sys
import types
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

# ---------------------------------------------------------------------------
# Stub out weasyprint in sys.modules BEFORE any api code imports it.
# This prevents the Pango/Cairo dlopen from running on machines without those
# native libraries installed (CI, developer laptops, etc.).
# ---------------------------------------------------------------------------
if "weasyprint" not in sys.modules:
    _wp_stub = types.ModuleType("weasyprint")
    # Provide a no-op HTML class; tests that need it will replace it via monkeypatch.
    class _StubHTML:
        def __init__(self, string: str) -> None:
            pass
        def write_pdf(self) -> bytes:
            return b"%PDF-stub"
    _wp_stub.HTML = _StubHTML  # type: ignore[attr-defined]
    sys.modules["weasyprint"] = _wp_stub

import models.clinical  # noqa: F401 — registers ORM metadata
import models.wearable  # noqa: F401

_TEST_API_KEY = "test-key-report"

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


class _FakeHTML:
    """Stand-in for weasyprint.HTML that returns stub PDF bytes."""
    def __init__(self, string: str) -> None:
        pass

    def write_pdf(self) -> bytes:
        return b"%PDF-stub"


@pytest.fixture(scope="module")
def test_engine():
    from db import Base

    eng = create_engine(
        "sqlite:///file:qtx_test_report?mode=memory&cache=shared&uri=true",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def set_fk(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)
    eng.dispose()


def _seed(engine) -> None:
    from models.clinical import Patient, Session as ClinicalSession

    DBSession = sessionmaker(bind=engine)
    db = DBSession()

    pid = uuid.uuid4()
    p = Patient(
        id=pid, sn="301", name="Report Patient", gender="F", age=68,
        age_band="60-69", cohort="Neurological", record_type="Active",
        **{col: False for col in _FLAG_COLS},
    )
    db.add(p)
    db.flush()

    s = ClinicalSession(
        id=uuid.uuid4(), patient_id=pid, session_number=1,
        has_followup=True, is_dropout=False,
        post_vas=3.0, post_tug_s=18.0, post_sppb=9,
    )
    db.add(s)
    db.commit()
    db.close()


@pytest.fixture(scope="module", autouse=True)
def seeded_engine(test_engine):
    _seed(test_engine)
    return test_engine


@pytest.fixture
def client(test_engine, monkeypatch):
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", _FakeHTML)

    from db import get_db
    from main import app

    os.environ["QTX_API_KEY"] = _TEST_API_KEY

    DBSession = sessionmaker(bind=test_engine)

    def override_get_db():
        db = DBSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app, headers={"X-Api-Key": _TEST_API_KEY}, raise_server_exceptions=True) as c:
        import deps
        deps._db_ready = True
        yield c

    app.dependency_overrides.clear()
    os.environ.pop("QTX_API_KEY", None)


def test_pdf_200_content_type(client):
    """PDF endpoint returns 200 with content-type application/pdf."""
    resp = client.get("/api/patient/301/report.pdf")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"


def test_pdf_content_disposition_header(client):
    """Response includes Content-Disposition header with patient sn in filename."""
    resp = client.get("/api/patient/301/report.pdf")
    assert resp.status_code == 200
    cd = resp.headers.get("content-disposition", "")
    assert "301" in cd
    assert "patient_301_report.pdf" in cd


def test_pdf_body_is_stub_bytes(client):
    """Response body is the stub PDF bytes from the monkeypatched WeasyPrint."""
    resp = client.get("/api/patient/301/report.pdf")
    assert resp.content == b"%PDF-stub"


def test_pdf_404_unknown_sn(client):
    """Unknown patient sn returns 404."""
    resp = client.get("/api/patient/999/report.pdf")
    assert resp.status_code == 404


def test_pdf_503_when_db_not_ready(client):
    """Endpoint returns 503 when _db_ready is False."""
    import deps
    deps._db_ready = False
    try:
        resp = client.get("/api/patient/301/report.pdf")
        assert resp.status_code == 503
    finally:
        deps._db_ready = True


def test_pdf_key_query_param_auth(test_engine, monkeypatch):
    """?key= query param is accepted instead of X-Api-Key header."""
    import services.report as svc
    monkeypatch.setattr(svc.weasyprint, "HTML", _FakeHTML)

    from db import get_db
    from main import app

    os.environ["QTX_API_KEY"] = _TEST_API_KEY

    DBSession = sessionmaker(bind=test_engine)

    def override_get_db():
        db = DBSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db

    # No X-Api-Key header — only ?key= query param
    with TestClient(app, raise_server_exceptions=True) as c:
        import deps
        deps._db_ready = True
        resp = c.get(f"/api/patient/301/report.pdf?key={_TEST_API_KEY}")
        assert resp.status_code == 200, f"Expected 200 with ?key= param, got {resp.status_code}: {resp.text}"

    app.dependency_overrides.clear()
    os.environ.pop("QTX_API_KEY", None)
