"""Tests for POST /api/import/seed and POST /api/import/file endpoints.

Uses SQLite in-memory with shared-cache URI. WeasyPrint is stubbed out to
avoid requiring native Pango/Cairo libraries on developer/CI machines.
"""
from __future__ import annotations

import io
import os
import sys
import types
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

# ---------------------------------------------------------------------------
# Ensure api/ is importable
# ---------------------------------------------------------------------------
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

# ---------------------------------------------------------------------------
# Stub weasyprint BEFORE any api module imports it
# ---------------------------------------------------------------------------
if "weasyprint" not in sys.modules:
    _wp_stub = types.ModuleType("weasyprint")

    class _StubHTML:
        def __init__(self, string: str) -> None:
            pass

        def write_pdf(self) -> bytes:
            return b"%PDF-stub"

    _wp_stub.HTML = _StubHTML  # type: ignore[attr-defined]
    sys.modules["weasyprint"] = _wp_stub

import models.clinical  # noqa: F401 — registers ORM metadata
import models.wearable  # noqa: F401

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_TEST_KEY = "import-test-key"

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


# ---------------------------------------------------------------------------
# Client fixture
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def client():
    from db import Base, get_db
    from main import app
    import deps

    eng = create_engine(
        "sqlite:///file:qtx_test_import?mode=memory&cache=shared&uri=true",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def set_fk(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    Session = sessionmaker(bind=eng)

    def override():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    os.environ["QTX_API_KEY"] = _TEST_KEY

    with TestClient(app, headers={"X-Api-Key": _TEST_KEY}, raise_server_exceptions=False) as c:
        deps._db_ready = True
        yield c

    app.dependency_overrides.clear()
    os.environ.pop("QTX_API_KEY", None)
    deps._db_ready = False


# ---------------------------------------------------------------------------
# Test 1: POST /api/import/seed → 404 when parquet file is absent
# ---------------------------------------------------------------------------
def test_seed_returns_404_when_parquet_missing(client, monkeypatch):
    """The parquet file does not exist in the test environment; expect 404."""
    import routers.import_data as idata
    monkeypatch.setattr(idata, "_PARQUET_PATH", Path("/nonexistent/does_not_exist.parquet"))
    resp = client.post("/api/import/seed")
    assert resp.status_code == 404, f"Expected 404, got {resp.status_code}: {resp.text}"
    body = resp.json()
    assert "detail" in body
    assert "not found" in body["detail"].lower() or "parquet" in body["detail"].lower()


# ---------------------------------------------------------------------------
# Test 2: POST /api/import/file with .txt extension → 422
# ---------------------------------------------------------------------------
def test_import_file_txt_extension_rejected(client):
    """.txt is not in the accepted set; router must return 422."""
    resp = client.post(
        "/api/import/file",
        files={"file": ("test.txt", b"hello world", "text/plain")},
    )
    assert resp.status_code == 422, f"Expected 422, got {resp.status_code}: {resp.text}"
    body = resp.json()
    detail = body.get("detail", "")
    assert "unsupported file type" in detail.lower(), f"Unexpected detail: {detail!r}"


# ---------------------------------------------------------------------------
# Test 3: POST /api/import/file with .pdf extension → 422
# ---------------------------------------------------------------------------
def test_import_file_pdf_extension_rejected(client):
    """.pdf is not in the accepted set; router must return 422."""
    resp = client.post(
        "/api/import/file",
        files={"file": ("report.pdf", b"%PDF-1.4 fake", "application/pdf")},
    )
    assert resp.status_code == 422, f"Expected 422, got {resp.status_code}: {resp.text}"
    body = resp.json()
    detail = body.get("detail", "")
    assert "unsupported file type" in detail.lower(), f"Unexpected detail: {detail!r}"


# ---------------------------------------------------------------------------
# Test 4: POST /api/import/file with no filename (empty string) → 422
# ---------------------------------------------------------------------------
def test_import_file_empty_filename_rejected(client):
    """Empty filename produces suffix '' which is not accepted → 422."""
    resp = client.post(
        "/api/import/file",
        files={"file": ("", b"content", "application/octet-stream")},
    )
    assert resp.status_code == 422, f"Expected 422, got {resp.status_code}: {resp.text}"
    # Detail may be a string (our custom HTTPException) or a list (Pydantic validation)
    detail = resp.json().get("detail", "")
    if isinstance(detail, str):
        assert "unsupported" in detail.lower() or detail == ""
    # If detail is a list, Pydantic rejected the request — still a 422, which is correct


# ---------------------------------------------------------------------------
# Test 5: POST /api/import/file with content > 50 MB → 413
# ---------------------------------------------------------------------------
def test_import_file_too_large_rejected(client):
    """Files exceeding 50 MB must return 413 Request Entity Too Large."""
    big_content = b"x" * (51 * 1024 * 1024)
    resp = client.post(
        "/api/import/file",
        files={"file": ("data.csv", big_content, "text/csv")},
    )
    assert resp.status_code == 413, f"Expected 413, got {resp.status_code}: {resp.text}"
    body = resp.json()
    detail = body.get("detail", "")
    assert "50 mb" in detail.lower() or "exceeds" in detail.lower(), (
        f"Unexpected detail: {detail!r}"
    )


# ---------------------------------------------------------------------------
# Test 6: POST /api/import/file with .csv but broken qtx pipeline → 422
# ---------------------------------------------------------------------------
def test_import_file_csv_pipeline_failure_returns_422(client):
    """When the qtx pipeline raises, the router should catch it and return 422."""
    # Patch the pipeline modules that get imported inside the endpoint
    pipeline_error = RuntimeError("Synthetic pipeline failure for test")

    with patch.dict(
        sys.modules,
        {
            "qtx": MagicMock(),
            "qtx.io": MagicMock(),
            "qtx.io.load_raw": MagicMock(),
            "qtx.clean": MagicMock(),
            "qtx.clean.normalise": MagicMock(normalise=MagicMock(side_effect=pipeline_error)),
            "qtx.phenotype": MagicMock(),
            "qtx.phenotype.classify": MagicMock(),
            "qtx.outcomes": MagicMock(),
            "qtx.outcomes.change_scores": MagicMock(),
            "qtx.outcomes.composite": MagicMock(),
            "qtx.outcomes.responders": MagicMock(),
            "qtx.features": MagicMock(),
            "qtx.features.build": MagicMock(),
        },
    ):
        resp = client.post(
            "/api/import/file",
            files={"file": ("patients.csv", b"sn,name\n1,Alice", "text/csv")},
        )

    # The pipeline exception is caught by the endpoint and re-raised as 422
    assert resp.status_code == 422, f"Expected 422, got {resp.status_code}: {resp.text}"
    body = resp.json()
    detail = body.get("detail", "")
    assert "pipeline" in detail.lower() or "process" in detail.lower(), (
        f"Unexpected detail: {detail!r}"
    )


# ---------------------------------------------------------------------------
# Test 7: POST /api/import/file with .xlsx passes type check (pipeline error is OK)
# ---------------------------------------------------------------------------
def test_import_file_xlsx_passes_type_check(client):
    """.xlsx is an accepted extension; 422 (if any) must come from the pipeline,
    not from the type-validation guard — meaning the status code must NOT be 422
    with an 'unsupported file type' message."""
    small_xlsx = b"PK\x03\x04" + b"\x00" * 20  # minimal fake XLSX bytes (ZIP header)
    resp = client.post(
        "/api/import/file",
        files={"file": ("data.xlsx", small_xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    # If the file-type guard incorrectly rejects .xlsx we would get the exact
    # "unsupported file type" message — that is the failure we guard against.
    if resp.status_code == 422:
        detail = resp.json().get("detail", "")
        assert "unsupported file type" not in detail.lower(), (
            f".xlsx should pass the type check but got type-rejection: {detail!r}"
        )
    # Any other status (422 from pipeline, 500, etc.) is acceptable here because
    # we are only verifying the type-check layer, not end-to-end success.


# ---------------------------------------------------------------------------
# Test 8: POST /api/import/file with .xls passes type check (pipeline error is OK)
# ---------------------------------------------------------------------------
def test_import_file_xls_passes_type_check(client):
    """.xls is in _ACCEPTED_EXTENSIONS; rejection must not be due to file type."""
    fake_xls = b"\xd0\xcf\x11\xe0" + b"\x00" * 20  # OLE2 compound document header
    resp = client.post(
        "/api/import/file",
        files={"file": ("legacy.xls", fake_xls, "application/vnd.ms-excel")},
    )
    if resp.status_code == 422:
        detail = resp.json().get("detail", "")
        assert "unsupported file type" not in detail.lower(), (
            f".xls should pass the type check but got type-rejection: {detail!r}"
        )


# ---------------------------------------------------------------------------
# Test 9: _run_upsert DB error → 500
# ---------------------------------------------------------------------------
def test_run_upsert_db_error_returns_500(client):
    """When the DB commit raises, _run_upsert must roll back and return 500."""
    import pandas as pd
    from routers.import_data import _run_upsert
    from sqlalchemy.exc import OperationalError

    # Build a minimal DataFrame (columns don't matter for this unit test because
    # we mock IngestPipeline entirely)
    df = pd.DataFrame({"sn": ["X1"], "name": ["Test Patient"]})

    # Build a mock session whose commit raises
    mock_db = MagicMock()
    mock_db.commit.side_effect = OperationalError("disk I/O error", None, None)

    # Mock IngestPipeline.upsert so it succeeds (commit is what fails)
    from fastapi import HTTPException

    mock_summary = MagicMock()
    mock_summary.inserted = 0
    mock_summary.updated = 0
    mock_summary.skipped = 0
    mock_summary.errors = []

    with patch("routers.import_data.IngestPipeline") as MockPipeline:
        instance = MockPipeline.return_value
        instance.upsert.return_value = mock_summary

        with pytest.raises(HTTPException) as exc_info:
            _run_upsert(df, mock_db, source="test_source.csv")

    assert exc_info.value.status_code == 500
    assert "rolled back" in exc_info.value.detail.lower() or "batch" in exc_info.value.detail.lower()
    mock_db.rollback.assert_called_once()


# ---------------------------------------------------------------------------
# Test 10: Exact detail message for unsupported extension includes the suffix
# ---------------------------------------------------------------------------
def test_import_file_detail_includes_rejected_suffix(client):
    """The 422 detail string should name the offending extension."""
    resp = client.post(
        "/api/import/file",
        files={"file": ("malware.exe", b"\x4d\x5a", "application/octet-stream")},
    )
    assert resp.status_code == 422
    detail = resp.json().get("detail", "")
    assert ".exe" in detail, f"Expected rejected suffix in detail, got: {detail!r}"


# ---------------------------------------------------------------------------
# Test 11: POST /api/import/seed detail contains path hint
# ---------------------------------------------------------------------------
def test_seed_404_detail_mentions_parquet_or_scripts(client, monkeypatch):
    """The 404 detail should give the operator a useful diagnostic hint."""
    import routers.import_data as idata
    monkeypatch.setattr(idata, "_PARQUET_PATH", Path("/nonexistent/does_not_exist.parquet"))
    resp = client.post("/api/import/seed")
    assert resp.status_code == 404
    detail = resp.json().get("detail", "")
    # Either the file path or a reference to the pipeline scripts should appear
    assert any(keyword in detail.lower() for keyword in ("parquet", "script", "run", "processed")), (
        f"Detail should hint at resolution steps, got: {detail!r}"
    )


# ---------------------------------------------------------------------------
# Test 12: File exactly at 50 MB limit is not rejected for size
# ---------------------------------------------------------------------------
def test_import_file_exactly_50mb_not_size_rejected(client):
    """A file of exactly 50 MB should NOT trigger the 413 size guard.
    It will fail at the pipeline stage (422), but the 413 must not fire."""
    exact_content = b"x" * (50 * 1024 * 1024)
    resp = client.post(
        "/api/import/file",
        files={"file": ("exact.csv", exact_content, "text/csv")},
    )
    assert resp.status_code != 413, (
        f"A file at exactly the limit should not be rejected for size, got 413: {resp.text}"
    )


# ---------------------------------------------------------------------------
# Test 13: POST /api/import/file with valid CSV and mocked pipeline -> 200
# ---------------------------------------------------------------------------
def test_import_file_valid_csv_returns_200_with_inserted(client):
    """Uploading a valid CSV with all pipeline stages mocked returns 200 and inserted > 0."""
    import pandas as pd

    sample_df = pd.DataFrame({"sn": ["T001"], "name": ["Test Patient"]})

    mock_summary = MagicMock()
    mock_summary.inserted = 1
    mock_summary.updated = 0
    mock_summary.skipped = 0
    mock_summary.errors = []

    pipeline_modules = {
        "qtx": MagicMock(),
        "qtx.io": MagicMock(),
        "qtx.io.load_raw": MagicMock(load_raw=MagicMock(return_value=sample_df)),
        "qtx.clean": MagicMock(),
        "qtx.clean.normalise": MagicMock(normalise=MagicMock(return_value=sample_df)),
        "qtx.phenotype": MagicMock(),
        "qtx.phenotype.classify": MagicMock(classify=MagicMock(return_value=sample_df)),
        "qtx.outcomes": MagicMock(),
        "qtx.outcomes.change_scores": MagicMock(
            compute_change_scores=MagicMock(return_value=sample_df)
        ),
        "qtx.outcomes.composite": MagicMock(
            compute_composite=MagicMock(return_value=sample_df)
        ),
        "qtx.outcomes.responders": MagicMock(
            compute_responders=MagicMock(return_value=sample_df)
        ),
        "qtx.features": MagicMock(),
        "qtx.features.build": MagicMock(
            build_feature_matrix=MagicMock(return_value=sample_df)
        ),
    }

    with patch.dict(sys.modules, pipeline_modules):
        with patch("routers.import_data.IngestPipeline") as MockPipeline:
            MockPipeline.return_value.upsert.return_value = mock_summary
            resp = client.post(
                "/api/import/file",
                files={"file": ("patients.csv", b"sn,name\nT001,Test Patient", "text/csv")},
            )

    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
    body = resp.json()
    assert body.get("inserted", 0) > 0, f"Expected inserted > 0, got: {body}"


# ---------------------------------------------------------------------------
# Test 14: POST /api/import/file with malformed data -> 422 with error message
# ---------------------------------------------------------------------------
def test_import_file_malformed_data_returns_422_with_error(client):
    """When the pipeline raises on bad data, the endpoint returns 422 with a message."""
    pipeline_error = ValueError("Malformed data: required column sn not found")

    pipeline_modules = {
        "qtx": MagicMock(),
        "qtx.io": MagicMock(),
        "qtx.io.load_raw": MagicMock(),
        "qtx.clean": MagicMock(),
        "qtx.clean.normalise": MagicMock(
            normalise=MagicMock(side_effect=pipeline_error)
        ),
        "qtx.phenotype": MagicMock(),
        "qtx.phenotype.classify": MagicMock(),
        "qtx.outcomes": MagicMock(),
        "qtx.outcomes.change_scores": MagicMock(),
        "qtx.outcomes.composite": MagicMock(),
        "qtx.outcomes.responders": MagicMock(),
        "qtx.features": MagicMock(),
        "qtx.features.build": MagicMock(),
    }

    with patch.dict(sys.modules, pipeline_modules):
        resp = client.post(
            "/api/import/file",
            files={"file": ("bad.csv", b"not,valid,columns\n1,2,3", "text/csv")},
        )

    assert resp.status_code == 422, f"Expected 422, got {resp.status_code}: {resp.text}"
    detail = resp.json().get("detail", "")
    assert "pipeline" in detail.lower() or "process" in detail.lower(), (
        f"Expected pipeline error in detail, got: {detail!r}"
    )


# ---------------------------------------------------------------------------
# Test 15: Temp file is cleaned up after a successful import
# ---------------------------------------------------------------------------
def test_import_file_temp_file_cleaned_up_after_success(client):
    """The temp file written before pipeline processing is removed after success."""
    import pandas as pd
    import routers.import_data as idata

    sample_df = pd.DataFrame({"sn": ["T002"], "name": ["Cleanup Test"]})
    created_paths: list[Path] = []

    import tempfile as _tempfile_mod
    original_ntf = _tempfile_mod.NamedTemporaryFile

    def tracking_ntf(*args, **kwargs):
        f = original_ntf(*args, **kwargs)
        created_paths.append(Path(f.name))
        return f

    mock_summary = MagicMock()
    mock_summary.inserted = 1
    mock_summary.updated = 0
    mock_summary.skipped = 0
    mock_summary.errors = []

    pipeline_modules = {
        "qtx": MagicMock(),
        "qtx.io": MagicMock(),
        "qtx.io.load_raw": MagicMock(load_raw=MagicMock(return_value=sample_df)),
        "qtx.clean": MagicMock(),
        "qtx.clean.normalise": MagicMock(normalise=MagicMock(return_value=sample_df)),
        "qtx.phenotype": MagicMock(),
        "qtx.phenotype.classify": MagicMock(classify=MagicMock(return_value=sample_df)),
        "qtx.outcomes": MagicMock(),
        "qtx.outcomes.change_scores": MagicMock(
            compute_change_scores=MagicMock(return_value=sample_df)
        ),
        "qtx.outcomes.composite": MagicMock(
            compute_composite=MagicMock(return_value=sample_df)
        ),
        "qtx.outcomes.responders": MagicMock(
            compute_responders=MagicMock(return_value=sample_df)
        ),
        "qtx.features": MagicMock(),
        "qtx.features.build": MagicMock(
            build_feature_matrix=MagicMock(return_value=sample_df)
        ),
    }

    with patch.dict(sys.modules, pipeline_modules):
        with patch.object(idata.tempfile, "NamedTemporaryFile", side_effect=tracking_ntf):
            with patch("routers.import_data.IngestPipeline") as MockPipeline:
                MockPipeline.return_value.upsert.return_value = mock_summary
                resp = client.post(
                    "/api/import/file",
                    files={"file": ("patients.csv", b"sn,name\nT002,Cleanup Test", "text/csv")},
                )

    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
    assert len(created_paths) == 1, "Expected exactly one temp file to be created"
    assert not created_paths[0].exists(), (
        f"Temp file {created_paths[0]} was not removed after success"
    )


# ---------------------------------------------------------------------------
# Test 16: Temp file is cleaned up even after a pipeline failure
# ---------------------------------------------------------------------------
def test_import_file_temp_file_cleaned_up_after_failure(client):
    """The temp file is removed even when the pipeline raises an exception."""
    import routers.import_data as idata

    created_paths: list[Path] = []
    pipeline_error = RuntimeError("Simulated pipeline crash")

    import tempfile as _tempfile_mod
    original_ntf = _tempfile_mod.NamedTemporaryFile

    def tracking_ntf(*args, **kwargs):
        f = original_ntf(*args, **kwargs)
        created_paths.append(Path(f.name))
        return f

    pipeline_modules = {
        "qtx": MagicMock(),
        "qtx.io": MagicMock(),
        "qtx.io.load_raw": MagicMock(),
        "qtx.clean": MagicMock(),
        "qtx.clean.normalise": MagicMock(
            normalise=MagicMock(side_effect=pipeline_error)
        ),
        "qtx.phenotype": MagicMock(),
        "qtx.phenotype.classify": MagicMock(),
        "qtx.outcomes": MagicMock(),
        "qtx.outcomes.change_scores": MagicMock(),
        "qtx.outcomes.composite": MagicMock(),
        "qtx.outcomes.responders": MagicMock(),
        "qtx.features": MagicMock(),
        "qtx.features.build": MagicMock(),
    }

    with patch.dict(sys.modules, pipeline_modules):
        with patch.object(idata.tempfile, "NamedTemporaryFile", side_effect=tracking_ntf):
            resp = client.post(
                "/api/import/file",
                files={"file": ("patients.csv", b"sn,name\nT003,Crash Test", "text/csv")},
            )

    assert resp.status_code == 422, f"Expected 422, got {resp.status_code}: {resp.text}"
    assert len(created_paths) == 1, "Expected exactly one temp file to be created"
    assert not created_paths[0].exists(), (
        f"Temp file {created_paths[0]} was not removed after pipeline failure"
    )
