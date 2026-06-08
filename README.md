# QTX-AH — QuantumTX Alexandra Hospital Analytics Pipeline

A reproducible, config-driven Python pipeline for analysing rehabilitation outcomes from QuantumTX's magnetic-mitohormesis therapy programme at Alexandra Hospital (AH) Singapore. Covers data ingestion → cleaning → phenotyping → outcomes → EDA → modelling → an interactive Streamlit dashboard.

> **Dataset:** 1,716 patient records (2024), six functional assessment blocks (VAS, TUG, 5×SST, Normal Gait Speed, Fast Gait Speed, SPPB), ~34.7% follow-up rate.

---

## Security

All secrets (API keys, database credentials) are gitignored via `.env` — never committed. Copy `.env.example` to `.env` and fill in real values. A pre-commit hook at `.git/hooks/pre-commit` blocks accidental commits of `.env` files and Anthropic key patterns; re-install it after each fresh clone.

**Before granting external access:** run BFG Repo Cleaner or `git filter-branch` to confirm no secrets exist in git history. See `HANDOFF.md → Environment files` for the full warning and instructions.

---

## Current Results (v0.2.0, Approach B — iterative imputation + XGBoost)

> Numbers from a full `make model` run on the 2024 AH dataset with 46-feature matrix and iterative MICE imputation. Both GBM and XGBoost estimators are trained; XGBoost is the recommended estimator. Update this section after retraining on new data.

| Metric | Value | Notes |
|--------|-------|-------|
| Patients | 1,716 | 49 legacy (`OLD…`) records included but excluded from primary models |
| Follow-up rate | 34.7% (596 / 1,716) | Dropout is the primary data-quality challenge |
| Overall responders | 69.5% of follow-up (414 / 596) | ≥ MCID on 2+ tests |
| Classified by phenotype | 39.9% (684 / 1,716) | 60.1% Unclassified — most have no comorbidity tags |
| **Regression XGB** R² (composite improvement) | **0.125** | RMSE ~0.58, n ≈ 596; iterative imputation |
| **Regression GBM** R² | 0.110 | RMSE ~0.59, n ≈ 596 |
| **Classifier XGB** AUC-ROC (overall responder) | **0.739** | AUC-PR ~0.88, F1 ~0.72, n ≈ 596 |
| **Classifier GBM** AUC-ROC | 0.677 | n ≈ 596 |
| **Dropout XGB** AUC-ROC (predicts non-completion) | **0.998** | F1 ~0.99, n = 1,716; all rows usable |
| **Dropout GBM** AUC-ROC | 0.992 | n = 1,716 |

**Top phenotype groups** (of classified patients): Joint disease 25%, Frailty/Sarcopenia 11%, Spine/Back 8%, Soft-tissue injury 6%, Neurological 4%.

**Interpretation notes:**
- XGBoost handles NaN natively (no imputer step in pipeline) and outperforms GBM on all three tasks.
- Classifier AUC-ROC crossed the 0.70 clinical target with XGBoost + iterative imputation vs 0.63 in v0.1.0 (complete-case GBM).
- The dropout model's near-perfect AUC-ROC (0.998) reflects that missing baseline data is itself the strongest predictor of non-completion — a real clinical signal, not leakage.
- All metrics are 5-fold stratified CV. See `reports/modelling.html` for SHAP importances, calibration curves, and full sensitivity analysis across four imputation strategies.

### How to track metrics

```bash
# Train all 6 models and print terminal summary
make model

# View full HTML report (metrics, SHAP, calibration, sensitivity)
open reports/modelling.html

# Run test suite (99 tests)
make test

# Run a quick smoke-check without full pipeline
PYTHONPATH=src .venv/bin/pytest tests/test_models.py -v
```

The terminal summary printed by `make model` shows N, AUC-ROC ± std, AUC-PR, Brier, and F1 for all six model blocks, plus best hyperparameters.

---

## Table of Contents

1. [Background](#background)
2. [Project Structure](#project-structure)
3. [Quick Start](#quick-start)
4. [Pipeline Reference](#pipeline-reference)
5. [Configuration System](#configuration-system)
6. [Outputs & Reports](#outputs--reports)
7. [Dashboard](#dashboard)
8. [Modelling](#modelling)
9. [Phenotype Rules](#phenotype-rules)
10. [Adding a New Model](#adding-a-new-model)
11. [Testing](#testing)
12. [Data Dictionary](#data-dictionary)
13. [Clinical Context](#clinical-context)

---

## Background

QuantumTX Pte Ltd (NUS / ETH Zürich spinoff) commercialises magnetic-mitohormesis therapy — a non-invasive magnetic-field treatment that induces mitochondrial activation in skeletal muscle. The Alexandra Hospital demo centre runs a structured programme with pre- and post-functional assessments.

This pipeline converts a hand-cleaned Excel workbook into a versioned, analyst-ready dataset, a trained set of predictive models, and a clinician-facing dashboard. Every threshold, rule, and assumption lives in `config/` — the clinical team can refine the phenotype taxonomy or MCID thresholds without touching Python.

---

## Project Structure

```
quantumtx-ah/
├── config/                   # All rules, thresholds, and assumptions — edit here, not in code
│   ├── settings.yaml         # Paths, random seed, log level
│   ├── schema.yaml           # Canonical column names, dtypes, allowed values
│   ├── cleaning.yaml         # NA tokens, case maps, plausibility ranges, age bands
│   ├── phenotypes.yaml       # 3-layer taxonomy: 14 groups, 9 regions, 24 condition flags
│   ├── outcomes.yaml         # MCIDs, composite method, responder threshold
│   ├── missingness.yaml      # Per-feature imputation policy
│   └── models.yaml           # Feature lists, hyperparameters, sensitivity variants
│
├── data/
│   ├── inputs/               # Source Excel files — READ ONLY, gitignored
│   ├── processed/            # Versioned Parquet snapshots
│   └── audit/                # Per-stage audit logs (CSV)
│
├── src/qtx/
│   ├── io/                   # Excel ingestion, Parquet persistence
│   ├── clean/                # NA harmonisation, type coercion, plausibility flags, audit log
│   ├── phenotype/            # YAML-driven regex classifier, coverage & unmatched reports
│   ├── outcomes/             # Change scores, composite z-score, MCID responder flags
│   ├── missing/              # Missingness profiling, four imputation strategies
│   ├── features/             # Modelling matrix builder, pandera schema validation
│   ├── models/               # Regression, classifier, dropout models; evaluate & SHAP
│   ├── eda/                  # Descriptive tables, Plotly figures, self-contained HTML report
│   └── utils/                # Config loader (YAML → dict, cached), Rich logging
│
├── scripts/                  # One-off CLIs (01_ingest → 07_export_dashboard_data)
├── dashboard/                # Streamlit app (app.py) + sanitised partner stub
├── notebooks/                # Exploration notebooks
├── reports/                  # Generated HTML reports (gitignored)
├── models/                   # Trained joblib artefacts (gitignored)
└── tests/                    # pytest + hypothesis property-based tests
```

---

## Quick Start

### Prerequisites

- Python 3.11+
- The source Excel files in `data/inputs/` (gitignored — copy them in manually):
  - `QTX_AX(nov 2025) - Reet & Jun Yi.xlsx` — raw source
  - `QTX_AH_2024_organised.xlsx` — reference cleaned workbook

### Install

```bash
cd quantumtx-ah

# Option A — pip editable install (fastest)
pip install -e .

# Option B — Poetry
poetry install
```

### Run everything

```bash
make all
```

This executes the full pipeline end-to-end. Estimated runtime: 3–8 minutes depending on machine (model training dominates).

### Run the dashboard

```bash
make dashboard
# opens at http://localhost:8501
```

---

## Pipeline Reference

Each stage is an independent script. Run them individually or chain with `make all`.

| Stage | Make target | Script | Input → Output |
|-------|------------|--------|----------------|
| 1. Ingest | `make ingest` | `scripts/01_ingest.py` | Excel → `data/processed/raw.parquet` |
| 2. Clean | `make clean-data` | `scripts/02_clean.py` | raw → `cleaned.parquet` + `data/audit/clean_audit.csv` |
| 3. Phenotype | `make phenotype` | `scripts/03_phenotype.py` | cleaned → `phenotyped.parquet` + `reports/unmatched_tags.csv` |
| 4. Outcomes | `make outcomes` | `scripts/04_outcomes.py` | phenotyped → `outcomes.parquet` |
| 5. EDA | `make eda` | `scripts/05_eda.py` | featured → `reports/eda.html` |
| 6. Features | _(called by 07)_ | `scripts/07_export_dashboard_data.py` | outcomes → `featured.parquet` + `dashboard_data.parquet` |
| 7. Models | `make model` | `scripts/06_train_models.py` | featured → `models/*.joblib` + `reports/modelling.html` |

Run individual stages with `PYTHONPATH=src python scripts/01_ingest.py` (or via `make`).

### Audit logs

Every value change during cleaning is recorded to `data/audit/clean_audit.csv` with columns:

```
record_id | module | field | before | after | reason
```

The current dataset produces ~24,000 audit rows, of which ~23,000 are NA token harmonisations.

---

## Configuration System

**Rule:** no thresholds, patterns, or assumptions live in Python code. Edit YAML, re-run the affected stage.

### `config/cleaning.yaml`

Controls:
- `na_tokens` — strings treated as missing (e.g. `"NA"`, `"-"`, `"nil"`)
- `gender_map`, `yesno_map`, `frequency_map` — case-insensitive normalisation maps
- `plausibility_ranges` — per-field `{min, max, dnc_above}` for out-of-range flagging
- `age_bands` — bucket boundaries for `age_band` column
- `include_starred` — whether `**`-prefixed names are included in analyses (default: `false`)
- `dedupe_by_name` — whether to collapse duplicate names to most-recent row (default: `false`)
- `pre_post_pairs`, `followup_post_cols`, `column_roles` — structural column lists

### `config/outcomes.yaml`

Controls MCIDs per test and composite computation:

```yaml
tests:
  tug:
    higher_is_better: false
    mcid_abs: 3        # ≥3 s improvement = clinically meaningful
    mcid_pct: 0.10     # OR ≥10% relative improvement
```

Change any threshold here — no code edit needed.

### `config/phenotypes.yaml`

The 3-layer taxonomy. Add patterns, reorder priority, or remap cohorts:

```yaml
groups:
  joint_disease:
    label: "Joint disease"
    patterns:
      - '\boa\b'        # matches "OA"
      - '\barthrit'     # matches "arthritis", "arthritic"
      - 'knee degenerat'

priority:              # first match wins for primary_indication
  - neurological
  - post_surgical
  - joint_disease
  ...

cohort_rollup:         # maps groups → 6 dashboard cohorts
  Pain & Musculoskeletal: [joint_disease, spine_back, ...]
```

### `config/missingness.yaml`

Per-feature imputation strategy. Outcomes are **never imputed**:

```yaml
per_feature_policy:
  baseline_sppb: {strategy: iterative, max_missing_pct: 0.40}
  has_oa:        {strategy: fill_zero}
  gender:        {strategy: category_missing}
outcomes:
  policy: never_impute
```

### `config/models.yaml`

Feature lists and sensitivity variants. To change what goes into the regression:

```yaml
regression_composite:
  features: [age, gender, baseline_sppb, ...]
  model: gradient_boosting
  cv: {kind: stratified_kfold, k: 5, stratify_on: cohort}
```

---

## Outputs & Reports

| File | Description |
|------|-------------|
| `data/processed/raw.parquet` | Original Excel values, canonical column names |
| `data/processed/cleaned.parquet` | NA-harmonised, type-coerced, plausibility-flagged |
| `data/processed/phenotyped.parquet` | + 48 phenotype columns (groups, regions, flags, cohort) |
| `data/processed/outcomes.parquet` | + improvement scores, MCID flags, composite, responders |
| `data/processed/featured.parquet` | Modelling-ready (imputed where configured, schema-validated) |
| `data/processed/dashboard_data.parquet` | Slim 73-col subset for the dashboard |
| `data/audit/clean_audit.csv` | Row-level audit trail for every cleaning transformation |
| `reports/eda.html` | Self-contained interactive EDA (4.8 MB, Plotly, no CDN) |
| `reports/missingness_profile.html` | Per-feature missingness × dropout vs. followup |
| `reports/modelling.html` | CV metrics, SHAP importances, sensitivity analysis |
| `reports/unmatched_tags.csv` | Free-text tokens not matched by any phenotype rule |
| `models/regression_gbm.joblib` | GradientBoostingRegressor on `composite_improvement` |
| `models/regression_xgb.joblib` | XGBRegressor on `composite_improvement` |
| `models/classifier_gbm.joblib` | GradientBoostingClassifier on `overall_responder` |
| `models/classifier_xgb.joblib` | XGBClassifier on `overall_responder` |
| `models/dropout_gbm.joblib` | GBM dropout predictor (baseline features → `is_dropout`) |
| `models/dropout_xgb.joblib` | XGBoost dropout predictor (baseline features → `is_dropout`) |

All Parquet files are also version-stamped in `data/processed/snapshots/`.

---

## Dashboard

Start with:

```bash
make dashboard
# or
streamlit run dashboard/app.py
```

### Features

**Sidebar filters** — cohort, usage frequency, age band, gender, record type. Reset button clears all.

**KPI strip** — filtered N, % with follow-up, mean composite improvement, % overall responders.

**Pre vs Post boxplots** — side-by-side for all 6 tests (paired observations only).

**Comorbidity breakdown** — horizontal bar chart of mean composite improvement by `has_*` flag.

**Intake Estimator** — enter a new patient's baseline values and comorbidity tags; the dashboard predicts:
- Expected composite improvement
- P(responder) — probability of meeting MCID on ≥2 tests
- P(dropout) — probability of not completing follow-up

> The Intake Estimator is a clinical decision-support tool, not a guarantee. Predictions are based on the training cohort and carry uncertainty.

---

## Modelling

Three model families, each trained with two estimators (GBM and XGBoost), all with 5-fold stratified CV and iterative MICE imputation:

| Model | Target | Estimator | N | AUC-ROC / R² | F1 |
|-------|--------|-----------|---|--------------|-----|
| Regression | `composite_improvement` | XGBoost | ~596 | R² = 0.125 | — |
| Regression | `composite_improvement` | GBM | ~596 | R² = 0.110 | — |
| Classifier | `overall_responder` | XGBoost | ~596 | AUC-ROC = 0.739 | ~0.72 |
| Classifier | `overall_responder` | GBM | ~596 | AUC-ROC = 0.677 | — |
| Dropout | `is_dropout` | XGBoost | 1,716 | AUC-ROC = 0.998 | ~0.99 |
| Dropout | `is_dropout` | GBM | 1,716 | AUC-ROC = 0.992 | — |

XGBoost handles NaN natively (no imputer in its pipeline). The sensitivity analysis in `reports/modelling.html` shows metrics across four imputation strategies (complete-case, iterative MICE, kNN-5, median). SHAP feature importances and calibration curves are included for all six model blocks.

---

## Phenotype Rules

The taxonomy lives entirely in `config/phenotypes.yaml`. The clinical team can edit it without touching any Python.

### Workflow

```bash
# 1. Edit the YAML
nano config/phenotypes.yaml

# 2. Re-run phenotyping
make phenotype

# 3. Review unmatched tokens (feedback loop)
cat reports/unmatched_tags.csv | head -20

# 4. Sample classified records for clinical review
PYTHONPATH=src python scripts/03_phenotype.py --sample 30
```

### Adding a new group

```yaml
# config/phenotypes.yaml
groups:
  lymphoedema:
    label: "Lymphoedema"
    patterns:
      - 'lymphoedema'
      - 'lymphedema'
      - 'lymphatic'
```

Then add `lymphoedema` to the `priority` list at the appropriate rank, and to `cohort_rollup` if it belongs to an existing cohort (or create a new cohort label).

### Adding a new condition flag

```yaml
flags:
  has_lymphoedema:
    patterns:
      - 'lymphoedema'
      - 'lymphedema'
```

Flags are binary (0/1) and independent of the group hierarchy. They feed directly into model features.

### Why is my patient Unclassified?

Two reasons:
1. Both `tags` and `pain_location` are empty — structurally unclassifiable (~57% of this dataset).
2. The tags contain text that no pattern matches — check `reports/unmatched_tags.csv` for the token, then add a pattern.

---

## Adding a New Model

1. **Add config** to `config/models.yaml`:

```yaml
my_model:
  target: overall_responder
  features: [age, baseline_sppb, has_oa, cohort]
  model: random_forest
  cv: {kind: stratified_kfold, k: 5, stratify_on: cohort}
  metrics: [auc_roc, auc_pr, brier]
```

2. **Create the module** at `src/qtx/models/my_model.py`:

```python
from sklearn.ensemble import RandomForestClassifier
from qtx.models.evaluate import cross_validate_classifier, shap_importances
from qtx.utils.config import get_models_config

def train_my_model(df, imputation_strategy="complete_case"):
    cfg = get_models_config()["my_model"]
    # ... prep X, y, encode categoricals ...
    model = RandomForestClassifier(random_state=42)
    cv_metrics = cross_validate_classifier(model, X, y, cfg["cv"])
    shap_df = shap_importances(model, X)
    import joblib
    joblib.dump(model, "models/my_model.joblib")
    return {"model": model, "cv_metrics": cv_metrics, "shap_df": shap_df}
```

3. **Register** in `scripts/06_train_models.py`:

```python
from qtx.models.my_model import train_my_model
results["my_model"] = train_my_model(df)
```

4. Re-run: `make model`

---

## Testing

```bash
# Run all tests
make test

# With PYTHONPATH (if not installed editable)
PYTHONPATH=src pytest tests/ -v
```

**Coverage: 99 tests across 5 modules**

| Module | What's tested |
|--------|--------------|
| `test_clean.py` | Schema, NA harmonisation, case maps, DNC flags, legacy detection, age bands. Property-based tests (Hypothesis) for gender variants. |
| `test_phenotype.py` | 20 hand-labelled tag→cohort pairs, multi-label co-occurrence, absence=0 invariant, Unclassified for empty input. |
| `test_outcomes.py` | Direction correction for all 6 tests, MCID thresholds, NaN propagation, breadth counting, overall_responder logic. |
| `test_missing.py` | fill_zero, category_missing, complete-case drop, outcome exclusion, missing_indicator column generation. |
| `test_models.py` | Config (46 features per model, tuning blocks), imputer factory, XGB estimator factory, train contract for all 6 model/estimator combinations (best_params, n, Pipeline type), cross_validate_classifier F1 output. |

---

## Data Dictionary

Full field definitions, units, and allowed values are in the reference workbook:

```
data/inputs/QTX_AH_2024_organised.xlsx  →  sheet: Data Dictionary
```

The pipeline's canonical column names (snake_case), dtypes, and allowed values are in `config/schema.yaml`.

The 6 clinical assessment blocks:

| Block | Pre column | Post column | Direction | MCID |
|-------|-----------|------------|-----------|------|
| VAS (pain 0–10) | `pre_vas` | `post_vas` | Lower = better | ≥2 point reduction |
| TUG (timed up-and-go, s) | `pre_tug_s` | `post_tug_s` | Lower = better | ≥3 s or ≥10% |
| 5×SST (sit-to-stand, s) | `pre_5xsst_s` | `post_5xsst_s` | Lower = better | ≥10% |
| Normal gait speed (m/s) | `pre_normal_gs_ms` | `post_normal_gs_ms` | Higher = better | ≥0.05 m/s |
| Fast gait speed (m/s) | `pre_fast_gs_ms` | `post_fast_gs_ms` | Higher = better | ≥0.10 m/s |
| SPPB (0–12 composite) | `baseline_sppb` | `post_sppb` | Higher = better | ≥1 point |

---

## Clinical Context

**Treatment dosing** (`usage_frequency`):
- `Once (1x/week, one leg)` — one leg, one session/week
- `Twice (2x/week, one leg per session)` — alternating legs, two sessions/week
- `L+R 10 (20-min session, 10 min each leg)` — both legs in a single 20-min session

**Responder definition:** a patient who meets the MCID threshold on ≥2 tests is classified as an `overall_responder`. This threshold is configurable in `config/outcomes.yaml → responder_breadth.threshold_for_overall_responder`.

**Composite score:** each test's improvement is z-scored within cohort (if n ≥ 30) or globally, then averaged across available tests. Mean ≈ 0 by construction; positive values indicate above-average improvement relative to the cohort.

**Data completeness:**
- ~34.7% of patients have any follow-up measurement
- ~60% of patients have no comorbidity tags (Unclassified cohort)
- Missing follow-up is treated as informative dropout, not random missingness

---

## Reproducibility

All random seeds are set via `config/settings.yaml → random_seed`. Re-running `make all` on the same input file produces byte-identical Parquet outputs.

---

## Licence

Internal — QuantumTX Pte Ltd. Not for public distribution.
