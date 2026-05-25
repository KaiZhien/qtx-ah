# QTX-AH Handoff — Clinical Intelligence System

**Date:** 2026-05-25
**Branch:** main
**Status:** Codebase hardening complete (34/34 tests passing). Ready to build clinical intelligence layer.

---

## What We Are About To Build

A per-patient clinical intelligence system in four sub-projects that must be built in order. Each one is the foundation for the next.

### Sub-project 1 — Foundation: Database + Data Ingestion (START HERE)
Replace the static `data/processed/dashboard_data.parquet` file with a proper PostgreSQL database (with pgvector extension). Build a CSV/Excel import pipeline so clinicians can load patient data. Define a longitudinal session schema — each patient can have multiple sessions over time.

Key schema entities: `patients`, `sessions` (one per treatment episode), `measurements` (per-test values per session), `conditions` (patient comorbidities). The existing parquet data seeds the database on first import.

### Sub-project 2 — Patient Knowledge Graph
Per-patient data model where sessions, measurements, trends, and observations are linked. Compute trend signals automatically on each new session (e.g. "gait speed improving", "TUG plateaued for 3 sessions"). This is the accumulating "vault" per patient.

### Sub-project 3 — AI Reasoning Layer
Claude Sonnet 4.6 + Voyage-3-lite embeddings. Reasons **purely over THIS patient's own data** — no cross-patient comparison (clinically inappropriate; every body responds differently). Clinical evidence guidelines as background context only. Two modes: (a) proactive insights generated on each session entry, (b) clinician Q&A. Estimated cost: ~$40/month at 100 queries/day with prompt caching. BAA with Anthropic required before sending patient data (free, apply at privacy.claude.com).

### Sub-project 4 — Frontend + PDF Reporting
Timeline view of patient progress across sessions, AI insight cards, clinician Q&A interface, exportable PDF clinical summaries.

---

## Key Technical Decisions Already Made

| Decision | Choice | Reason |
|----------|--------|--------|
| Database | PostgreSQL + pgvector | Needed for vector storage + concurrent access; SQLAlchemy makes it a one-line engine change from current SQLite |
| Embeddings | Voyage-3-lite ($0.06/1M tokens) | Best structured-data quality at lowest cost |
| LLM | Claude Sonnet 4.6 | Best clinical reasoning benchmarks; HIPAA BAA available from Anthropic |
| Reasoning scope | Per-patient only | Cross-patient comparison is clinically inappropriate |
| Patient data compliance | Treat as PHI; sign Anthropic BAA | Small population (~2K patients) makes anonymisation insufficient |

---

## Current Codebase State

**Working directory:** `/Users/reetmitra/Desktop/QTX/quantumtx-ah`

**What already works (34/34 tests passing):**
- Patient listing + filtering — reads from `data/processed/dashboard_data.parquet`
- Outcome prediction — composite improvement, responder/dropout probability, per-test predictions with physiological bounds
- Fall risk prediction — XGBoost + clinical adjusters + optional wearable augmentation
- Dosage recommendation — 1x/week / 2x/week / L+R 10
- Wearable integration (Terra API) — fully built, Terra account not yet set up
- API key auth middleware (`QTX_API_KEY`), db rollback, graceful startup errors
- Env vars documented in `.env.example` and `web/.env.local.example`

**Test commands:**
```bash
.venv/bin/python -m pytest api/test_api.py tests/ -v --noconftest
```

**Import convention (critical):** All `api/` files use bare imports (`from db import get_db`, never `from api.db import ...`). `api/` has no `__init__.py`.

---

## Immediate Next Step

Open a fresh chat, load this file for context, and say:

> "I want to design Sub-project 1 of the clinical intelligence system described in HANDOFF.md — the PostgreSQL database schema and CSV/Excel ingestion pipeline."

Use the `superpowers:brainstorming` skill at the start of the session to design before implementing.

---

## Previous Handoff (Wearable Integration — completed 2026-05-22)

---

## What Was Built

End-to-end wearable device integration for the QuantumTX Alexandra Hospital clinical analytics platform. Patients connect consumer wearables (Apple Watch, Garmin, Fitbit, WHOOP, Samsung) via **Terra API**, which normalises the data and delivers it to the QTX backend via webhook. All data is owned by QTX — Terra is a replaceable connector, not a dependency.

Three plans were executed in sequence:

| Plan | Scope | Status |
|---|---|---|
| 1 — Backend Pipeline | SQLite schema, Terra webhook ingestion, enrollment API, reconciliation | ✅ Complete |
| 2 — Fall Risk Augmentation | Wearable feature service, score adjusters, `source` field | ✅ Complete |
| 3 — Frontend | Drawer tab, fall risk form/results, cohorts panel | ✅ Complete |

---

## Architecture

```
Patient Device (Apple Watch / Garmin / Fitbit / WHOOP / Samsung)
    │  native device sync
    ▼
Terra API  ──(HMAC-signed webhook)──▶  POST /webhooks/terra
                                            │
                                            ▼
                                    api/services/terra.py
                                    ingest_payload()
                                            │
                                            ▼
                                    data/wearable.db  (SQLite)
                                    ┌─────────────────────────┐
                                    │ wearable_enrollments    │
                                    │ wearable_activity       │
                                    │ wearable_body           │
                                    │ wearable_sleep          │
                                    │ wearable_events         │
                                    └─────────────────────────┘
                                            │
                              ┌─────────────┴──────────────┐
                              ▼                            ▼
                    Fall Risk Predictor          GET /api/wearable/
                    (score adjusters)            {patient_id}/features
                              │                            │
                              ▼                            ▼
                    api/predict/fall-risk         Web app drawer
                    source: clinic_only           Wearable tab
                         or clinic_and_wearable
```

**Key design principle:** Every wearable table stores only `terra_user_id`. The only join back to clinical identity is through `wearable_enrollments`. A breach of wearable data reveals no patient identity without that table.

---

## Plan 1 — Backend Data Pipeline

### New files
- **`api/db.py`** — SQLAlchemy engine, `Base`, `get_db()`, `init_db()`. DB lives at `data/wearable.db`, created on API startup.
- **`api/models/wearable.py`** — Five ORM models: `WearableEnrollment`, `WearableActivity`, `WearableBody`, `WearableSleep`, `WearableEvent`.
- **`api/services/terra.py`** — Terra API client: `verify_signature()` (HMAC-SHA256), `create_widget_session()`, `ingest_payload()` (dispatches to per-type helpers), `fetch_user_data()`, `deactivate_user()`.
- **`api/routers/webhooks.py`** — `POST /webhooks/terra`. Verifies signature, calls `ingest_payload`. Skips verification when `TERRA_WEBHOOK_SECRET` is unset (dev mode).
- **`api/routers/wearable.py`** — Enrollment endpoints: `POST /api/wearable/enroll`, `POST /api/wearable/confirm-enrollment`, `DELETE /api/wearable/enroll/{patient_id}`. Features endpoint: `GET /api/wearable/{patient_id}/features`. Summary: `GET /api/wearable/summary`.
- **`scripts/10_reconcile_wearables.py`** — Nightly job: pulls previous 24h from Terra for all active enrollments, fills webhook gaps. Run via `make reconcile-wearables`. Exits cleanly when `TERRA_DEV_ID`/`TERRA_API_KEY` are unset.

### Modified files
- **`api/main.py`** — Added `init_db()` to lifespan startup; registered `wearable` and `webhooks` routers.
- **`Makefile`** — Added `fall-risk` and `reconcile-wearables` targets.
- **`pyproject.toml`** — Added `sqlalchemy ^2.0` and `httpx ^0.27`.
- **`.gitignore`** — Added `data/wearable.db`.

### Environment variables required for production
```
TERRA_DEV_ID=...
TERRA_API_KEY=...
TERRA_WEBHOOK_SECRET=...
```

---

## Plan 2 — Fall Risk Model Augmentation

### New file
- **`api/services/wearable_features.py`** — `get_patient_features(patient_id, db) -> dict`. Computes six rolling-window features from the wearable DB. Returns `{"enrolled": False, "source": "clinic_only"}` when no active enrollment exists.

### Modified files
- **`api/routers/wearable.py`** — `GET /api/wearable/{patient_id}/features` now delegates to `wearable_features.get_patient_features()` (one line).
- **`api/routers/fall_risk.py`** — Key changes:
  - `FallRiskRequest` gains `patient_id: str | None = None`
  - `predict_fall_risk` gains `db: Session = Depends(get_db)`
  - `_adjust_score_with_wearable(score, wearable)` — compliance-weighted adjusters: fall events (+10/+15), low steps (+4/+8), high sedentary % (+3/+6), low HRV (+5). Ignored entirely when compliance < 30%.
  - `_top_factors` surfaces wearable fall events and low-activity signals when enrolled + compliant.
  - Response gains `source` field: `"clinic_only"` or `"clinic_and_wearable"`.

### Wearable features computed
| Feature | Window | Adjusts score? |
|---|---|---|
| `wearable_steps_30d_avg` | 30 days | Yes |
| `wearable_sedentary_pct_30d` | 30 days | Yes |
| `wearable_cadence_avg_30d` | 30 days | No (returned, not yet in adjuster) |
| `wearable_hrv_trend_7d` | 7 days | Yes |
| `wearable_fall_events_90d` | 90 days | Yes (strongest signal) |
| `wearable_compliance_rate_30d` | 30 days | Gates all adjusters |

---

## Plan 3 — Frontend

### Modified files
- **`web/lib/types.ts`** — Added `WearableFeatures` type; added `source?` to `FallRiskResult`; added `patient_id?` to `FallRiskInput`.
- **`web/lib/api.ts`** — Added `fetchWearableFeatures(patientId)`, `enrollPatient(patientId, brand)`, `fetchWearableSummary()`.
- **`web/components/PatientDrawerBody.tsx`** — Tab switcher (Clinical | Wearable). Wearable tab: fetches features on first open, shows a metrics panel (steps, sedentary %, cadence, HRV, fall events, compliance) for enrolled patients, or a device-brand picker + "Enroll patient" button that opens the Terra widget. Low-compliance warning shown when < 30%.
- **`web/components/fall-risk/FallRiskResults.tsx`** — "+ Wearable data" blue badge shown when `source === "clinic_and_wearable"`.
- **`web/components/fall-risk/FallRiskForm.tsx`** — Optional "Patient ID" text input in step 1. When filled, the ID is sent with the API call so the backend can look up wearable features for that patient.
- **`web/components/pages/CohortsPage.tsx`** — Enrollment summary card at the top: shows count of active wearable enrollments fetched from `GET /api/wearable/summary`.

---

## Testing

```bash
# Full backend test suite (125 tests)
PYTHONPATH=src .venv/bin/pytest tests/ -v

# Wearable-specific tests only (22 tests)
PYTHONPATH=src .venv/bin/pytest tests/test_wearable_webhook.py \
  tests/test_wearable_enrollment.py tests/test_wearable_features.py \
  tests/test_fall_risk_wearable.py -v

# Frontend type-check
cd web && npx tsc --noEmit

# Start full stack
make dev
```

All 125 tests pass. Zero TypeScript errors.

---

## Import Convention (critical)

All Python files inside `api/` use **bare module imports** — no `api.` prefix:
```python
from db import get_db          # ✅
from api.db import get_db      # ❌ — api/ has no __init__.py
```

Test files add `api/` to `sys.path` manually:
```python
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))
```

Run tests as: `PYTHONPATH=src .venv/bin/pytest` (not `python -m pytest`).

---

## Outstanding / Deferred

- **Terra PDPA / HBRA compliance** — written confirmation needed before go-live with real patient data.
- **Webhook signature enforcement** — currently skipped when `TERRA_WEBHOOK_SECRET` is unset. Must be required in production.
- **Postgres migration** — current storage is SQLite (`data/wearable.db`). Production should use Postgres; only `api/db.py` connection string needs updating.
- **Backfill on enrollment** — design spec calls for a 90-day historical pull when a patient first enrolls. Not yet implemented; `scripts/10_reconcile_wearables.py` only covers the previous 24h.
- **Walking cadence in score adjuster** — `wearable_cadence_avg_30d` is computed and returned but not yet wired into `_adjust_score_with_wearable`. Strong gait proxy once clinical thresholds are confirmed.
- **Between-visit trajectory alerts** — Phase 2: continuous scoring on incoming wearable data, alerting clinicians when a patient's metrics deteriorate. Deferred until Phase 1 data coverage is established.
