# QTX-AH — Deployment & Setup Guide

**Stack:** FastAPI (Python) + PostgreSQL + Next.js  
**Hosting:** Railway (backend + database) + Vercel (frontend)  
**Estimated cost:** ~$5–10/month on Railway Starter; Vercel free tier

---

## Prerequisites

- GitHub account with access to the `qtx-ah` repo (private repo — both Railway and Vercel support this)
- Railway account — [railway.app](https://railway.app)
- Vercel account — [vercel.com](https://vercel.com)
- API keys:
  - `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com)
  - `VOYAGE_API_KEY` from [dash.voyageai.com](https://dash.voyageai.com)

---

## Architecture Overview

```
Browser → Vercel (Next.js) → Railway (FastAPI) → Railway (PostgreSQL)
                                     ↓
                              models/*.joblib (in repo)
                              Anthropic API (Claude)
                              Voyage AI (embeddings)
```

- All `/api/*` requests from the frontend are proxied to the FastAPI backend
- The backend loads 4 ML models at startup from the `models/` directory
- The database is provisioned and managed by Railway's PostgreSQL plugin
- AI features (session insights, treatment plans, anomaly alerts) gracefully degrade to stub responses if `ANTHROPIC_API_KEY` is not set

---

## Part 1 — Railway (Backend + Database)

### 1.1 Create the project

1. Log in to [railway.app](https://railway.app)
2. Click **New Project** → **Deploy from GitHub repo**
3. Railway will prompt you to install the **Railway GitHub App** — click **Configure GitHub App** and grant access to the `qtx-ah` repo specifically (no need to grant access to all repos)
4. Select the `qtx-ah` repository
5. Railway will detect `requirements.txt` and `Procfile` automatically — no extra build config needed

### 1.2 Add a PostgreSQL database

1. Inside your Railway project, click **+ New** → **Database** → **PostgreSQL**
2. Wait for the database to provision (usually ~30 seconds)
3. Click the PostgreSQL service → **Variables** tab → copy the `DATABASE_URL` value (starts with `postgresql://`)

### 1.3 Set environment variables

Go to your Python service → **Variables** tab and add the following:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Paste from the PostgreSQL plugin (step 1.2) |
| `QTX_API_KEY` | Generate: `python3 -c "import secrets; print(secrets.token_hex(32))"` |
| `QTX_ADMIN_KEY` | Generate again (must differ from `QTX_API_KEY`) |
| `ANTHROPIC_API_KEY` | From [console.anthropic.com](https://console.anthropic.com) |
| `VOYAGE_API_KEY` | From [dash.voyageai.com](https://dash.voyageai.com) |
| `ALLOWED_ORIGINS` | Leave blank for now — fill in after Vercel deploy (step 2.3) |
| `LOG_LEVEL` | `INFO` |

Optional variables (safe to leave unset for demo):

| Variable | Default | Purpose |
|----------|---------|---------|
| `RETRAIN_THRESHOLD` | `50` | Sessions before auto-retrain triggers |
| `CALIBRATION_DRIFT_THRESHOLD` | `0.30` | MAE drift threshold for retrain |
| `CALIBRATION_MIN_COHORT_N` | `20` | Min cohort size for drift checks |
| `TERRA_WEBHOOK_SECRET` | — | Terra wearable webhook HMAC secret |
| `TERRA_DEV_ID` | — | Terra developer ID |
| `TERRA_API_KEY` | — | Terra API key |

### 1.4 Deploy and verify

Railway deploys automatically after variables are set. The service is healthy when you see:

```
[deps] DB ready — N patients loaded
INFO: Application startup complete.
```

If you see `[deps] WARNING: DB unavailable at startup`, the database URL is likely wrong — double-check the `DATABASE_URL` value.

Once deployed, copy your Railway public URL (e.g. `https://qtx-ah-api.up.railway.app`). You'll need it for the Vercel setup.

### 1.5 Run database migrations

The app auto-creates all tables on first startup via SQLAlchemy. These migration scripts add extra columns and indexes that must be run once after the first deploy.

Open a shell in Railway: go to your service → **Settings** → **Railway CLI** or use the in-browser shell. Then run each script in order:

```bash
cd /app
PYTHONPATH=/app/src:/app/api python scripts/12_migrate_add_notes_column.py
PYTHONPATH=/app/src:/app/api python scripts/13_migrate_add_embeddings.py
PYTHONPATH=/app/src:/app/api python scripts/15_migrate_add_tandem.py
PYTHONPATH=/app/src:/app/api python scripts/19_migrate_add_session_predictions.py
PYTHONPATH=/app/src:/app/api python scripts/20_normalize_raise_usage_frequency.py
PYTHONPATH=/app/src:/app/api python scripts/22_migrate_add_shap_top5.py
PYTHONPATH=/app/src:/app/api python scripts/23_migrate_add_bias_correction.py
```

Each script prints a confirmation line when complete. They are all idempotent — safe to re-run.

### 1.6 (Optional) Seed demo data

To populate the database with the QTX + RAISE patient dataset for demo purposes:

```bash
cd /app
PYTHONPATH=/app/src:/app/api python scripts/11_seed_database.py
```

This inserts ~1,700 patients from the processed parquet file. Skip this if you plan to import real data via the UI.

---

## Part 2 — Vercel (Frontend)

### 2.1 Import the project

1. Log in to [vercel.com](https://vercel.com)
2. Click **Add New Project** → import the `qtx-ah` repository
3. Vercel will prompt you to install the **Vercel GitHub App** — grant access to the `qtx-ah` repo specifically
4. Set **Root Directory** to `web`
5. Leave the build command as-is (`next build`) — Vercel detects Next.js automatically

### 2.2 Set environment variables

Under **Environment Variables**, add:

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_API_URL` | Your Railway URL from step 1.4 (e.g. `https://qtx-ah-api.up.railway.app`) |
| `NEXT_PUBLIC_API_KEY` | Same value as `QTX_API_KEY` set in Railway |

### 2.3 Deploy and update CORS

Click **Deploy**. Once complete, copy your Vercel URL (e.g. `https://qtx-ah.vercel.app`).

Go back to Railway → your Python service → **Variables** → set:

```
ALLOWED_ORIGINS = https://qtx-ah.vercel.app
```

Railway will redeploy automatically. The backend will now accept requests from your Vercel frontend.

---

## Part 3 — Verify End-to-End

Once both services are live, verify the stack is working:

**Backend health check:**
```
GET https://qtx-ah-api.up.railway.app/docs
```
Should return the FastAPI Swagger UI.

**API key check:**
```bash
curl -H "X-Api-Key: YOUR_QTX_API_KEY" https://qtx-ah-api.up.railway.app/api/patients
```
Should return a JSON list (empty array if no data yet, not a 401).

**Frontend:** Open your Vercel URL in a browser. The patient list should load without errors in the browser console.

---

## Environment Variables Reference

### Backend (Railway)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (auto-set by Railway plugin) |
| `QTX_API_KEY` | Yes | 32-byte hex key; required on all API requests via `X-Api-Key` header |
| `QTX_ADMIN_KEY` | Yes | Separate key for admin endpoints (`X-Admin-Key` header); must differ from `QTX_API_KEY` |
| `ANTHROPIC_API_KEY` | No | Enables Claude-powered insights, treatment plans, anomaly alerts. Without it, all AI responses return stub text. |
| `VOYAGE_API_KEY` | No | Enables semantic search in patient Q&A. Without it, keyword search is used as fallback. |
| `ALLOWED_ORIGINS` | Yes | Comma-separated list of allowed CORS origins (your Vercel URL in production) |
| `LOG_LEVEL` | No | Python log level — `INFO` recommended |
| `RETRAIN_THRESHOLD` | No | Default `50`. Sessions added before auto-retrain is considered. |
| `CALIBRATION_DRIFT_THRESHOLD` | No | Default `0.30`. Relative MAE increase before drift retrain triggers. |
| `CALIBRATION_MIN_COHORT_N` | No | Default `20`. Min patients per cohort for drift checks. |
| `TERRA_WEBHOOK_SECRET` | No | HMAC secret for Terra wearable webhooks. Leave blank if not using wearables. |
| `TERRA_DEV_ID` | No | Terra developer ID for wearable data pulls. |
| `TERRA_API_KEY` | No | Terra API key for wearable data pulls. |

### Frontend (Vercel)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Yes | Full URL of the Railway backend (no trailing slash) |
| `NEXT_PUBLIC_API_KEY` | Yes | Must match `QTX_API_KEY` set in Railway |

---

## Local Development

### Backend

```bash
# From repo root
cp .env.example .env
# Fill in .env with your values

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e .          # installs the src/qtx package

cd api
uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd web
cp .env.local.example .env.local   # if it exists, else create manually
# Set NEXT_PUBLIC_API_URL=http://localhost:8000
# Set NEXT_PUBLIC_API_KEY=<your QTX_API_KEY>

npm install
npm run dev
```

Both together via Makefile (from repo root):

```bash
make dev
```

---

## Updating the Deployment

Both platforms redeploy automatically on every push to `main`.

- **Railway** rebuilds the Python service and restarts it
- **Vercel** rebuilds the Next.js app

No manual steps needed after the initial migration run (section 1.5).

---

## Model Files

The following ML model files are committed to the repository and deployed with the backend:

| File | Size | Purpose |
|------|------|---------|
| `models/classifier_xgb.joblib` | 290 KB | Responder probability classifier |
| `models/regression_xgb.joblib` | 444 KB | Composite improvement regressor |
| `models/dropout_xgb.joblib` | 307 KB | Dropout risk predictor |
| `models/dosage_frequency.joblib` | 6.7 MB | Dosage frequency recommender |
| `models/fall_risk_xgb.joblib` | 372 KB | Fall risk predictor |
| `models/fall_risk_medians.joblib` | < 1 KB | Fall risk baseline medians |

The large GradientBoosting variants (`*_gbm.joblib`, ~130MB each) are gitignored and not deployed — the XGBoost models are used in production.

To retrain and update models, trigger a manual retrain via the Admin dashboard or `POST /api/admin/trigger_retrain` with the `X-Admin-Key` header.

---

## Troubleshooting

**Backend won't start — `RuntimeError: model file(s) not found`**  
The XGBoost model files are missing. Ensure `models/*.joblib` (non-GBM) are committed and pushed to the repo.

**`[deps] WARNING: DB unavailable at startup`**  
`DATABASE_URL` is missing or incorrect. Verify it matches the Railway PostgreSQL plugin's connection string exactly.

**Frontend shows 401 errors**  
`NEXT_PUBLIC_API_KEY` does not match `QTX_API_KEY` on the backend. Both must be identical.

**Frontend shows CORS errors**  
`ALLOWED_ORIGINS` on Railway does not include your Vercel URL. Update it and Railway will redeploy.

**AI features return stub text**  
`ANTHROPIC_API_KEY` is not set or is invalid. All AI endpoints degrade gracefully — this is expected behaviour without a key.

**Embeddings / semantic search not working**  
`VOYAGE_API_KEY` is not set. The Q&A endpoint falls back to keyword search automatically.
