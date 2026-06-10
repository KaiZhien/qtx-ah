"""Integration tests for GET /api/patient/{sn}/metric_series."""
from __future__ import annotations
import os, sys, types
from pathlib import Path
from unittest.mock import MagicMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))
if "weasyprint" not in sys.modules:
    _wp = types.ModuleType("weasyprint")
    class _HTML:
        def __init__(self, s): pass
        def write_pdf(self): return b"%PDF"
    _wp.HTML = _HTML
    sys.modules["weasyprint"] = _wp
_KEY = "metric-series-test-key"
os.environ.setdefault("QTX_API_KEY", _KEY)
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("TERRA_WEBHOOK_SECRET", "s")
import deps
_orig = deps.load_all
deps.load_all = lambda: None
from main import app
deps.load_all = _orig
import contextlib
import pytest
from fastapi.testclient import TestClient
from db import get_db


@pytest.fixture(autouse=True)
def _restore_api_key():
    prev = os.environ.get("QTX_API_KEY")
    os.environ["QTX_API_KEY"] = _KEY
    yield
    if prev is None:
        os.environ.pop("QTX_API_KEY", None)
    else:
        os.environ["QTX_API_KEY"] = prev


@contextlib.contextmanager
def _client():
    deps.load_all = lambda: None
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            yield c
    finally:
        deps.load_all = _orig


def _patient(sn="QTX001"):
    p = MagicMock()
    p.sn = sn
    p.id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    return p


def _row(session_number, value):
    r = MagicMock()
    r.session_number = session_number
    r.value = value
    return r


def _db_with_rows(rows, patient_exists=True):
    db = MagicMock()
    qf = MagicMock()
    qf.first.return_value = _patient() if patient_exists else None
    db.query.return_value.filter_by.return_value = qf
    ex = MagicMock()
    ex.fetchall.return_value = rows
    db.execute.return_value = ex
    return db


def test_metric_series_requires_api_key():
    with _client() as c:
        r = c.get("/api/patient/QTX001/metric_series?metric=vas_change")
        assert r.status_code == 401


def test_metric_series_returns_200_with_data():
    rows = [_row(1, -1.5), _row(2, -2.0)]
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows(rows)
        try:
            r = c.get(
                "/api/patient/QTX001/metric_series?metric=vas_change",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    d = r.json()
    assert d["sn"] == "QTX001"
    assert d["metric"] == "vas_change"
    assert len(d["points"]) == 2


def test_metric_series_404_for_unknown_patient():
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows([], patient_exists=False)
        try:
            r = c.get(
                "/api/patient/UNKNOWN/metric_series?metric=vas_change",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 404


def test_metric_series_400_for_invalid_metric():
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows([])
        try:
            r = c.get(
                "/api/patient/QTX001/metric_series?metric=injection_attempt",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 400
    assert "Invalid metric" in r.json()["detail"]


def test_metric_series_empty_points_when_no_data():
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows([])
        try:
            r = c.get(
                "/api/patient/QTX001/metric_series?metric=vas_change",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    assert r.json()["points"] == []


def test_metric_series_point_types():
    rows = [_row(1, -1.5), _row(3, -2.7)]
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows(rows)
        try:
            r = c.get(
                "/api/patient/QTX001/metric_series?metric=tug_change_pct",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    for pt in r.json()["points"]:
        assert isinstance(pt["session_number"], int)
        assert isinstance(pt["value"], float)


def test_metric_series_raise_sessions_excluded():
    """RAISE exclusion filter is present in SQL and :pid is bound to the correct patient id."""
    rows = [_row(1, -1.0)]
    patient = _patient("QTX001")
    db = MagicMock()
    qf = MagicMock(); qf.first.return_value = patient
    db.query.return_value.filter_by.return_value = qf
    ex = MagicMock(); ex.fetchall.return_value = rows
    db.execute.return_value = ex

    with _client() as c:
        app.dependency_overrides[get_db] = lambda: db
        try:
            r = c.get(
                "/api/patient/QTX001/metric_series?metric=vas_change",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)

    assert r.status_code == 200
    db.execute.assert_called_once()
    call_args = db.execute.call_args
    sql_text = str(call_args[0][0])
    # The SQL must contain the RAISE exclusion filter
    assert "not ilike" in sql_text.lower() or "not ilike" in sql_text.lower()
    assert "raise" in sql_text.lower()
    # The :pid parameter must be bound to the correct patient id
    params = call_args[0][1]
    assert params.get("pid") == str(patient.id)


def test_metric_series_tug_change_pct_valid():
    rows = [_row(1, -15.0)]
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows(rows)
        try:
            r = c.get(
                "/api/patient/QTX001/metric_series?metric=tug_change_pct",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    assert r.json()["metric"] == "tug_change_pct"
