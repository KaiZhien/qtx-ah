"""Tests for scripts/18_scheduled_retrain.py (config-driven retrain + promotion gate)."""
from __future__ import annotations

import importlib.util
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

import joblib
import numpy as np
import pandas as pd
import pytest

# The script filename starts with a digit so it cannot be imported via normal import
# machinery. Use importlib to load it directly without running main().
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "api"))

from qtx.utils.config import get_models_config  # noqa: E402

_SCRIPT_PATH = ROOT / "scripts" / "18_scheduled_retrain.py"
_spec = importlib.util.spec_from_file_location("scheduled_retrain", _SCRIPT_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]

_build_training_matrix = _mod._build_training_matrix


# ---------------------------------------------------------------------------
# Synthetic data
# ---------------------------------------------------------------------------

def _synthetic_frame(n_patients: int = 40, per: int = 3, seed: int = 0) -> pd.DataFrame:
    """Frame mimicking _load_qtx_sessions output: features + all three targets."""
    rng = np.random.default_rng(seed)
    cohorts = ["Pain & Musculoskeletal", "Neurological", "Frailty/Sarcopenia"]
    usages = ["Once / week", "Twice / week"]
    indications = ["Knee OA", "Back pain", "Stroke"]
    rows = []
    for _ in range(n_patients):
        pid = str(uuid.uuid4())
        for sn in range(1, per + 1):
            has_oa = float(rng.integers(0, 2))
            has_diabetes = float(rng.integers(0, 2))
            comp = float(rng.normal(0.0, 1.0))
            rows.append({
                "session_id": str(uuid.uuid4()),
                "patient_id": pid,
                "age": float(rng.integers(50, 90)),
                "gender": str(rng.choice(["M", "F"])),
                "cohort": str(rng.choice(cohorts)),
                "usage_frequency": str(rng.choice(usages)),
                "primary_indication": str(rng.choice(indications)),
                "baseline_sppb": float(rng.integers(4, 12)),
                "pre_tug_s": float(rng.normal(15, 3)),
                "pre_vas": float(rng.integers(0, 10)),
                "pre_5xsst_s": float(rng.normal(20, 4)),
                "pre_normal_gs_ms": float(rng.normal(0.9, 0.2)),
                "pre_fast_gs_ms": float(rng.normal(1.3, 0.2)),
                "has_oa": has_oa,
                "has_diabetes": has_diabetes,
                "n_flags": has_oa + has_diabetes,
                "n_groups": 1.0,
                "n_regions": 1.0,
                "session_number": float(sn),
                "prior_avg_composite_improvement": float(rng.normal(0, 0.5)),
                "trend_tug_magnitude": float(rng.normal(0, 1)),
                "composite_improvement": comp,
                "overall_responder": int(comp > 0),
                "is_dropout": int(rng.integers(0, 2)),
            })
    return pd.DataFrame(rows)


def _write_dummy_incumbents(models_dir: Path) -> None:
    # joblib dump/load here operates only on first-party files written into a
    # pytest tmp_path — never untrusted input — so it is safe.
    models_dir.mkdir(parents=True, exist_ok=True)
    for spec in _mod._MODEL_SPECS.values():
        joblib.dump({"incumbent": True}, models_dir / spec["artifact"])


# ---------------------------------------------------------------------------
# _build_training_matrix (alignment helper — still used for scoring)
# ---------------------------------------------------------------------------

class TestBuildTrainingMatrix:
    def test_handles_missing_features_with_zeros(self):
        df = pd.DataFrame({"age": [30.0, 40.0, 50.0]})
        result = _build_training_matrix(df, ["age", "nonexistent_feature"])
        assert result.shape == (3, 2)
        np.testing.assert_array_equal(result[:, 0], [30.0, 40.0, 50.0])
        np.testing.assert_array_equal(result[:, 1], [0.0, 0.0, 0.0])

    def test_handles_categorical_encoding(self):
        df = pd.DataFrame({"age": [30.0, 40.0], "cohort": ["A", "B"]})
        result = _build_training_matrix(df, ["age", "cohort_A", "cohort_B"])
        assert result.shape == (2, 3)
        assert result[0, 1] == 1.0 and result[0, 2] == 0.0
        assert result[1, 1] == 0.0 and result[1, 2] == 1.0

    def test_encodes_primary_indication(self):
        df = pd.DataFrame({"age": [30.0], "primary_indication": ["Knee OA"]})
        result = _build_training_matrix(df, ["age", "primary_indication_Knee OA"])
        assert result[0, 1] == 1.0

    def test_returns_numpy_array(self):
        assert isinstance(_build_training_matrix(pd.DataFrame({"x": [1.0, 2.0]}), ["x"]), np.ndarray)

    def test_fills_nan_with_zero(self):
        result = _build_training_matrix(pd.DataFrame({"age": [30.0, float("nan"), 50.0]}), ["age"])
        assert result[1, 0] == 0.0


# ---------------------------------------------------------------------------
# F1 — config feature parity + categorical encoding
# ---------------------------------------------------------------------------

class TestFeatureParity:
    def test_retrain_feature_list_matches_config(self):
        cfg = get_models_config()
        assert _mod._retrain_feature_list("regression") == cfg["regression_composite"]["features"]
        assert _mod._retrain_feature_list("classifier") == cfg["classifier_responder"]["features"]
        assert _mod._retrain_feature_list("dropout") == cfg["dropout"]["features"]

    def test_previously_omitted_categoricals_are_present(self):
        for model_name in ("regression", "classifier", "dropout"):
            feats = _mod._retrain_feature_list(model_name)
            for cat in ("gender", "cohort", "usage_frequency", "primary_indication"):
                assert cat in feats, f"{cat} missing from {model_name} feature list"

    def test_design_matrix_encodes_categoricals(self):
        df = _synthetic_frame(20, 1, seed=5)
        X, feats = _mod._build_design_matrix(df, "regression_composite")
        # raw categorical names replaced by prefix-encoded dummies
        for raw in ("gender", "cohort", "usage_frequency", "primary_indication"):
            assert raw not in feats
        assert any(f.startswith("gender_") for f in feats)
        assert any(f.startswith("cohort_") for f in feats)
        assert any(f.startswith("primary_indication_") for f in feats)
        assert list(X.columns) == feats


# ---------------------------------------------------------------------------
# _fit_model / _score_model
# ---------------------------------------------------------------------------

class TestFitModel:
    def test_regression_returns_servable_model(self):
        fit = _mod._fit_model(_synthetic_frame(30, 2, seed=1), "regression")
        assert fit is not None
        model, feats = fit
        assert list(model.feature_names_in_) == feats
        assert any(f.startswith("cohort_") for f in feats)
        assert "cohort" not in feats and "gender" not in feats

    def test_classifier_and_dropout_return_proba_models(self):
        df = _synthetic_frame(30, 2, seed=2)
        for name in ("classifier", "dropout"):
            fit = _mod._fit_model(df, name)
            assert fit is not None
            assert hasattr(fit[0], "predict_proba")

    def test_insufficient_data_returns_none(self):
        assert _mod._fit_model(_synthetic_frame(3, 1, seed=1), "classifier") is None

    def test_missing_target_returns_none(self):
        df = _synthetic_frame(30, 1, seed=1).drop(columns=["is_dropout"])
        assert _mod._fit_model(df, "dropout") is None


class TestScoreModel:
    def test_regression_metrics(self):
        df = _synthetic_frame(30, 2, seed=3)
        model, _ = _mod._fit_model(df, "regression")
        metrics = _mod._score_model(model, df, "regression")
        assert {"rmse", "r2", "n"} <= set(metrics)

    def test_binary_metrics(self):
        df = _synthetic_frame(30, 2, seed=4)
        model, _ = _mod._fit_model(df, "classifier")
        metrics = _mod._score_model(model, df, "classifier")
        assert "auc" in metrics

    def test_none_model_scores_none(self):
        assert _mod._score_model(None, _synthetic_frame(5, 1), "regression") is None


# ---------------------------------------------------------------------------
# F2 — promotion gate
# ---------------------------------------------------------------------------

class TestPromotionGate:
    def test_rejects_worse_regression_candidate(self):
        assert _mod._promotion_decision(
            "regression", {"rmse": 0.60, "r2": 0.10}, {"rmse": 0.50, "r2": 0.20}) is False

    def test_promotes_better_or_equal_regression_candidate(self):
        assert _mod._promotion_decision(
            "regression", {"rmse": 0.40, "r2": 0.30}, {"rmse": 0.50, "r2": 0.20}) is True
        # exactly equal → still promoted (>= incumbent)
        assert _mod._promotion_decision(
            "regression", {"rmse": 0.50, "r2": 0.20}, {"rmse": 0.50, "r2": 0.20}) is True

    def test_rejects_worse_classifier_candidate(self):
        assert _mod._promotion_decision("classifier", {"auc": 0.60}, {"auc": 0.70}) is False

    def test_promotes_better_classifier_candidate(self):
        assert _mod._promotion_decision("classifier", {"auc": 0.80}, {"auc": 0.70}) is True

    def test_never_auto_accepts_without_incumbent(self):
        # No comparable incumbent → never auto-accept, even on a "perfect" candidate.
        assert _mod._promotion_decision("classifier", {"auc": 0.99}, None) is False
        assert _mod._promotion_decision("regression", {"rmse": 0.0, "r2": 1.0}, None) is False

    def test_rejects_when_candidate_unscoreable(self):
        assert _mod._promotion_decision("classifier", None, {"auc": 0.70}) is False


# ---------------------------------------------------------------------------
# F2 — fixed eval set creation + train/eval exclusion
# ---------------------------------------------------------------------------

class TestEvalSet:
    def test_created_and_patient_grouped_and_excluded_from_training(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_mod, "MODELS_DIR", tmp_path)
        df = _synthetic_frame(30, 3, seed=7)

        eval_df = _mod._ensure_eval_set(df, seed=42)
        assert _mod._eval_parquet_path().exists()
        assert _mod._eval_manifest_path().exists()

        eval_ids = _mod._load_eval_manifest_ids()
        assert 0 < len(eval_ids) < len(df)

        train_df = _mod._training_frame(df, eval_ids)
        # eval rows are held out of training
        assert set(train_df["session_id"]) & eval_ids == set()
        # patient-grouped: no patient appears in both splits
        assert set(train_df["patient_id"]) & set(eval_df["patient_id"]) == set()

    def test_second_call_is_stable(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_mod, "MODELS_DIR", tmp_path)
        df = _synthetic_frame(30, 3, seed=8)
        first = set(_mod._ensure_eval_set(df, seed=42)["session_id"])
        # a differently-shuffled frame must NOT change the frozen eval set
        second = set(_mod._ensure_eval_set(df.sample(frac=1.0, random_state=1), seed=99)["session_id"])
        assert first == second


# ---------------------------------------------------------------------------
# F2 — end-to-end gate via _run_retrain
# ---------------------------------------------------------------------------

class TestRunRetrainGate:
    def test_first_run_creates_eval_set_and_does_not_auto_accept(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_mod, "MODELS_DIR", tmp_path)
        monkeypatch.setattr(_mod, "STATE_PATH", tmp_path / "retrain_state.json")
        df = _synthetic_frame(40, 3, seed=11)

        summary = _mod._run_retrain(df=df, run_side_effects=False)

        # eval set created on first run
        assert _mod._eval_parquet_path().exists()
        assert _mod._eval_manifest_path().exists()
        # no incumbent existed → nothing auto-accepted, no artifact written
        for name, spec in _mod._MODEL_SPECS.items():
            assert summary[name]["promoted"] is False
            assert not (tmp_path / spec["artifact"]).exists()

    def test_promotes_when_candidate_beats_incumbent(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_mod, "MODELS_DIR", tmp_path)
        monkeypatch.setattr(_mod, "STATE_PATH", tmp_path / "retrain_state.json")
        monkeypatch.setattr(_mod, "_compute_calibration_baseline", lambda: {})
        _write_dummy_incumbents(tmp_path)

        cand = SimpleNamespace(feature_names_in_=np.array(["age"]))
        monkeypatch.setattr(_mod, "_fit_model", lambda tdf, name: (cand, ["age"]))
        monkeypatch.setattr(
            _mod, "_score_model",
            lambda model, edf, name: ({"rmse": 0.1, "r2": 0.9, "auc": 0.95, "n": 10}
                                      if model is cand else
                                      {"rmse": 0.5, "r2": 0.1, "auc": 0.60, "n": 10}),
        )

        summary = _mod._run_retrain(df=_synthetic_frame(40, 3, seed=12), run_side_effects=False)

        for name, spec in _mod._MODEL_SPECS.items():
            assert summary[name]["promoted"] is True
            assert (tmp_path / spec["artifact"]).exists()
            assert (tmp_path / f"{spec['artifact']}.meta.json").exists()

    def test_rejects_when_candidate_worse_than_incumbent(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_mod, "MODELS_DIR", tmp_path)
        monkeypatch.setattr(_mod, "STATE_PATH", tmp_path / "retrain_state.json")
        _write_dummy_incumbents(tmp_path)

        cand = SimpleNamespace(feature_names_in_=np.array(["age"]))
        monkeypatch.setattr(_mod, "_fit_model", lambda tdf, name: (cand, ["age"]))
        monkeypatch.setattr(
            _mod, "_score_model",
            lambda model, edf, name: ({"rmse": 0.9, "r2": 0.0, "auc": 0.50, "n": 10}
                                      if model is cand else
                                      {"rmse": 0.4, "r2": 0.3, "auc": 0.80, "n": 10}),
        )

        summary = _mod._run_retrain(df=_synthetic_frame(40, 3, seed=13), run_side_effects=False)

        for name, spec in _mod._MODEL_SPECS.items():
            assert summary[name]["promoted"] is False
            # incumbent artifact left untouched
            assert joblib.load(tmp_path / spec["artifact"]) == {"incumbent": True}


# ---------------------------------------------------------------------------
# F3 — concurrency lock
# ---------------------------------------------------------------------------

class TestLock:
    def test_second_acquire_blocked_then_freed(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_mod, "MODELS_DIR", tmp_path)
        fd1 = _mod._acquire_lock()
        assert fd1 is not None
        assert _mod._acquire_lock() is None  # already held
        _mod._release_lock(fd1)
        fd3 = _mod._acquire_lock()  # freed → acquirable again
        assert fd3 is not None
        _mod._release_lock(fd3)

    def test_main_exits_cleanly_when_locked(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_mod, "MODELS_DIR", tmp_path)
        fd = _mod._acquire_lock()
        assert fd is not None
        called: list[int] = []
        monkeypatch.setattr(_mod, "_run_retrain", lambda *a, **k: called.append(1))
        try:
            _mod.main()  # lock held → must not run the retrain body
            assert called == []
        finally:
            _mod._release_lock(fd)
