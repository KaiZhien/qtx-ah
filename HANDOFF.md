# QTX-AH Handoff — Clinical Intelligence System

**Date:** 2026-06-08
**Branch:** main
**Commit:** d32e4b9
**Status:** Sub-projects 1–4 complete. RAISE pipeline complete. Dual-loop ML+AI integration live. Calibration alerting + observability live. Admin auth hardened. RAISE clinical findings integrated into AI reasoning layer. 483 tests passing.

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
| Admin auth | Separate `QTX_ADMIN_KEY` via `X-Admin-Key` header | `QTX_API_KEY` is frontend-exposed; admin reload must be separated |
| Retrain trigger | Count-based (50 sessions) + drift-based (30% MAE increase) | Count ensures periodic refresh; drift ensures quality-triggered response |

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
RETRAIN_THRESHOLD=50
CALIBRATION_DRIFT_THRESHOLD=0.30
CALIBRATION_MIN_COHORT_N=20
TERRA_WEBHOOK_SECRET=
TERRA_DEV_ID=
TERRA_API_KEY=
ALLOWED_ORIGINS=http://localhost:3000
```

`ALLOWED_ORIGINS` — comma-separated list of frontend origins the API will accept CORS requests from. Defaults to `http://localhost:3000` if unset. For production, set to the deployed frontend URL (e.g. `https://qtx.ah.sg`). Multiple origins: `ALLOWED_ORIGINS=https://qtx.ah.sg,https://staging.qtx.ah.sg`.

**`quantumtx-ah/web/.env.local`** (Next.js — gitignored):
```
NEXT_PUBLIC_API_KEY=<same 32-byte hex as QTX_API_KEY>
NEXT_PUBLIC_API_URL=http://localhost:8000
```

`QTX_ADMIN_KEY` must be different from `QTX_API_KEY`. Generate each with:
```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

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

```bash
# 7. Backfill RAISE usage_frequency (script 20) — one-time after step 5
#    Sets usage_frequency = 'Once (1x/week, one leg)' on all RAISE sessions.
#    Required for covariate shift test (script 17) to evaluate clinical features only.
PYTHONPATH=src:api .venv/bin/python3.14 scripts/20_normalize_raise_usage_frequency.py
```
Expected: `162 rows updated` (0 on re-run — idempotent).

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
    webhooks.py            — POST /webhooks/terra (HMAC-verified)
    sessions.py            — POST /api/patient/{sn}/session (runs PredictionService +
                             InsightService + RetrainService + CalibrationService on
                             every new session)
                             GET /api/patient/{sn}/predictions/latest
    ask.py                 — POST /api/patient/{sn}/ask (AI Q&A)
    report.py              — GET /api/patient/{sn}/report.pdf (PDF export)
    admin.py               — POST /api/admin/reload-models (hot-swap; requires X-Admin-Key)
    calibration.py         — GET /api/calibration (per-cohort MAE drift status)
  services/
    ingest.py              — IngestPipeline, IngestSummary, RowError
    insight.py             — InsightService (Claude Sonnet 4.6 + Voyage RAG)
    voyage.py              — VoyageEmbedder (voyage-3-lite, 512 dims, 5s timeout)
    prediction.py          — PredictionService (regression/classifier/dropout/dosage;
                             fall risk excluded)
    retrain.py             — RetrainService.check_and_trigger() (count-based trigger)
    calibration.py         — CalibrationService (drift-based trigger + GET /api/calibration)
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
    pages/                 — OverviewPage (+ ModelHealthCard), CohortsPage, ClinicalPage
    clinical/              — InsightCard, MetricChart, QAPanel, TimelineTab, AITab,
                             PredictionChips (model signals + "Updated X ago" timestamp),
                             ModelHealthCard (per-cohort calibration health)
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
                                     (SHIFT_FEATURES excludes usage_frequency + cohort;
                                      shap_gate confound = ["primary_indication"])
  18_scheduled_retrain.py          — background retrain job (spawned by RetrainService or
                                     CalibrationService); writes calibration_baseline to
                                     retrain_state.json after successful retrain
  19_migrate_add_session_predictions.py — adds session_predictions table
  20_normalize_raise_usage_frequency.py — backfills RAISE usage_frequency to QTX taxonomy
  21_calibration_report.py         — offline per-cohort MAE/RMSE/bias + monthly drift report
tests/
  test_clinical_schema.py, test_ingest.py, test_patients_db.py,
  test_fall_risk_api.py, test_fall_risk_wearable.py, test_models.py,
  test_dosage.py, test_wearable_*.py, test_sessions_api.py, test_ask_api.py,
  test_import_api.py, test_middleware.py, test_orm_comprehensive.py,
  test_ingest_comprehensive.py, test_report_api.py, test_report_service.py,
  test_trend_comprehensive.py, test_voyage.py, test_insight.py,
  test_raise_ingest.py, test_raise_evaluation.py,
  test_prediction_service.py, test_insight_predictions.py, test_retrain_service.py,
  test_admin_auth.py, test_calibration_service.py, test_calibration_api.py
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
                            │ patients      (1,877 rows) │
                            │  └─ 1,715 QTX + 162 RAISE │
                            │ sessions (session_number)  │
                            │ patient_conditions         │
                            │ session_predictions        │
                            │ wearable_enrollments       │
                            │ wearable_activity/body/... │
                            └────────────────────────────┘
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
4. **Backfill** (`scripts/20_normalize_raise_usage_frequency.py`) — sets `usage_frequency = 'Once (1x/week, one leg)'` on all RAISE sessions (was NULL; needed for covariate shift test).

### Covariate shift analysis (`scripts/17_raise_model_evaluation.py`)

Gates whether RAISE data can be merged with QTX for model retraining. Two gates must both pass:

- **Gate 1 — AUC < 0.70**: XGBoost shift classifier predicts dataset origin. AUC ≥ 0.70 = populations too distinguishable to safely merge.
- **Gate 2 — `primary_indication` SHAP < 15%**: Checks separation is not driven by clinical classification labels.

**Key fix (2026-06-04):** `usage_frequency` and `cohort` removed from `SHIFT_FEATURES` — they were programme-design labels, not clinical phenotypes, causing AUC = 1.000 trivially. The shift test now evaluates clinical separability only. Re-run after `script 20` backfill to get the updated AUC.

**Implication if gates fail after fix:** RAISE population (elderly frailty, BIXEPS programme) remains clinically distinct from QTX. Do not merge for training until populations are more similar.

---

## Dual + Calibration Loop ML+AI Integration ✅ COMPLETE

Every `POST /api/patient/{sn}/session` call runs four services in sequence:

1. **`PredictionService`** — builds feature vectors from ORM objects, calls 4 models (regression, classifier, dropout, dosage; fall risk excluded), persists one `session_predictions` row.
2. **`InsightService`** — Claude's prompt includes a `model_predictions` block with all 4 signals. Claude flags when actual measurements diverge from predictions.
3. **`RetrainService.check_and_trigger()`** — count-based trigger: spawns `scripts/18_scheduled_retrain.py` when `session_count - last_retrain_count >= RETRAIN_THRESHOLD` (default 50).
4. **`CalibrationService.check_and_trigger()`** — drift-based trigger: computes per-cohort MAE (cached 1 hour), compares against `calibration_baseline` in `retrain_state.json`, spawns retrain if any cohort with n≥20 has drifted ≥30%. 1-hour spawn cooldown prevents cascade.

### Scheduled retrain job (`scripts/18_scheduled_retrain.py`)

- Loads all QTX sessions from DB (excludes RAISE rows via `ingested_from`)
- Retrains regression model (XGBRegressor) with 5-fold CV
- Saves new model only if CV metrics hold or improve vs. `retrain_state.json` baseline
- Calls `POST /api/admin/reload-models` with `X-Admin-Key: QTX_ADMIN_KEY` for hot-swap
- After successful retrain: writes `calibration_baseline: {cohort: mae}` to `retrain_state.json`
- State file: `retrain_state.json` (gitignored, project root). `_write_state` reads-then-merges to preserve all keys.

**Note:** Only the regression model retrains. `classifier_xgb.joblib` and `dropout_xgb.joblib` are static since initial training. See Next Steps for expanding retrain coverage.

### Admin hot-reload (`POST /api/admin/reload-models`)

- Calls `deps.load_all()` in place — `deps.models` is a mutable dict; no server restart required.
- **Auth:** Requires `X-Admin-Key: QTX_ADMIN_KEY` header. Exempt from the global `QTX_API_KEY` middleware. 503 if `QTX_ADMIN_KEY` unset, 401 if wrong key. Uses `hmac.compare_digest` (timing-safe).
- `QTX_ADMIN_KEY` must be different from `QTX_API_KEY` — the latter is frontend-exposed.

### Calibration monitoring (`GET /api/calibration`)

Returns per-cohort MAE vs baseline with drift status. Requires `X-Api-Key` (standard key — read-only, non-sensitive).

```json
{
  "generated_at": "...",
  "drift_threshold": 0.30,
  "cohorts": [
    { "cohort": "Pain & Musculoskeletal", "n": 328, "current_mae": 0.415,
      "baseline_mae": 0.410, "drift_pct": 1.2, "status": "OK" }
  ]
}
```

Status values: `OK` (<15% drift), `WARNING` (15–30%), `ALERT` (≥30%), `NO_BASELINE` (no baseline yet — run a retrain first).

**`ModelHealthCard`** in `OverviewPage` renders this endpoint's data with colour-coded status pills. Current per-cohort MAE baseline: Pain & MSK 0.415, Neurological 0.425, Frailty/Sarcopenia 0.361.

---

## Sub-project 4 — Frontend + PDF Reporting ✅ COMPLETE

### PDF Report
- `GET /api/patient/{sn}/report.pdf` — WeasyPrint renders `templates/patient_report.html` as a PDF clinical summary.
- **Requires:** `brew install pango` (libpango system library). Already installed on this machine.

### Prediction Chips (AI tab)
`PredictionChips` renders a compact chip row at the top of the AI tab in the patient drawer:
- Predicted improvement (signed float)
- Responder probability (%)
- Dropout risk — LOW / HIGH (amber chip when > 50%)
- Dosage recommendation
- **"Updated X ago"** timestamp from `predicted_at` — always relative format; silently absent if no prediction row exists.

Fetched from `GET /api/patient/{sn}/predictions/latest`.

### Model Health Card (Overview page)
`ModelHealthCard` renders at the bottom of `OverviewPage` showing per-cohort calibration status. Three states: loading skeleton, no-baseline message (run a retrain), data table with OK/WARNING/ALERT pills. Uses the same `formatRelative` helper as PredictionChips.

### Clinical sub-components
`InsightCard`, `MetricChart`, `QAPanel`, `TimelineTab`, `AITab`, `PredictionChips`, `ModelHealthCard` all live in `web/components/clinical/`.

---

## RAISE Clinical Findings Integration (2026-06-08)

RAISE multi-centre validation report (n=206, 4 centres) findings incorporated into the AI reasoning layer. These are population-level observational signals — Claude now has them as context when interpreting per-patient session data.

**`api/services/insight.py` — `_SYSTEM_PROMPT` additions:**
- **Diabetes = high-responder**: SPPB +1.25 pts, ANCOVA-adjusted p=0.015 (only RAISE finding to survive covariate adjustment). Claude flags diabetes patients as likely high-responders.
- **Frailty differential**: frail patients (has_frailty / baseline SPPB ≤8) improve ~5× more than Normal. Claude frames even modest gains as clinically meaningful in this group.
- **Dementia caution**: directional SPPB decline observed in n=29 (non-significant). Claude explicitly monitors regression in patients with cognitive impairment.
- **Age window**: 70–79 group showed peak gait improvement (+0.194 m/s); 80+ still benefit (+0.418 SPPB pts). Advanced age is not a contraindication.
- **SPPB ceiling**: stable score near 12 is a success — limited headroom, not treatment failure.
- **Tandem Balance**: post_tandem_s improvement correlates with fall risk reduction.

**`api/routers/ask.py` + `api/routers/sessions.py` — AI context payload enrichment:**
- Patient dict now includes: `age_band`, `baseline_sppb`, `pre_tandem_s`, `has_frailty`, `has_diabetes`, `has_neurological`, `has_stroke`, `has_parkinsons`
- Session dict now includes: `post_tandem_s`, `usage_frequency` (ask.py was missing), `sppb_change`, all change score percentages `tug_change_pct / sst_change_pct / vas_change / normal_gs_change_pct / fast_gs_change_pct` (sessions.py was missing these)
- `GET /api/patient/{sn}/timeline` endpoint patient dict updated to match

---

## Code Quality & Hygiene (2026-06-04)

- **`datetime.utcnow()` deprecated calls** — eliminated across all 3 affected files (`api/models/clinical.py`, `api/services/ingest.py`, `api/services/trend.py`). All replaced with `datetime.now(timezone.utc)`. Column defaults use `lambda: datetime.now(timezone.utc)` for lazy evaluation.
- **Webhook signature** — `POST /webhooks/terra` raises 500 if `TERRA_WEBHOOK_SECRET` unset, 401 on invalid signature. Uses `hmac.compare_digest` for timing safety.

---

## Outstanding / Deferred

- **Terra PDPA / HBRA compliance** — written confirmation needed before go-live.
- **Walking cadence in fall risk adjuster** — `wearable_cadence_avg_30d` computed but not wired into score.
- **`POST /api/import/file` pipeline** — function signatures are illustrative; wire to actual `src/qtx/` pipeline when ready.
- **Anthropic BAA** — required before sending real patient data to Claude in production.
- **RAISE covariate shift gates** — re-run `script 17` after `script 20` backfill to confirm AUC < 0.70. If still failing, clinical populations are genuinely distinct and RAISE data should not be merged into QTX training set.
- **Classifier + dropout retrain** ✅ — `_retrain_classifier` and `_retrain_dropout` added to `scripts/18`. All four models now retrain on schedule.
- **Fall risk** — entirely removed from this codebase. Owned by a separate team member. The `session_predictions` table retains `fall_risk_score` and `fall_risk_label` columns (they simply stay NULL).

---

## Next Steps — Ideation Backlog

A 5-agent codebase audit (2026-06-04) surfaced the following prioritised improvements. Items marked 🎯 are highest-leverage.

### The 3 Biggest Opportunities

**1. 🎯 Longitudinal features in the regression model**
The regression model treats every session as session 1. `session_number`, prior composite improvement actuals, and `PatientTrend.magnitude` are all in the DB and none are features. R²=0.022 is a credibility liability; adding these signals is the single highest-leverage ML change.

**2. The system describes what happened — it never says what to do next**
Claude has access to the full phenotype, trajectory, and ML predictions but is only asked for summaries and Q&A. A treatment plan generation mode (`POST /api/patient/{sn}/suggest_plan`) would be the first output a clinician can bring into the treatment room.

**3. 1,877 patients of population data unused as context**
Every patient view shows raw numbers with no reference point. `PERCENT_RANK()` window queries partitioned by cohort, age band, and sex would transform absolute readings into population-relative ranks — standard in clinical trial reporting, absent from open-source rehab platforms.

### Quick Wins (1–2 weeks each)

| Priority | Name | What | Builds on |
|----------|------|------|-----------|
| ✅ | **Longitudinal features** | `session_number`, `prior_avg_composite_improvement`, `trend_tug_magnitude` added to regression feature vector | `session_predictions`, `patient_trends`, `src/qtx/models/regression.py` |
| ✅ | **SHAP at inference** | Top-5 (feature, contribution) pairs stored as `shap_top5 JSON` in `session_predictions`; rendered in `PredictionChips` | `shap.TreeExplainer` in `evaluate.py` |
| ✅ | **MCID + RAISE patterns in system prompt** | MCID thresholds + RAISE-validated response patterns (diabetes, frailty, dementia, age window, SPPB ceiling, tandem balance) added to `_SYSTEM_PROMPT` | `insight.py` |
| ✅ | **Pre/post pairs + change scores in AI context** | `pre_vas`, `tug_change_pct`, `vas_change`, `sppb_change`, `post_tandem_s`, `usage_frequency`, phenotype flags, `age_band`, `baseline_sppb`, `pre_tandem_s` added to AI context payloads | `ask.py`, `sessions.py` |
| ✅ | **Retrain all four models** | `_retrain_classifier` and `_retrain_dropout` added to `scripts/18` | `src/qtx/models/classifier.py`, `src/qtx/models/dropout.py` |
| ✅ | **Cohort percentile on chips** | `PERCENT_RANK()` → `GET /api/patient/{sn}/benchmark` → `(cohort p62)` rendered in `PredictionChips` | `sessions`, `patients` tables; `PredictionChips.tsx` |
| ✅ | **"Prepare session" button** | Button in `PatientDrawerBody` header fires `ask` endpoint with pre-wired prompt | `api/routers/ask.py`, `QAPanel.tsx` |

### Big Bets (1–3 months each)

**🎯 Treatment Plan Generation**
`POST /api/patient/{sn}/suggest_plan` with `insight_type="treatment_plan"`. Prompt uses all 24 `has_*` flags, trend data, and ML predictions to produce a structured 4-session plan: session focus, interventions, monitoring target, risk flags. Rendered as `PlanCard` checklist in AI tab. ~200 lines across 3 files. *The first output a clinician can bring into the treatment room.*

**Cohort Response Curves with Per-Patient Overlay**
`cohort_response_curves` table storing p25/p50/p75 percentile bands per outcome metric by session number, partitioned by `grp_*` phenotype flags. Rendered as a shaded region behind the patient line in `MetricChart.tsx`. A TUG moving from the 28th to 61st percentile among frailty patients is a finding — a raw number is not.

**Proactive Anomaly Detection**
`AnomalyDetector` checks after every session: metric regressing 2+ sessions in a row (from `PatientTrend.direction`), post-session VAS > pre-session VAS, composite improvement dropping below zero despite HIGH responder probability, TUG exceeding 12s fall-risk threshold for a patient without `has_fall_risk`. Triggers a targeted 256-token Claude call → warning card above PredictionChips. *Makes the AI proactive rather than reactive.*

**Per-Patient Bayesian Residual Correction**
At inference in `prediction.py`, query `AVG(predicted - actual)` from `session_predictions JOIN sessions` filtered to the current patient's history. Subtract from the XGBoost point estimate. No new data, no retraining, one SQL query. *Turns a static population model into a self-improving per-patient system.*

### The Single Most Exciting Idea

**Treatment Plan Generation.** Every feature in QTX-AH helps a clinician *understand* a patient. This one helps them *treat* one. The `dosage_recommendation` chip is the seed — Claude already has everything it needs to expand it into a structured 4-session plan grounded in this specific patient's measured limitations, trends, and ML signals. A clinician who checks the plan before every session is product-market fit.

### Immediate Next Step

Re-run `scripts/17_raise_model_evaluation.py` to confirm covariate shift AUC after the `script 20` backfill. If AUC < 0.70 and SHAP gate passes, RAISE data can be merged into QTX training set for the next scheduled retrain — expanding from 1,715 to 1,877 patients and improving model coverage of frail/elderly phenotypes.
