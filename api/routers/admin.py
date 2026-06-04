"""Admin endpoints — model hot-reload. Protected by QTX_ADMIN_KEY (separate from QTX_API_KEY)."""
from __future__ import annotations

import hmac
import os

from fastapi import APIRouter, Depends, HTTPException, Request

import deps

router = APIRouter()


def require_admin_key(request: Request) -> None:
    """Verify X-Admin-Key header matches QTX_ADMIN_KEY env var."""
    expected = os.environ.get("QTX_ADMIN_KEY", "")
    if not expected:
        raise HTTPException(status_code=503, detail="QTX_ADMIN_KEY is not configured")
    provided = request.headers.get("X-Admin-Key", "")
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing admin key")


@router.post("/admin/reload-models", dependencies=[Depends(require_admin_key)])
def reload_models() -> dict:
    """Reload all ML model files from disk into the running process."""
    deps.load_all()
    loaded = [
        "classifier_xgb.joblib", "regression_xgb.joblib",
        "dropout_xgb.joblib", "dosage_frequency.joblib",
    ]
    return {"status": "ok", "models_loaded": loaded}
