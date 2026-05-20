# Approach B — XGBoost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add XGBoost as a second estimator running alongside sklearn GradientBoosting for all three models, with both shown fully in the HTML report.

**Architecture:** Each `train_*` function gains an `estimator_type="gbm"` parameter. When `"xgb"`, a `Pipeline([("model", XGBClassifier/XGBRegressor)])` is built (no imputer — XGB handles NaN natively). `RandomizedSearchCV` wraps it with XGB-specific param distributions from a new `tuning_xgb` config block. `scripts/06_train_models.py` calls both variants per model; `build_report` gains a `_render_model_subsection` helper and renders each model as two subsections (GBM and XGBoost).

**Tech Stack:** xgboost ^2.0, scikit-learn Pipeline, RandomizedSearchCV, existing GradientBoosting + evaluate.py helpers, pytest.

---

## File Map

| File | Change |
|---|---|
| `pyproject.toml` | Add `xgboost = "^2.0"` |
| `config/models.yaml` | Add `tuning_xgb:` block |
| `src/qtx/models/evaluate.py` | Add `_build_xgb_estimator(task, seed)` after `_build_sklearn_imputer` |
| `src/qtx/models/classifier.py` | Add `estimator_type="gbm"` param + XGB branch |
| `src/qtx/models/regression.py` | Same as classifier |
| `src/qtx/models/dropout.py` | Same as classifier |
| `scripts/06_train_models.py` | Call both variants; add `_render_model_subsection` helper; update `build_report`; rename artefacts |
| `tests/test_models.py` | Add 7 XGB-specific tests |

---

## Task 1 — Add XGBoost dependency and tuning_xgb config

**Files:**
- Modify: `pyproject.toml`
- Modify: `config/models.yaml`
- Modify: `tests/test_models.py`

- [ ] **Step 1: Write the failing config test**

Add at the bottom of `tests/test_models.py`:

```python
# ---------------------------------------------------------------------------
# tuning_xgb config test
# ---------------------------------------------------------------------------

def test_config_has_tuning_xgb_block():
    cfg = get_models_config()
    assert "tuning_xgb" in cfg, "Expected tuning_xgb block in models.yaml"
    assert "colsample_bytree" in cfg["tuning_xgb"]["param_distributions"]
    assert cfg["tuning_xgb"]["n_iter"] == 30
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PYTHONPATH=src .venv/bin/pytest tests/test_models.py::test_config_has_tuning_xgb_block -v
```

Expected: FAIL with `AssertionError: Expected tuning_xgb block in models.yaml`

- [ ] **Step 3: Add xgboost to pyproject.toml**

In `pyproject.toml`, add `xgboost = "^2.0"` to `[tool.poetry.dependencies]`:

```toml
[tool.poetry.dependencies]
python = ">=3.11,<3.13"
pandas = "^2.2"
numpy = "^1.26"
pyarrow = "^15.0"
openpyxl = "^3.1"
pyyaml = "^6.0"
scikit-learn = "^1.4"
statsmodels = "^0.14"
miceforest = "^5.0"
shap = "^0.44"
plotly = "^5.20"
matplotlib = "^3.8"
streamlit = "^1.32"
rich = "^13.7"
pydantic = "^2.6"
pandera = "^0.18"
jinja2 = "^3.1"
xgboost = "^2.0"
```

- [ ] **Step 4: Install the new dependency**

```bash
.venv/bin/pip install "xgboost>=2.0,<3.0"
```

Expected output: `Successfully installed xgboost-...`

- [ ] **Step 5: Add tuning_xgb block to config/models.yaml**

Append to the end of `config/models.yaml` (after the existing `tuning:` block):

```yaml
tuning_xgb:
  n_iter: 30
  cv: 5
  param_distributions:
    n_estimators: [100, 200, 300, 500]
    learning_rate: [0.01, 0.05, 0.1, 0.2]
    max_depth: [2, 3, 4, 6]
    subsample: [0.7, 0.8, 1.0]
    min_child_weight: [1, 3, 5, 10]
    colsample_bytree: [0.6, 0.8, 1.0]
```

- [ ] **Step 6: Run test to verify it passes**

```bash
PYTHONPATH=src .venv/bin/pytest tests/test_models.py::test_config_has_tuning_xgb_block -v
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add pyproject.toml config/models.yaml tests/test_models.py
git commit -m "feat(config): add xgboost dependency and tuning_xgb config block"
```

---

## Task 2 — Write all failing XGB tests

**Files:**
- Modify: `tests/test_models.py`

Add all new tests at the bottom of `tests/test_models.py`. Do NOT implement anything yet.

- [ ] **Step 1: Add all XGB tests**

Append to `tests/test_models.py`:

```python
# ---------------------------------------------------------------------------
# _build_xgb_estimator tests
# ---------------------------------------------------------------------------

def test_build_xgb_estimator_classifier():
    from xgboost import XGBClassifier
    from qtx.models.evaluate import _build_xgb_estimator
    est = _build_xgb_estimator("classifier", seed=42)
    assert isinstance(est, XGBClassifier)


def test_build_xgb_estimator_regressor():
    from xgboost import XGBRegressor
    from qtx.models.evaluate import _build_xgb_estimator
    est = _build_xgb_estimator("regressor", seed=42)
    assert isinstance(est, XGBRegressor)


# ---------------------------------------------------------------------------
# train_classifier XGB contract
# ---------------------------------------------------------------------------

def test_train_classifier_xgb_returns_best_params(featured_df):
    from qtx.models.classifier import train_classifier
    result = train_classifier(featured_df, estimator_type="xgb")
    assert result, "train_classifier(xgb) returned empty dict"
    assert "best_params" in result
    assert "n_estimators" in result["best_params"]


def test_train_classifier_xgb_model_is_pipeline(featured_df):
    from sklearn.pipeline import Pipeline
    from qtx.models.classifier import train_classifier
    result = train_classifier(featured_df, estimator_type="xgb")
    assert isinstance(result["model"], Pipeline)


# ---------------------------------------------------------------------------
# train_regression XGB contract
# ---------------------------------------------------------------------------

def test_train_regression_xgb_returns_best_params(featured_df):
    from qtx.models.regression import train_regression
    result = train_regression(featured_df, estimator_type="xgb")
    assert result, "train_regression(xgb) returned empty dict"
    assert "best_params" in result
    assert "n_estimators" in result["best_params"]


# ---------------------------------------------------------------------------
# train_dropout XGB contract
# ---------------------------------------------------------------------------

def test_train_dropout_xgb_returns_best_params(featured_df):
    from qtx.models.dropout import train_dropout
    result = train_dropout(featured_df, estimator_type="xgb")
    assert result, "train_dropout(xgb) returned empty dict"
    assert "best_params" in result
    assert "n_estimators" in result["best_params"]
```

- [ ] **Step 2: Run all new tests to verify they all fail**

```bash
PYTHONPATH=src .venv/bin/pytest tests/test_models.py -k "xgb" -v
```

Expected: all 7 FAIL (ImportError or AttributeError on `_build_xgb_estimator` / `estimator_type`)

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/test_models.py
git commit -m "test(models): add failing XGB contract tests"
```

---

## Task 3 — Add _build_xgb_estimator to evaluate.py

**Files:**
- Modify: `src/qtx/models/evaluate.py`

- [ ] **Step 1: Add _build_xgb_estimator after _build_sklearn_imputer**

In `src/qtx/models/evaluate.py`, insert the following function after the `_build_sklearn_imputer` function (after line 48, before the `# CV helpers` comment):

```python
def _build_xgb_estimator(task: str, seed: int):
    """Return an unfitted XGBoost estimator for use inside a Pipeline.

    task: "classifier" or "regressor"
    XGBoost handles NaN natively — no imputer step is needed alongside this estimator.
    """
    from xgboost import XGBClassifier, XGBRegressor

    common_kwargs = dict(random_state=seed, n_jobs=-1, verbosity=0, tree_method="hist")
    if task == "regressor":
        return XGBRegressor(**common_kwargs)
    return XGBClassifier(**common_kwargs)
```

- [ ] **Step 2: Run the imputer/estimator tests**

```bash
PYTHONPATH=src .venv/bin/pytest tests/test_models.py::test_build_xgb_estimator_classifier tests/test_models.py::test_build_xgb_estimator_regressor -v
```

Expected: both PASS

- [ ] **Step 3: Run full test suite to confirm no regressions**

```bash
PYTHONPATH=src .venv/bin/pytest tests/ -q
```

Expected: 91 passed (same as before), plus 2 new XGB estimator tests = 93 passed

- [ ] **Step 4: Commit**

```bash
git add src/qtx/models/evaluate.py
git commit -m "feat(evaluate): add _build_xgb_estimator factory"
```

---

## Task 4 — Update classifier.py with estimator_type

**Files:**
- Modify: `src/qtx/models/classifier.py`

The current `train_classifier` signature is:
```python
def train_classifier(df: pd.DataFrame, imputation_strategy: str = "iterative") -> dict:
```

- [ ] **Step 1: Add _DEFAULT_XGB_PARAM_GRID module constant**

After the existing `_DEFAULT_PARAM_GRID` dict in `classifier.py`, add:

```python
_DEFAULT_XGB_PARAM_GRID = {
    "n_estimators": [100, 200, 300, 500],
    "learning_rate": [0.01, 0.05, 0.1, 0.2],
    "max_depth": [2, 3, 4, 6],
    "subsample": [0.7, 0.8, 1.0],
    "min_child_weight": [1, 3, 5, 10],
    "colsample_bytree": [0.6, 0.8, 1.0],
}
```

- [ ] **Step 2: Update the train_classifier function**

Replace the entire `train_classifier` function with:

```python
def train_classifier(df: pd.DataFrame, imputation_strategy: str = "iterative", estimator_type: str = "gbm") -> dict:
    """Train overall_responder classifier.

    Returns: {model, cv_metrics, shap_df, feature_names, n, strategy, best_params, calibration, X, y}
    model is a fitted sklearn Pipeline. estimator_type: "gbm" (default) or "xgb".
    """
    seed = int(get_settings().get("random_seed", 42))
    feature_cols = _get_feature_cols()
    cv_config = _get_cv_config()
    tuning_key = "tuning_xgb" if estimator_type == "xgb" else "tuning"
    tuning_cfg = get_models_config().get(tuning_key, {})
    default_grid = _DEFAULT_XGB_PARAM_GRID if estimator_type == "xgb" else _DEFAULT_PARAM_GRID

    log.info(
        "train_classifier: strategy=%s, estimator=%s, features=%d",
        imputation_strategy, estimator_type, len(feature_cols),
    )

    df_out = df[df["overall_responder"].notna()].copy()
    log.info("train_classifier: %d rows with overall_responder", len(df_out))

    cols_to_use = [c for c in feature_cols if c in df_out.columns]
    df_model = df_out[cols_to_use + ["overall_responder"]].copy()
    df_model, dummy_cols = _encode_categoricals(df_model, _CAT_COLS)

    non_cat_cols = [c for c in cols_to_use if c not in _CAT_COLS]
    final_feature_cols = non_cat_cols + dummy_cols

    df_model = df_model.dropna(subset=["overall_responder"])

    X_raw = df_model[final_feature_cols].astype(float)
    y = df_model["overall_responder"].astype(int)

    n_samples = len(X_raw)
    log.info("train_classifier: final n=%d", n_samples)

    if n_samples < 10:
        log.error("train_classifier: too few samples (%d); skipping", n_samples)
        return {}

    if imputation_strategy == "complete_case":
        mask = ~X_raw.isna().any(axis=1)
        X_raw = X_raw[mask]
        y = y[mask]
        n_samples = len(X_raw)
        log.info("train_classifier: complete_case n=%d after NaN drop", n_samples)
        if n_samples < 10:
            log.error("train_classifier: complete_case yielded too few samples (%d); skipping", n_samples)
            return {}

    if estimator_type == "xgb":
        from xgboost import XGBClassifier
        base_model = XGBClassifier(random_state=seed, n_jobs=-1, verbosity=0, tree_method="hist")
        pipeline = Pipeline([("model", base_model)])
    else:
        sklearn_imputer = _build_sklearn_imputer(imputation_strategy, seed)
        base_model = GradientBoostingClassifier(random_state=seed)
        pipeline = Pipeline([("imputer", sklearn_imputer), ("model", base_model)])

    param_distributions = {
        "model__" + k: v
        for k, v in tuning_cfg.get("param_distributions", default_grid).items()
    }

    search = RandomizedSearchCV(
        pipeline,
        param_distributions,
        n_iter=tuning_cfg.get("n_iter", 30),
        cv=tuning_cfg.get("cv", 5),
        scoring="roc_auc",
        random_state=seed,
        n_jobs=-1,
        refit=True,
    )
    search.fit(X_raw, y)

    best_pipeline = search.best_estimator_
    best_params = {k.replace("model__", ""): v for k, v in search.best_params_.items()}
    log.info("train_classifier: best_params=%s", best_params)

    cv_metrics = cross_validate_classifier(best_pipeline, X_raw, y, cv_config)
    cv_metrics["n"] = n_samples

    if estimator_type == "xgb":
        X_for_shap = X_raw
    else:
        X_for_shap = pd.DataFrame(
            best_pipeline.named_steps["imputer"].transform(X_raw.values),
            columns=final_feature_cols,
        )

    try:
        shap_df = shap_importances(best_pipeline.named_steps["model"], X_for_shap)
    except Exception as e:
        log.warning("SHAP failed for classifier: %s", e)
        shap_df = pd.DataFrame(
            {"feature": final_feature_cols, "mean_abs_shap": [float("nan")] * len(final_feature_cols)}
        )

    try:
        calibration = calibration_data(best_pipeline, X_raw, y)
    except Exception as e:
        log.warning("Calibration failed for classifier: %s", e)
        import numpy as np
        calibration = (np.array([]), np.array([]))

    return {
        "model": best_pipeline,
        "cv_metrics": cv_metrics,
        "shap_df": shap_df,
        "feature_names": final_feature_cols,
        "n": n_samples,
        "strategy": imputation_strategy,
        "best_params": best_params,
        "calibration": calibration,
        "X": X_raw,
        "y": y,
    }
```

- [ ] **Step 3: Run the classifier XGB tests**

```bash
PYTHONPATH=src .venv/bin/pytest tests/test_models.py -k "classifier" -v
```

Expected: all classifier tests PASS (both existing GBM tests and new XGB tests)

- [ ] **Step 4: Run full test suite**

```bash
PYTHONPATH=src .venv/bin/pytest tests/ -q
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/qtx/models/classifier.py
git commit -m "feat(classifier): add estimator_type param with XGBoost branch"
```

---

## Task 5 — Update regression.py with estimator_type

**Files:**
- Modify: `src/qtx/models/regression.py`

- [ ] **Step 1: Add _DEFAULT_XGB_PARAM_GRID**

After the existing `_DEFAULT_PARAM_GRID` dict in `regression.py`, add:

```python
_DEFAULT_XGB_PARAM_GRID = {
    "n_estimators": [100, 200, 300, 500],
    "learning_rate": [0.01, 0.05, 0.1, 0.2],
    "max_depth": [2, 3, 4, 6],
    "subsample": [0.7, 0.8, 1.0],
    "min_child_weight": [1, 3, 5, 10],
    "colsample_bytree": [0.6, 0.8, 1.0],
}
```

- [ ] **Step 2: Update train_regression**

Replace the entire `train_regression` function with:

```python
def train_regression(df: pd.DataFrame, imputation_strategy: str = "iterative", estimator_type: str = "gbm") -> dict:
    """Train composite_improvement regression model.

    Returns: {model, cv_metrics, shap_df, feature_names, n, strategy, best_params}
    model is a fitted sklearn Pipeline. estimator_type: "gbm" (default) or "xgb".
    """
    seed = int(get_settings().get("random_seed", 42))
    feature_cols = _get_feature_cols()
    cv_config = _get_cv_config()
    tuning_key = "tuning_xgb" if estimator_type == "xgb" else "tuning"
    tuning_cfg = get_models_config().get(tuning_key, {})
    default_grid = _DEFAULT_XGB_PARAM_GRID if estimator_type == "xgb" else _DEFAULT_PARAM_GRID

    log.info(
        "train_regression: strategy=%s, estimator=%s, features=%d",
        imputation_strategy, estimator_type, len(feature_cols),
    )

    df_out = df[df["composite_improvement"].notna()].copy()
    log.info("train_regression: %d rows with composite_improvement", len(df_out))

    cols_to_use = [c for c in feature_cols if c in df_out.columns]
    df_model = df_out[cols_to_use + ["composite_improvement"]].copy()
    df_model, dummy_cols = _encode_categoricals(df_model, _CAT_COLS)

    non_cat_cols = [c for c in cols_to_use if c not in _CAT_COLS]
    final_feature_cols = non_cat_cols + dummy_cols

    df_model = df_model.dropna(subset=["composite_improvement"])

    X_raw = df_model[final_feature_cols].astype(float)
    y = df_model["composite_improvement"].astype(float)

    n_samples = len(X_raw)
    log.info("train_regression: final n=%d", n_samples)

    if n_samples < 10:
        log.error("train_regression: too few samples (%d); skipping", n_samples)
        return {}

    if imputation_strategy == "complete_case":
        mask = ~X_raw.isna().any(axis=1)
        X_raw = X_raw[mask]
        y = y[mask]
        n_samples = len(X_raw)
        log.info("train_regression: complete_case n=%d after NaN drop", n_samples)
        if n_samples < 10:
            log.error("train_regression: complete_case yielded too few samples (%d); skipping", n_samples)
            return {}

    if estimator_type == "xgb":
        from xgboost import XGBRegressor
        base_model = XGBRegressor(random_state=seed, n_jobs=-1, verbosity=0, tree_method="hist")
        pipeline = Pipeline([("model", base_model)])
    else:
        sklearn_imputer = _build_sklearn_imputer(imputation_strategy, seed)
        base_model = GradientBoostingRegressor(random_state=seed)
        pipeline = Pipeline([("imputer", sklearn_imputer), ("model", base_model)])

    param_distributions = {
        "model__" + k: v
        for k, v in tuning_cfg.get("param_distributions", default_grid).items()
    }

    search = RandomizedSearchCV(
        pipeline,
        param_distributions,
        n_iter=tuning_cfg.get("n_iter", 30),
        cv=tuning_cfg.get("cv", 5),
        scoring="neg_root_mean_squared_error",
        random_state=seed,
        n_jobs=-1,
        refit=True,
    )
    search.fit(X_raw, y)

    best_pipeline = search.best_estimator_
    best_params = {k.replace("model__", ""): v for k, v in search.best_params_.items()}
    log.info("train_regression: best_params=%s", best_params)

    cv_metrics = cross_validate_regression(best_pipeline, X_raw, y, cv_config)
    cv_metrics["n"] = n_samples

    if estimator_type == "xgb":
        X_for_shap = X_raw
    else:
        X_for_shap = pd.DataFrame(
            best_pipeline.named_steps["imputer"].transform(X_raw.values),
            columns=final_feature_cols,
        )

    try:
        shap_df = shap_importances(best_pipeline.named_steps["model"], X_for_shap)
    except Exception as e:
        log.warning("SHAP failed for regression: %s", e)
        shap_df = pd.DataFrame(
            {"feature": final_feature_cols, "mean_abs_shap": [float("nan")] * len(final_feature_cols)}
        )

    return {
        "model": best_pipeline,
        "cv_metrics": cv_metrics,
        "shap_df": shap_df,
        "feature_names": final_feature_cols,
        "n": n_samples,
        "strategy": imputation_strategy,
        "best_params": best_params,
    }
```

- [ ] **Step 3: Run regression XGB tests**

```bash
PYTHONPATH=src .venv/bin/pytest tests/test_models.py -k "regression" -v
```

Expected: all regression tests PASS

- [ ] **Step 4: Run full test suite**

```bash
PYTHONPATH=src .venv/bin/pytest tests/ -q
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/qtx/models/regression.py
git commit -m "feat(regression): add estimator_type param with XGBoost branch"
```

---

## Task 6 — Update dropout.py with estimator_type

**Files:**
- Modify: `src/qtx/models/dropout.py`

- [ ] **Step 1: Add _DEFAULT_XGB_PARAM_GRID**

After the existing `_DEFAULT_PARAM_GRID` dict in `dropout.py`, add:

```python
_DEFAULT_XGB_PARAM_GRID = {
    "n_estimators": [100, 200, 300, 500],
    "learning_rate": [0.01, 0.05, 0.1, 0.2],
    "max_depth": [2, 3, 4, 6],
    "subsample": [0.7, 0.8, 1.0],
    "min_child_weight": [1, 3, 5, 10],
    "colsample_bytree": [0.6, 0.8, 1.0],
}
```

- [ ] **Step 2: Update train_dropout**

Replace the entire `train_dropout` function with:

```python
def train_dropout(df: pd.DataFrame, imputation_strategy: str = "iterative", estimator_type: str = "gbm") -> dict:
    """Train dropout classifier: predict is_dropout from baseline features only.

    All rows are usable (dropout status known for all 1716).
    Returns: {model, cv_metrics, shap_df, feature_names, n, strategy, best_params}
    model is a fitted sklearn Pipeline. estimator_type: "gbm" (default) or "xgb".
    """
    seed = int(get_settings().get("random_seed", 42))
    feature_cols = _get_feature_cols()
    tuning_key = "tuning_xgb" if estimator_type == "xgb" else "tuning"
    tuning_cfg = get_models_config().get(tuning_key, {})
    default_grid = _DEFAULT_XGB_PARAM_GRID if estimator_type == "xgb" else _DEFAULT_PARAM_GRID
    cv_config = {"kind": "stratified_kfold", "k": 5}

    log.info(
        "train_dropout: strategy=%s, estimator=%s, features=%d",
        imputation_strategy, estimator_type, len(feature_cols),
    )

    df_out = df[df["is_dropout"].notna()].copy()
    log.info("train_dropout: %d rows with is_dropout", len(df_out))

    cols_to_use = [c for c in feature_cols if c in df_out.columns]
    df_model = df_out[cols_to_use + ["is_dropout"]].copy()
    df_model, dummy_cols = _encode_categoricals(df_model, _CAT_COLS)

    non_cat_cols = [c for c in cols_to_use if c not in _CAT_COLS]
    final_feature_cols = non_cat_cols + dummy_cols

    df_model = df_model.dropna(subset=["is_dropout"])

    X_raw = df_model[final_feature_cols].astype(float)
    y = df_model["is_dropout"].astype(int)

    n_samples = len(X_raw)
    log.info("train_dropout: final n=%d", n_samples)

    if n_samples < 10:
        log.error("train_dropout: too few samples (%d); skipping", n_samples)
        return {}

    if imputation_strategy == "complete_case":
        mask = ~X_raw.isna().any(axis=1)
        X_raw = X_raw[mask]
        y = y[mask]
        n_samples = len(X_raw)
        log.info("train_dropout: complete_case n=%d after NaN drop", n_samples)

    if estimator_type == "xgb":
        from xgboost import XGBClassifier
        base_model = XGBClassifier(random_state=seed, n_jobs=-1, verbosity=0, tree_method="hist")
        pipeline = Pipeline([("model", base_model)])
    else:
        sklearn_imputer = _build_sklearn_imputer(imputation_strategy, seed)
        base_model = GradientBoostingClassifier(random_state=seed)
        pipeline = Pipeline([("imputer", sklearn_imputer), ("model", base_model)])

    param_distributions = {
        "model__" + k: v
        for k, v in tuning_cfg.get("param_distributions", default_grid).items()
    }

    search = RandomizedSearchCV(
        pipeline,
        param_distributions,
        n_iter=tuning_cfg.get("n_iter", 30),
        cv=tuning_cfg.get("cv", 5),
        scoring="roc_auc",
        random_state=seed,
        n_jobs=-1,
        refit=True,
    )
    search.fit(X_raw, y)

    best_pipeline = search.best_estimator_
    best_params = {k.replace("model__", ""): v for k, v in search.best_params_.items()}
    log.info("train_dropout: best_params=%s", best_params)

    cv_metrics = cross_validate_classifier(best_pipeline, X_raw, y, cv_config)
    cv_metrics["n"] = n_samples

    if estimator_type == "xgb":
        X_for_shap = X_raw
    else:
        X_for_shap = pd.DataFrame(
            best_pipeline.named_steps["imputer"].transform(X_raw.values),
            columns=final_feature_cols,
        )

    try:
        shap_df = shap_importances(best_pipeline.named_steps["model"], X_for_shap)
    except Exception as e:
        log.warning("SHAP failed for dropout: %s", e)
        shap_df = pd.DataFrame(
            {"feature": final_feature_cols, "mean_abs_shap": [float("nan")] * len(final_feature_cols)}
        )

    return {
        "model": best_pipeline,
        "cv_metrics": cv_metrics,
        "shap_df": shap_df,
        "feature_names": final_feature_cols,
        "n": n_samples,
        "strategy": imputation_strategy,
        "best_params": best_params,
    }
```

- [ ] **Step 3: Run dropout XGB tests**

```bash
PYTHONPATH=src .venv/bin/pytest tests/test_models.py -k "dropout" -v
```

Expected: all dropout tests PASS

- [ ] **Step 4: Run full test suite**

```bash
PYTHONPATH=src .venv/bin/pytest tests/ -q
```

Expected: all tests pass (91 original + 8 new XGB tests = 99 total)

- [ ] **Step 5: Commit**

```bash
git add src/qtx/models/dropout.py
git commit -m "feat(dropout): add estimator_type param with XGBoost branch"
```

---

## Task 7 — Update scripts/06_train_models.py

**Files:**
- Modify: `scripts/06_train_models.py`

This task updates the script to: (a) call both GBM and XGB variants per model, (b) save six artefacts instead of three, (c) add a `_render_model_subsection` helper, (d) update `build_report` to show both subsections per model, and (e) extend the terminal summary.

- [ ] **Step 1: Update the training calls and artefact saves in main()**

Replace the training block and artefact save block in `main()`:

**Training block** — replace:
```python
    log.info("=== Training Regression (iterative) ===")
    reg_result = train_regression(df, imputation_strategy="iterative")

    log.info("=== Training Classifier (iterative) ===")
    clf_result = train_classifier(df, imputation_strategy="iterative")

    log.info("=== Training Dropout (iterative) ===")
    drop_result = train_dropout(df, imputation_strategy="iterative")
```

With:
```python
    log.info("=== Training Regression GBM (iterative) ===")
    reg_result_gbm = train_regression(df, imputation_strategy="iterative", estimator_type="gbm")

    log.info("=== Training Regression XGBoost ===")
    reg_result_xgb = train_regression(df, imputation_strategy="iterative", estimator_type="xgb")

    log.info("=== Training Classifier GBM (iterative) ===")
    clf_result_gbm = train_classifier(df, imputation_strategy="iterative", estimator_type="gbm")

    log.info("=== Training Classifier XGBoost ===")
    clf_result_xgb = train_classifier(df, imputation_strategy="iterative", estimator_type="xgb")

    log.info("=== Training Dropout GBM (iterative) ===")
    drop_result_gbm = train_dropout(df, imputation_strategy="iterative", estimator_type="gbm")

    log.info("=== Training Dropout XGBoost ===")
    drop_result_xgb = train_dropout(df, imputation_strategy="iterative", estimator_type="xgb")
```

**Artefact save block** — replace:
```python
    if reg_result.get("model"):
        joblib.dump(reg_result["model"], models_dir / "regression.joblib")
        log.info("Saved models/regression.joblib")

    if clf_result.get("model"):
        joblib.dump(clf_result["model"], models_dir / "classifier.joblib")
        log.info("Saved models/classifier.joblib")

    if drop_result.get("model"):
        joblib.dump(drop_result["model"], models_dir / "dropout.joblib")
        log.info("Saved models/dropout.joblib")
```

With:
```python
    for label, result, fname in [
        ("regression_gbm", reg_result_gbm, "regression_gbm.joblib"),
        ("regression_xgb", reg_result_xgb, "regression_xgb.joblib"),
        ("classifier_gbm", clf_result_gbm, "classifier_gbm.joblib"),
        ("classifier_xgb", clf_result_xgb, "classifier_xgb.joblib"),
        ("dropout_gbm", drop_result_gbm, "dropout_gbm.joblib"),
        ("dropout_xgb", drop_result_xgb, "dropout_xgb.joblib"),
    ]:
        if result.get("model"):
            joblib.dump(result["model"], models_dir / fname)
            log.info("Saved models/%s", fname)
```

- [ ] **Step 2: Update the sensitivity and stratified performance calls**

Replace:
```python
    strat_perf = pd.DataFrame()
    if clf_result.get("model") and "X" in clf_result and "y" in clf_result:
        try:
            clf_model = clf_result["model"]
            X_clf = clf_result["X"]
            y_clf = clf_result["y"]
            df_full_aligned = df.loc[X_clf.index] if X_clf.index.isin(df.index).all() else df.iloc[:len(X_clf)]
            strat_perf = stratified_performance(clf_model, X_clf, y_clf, df_full_aligned, "cohort")
            log.info("Stratified performance:\n%s", strat_perf.to_string())
        except Exception as e:
            log.warning("Stratified performance failed: %s", e)
```

With:
```python
    strat_perf = pd.DataFrame()
    if clf_result_gbm.get("model") and "X" in clf_result_gbm and "y" in clf_result_gbm:
        try:
            X_clf = clf_result_gbm["X"]
            y_clf = clf_result_gbm["y"]
            df_full_aligned = df.loc[X_clf.index] if X_clf.index.isin(df.index).all() else df.iloc[:len(X_clf)]
            strat_perf = stratified_performance(clf_result_gbm["model"], X_clf, y_clf, df_full_aligned, "cohort")
            log.info("Stratified performance:\n%s", strat_perf.to_string())
        except Exception as e:
            log.warning("Stratified performance failed: %s", e)
```

- [ ] **Step 3: Update the build_report call**

Replace:
```python
    html_content = build_report(
        reg_result,
        clf_result,
        drop_result,
        reg_sensitivity,
        clf_sensitivity,
        drop_sensitivity,
        strat_perf,
    )
```

With:
```python
    html_content = build_report(
        reg_result_gbm, reg_result_xgb,
        clf_result_gbm, clf_result_xgb,
        drop_result_gbm, drop_result_xgb,
        reg_sensitivity,
        clf_sensitivity,
        drop_sensitivity,
        strat_perf,
    )
```

- [ ] **Step 4: Update the terminal summary**

Replace the entire terminal summary block (from `print("\n" + "=" * 60)` to the final `print("=" * 60)`) with:

```python
    print("\n" + "=" * 60)
    print("QTX MODEL TRAINING SUMMARY")
    print("=" * 60)

    for label, result, cv_keys in [
        ("[REGRESSION GBM]  composite_improvement", reg_result_gbm,
         [("RMSE", "rmse_mean", "rmse_std"), ("MAE", "mae_mean", "mae_std"), ("R²", "r2_mean", "r2_std")]),
        ("[REGRESSION XGB]  composite_improvement", reg_result_xgb,
         [("RMSE", "rmse_mean", "rmse_std"), ("MAE", "mae_mean", "mae_std"), ("R²", "r2_mean", "r2_std")]),
        ("[CLASSIFIER GBM]  overall_responder", clf_result_gbm,
         [("AUC-ROC", "auc_roc_mean", "auc_roc_std"), ("AUC-PR", "auc_pr_mean", "auc_pr_std"), ("Brier", "brier_mean", "brier_std")]),
        ("[CLASSIFIER XGB]  overall_responder", clf_result_xgb,
         [("AUC-ROC", "auc_roc_mean", "auc_roc_std"), ("AUC-PR", "auc_pr_mean", "auc_pr_std"), ("Brier", "brier_mean", "brier_std")]),
        ("[DROPOUT GBM]     is_dropout", drop_result_gbm,
         [("AUC-ROC", "auc_roc_mean", "auc_roc_std"), ("AUC-PR", "auc_pr_mean", "auc_pr_std")]),
        ("[DROPOUT XGB]     is_dropout", drop_result_xgb,
         [("AUC-ROC", "auc_roc_mean", "auc_roc_std"), ("AUC-PR", "auc_pr_mean", "auc_pr_std")]),
    ]:
        cv = result.get("cv_metrics", {})
        print(f"\n{label}")
        print(f"  N = {cv.get('n', '?')}")
        for metric_label, mean_key, std_key in cv_keys:
            print(f"  {metric_label:<8} = {cv.get(mean_key, float('nan')):.4f} ± {cv.get(std_key, float('nan')):.4f}")
        if result.get("best_params"):
            print(f"  Best params: {result['best_params']}")

    print(f"\n[OUTPUT] models/regression_gbm.joblib  models/regression_xgb.joblib")
    print(f"[OUTPUT] models/classifier_gbm.joblib  models/classifier_xgb.joblib")
    print(f"[OUTPUT] models/dropout_gbm.joblib     models/dropout_xgb.joblib")
    print(f"[OUTPUT] reports/modelling.html")
    print("=" * 60)
```

- [ ] **Step 5: Add _render_model_subsection helper and update build_report**

Add this helper function just before `build_report` in `scripts/06_train_models.py`:

```python
def _render_model_subsection(result: dict, label: str, task: str) -> list[str]:
    """Render one estimator result (GBM or XGBoost) as a list of HTML strings."""
    parts = []
    parts.append(f"<h3>{label}</h3>")
    cv = result.get("cv_metrics", {})
    if task == "regression":
        parts.append(
            f'<p><span class="metric-highlight">N = {cv.get("n", "?")} | '
            f'RMSE = {cv.get("rmse_mean", float("nan")):.4f} ± {cv.get("rmse_std", float("nan")):.4f} | '
            f'MAE = {cv.get("mae_mean", float("nan")):.4f} | '
            f'R² = {cv.get("r2_mean", float("nan")):.4f}</span></p>'
        )
    else:
        parts.append(
            f'<p><span class="metric-highlight">N = {cv.get("n", "?")} | '
            f'AUC-ROC = {cv.get("auc_roc_mean", float("nan")):.4f} ± {cv.get("auc_roc_std", float("nan")):.4f} | '
            f'AUC-PR = {cv.get("auc_pr_mean", float("nan")):.4f} | '
            f'Brier = {cv.get("brier_mean", float("nan")):.4f}</span></p>'
        )
    bp = result.get("best_params", {})
    if bp:
        params_str = " | ".join(f"{k}={v}" for k, v in sorted(bp.items()))
        parts.append(f"<p><strong>Best hyperparameters:</strong> {params_str}</p>")
    shap_df = result.get("shap_df", pd.DataFrame())
    if not shap_df.empty:
        img_b64 = shap_bar_plot(shap_df, f"Top-10 SHAP Features ({label})")
        parts.append(f'<div class="fig-box"><img src="data:image/png;base64,{img_b64}"></div>')
        parts.append("<h4>Top-10 SHAP Features</h4>")
        parts.append(df_to_html_table(shap_df.head(10)))
    return parts
```

Replace the entire `build_report` function with:

```python
def build_report(
    reg_result_gbm: dict,
    reg_result_xgb: dict,
    clf_result_gbm: dict,
    clf_result_xgb: dict,
    drop_result_gbm: dict,
    drop_result_xgb: dict,
    reg_sensitivity: pd.DataFrame,
    clf_sensitivity: pd.DataFrame,
    drop_sensitivity: pd.DataFrame,
    strat_perf: pd.DataFrame,
) -> str:
    """Build full HTML report string."""
    sections = []
    sections.append(f"<html><head><title>QTX Model Report</title>{_HTML_STYLE}</head><body>")
    sections.append("<h1>QuantumTX — Model Training Report</h1>")
    sections.append("<p>Generated on <strong>2026-05-20</strong></p>")

    # --- Regression ---
    sections.append('<div class="section">')
    sections.append("<h2>1. Composite Improvement Regression</h2>")
    sections.extend(_render_model_subsection(reg_result_gbm, "GBM", "regression"))
    sections.extend(_render_model_subsection(reg_result_xgb, "XGBoost", "regression"))
    sections.append("<h3>Sensitivity Analysis (Imputation Strategies)</h3>")
    if not reg_sensitivity.empty:
        sections.append(df_to_html_table(reg_sensitivity))
    sections.append("</div>")

    # --- Classifier ---
    sections.append('<div class="section">')
    sections.append("<h2>2. Overall Responder Classifier</h2>")
    sections.extend(_render_model_subsection(clf_result_gbm, "GBM", "classifier"))
    cal_data = clf_result_gbm.get("calibration", (np.array([]), np.array([])))
    if len(cal_data[0]) > 0:
        cal_b64 = calibration_plot(cal_data, "Calibration Curve (GBM)")
        sections.append(f'<div class="fig-box"><img src="data:image/png;base64,{cal_b64}"></div>')
    sections.extend(_render_model_subsection(clf_result_xgb, "XGBoost", "classifier"))
    cal_data_xgb = clf_result_xgb.get("calibration", (np.array([]), np.array([])))
    if len(cal_data_xgb[0]) > 0:
        cal_b64 = calibration_plot(cal_data_xgb, "Calibration Curve (XGBoost)")
        sections.append(f'<div class="fig-box"><img src="data:image/png;base64,{cal_b64}"></div>')
    sections.append("<h3>Sensitivity Analysis</h3>")
    if not clf_sensitivity.empty:
        sections.append(df_to_html_table(clf_sensitivity))
    if not strat_perf.empty:
        sections.append("<h3>Stratified Performance by Cohort</h3>")
        sections.append(df_to_html_table(strat_perf))
    sections.append("</div>")

    # --- Dropout ---
    sections.append('<div class="section">')
    sections.append("<h2>3. Dropout Prediction</h2>")
    sections.extend(_render_model_subsection(drop_result_gbm, "GBM", "classifier"))
    sections.extend(_render_model_subsection(drop_result_xgb, "XGBoost", "classifier"))
    sections.append("<h3>Sensitivity Analysis</h3>")
    if not drop_sensitivity.empty:
        sections.append(df_to_html_table(drop_sensitivity))
    sections.append("</div>")

    sections.append("</body></html>")
    return "\n".join(sections)
```

- [ ] **Step 6: Run full test suite**

```bash
PYTHONPATH=src .venv/bin/pytest tests/ -q
```

Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add scripts/06_train_models.py
git commit -m "feat(report): render GBM and XGBoost subsections per model; save six artefacts"
```

---

## Task 8 — End-to-end smoke test

**Files:** none — verification only

- [ ] **Step 1: Run full test suite**

```bash
PYTHONPATH=src .venv/bin/pytest tests/ -q
```

Expected: all tests pass

- [ ] **Step 2: Run make model**

```bash
make model
```

Expected: completes without errors. Terminal summary shows six model blocks (GBM + XGBoost for each of regression, classifier, dropout).

- [ ] **Step 3: Verify success criteria**

Check terminal output against these targets:

| Model | Metric | Minimum |
|---|---|---|
| Classifier XGBoost | AUC-ROC | >= 0.68 (GBM baseline) |
| Regression XGBoost | R² | >= 0.11 (GBM baseline) |
| Dropout XGBoost | AUC-ROC | >= 0.95 |
| All 6 artefacts | saved | `ls models/*.joblib` shows 6 files |

- [ ] **Step 4: Verify artefacts**

```bash
ls -la models/*.joblib
```

Expected: `classifier_gbm.joblib`, `classifier_xgb.joblib`, `regression_gbm.joblib`, `regression_xgb.joblib`, `dropout_gbm.joblib`, `dropout_xgb.joblib`
