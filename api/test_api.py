"""API tests using FastAPI TestClient."""
import sys
from pathlib import Path

# Ensure the api/ directory is on the path so imports work
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest
from fastapi.testclient import TestClient

from main import app


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
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
