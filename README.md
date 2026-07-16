# QTX-AH — QuantumTX Alexandra Hospital Clinical Intelligence Platform

A config-driven analytics and clinical-intelligence platform for QuantumTX's magnetic-mitohormesis therapy programme at Alexandra Hospital (AH) Singapore. The repository contains four co-located systems:

1. **ML pipeline** (`src/qtx`, `scripts/`, `config/`) — reproducible Python pipeline: ingestion → cleaning → phenotyping → outcomes → EDA → model training.
2. **Clinical API** (`api/`) — FastAPI + PostgreSQL 17 + pgvector backend serving predictions, AI insights, wearable ingestion, and PDF reports. Deployed on Railway.
3. **Clinician dashboard** (`web/`) — Next.js 14 app for cohort analytics and per-patient clinical views, including a patient-facing trajectory simulator. Deployed on Vercel.
4. **DLMS** (`dlms/`) — a separate Device Lifecycle Management System (Next.js 14 App Router + Supabase) for tracking the physical therapy devices. Deployed independently on Vercel + Supabase cloud.

> **Datasets:** 1,716 AH patient records (2024) across six functional assessment blocks (VAS, TUG, 5×SST, Normal Gait Speed, Fast Gait Speed, SPPB), ~34.7% follow-up rate — plus the RAISE multi-centre eldercare validation cohort (n=206, narrative-only; see [RAISE Dataset](#raise-dataset)).

---

## Security

All secrets (API keys, database credentials) are gitignored via `.env` — never committed. Copy `.env.example` to `.env` and fill in real values (see [Environment Variables](#environment-variables)). A pre-commit hook at `.git/hooks/pre-commit` blocks accidental commits of `.env` files and Anthropic key patterns; re-install it after each fresh clone.

**Before granting external access:** verify no secrets exist in git history (`git log --all -p -- '.env*'`, plus a pattern scan for `sk-ant-`, `eyJ`, `postgres://…:…@`). If anything is found, rewrite history with `git filter-repo` or BFG Repo Cleaner and rotate the exposed keys.

Auth model at a glance:

| Surface | Mechanism |
|---------|-----------|
| Clinical API (all `/api/*` routes) | `X-Api-Key` header (`QTX_API_KEY`) enforced by middleware |
| Admin endpoints (`/api/admin/*`) | Separate `X-Admin-Key` header (`QTX_ADMIN_KEY`), constant-time compare |
| Terra webhooks (`/webhooks/*`) | HMAC-SHA256 signature verification + 300 s replay window |
| DLMS | Supabase Auth + RBAC (viewer / engineer / admin) enforced in server actions and RLS; sign-up restricted to `@quantumtx.com` |

---

## Table of Contents

1. [Repository Structure](#repository-structure)
2. [Quick Start](#quick-start)
3. [Environment Variables](#environment-variables)
4. [Model Results](#model-results)
5. [Pipeline Reference](#pipeline-reference)
6. [Configuration System](#configuration-system)
7. [Clinical API](#clinical-api)
8. [Dual-Loop ML + AI](#dual-loop-ml--ai)
9. [RAISE Dataset](#raise-dataset)
10. [Wearable Integration](#wearable-integration)
11. [Web Dashboard](#web-dashboard)
12. [DLMS — Device Lifecycle Management](#dlms--device-lifecycle-management)
13. [Outputs & Reports](#outputs--reports)
14. [Phenotype Rules](#phenotype-rules)
15. [Adding a New Model](#adding-a-new-model)
16. [Testing](#testing)
17. [Data Dictionary](#data-dictionary)
18. [Clinical Context](#clinical-context)

---

## Repository Structure

```
quantumtx-ah/
├── config/                   # All rules, thresholds, and assumptions — edit here, not in code
│   ├── settings.yaml         # Paths, random seed, log level
│   ├── schema.yaml           # Canonical column names, dtypes, allowed values (reference)
│   ├── cleaning.yaml         # NA tokens, case maps, plausibility ranges, age bands
│   ├── phenotypes.yaml       # 3-layer taxonomy: 14 groups, 9 regions, 24 condition flags
│   ├── outcomes.yaml         # MCIDs, composite method, responder threshold
│   ├── missingness.yaml      # Per-feature imputation policy
│   ├── dosage.yaml           # Dosage-frequency model config
│   └── models.yaml           # Feature lists, hyperparameters, sensitivity variants
│
├── data/
│   ├── inputs/               # Source Excel files — READ ONLY, gitignored
│   ├── processed/            # Versioned Parquet snapshots (gitignored)
│   └── audit/                # Per-stage audit logs (CSV, gitignored)
│
├── src/qtx/                  # Pipeline library
│   ├── io/                   # Excel ingestion, Parquet persistence
│   ├── clean/                # NA harmonisation, type coercion, plausibility flags, audit log
│   ├── phenotype/            # YAML-driven regex classifier, coverage & unmatched reports
│   ├── outcomes/             # Change scores, composite z-score, MCID responder flags
│   ├── features/             # Modelling matrix builder, pandera schema validation
│   ├── models/               # Regression, classifier, dropout models; evaluate & SHAP
│   ├── eda/                  # Descriptive tables, Plotly figures, self-contained HTML report
│   └── utils/                # Config loader (YAML → dict, cached), Rich logging
│
├── api/                      # FastAPI clinical API (Railway)
│   ├── main.py               # App entry; API-key middleware, CORS, router mounting
│   ├── db.py / deps.py       # SQLAlchemy engine, model registry, hot-reload
│   ├── models/               # ORM: patients, sessions, predictions, insights, wearables
│   ├── routers/              # 15 routers (see Clinical API section)
│   ├── services/             # prediction, insight, retrain, calibration, anomaly, trend,
│   │                         #   ingest, report, terra, voyage, claude_client, wearable_features
│   └── templates/            # WeasyPrint PDF report template
│
├── web/                      # Next.js 14 clinician dashboard (Vercel, port 3000)
│   ├── app/                  # / (dashboard), /patient/[sn], /admin
│   ├── components/           # pages/, clinical/, charts/, patient/, ui/
│   └── lib/                  # api.ts (all fetches), types.ts, constants.ts
│
├── dlms/                     # Device Lifecycle Management System (self-contained app)
│   ├── app/                  # Next.js App Router pages + server actions (port 3001)
│   ├── lib/                  # domain/ (pure logic), services/, auth/ (RBAC), supabase/
│   ├── components/           # device/, analytics/, import/, layout/, ui/ (shadcn)
│   ├── supabase/             # migrations/, seed.sql, edge functions
│   │                         #   (warranty-alerts, weekly-digest)
│   └── __tests__/            # Vitest suite
│
├── scripts/                  # Pipeline stages (01–08, 10), DB migrations & seeds (11–25)
├── e2e/                      # Playwright E2E tests against the web dashboard
├── tests/                    # Backend pytest suite (incl. hypothesis property tests)
├── notebooks/                # Exploration notebooks
├── reports/                  # Generated HTML reports (gitignored)
└── models/                   # Trained joblib artefacts (XGB tracked for deploys; GBM gitignored)
```

---

## Quick Start

### Prerequisites

- Python 3.12 (`.python-version`; pyproject allows ≥3.11,<3.13)
- PostgreSQL 17 + pgvector (`brew install postgresql@17 pgvector pango`)
- Node 20+
- Source Excel files in `data/inputs/` (gitignored — copy in manually):
  - `QTX_AX(nov 2025) - Reet & Jun Yi.xlsx` — raw source
  - `QTX_AH_2024_organised.xlsx` — reference cleaned workbook

### Install & run the analytics stack

```bash
cd quantumtx-ah
pip install -e .                       # or: poetry install

# Database (first time)
psql postgres -c "CREATE USER qtx WITH PASSWORD 'secret';"
psql postgres -c "CREATE DATABASE qtxah OWNER qtx;"
psql qtxah    -c "CREATE EXTENSION IF NOT EXISTS vector; GRANT ALL ON SCHEMA public TO qtx;"

cp .env.example .env                   # fill in keys (see Environment Variables)
make setup                             # setup.sh: runs all DB migrations + seeding

make all                               # full pipeline: ingest → … → train (3–8 min)
make dev                               # API :8000 + web dashboard :3000
```

`web/.env.local` needs `NEXT_PUBLIC_API_URL=http://localhost:8000` and `NEXT_PUBLIC_API_KEY` matching `QTX_API_KEY`.

### Run the DLMS

The DLMS is independent of the analytics stack:

```bash
cd dlms
npm install
npm run setup        # scripts/setup.sh — local Supabase + migrations
npm run dev          # http://localhost:3001
```

Production deploys are manual: `vercel deploy --prod --yes` from `dlms/` after merging to `main` (git push does **not** auto-deploy).

---

## Environment Variables

Copy `.env.example` → `.env` at the repo root. Generate keys with `python3 -c "import secrets; print(secrets.token_hex(32))"`.

| Variable | Purpose |
|----------|---------|
| `QTX_API_KEY` | Internal API key; required on all non-webhook API routes (`X-Api-Key`) |
| `QTX_ADMIN_KEY` | Admin key for model hot-reload/retrain endpoints (`X-Admin-Key`); must differ from `QTX_API_KEY` |
| `DATABASE_URL` | e.g. `postgresql+psycopg2://qtx:secret@localhost:5432/qtxah` |
| `ANTHROPIC_API_KEY` | Claude (insights, Q&A, treatment briefs). **BAA required before sending real patient data in production** |
| `VOYAGE_API_KEY` | Voyage-3-lite embeddings (512 dims) for semantic retrieval |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist (default `http://localhost:3000`) |
| `RETRAIN_THRESHOLD` | Sessions since last retrain that trigger auto-retrain (default 50) |
| `CALIBRATION_DRIFT_THRESHOLD` / `CALIBRATION_MIN_COHORT_N` | Drift-based retrain gate (default 0.30 / 20) |
| `TERRA_DEV_ID` / `TERRA_API_KEY` / `TERRA_WEBHOOK_SECRET` | Terra wearable integration |
| `LOG_LEVEL` | API log level (default `INFO`) |

The DLMS keeps its own env (`dlms/.env.local` / Vercel): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`. Dev-mode role switching uses the server-only `DLMS_DEV_MODE` flag and is inert in production builds.

---

## Model Results

Latest full `make model` run on the 2024 AH dataset (2026-07-10 re-baseline; XGBoost only — GBM artifact training was dropped as never-served). Update this section after retraining on new data.

> **Methodology note (2026-07-10):** all metrics below come from **nested,
> patient-grouped 5-fold CV** — hyperparameters are selected inside each outer
> training fold, folds are grouped by patient (`sn`), and the regression target's
> cohort z-score normalisation is refit per fold. Earlier published numbers
> (regression R² 0.125 / RMSE ~0.58, classifier AUC 0.739, and all GBM rows) came
> from a leaky protocol (hyperparameter search over the full dataset, ungrouped
> shuffled folds, globally z-scored targets) and are **not comparable**; the
> classifier's honest AUC is lower, the regression RMSE is on a different target
> scale by construction (R² is the comparable number).

| Metric | Value | Notes |
|--------|-------|-------|
| Patients | 1,716 | 49 legacy (`OLD…`) records included but excluded from primary models |
| Follow-up rate | 34.7% (596 / 1,716) | Dropout is the primary data-quality challenge |
| Overall responders | 69.5% of follow-up (414 / 596) | ≥ MCID on 2+ tests |
| Classified by phenotype | 39.9% (684 / 1,716) | 60.1% Unclassified — most have no comorbidity tags |
| **Regression XGB** R² (composite improvement) | **0.176** | RMSE 0.752 ± 0.188 (per-fold-normalised target), MAE 0.491, n = 596 |
| **Classifier XGB** AUC-ROC (overall responder) | **0.691 ± 0.073** | AUC-PR 0.839, Brier 0.200, F1 0.683 |
| **Dropout XGB** AUC-ROC (predicts non-completion) | **0.998** | n = 1,716 — see caveat below |
| Dosage macro F1 (3-class) | 0.541 ± 0.041 | Macro AUC-ROC (OVR) 0.762, n = 544 labelled |

A fourth model family — **dosage frequency** (`make dosage`, `models/dosage_frequency.joblib`) — recommends a usage-frequency label with calibrated confidence.

**Top phenotype groups** (of classified patients): Joint disease 25%, Frailty/Sarcopenia 11%, Spine/Back 8%, Soft-tissue injury 6%, Neurological 4%.

**Interpretation notes:**
- XGBoost handles NaN natively (no imputer step in its pipeline).
- **Dropout-model caveat:** an ablation (2026-07-10) shows the **missingness mask
  alone** — the NaN pattern of the feature columns, with no values — achieves
  AUC-ROC **0.986** under the same grouped CV (logistic regression). The dropout
  model is therefore best understood as an administrative missing-data detector,
  not a clinical predictor; patients who drop out are largely those whose
  assessment blocks were never completed. Treat its score as a data-completeness
  flag, and do not present it as a clinical risk model.
- All metrics are nested, patient-grouped 5-fold CV. `reports/modelling.html` has SHAP importances, calibration curves, and the sensitivity analysis across four imputation strategies.

---

## Pipeline Reference

Each stage is an independent script. Run individually or chain with `make all`.

| Stage | Make target | Script | Input → Output |
|-------|------------|--------|----------------|
| 1. Ingest | `make ingest` | `scripts/01_ingest.py` | Excel → `data/processed/raw.parquet` |
| 2. Clean | `make clean-data` | `scripts/02_clean.py` | raw → `cleaned.parquet` + `data/audit/clean_audit.csv` |
| 3. Phenotype | `make phenotype` | `scripts/03_phenotype.py` | cleaned → `phenotyped.parquet` + `reports/unmatched_tags.csv` |
| 4. Outcomes | `make outcomes` | `scripts/04_outcomes.py` | phenotyped → `outcomes.parquet` |
| 5. EDA | `make eda` | `scripts/05_eda.py` | featured → `reports/eda.html` |
| 6. Features | `make features` | `scripts/07_export_dashboard_data.py` | outcomes → `featured.parquet` + `dashboard_data.parquet` |
| 7. Models | `make model` | `scripts/06_train_models.py` | featured → `models/*.joblib` + `reports/modelling.html` |
| 8. Dosage | `make dosage` | `scripts/08_train_dosage_model.py` | featured → `models/dosage_frequency.joblib` |

Beyond the training pipeline, `scripts/` also holds operational CLIs:

- `10_reconcile_wearables.py` (`make reconcile-wearables`) — link Terra users to patients
- `11_seed_database.py`, `16_ingest_raise_data.py`, `20_normalize_raise_usage_frequency.py`, `25_compute_cohort_response_curves.py`, `26_backfill_predictions.py` — DB seeding/backfills (run by `setup.sh`)
- `12/13/15/19/22/23/24_migrate_*.py` — idempotent schema migrations (run by `setup.sh`)
- `17_raise_model_evaluation.py` — offline RAISE covariate-shift evaluation
- `18_scheduled_retrain.py` — spawned by the API's auto-retrain services
- `21_calibration_report.py` — per-cohort calibration report

### Audit logs

Every value change during cleaning is recorded to `data/audit/clean_audit.csv` (`record_id | module | field | before | after | reason`). The current dataset produces ~24,000 audit rows, ~23,000 of which are NA-token harmonisations.

---

## Configuration System

**Rule:** no thresholds, patterns, or assumptions live in Python code. Edit YAML, re-run the affected stage.

### `config/cleaning.yaml`

- `na_tokens` — strings treated as missing (e.g. `"NA"`, `"-"`, `"nil"`)
- `gender_map`, `yesno_map`, `frequency_map` — case-insensitive normalisation maps
- `plausibility_ranges` — per-field `{min, max, dnc_above}` for out-of-range flagging
- `age_bands` — bucket boundaries for `age_band`
- `pre_post_pairs`, `followup_post_cols`, `column_roles` — structural column lists

### `config/outcomes.yaml`

MCIDs per test and composite computation:

```yaml
tests:
  tug:
    higher_is_better: false
    mcid_abs: 3        # ≥3 s improvement = clinically meaningful
    mcid_pct: 0.10     # OR ≥10% relative improvement
```

### `config/phenotypes.yaml`

The 3-layer taxonomy (groups / regions / condition flags), the `priority` order for primary indication, and the `cohort_rollup` mapping groups → 6 dashboard cohorts. See [Phenotype Rules](#phenotype-rules).

### `config/missingness.yaml`

Per-feature imputation strategy. Outcomes are **never imputed**:

```yaml
per_feature_policy:
  baseline_sppb: {strategy: iterative, max_missing_pct: 0.40}
  has_oa:        {strategy: fill_zero}
outcomes:
  policy: never_impute
```

### `config/models.yaml`

Feature lists, hyperparameter tuning blocks, CV settings, and sensitivity variants per model family.

---

## Clinical API

FastAPI app (`api/`), deployed on Railway. All routes except `/webhooks/*` require `X-Api-Key`; admin routes additionally require `X-Admin-Key`.

| Router | Concern |
|--------|---------|
| `patients` | Patient list/detail, per-metric session series |
| `sessions` | Longitudinal session ingest — triggers the dual-loop (below) |
| `predict` | On-demand outcome / dosage predictions |
| `ask` | Clinician Q&A with Voyage semantic retrieval + Claude |
| `plan` | AI treatment-plan briefs |
| `anomaly` | Rule-based proactive anomaly flags (+ Claude summaries) |
| `report` | WeasyPrint PDF patient reports |
| `calibration` | Per-cohort calibration metrics + drift status |
| `benchmark` | Cohort benchmark comparisons |
| `cohorts` | Cohort response curves |
| `triage` | Cross-patient attention worklist — read-only rollup of new anomalies, declining trends, and prediction divergence |
| `import_data` | CSV/Excel bulk import + parquet seeding (admin-gated) |
| `wearable` | Wearable enrollment + feature summaries |
| `webhooks` | Terra webhook ingest (HMAC-verified) |
| `admin` | Model hot-reload, retrain trigger, retrain state |

### Production seeding

Patient data files are **never tracked in git** (PHI). To seed or refresh a deployed
environment, upload the locally-built parquet through the admin-gated endpoint
(idempotent upsert — safe to re-run):

```bash
curl -X POST \
  -H "X-Api-Key: $QTX_API_KEY" -H "X-Admin-Key: $QTX_ADMIN_KEY" \
  -F "file=@data/processed/dashboard_data.parquet" \
  https://<railway-host>/api/import/seed_parquet
```

Alternative: run the full seed pipeline from a workstation against the remote DB —
`DATABASE_URL=<railway-postgres-url> bash setup.sh`. Both `POST /import/seed` and
`POST /import/file` also require `X-Admin-Key`.

AI stack: **Claude Sonnet 4.6** for narrative insights and Q&A, **Voyage-3-lite** (512-dim) for embeddings. Reasoning is per-patient only — cross-patient generation was ruled clinically inappropriate.

---

## Dual-Loop ML + AI

Every `POST /api/patient/{sn}/session` runs:

1. **PredictionService** — 4 XGBoost models → `session_predictions` (with SHAP top-5 drivers and bias correction)
2. **InsightService** — Claude prompt includes all model signals; flags model/observation divergence
3. **RetrainService** — count-based trigger: spawns `scripts/18_scheduled_retrain.py` when sessions since last retrain ≥ `RETRAIN_THRESHOLD`
4. **CalibrationService** — drift-based trigger: retrain if any cohort's MAE drifted ≥ `CALIBRATION_DRIFT_THRESHOLD` (1 h cooldown)

Retrain state lives in `retrain_state.json` (runtime file); scikit-learn is pinned `>=1.8,<1.9` to match the pickled models.

---

## RAISE Dataset

The RAISE multi-centre eldercare validation cohort (**n=206**) informs the AI layer as **narrative-only** context: its validated findings are cited in the Claude system prompt but do **not** feed any served XGBoost prediction (`deps.py` always serves the baseline `regression_xgb.joblib`).

- 162 RAISE rows are ingested into the DB (tagged `ingested_from ILIKE '%raise%'`) and excluded from calibration and metric-series queries. The 206/162 distinction is intentional — the published validation cohort vs rows loaded here.
- Validated findings in the prompt: diabetes = high-responder (ANCOVA p=0.015), frailty 5× response differential, dementia regression caution, peak response window age 70–79, SPPB near-ceiling (≈12) = success.
- Merging RAISE into QTX training is gated by `scripts/17_raise_model_evaluation.py`: covariate-shift AUC < 0.70 **and** `primary_indication` SHAP < 15% required.

---

## Wearable Integration

Terra powers wearable data ingestion:

- `/webhooks/terra` verifies HMAC-SHA256 signatures (300 s replay window) and stores pseudonymous `terra_user_id` + metrics; ingestion is idempotent.
- `api/services/wearable_features.py` aggregates activity/sleep features per patient.
- `make reconcile-wearables` links Terra users to patient records.

Terra PDPA / HBRA written confirmation is required before go-live with real patients.

---

## Web Dashboard

Next.js 14 app (`web/`, port 3000) talking to the Clinical API:

- **Overview / Cohorts / Clinical** pages — cohort analytics, response curves, per-patient clinical drawer
- **Clinical drawer tabs** — Timeline, AI (insights + Q&A), predictions (chips + SHAP drivers), anomaly warnings, dosage recommender, PDF export
- **Patient View** (`/patient/[sn]`) — patient-facing trajectory simulator: plain-English progress summary, goal picker, session slider with cohort p25–p75 percentile band
- **Admin** (`/admin`) — model health, retrain state, calibration drift

Tests: Jest + React Testing Library (`web/__tests__`), Playwright E2E at the repo root (`e2e/`, runs against `make dev`).

---

## DLMS — Device Lifecycle Management

Self-contained system under `dlms/` (Next.js 14 App Router + Supabase cloud). Tracks the physical therapy devices through their lifecycle.

**Features:** 21-field bilingual device registry with colour-coded create/edit, batch CSV/Excel import with serial-range expansion (`…-0001 to 0015`) and dedupe reporting, per-device tabs (component timeline, versioned change history, append-only service log), fleet-wide component traceability, device assignment + "My Queue", warranty-expiry and service-overdue banners with daily e-mail alerts (Resend), analytics dashboards with Excel/PDF export, AI invoice extraction to a drafts queue (Claude), keyboard shortcuts, filter presets.

**Architecture notes:**

- **RBAC** — viewer / engineer / admin roles via Supabase Auth; permission matrix in `lib/auth/permissions.ts` enforced in server actions; RLS + grants as a DB backstop (hardened 2026-07: `security_invoker` views, pinned `search_path`, anon revoked).
- **Audit** — every INSERT/UPDATE/soft-delete captured to `audit_log` with old/new values via trigger.
- **Edge functions** — `warranty-alerts` (daily cron), `weekly-digest`.
- **Domain layer** — pure, unit-tested logic in `lib/domain/` (serial ranges, status transitions, service schedules, component history); services do flat selects + JS reduction (no DB views/RPC).
- Sign-up restricted to `@quantumtx.com`; new accounts start inactive until an admin activates them.

Tests: 270 Vitest tests (`cd dlms && npm test`); `npm run type-check` is clean.

---

## Outputs & Reports

| File | Description |
|------|-------------|
| `data/processed/raw.parquet` | Original Excel values, canonical column names |
| `data/processed/cleaned.parquet` | NA-harmonised, type-coerced, plausibility-flagged |
| `data/processed/phenotyped.parquet` | + 48 phenotype columns (groups, regions, flags, cohort) |
| `data/processed/outcomes.parquet` | + improvement scores, MCID flags, composite, responders |
| `data/processed/featured.parquet` | Modelling-ready (imputed where configured, schema-validated) |
| `data/processed/dashboard_data.parquet` | Slim 73-col subset consumed by `scripts/11_seed_database.py` |
| `data/audit/clean_audit.csv` | Row-level audit trail for every cleaning transformation |
| `reports/eda.html` | Self-contained interactive EDA (Plotly, no CDN) |
| `reports/modelling.html` | CV metrics, SHAP importances, calibration, sensitivity analysis |
| `reports/unmatched_tags.csv` | Free-text tokens not matched by any phenotype rule |
| `models/{regression,classifier,dropout}_xgb.joblib` | XGBoost models (tracked — served by the API) |
| `models/dosage_frequency.joblib` | Calibrated dosage-frequency classifier (tracked) |
| `models/*_gbm.joblib` | GBM counterparts (~130 MB each, gitignored) |

All Parquet files are also version-stamped in `data/processed/snapshots/`.

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
head -20 reports/unmatched_tags.csv

# 4. Sample classified records for clinical review
PYTHONPATH=src python scripts/03_phenotype.py --sample 30
```

### Adding a new group

```yaml
groups:
  lymphoedema:
    label: "Lymphoedema"
    patterns:
      - 'lymphoedema'
      - 'lymphedema'
```

Then add `lymphoedema` to the `priority` list at the appropriate rank, and to `cohort_rollup` if it belongs to an existing cohort.

### Adding a new condition flag

```yaml
flags:
  has_lymphoedema:
    patterns:
      - 'lymphoedema'
      - 'lymphedema'
```

Flags are binary (0/1), independent of the group hierarchy, and feed directly into model features.

### Why is my patient Unclassified?

1. Both `tags` and `pain_location` are empty — structurally unclassifiable (~57% of this dataset).
2. The tags contain text no pattern matches — check `reports/unmatched_tags.csv`, then add a pattern.

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

2. **Create the module** at `src/qtx/models/my_model.py` using `cross_validate_classifier` / `shap_importances` from `qtx.models.evaluate`.

3. **Register** in `scripts/06_train_models.py`:

```python
from qtx.models.my_model import train_my_model
results["my_model"] = train_my_model(df)
```

4. Re-run `make model`. To serve it, register the artefact in `api/deps.py`.

---

## Testing

```bash
make test                        # backend: pytest tests/ (~620 tests, incl. hypothesis)
cd web && npm test               # dashboard: 26 Jest/RTL tests
npx playwright test              # 25 E2E tests (requires `make dev` running)
cd dlms && npm test              # DLMS: 270 Vitest tests
cd dlms && npm run type-check    # DLMS strict TS check
```

The backend suite covers the pipeline modules (clean, phenotype, outcomes, models, dosage), every API router and service (ingest, prediction, insight, retrain, calibration, anomaly, trend, reports, wearables/webhooks, middleware auth), and the RAISE ingest/evaluation scripts. DLMS tests cover the pure domain layer plus mutation-layer service tests via a Supabase chain mock.

---

## Data Dictionary

Full field definitions, units, and allowed values live in the reference workbook:

```
data/inputs/QTX_AH_2024_organised.xlsx  →  sheet: Data Dictionary
```

The pipeline's canonical column names (snake_case), dtypes, and allowed values are documented in `config/schema.yaml`.

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

**Responder definition:** meets the MCID threshold on ≥2 tests → `overall_responder`. Configurable in `config/outcomes.yaml → responder_breadth.threshold_for_overall_responder`.

**Composite score:** each test's improvement is z-scored within cohort (if n ≥ 30) or globally, then averaged across available tests. Mean ≈ 0 by construction.

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
