"""Terra webhook receiver."""
from __future__ import annotations

import json
import os

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from db import get_db
from services import terra as terra_svc

router = APIRouter()


@router.post("/webhooks/terra")
async def terra_webhook(request: Request, db: Session = Depends(get_db)):
    body = await request.body()
    secret = os.environ.get("TERRA_WEBHOOK_SECRET", "")
    if secret:
        sig = request.headers.get("terra-signature", "")
        if not terra_svc.verify_signature(body, sig, secret):
            raise HTTPException(status_code=401, detail="Invalid Terra signature")
    payload = json.loads(body)
    terra_svc.ingest_payload(payload, db)
    return {"status": "ok"}
