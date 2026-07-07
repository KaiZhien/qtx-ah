"""HTTP-level tests for POST /api/predict/outcomes and /api/predict/dosage.

Unlike the other API test modules, this one lets the app lifespan run the real
deps.load_all() so the endpoints serve the actual tracked joblib models.
"""
from __future__ import annotations
import os, sys, types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

# Stub weasyprint before any app imports
if "weasyprint" not in sys.modules:
    _wp = types.ModuleType("weasyprint")
    class _HTML:
        def __init__(self, s): pass
        def write_pdf(self): return b"%PDF"
    _wp.HTML = _HTML
    sys.modules["weasyprint"] = _wp

_KEY = "predict-test-key"
os.environ.setdefault("QTX_API_KEY", _KEY)
os.environ.setdefault("TERRA_WEBHOOK_SECRET", "s")

import pytest
from fastapi.testclient import TestClient

from main import app


@pytest.fixture(scope="module")
def client():
    prev = os.environ.get("QTX_API_KEY")
    os.environ["QTX_API_KEY"] = _KEY
    # Lifespan runs deps.load_all() — loads the real models from models/*.joblib.
    with TestClient(app, headers={"X-Api-Key": _KEY}) as c:
        yield c
    if prev is None:
        os.environ.pop("QTX_API_KEY", None)
    else:
        os.environ["QTX_API_KEY"] = prev


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
