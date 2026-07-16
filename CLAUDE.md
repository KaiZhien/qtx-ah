# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Four co-located systems (see README.md for full reference docs):

1. **ML pipeline** — `src/qtx` (library) + `scripts/01–29` (stage CLIs) + `config/*.yaml`. File-based chaining via Parquet in `data/processed/`.
2. **Clinical API** — `api/` FastAPI + Postgres/pgvector, deployed on Railway (project `valiant-spontaneity`, service `web`).
3. **Clinician dashboard** — `web/` Next.js 14, deployed on Vercel (`qtx-ah`). Auth = Supabase login (project `qtx-clinician-auth`) + a server-side BFF proxy at `web/app/api/[...path]/route.ts` that injects `X-Api-Key`. The browser never holds API keys.
4. **DLMS** — `dlms/` self-contained Next.js 14 + Supabase (`bkvbqopcebfjfiemqdvk`), deployed on Vercel (`dlms`).

## Commands

```bash
# Backend + pipeline tests (canonical invocation; `make test` also works)
PYTHONPATH=src:api .venv/bin/pytest -q                      # full suite
PYTHONPATH=src:api .venv/bin/pytest tests/test_foo.py -q    # one file
PYTHONPATH=src:api .venv/bin/pytest tests/test_foo.py -k name -q

# Web dashboard
cd web && npm test                 # Jest
cd web && npx tsc --noEmit         # types
cd web && npm run build
npx playwright test                # e2e from repo root; needs `make dev` + E2E_CLINICIAN_EMAIL/PASSWORD

# DLMS
cd dlms && npm test                # Vitest;  npx vitest run __tests__/foo.test.ts for one file
cd dlms && npm run type-check && npm run build

# ML pipeline (config-driven — change config/*.yaml, not code constants)
make features        # ingest → clean → phenotype → outcomes → featured.parquet
make model dosage    # retrain all models (nested CV; slower than the old protocol)
make dev             # API :8000 + web :3000  (dlms: cd dlms && npm run dev → :3001)
```

## Deployment — none of this is guessable

- **Railway (API)**: auto-deploys on push to `main`. Verify with `GET /health` (unauthenticated). CLI is linked; `railway variables --service web` / `--service Postgres` work. Prod DB migrations: numbered `scripts/NN_migrate_*.py` run locally against the Postgres service's `DATABASE_PUBLIC_URL` (convert to `postgresql+psycopg2://`), also wired into `setup.sh`.
- **Vercel (both apps): git push does NOT deploy.** DLMS: `cd dlms && npx vercel deploy --prod --yes`. Web: run the same **from the repo root** (project root-directory setting is `web`; `.vercelignore` restricts the upload — deploying from inside `web/` fails looking for `web/web`).
- **DLMS DB**: migration files live in `dlms/supabase/migrations/` but are applied to cloud via the Supabase MCP (`apply_migration`) or CLI — committing the file does nothing by itself. Edge functions likewise need an explicit deploy.
- Prod seeding for the clinical DB: upload the local parquet via admin-gated `POST /api/import/seed_parquet` (idempotent upsert). Data files are never in git.

## Architecture notes that span files

- **Dual-loop on `POST /api/patient/{sn}/session`**: session+trends+prediction commit atomically (prediction inside a SAVEPOINT); insight + anomaly generation run in FastAPI BackgroundTasks and are fail-safe — Claude errors persist `model="api_error"` rows, never a 502. The POST returns `insight_status: "scheduled"`; the UI reads `GET .../insights`. Only the interactive endpoints (`/ask`, `/prepare_session`, `/suggest_plan`) surface Claude failures as 502.
- **Claude usage**: one shared client in `api/services/claude_client.py` (60s timeout, SDK retries, prompt-cache on the system block). Model ID comes from `QTX_CLAUDE_MODEL` (default `claude-sonnet-4-6`) — a sonnet-5 migration is NOT a drop-in (adaptive thinking on by default + different tokenizer); treat it as a deliberate change.
- **ML methodology is load-bearing**: reported metrics use nested, patient-grouped CV with per-fold target normalization (`src/qtx/models/evaluate.py`). Categorical encoding is shared between batch training and `scripts/18_scheduled_retrain.py` via `qtx.models.preprocessing` — keep them on the same contract or served models break. The retrain promotion gate scores incumbent vs candidate on a frozen holdout (`models/eval_set.parquet`, gitignored); never reintroduce stored-metric comparisons or 0.0-default baselines.
- **The dropout model (AUC 0.998) is a missingness detector, not a clinical predictor** — a missingness-mask-only ablation reaches 0.986. Don't present its score as clinical risk (README Model Results has the caveat).
- **DLMS security model** (since 2026-07-16): pure reads run on the user-scoped `createReadClient()` so **RLS is live enforcement on the read path**; writes AND read-feeds-write pre-reads (`fetchDeviceForWrite`/`fetchDraftForWrite`, dedupe checks, last-admin count) stay on the service-role admin client for optimistic-concurrency truth. `can()` in `lib/auth/permissions.ts` remains enforced in pages, server actions, AND services. `analyticsService` is a documented permanent admin-client exception (its views read audit_log, whose RLS blocks viewers). Client topology is pinned by `__tests__/*.clientSelection.test.ts` — keep them honest. Status transitions are computed from `status_option.is_terminal`/`is_initial` flags (3-arg `isValidTransition(from, to, statuses)`, fails closed; admin-added statuses just work). **Cloud vocab codes drifted from seed.sql**: prod uses `In Stock`/`Under Repair`/`Shipped`, not `Stock`/`Repair` — never assume the seeded codes in prod-facing logic. Pure logic lives in `lib/domain/` (no I/O, unit-tested); house rule: flat selects + JS reduce, no DB views/RPC.
- **DLMS audit**: `fn_audit` is shape-agnostic and attached to all mutable tables; `audit_log.row_id`/`new_values` are nullable. The seeded `system` actor `11111111-1111-1111-1111-111111111111` remains in `app_user` (still referenced by historical audit rows); the retired `device-api` edge function that wrote as this actor was removed 2026-07-13.

## Hard rules

- **PHI**: `data/` is fully gitignored and must stay that way — real patient names/DOBs live there. Git history was rewritten on 2026-07-10 to purge PHI; **never pull/push from a clone made before that date** (it resurrects the purged blobs). `.env*` files (including `.env.example`) are local-only.
- **RAISE numbers**: the published validation cohort is **n=206**; the locally ingested rows are 162 — different denominators counting different things. The `insight.py` system prompt correctly says 206; do not "fix" it. RAISE is narrative-only: it influences Claude prompts, never served XGBoost predictions.
- TDD is the house convention in all three codebases (DLMS domain modules take an injectable `today`; API service tests use the sqlite fixtures in `tests/conftest.py`; DLMS mutation tests use `__tests__/supabaseChainMock.ts`).
- Merge to `main` locally; no PRs, no long-lived branches.
- **Commit attribution**: every commit is authored solely by Reet Mitra — never add a `Co-Authored-By: Claude ...` trailer (or any co-author trailer) to a commit message. History was rewritten on 2026-07-16 to strip these trailers from all prior commits, stacking on the 2026-07-10 PHI purge; **never pull/push from a clone made before 2026-07-16** (same resurrection risk as the PHI rewrite).
- `HANDOFF.md` (gitignored, local) is the session-by-session state log — read it at session start, append to it when handing off. SETUP.md/TESTING.md are also local-only.
