# Approach B — XGBoost Alongside GBM — Design Spec
**Date:** 2026-05-20  
**Status:** Approved  
**Scope:** Add XGBoost as a second estimator running alongside sklearn GradientBoosting for all three models

---

## Problem Statement

After Approach A, current performance (iterative imputation, 46 features, n=596 for outcome models):

| Model | Metric | Current |
|---|---|---|
| Regression (composite_improvement) | R² | 0.11 |
| Classifier (overall_responder) | AUC-ROC | 0.68 |
| Dropout predictor (is_dropout) | AUC-ROC | 0.99 |

The classifier is still below the 0.70 AUC-ROC target. XGBoost typically outperforms sklearn's GradientBoosting on tabular data due to better regularisation, second-order gradient approximation, and native NaN handling (no imputer pass needed).

---

## Approach

Add XGBoost as a second estimator alongside the existing GBM. Both run for all three models. The HTML report shows each model with two full subsections (GBM and XGBoost), each with its own metrics, SHAP chart, and best hyperparameters. Separate model artefacts are saved for each.

---

## Section 1: Architecture

### estimator_type parameter

Each `train_*` function gains:

```python
def train_classifier(df: pd.DataFrame, imputation_strategy: str = "iterative", estimator_type: str = "gbm") -> dict:
```

Default is `"gbm"` — all existing call sites continue to work unchanged.

### XGBoost pipeline

When `estimator_type="xgb"`:

- `_build_xgb_estimator(task, seed)` returns `XGBClassifier` or `XGBRegressor` with `tree_method="hist"`, `random_state=seed`, `n_jobs=-1`, `verbosity=0`
- XGBoost handles NaN natively — no imputer step required
- Pipeline: `Pipeline([("model", xgb_estimator)])` — single step, consistent with existing Pipeline contract
- SHAP: `shap_importances(best_pipeline.named_steps["model"], X_raw)` — `X_raw` passed directly (no imputer transform step)
- `complete_case` NaN dropping still applies when `imputation_strategy="complete_case"` (same guard as GBM path)

When `estimator_type="gbm"`: existing path unchanged.

### Hyperparameter search

XGB uses different parameter names from sklearn GBM. A separate `tuning_xgb` block in `config/models.yaml` holds XGB-specific distributions:

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

The `_get_tuning_cfg()` helpers in each model file are updated to accept `estimator_type` and return the appropriate block.

### Return contract

Both GBM and XGB paths return the same dict shape:
`{model, cv_metrics, shap_df, feature_names, n, strategy, best_params}`

The `model` key is always a fitted `Pipeline`.

---

## Section 2: Files Changed

| File | Change |
|---|---|
| `pyproject.toml` | Add `xgboost = "^2.0"` to dependencies |
| `config/models.yaml` | Add `tuning_xgb:` block |
| `src/qtx/models/evaluate.py` | Add `_build_xgb_estimator(task, seed)` factory |
| `src/qtx/models/classifier.py` | Add `estimator_type="gbm"` param; branch for XGB pipeline + SHAP |
| `src/qtx/models/regression.py` | Same as classifier |
| `src/qtx/models/dropout.py` | Same as classifier |
| `scripts/06_train_models.py` | Call both variants per model; save `*_gbm.joblib` / `*_xgb.joblib`; pass both to `build_report` |
| `scripts/06_train_models.py` → `build_report` | Each model section has GBM and XGB subsections with full metrics, SHAP, best params |
| `tests/test_models.py` | New tests for `_build_xgb_estimator` and XGB train-function contracts |

### Explicitly not changed
- Pipeline stages 01–05
- `src/qtx/missing/impute.py`
- `src/qtx/models/evaluate.py` metric functions (`cross_validate_*`, `shap_importances`, etc.)
- Dashboard

---

## Section 3: Testing

New tests in `tests/test_models.py`:

| Test | Assertion |
|---|---|
| `test_build_xgb_estimator_classifier` | Returns `XGBClassifier` |
| `test_build_xgb_estimator_regressor` | Returns `XGBRegressor` |
| `test_config_has_tuning_xgb_block` | `models.yaml` has `tuning_xgb` with `colsample_bytree` |
| `test_train_classifier_xgb_returns_best_params` | Result has `best_params` with `n_estimators` |
| `test_train_classifier_xgb_model_is_pipeline` | `result["model"]` is `Pipeline` |
| `test_train_regression_xgb_returns_best_params` | Result has `best_params` with `n_estimators` |
| `test_train_dropout_xgb_returns_best_params` | Result has `best_params` with `n_estimators` |

All 91 existing tests must continue to pass.

---

## Success Criteria

- All three models run both GBM and XGBoost variants without error
- HTML report shows both subsections per model (metrics + SHAP + best params)
- Classifier XGBoost AUC-ROC >= GBM baseline of 0.68 (directional target: >0.70)
- Regression XGBoost R² >= GBM baseline of 0.11
- Dropout XGBoost AUC-ROC >= 0.95
- All existing 91 tests continue to pass
- `make model` runs end-to-end without errors
