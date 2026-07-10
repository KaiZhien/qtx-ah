"""FastAPI application entry point."""
from __future__ import annotations

import hmac
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the project root (one level above api/)
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import deps
from routers import patients, predict, wearable, webhooks, import_data, sessions, ask, report, admin, calibration, benchmark, anomaly, plan, cohorts


@asynccontextmanager
async def lifespan(app: FastAPI):
    deps.load_all()
    yield


app = FastAPI(title="QuantumTX AH Clinical API", version="1.0.0", lifespan=lifespan)

_raw_origins = os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000")
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def api_key_middleware(request: Request, call_next):
    """Require X-Api-Key header on all routes except /webhooks/ (which uses Terra HMAC)."""
    if not request.url.path.startswith("/webhooks") and not request.url.path.startswith("/api/admin/"):
        expected = os.environ.get("QTX_API_KEY", "")
        if not expected:
            return JSONResponse({"detail": "QTX_API_KEY is not configured on the server"}, status_code=500)
        provided = request.headers.get("X-Api-Key", "") or request.query_params.get("key", "")
        if not hmac.compare_digest(provided, expected):
            return JSONResponse({"detail": "Invalid or missing API key"}, status_code=401)
    return await call_next(request)


app.include_router(patients.router, prefix="/api")
app.include_router(predict.router, prefix="/api")
app.include_router(wearable.router, prefix="/api")
app.include_router(webhooks.router)
app.include_router(import_data.router, prefix="/api")
app.include_router(sessions.router, prefix="/api")
app.include_router(ask.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
app.include_router(report.router, prefix="/api")
app.include_router(calibration.router, prefix="/api")
app.include_router(benchmark.router, prefix="/api", tags=["benchmark"])
app.include_router(anomaly.router, prefix="/api")
app.include_router(plan.router, prefix="/api")
app.include_router(cohorts.router, prefix="/api")
