# QTX-AH Handoff — Clinical Intelligence System

**Date:** 2026-05-25
**Branch:** main
**Status:** Sub-project 1 complete (161/161 tests passing). Building Sub-project 2.

---

## What We Are Building

A per-patient clinical intelligence system in four sub-projects that must be built in order.

### Sub-project 1 — Foundation: Database + Data Ingestion ✅ COMPLETE
Replaced the static `data/processed/dashboard_data.parquet` with PostgreSQL (+ pgvector). Built a CSV/Excel import pipeline and longitudinal session schema.

**What was built:**
- `api/models/clinical.py` — `Patient`, `Session`, `PatientCondition` ORM models
- `api/db.py` — Lazy Postgres engine; unified DB for clinical + wearable data
- `api/services/ingest.py` — `IngestPipeline` upserts 73-column DataFrame; normalises SNs; rebuilds conditions
- `scripts/11_seed_database.py` — idempotent seed from parquet (run once)
- `POST /api/import/seed` and `POST /api/import/file` endpoints
- `GET /api/patients` and `GET /api/patient/{sn}` migrated to SQLAlchemy
- `deps._db_ready` flag — wearable/predict endpoints survive DB unavailability
- 25 new tests; 161/161 passing

**To seed a real Postgres instance:**
```bash
DATABASE_URL=postgresql+psycopg2://user:pass@localhost:5432/qtxah \
PYTHONPATH=src .venv/bin/python scripts/11_seed_database.py
```

---

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
| Database | PostgreSQL + pgvector | Vector storage + concurrent access |
| Embeddings | Voyage-3-lite ($0.06/1M tokens) | Best structured-data quality at lowest cost |
| LLM | Claude Sonnet 4.6 | Best clinical reasoning benchmarks; HIPAA BAA available |
| Reasoning scope | Per-patient only | Cross-patient comparison is clinically inappropriate |
| Patient data compliance | Treat as PHI; sign Anthropic BAA | Small population (~2K patients) makes anonymisation insufficient |

---

## Current Codebase State

**Working directory:** `/Users/reetmitra/Desktop/QTX/quantumtx-ah`

**Test command:**
```bash
PYTHONPATH=src .venv/bin/pytest tests/ api/test_api.py -v --noconftest
```
Expected: 161 passed, 5 pre-existing failures in `test_fall_risk_wearable.py`, 2 errors in `test_clean.py`.

**Import convention (critical):** All `api/` files use bare imports (`from db import get_db`). `api/` has no `__init__.py`.

**File map:**
```
api/
  db.py                    — lazy Postgres engine, Base, get_db, init_db
  deps.py                  — ML model loading, _db_ready flag
  main.py                  — FastAPI app, lifespan, all routers registered
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
  services/
    ingest.py              — IngestPipeline, IngestSummary, RowError
    terra.py               — Terra API client
    wearable_features.py   — rolling wearable feature computation
scripts/
  11_seed_database.py      — seed Postgres from dashboard_data.parquet
tests/
  test_clinical_schema.py  — ORM constraint tests (9 tests)
  test_ingest.py           — IngestPipeline unit tests (6 tests)
  test_patients_db.py      — patient API endpoint tests (9 tests)
  test_fall_risk_api.py    — fall risk endpoint tests (4 tests)
  test_fall_risk_wearable.py — wearable fall risk (5 pre-existing failures)
  (+ existing tests for models, dosage, wearable webhook/enrollment/features)
```

---

## Immediate Next Step

Open a fresh chat, load this file for context, and say:

> "I want to design Sub-project 2 of the clinical intelligence system described in HANDOFF.md — the patient knowledge graph and trend computation layer."

Use the `superpowers:brainstorming` skill at the start of the session to design before implementing.

---

## Previous: Sub-project 1 — DB + Ingestion (completed 2026-05-25)

### Architecture

```
dashboard_data.parquet
    │  scripts/11_seed_database.py  (one-off)
    ▼
POST /api/import/seed  ──▶  IngestPipeline.upsert(df)
POST /api/import/file  ──▶  qtx pipeline → IngestPipeline.upsert(df)
                                    │
                                    ▼
                            PostgreSQL (DATABASE_URL)
                            ┌────────────────────────────┐
                            │ patients                   │
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

### Outstanding / Deferred
- **Terra PDPA / HBRA compliance** — written confirmation needed before go-live.
- **Webhook signature enforcement** — currently skipped when `TERRA_WEBHOOK_SECRET` is unset.
- **Walking cadence in fall risk adjuster** — `wearable_cadence_avg_30d` computed but not wired.
- **`_cohort_stat` in fall_risk.py** — currently returns static default (45% / 0 cohort) since `deps.df` was removed. Sub-project 2 should wire this to query the DB instead.
- **`POST /api/import/file` pipeline** — `load_raw_bytes` / `normalise` / etc. function signatures are illustrative; wire to actual `src/qtx/` pipeline when ready.
