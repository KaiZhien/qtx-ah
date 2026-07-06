"""API tests using FastAPI TestClient."""
import os
import sys
import types
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Stub weasyprint before main/routers import it (no system Pango/Cairo needed).
if "weasyprint" not in sys.modules:
    _wp_stub = types.ModuleType("weasyprint")
    class _StubHTML:
        def __init__(self, string: str) -> None: pass
        def write_pdf(self) -> bytes: return b"%PDF-stub"
    _wp_stub.HTML = _StubHTML  # type: ignore[attr-defined]
    sys.modules["weasyprint"] = _wp_stub

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from main import app

_TEST_API_KEY = "test-qtx-api-key"
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


def _make_test_engine():
    import models.clinical  # noqa: F401
    import models.wearable  # noqa: F401
    from db import Base
    eng = create_engine(
        "sqlite:///file:qtx_test_api?mode=memory&cache=shared&uri=true",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def set_fk(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    return eng


def _seed_test_db(engine) -> None:
    from models.clinical import Patient, Session as ClinicalSession
    Session = sessionmaker(bind=engine)
    db = Session()
    flags = {col: False for col in _FLAG_COLS}
    patients = [
        {"id": uuid.uuid4(), "sn": "1", "name": "Test Patient M", "gender": "M",
         "age": 65, "age_band": "60-69", "cohort": "Pain & Musculoskeletal",
         "record_type": "Active", **flags, "has_oa": True, "grp_joint_disease": True},
        {"id": uuid.uuid4(), "sn": "2", "name": "Test Patient F", "gender": "F",
         "age": 72, "age_band": "70-79", "cohort": "Neurological",
         "record_type": "Active", **flags, "has_stroke": True, "grp_neurological": True},
    ]
    for p_data in patients:
        p = Patient(**p_data)
        db.add(p)
    db.flush()
    for p_data in patients:
        s = ClinicalSession(
            id=uuid.uuid4(), patient_id=p_data["id"], session_number=1,
            has_followup=True, is_dropout=False,
            usage_frequency="Once (1x/week, one leg)",
        )
        db.add(s)
    db.commit()
    db.close()


@pytest.fixture(scope="session", autouse=True)
def set_api_key_env():
    os.environ["QTX_API_KEY"] = _TEST_API_KEY
    os.environ["TERRA_WEBHOOK_SECRET"] = "test_terra_secret"
    yield
    os.environ.pop("QTX_API_KEY", None)


@pytest.fixture(scope="session")
def client(set_api_key_env):
    from db import get_db
    import deps

    eng = _make_test_engine()
    _seed_test_db(eng)
    Session = sessionmaker(bind=eng)

    def override_get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app, headers={"X-Api-Key": _TEST_API_KEY}) as c:
        deps._db_ready = True
        yield c

    app.dependency_overrides.clear()
    deps._db_ready = False

_VALID_OUTCOMES_BODY = {
    "age": 65,
    "gender": "F",
    "cohort": "Pain & Musculoskeletal",
    "usage_frequency": "Once (1x/week, one leg)",
    "pre_vas": 6.0,
    "pre_tug_s": 15.0,
    "pre_5xsst_s": 20.0,
    "pre_normal_gs_ms": 0.8,
    "pre_fast_gs_ms": 1.2,
    "baseline_sppb": 6,
    "has_oa": 1,
    "has_diabetes": 0,
    "has_hypertension": 1,
    "has_frailty": 0,
    "has_osteoporosis": 0,
    "has_stroke": 0,
    "has_parkinsons": 0,
    "has_cancer": 0,
    "has_copd": 0,
    "has_depression": 0,
}

_VALID_DOSAGE_BODY = {
    "age": 70,
    "gender": "F",
    "joined_with_pain": "Y",
    "hl_knee_issue": 1,
    "hl_leg_issue": 0,
    "hl_back_spine_issue": 0,
    "hl_balance_issue": 0,
    "hl_upper_body_issue": 0,
    "hl_foot_ankle_issue": 0,
    "hl_neuro_issue": 0,
    "hl_frailty_issue": 0,
    "hl_metabolic_issue": 0,
    "hl_injury_surgery_issue": 0,
    "hl_general_pain_issue": 0,
}


def test_list_patients_returns_list(client):
    resp = client.get("/api/patients")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) > 0


def test_filter_gender_male(client):
    resp = client.get("/api/patients?gender=M")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) > 0
    for p in data:
        assert p["gender"] == "M"


def test_filter_fu_only(client):
    resp = client.get("/api/patients?fu_only=true")
    assert resp.status_code == 200
    data = resp.json()
    for p in data:
        assert p.get("is_dropout") != 1


def test_get_patient_by_sn(client):
    resp = client.get("/api/patient/1")
    assert resp.status_code == 200
    data = resp.json()
    assert "sn" in data
    # sn stored as "1.0" string — check it matches 1
    assert str(data["sn"]) in ("1", "1.0")


def test_get_patient_not_found(client):
    resp = client.get("/api/patient/99999")
    assert resp.status_code == 404


def test_predict_outcomes_valid(client):
    resp = client.post("/api/predict/outcomes", json=_VALID_OUTCOMES_BODY)
    assert resp.status_code == 200
    data = resp.json()
    assert "composite_improvement" in data
    assert "p_responder" in data
    assert "p_dropout" in data
    assert "per_test" in data
    assert "contributions" in data
    assert isinstance(data["per_test"], list)
    assert isinstance(data["contributions"], list)


def test_predict_dosage_valid(client):
    resp = client.post("/api/predict/dosage", json=_VALID_DOSAGE_BODY)
    assert resp.status_code == 200
    data = resp.json()
    assert "recommendation" in data
    assert "confidence" in data
    assert "probabilities" in data
    probs = data["probabilities"]
    total = sum(probs.values())
    assert abs(total - 1.0) < 0.01, f"Probabilities should sum to ~1.0, got {total}"


def test_api_key_required():
    """All non-webhook routes must reject requests without a valid API key."""
    os.environ["QTX_API_KEY"] = _TEST_API_KEY
    bare_client = TestClient(app, raise_server_exceptions=False)
    resp = bare_client.get("/api/patients")
    assert resp.status_code == 401


def test_webhook_bypasses_api_key():
    """Webhook route must not require QTX_API_KEY (it uses Terra HMAC instead)."""
    import hashlib
    import hmac as hmac_lib
    import json
    import time
    secret = os.environ.get("TERRA_WEBHOOK_SECRET", "test_terra_secret")
    body_bytes = json.dumps({
        "type": "activity",
        "user": {"user_id": "u_auth_test", "provider": "APPLE"},
        "data": [{"metadata": {"start_time": "2026-05-20T08:00:00Z"}, "steps_data": {"steps": 1000}}],
    }).encode()
    ts = str(int(time.time()))
    sig = hmac_lib.new(secret.encode(), f"{ts}.{body_bytes.decode()}".encode(), hashlib.sha256).hexdigest()
    bare_client = TestClient(app, raise_server_exceptions=False)
    resp = bare_client.post(
        "/webhooks/terra",
        content=body_bytes,
        headers={"Content-Type": "application/json", "terra-signature": f"t={ts},v1={sig}"},
    )
    assert resp.status_code == 200


def test_outcomes_per_test_predictions_within_bounds(client):
    """Per-test predicted values must stay within physiological ranges."""
    resp = client.post("/api/predict/outcomes", json={
        "age": 72, "gender": "F",
        "cohort": "Pain & Musculoskeletal",
        "usage_frequency": "Once (1x/week, one leg)",
        "pre_vas": 7.0, "pre_tug_s": 15.0, "pre_5xsst_s": 20.0,
        "pre_normal_gs_ms": 0.7, "pre_fast_gs_ms": 1.1, "baseline_sppb": 5,
        "has_oa": 1, "has_diabetes": 0, "has_hypertension": 1, "has_frailty": 0,
        "has_osteoporosis": 0, "has_stroke": 0, "has_parkinsons": 0,
        "has_cancer": 0, "has_copd": 0, "has_depression": 0,
    })
    assert resp.status_code == 200
    data = resp.json()
    for pt in data["per_test"]:
        name = pt["name"]
        pred = pt["predicted"]
        if "GS" in name:
            assert 0.1 <= pred <= 2.5, f"{name} gait speed {pred} out of range"
        elif "TUG" in name:
            assert pred >= 1.0, f"TUG {pred}s below physiological minimum"
        elif "5xSST" in name:
            assert pred >= 3.0, f"5xSST {pred}s below physiological minimum"
        elif "VAS" in name:
            assert 0 <= pred <= 100, f"VAS {pred} out of range"
        elif "SPPB" in name:
            assert 0 <= pred <= 12, f"SPPB {pred} out of range"
