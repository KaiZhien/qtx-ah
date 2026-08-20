# QuantumTX — Clinical Intelligence & Operations Platform

One repository, **four co-located systems** for QuantumTX's magnetic-mitohormesis therapy programme. They share a git repo and nothing else — different languages, different databases, different deploy targets.

| # | System | Path | Stack | Deploys to |
|---|--------|------|-------|-----------|
| 1 | **QTX Operations Platform** | `dlms/` | Next.js 14 (App Router), Supabase, node-postgres | Vercel + Supabase |
| 2 | **Clinical API** | `api/` | FastAPI, PostgreSQL 17 + pgvector | Railway |
| 3 | **Clinician dashboard** | `web/` | Next.js 14 | Vercel |
| 4 | **ML pipeline** | `src/qtx`, `scripts/`, `config/` | Python 3.12, XGBoost, Parquet | runs locally |

**System 1 — the Operations Platform — is where current development happens and is ~75% of the codebase.** It is a five-module internal operations system (Engineering · Finance · Logistics · Manufacturing · Maintenance) for the physical therapy devices, plus Tasks, Approvals, Notifications, global Search and an Admin console. The original **DLMS** (Device Lifecycle Management System) it grew from still runs in production and lives under `dlms/app/legacy/`.

Systems 2–4 form the **Alexandra Hospital (AH) clinical intelligence stack**: a reproducible ML pipeline over 1,716 AH patient records (2024) across six functional assessment blocks (VAS, TUG, 5×SST, Normal Gait Speed, Fast Gait Speed, SPPB), a FastAPI backend serving predictions and Claude-powered insights, and a clinician-facing dashboard — plus the RAISE multi-centre eldercare validation cohort (n=206, narrative-only; see [RAISE Dataset](#raise-dataset)).

---

## Security

All secrets are gitignored via `.env*` — never committed. A pre-commit hook at `.git/hooks/pre-commit` blocks accidental commits of `.env` files and Anthropic key patterns; re-install it after each fresh clone. Patient data (`data/`) is fully gitignored — **PHI never enters git**. Production URLs and cloud project identifiers are deliberately kept out of this tracked file; they live in the local-only operational docs.

Auth model at a glance:

| Surface | Mechanism |
|---------|-----------|
| Clinical API (all `/api/*` routes) | `X-Api-Key` header (`QTX_API_KEY`), constant-time compare, enforced by middleware |
| Admin endpoints (`/api/admin/*`) | Separate `X-Admin-Key` header (`QTX_ADMIN_KEY`) |
| Terra webhooks (`/webhooks/*`) | HMAC-SHA256 signature verification + 300 s replay window |
| Clinician dashboard | Supabase login + **fail-closed email allowlist** + a server-side BFF proxy that injects the API key — **the browser never holds an API key** |
| Ops Platform | Supabase Auth with **MFA/AAL2 enforced at page and server-action layer**; DB-driven RBAC (6 roles × 24 permissions + per-user overrides); deny-via-REST RLS on every table; tamper-resistant append-only audit log |
| Legacy DLMS | Supabase Auth + RBAC (viewer/engineer/admin) enforced in server actions, services and RLS |

---

## Table of Contents

1. [Repository Structure](#repository-structure)
2. [Quick Start](#quick-start)
3. [Environment Variables](#environment-variables)
4. [QTX Operations Platform](#qtx-operations-platform)
5. [Clinical API](#clinical-api)
6. [Dual-Loop ML + AI](#dual-loop-ml--ai)
7. [Web Dashboard](#web-dashboard)
8. [ML Pipeline](#ml-pipeline)
9. [Model Results](#model-results)
10. [Configuration System](#configuration-system)
11. [Phenotype Rules](#phenotype-rules)
12. [RAISE Dataset](#raise-dataset)
13. [Wearable Integration](#wearable-integration)
14. [Deployment](#deployment)
15. [Testing](#testing)
16. [Data Dictionary](#data-dictionary)
17. [Clinical Context](#clinical-context)

---

## Repository Structure

```
quantumtx-ah/
├── dlms/                     # System 1 — QTX Operations Platform (+ legacy DLMS)
│   ├── app/(platform)/       # 61 pages: admin, approvals, dashboard, engineering,
│   │                         #   finance, logistics, maintenance, manufacturing,
│   │                         #   notifications, search, tasks
│   ├── app/legacy/           # the original DLMS app, preserved under /legacy/* routes
│   ├── app/api/              # health, outbox drain, cron handlers
│   ├── modules/              # per-module domain/ (pure) + services/ (I/O)
│   │   └── shared/           # approvals, auth, authz, export, navigation,
│   │                         #   notifications, outbox, reporting, search, settings, tasks
│   ├── lib/                  # db/tx.ts (owner-pool transactions), auth, domain, supabase
│   ├── supabase/             # 55 migrations, seeds, edge functions
│   ├── docs/                 # design specs, implementation plans, runbooks, PROGRESS.md
│   ├── scripts/              # data migrations (demo, components, reconcile), outbox drain, worker
│   └── __tests__/            # Vitest unit suite + integration/ (dockerised Postgres)
│
├── api/                      # System 2 — FastAPI clinical API
│   ├── main.py               # app entry; API-key middleware, CORS, 15 routers
│   ├── db.py / deps.py       # SQLAlchemy engine, model registry, hot-reload
│   ├── models/               # ORM: patients, sessions, predictions, insights, wearables
│   ├── routers/              # see Clinical API section
│   ├── services/             # prediction, insight, retrain, calibration, anomaly, trend,
│   │                         #   triage, ingest, report, terra, voyage, claude_client, …
│   └── templates/            # WeasyPrint PDF report template
│
├── web/                      # System 3 — Next.js 14 clinician dashboard
│   ├── app/                  # / (workspaces), /patient/[sn], /admin, /login
│   ├── app/api/[...path]/    # server-side BFF proxy (session check + API-key injection)
│   ├── components/           # pages/, clinical/, charts/, patient/, ui/
│   └── lib/                  # api.ts, types.ts, auth/allowlist.ts, supabase/
│
├── src/qtx/                  # System 4 — pipeline library
│   ├── io/ clean/ phenotype/ outcomes/ features/ models/ eda/ utils/
├── config/                   # All rules & thresholds live in YAML, not code
├── scripts/                  # 01–08,10: pipeline stages · 11–29: API DB migrations/seeds/ops
├── data/                     # inputs/, processed/, audit/ — all gitignored (PHI)
├── models/                   # Trained artefacts (XGB tracked & served; GBM gitignored)
├── tests/                    # Backend pytest suite (incl. hypothesis property tests)
├── e2e/                      # Playwright E2E against the web dashboard
└── setup.sh / Makefile       # Clinical-stack migrations+seeding / task runner
```

---

## Quick Start

### Prerequisites

- **Python 3.12** (exactly — `.python-version`; pyproject requires ≥3.11,<3.13)
- PostgreSQL 17 + pgvector (`brew install postgresql@17 pgvector pango`)
- Node 20+, Docker (for the platform's integration tests / local Supabase)
- Source Excel files in `data/inputs/` (gitignored — obtained out-of-band, never via git)

### Clinical stack (API + dashboard + pipeline)

```bash
# Python env — build on 3.12
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt && .venv/bin/pip install -e .

# Database (first time)
psql postgres -c "CREATE USER qtx WITH PASSWORD 'secret';"
psql postgres -c "CREATE DATABASE qtxah OWNER qtx;"
psql qtxah    -c "CREATE EXTENSION IF NOT EXISTS vector; GRANT ALL ON SCHEMA public TO qtx;"

cp .env.example .env        # fill in keys (see Environment Variables)
bash setup.sh               # all DB migrations + seeding (idempotent)

make all                    # full pipeline: ingest → … → train (3–8 min)
make dev                    # API :8000 + web dashboard :3000
```

`web/.env.local` needs the Supabase auth project's URL/anon key, `BACKEND_URL=http://localhost:8000`, a server-side `QTX_API_KEY`, and `CLINICIAN_EMAIL_ALLOWLIST` (empty allowlist = nobody can log in, by design).

### Operations Platform

```bash
cd dlms
npm install
cp .env.local.example .env.local    # then fill in (see Environment Variables)
npm run dev                          # http://localhost:3001  (platform on clean URLs, legacy DLMS under /legacy)
```

Fully-local alternative: `npx supabase start` (Docker) and point the env at the local instance.

---

## Environment Variables

Names only — values are provisioned out-of-band and all `.env*` files are local-only.

**Root `.env` (Clinical API + pipeline):** `DATABASE_URL`, `QTX_API_KEY`, `QTX_ADMIN_KEY` (must differ), `ANTHROPIC_API_KEY` (**BAA required before real patient data in production**), `VOYAGE_API_KEY`, `ALLOWED_ORIGINS`, `QTX_CLAUDE_MODEL` (default `claude-sonnet-4-6`), `LOG_LEVEL`, `RETRAIN_THRESHOLD` (50), `CALIBRATION_DRIFT_THRESHOLD` (0.30), `CALIBRATION_MIN_COHORT_N` (20), `QTX_TRIAGE_DIVERGENCE_THRESHOLD` (0.15), `TERRA_DEV_ID` / `TERRA_API_KEY` / `TERRA_WEBHOOK_SECRET`.

**`web/.env.local` (dashboard):** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `BACKEND_URL`, `QTX_API_KEY` (server-side only — injected by the BFF proxy, never `NEXT_PUBLIC_`), `CLINICIAN_EMAIL_ALLOWLIST` (fail-closed).

**`dlms/.env.local` (platform):** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (Supavisor transaction mode), `APP_ENV`, plus deployment-side `CRON_SECRET`, `OUTBOX_DRAIN_SECRET`, `RESEND_API_KEY`, `NOTIFICATION_EMAIL_FROM`, `NEXT_PUBLIC_SITE_URL`, `ANTHROPIC_API_KEY`, and (migrations only) read-only `LEGACY_DATABASE_URL`. `DLMS_DEV_MODE` is a server-only dev flag, inert in production builds.

Generate keys with `python3 -c "import secrets; print(secrets.token_hex(32))"`.

---

## QTX Operations Platform

A five-module operations system for a medical-device manufacturer, built in `dlms/` alongside (and gradually replacing) the legacy DLMS. **51 tables · 61 pages · 2,451 unit tests · 1,088 integration tests.**

| Module | Covers |
|--------|--------|
| **Engineering** | ECRs, ECOs (+ BOM effectivity on date & serial axes), failure investigations + root-cause vocabulary, firmware releases, BOM |
| **Finance** | Buyers, sales invoices (on-demand streamed PDF), warranty registry (status always derived) |
| **Logistics** | Delivery orders, locations, stock levels, atomic idempotent stock transfers |
| **Manufacturing** | Device registry + full lifecycle write path, serialized component installations, Excel bulk import |
| **Maintenance** | Repairs (+ sign-off), modifications, append-only usage records with counter-reset detection |
| **Shared** | Collaborative tasks, approvals engine, notifications + email, transactional outbox, global ⌘K search, dashboards, full-system export, Super Admin console |

### Architecture invariants

- **Every write:** `authorize(actor, permission, module)` → `withTransaction(actorId, fn)` (owner pool) → optimistic `version` check → `FOR UPDATE` on read-feeds-write. Server actions use the AAL2-enforcing actor guard and map all errors to fixed user strings — both pinned by convention tests.
- **RLS everywhere, deny-via-REST:** every table enables RLS with no policies (NOT FORCE) — the anon key reaches nothing; the app's owner/service_role connections pass. A migration-derived test keeps new tables covered automatically.
- **Audit:** a shape-agnostic trigger on every mutable table; actor carried via a transaction-local GUC; `audit_log` is INSERT-only for *all* roles including service_role.
- **Vocabularies are data:** statuses, phases, modification types and root causes are admin-editable rows, never constants. Status transitions are computed from `is_terminal`/`is_initial` flags and fail closed.
- **Transactional outbox:** status-change side effects (handoff tasks, notifications) commit in the same transaction as the change; a drain (every 5 min via Vercel Cron, secret-gated) processes them exactly once; bad events park visibly after 5 attempts. `GET /api/health` reports queue staleness.
- **Approvals engine:** polymorphic approvals over ECOs, invoices and repairs. An approval binds a *snapshot* of the record — any drift between approval and the gated action is refused naming the changed field. "Requested ⇒ binding", not "approval mandatory"; a Finance amount threshold is the one automatic trigger.
- **Pure domain layer:** `modules/*/domain/` and `lib/domain/` are I/O-free and unit-tested, with an injectable `today`. House rule: flat selects + JS reduce; no DB views/RPC.
- **404-not-403:** permission-denied pages render not-found, never confirming a record exists.

### Platform testing

```bash
cd dlms
npm test                   # unit (Vitest)
npm run test:integration   # boots a dockerised Postgres on :55432, applies platform migrations, tears down
npm run type-check && npm run build
```

The integration suite is the enforcement layer for the RBAC matrix, RLS posture, AAL pinning and route reachability — CI must run it, not just the unit suite.

### Legacy DLMS

The original device registry (bilingual 21-field device table, batch Excel/CSV import with serial-range expansion, component timeline, versioned change history, service log, traceability, assignment/My Queue, warranty + service-overdue alerts, analytics, AI invoice extraction) remains live under `/legacy/*` routes against its own Supabase project, with its own edge functions (`warranty-alerts`, `weekly-digest`). It is in maintenance mode; the platform's Manufacturing module is its successor once the scripted data migrations (`dlms/scripts/migrate_demo.ts`, `migrate_components.ts`, `reconcile.ts` — runbooks RB-07/RB-08) run against production data.

---

## Clinical API

FastAPI app (`api/`), deployed on Railway. All routes except `/webhooks/*` and `/health` require `X-Api-Key`; admin routes require `X-Admin-Key` instead.

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
| `triage` | Cross-patient attention worklist — anomalies, declining trends, prediction divergence |
| `import_data` | CSV/Excel bulk import + parquet seeding (admin-gated) |
| `wearable` | Wearable enrollment + feature summaries |
| `webhooks` | Terra webhook ingest (HMAC-verified) |
| `admin` | Model hot-reload, retrain trigger, retrain state |

AI stack: **Claude Sonnet 4.6** (via `QTX_CLAUDE_MODEL`) for narrative insights and Q&A, **Voyage-3-lite** (512-dim, HNSW-indexed in pgvector) for embeddings. Reasoning is per-patient only — cross-patient generation was ruled clinically inappropriate. A Sonnet-5 migration is **not** a drop-in (adaptive thinking + different tokenizer); treat it as a deliberate change.

### Production seeding

Patient data files are never in git (PHI). Seed or refresh a deployed environment by uploading the locally-built parquet through the admin-gated endpoint (idempotent upsert, safe to re-run):

```bash
curl -X POST \
  -H "X-Api-Key: $QTX_API_KEY" -H "X-Admin-Key: $QTX_ADMIN_KEY" \
  -F "file=@data/processed/dashboard_data.parquet" \
  https://<api-host>/api/import/seed_parquet
```

Prod DB migrations are the numbered `scripts/NN_migrate_*.py`, run locally against the remote database URL; all idempotent, all wired into `setup.sh`.

---

## Dual-Loop ML + AI

Every `POST /api/patient/{sn}/session` runs:

1. **PredictionService** — 4 XGBoost models → `session_predictions` (SHAP top-5 drivers, bias correction) — commits **atomically** with the session and trends (prediction inside a SAVEPOINT)
2. **InsightService** — Claude prompt includes all model signals; flags model/observation divergence — runs in a **background task, fail-safe**: Claude errors persist `model="api_error"` rows, never a 502. The POST returns `insight_status: "scheduled"`; the UI polls `GET .../insights`
3. **RetrainService** — count-based trigger: spawns `scripts/18_scheduled_retrain.py` at ≥ `RETRAIN_THRESHOLD` sessions
4. **CalibrationService** — drift-based trigger: retrain if any cohort's MAE drifted ≥ `CALIBRATION_DRIFT_THRESHOLD` (1 h cooldown)

Only the interactive endpoints (`/ask`, `/prepare_session`, `/suggest_plan`) surface Claude failures as 502. Retrain promotion is gated on a frozen holdout set — a candidate must beat the incumbent on identical data to be promoted. scikit-learn is pinned `>=1.8,<1.9` to match the pickled models.

---

## Web Dashboard

Next.js 14 app (`web/`, port 3000) talking to the Clinical API **exclusively through its own server-side BFF proxy** (`web/app/api/[...path]/route.ts`): the browser authenticates with a Supabase session, the proxy verifies it against a fail-closed email allowlist, then injects `X-Api-Key` server-side and forwards. No API key ever ships to the browser.

- **Overview / Cohorts / Clinical / Triage** workspaces — cohort analytics, response curves, per-patient clinical drawer, cross-patient attention worklist
- **Clinical drawer tabs** — Timeline, AI (insights + Q&A + pre-session brief + treatment plan), predictions (chips + SHAP drivers), anomaly warnings, dosage recommender, PDF export
- **Patient View** (`/patient/[sn]`) — patient-facing trajectory simulator: plain-English progress summary, goal picker, session slider with cohort p25–p75 percentile band
- **Admin** (`/admin`) — model health, retrain state, calibration drift

---

## ML Pipeline

Each stage is an independent script chained through Parquet files. Run individually or via `make`.

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

Beyond training, `scripts/` also holds the operational CLIs: `10_reconcile_wearables`, DB seeds/backfills (`11`, `16`, `20`, `25`, `26`), idempotent schema migrations (`12/13/15/19/22/23/24/27/28/29`), the offline RAISE evaluation (`17`), the scheduled retrain entrypoint (`18`), and the calibration report (`21`). Numbers `09` and `14` are intentionally absent (deleted in cleanups). Every cleaning change is audited row-level to `data/audit/clean_audit.csv`.

**Warning:** `make clean` removes `data/processed/`, `reports/` **and `models/`** — including the tracked serving artefacts; restore them with `git checkout models/`.

---

## Model Results

Latest full `make model` run on the 2024 AH dataset (2026-07-10 re-baseline; XGBoost only). Update this section after retraining on new data.

> **Methodology note:** all metrics come from **nested, patient-grouped 5-fold CV** — hyperparameters selected inside each outer training fold, folds grouped by patient (`sn`), regression target normalisation refit per fold. Earlier published numbers came from a leaky protocol and are not comparable.

| Metric | Value | Notes |
|--------|-------|-------|
| Patients | 1,716 | 49 legacy (`OLD…`) records excluded from primary models |
| Follow-up rate | 34.7% (596 / 1,716) | Dropout is the primary data-quality challenge |
| Overall responders | 69.5% of follow-up (414 / 596) | ≥ MCID on 2+ tests |
| Classified by phenotype | 39.9% (684 / 1,716) | Most unclassified have no comorbidity tags |
| **Regression XGB** R² (composite improvement) | **0.176** | RMSE 0.752 ± 0.188 (per-fold-normalised target), MAE 0.491, n = 596 |
| **Classifier XGB** AUC-ROC (overall responder) | **0.691 ± 0.073** | AUC-PR 0.839, Brier 0.200, F1 0.683 |
| **Dropout XGB** AUC-ROC | **0.998** | see caveat below |
| Dosage macro F1 (3-class) | 0.541 ± 0.041 | Macro AUC-ROC (OVR) 0.762, n = 544 labelled |

- **Dropout-model caveat:** a missingness-mask-only ablation reaches AUC 0.986 under the same protocol — the model is an administrative missing-data detector, **not a clinical predictor**. Treat its score as a data-completeness flag.
- XGBoost handles NaN natively (no imputer step). `reports/modelling.html` has SHAP importances, calibration curves, and the sensitivity analysis across four imputation strategies.

**Top phenotype groups** (of classified patients): Joint disease 25%, Frailty/Sarcopenia 11%, Spine/Back 8%, Soft-tissue injury 6%, Neurological 4%.

---

## Configuration System

**Rule: no thresholds, patterns, or assumptions live in Python code.** Edit YAML, re-run the affected stage.

- `config/cleaning.yaml` — NA tokens, normalisation maps, plausibility ranges, age bands, structural column lists
- `config/outcomes.yaml` — MCIDs per test, composite method, responder threshold
- `config/phenotypes.yaml` — 3-layer taxonomy (14 groups, 9 regions, 24 condition flags), priority order, cohort rollup
- `config/missingness.yaml` — per-feature imputation policy; **outcomes are never imputed**
- `config/models.yaml` — feature lists, hyperparameter blocks, CV settings, sensitivity variants
- `config/dosage.yaml`, `config/schema.yaml`, `config/settings.yaml` — dosage model, canonical schema, paths/seed/logging

To add a model: add a block to `models.yaml`, create `src/qtx/models/<name>.py` using the shared `qtx.models.evaluate` helpers, register it in `scripts/06_train_models.py`, and (to serve it) register the artefact in `api/deps.py`.

---

## Phenotype Rules

The taxonomy lives entirely in `config/phenotypes.yaml` — the clinical team can edit it without touching Python.

```bash
nano config/phenotypes.yaml           # 1. edit patterns / groups / flags
make phenotype                        # 2. re-run
head -20 reports/unmatched_tags.csv   # 3. review unmatched tokens (feedback loop)
PYTHONPATH=src python scripts/03_phenotype.py --sample 30   # 4. sample for clinical review
```

New groups get a `label` + `patterns` list, a rank in `priority`, and (optionally) a `cohort_rollup` entry. Condition flags are binary, independent of the group hierarchy, and feed model features directly. A patient is Unclassified when both `tags` and `pain_location` are empty (~57% of this dataset) or when no pattern matches — check `unmatched_tags.csv` before adding patterns.

---

## RAISE Dataset

The RAISE multi-centre eldercare validation cohort (**n=206**) informs the AI layer as **narrative-only** context: its validated findings are cited in the Claude system prompt but do **not** feed any served XGBoost prediction.

- 162 RAISE rows are ingested into the DB (tagged `ingested_from ILIKE '%raise%'`) and excluded from calibration and metric-series queries. **The 206 / 162 distinction is intentional** — published validation cohort vs rows loaded here. Do not "correct" one to the other.
- Findings in the prompt: diabetes = high-responder (ANCOVA p=0.015), frailty 5× response differential, dementia regression caution, peak response window age 70–79, SPPB near-ceiling (≈12) = success.
- Merging RAISE into QTX training is gated by `scripts/17_raise_model_evaluation.py`: covariate-shift AUC < 0.70 **and** `primary_indication` SHAP < 15% required.

---

## Wearable Integration

Terra powers wearable ingestion: `/webhooks/terra` verifies HMAC-SHA256 signatures (300 s replay window) and stores pseudonymous `terra_user_id` + metrics idempotently; `api/services/wearable_features.py` aggregates activity/sleep features per patient; `make reconcile-wearables` links Terra users to patients. Terra PDPA / HBRA written confirmation is required before go-live with real patients.

---

## Deployment

> **Git push deploys nothing by itself.** Every deploy is a manual, explicit act — verify, don't assume.

- **Railway (Clinical API):** pushing `main` is *supposed* to auto-deploy — verify a build actually started after each push, and redeploy from the dashboard if not. Health check: unauthenticated `GET /health`. Build stack: nixpacks (`nixpacks.toml` carries the WeasyPrint native libs) + `Procfile` → `start.sh`.
- **Vercel (both apps):** the git webhook is not wired. Platform/DLMS: `cd dlms && npx vercel deploy --prod --yes`. Clinician web: the same command **from the repo root** (the project's root-directory setting is `web`; deploying from inside `web/` fails).
- **Supabase (platform + legacy DLMS):** committing a migration file does nothing — cloud apply is a separate explicit step (Supabase MCP `apply_migration` or CLI), as is deploying edge functions. Platform migrations are ordering-critical; apply in filename order.
- **Platform crons:** `dlms/vercel.json` declares four (outbox drain every 5 min; task reminders, warranty expiry, permission-override expiry). They authenticate with `CRON_SECRET` and fail closed — an unset secret means silent 401s, detected via `GET /api/health` queue staleness. Vercel Hobby runs at most two daily crons and **silently drops the rest**.

---

## Testing

TDD is the house convention in all three codebases.

```bash
# Backend + pipeline (canonical invocation; `make test` also works)
PYTHONPATH=src:api .venv/bin/pytest -q
PYTHONPATH=src:api .venv/bin/pytest tests/test_foo.py -k name -q   # one file / one test

# Clinician dashboard
cd web && npm test               # Jest + RTL
cd web && npx tsc --noEmit && npm run build

# Ops Platform
cd dlms && npm test                    # unit (Vitest)
cd dlms && npm run test:integration    # dockerised Postgres, serial, self-tearing-down
cd dlms && npm run type-check && npm run build

# E2E (repo root; needs `make dev` + E2E_CLINICIAN_EMAIL/PASSWORD)
npx playwright test
```

The backend suite covers the pipeline modules, every API router and service, and the RAISE ingest/evaluation scripts (API tests run on in-memory SQLite fixtures). Platform tests split into a pure unit layer and an integration layer that exercises the real schema — including convention-enforcement tests (RBAC matrix drift, RLS posture derived from migrations, AAL pinning on every server action, route reachability / orphan detection). DLMS domain modules take an injectable `today`; mutation tests use the shared Supabase chain mock.

---

## Data Dictionary

Full field definitions, units, and allowed values: `data/inputs/QTX_AH_2024_organised.xlsx` → sheet *Data Dictionary*. Canonical column names, dtypes and allowed values: `config/schema.yaml`.

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

**Treatment dosing** (`usage_frequency`): `Once (1x/week, one leg)` · `Twice (2x/week, one leg per session)` · `L+R 10 (20-min session, 10 min each leg)`.

**Responder definition:** meets the MCID threshold on ≥2 tests → `overall_responder` (configurable in `config/outcomes.yaml`).

**Composite score:** each test's improvement is z-scored within cohort (if n ≥ 30) or globally, then averaged across available tests. Mean ≈ 0 by construction.

**Data completeness:** ~34.7% of patients have any follow-up; ~60% have no comorbidity tags (Unclassified); missing follow-up is treated as informative dropout, not random missingness.

---

## Reproducibility

All random seeds are set via `config/settings.yaml → random_seed`. Re-running `make all` on the same input file produces byte-identical Parquet outputs.

---

## Licence

Internal — QuantumTX Pte Ltd. Not for public distribution.
