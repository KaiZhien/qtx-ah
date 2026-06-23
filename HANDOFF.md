# QTX-AH Handoff

**Date:** 2026-06-23 | **Branch:** main | **Commit:** ee6a731

---

## 1 · Clinical Intelligence System (Sub-projects 1–4 complete)

**Status:** 613 backend tests passing. Jest + RTL (26). Playwright E2E (25). Production live on Railway + Vercel.

### What Was Built
- **SP1** — PostgreSQL 17 + pgvector replacing static parquet. CSV/Excel import + longitudinal session schema.
- **SP2** — Per-patient longitudinal model. Trend signals on every session.
- **SP3** — Claude Sonnet 4.6 + Voyage-3-lite (512 dims). Proactive insights + clinician Q&A with semantic retrieval.
- **SP4** — Timeline tab, AI tab, MetricChart, InsightCard, QAPanel, PDF export wired to live API.

### Production URLs
| Service | URL |
|---------|-----|
| Backend (Railway) | `https://web-production-484c2.up.railway.app` |
| Frontend (Vercel) | `https://qtx-ah.vercel.app` |

**First-deploy DB setup:** `cd /app && bash setup.sh`

### Local Dev
```bash
# Prerequisites (one-time, macOS)
brew install postgresql@17 pgvector pango && brew services start postgresql@17
psql postgres -c "CREATE USER qtx WITH PASSWORD 'secret';"
psql postgres -c "CREATE DATABASE qtxah OWNER qtx;"
psql qtxah -c "CREATE EXTENSION IF NOT EXISTS vector; GRANT ALL ON SCHEMA public TO qtx;"
./setup.sh   # migrations + seeding (idempotent)
make dev     # API :8000 + Next.js :3000
```

**`.env` (root):** `QTX_API_KEY`, `QTX_ADMIN_KEY`, `DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `ALLOWED_ORIGINS`

**`web/.env.local`:** `NEXT_PUBLIC_API_KEY`, `NEXT_PUBLIC_API_URL=http://localhost:8000`

### Key Decisions
| Decision | Choice |
|----------|--------|
| Embeddings | Voyage-3-lite ($0.06/1M) |
| LLM | Claude Sonnet 4.6 |
| Reasoning scope | Per-patient only (cross-patient clinically inappropriate) |
| Admin auth | Separate `QTX_ADMIN_KEY` via `X-Admin-Key` |
| Retrain trigger | Count-based (50 sessions) + drift-based (30% MAE) |
| scikit-learn | Pinned `>=1.8,<1.9` (models pickled with 1.8.x) |

### Dual-Loop ML+AI (every POST /api/patient/{sn}/session)
1. **PredictionService** → 4 XGBoost models → `session_predictions` (SHAP top-5, bias correction)
2. **InsightService** → Claude prompt includes all 4 signals; flags divergence
3. **RetrainService** → count-based: spawns `scripts/18` when sessions since retrain ≥ 50
4. **CalibrationService** → drift-based: retrain if any cohort MAE drifted ≥ 30% (1 hr cooldown)

### Key File Map
```
api/main.py, db.py, deps.py
api/routers/  patients, sessions, ask, predict, admin, calibration, cohort_curves, report
api/services/ insight, prediction, retrain, calibration, cohort_curves, voyage, report
web/components/pages/  OverviewPage, CohortsPage, ClinicalPage
web/components/clinical/  InsightCard, MetricChart, QAPanel, TimelineTab, AITab, PredictionChips
web/components/patient/   GoalPicker, ProgressHeroCard, TrajectoryChart
scripts/ 11–25 | setup.sh (runs all migrations + seeding)
```

### RAISE Eldercare Dataset
162 patients (METTA/LB/PH). Tagged `ingested_from ILIKE '%raise%'`. Covariate shift gate (script 17): AUC < 0.70 AND `primary_indication` SHAP < 15% required before merging into QTX training.

**RAISE findings in system prompt:** diabetes = high-responder (ANCOVA p=0.015), frailty 5× differential, dementia regression caution, age window 70–79 peak, SPPB ceiling near 12 = success.

### Test Commands
```bash
PYTHONPATH=src:api .venv/bin/pytest tests/ -v   # 613 tests
cd web && npm test                               # 26 Jest/RTL tests
npx playwright test                              # 25 E2E (requires make dev)
```

### Outstanding
- Anthropic BAA required before sending real patient data to Claude in production
- Terra PDPA / HBRA compliance written confirmation needed before go-live
- Re-run script 17 after script 20 backfill to confirm AUC < 0.70
- Seed RAISE patients in Railway prod if needed (`scripts/16` via Railway console)
- Fall risk removed from this codebase — owned by a separate team member

---

## 2 · DLMS — Device Lifecycle Management System

**Status:** Live on cloud Supabase (`bkvbqopcebfjfiemqdvk`). 103 tests passing. Commit `ee6a731`.

**Location:** `dlms/` (Next.js 14 App Router + Supabase cloud)

### What Was Built
- Supabase auth (email/password) with role-based access: `viewer`, `engineer`, `admin`, `system`
- Colour-coded device table — 6 sections matching the PCBA traceability spreadsheet (Device Info, PCBA-A, PCBA-B, HMI, Shipment, Status & Notes)
- **Modal-based create/edit** — wide centred dialog with all 21 fields in colour-coded grouped sections
- CSV export with bilingual headers (auto-derived from `FIELD_LABELS`)
- Filters panel + sortable columns
- RLS + table GRANT layer (`20250101000008_grants.sql`) — anon=SELECT only, authenticated/service_role=full DML
- Full audit log (`audit_log` table) — every INSERT/UPDATE/soft-delete with old/new values and changed columns
- **Warranty-expiry notifications** (ship_date + 2 years):
  - `warranty_expiry` generated column on `device` (auto-computed, read-only)
  - Yellow/red `AlertTriangle` icon per row (≤7 days = yellow, expired = red)
  - Banner on `/devices` counting upcoming-expiry devices
  - `warranty-alerts` Edge Function — daily email to all active engineers + admins; deduped via `warranty_notification` table
  - Cron job `dlms-warranty-alerts` at 08:00 UTC daily
- **Sign-up flow** at `/signup` — restricted to `@quantumtx.com` emails; new accounts default to `role='engineer', active=false`; admin activates via SQL

### Cloud Infrastructure
| Resource | Value |
|----------|-------|
| Supabase project | `bkvbqopcebfjfiemqdvk` |
| Project URL | `https://bkvbqopcebfjfiemqdvk.supabase.co` |
| Edge Functions | `warranty-alerts`, `weekly-digest` |
| Cron job | `dlms-warranty-alerts` — daily 08:00 UTC |

### Activating a new user (after they sign up + confirm email)
```sql
UPDATE app_user SET active = true, role = 'engineer' WHERE email = 'user@quantumtx.com';
-- For admins:
UPDATE app_user SET active = true, role = 'admin' WHERE email = 'user@quantumtx.com';
```

### Activating Resend email alerts (one-time setup)
```bash
cd dlms
npx supabase secrets set RESEND_API_KEY=re_xxxx WARRANTY_FROM_EMAIL=alerts@quantumtx.com
```
Then update the cron job in the SQL Editor with the real service-role key (see cron migration for template).

### Local Dev
```bash
cd dlms
npx supabase start          # starts local Postgres + Auth + PostgREST (requires Docker)
npm run dev                 # Next.js on :3001

# Local Studio:  http://localhost:54323
# Local DB:      postgresql://postgres:postgres@127.0.0.1:54322/postgres
# Local email:   http://localhost:54324 (Inbucket)
```

**`dlms/.env.local` (currently pointing at cloud):**
```
NEXT_PUBLIC_SUPABASE_URL=https://bkvbqopcebfjfiemqdvk.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
NEXT_PUBLIC_DEV_MODE=true
```
To switch back to local, replace URL with `http://127.0.0.1:54321` and use the local keys from `npx supabase start` output.

### DB Schema (key tables)
| Table | Purpose |
|-------|---------|
| `device` | 22-column device record + `warranty_expiry` (generated) + `version` (optimistic concurrency) |
| `warranty_notification` | Dedup log — records which devices have had a warranty alert email sent |
| `status_option` | Vocabulary: In Stock, In Use, Under Repair, Retired, Lost, Shipped |
| `phase_option` | Vocabulary: Production, Validation, Rework, Pilot, EoL, MP |
| `app_user` | User profiles + role (`viewer`/`engineer`/`admin`/`system`) + `active` flag |
| `audit_log` | Append-only row-level change log |

### Key Files
```
dlms/app/
  devices/page.tsx          — RSC: fetches devices + vocabulary + expiring count; renders banner
  devices/actions.ts        — Server actions: create/update device rows
  signup/page.tsx           — Sign-up form (domain-restricted to @quantumtx.com)
  signup/actions.ts         — Sign-up server action: auth.signUp + app_user insert (active=false)
dlms/components/device/
  DeviceTable.tsx           — Main table: colour-coded headers, warranty icon, modal create/edit
  WarrantyBanner.tsx        — Yellow alert banner when devices expiring within 7 days
dlms/supabase/functions/
  warranty-alerts/          — Daily email Edge Function (Deno); HTML-escaped; deduped
  weekly-digest/            — Weekly analytics digest Edge Function
dlms/supabase/migrations/
  20250104000000_warranty.sql      — warranty_expiry generated column + warranty_notification table
  20250104000001_warranty_cron.sql — Daily cron job (placeholder URL; update after deploy)
dlms/lib/
  auth/permissions.ts       — can() + ACTIONS RBAC
  i18n/fields.ts            — GROUP_LABELS, FIELD_LABELS (bilingual, single source of truth → CSV export)
  services/deviceService.ts — listDevices, getExpiringWarrantyCount, SORTABLE set
```

### Known Issues / Open Items
- `tsc --noEmit` errors in `dlms/__tests__` (missing `@types/jest` in tsconfig) — pre-existing, safe to ignore
- `NEXT_PUBLIC_DEV_MODE=true` in `.env.local` enables cookie-based role switching for local demos — remove or set to `false` before exposing the app publicly
- `warranty_notification` records are permanent (no TTL) — if a `ship_date` is ever corrected on a device, the old notification blocks future alerts. Clear with: `DELETE FROM warranty_notification WHERE device_id = '...'`
- Resend secrets not yet configured — warranty email alerts are inert until `RESEND_API_KEY` + `WARRANTY_FROM_EMAIL` are set via `npx supabase secrets set`

---

## Repo Structure
```
/                  — FastAPI backend (src/, api/, models/, scripts/)
web/               — Next.js 14 clinical intelligence frontend
dlms/              — Next.js 14 DLMS (Device Lifecycle Management)
setup.sh           — Backend migrations + seeding (clinical system only)
Makefile           — make dev, make setup, make test
```
