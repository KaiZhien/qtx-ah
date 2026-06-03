"""Unit tests for RetrainService.check_and_trigger threshold logic."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))


def _make_state(last_count: int, state_path: Path) -> None:
    state_path.write_text(json.dumps({
        "last_retrain_session_count": last_count,
        "last_retrain_at": "2026-01-01T00:00:00",
        "last_metrics": {"rmse_mean": 0.70, "r2_mean": 0.06, "auc_roc_mean": 0.89},
    }))


def test_no_trigger_when_below_threshold(tmp_path):
    state_file = tmp_path / "retrain_state.json"
    _make_state(100, state_file)
    from services.retrain import RetrainService
    with patch("subprocess.Popen") as mock_popen:
        RetrainService(state_path=state_file, threshold=50).check_and_trigger(130)
        mock_popen.assert_not_called()


def test_triggers_when_at_threshold(tmp_path):
    state_file = tmp_path / "retrain_state.json"
    _make_state(100, state_file)
    from services.retrain import RetrainService
    with patch("subprocess.Popen") as mock_popen:
        RetrainService(state_path=state_file, threshold=50).check_and_trigger(150)
        mock_popen.assert_called_once()


def test_triggers_when_above_threshold(tmp_path):
    state_file = tmp_path / "retrain_state.json"
    _make_state(100, state_file)
    from services.retrain import RetrainService
    with patch("subprocess.Popen") as mock_popen:
        RetrainService(state_path=state_file, threshold=50).check_and_trigger(200)
        mock_popen.assert_called_once()


def test_no_state_file_treats_last_count_as_zero(tmp_path):
    state_file = tmp_path / "retrain_state.json"
    from services.retrain import RetrainService
    with patch("subprocess.Popen") as mock_popen:
        RetrainService(state_path=state_file, threshold=50).check_and_trigger(60)
        mock_popen.assert_called_once()


def test_no_trigger_when_same_count(tmp_path):
    state_file = tmp_path / "retrain_state.json"
    _make_state(150, state_file)
    from services.retrain import RetrainService
    with patch("subprocess.Popen") as mock_popen:
        RetrainService(state_path=state_file, threshold=50).check_and_trigger(150)
        mock_popen.assert_not_called()
