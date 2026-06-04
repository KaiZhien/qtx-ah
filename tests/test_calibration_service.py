"""Unit tests for api/services/calibration.py — no DB required."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from services.calibration import CalibrationService


# ── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def reset_cache():
    CalibrationService._cache = {"computed_at": None, "metrics": {}}


# ── get_report tests ──────────────────────────────────────────────────────────

def test_get_report_no_baseline(tmp_path):
    """When calibration_baseline is absent, all statuses are NO_BASELINE."""
    metrics = {
        "adult": {"mae": 5.0, "n": 30, "bias": 1.0},
        "pediatric": {"mae": 7.0, "n": 25, "bias": -0.5},
    }
    db = MagicMock()

    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({}))  # no calibration_baseline key

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    assert report["total_matchable"] == 55
    for cohort_row in report["cohorts"]:
        assert cohort_row["status"] == "NO_BASELINE"
        assert cohort_row["baseline_mae"] is None
        assert cohort_row["drift_pct"] is None


def test_get_report_ok_status(tmp_path):
    """Drift < 15% → status is OK."""
    metrics = {"adult": {"mae": 5.5, "n": 30, "bias": 0.2}}
    db = MagicMock()
    # baseline_mae=5.0 → drift_pct = (5.5-5.0)/5.0*100 = 10.0 < 15 → OK
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({"calibration_baseline": {"adult": 5.0}}))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    cohort = report["cohorts"][0]
    assert cohort["cohort"] == "adult"
    assert cohort["status"] == "OK"
    assert cohort["drift_pct"] == pytest.approx(10.0, abs=0.01)


def test_get_report_warning_status(tmp_path):
    """Drift 15-30% → status is WARNING."""
    metrics = {"adult": {"mae": 6.0, "n": 30, "bias": 0.5}}
    db = MagicMock()
    # baseline_mae=5.0 → drift_pct = (6.0-5.0)/5.0*100 = 20.0 → WARNING
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({"calibration_baseline": {"adult": 5.0}}))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    cohort = report["cohorts"][0]
    assert cohort["status"] == "WARNING"
    assert cohort["drift_pct"] == pytest.approx(20.0, abs=0.01)


def test_get_report_alert_status(tmp_path):
    """Drift >= 30% → status is ALERT."""
    metrics = {"adult": {"mae": 7.0, "n": 30, "bias": 1.2}}
    db = MagicMock()
    # baseline_mae=5.0 → drift_pct = (7.0-5.0)/5.0*100 = 40.0 → ALERT
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({"calibration_baseline": {"adult": 5.0}}))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    cohort = report["cohorts"][0]
    assert cohort["status"] == "ALERT"
    assert cohort["drift_pct"] == pytest.approx(40.0, abs=0.01)


# ── check_and_trigger tests ───────────────────────────────────────────────────

def test_check_and_trigger_no_drift(tmp_path):
    """No cohort exceeds threshold — subprocess is NOT spawned."""
    # baseline_mae=5.0, current_mae=5.2 → drift=0.04, threshold=0.30 → no spawn
    metrics = {"adult": {"mae": 5.2, "n": 30, "bias": 0.1}}
    db = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({"calibration_baseline": {"adult": 5.0}}))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file), \
         patch("services.calibration.subprocess.Popen") as mock_popen:
        CalibrationService.check_and_trigger(db)

    mock_popen.assert_not_called()


def test_check_and_trigger_drift_detected(tmp_path):
    """One cohort exceeds threshold — subprocess is spawned exactly once."""
    # baseline_mae=5.0, current_mae=7.0 → drift=0.40 > 0.30 → spawn
    metrics = {
        "adult": {"mae": 7.0, "n": 30, "bias": 1.5},
        "pediatric": {"mae": 8.0, "n": 25, "bias": 2.0},  # both drift but only one spawn
    }
    db = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({
        "calibration_baseline": {"adult": 5.0, "pediatric": 5.0},
    }))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file), \
         patch("services.calibration.subprocess.Popen") as mock_popen:
        CalibrationService.check_and_trigger(db)

    mock_popen.assert_called_once()


# ── boundary tests ────────────────────────────────────────────────────────────

def test_get_report_warning_at_boundary(tmp_path):
    """Exactly 15% drift → status is WARNING (not OK)."""
    metrics = {"adult": {"mae": 5.75, "n": 30, "bias": 0.3}}
    db = MagicMock()
    # baseline_mae=5.0 → drift_pct = (5.75-5.0)/5.0*100 = 15.0 → WARNING
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({"calibration_baseline": {"adult": 5.0}}))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    cohort = report["cohorts"][0]
    assert cohort["status"] == "WARNING"
    assert cohort["drift_pct"] == pytest.approx(15.0, abs=0.01)


def test_get_report_alert_at_boundary(tmp_path):
    """Exactly 30% drift → status is ALERT (not WARNING)."""
    metrics = {"adult": {"mae": 6.5, "n": 30, "bias": 0.5}}
    db = MagicMock()
    # baseline_mae=5.0 → drift_pct = (6.5-5.0)/5.0*100 = 30.0 → ALERT
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({"calibration_baseline": {"adult": 5.0}}))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    cohort = report["cohorts"][0]
    assert cohort["status"] == "ALERT"
    assert cohort["drift_pct"] == pytest.approx(30.0, abs=0.01)
