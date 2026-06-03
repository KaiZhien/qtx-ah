# RAISE Covariate Shift Analysis & Conditional Retraining Design

## Goal

Evaluate whether the 162-patient RAISE eldercare dataset can be safely merged with the QTX training cohort to improve the outcome regression and fall risk models, using a binary covariate shift test as a safety gate before any retraining occurs.

## Context

The existing ML pipeline (`src/qtx/models/`) trains XGBoost models on ~1715 QTX clinic patients. RAISE adds 162 patients across 3 eldercare centres (METTA, LB, PH) who each had a single 10-minute BIXEPS session. EDA (script 14) revealed strong centre heterogeneity — METTA mean pre-TUG 36s vs ~11s at LB/PH — making naive pooling risky. RAISE covers 5 of 6 composite improvement tests (no fast gait speed). All RAISE patients are ingested into the same PostgreSQL DB as Patient + Session rows (scripts 15 + 16).

---

## Section 1 — Data Assembly

A single script (`scripts/17_raise_model_evaluation.py`) queries RAISE patients and their sessions from the DB (filtered by `ingested_from LIKE 'raise%'`), joins Patient and Session into a flat dataframe, and maps columns to the same schema as the QTX parquet (`src/qtx/data/dashboard_data.parquet`).

Change scores are computed using the existing `compute_change_scores` function from `src/qtx/outcomes/change_scores.py`. Composite improvement is then computed using `compute_composite` from `src/qtx/outcomes/composite.py`. `fast_gs_improvement` is left as NaN for all RAISE rows (the test was not collected). A `dataset` flag column is added: 0 = QTX, 1 = RAISE. The two halves are concatenated into a single dataframe.

Derived columns computed from Patient flags:
- `n_flags` = count of True `has_*` columns
- `n_groups` = count of True `grp_*` columns
- `n_regions` = count of True `rgn_*` columns

Columns absent from RAISE and filled with NaN or False:
- `primary_indication` → NaN
- `pre_fast_gs_ms`, `post_fast_gs_ms`, `fast_gs_improvement` → NaN
- `usage_frequency` → `"Once weekly (BIXEPS)"`

---

## Section 2 — Covariate Shift Test

A binary XGBoost classifier is trained to predict `dataset` (0=QTX, 1=RAISE) using the same ~50 features defined in `config/models.yaml`. Stratified 5-fold cross-validation yields a mean AUC-ROC.

**Gate:** AUC < 0.70 → populations are not reliably distinguishable → proceed to Section 3.  
AUC ≥ 0.70 → populations are too different to merge safely → print top-10 SHAP features driving the separation and exit without retraining.

SHAP values are computed on this shift classifier regardless of the gate outcome (used in Section 3 if gate passes).

---

## Section 3 — SHAP Importance Check

Using mean absolute SHAP values from the Section 2 classifier, the script checks whether `cohort` and `usage_frequency` together account for ≥ 15% of total importance. If they do, the classifier is separating populations by programme/centre rather than clinical profile — merging would inject an institutional confound. The script prints the top-10 SHAP features and exits.

**Gate:** combined `cohort` + `usage_frequency` SHAP < 15% → safe → proceed to Section 4.  
≥ 15% → exit without retraining.

Both gates must pass for retraining to occur.

---

## Section 4 — Conditional Retraining

If both gates pass, two models are retrained on the combined dataset using the existing `RandomizedSearchCV` pipelines:

1. **Outcome regression** (`src/qtx/models/regression.py`) — target: `composite_improvement`; metrics: CV RMSE and R²
2. **Fall risk classifier** (`src/qtx/models/classifier.py`) — target: `has_fall_risk`; metric: CV AUC

For each model, metrics are computed for (a) QTX-only and (b) combined data. If combined metrics are at least as good as QTX-only on both models (neither gets worse), the new model objects are saved alongside the existing files with a `_raise_augmented` suffix (e.g., `models/outcome_model_raise_augmented.joblib`).

The script always prints a side-by-side comparison table before exiting, regardless of whether models are saved.

---

## Output

```
=== Covariate Shift Report ===
Shift classifier AUC: X.XX  → PASS / FAIL
Cohort + usage_freq SHAP:  XX%  → PASS / FAIL

=== Retraining Comparison ===
                     QTX-only   Combined   Delta
Outcome RMSE         X.XX       X.XX       ±X.XX
Outcome R²           X.XX       X.XX       ±X.XX
Fall Risk AUC        X.XX       X.XX       ±X.XX

Models saved: YES / NO (reason)
```

---

## Files

| File | Action |
|------|--------|
| `scripts/17_raise_model_evaluation.py` | New — full pipeline: data assembly, shift test, SHAP check, conditional retrain |
| `tests/test_raise_evaluation.py` | New — unit tests for helper functions (data assembly mapping, gate logic) |

No changes to existing model files, ORM models, or migrations.

---

## Testing

- Unit tests cover: DB query result → flat dataframe column mapping, `n_flags`/`n_groups`/`n_regions` computation, gate logic (AUC threshold, SHAP threshold), model save decision (better vs worse metrics).
- Integration: run `scripts/17_raise_model_evaluation.py` against local DB (requires scripts 15 + 16 already applied).
