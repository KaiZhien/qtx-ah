"""Unit tests for RetrainService.check_and_trigger threshold logic."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))


def _make_state(last_count: int, state_path: Path) -> None:
    state_path.write_text(json.dumps({
        "last_retrain_session_count": last_count,
        "last_retrain_at": "2026-01-01T00:00:00",
        "last_metrics": {"rmse_mean": 0.70, "r2_mean": 0.06, "auc_roc_mean": 0.89},
    }))


def _mock_bg():
    return MagicMock()


def test_no_trigger_when_below_threshold(tmp_path):
    state_file = tmp_path / "retrain_state.json"
    _make_state(100, state_file)
    from services.retrain import RetrainService
    bg = _mock_bg()
    RetrainService(state_path=state_file, threshold=50).check_and_trigger(130, bg)
    bg.add_task.assert_not_called()


def test_triggers_when_at_threshold(tmp_path):
    state_file = tmp_path / "retrain_state.json"
    _make_state(100, state_file)
    from services.retrain import RetrainService
    bg = _mock_bg()
    RetrainService(state_path=state_file, threshold=50).check_and_trigger(150, bg)
    bg.add_task.assert_called_once()


def test_triggers_when_above_threshold(tmp_path):
    state_file = tmp_path / "retrain_state.json"
    _make_state(100, state_file)
    from services.retrain import RetrainService
    bg = _mock_bg()
    RetrainService(state_path=state_file, threshold=50).check_and_trigger(200, bg)
    bg.add_task.assert_called_once()


def test_no_state_file_treats_last_count_as_zero(tmp_path):
    state_file = tmp_path / "retrain_state.json"
    from services.retrain import RetrainService
    bg = _mock_bg()
    RetrainService(state_path=state_file, threshold=50).check_and_trigger(60, bg)
    bg.add_task.assert_called_once()


def test_no_trigger_when_same_count(tmp_path):
    state_file = tmp_path / "retrain_state.json"
    _make_state(150, state_file)
    from services.retrain import RetrainService
    bg = _mock_bg()
    RetrainService(state_path=state_file, threshold=50).check_and_trigger(150, bg)
    bg.add_task.assert_not_called()


def test_add_task_receives_spawn_method(tmp_path):
    """add_task should be called with _spawn_retrain_subprocess."""
    state_file = tmp_path / "retrain_state.json"
    _make_state(0, state_file)
    from services.retrain import RetrainService
    svc = RetrainService(state_path=state_file, threshold=50)
    bg = _mock_bg()
    svc.check_and_trigger(60, bg)
    bg.add_task.assert_called_once_with(svc._spawn_retrain_subprocess)


def test_spawn_retrain_subprocess_logs_error_on_nonzero_exit(tmp_path, caplog):
    """_spawn_retrain_subprocess logs an error when the script exits non-zero."""
    import logging
    from services.retrain import RetrainService
    svc = RetrainService(state_path=tmp_path / "state.json", threshold=50)

    mock_result = MagicMock()
    mock_result.returncode = 1

    with patch("subprocess.run", return_value=mock_result), \
         caplog.at_level(logging.ERROR, logger="services.retrain"):
        svc._spawn_retrain_subprocess()

    assert any("non-zero code" in r.message for r in caplog.records)


def test_spawn_retrain_subprocess_no_error_on_zero_exit(tmp_path, caplog):
    """_spawn_retrain_subprocess does not log an error when the script succeeds."""
    import logging
    from services.retrain import RetrainService
    svc = RetrainService(state_path=tmp_path / "state.json", threshold=50)

    mock_result = MagicMock()
    mock_result.returncode = 0

    with patch("subprocess.run", return_value=mock_result), \
         caplog.at_level(logging.ERROR, logger="services.retrain"):
        svc._spawn_retrain_subprocess()

    assert not any(r.levelno >= logging.ERROR for r in caplog.records)
