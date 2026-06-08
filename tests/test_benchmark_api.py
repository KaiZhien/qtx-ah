"""Integration tests for GET /api/patient/{sn}/benchmark."""
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
_KEY = "bench-test-key"
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
    """Ensure QTX_API_KEY and get_db override are present for each test.

    test_import_api.py clears both in its module-scoped fixture teardown;
    this autouse fixture restores them before each benchmark test runs.
    """
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
        with TestClient(app, raise_server_exceptions=False) as c: yield c
    finally:
        deps.load_all = _orig

def _patient():
    p = MagicMock(); p.sn = "P001"; return p

def _db(row, exists=True):
    db = MagicMock()
    qf = MagicMock(); qf.first.return_value = _patient() if exists else None
    db.query.return_value.filter_by.return_value = qf
    ex = MagicMock(); ex.first.return_value = row
    db.execute.return_value = ex
    return db

def _row(pct=0.62):
    r = MagicMock()
    r._mapping = {"cohort":"QTX-A","cohort_n":80,"sn":"P001",
        "composite_improvement":12.5,"tug_change_pct":-18.0,"sst_change_pct":-12.0,
        "sppb_change":2.0,"vas_change":-3.0,"normal_gs_change_pct":8.0,"fast_gs_change_pct":7.0,
        "pct_composite":pct,"pct_tug":0.55,"pct_sst":0.45,"pct_sppb":0.70,"pct_vas":0.80,
        "pct_normal_gs":0.60,"pct_fast_gs":0.50,
        "n_composite":75,"n_tug":70,"n_sst":68,"n_sppb":60,"n_vas":65,"n_normal_gs":55,"n_fast_gs":55}
    return r

def test_benchmark_requires_api_key():
    with _client() as c: assert c.get("/api/patient/X/benchmark").status_code == 401

def test_benchmark_returns_503_when_db_not_ready():
    with _client() as c:
        with patch.object(deps,"_db_ready",False):
            assert c.get("/api/patient/P001/benchmark",headers={"X-Api-Key":_KEY}).status_code == 503

def test_benchmark_404_for_unknown_patient():
    with _client() as c:
        with patch.object(deps,"_db_ready",True):
            app.dependency_overrides[get_db] = lambda: _db(None,exists=False)
            try: r = c.get("/api/patient/X/benchmark",headers={"X-Api-Key":_KEY})
            finally: app.dependency_overrides.pop(get_db,None)
    assert r.status_code == 404

def test_benchmark_no_session_data_returns_null_percentile():
    with _client() as c:
        with patch.object(deps,"_db_ready",True):
            app.dependency_overrides[get_db] = lambda: _db(None,exists=True)
            try: r = c.get("/api/patient/P001/benchmark",headers={"X-Api-Key":_KEY})
            finally: app.dependency_overrides.pop(get_db,None)
    assert r.status_code == 200
    d = r.json(); assert d["cohort_percentile"] is None; assert d["benchmarks"] == []

def test_benchmark_cohort_percentile_preserved():
    with _client() as c:
        with patch.object(deps,"_db_ready",True):
            app.dependency_overrides[get_db] = lambda: _db(_row(0.62))
            try: r = c.get("/api/patient/P001/benchmark",headers={"X-Api-Key":_KEY})
            finally: app.dependency_overrides.pop(get_db,None)
    assert r.status_code == 200; assert r.json()["cohort_percentile"] == 62

def test_benchmark_includes_benchmarks_array():
    with _client() as c:
        with patch.object(deps,"_db_ready",True):
            app.dependency_overrides[get_db] = lambda: _db(_row())
            try: r = c.get("/api/patient/P001/benchmark",headers={"X-Api-Key":_KEY})
            finally: app.dependency_overrides.pop(get_db,None)
    assert r.status_code == 200; assert len(r.json()["benchmarks"]) >= 1

def test_benchmark_percentile_values_in_range():
    with _client() as c:
        with patch.object(deps,"_db_ready",True):
            app.dependency_overrides[get_db] = lambda: _db(_row())
            try: r = c.get("/api/patient/P001/benchmark",headers={"X-Api-Key":_KEY})
            finally: app.dependency_overrides.pop(get_db,None)
    assert r.status_code == 200
    for e in r.json()["benchmarks"]: assert 0.0 <= e["percentile"] <= 1.0

def test_benchmark_metric_schema():
    with _client() as c:
        with patch.object(deps,"_db_ready",True):
            app.dependency_overrides[get_db] = lambda: _db(_row())
            try: r = c.get("/api/patient/P001/benchmark",headers={"X-Api-Key":_KEY})
            finally: app.dependency_overrides.pop(get_db,None)
    assert r.status_code == 200
    for e in r.json()["benchmarks"]:
        assert isinstance(e["metric"],str); assert isinstance(e["patient_value"],(int,float))
        assert isinstance(e["percentile"],float); assert isinstance(e["percentile_display"],str)
        assert isinstance(e["n_compared"],int); assert isinstance(e["higher_is_better"],bool)
