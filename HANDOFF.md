# QTX-AH Handoff — Clinical Intelligence System

**Date:** 2026-05-26
**Branch:** main
**Commit:** 2f9f1a1
**Status:** Sub-project 1 complete + dev environment fully operational. Sub-project 2 in progress. Sub-projects 3–4 partially scaffolded.

---

## What We Are Building

A per-patient clinical intelligence system in four sub-projects that must be built in order.

### Sub-project 1 — Foundation: Database + Data Ingestion ✅ COMPLETE
Replaced the static `data/processed/dashboard_data.parquet` with PostgreSQL (+ pgvector). Built a CSV/Excel import pipeline and longitudinal session schema.

### Sub-project 2 — Patient Knowledge Graph (IN PROGRESS)
Per-patient longitudinal model. Each new clinic visit creates a new session row. Trend signals computed automatically on each new session entry (e.g. "gait speed improving", "TUG plateaued for 3 sessions"). Clinician observations stored alongside measurements. This is the accumulating "vault" per patient that the AI layer (Sub-project 3) reasons over.

### Sub-project 3 — AI Reasoning Layer
Claude Sonnet 4.6 + Voyage-3-lite embeddings. Reasons **purely over THIS patient's own data** — no cross-patient comparison (clinically inappropriate). Two modes: (a) proactive insights on each new session, (b) clinician Q&A. BAA with Anthropic required before sending patient data.

### Sub-project 4 — Frontend + PDF Reporting
Timeline view of patient progress across sessions, AI insight cards, clinician Q&A interface, exportable PDF clinical summaries.

---

## Key Technical Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Database | PostgreSQL 17 + pgvector | Vector storage + concurrent access; pgvector requires PG17+ on macOS homebrew |
| Embeddings | Voyage-3-lite ($0.06/1M tokens) | Best structured-data quality at lowest cost |
| LLM | Claude Sonnet 4.6 | Best clinical reasoning benchmarks; HIPAA BAA available |
| Reasoning scope | Per-patient only | Cross-patient comparison is clinically inappropriate |
| Patient data compliance | Treat as PHI; sign Anthropic BAA | Small population (~2K patients) makes anonymisation insufficient |
| Env loading | python-dotenv in api/main.py | API server reads project root .env at startup |

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

### Seed the database (one-time after fresh setup)
```bash
DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \
PYTHONPATH=src .venv/bin/python scripts/11_seed_database.py
```
Expected: `Inserted: 1,715 / Errors: 0`

### Run everything
```bash
make dev   # starts API (port 8000) + Next.js (port 3000) concurrently
```

---

## Current Codebase State

**Working directory:** `/Users/reetmitra/Desktop/QTX/quantumtx-ah`

**Test command:**
```bash
PYTHONPATH=src .venv/bin/pytest tests/ api/test_api.py -v
```

**Import convention (critical):** All `api/` files use bare imports (`from db import get_db`). `api/` has no `__init__.py`. All test files that exercise API code must add `api/` to `sys.path`.

**File map:**
```
api/
  db.py                    — lazy Postgres engine, Base, get_db, init_db
  deps.py                  — ML model loading, _db_ready flag
  main.py                  — FastAPI app, lifespan, dotenv load, all routers
  models/
    clinical.py            — Patient, Session, PatientCondition ORM models
    wearable.py            — WearableEnrollment, WearableActivity, etc.
  routers/
    patients.py            — GET /api/patients, GET /api/patient/{sn}
    predict.py             — POST /api/predict/outcomes, /dosage
    fall_risk.py           — POST /api/predict/fall-risk
    wearable.py            — wearable enrollment + features
    import_data.py         — POST /api/import/seed, /import/file
    webhooks.py            — POST /webhooks/terra
    sessions.py            — patient session management
    ask.py                 — POST /api/patient/{sn}/ask (AI Q&A)
    report.py              — GET /api/patient/{sn}/report.pdf (PDF export)
  services/
    ingest.py              — IngestPipeline, IngestSummary, RowError
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
    fall-risk/
      FallRiskForm.tsx     — self-report form with step1Valid() gate
      FallRiskResults.tsx  — risk score + factors + CTA panel
    pages/
      FallRiskPage.tsx     — shimmer skeleton loading state + results layout
      OverviewPage.tsx
      CohortsPage.tsx
      ClinicalPage.tsx
    clinical/
      InsightCard.tsx      — AI insight display card (Sub-project 3/4)
      MetricChart.tsx      — longitudinal metric sparkline
      QAPanel.tsx          — clinician Q&A interface
      TimelineTab.tsx      — per-patient session timeline
    ui/                    — Card, Drawer, Field, KPI, Pill, Tabs, Icons
  lib/
    api.ts                 — all fetch helpers (predictFallRisk, etc.)
    types.ts               — shared TypeScript types
    constants.ts
scripts/
  11_seed_database.py      — seed Postgres from dashboard_data.parquet
  12_migrate_add_notes_column.py
tests/
  (existing)
  test_clinical_schema.py, test_ingest.py, test_patients_db.py,
  test_fall_risk_api.py, test_fall_risk_wearable.py, test_models.py,
  test_dosage.py, test_wearable_*.py, test_sessions_api.py, test_ask_api.py
  (new)
  test_import_api.py, test_middleware.py, test_orm_comprehensive.py,
  test_ingest_comprehensive.py, test_report_api.py, test_report_service.py,
  test_trend_comprehensive.py
models/
  classifier_xgb.joblib
  regression_xgb.joblib
  dropout_xgb.joblib
  dosage_frequency.joblib
  fall_risk_xgb.joblib
  fall_risk_medians.joblib
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

## Sub-project 4 — Frontend + PDF Reporting (partially scaffolded)

### Fall Risk Predictor
- **Loading state:** `FallRiskPage` shows a shimmer skeleton in the results panel (mirrors score card + factors card + CTA card layout) while the API call is in flight.
- **Disabled button UX:** `.btn:disabled` now has `opacity: 0.38` and `cursor: not-allowed` — previously disabled buttons were visually identical to enabled ones.
- **`step1Valid()` gates:** "Get Result Now" requires age (integer 1–120), gender, walking aid, exercise frequency, and polypharmacy (Yes/No) to all be set before enabling.

### PDF Report
- `GET /api/patient/{sn}/report.pdf` — WeasyPrint renders `templates/patient_report.html` as a PDF clinical summary.
- **Requires:** `brew install pango` (libpango system library). Already installed on this machine.

### Clinical sub-components (Sub-project 3/4)
`InsightCard`, `MetricChart`, `QAPanel`, `TimelineTab` are scaffolded in `web/components/clinical/` — ready to be wired to the AI + timeline endpoints.

---

## Outstanding / Deferred

- **Terra PDPA / HBRA compliance** — written confirmation needed before go-live.
- **Webhook signature enforcement** — currently skipped when `TERRA_WEBHOOK_SECRET` is unset.
- **Walking cadence in fall risk adjuster** — `wearable_cadence_avg_30d` computed but not wired into score.
- **`POST /api/import/file` pipeline** — function signatures are illustrative; wire to actual `src/qtx/` pipeline when ready.
- **Sub-project 2** — trend signals + longitudinal knowledge graph not yet built.
- **Sub-project 3** — AI Q&A endpoint stubbed (`ask.py`); needs Anthropic BAA + embeddings wired.
- **Clinical components** — `InsightCard`, `MetricChart`, `QAPanel`, `TimelineTab` scaffolded but not connected to live data.

---

## Next Steps

> "I want to design Sub-project 2 of the clinical intelligence system described in HANDOFF.md — the patient knowledge graph and trend computation layer."

Use the `superpowers:brainstorming` skill at the start of the session to design before implementing.
