# QuantumTX AH-2024 — Project Handoff

**Date:** 2026-05-19  
**Repo:** https://github.com/reetmitra/qtx-ah.git  
**Local path:** `/Users/reetmitra/Desktop/QTX/quantumtx-ah/`  
**Status:** Pipeline complete, all 63 tests passing, dashboard live

---

## 1. What Was Built

A fully reproducible end-to-end Python ML pipeline for the Alexandra Hospital 2024 physiotherapy dataset. It covers: raw Excel ingestion → data cleaning → phenotype classification → outcomes computation → EDA → model training → Streamlit dashboard → dosage frequency recommender.

Everything is config-driven — no magic numbers in code. All thresholds, regex patterns, MCIDs, and feature lists live in YAML files under `config/`.

---

## 2. Data

**Source files** (in `data/inputs/`, gitignored — contain PII):

| File | Purpose |
|---|---|
| `QTX_AX(nov 2025) - Reet & Jun Yi.xlsx` | Raw patient data (sheet: "Overview of AH Users 2024", headers row 4, data row 5+) |
| `QTX_AH_2024_organised.xlsx` | Organised version (used for session lookups) |
| `cleaned_data.xlsx` | Hand-cleaned supplement — `Tags_clean` column + 11 binary condition flags + `frequency` dosage label |

**Key data facts:**
- 1,716 total patient rows
- 596 (34.7%) have any post-assessment follow-up
- 1,120 (65.3%) are classified as dropout (missing all post- measurements)
- 684 (39.9%) are phenotype-classifiable; 1,032 (60.1%) are Unclassified because they have no tags at all
- 686 rows have `tags_clean` from the supplement; 1,666 rows have ≥1 hand-labeled flag (`hl_*`)
- 544 rows have a `frequency` dosage label (once / twice / l + r 10) — used for the dosage recommender

---

## 3. Pipeline Stages

Run the full pipeline with `make all` from the project root (Python venv auto-detected).

### Stage-by-stage

| Stage | Script | Output | Make target |
|---|---|---|---|
| 1. Ingest | `scripts/01_ingest.py` | `data/processed/raw.parquet` (1716 × 43) | `make ingest` |
| 2. Clean | `scripts/02_clean.py` | `data/processed/cleaned.parquet` (1716 × 62) + `data/audit/clean_audit.csv` | `make clean-data` |
| 3. Phenotype | `scripts/03_phenotype.py` | `data/processed/phenotyped.parquet` (1716 × 136) + `reports/unmatched_tags.csv` | `make phenotype` |
| 4. Outcomes | `scripts/04_outcomes.py` | `data/processed/outcomes.parquet` (1716 × 161) | `make outcomes` |
| 5. EDA | `scripts/05_eda.py` | `reports/eda.html`, `reports/missingness_profile.html` | `make eda` |
| 6. Features + Export | `scripts/07_export_dashboard_data.py` | `data/processed/featured.parquet`, `data/processed/dashboard_data.parquet` | `make features` |
| 7. Models | `scripts/06_train_models.py` | `models/*.joblib`, `reports/modelling.html` | `make model` |
| 8. Dosage model | `scripts/08_train_dosage_model.py` | `models/dosage_frequency.joblib`, `reports/dosage_model.html` | `make dosage` |
| 9. Dashboard | `dashboard/app.py` | Streamlit app at http://localhost:8501 | `make dashboard` |

Run any script directly with:
```bash
PYTHONPATH=src .venv/bin/python3 scripts/XX_name.py
```

---

## 4. Repository Layout

```
quantumtx-ah/
├── config/
│   ├── settings.yaml          # Paths, logging, random_seed
│   ├── cleaning.yaml          # NA tokens, type maps, plausibility ranges, column roles
│   ├── phenotypes.yaml        # 14 groups, 9 regions, 24 flags, priority, cohort_rollup
│   ├── outcomes.yaml          # 6 tests, MCIDs, composite method, responder threshold
│   ├── missingness.yaml       # Per-feature imputation policy
│   ├── models.yaml            # 3 model configs, feature lists, sensitivity variants
│   ├── schema.yaml            # Column schema for validation
│   └── dosage.yaml            # Dosage recommender: label map, 21 features, GBM hyperparams
│
├── src/qtx/
│   ├── utils/
│   │   ├── config.py          # get_settings(), get_path(), all get_*_config() helpers
│   │   └── logging.py         # setup_logging() (idempotent), get_logger()
│   ├── io/
│   │   ├── load_raw.py        # openpyxl reader; maps raw headers → canonical names
│   │   ├── load_supplement.py # loads cleaned_data.xlsx; returns sn + tags_clean + hl_*
│   │   ├── load_sessions.py   # session/usage data loader
│   │   └── persist.py         # save_parquet() / load_parquet() with versioned snapshots
│   ├── clean/
│   │   ├── audit.py           # AuditLog class — logs every value change to CSV
│   │   ├── normalise.py       # 6-step normalisation (types, maps, gender, pre/post, sn)
│   │   └── plausibility.py    # Adds *_flag columns: "low"/"high"/"dnc" — never modifies values
│   ├── phenotype/
│   │   ├── rules.py           # load_rules() — compiles all regex patterns from YAML
│   │   ├── classify.py        # classify() — grp_*, rgn_*, has_*, primary_indication, cohort, final_*
│   │   └── validate.py        # coverage_report(), unmatched_fragments()
│   ├── outcomes/
│   │   ├── change_scores.py   # Direction-corrected improvements per test
│   │   ├── composite.py       # Z-score composite (cohort-stratified if n≥30)
│   │   └── responders.py      # Per-test responders, breadth_of_response, overall_responder, is_dropout
│   ├── missing/
│   │   ├── profile.py         # Missingness profile HTML report
│   │   └── impute.py          # FeatureImputer (fill_zero / category_missing / iterative MICE / knn5)
│   ├── features/
│   │   └── build.py           # build_feature_matrix() — applies imputation, pandera validation
│   ├── eda/
│   │   ├── descriptives.py    # Summary stats
│   │   ├── stratified.py      # 5 Plotly figures (strip plots, heatmaps, SHAP)
│   │   └── report.py          # Renders eda.html (inline Plotly JS, ~4.8MB)
│   ├── models/
│   │   ├── evaluate.py        # Cross-validated metrics + SHAP via TreeExplainer
│   │   ├── regression.py      # GradientBoostingRegressor → composite_improvement
│   │   ├── classifier.py      # GradientBoostingClassifier → overall_responder
│   │   └── dropout.py         # GradientBoostingClassifier → is_dropout
│   └── dosage/
│       ├── prepare.py         # build_dosage_matrix(), derive_features_for_prediction()
│       ├── train.py           # train_dosage_model() — calibrated 3-class GBM
│       ├── evaluate.py        # evaluate_multiclass_cv(), dosage_shap_importances()
│       └── predict.py         # predict_frequency() — returns recommendation + confidence + probs
│
├── scripts/                   # Numbered pipeline entry points (01–08)
├── dashboard/
│   ├── app.py                 # Streamlit main page (KPIs, filters, pre/post plots, intake estimator)
│   └── pages/
│       └── dosage_recommender.py  # Streamlit dosage frequency intake form page
├── tests/                     # 63 pytest tests
│   ├── test_clean.py          # 7 tests
│   ├── test_dosage.py         # 17 tests
│   ├── test_missing.py        # 5 tests
│   ├── test_outcomes.py       # 11 tests
│   └── test_phenotype.py      # 23 tests
├── data/                      # gitignored
│   ├── inputs/                # Source Excel files
│   ├── processed/             # Parquet outputs (raw → cleaned → phenotyped → outcomes → featured)
│   ├── processed/snapshots/   # Dated versioned copies
│   └── audit/                 # clean_audit.csv
├── models/                    # gitignored — .joblib model artefacts
├── reports/                   # gitignored — HTML reports + unmatched_tags.csv
├── Makefile
├── pyproject.toml
├── README.md
└── HANDOFF.md                 # This file
```

---

## 5. Config Reference

### `config/settings.yaml`
All file paths relative to project root. `get_path(key)` returns absolute `Path`.
```yaml
paths:
  raw_excel: "data/inputs/QTX_AX(nov 2025) - Reet & Jun Yi.xlsx"
  supplement_excel: "data/inputs/cleaned_data.xlsx"
  processed: "data/processed"
  audit: "data/audit"
```

### `config/cleaning.yaml`
- `na_tokens`: list of strings treated as NA (e.g. "N/A", "-", "nil")
- `plausibility_ranges`: per-column min/max/`dnc_above` thresholds (TUG/SST use `dnc_above` because high values = "did not complete")
- `column_roles`: maps role names to column lists (numeric, yesno, gender, frequency, etc.)
- `pre_post_pairs`: list of `[pre_col, post_col]` pairs for direction checks

### `config/phenotypes.yaml`
Core taxonomy — edit this to improve classification coverage:
- `groups`: 14 groups, each with `label` + `patterns` list (regex)
- `regions`: 9 anatomical regions
- `flags`: 24 binary condition flags (`has_*`)
- `priority`: ordered list of group keys (first match wins for `primary_indication`)
- `cohort_rollup`: maps cohort label → list of group keys

### `config/outcomes.yaml`
- `tests`: 6 entries with `pre_col`, `post_col`, `direction` (+1 or -1), `mcid_abs`, `mcid_pct`
- `composite_method`: `z_mean_available_case` (z-score within cohort if n≥30, else global)
- `threshold_for_overall_responder`: 2 (need ≥2 individual test responders)

### `config/missingness.yaml`
- Per-feature policies: `fill_zero` (has_* flags), `category_missing`, `iterative` (MICE), `knn5`, `median`
- `outcomes.policy: never_impute` — post_* columns are never imputed

### `config/models.yaml`
- 3 model configs: regression, classifier, dropout
- `features`: 16 features used (demographics + phenotype flags + baseline scores)
- 4 sensitivity variants (complete_case / iterative / knn5 / median) × 3 feature sets

### `config/dosage.yaml`
All dosage recommender parameters. Edit and re-run `make dosage` — no code changes needed.
- `label_map`: maps raw frequency strings from `cleaned_data.xlsx` to integer class labels
- `label_names`: compact slugs indexed by label int (`once`, `twice`, `lr10`)
- `intake_features_encoded`: the 21 model input columns (14 base + 7 engineered)
- `model`: GBM hyperparameters (`n_estimators`, `learning_rate`, `max_depth`, `min_samples_leaf`)
- `calibration`: Platt scaling settings (`method: sigmoid`, `cv: 5`)
- `cv.k`: number of folds for evaluation cross-validation (distinct from calibration CV)
- `model_path`: relative path to the saved `.joblib` artefact

---

## 6. Phenotype Classification

**How it works:**
1. Each patient row's `tags_clean` (preferred) or raw `tags` column + `pain_location` are combined into a single lowercase string (the "text blob")
2. Regex patterns from `phenotypes.yaml` are matched against this blob
3. Each matched group/region/flag gets a binary column (`grp_*` / `rgn_*` / `has_*`)
4. `primary_indication` = first matching group in priority order (or "Unclassified")
5. `cohort` = lookup of `primary_indication` in `cohort_rollup`

**Current cohort distribution:**

| Cohort | Count | % |
|---|---|---|
| Pain & Musculoskeletal | 456 | 26.6% |
| Frailty/Sarcopenia | 80 | 4.7% |
| Neurological | 76 | 4.4% |
| Post-Surgical/Rehab | 52 | 3.0% |
| Other-Mixed | 17 | 1.0% |
| Wellness | 3 | 0.2% |
| **Unclassified** | **1,032** | **60.1%** |

**The 60% unclassified problem:** 977 patients have no tags whatsoever in the source data — they cannot be classified regardless of how good the regex patterns are. The remaining ~55 unclassified patients have tags that don't match any current pattern. To improve coverage:
1. Check `reports/unmatched_tags.csv` — lists tag fragments that matched no pattern
2. Add new patterns to `config/phenotypes.yaml`
3. Re-run `make phenotype` (no retraining needed)

---

## 7. Supplement Integration (`cleaned_data.xlsx`)

The hand-cleaned workbook at `data/inputs/cleaned_data.xlsx` provides three things:

**`tags_clean`** — Pre-cleaned, lowercased version of the Tags column. Used instead of raw `tags` when available (686 patients). Merged into `cleaned.parquet` during stage 2 and used by the classifier in stage 3.

**`hl_*` flags** — 11 hand-labeled binary condition flags for 1,666 patients, sourced from columns `knee_issue`, `leg_issue`, etc. in Sheet1:

| Source column | Canonical name | Maps to `final_*` via |
|---|---|---|
| `knee_issue` | `hl_knee_issue` | `has_knee_issue` |
| `leg_issue` | `hl_leg_issue` | `rgn_lower_limb` |
| `back_spine_issue` | `hl_back_spine_issue` | `has_spinal_issue` |
| `balance_issue` | `hl_balance_issue` | `has_balance_issue` |
| `upper_body_issue` | `hl_upper_body_issue` | `has_shoulder_issue` |
| `foot_ankle_issue` | `hl_foot_ankle_issue` | `rgn_ankle_foot` |
| `neuro_issue` | `hl_neuro_issue` | `has_neurological` |
| `frailty_issue` | `hl_frailty_issue` | `has_frailty` |
| `metabolic_issue` | `hl_metabolic_issue` | `has_metabolic` |
| `injury_surgery_issue` | `hl_injury_surgery_issue` | `has_post_surgery` |
| `general_pain_issue` | `hl_general_pain_issue` | `has_chronic_pain` |

**`final_*` columns** — 11 merged columns in `phenotyped.parquet`. Hand label (`hl_*`) takes priority when present (non-NA); automated classifier result (`has_*` or `rgn_*`) is used as fallback. These are the recommended columns for downstream analysis.

**`frequency`** — Dosage label per patient (`once`, `twice`, `l + r 10`). Used exclusively by the dosage recommender. 544 rows labelled; 1,172 rows missing (not all patients have a prescribed frequency).

**Join key:** Patient S/N is normalised to string `"1.0"`, `"2.0"` etc. to match the `sn` column in the pipeline parquets.

---

## 8. Outcomes

Six functional tests are tracked:

| Test | Pre col | Post col | Direction | MCID (abs) |
|---|---|---|---|---|
| VAS Pain | `pre_vas_pain` | `post_vas_pain` | Lower=better | 1.5 |
| TUG | `pre_tug_s` | `post_tug_s` | Lower=better | 3.5s |
| 5xSST | `pre_5xsst_s` | `post_5xsst_s` | Lower=better | 2.3s |
| Normal Gait Speed | `pre_normal_gs_ms` | `post_normal_gs_ms` | Higher=better | 0.1 m/s |
| Fast Gait Speed | `pre_fast_gs_ms` | `post_fast_gs_ms` | Higher=better | 0.1 m/s |
| SPPB | `pre_sppb` | `post_sppb` | Higher=better | 1 point |

**Derived columns:**
- `{test}_improvement` — direction-corrected improvement (positive = better)
- `z_{test}_improvement` — z-scored within cohort (if n≥30) else globally
- `composite_improvement` — mean of available z-scored improvements
- `{test}_responder` — 1 if improvement ≥ MCID (abs OR pct threshold, whichever is met)
- `breadth_of_response` — count of tests where patient is a responder (0–6)
- `overall_responder` — 1 if breadth_of_response ≥ 2
- `is_dropout` — 1 if all post- columns are missing

**Missingness note:** Post- columns are never imputed. Outcome computation is available-case only. 596 patients (34.7%) have sufficient data for any outcome analysis.

---

## 9. Models

### Clinical outcome models (stages 1–3)

Three GradientBoosting models, all saved to `models/` as `.joblib` files.

| Model | Target | File | Performance |
|---|---|---|---|
| Regression | `composite_improvement` | `models/regression.joblib` | RMSE=0.61, R²=0.04 |
| Classifier | `overall_responder` | `models/classifier.joblib` | AUC-ROC=0.63 |
| Dropout predictor | `is_dropout` | `models/dropout.joblib` | AUC-ROC=0.97 |

**Performance context:**
- The regression and classifier performance is modest — this is expected given the high dropout rate (65%), heavily missing baseline functional scores, and heterogeneous population.
- The dropout AUC of 0.97 is not data leakage — missing baseline data is itself the strongest predictor of non-completion. This is a real clinical signal.
- Complete-case analysis drops ~70% of data. Sensitivity analysis across 4 imputation strategies (complete_case, MICE, knn5, median) is documented in `reports/modelling.html`.

**SHAP:** All models use `shap.TreeExplainer` for feature importance. Top predictors for the classifier are typically `n_sessions`, `age`, and phenotype group flags.

### Dosage frequency recommender (stage 8)

A separate 3-class `GradientBoostingClassifier` calibrated with Platt scaling, trained on 544 labelled rows from `cleaned_data.xlsx`.

**File:** `models/dosage_frequency.joblib`  
**Report:** `reports/dosage_model.html`  
**Retrain:** `make dosage`

**Classes:**

| Label | Raw string | Count | Description |
|---|---|---|---|
| 0 | `once` | 424 | Once per week, one leg |
| 1 | `twice` | 32 | Twice per week, one leg per session |
| 2 | `l + r 10` | 88 | L+R bilateral, 10 min each leg |

**Performance (5-fold CV):**

| Metric | Value |
|---|---|
| Macro AUC-ROC | 0.762 |
| Macro F1 | 0.541 ± 0.041 |
| Per-class F1 (once / twice / lr10) | 0.819 / 0.108 / 0.695 |

The "twice" class F1 (0.108) is limited by its small training size (n=32). This is a data constraint, not a modelling failure — distinguishing twice from once at intake requires functional measures not yet collected.

**Features (21 total):** 14 base intake features + 7 clinically-engineered composites:

| Feature | Source | Clinical rationale |
|---|---|---|
| `age` | direct | Continuous age |
| `gender_M` | direct | Binary: male=1 |
| `joined_with_pain_Y` | direct | Binary: enrolled with pain=1 |
| `hl_knee_issue` … `hl_general_pain_issue` | direct (×11) | Hand-labeled condition flags |
| `age_above_65` | derived | Venugobal 2023: 66+ cohort are strongest once-weekly PEMF responders |
| `age_above_75` | derived | Venugobal 2023: 76–91 cohort shows greatest absolute mobility gains |
| `bilateral_lower_limb_load` | derived | Sum of knee+leg+foot+balance flags (0–4); predicts L+R bilateral treatment |
| `inflammatory_burden` | derived | Sum of knee+back+general_pain+injury flags; Franco-Obregón 2023: once-weekly resets systemic inflammation |
| `elderly_frailty` | derived | age_above_65 × frailty flag; interaction captures highest-responder subgroup |
| `muscle_atrophy_risk` | derived | age_above_65 × (frailty+neuro+leg) composite (0–3); Kurth 2020: TRPC1-mediated atrophy severity |
| `pain_with_knee` | derived | knee × joined_with_pain interaction; Wang 2024: bilateral knee OA with pain → bilateral treatment |

**Scientific basis:** Features were derived from 9 peer-reviewed PEMF clinical papers (Yap 2019, Tai 2020, Kurth 2020, Parate 2017 & 2020, Stephenson 2022, Venugobal 2023, Wang 2024, Franco-Obregón 2023). The core mechanism is the TRPC1-mitochondrial axis and magnetic mitohormesis: once-weekly 1 mT PEMF is the optimal dose for most patients; bilateral lower-limb conditions indicate bilateral (L+R) treatment; frail elderly respond most strongly to once-weekly.

---

## 10. Dashboard

**Start:** `make dashboard` or `PYTHONPATH=src .venv/bin/streamlit run dashboard/app.py`  
**URL:** http://localhost:8501

### Pages

**Clinical Dashboard (`app.py` — main page)**
- Top KPIs: N Patients, % with Follow-up, Mean Composite Improvement, % Overall Responders
- Sidebar filters: Cohort (multi-select), Usage Frequency, Age Band, Gender, Record Type
- Pre vs Post comparison: paired box plots for all 6 functional tests
- Mean composite improvement by comorbidity flag (horizontal bar chart)
- Intake Estimator (expander): enter demographics + conditions → model predicts composite improvement, P(Responder), P(Dropout)

**Dosage Recommender (`pages/dosage_recommender.py`)**
- Intake form: age, gender, joined-with-pain, 11 condition checkboxes
- On submit: derives 7 engineered features automatically, runs the dosage model
- Outputs: recommended frequency label (once / twice / L+R 10), model confidence %, probability breakdown bar chart
- Confidence warning displayed if model confidence < 50% (atypical patient profile)

Sidebar navigation links between both pages are explicit (`st.page_link`) — required for Streamlit 1.36+ multi-page apps.

---

## 11. Testing

```bash
PYTHONPATH=src .venv/bin/pytest tests/ -v
```

63 tests across 5 files:

| File | Tests | Coverage |
|---|---|---|
| `tests/test_clean.py` | 7 | Normalise, plausibility, audit log, Hypothesis property tests |
| `tests/test_dosage.py` | 17 | prepare (5), evaluate (3), train (4), predict (5) |
| `tests/test_missing.py` | 5 | Imputation strategies, outcome exclusion, complete-case |
| `tests/test_outcomes.py` | 11 | Change scores, composite, responders, is_dropout |
| `tests/test_phenotype.py` | 23 | 20 parametrized pattern tests, coverage report, blob building |

Tests use minimal in-memory DataFrames — no file I/O, no Excel reads. The dosage tests use `_add_engineered_features()` internally so that synthetic test matrices always match the config's `intake_features_encoded` list.

---

## 12. Git History

```
e4a6225  feat(dosage): add clinically-grounded engineered features + retune GBM
6d7a5bf  fix(dosage): keep DataFrame feature names in CV loop to silence sklearn warnings
4de779b  feat(dosage): add Streamlit intake form page for frequency recommendation
d8f69e7  feat(dosage): add make dosage target
d87c623  feat(dosage): add training script 08_train_dosage_model.py
6871bee  feat(dosage): implement predict_frequency inference wrapper
e348ee7  feat(dosage): implement train_dosage_model with calibrated GBM
5eecebb  feat(dosage): implement evaluate_multiclass_cv and dosage_shap_importances
5deac8b  fix(dosage): compute age median on to_numeric coerced series
a9b7eb2  feat(dosage): implement build_dosage_matrix and load_dosage_data
92957fb  feat(dosage): add get_dosage_config() loader
96cf756  fix(dosage): clarify label_map key normalization and dual cv blocks in dosage.yaml
505c4c1  feat(dosage): add dosage.yaml config
ce66546  feat: integrate hand-cleaned supplement (tags_clean + 11 hl_* flags)
51616d9  docs: add baseline results section with v0.1.0 pipeline metrics
d3eb1cf  fix(makefile): use venv python3, set PYTHONPATH=src, fix features target
39f9ef7  docs: comprehensive README with pipeline reference, config guide, clinical context
14d6e2c  Add test suite (46 tests) and project README
ce0888e  feat(dashboard): implement Streamlit clinical analytics dashboard
6c227b9  feat(models): implement three model families and training pipeline
b2cdfe9  feat(eda): implement EDA modules and HTML report generation
39e53ff  feat(features): implement feature matrix builder and dashboard export
613648e  feat(missing): implement missingness profiling and per-feature imputation
f0a4f3e  feat(outcomes): implement change scores, composite, responders and 04_outcomes script
85905b8  feat(phenotype): implement rules, classify, validate and 03_phenotype script
916f22b  feat(clean): drive column roles and pre/post pairs from cleaning.yaml
46dc32a  feat(clean): implement full cleaning pipeline — audit, normalise, plausibility
6082d30  feat(io): implement data ingestion — load_raw, persist, and 01_ingest
6d4d782  feat(utils): implement config loader and Rich logging setup
e0959e4  chore: bootstrap quantumtx-ah project skeleton
```

---

## 13. Known Issues / Future Work

### Phenotype coverage (highest priority)
- 60% of patients are Unclassified because they have no tags in the source Excel
- For classifiable patients with tags: review `reports/unmatched_tags.csv` and expand patterns in `config/phenotypes.yaml`
- Consider: ask AH staff to retroactively fill tags for historical records, or back-classify from diagnosis codes if available

### Dosage recommender — "twice" class
- The "twice" frequency class has only 32 labelled examples; per-class F1 is 0.108
- The papers (Wang 2024, Venugobal 2023) suggest twice is often a clinical refinement decision rather than an intake-predictable one — it depends on in-session response and functional deficits measured during the session, not just at intake
- **Most impactful fix:** collect `pre_tug_s` and `pre_5xsst_s` at intake for dosage-labelled patients and add them to `intake_features_encoded` in `dosage.yaml`; these are the strongest predictors of whether a patient needs more frequent treatment
- As the labelled dataset grows beyond n=100 for "twice", F1 should improve substantially

### Dosage recommender — future features
The `future_features` block in `dosage.yaml` lists four fields not yet collected at intake that would meaningfully improve dosage prediction:
```yaml
future_features:
  - activity_level          # sedentary / light_active / moderately_active / very_active
  - exercise_freq_per_week  # 0 / 1-2 / 3-4 / 5+
  - pain_duration_months    # float
  - prior_physio            # Y / N
```
Once these are added to `cleaned_data.xlsx`, add them to `intake_features_raw` and `intake_features_encoded` in `dosage.yaml` and re-run `make dosage` — no code changes required.

### Clinical outcome model performance
- R²=0.04 for composite improvement is low. Factors: small effective sample (n≈596), high missingness on baseline functional scores (TUG 63% missing, SST 68% missing), and genuine heterogeneity of the patient population
- Consider separate models per cohort once cohort sample sizes grow
- SPPB is a strong predictor but is missing for many patients — prioritise collection at intake

### Data quality
- `pre_tug_s` and `pre_5xsst_s` are missing for 63–68% of patients at baseline — these are the highest-value measurements for outcome and dosage prediction
- `tags` column is blank for ~57% of patients — limits phenotyping
- The plausibility flagging (`*_flag` columns in `cleaned.parquet`) identifies out-of-range values but does not correct them; manual review is needed for flagged records

### Supplement sync
- `cleaned_data.xlsx` is a manual snapshot. As new patients are added to the main workbook, the supplement will drift out of sync. Consider a process to periodically update it.
- `load_supplement()` uses `@lru_cache` — in long-running processes, call `load_supplement.cache_clear()` after updating the file

### Infrastructure
- There is no CI pipeline (no GitHub Actions). Consider adding one to run `pytest` on push.
- Dashboard is not deployed — it runs locally only. For sharing with AH staff, consider Streamlit Cloud or a simple VPS deploy.

---

## 14. Environment Setup (for a new machine)

```bash
# Clone
git clone https://github.com/reetmitra/qtx-ah.git
cd quantumtx-ah

# Create venv (Python 3.11+ recommended; project developed on 3.14)
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"   # or: pip install -r requirements.txt

# Place data files (not in repo — obtain from team)
cp /path/to/data_files data/inputs/

# Run pipeline
make all         # stages 1–7: ingest through models
make dosage      # stage 8: train dosage recommender

# Run tests
PYTHONPATH=src pytest tests/ -v

# Start dashboard
make dashboard
```

**Key env requirement:** `PYTHONPATH=src` must be set for all script and test runs (set automatically by Makefile; set manually for direct invocations).

---

## 15. Key Contacts / Context

- **Project:** QuantumTX Alexandra Hospital 2024 physiotherapy cohort
- **Data owner:** Reet Mitra (reetmitra8@gmail.com)
- **Data period:** 2024 AH patient intake and follow-up assessments
- **Supplement workbook:** Hand-cleaned by Reet & Jun Yi (`cleaned_data.xlsx`)
- **Source workbook:** `QTX_AX(nov 2025) - Reet & Jun Yi.xlsx`
- **PEMF device:** QuantumTx (Singapore) — 1 mT, 50 Hz, 10 min/session
- **Clinical papers underpinning dosage model:** Yap et al. 2019 (FASEB J), Tai et al. 2020 (FASEB J), Kurth et al. 2020 (Adv Biosystems), Parate et al. 2017 & 2020 (Sci Rep / Stem Cell Res Ther), Stephenson et al. 2022 (J Orthop Transl), Venugobal et al. 2023 (Aging), Wang et al. 2024 (Front Med), Franco-Obregón 2023 (Biocell)
