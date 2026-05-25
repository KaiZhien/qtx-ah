"""API tests using FastAPI TestClient."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest
from fastapi.testclient import TestClient

from main import app

_TEST_API_KEY = "test-qtx-api-key"


@pytest.fixture(scope="session", autouse=True)
def set_api_key_env():
    os.environ["QTX_API_KEY"] = _TEST_API_KEY
    os.environ.setdefault("TERRA_WEBHOOK_SECRET", "test_terra_secret")
    yield
    os.environ.pop("QTX_API_KEY", None)


@pytest.fixture(scope="session")
def client(set_api_key_env):
    with TestClient(app, headers={"X-Api-Key": _TEST_API_KEY}) as c:
        yield c

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


_VALID_FALL_RISK_BODY = {
    "age": 72,
    "gender": "F",
    "falls_history": 1,
    "walking_aid": "stick",
    "exercise_frequency": "1-2",
    "has_oa": 1,
    "has_diabetes": 0,
    "has_stroke": 0,
    "has_parkinsons": 0,
    "has_hypertension": 1,
    "has_frailty": 0,
    "polypharmacy": 1,
}


def test_fall_risk_returns_valid_structure(client):
    resp = client.post("/api/predict/fall-risk", json=_VALID_FALL_RISK_BODY)
    assert resp.status_code == 200
    data = resp.json()
    assert "risk_score" in data
    assert "risk_label" in data
    assert data["risk_label"] in ("low", "moderate", "elevated", "high")
    assert 0 <= data["risk_score"] <= 100


def test_fall_risk_rejects_old_has_heart_disease_field(client):
    """The renamed field must cause a 422 validation error when the old name is used."""
    old_body = {**_VALID_FALL_RISK_BODY}
    old_body.pop("has_hypertension")
    old_body["has_heart_disease"] = 1  # old field name — must be rejected
    resp = client.post("/api/predict/fall-risk", json=old_body)
    assert resp.status_code == 422


def test_fall_risk_per_test_predictions_within_bounds(client):
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
