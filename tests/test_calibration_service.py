"""Unit tests for api/services/calibration.py — no DB required."""
from __future__ import annotations

import json
import logging
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
    CalibrationService._last_spawn_at = None


# ── get_report tests ──────────────────────────────────────────────────────────

def test_get_report_no_baseline(tmp_path):
    """When calibration_baseline is absent, all statuses are NO_BASELINE."""
    metrics = {
        "adult": {"mae": 5.0, "n": 30, "bias": 1.0},
        "pediatric": {"mae": 7.0, "n": 25, "bias": -0.5},
    }
    db = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({}))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    assert report["total_matchable"] == 55
    for cohort_row in report["cohorts"]:
        assert cohort_row["status"] == "NO_BASELINE"
        assert cohort_row["baseline_mae"] is None
        assert cohort_row["drift_pct"] is None


def test_get_report_ok_status(tmp_path):
    """Drift < 15% -> status is OK."""
    metrics = {"adult": {"mae": 5.5, "n": 30, "bias": 0.2}}
    db = MagicMock()
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
    """Drift 15-30% -> status is WARNING."""
    metrics = {"adult": {"mae": 6.0, "n": 30, "bias": 0.5}}
    db = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({"calibration_baseline": {"adult": 5.0}}))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    cohort = report["cohorts"][0]
    assert cohort["status"] == "WARNING"
    assert cohort["drift_pct"] == pytest.approx(20.0, abs=0.01)


def test_get_report_alert_status(tmp_path):
    """Drift >= 30% -> status is ALERT."""
    metrics = {"adult": {"mae": 7.0, "n": 30, "bias": 1.2}}
    db = MagicMock()
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
    """No cohort exceeds threshold — background task is NOT added."""
    # baseline_mae=5.0, current_mae=5.2 → drift=0.04, threshold=0.30 → no spawn
    metrics = {"adult": {"mae": 5.2, "n": 30, "bias": 0.1}}
    db = MagicMock()
    background_tasks = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({"calibration_baseline": {"adult": 5.0}}))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        CalibrationService.check_and_trigger(db, background_tasks)

    background_tasks.add_task.assert_not_called()


def test_check_and_trigger_drift_detected(tmp_path):
    """One cohort exceeds threshold — background task is added exactly once."""
    # baseline_mae=5.0, current_mae=7.0 → drift=0.40 > 0.30 → spawn
    metrics = {
        "adult": {"mae": 7.0, "n": 30, "bias": 1.5},
        "pediatric": {"mae": 8.0, "n": 25, "bias": 2.0},  # both drift but only one retrain
    }
    db = MagicMock()
    background_tasks = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({
        "calibration_baseline": {"adult": 5.0, "pediatric": 5.0},
    }))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        CalibrationService.check_and_trigger(db, background_tasks)

    background_tasks.add_task.assert_called_once()


def test_check_and_trigger_add_task_receives_spawn_method(tmp_path):
    """add_task should be called with _spawn_retrain_subprocess."""
    metrics = {"adult": {"mae": 7.0, "n": 30, "bias": 1.5}}
    db = MagicMock()
    bg = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({"calibration_baseline": {"adult": 5.0}}))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        CalibrationService.check_and_trigger(db, bg)

    bg.add_task.assert_called_once_with(CalibrationService._spawn_retrain_subprocess)


def test_spawn_retrain_subprocess_logs_error_on_nonzero_exit(caplog):
    """_spawn_retrain_subprocess logs an error when the script exits non-zero."""
    import logging

    mock_result = MagicMock()
    mock_result.returncode = 1

    with patch("services.calibration.subprocess.run", return_value=mock_result), \
         caplog.at_level(logging.ERROR, logger="services.calibration"):
        CalibrationService._spawn_retrain_subprocess()

    assert any("non-zero code" in r.message for r in caplog.records)


def test_spawn_retrain_subprocess_no_error_on_zero_exit(caplog):
    """_spawn_retrain_subprocess does not log an error when the script succeeds."""
    import logging

    mock_result = MagicMock()
    mock_result.returncode = 0

    with patch("services.calibration.subprocess.run", return_value=mock_result), \
         caplog.at_level(logging.ERROR, logger="services.calibration"):
        CalibrationService._spawn_retrain_subprocess()

    assert not any(r.levelno >= logging.ERROR for r in caplog.records)


# ── boundary tests ────────────────────────────────────────────────────────────

def test_get_report_warning_at_boundary(tmp_path):
    """Exactly 15% drift -> status is WARNING (not OK)."""
    metrics = {"adult": {"mae": 5.75, "n": 30, "bias": 0.3}}
    db = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({"calibration_baseline": {"adult": 5.0}}))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    cohort = report["cohorts"][0]
    assert cohort["status"] == "WARNING"
    assert cohort["drift_pct"] == pytest.approx(15.0, abs=0.01)


def test_get_report_alert_at_boundary(tmp_path):
    """Exactly 30% drift -> status is ALERT (not WARNING)."""
    metrics = {"adult": {"mae": 6.5, "n": 30, "bias": 0.5}}
    db = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({"calibration_baseline": {"adult": 5.0}}))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value=metrics), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    cohort = report["cohorts"][0]
    assert cohort["status"] == "ALERT"
    assert cohort["drift_pct"] == pytest.approx(30.0, abs=0.01)


# ── AUC computation tests ─────────────────────────────────────────────────────

def _make_auc_rows(n: int, prob_key: str, actual_key: str, alternating: bool = True):
    """Return a list of mock DB rows for AUC computation.

    alternating=True produces rows with alternating 0/1 labels and matching
    probabilities so roc_auc_score can be computed without degenerate classes.
    """
    rows = []
    for i in range(n):
        label = i % 2
        prob = 0.8 if label == 1 else 0.2
        row = MagicMock()
        row.__getitem__ = lambda self, k, _prob=prob, _label=label, _pk=prob_key, _ak=actual_key: (
            _prob if k == _pk else _label
        )
        # Also support attribute access style
        setattr(row, prob_key, prob)
        setattr(row, actual_key, label)
        rows.append(row)
    return rows


def test_compute_current_classifier_auc_returns_none_when_insufficient_data():
    """Fewer than 20 paired rows → _compute_current_classifier_auc returns None."""
    db = MagicMock()
    # Return only 10 rows — below the 20-row threshold
    mock_rows = [MagicMock() for _ in range(10)]
    for i, row in enumerate(mock_rows):
        row.responder_probability = 0.8 if i % 2 else 0.2
        row.overall_responder = i % 2
    db.execute.return_value.fetchall.return_value = mock_rows

    result = CalibrationService._compute_current_classifier_auc(db)

    assert result is None


def test_compute_current_dropout_auc_returns_none_when_insufficient_data():
    """Fewer than 20 paired rows → _compute_current_dropout_auc returns None."""
    db = MagicMock()
    mock_rows = [MagicMock() for _ in range(5)]
    for i, row in enumerate(mock_rows):
        row.dropout_probability = 0.8 if i % 2 else 0.2
        row.is_dropout = i % 2
    db.execute.return_value.fetchall.return_value = mock_rows

    result = CalibrationService._compute_current_dropout_auc(db)

    assert result is None


def test_compute_current_classifier_auc_returns_float_with_sufficient_data():
    """With ≥20 paired rows and non-degenerate labels, returns a float AUC."""
    db = MagicMock()
    mock_rows = []
    for i in range(30):
        row = MagicMock()
        row.responder_probability = 0.8 if i % 2 else 0.2
        row.overall_responder = i % 2
        mock_rows.append(row)
    db.execute.return_value.fetchall.return_value = mock_rows

    result = CalibrationService._compute_current_classifier_auc(db)

    assert result is not None
    assert 0.0 <= result <= 1.0


# ── AUC drift status tests ────────────────────────────────────────────────────

def test_auc_drift_status_ok_at_minus_3_pct(tmp_path):
    """AUC drift of -3% (current < baseline by 3%) → status is OK."""
    db = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    # baseline_auc=0.739, current=-3% → 0.739*0.97 ≈ 0.717 → drift=-3% → OK
    baseline_auc = 0.739
    current_auc = baseline_auc * 0.97
    state_file.write_text(json.dumps({
        "classifier_auc_baseline": baseline_auc,
        "dropout_auc_baseline": 0.998,
    }))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value={}), \
         patch.object(CalibrationService, "_compute_current_classifier_auc", return_value=current_auc), \
         patch.object(CalibrationService, "_compute_current_dropout_auc", return_value=0.998), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    clf_row = next(r for r in report["model_auc_drift"] if r["model"] == "classifier")
    assert clf_row["status"] == "OK"
    assert clf_row["drift_pct"] == pytest.approx(-3.0, abs=0.1)


def test_auc_drift_status_warning_at_minus_7_pct(tmp_path):
    """AUC drift of -7% → status is WARNING."""
    db = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    baseline_auc = 0.739
    current_auc = baseline_auc * 0.93  # -7%
    state_file.write_text(json.dumps({
        "classifier_auc_baseline": baseline_auc,
        "dropout_auc_baseline": 0.998,
    }))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value={}), \
         patch.object(CalibrationService, "_compute_current_classifier_auc", return_value=current_auc), \
         patch.object(CalibrationService, "_compute_current_dropout_auc", return_value=0.998), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    clf_row = next(r for r in report["model_auc_drift"] if r["model"] == "classifier")
    assert clf_row["status"] == "WARNING"
    assert clf_row["drift_pct"] == pytest.approx(-7.0, abs=0.1)


def test_auc_drift_status_alert_at_minus_12_pct(tmp_path):
    """AUC drift of -12% → status is ALERT."""
    db = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    baseline_auc = 0.739
    current_auc = baseline_auc * 0.88  # -12%
    state_file.write_text(json.dumps({
        "classifier_auc_baseline": baseline_auc,
        "dropout_auc_baseline": 0.998,
    }))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value={}), \
         patch.object(CalibrationService, "_compute_current_classifier_auc", return_value=current_auc), \
         patch.object(CalibrationService, "_compute_current_dropout_auc", return_value=0.998), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    clf_row = next(r for r in report["model_auc_drift"] if r["model"] == "classifier")
    assert clf_row["status"] == "ALERT"
    assert clf_row["drift_pct"] == pytest.approx(-12.0, abs=0.15)


def test_get_report_includes_model_auc_drift_key(tmp_path):
    """get_report() response must include model_auc_drift with classifier and dropout entries."""
    db = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({
        "classifier_auc_baseline": 0.739,
        "dropout_auc_baseline": 0.998,
    }))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value={}), \
         patch.object(CalibrationService, "_compute_current_classifier_auc", return_value=0.739), \
         patch.object(CalibrationService, "_compute_current_dropout_auc", return_value=0.998), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    assert "model_auc_drift" in report
    models = {r["model"] for r in report["model_auc_drift"]}
    assert "classifier" in models
    assert "dropout" in models
    for row in report["model_auc_drift"]:
        assert "baseline_auc" in row
        assert "current_auc" in row
        assert "drift_pct" in row
        assert "status" in row
        assert "n" in row


def test_auc_drift_pct_is_none_when_current_auc_is_none(tmp_path):
    """When current_auc is None (insufficient data), drift_pct must be None."""
    db = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({
        "classifier_auc_baseline": 0.739,
        "dropout_auc_baseline": 0.998,
    }))

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value={}), \
         patch.object(CalibrationService, "_compute_current_classifier_auc", return_value=None), \
         patch.object(CalibrationService, "_compute_current_dropout_auc", return_value=None), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    for row in report["model_auc_drift"]:
        assert row["drift_pct"] is None
        assert row["current_auc"] is None


def test_auc_drift_no_baseline_status(tmp_path):
    """When classifier_auc_baseline is absent from state, status is NO_BASELINE."""
    db = MagicMock()
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps({}))  # no AUC baselines

    with patch.object(CalibrationService, "compute_cohort_metrics", return_value={}), \
         patch.object(CalibrationService, "_compute_current_classifier_auc", return_value=0.739), \
         patch.object(CalibrationService, "_compute_current_dropout_auc", return_value=0.998), \
         patch("services.calibration._STATE_PATH", state_file):
        report = CalibrationService.get_report(db)

    for row in report["model_auc_drift"]:
        assert row["status"] == "NO_BASELINE"
        assert row["baseline_auc"] is None
        assert row["drift_pct"] is None
