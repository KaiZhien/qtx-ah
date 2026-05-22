"""Terra API service — HMAC verification and payload ingestion."""
from __future__ import annotations

import hashlib
import hmac
import uuid
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from models.wearable import (
    WearableActivity,
    WearableBody,
    WearableEvent,
    WearableSleep,
)

TERRA_BASE_URL = "https://api.tryterra.co/v2"


def verify_signature(body: bytes, header: str, secret: str) -> bool:
    """Return True if Terra's HMAC-SHA256 webhook signature is valid."""
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        timestamp = parts["t"]
        v1 = parts["v1"]
    except (KeyError, ValueError):
        return False
    expected = hmac.new(
        secret.encode(),
        f"{timestamp}.{body.decode()}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, v1)


def create_widget_session(
    patient_id: str, dev_id: str, api_key: str
) -> dict:
    """Request a Terra widget session URL for patient enrollment."""
    resp = httpx.post(
        f"{TERRA_BASE_URL}/auth/generateWidgetSession",
        headers={"dev-id": dev_id, "x-api-key": api_key},
        json={
            "providers": "APPLE,GARMIN,FITBIT,WHOOP,SAMSUNG",
            "language": "EN",
            "reference_id": patient_id,
        },
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_user_data(
    terra_user_id: str,
    data_type: str,
    start_date: str,
    end_date: str,
    dev_id: str,
    api_key: str,
) -> list[dict]:
    """Pull historical data for one user and data type from Terra's REST API."""
    resp = httpx.get(
        f"{TERRA_BASE_URL}/userdata",
        headers={"dev-id": dev_id, "x-api-key": api_key},
        params={
            "user_id": terra_user_id,
            "data_type": data_type,
            "start_date": start_date,
            "end_date": end_date,
            "to_webhook": "false",
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("data", [])


def deactivate_user(terra_user_id: str, dev_id: str, api_key: str) -> None:
    """Revoke Terra connection for a user."""
    httpx.delete(
        f"{TERRA_BASE_URL}/user/{terra_user_id}",
        headers={"dev-id": dev_id, "x-api-key": api_key},
        timeout=10,
    ).raise_for_status()


def ingest_payload(payload: dict, db: Session) -> None:
    """Parse a Terra webhook payload and write normalised rows to the DB."""
    payload_type = payload.get("type", "")
    user_info = payload.get("user", {})
    terra_user_id = user_info.get("user_id", "")
    provider = user_info.get("provider", "")
    data_list = payload.get("data", [])

    if not terra_user_id or not data_list:
        return

    if payload_type == "activity":
        _ingest_activity(terra_user_id, provider, data_list, db)
    elif payload_type == "body":
        _ingest_body(terra_user_id, provider, data_list, db)
    elif payload_type == "sleep":
        _ingest_sleep(terra_user_id, provider, data_list, db)
    elif payload_type == "event":
        _ingest_events(terra_user_id, provider, data_list, db)


def _parse_date(iso_str: str):
    return datetime.fromisoformat(iso_str.rstrip("Z")).date()


def _ingest_activity(
    terra_user_id: str, provider: str, data_list: list, db: Session
) -> None:
    for item in data_list:
        start_str = item.get("metadata", {}).get("start_time", "")
        if not start_str:
            continue
        day = _parse_date(start_str)

        steps_data = item.get("steps_data", {}) or {}
        active_data = item.get("active_durations_data", {}) or {}
        movement_data = item.get("movement_data", {}) or {}
        distance_data = item.get("distance_data", {}) or {}
        device_data = item.get("device_data", {}) or {}

        wear_minutes = None
        wear_sec = device_data.get("num_on_wrist_seconds")
        if wear_sec is not None:
            wear_minutes = int(wear_sec / 60)

        active_sec = active_data.get("activity_seconds")
        sedentary_sec = active_data.get("rest_seconds")

        row = db.get(WearableActivity, (terra_user_id, day))
        if row is None:
            row = WearableActivity(terra_user_id=terra_user_id, date=day)
            db.add(row)

        row.steps = steps_data.get("steps")
        row.active_minutes = int(active_sec / 60) if active_sec is not None else None
        row.sedentary_minutes = int(sedentary_sec / 60) if sedentary_sec is not None else None
        row.walking_cadence_avg = movement_data.get("cadence_avg")
        row.distance_m = distance_data.get("distance_meters")
        row.wear_minutes = wear_minutes
        row.source_device = provider

    db.commit()


def _ingest_body(
    terra_user_id: str, provider: str, data_list: list, db: Session
) -> None:
    for item in data_list:
        start_str = item.get("metadata", {}).get("start_time", "")
        if not start_str:
            continue
        day = _parse_date(start_str)

        heart = item.get("heart_data", {}) or {}
        hr_data = heart.get("heart_rate_data", {}) or {}
        hr_summary = hr_data.get("summary", {}) or {}
        hrv_summary = (heart.get("hrv", {}) or {}).get("summary", {}) or {}
        oxy = item.get("oxygen_data", {}) or {}

        row = db.get(WearableBody, (terra_user_id, day))
        if row is None:
            row = WearableBody(terra_user_id=terra_user_id, date=day)
            db.add(row)

        row.hr_resting = hr_summary.get("resting_hr_bpm")
        row.hr_avg = hr_summary.get("avg_hr_bpm")
        row.hrv_rmssd = hrv_summary.get("rmssd_ms")
        row.spo2_avg = oxy.get("avg_saturation_percentage")
        row.source_device = provider

    db.commit()


def _ingest_sleep(
    terra_user_id: str, provider: str, data_list: list, db: Session
) -> None:
    for item in data_list:
        start_str = item.get("metadata", {}).get("start_time", "")
        if not start_str:
            continue
        day = _parse_date(start_str)

        durations = item.get("sleep_durations_data", {}) or {}
        asleep = durations.get("asleep", {}) or {}
        stages = durations.get("stages", {}) or {}
        efficiency = durations.get("sleep_efficiency")

        total_sec = asleep.get("duration_asleep_state_seconds")
        deep_sec = stages.get("deep_sleep_duration_seconds")
        rem_sec = stages.get("rem_sleep_duration_seconds")
        awake_sec = stages.get("awake_duration_seconds")

        row = db.get(WearableSleep, (terra_user_id, day))
        if row is None:
            row = WearableSleep(terra_user_id=terra_user_id, date=day)
            db.add(row)

        row.total_minutes = int(total_sec / 60) if total_sec is not None else None
        row.deep_minutes = int(deep_sec / 60) if deep_sec is not None else None
        row.rem_minutes = int(rem_sec / 60) if rem_sec is not None else None
        row.awake_minutes = int(awake_sec / 60) if awake_sec is not None else None
        row.efficiency_pct = efficiency * 100 if efficiency is not None else None
        row.source_device = provider

    db.commit()


def _ingest_events(
    terra_user_id: str, provider: str, data_list: list, db: Session
) -> None:
    known_types = {"fall_detected", "high_hr", "low_spo2"}
    for item in data_list:
        event_type = item.get("type", "")
        if event_type not in known_types:
            continue
        ts_str = item.get("timestamp", "")
        if not ts_str:
            continue
        occurred_at = datetime.fromisoformat(ts_str.rstrip("Z")).replace(
            tzinfo=timezone.utc
        )
        event = WearableEvent(
            id=str(uuid.uuid4()),
            terra_user_id=terra_user_id,
            occurred_at=occurred_at,
            event_type=event_type,
            payload_json=item,
            source_device=provider,
        )
        db.add(event)

    db.commit()
