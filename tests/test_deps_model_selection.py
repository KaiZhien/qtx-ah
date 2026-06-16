"""Tests for augmented model selection in deps.py."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'api'))

import importlib
import pytest
from pathlib import Path


def test_load_models_uses_baseline_by_default(monkeypatch):
    """Without QTX_USE_RAISE_AUGMENTED, _get_model_files returns regression_xgb.joblib."""
    monkeypatch.delenv("QTX_USE_RAISE_AUGMENTED", raising=False)
    import deps
    importlib.reload(deps)

    model_files = deps._get_model_files()
    assert model_files["regression"].name == "regression_xgb.joblib"


def test_load_models_uses_augmented_when_flag_set_and_file_exists(tmp_path, monkeypatch):
    """With QTX_USE_RAISE_AUGMENTED=1 and file present, uses augmented model."""
    monkeypatch.setenv("QTX_USE_RAISE_AUGMENTED", "1")
    import deps
    importlib.reload(deps)

    # Create a dummy augmented file so path.exists() returns True
    augmented_path = Path(deps.MODELS_DIR) / "regression_xgb_raise_augmented.joblib"
    augmented_path.parent.mkdir(parents=True, exist_ok=True)
    augmented_path.touch()

    try:
        model_files = deps._get_model_files()
        assert model_files["regression"].name == "regression_xgb_raise_augmented.joblib"
    finally:
        augmented_path.unlink(missing_ok=True)


def test_load_models_falls_back_to_baseline_if_augmented_missing(monkeypatch):
    """With QTX_USE_RAISE_AUGMENTED=1 but augmented file absent, falls back to baseline."""
    monkeypatch.setenv("QTX_USE_RAISE_AUGMENTED", "1")
    import deps
    importlib.reload(deps)

    augmented_path = Path(deps.MODELS_DIR) / "regression_xgb_raise_augmented.joblib"
    # Only meaningful when augmented file doesn't exist
    if not augmented_path.exists():
        model_files = deps._get_model_files()
        assert model_files["regression"].name == "regression_xgb.joblib"
    else:
        pytest.skip("augmented model file exists — fallback not testable in this env")
