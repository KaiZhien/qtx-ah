"""
Nightly reconciliation: fetch yesterday's wearable data for all active
enrolled patients and fill any rows that the webhook missed.

Run: PYTHONPATH=api .venv/bin/python scripts/10_reconcile_wearables.py
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from db import Base
from models.wearable import WearableEnrollment
from services import terra as terra_svc

_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "wearable.db"
_engine = create_engine(f"sqlite:///{_DB_PATH}", connect_args={"check_same_thread": False})
_Session = sessionmaker(bind=_engine)

DATA_TYPES = ["activity", "body", "sleep"]


def reconcile(target_date: date | None = None) -> None:
    dev_id = os.environ.get("TERRA_DEV_ID", "")
    api_key = os.environ.get("TERRA_API_KEY", "")
    if not dev_id or not api_key:
        print("TERRA_DEV_ID / TERRA_API_KEY not set — skipping reconciliation")
        return

    day = target_date or date.today() - timedelta(days=1)
    start_str = day.isoformat()
    end_str = (day + timedelta(days=1)).isoformat()

    db = _Session()
    try:
        active = db.query(WearableEnrollment).filter_by(active=True).all()
        print(f"Reconciling {len(active)} enrolled patients for {day}")

        for enrollment in active:
            uid = enrollment.terra_user_id
            for dtype in DATA_TYPES:
                try:
                    data = terra_svc.fetch_user_data(
                        uid, dtype, start_str, end_str, dev_id, api_key
                    )
                    if data:
                        payload = {
                            "type": dtype,
                            "user": {
                                "user_id": uid,
                                "provider": enrollment.device_brand,
                            },
                            "data": data,
                        }
                        terra_svc.ingest_payload(payload, db)
                        print(f"  {uid} {dtype}: {len(data)} records ingested")
                except Exception as exc:
                    print(f"  {uid} {dtype}: ERROR — {exc}")
    finally:
        db.close()


if __name__ == "__main__":
    reconcile()
