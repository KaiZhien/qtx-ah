"""FastAPI application entry point."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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

app.include_router(patients.router, prefix="/api")
app.include_router(predict.router, prefix="/api")
app.include_router(fall_risk.router, prefix="/api")
app.include_router(wearable.router, prefix="/api")
app.include_router(webhooks.router)
