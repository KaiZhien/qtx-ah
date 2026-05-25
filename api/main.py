"""FastAPI application entry point."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import deps
from routers import patients, predict, fall_risk, wearable, webhooks


@asynccontextmanager
async def lifespan(app: FastAPI):
    deps.load_all()
    from db import init_db
    init_db()
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
    if not request.url.path.startswith("/webhooks"):
        expected = os.environ.get("QTX_API_KEY", "")
        if not expected:
            return JSONResponse({"detail": "QTX_API_KEY is not configured on the server"}, status_code=500)
        provided = request.headers.get("X-Api-Key", "")
        if provided != expected:
            return JSONResponse({"detail": "Invalid or missing API key"}, status_code=401)
    return await call_next(request)


app.include_router(patients.router, prefix="/api")
app.include_router(predict.router, prefix="/api")
app.include_router(fall_risk.router, prefix="/api")
app.include_router(wearable.router, prefix="/api")
app.include_router(webhooks.router)
