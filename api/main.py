"""FastAPI application entry point."""
from __future__ import annotations

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
from routers import patients, predict, fall_risk, wearable, webhooks, import_data, sessions, ask, report, admin


@asynccontextmanager
async def lifespan(app: FastAPI):
    deps.load_all()  # init_db() is called inside load_all() once Task 6 (deps.py) is done
    yield


app = FastAPI(title="QuantumTX AH Clinical API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def api_key_middleware(request: Request, call_next):
    """Require X-Api-Key header on all routes except /webhooks/ (which uses Terra HMAC)."""
    exempt = request.url.path.startswith("/webhooks") or request.url.path.startswith("/api/admin")
    if not exempt:
        expected = os.environ.get("QTX_API_KEY", "")
        if not expected:
            return JSONResponse({"detail": "QTX_API_KEY is not configured on the server"}, status_code=500)
        provided = request.headers.get("X-Api-Key", "") or request.query_params.get("key", "")
        if provided != expected:
            return JSONResponse({"detail": "Invalid or missing API key"}, status_code=401)
    return await call_next(request)


app.include_router(patients.router, prefix="/api")
app.include_router(predict.router, prefix="/api")
app.include_router(fall_risk.router, prefix="/api")
app.include_router(wearable.router, prefix="/api")
app.include_router(webhooks.router)
app.include_router(import_data.router, prefix="/api")
app.include_router(sessions.router, prefix="/api")
app.include_router(ask.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
app.include_router(report.router, prefix="/api")
