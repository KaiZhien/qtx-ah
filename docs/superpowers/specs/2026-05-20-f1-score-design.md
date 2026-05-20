# F1 Score Addition — Design Spec
**Date:** 2026-05-20  
**Status:** Approved  
**Scope:** Add weighted F1 score to classifier CV metrics; surface in report and terminal summary

---

## Problem Statement

`cross_validate_classifier` currently reports AUC-ROC, AUC-PR, and Brier score. F1 score (weighted) is a useful complementary metric that captures precision/recall trade-off at the decision threshold, and is more interpretable to clinical stakeholders than AUC alone.

---

## Design

### 1. evaluate.py — cross_validate_classifier

Add weighted F1 per fold at threshold 0.5:

```python
from sklearn.metrics import f1_score

# inside the CV loop, after brier:
f1_scores.append(f1_score(y_val, (proba >= 0.5).astype(int), average="weighted"))
```

Return dict gains two new keys: `f1_mean`, `f1_std`.

Threshold 0.5 is used universally (no config needed — this is the standard operating threshold for binary classification).

### 2. scripts/06_train_models.py

`_render_model_subsection` for `task="classifier"` adds F1 to the metric highlight `<span>`:

```
N = X | AUC-ROC = X | AUC-PR = X | Brier = X | F1 = X
```

Terminal summary loop adds F1 row for classifier and dropout blocks:
```
("F1", "f1_mean", "f1_std")
```

### 3. config/models.yaml

Add `f1` to `classifier_responder.metrics` and `dropout.metrics` lists. These lists are documentation — they don't drive computation.

### 4. tests/test_models.py

One new test:

```python
def test_cross_validate_classifier_returns_f1():
    from sklearn.pipeline import Pipeline
    from sklearn.ensemble import GradientBoostingClassifier
    from qtx.models.evaluate import cross_validate_classifier
    X = pd.DataFrame({"a": [1.0]*40 + [0.0]*40})
    y = pd.Series([1]*40 + [0]*40)
    model = Pipeline([("model", GradientBoostingClassifier(n_estimators=5, random_state=0))])
    result = cross_validate_classifier(model, X, y, {"kind": "stratified_kfold", "k": 2})
    assert "f1_mean" in result
    assert "f1_std" in result
    assert 0.0 <= result["f1_mean"] <= 1.0
```

---

## Files Changed

| File | Change |
|---|---|
| `src/qtx/models/evaluate.py` | Add `f1_score` import; compute weighted F1 per fold in `cross_validate_classifier` |
| `scripts/06_train_models.py` | Add F1 to `_render_model_subsection` classifier metric line; add F1 to terminal summary |
| `config/models.yaml` | Add `f1` to `classifier_responder.metrics` and `dropout.metrics` |
| `tests/test_models.py` | Add `test_cross_validate_classifier_returns_f1` |

## Explicitly Not Changed

- `cross_validate_regression` (F1 is not applicable to regression)
- Regression report sections
- SHAP, calibration, sensitivity analysis
- Any model training logic

---

## Success Criteria

- `cross_validate_classifier` returns `f1_mean` and `f1_std`
- F1 appears in HTML report metric highlight for both classifier and dropout sections (GBM and XGBoost)
- F1 appears in terminal summary for both classifier and dropout
- All existing tests continue to pass
- New test passes
