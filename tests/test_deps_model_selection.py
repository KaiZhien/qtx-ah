"""Tests for model selection in deps.py."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'api'))

import importlib


def test_load_models_uses_baseline_regression(monkeypatch):
    """_get_model_files returns the baseline regression_xgb.joblib."""
    import deps
    importlib.reload(deps)

    model_files = deps._get_model_files()
    assert model_files["regression"].name == "regression_xgb.joblib"
