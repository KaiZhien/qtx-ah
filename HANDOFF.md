# QTX-AH Handoff — Clinical Intelligence System

**Date:** 2026-06-04
**Branch:** main
**Commit:** ed07e3e
**Status:** Sub-projects 1–4 complete. RAISE dataset ingested (162 patients). Dual-loop ML+AI integration live. Fall risk module removed (owned by separate team). 410 tests passing.

---

## What We Are Building

A per-patient clinical intelligence system in four sub-projects that must be built in order.

### Sub-project 1 — Foundation: Database + Data Ingestion ✅ COMPLETE
Replaced the static `data/processed/dashboard_data.parquet` with PostgreSQL (+ pgvector). Built a CSV/Excel import pipeline and longitudinal session schema.

### Sub-project 2 — Patient Knowledge Graph ✅ COMPLETE
Per-patient longitudinal model. Each new clinic visit creates a new session row. Trend signals computed automatically on each new session entry (e.g. "gait speed improving", "TUG plateaued for 3 sessions"). Clinician observations stored alongside measurements.

### Sub-project 3 — AI Reasoning Layer ✅ COMPLETE
Claude Sonnet 4.6 + Voyage-3-lite embeddings (512 dimensions). Reasons **purely over THIS patient's own data** — no cross-patient comparison (clinically inappropriate). Two modes: (a) proactive session insights, (b) clinician Q&A with semantic retrieval of past insights. BAA with Anthropic required before sending patient data in production.

### Sub-project 4 — Frontend + PDF Reporting ✅ COMPLETE
Timeline tab, AI tab (Q&A + insight history), MetricChart, InsightCard, QAPanel all wired to live API. PDF export (`GET /api/patient/{sn}/report.pdf`) verified end-to-end.

---

## Key Technical Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Database | PostgreSQL 17 + pgvector | Vector storage + concurrent access; pgvector requires PG17+ on macOS homebrew |
| Embeddings | Voyage-3-lite ($0.06/1M tokens) | Best structured-data quality at lowest cost; 512 dimensions |
| LLM | Claude Sonnet 4.6 | Best clinical reasoning benchmarks; HIPAA BAA available |
| Reasoning scope | Per-patient only | Cross-patient comparison is clinically inappropriate |
| Patient data compliance | Treat as PHI; sign Anthropic BAA | Small population (~2K patients) makes anonymisation insufficient |
| Env loading | python-dotenv in api/main.py | API server reads project root .env at startup |
| Fall risk | Removed from this codebase | Owned and maintained by a separate team member |

---

## Local Dev Setup

### Prerequisites (macOS)
```bash
# Install system deps (one-time)
brew install postgresql@17 pgvector pango

# Start Postgres (persists across reboots)
brew services start postgresql@17

# Create DB and user (one-time)
psql postgres -c "CREATE USER qtx WITH PASSWORD 'secret';"
psql postgres -c "CREATE DATABASE qtxah OWNER qtx;"
psql qtxah -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql qtxah -c "GRANT ALL ON SCHEMA public TO qtx;"
```

### Environment files
**`quantumtx-ah/.env`** (API server — gitignored):
```
QTX_API_KEY=<32-byte hex>
QTX_ADMIN_KEY=<separate 32-byte hex>
DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah
LOG_LEVEL=INFO
TERRA_WEBHOOK_SECRET=
TERRA_DEV_ID=
TERRA_API_KEY=
```

**`quantumtx-ah/web/.env.local`** (Next.js — gitignored):
```
NEXT_PUBLIC_API_KEY=<same 32-byte hex as QTX_API_KEY>
NEXT_PUBLIC_API_URL=http://localhost:8000
```

Both keys must match exactly.

### Seed the database and run migrations (one-time after fresh setup)
```bash
# 1. Seed QTX patient data (1,715 patients)
DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \
PYTHONPATH=src .venv/bin/python3.14 scripts/11_seed_database.py
```
Expected: `Inserted: 1,715 / Errors: 0`

```bash
# 2. Add notes column (migration 12)
PYTHONPATH=api .venv/bin/python3.14 scripts/12_migrate_add_notes_column.py

# 3. Add Voyage embedding column + IVFFlat index to patient_insights (migration 13)
#    Required for AI Q&A retrieval and PDF report generation.
#    Skipping this causes 500 errors on GET /api/patient/{sn}/report.pdf.
PYTHONPATH=api .venv/bin/python3.14 scripts/13_migrate_add_embeddings.py
```
Expected: `Migration 13 complete.`

```bash
# 4. Add Tandem stand columns — pre_tandem_s on patients, post_tandem_s on sessions (migration 15)
PYTHONPATH=src:api .venv/bin/python3.14 scripts/15_migrate_add_tandem.py

# 5. Ingest RAISE eldercare dataset — 162 patients across 3 centres (script 16)
#    Source file: 'Raise combined data (4 centres).xlsx'
#    Patients land in DB with ingested_from = 'Raise combined data (4 centres).xlsx'
PYTHONPATH=src:api .venv/bin/python3.14 scripts/16_ingest_raise_data.py
```
Expected: `Ingested 162 rows, 0 errors`

```bash
# 6. Add session_predictions table (migration 19)
#    Required for dual-loop ML+AI integration (PredictionService writes here on every session).
PYTHONPATH=src:api .venv/bin/python3.14 scripts/19_migrate_add_session_predictions.py
```
Expected: `Migration 19 complete.`

### Run everything
```bash
make dev   # starts API (port 8000) + Next.js (port 3000) concurrently
```

---

## Current Codebase State

**Working directory:** `/Users/reetmitra/Desktop/QTX/quantumtx-ah`

**Test command:**
```bash
PYTHONPATH=src:api .venv/bin/pytest tests/ -v
```

**Import convention (critical):** All `api/` files use bare imports (`from db import get_db`). `api/` has no `__init__.py`. All test files that exercise API code must add `api/` to `sys.path`.

**File map:**
```
api/
  db.py                    — lazy Postgres engine, Base, get_db, init_db
  deps.py                  — ML model loading, _db_ready flag
  main.py                  — FastAPI app, lifespan, dotenv load, all routers
  models/
    clinical.py            — Patient, Session, PatientCondition, PatientInsight,
                             SessionPrediction ORM models
    wearable.py            — WearableEnrollment, WearableActivity, etc.
  routers/
    patients.py            — GET /api/patients, GET /api/patient/{sn}
    predict.py             — POST /api/predict/outcomes, /dosage
    wearable.py            — wearable enrollment + features
    import_data.py         — POST /api/import/seed, /import/file
    webhooks.py            — POST /webhooks/terra
    sessions.py            — POST /api/patient/{sn}/session (runs PredictionService +
                             InsightService + RetrainService on every new session)
                             GET /api/patient/{sn}/predictions/latest
    ask.py                 — POST /api/patient/{sn}/ask (AI Q&A)
    report.py              — GET /api/patient/{sn}/report.pdf (PDF export)
    admin.py               — POST /api/admin/reload-models (hot-swap model files)
  services/
    ingest.py              — IngestPipeline, IngestSummary, RowError
    insight.py             — InsightService (Claude Sonnet 4.6 + Voyage RAG)
    voyage.py              — VoyageEmbedder (voyage-3-lite, 512 dims, 5s timeout)
    prediction.py          — PredictionService (runs regression/classifier/dropout/dosage,
                             saves SessionPrediction row; fall risk excluded)
    retrain.py             — RetrainService.check_and_trigger() (threshold-based background spawn)
    terra.py               — Terra API client
    wearable_features.py   — rolling wearable feature computation
    report.py              — WeasyPrint PDF generation (requires libpango)
  templates/
    patient_report.html    — Jinja2 template for PDF clinical report
web/
  app/
    globals.css            — design system tokens + .btn:disabled style
    layout.tsx / page.tsx
  components/
    pages/                 — OverviewPage, CohortsPage, ClinicalPage
    clinical/              — InsightCard, MetricChart, QAPanel, TimelineTab, AITab,
                             PredictionChips (model signals chips in AI tab)
    ui/                    — Card, Drawer, Field, KPI, Pill, Tabs, Icons
  lib/
    api.ts / types.ts / constants.ts
scripts/
  11_seed_database.py              — seed Postgres from dashboard_data.parquet
  12_migrate_add_notes_column.py   — adds notes column to sessions
  13_migrate_add_embeddings.py     — adds embedding vector(512) + IVFFlat index to patient_insights
  14_eda_raise_data.py             — EDA report for RAISE dataset (informational only)
  15_migrate_add_tandem.py         — adds pre_tandem_s (patients) + post_tandem_s (sessions)
  16_ingest_raise_data.py          — ingests 162 RAISE patients into PostgreSQL
  17_raise_model_evaluation.py     — covariate shift test + conditional retraining gate
  18_scheduled_retrain.py          — background retrain job (spawned by RetrainService)
  19_migrate_add_session_predictions.py — adds session_predictions table
tests/
  test_clinical_schema.py, test_ingest.py, test_patients_db.py,
  test_fall_risk_api.py, test_fall_risk_wearable.py, test_models.py,
  test_dosage.py, test_wearable_*.py, test_sessions_api.py, test_ask_api.py,
  test_import_api.py, test_middleware.py, test_orm_comprehensive.py,
  test_ingest_comprehensive.py, test_report_api.py, test_report_service.py,
  test_trend_comprehensive.py, test_voyage.py, test_insight.py,
  test_raise_ingest.py, test_raise_evaluation.py,
  test_prediction_service.py, test_insight_predictions.py, test_retrain_service.py
models/
  classifier_xgb.joblib
  regression_xgb.joblib
  dropout_xgb.joblib
  dosage_frequency.joblib
```

---

## Sub-project 1 — DB + Ingestion ✅ COMPLETE

### Architecture
```
dashboard_data.parquet
    │  scripts/11_seed_database.py  (one-off)
    ▼
POST /api/import/seed  ──▶  IngestPipeline.upsert(df)
POST /api/import/file  ──▶  qtx pipeline → IngestPipeline.upsert(df)
                                    │
                                    ▼
                            PostgreSQL 17 (DATABASE_URL)
                            ┌────────────────────────────┐
                            │ patients      (1,715 rows) │
                            │ sessions (session_number)  │
                            │ patient_conditions         │
                            │ wearable_enrollments       │
                            │ wearable_activity/body/... │
                            └────────────────────────────┘
                                    │
                      ┌─────────────┴──────────────┐
                      ▼                            ▼
              GET /api/patients           Fall Risk Predictor
              GET /api/patient/{sn}       (wearable augmentation)
```

### Key design decisions
- **Lazy engine:** `api/db.py` reads `DATABASE_URL` on first use — importing the module never requires the env var, so tests that override `get_db` stay green.
- **`_db_ready` flag:** `deps.load_all()` catches DB failures and sets `_db_ready = False`; patient endpoints return 503; wearable/predict endpoints keep working.
- **session_number=1 for all historical rows:** Confirmed zero duplicate SNs in parquet — every historical row is definitively session 1.
- **Upsert-on-sn:** `IngestPipeline` is idempotent — safe to re-run on same data.
- **Unified Postgres instance:** Clinical + wearable share one DB; SQLite wearable.db is retired.
- **Savepoint per row:** `IngestPipeline.upsert()` wraps each row in `begin_nested()` so a single bad row rolls back only itself, not the whole session.
- **`__missing__` sentinel:** The ML pipeline fills missing categoricals with `'__missing__'`. `_coerce()` in `ingest.py` maps this to `NULL` before DB insertion so VARCHAR(1) gender column accepts all rows.

---

## RAISE Eldercare Dataset Pipeline ✅ COMPLETE

162 patients across 3 centres (METTA, LB, PH) from the BIXEPS eldercare programme, ingested via a 3-step pipeline:

1. **EDA** (`scripts/14_eda_raise_data.py`) — distributions, centre comparison, data quality report. Key finding: METTA has extreme pre-TUG values (mean 36s vs ~11s at LB/PH), indicating heavy frailty severity.
2. **Migration** (`scripts/15_migrate_add_tandem.py`) — adds `pre_tandem_s` to `patients` and `post_tandem_s` to `sessions`.
3. **Ingestion** (`scripts/16_ingest_raise_data.py`) — creates Patient + Session rows. RAISE patients identified by `sessions.ingested_from ILIKE '%raise%'`.

### Covariate shift analysis (`scripts/17_raise_model_evaluation.py`)

Gates whether RAISE data can be merged with QTX for model retraining. Two gates must both pass before any retraining occurs:

- **Gate 1 — AUC < 0.70**: XGBoost binary classifier trained to predict dataset origin. AUC ≥ 0.70 means populations are too distinguishable to safely merge. Current result: **AUC = 1.000 (FAIL)** — `usage_frequency = "Once weekly (BIXEPS)"` is unique to all RAISE rows, making them trivially separable.
- **Gate 2 — Confound SHAP < 15%**: Checks that `cohort` + `usage_frequency` don't dominate SHAP importance (i.e. separation is clinical, not programmatic). Current result: **76.8% (FAIL)**.

**Implication:** RAISE data cannot yet be merged with QTX for training. Both gates will pass if `usage_frequency` is normalised to match QTX values (e.g. "Once / week") and RAISE's clinical profile is diversified beyond METTA-only patients.

---

## Dual-Loop ML+AI Integration ✅ COMPLETE

Two learning loops are now connected. Every `POST /api/patient/{sn}/session` call:

1. **Runs `PredictionService`** — builds feature vectors from ORM objects, calls 4 models (regression, classifier, dropout, dosage; fall risk excluded — owned by separate team), persists one `session_predictions` row.
2. **Passes predictions to `InsightService`** — Claude's prompt now includes a `model_predictions` block:
   ```
   "model_predictions": {
     "predicted_composite_improvement": 0.42,
     "responder_probability": 0.71,
     "dropout_risk": "LOW (0.12)",
     "dosage_recommendation": "Twice / week"
   }
   ```
   Claude is instructed to flag when actual measurements diverge significantly from predictions.
3. **Calls `RetrainService.check_and_trigger()`** — non-blocking; spawns `scripts/18_scheduled_retrain.py` as a background subprocess when `session_count - last_retrain_count >= 50` (configurable via `RETRAIN_THRESHOLD` env var).

### Scheduled retrain job (`scripts/18_scheduled_retrain.py`)

- Loads all QTX sessions from DB (excludes RAISE rows)
- Retrains regression model (XGBRegressor) only with 5-fold CV — fall risk excluded
- Saves new model only if CV metrics hold or improve vs. `retrain_state.json` baseline
- Calls `POST /api/admin/reload-models` (with `X-Api-Key` header) to hot-swap models in the running API
- State persisted in `retrain_state.json` (gitignored, project root)

### Admin hot-reload (`POST /api/admin/reload-models`)

Calls `deps.load_all()` in place — `deps.models` is a mutable dict so no server restart required. Protected by the same `QTX_API_KEY` middleware as all other routes.

---

## Sub-project 4 — Frontend + PDF Reporting (partially scaffolded)

### Fall Risk Predictor
- **Loading state:** `FallRiskPage` shows a shimmer skeleton in the results panel (mirrors score card + factors card + CTA card layout) while the API call is in flight.
- **Disabled button UX:** `.btn:disabled` now has `opacity: 0.38` and `cursor: not-allowed` — previously disabled buttons were visually identical to enabled ones.
- **`step1Valid()` gates:** "Get Result Now" requires age (integer 1–120), gender, walking aid, exercise frequency, and polypharmacy (Yes/No) to all be set before enabling.

### PDF Report
- `GET /api/patient/{sn}/report.pdf` — WeasyPrint renders `templates/patient_report.html` as a PDF clinical summary.
- **Requires:** `brew install pango` (libpango system library). Already installed on this machine.

### Prediction Chips (AI tab)
`PredictionChips` component renders a compact chip row at the top of the AI tab in the patient drawer, showing the latest `SessionPrediction` values:
- Predicted improvement (signed float)
- Responder probability (%)
- Dropout risk — LOW / HIGH (amber chip when > 50%)
- Dosage recommendation

Fetched from `GET /api/patient/{sn}/predictions/latest`. Silently absent if no prediction row exists yet (patient has no sessions).

### Clinical sub-components (Sub-project 3/4)
`InsightCard`, `MetricChart`, `QAPanel`, `TimelineTab`, `AITab`, `PredictionChips` all live in `web/components/clinical/`.

---

## Outstanding / Deferred

- **Terra PDPA / HBRA compliance** — written confirmation needed before go-live.
- **Webhook signature enforcement** — currently skipped when `TERRA_WEBHOOK_SECRET` is unset.
- **Walking cadence in fall risk adjuster** — `wearable_cadence_avg_30d` computed but not wired into score.
- **`POST /api/import/file` pipeline** — function signatures are illustrative; wire to actual `src/qtx/` pipeline when ready.
- **Anthropic BAA** — required before sending real patient data to Claude in production.
- **`datetime.utcnow()` in `api/services/trend.py`** — still emits deprecation warnings (lines 124, 132); low priority.
- **RAISE covariate shift gates currently failing** — `usage_frequency = "Once weekly (BIXEPS)"` makes RAISE rows trivially distinguishable. Fix: normalise RAISE `usage_frequency` values to match QTX taxonomy (e.g. "Once / week") before running `script 17` again.
- **`scripts/17` shift test uses `usage_frequency` as a shift feature** — consider excluding pure programme-label columns from `SHIFT_FEATURES` so the shift test detects clinical differences only.
- **Model calibration tracking** — `session_predictions.predicted_composite_improvement` is persisted but not yet compared against actuals. A future script could measure model drift per cohort.
- **Fall risk** — entirely removed from this codebase. Owned by a separate team member. The `session_predictions` table retains `fall_risk_score` and `fall_risk_label` columns (they simply stay NULL).

---

## Next Steps

The two core learning loops are live. Likely next priorities:

1. **Fix RAISE merge gates** — normalise `usage_frequency` in RAISE rows so `script 17` can complete a full covariate shift evaluation on clinical features only.
2. **Model calibration dashboard** — query `session_predictions` vs actual `composite_improvement` to surface per-cohort prediction error over time.
3. **Prediction chips are live** — `PredictionChips` in the AI tab already shows model signals. Next step: add a small "last updated" timestamp from `predicted_at` to make staleness visible to clinicians.
