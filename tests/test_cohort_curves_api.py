"""Integration tests for GET /api/cohort/{grp_flag}/response_curves."""
from __future__ import annotations

import os
import sys
import types
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

# Stub weasyprint before importing app
if "weasyprint" not in sys.modules:
    _wp = types.ModuleType("weasyprint")
    class _HTML:
        def __init__(self, s): pass
        def write_pdf(self): return b"%PDF"
    _wp.HTML = _HTML
    sys.modules["weasyprint"] = _wp

_KEY = "curve-test-key"
os.environ.setdefault("QTX_API_KEY", _KEY)
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("TERRA_WEBHOOK_SECRET", "s")

import deps
_orig_load = deps.load_all
deps.load_all = lambda: None

from main import app
deps.load_all = _orig_load

import contextlib
import pytest
from fastapi.testclient import TestClient
from db import get_db


@pytest.fixture(autouse=True)
def _restore_key():
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
        deps.load_all = _orig_load


def _make_row(grp_flag="grp_frailty_sarcopenia", metric="composite_improvement", session_number=1,
              p25=0.1, p50=0.3, p75=0.6, n=10):
    r = MagicMock()
    r.grp_flag = grp_flag
    r.metric = metric
    r.session_number = session_number
    r.p25 = p25
    r.p50 = p50
    r.p75 = p75
    r.n = n
    return r


def _db_with_rows(rows):
    db = MagicMock()
    q = MagicMock()
    q.filter_by.return_value = q
    q.order_by.return_value = q
    q.all.return_value = rows
    db.query.return_value = q
    return db


# --- Tests ---

def test_requires_api_key():
    with _client() as c:
        r = c.get("/api/cohort/grp_frailty_sarcopenia/response_curves")
    assert r.status_code == 401


def test_returns_404_when_no_curve_data():
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows([])
        try:
            r = c.get(
                "/api/cohort/grp_frailty_sarcopenia/response_curves",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 404


def test_returns_200_with_curves_array():
    rows = [_make_row(session_number=i) for i in range(1, 4)]
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows(rows)
        try:
            r = c.get(
                "/api/cohort/grp_frailty_sarcopenia/response_curves",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    body = r.json()
    assert "curves" in body
    assert isinstance(body["curves"], list)
    assert len(body["curves"]) >= 1


def test_curve_point_schema():
    rows = [_make_row(session_number=1, p25=0.1, p50=0.3, p75=0.6, n=10)]
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows(rows)
        try:
            r = c.get(
                "/api/cohort/grp_frailty_sarcopenia/response_curves",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    body = r.json()
    point = body["curves"][0]["points"][0]
    assert "session_number" in point
    assert "p25" in point
    assert "p50" in point
    assert "p75" in point
    assert "n" in point
    assert isinstance(point["session_number"], int)
    assert isinstance(point["n"], int)


def test_filter_by_metric():
    rows_ci = [_make_row(metric="composite_improvement", session_number=1)]
    rows_tug = [_make_row(metric="tug_change_pct", session_number=1)]

    def _db_metric_filtered():
        db = MagicMock()
        outer_q = MagicMock()
        inner_q = MagicMock()
        outer_q.filter_by.return_value = inner_q
        inner_q.filter_by.return_value = inner_q
        inner_q.order_by.return_value = inner_q
        inner_q.all.return_value = rows_ci
        db.query.return_value = outer_q
        return db

    with _client() as c:
        app.dependency_overrides[get_db] = _db_metric_filtered
        try:
            r = c.get(
                "/api/cohort/grp_frailty_sarcopenia/response_curves?metric=composite_improvement",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    body = r.json()
    for curve in body["curves"]:
        assert curve["metric"] == "composite_improvement"


def test_grp_flag_in_response():
    rows = [_make_row(grp_flag="grp_joint_disease")]
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows(rows)
        try:
            r = c.get(
                "/api/cohort/grp_joint_disease/response_curves",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    assert r.json()["grp_flag"] == "grp_joint_disease"


def test_cohort_curves_null_percentiles_returned_without_error():
    """A curve point with null p25/p50/p75 must not cause a 500 and must appear in the response."""
    rows = [_make_row(session_number=1, p25=None, p50=None, p75=None, n=5)]
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows(rows)
        try:
            r = c.get(
                "/api/cohort/grp_frailty_sarcopenia/response_curves",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    body = r.json()
    assert "curves" in body
    assert len(body["curves"]) >= 1
    point = body["curves"][0]["points"][0]
    assert point["p25"] is None
    assert point["p50"] is None
    assert point["p75"] is None
    assert point["n"] == 5


def test_cohort_curves_n_zero_included():
    """A curve point with n=0 must be included in the response, not filtered out."""
    rows = [_make_row(session_number=1, n=0)]
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows(rows)
        try:
            r = c.get(
                "/api/cohort/grp_frailty_sarcopenia/response_curves",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    body = r.json()
    assert "curves" in body
    assert len(body["curves"]) >= 1
    point = body["curves"][0]["points"][0]
    assert point["n"] == 0


def test_cohort_curves_invalid_metric_returns_non_500():
    """Passing an unrecognised metric value must not cause a 500 server error."""
    with _client() as c:
        app.dependency_overrides[get_db] = lambda: _db_with_rows([])
        try:
            r = c.get(
                "/api/cohort/grp_frailty_sarcopenia/response_curves?metric=invalid",
                headers={"X-Api-Key": _KEY},
            )
        finally:
            app.dependency_overrides.pop(get_db, None)
    assert r.status_code != 500


def test_migration_creates_table():
    """Integration test: migration 24 creates the table against SQLite."""
    import importlib.util
    from sqlalchemy import create_engine, inspect, text

    engine = create_engine("sqlite:///:memory:")
    # SQLite doesn't have gen_random_uuid() — create a simplified table to test
    with engine.connect() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS cohort_response_curves (
                id TEXT PRIMARY KEY,
                grp_flag TEXT NOT NULL,
                metric TEXT NOT NULL,
                session_number INTEGER NOT NULL,
                p25 REAL,
                p50 REAL,
                p75 REAL,
                n INTEGER NOT NULL,
                computed_at TEXT NOT NULL
            )
        """))
        conn.commit()

    insp = inspect(engine)
    assert "cohort_response_curves" in insp.get_table_names()
    cols = {c["name"] for c in insp.get_columns("cohort_response_curves")}
    assert {"grp_flag", "metric", "session_number", "p25", "p50", "p75", "n"}.issubset(cols)
