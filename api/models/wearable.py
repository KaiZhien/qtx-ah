"""SQLAlchemy ORM models for wearable data storage."""
from __future__ import annotations

from datetime import date, datetime
from sqlalchemy import String, Float, Integer, Boolean, DateTime, Date, JSON
from sqlalchemy.orm import Mapped, mapped_column
from api.db import Base


class WearableEnrollment(Base):
    __tablename__ = "wearable_enrollments"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    patient_id: Mapped[str] = mapped_column(String, index=True)
    terra_user_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    device_brand: Mapped[str] = mapped_column(String)
    enrolled_at: Mapped[datetime] = mapped_column(DateTime)
    enrolled_by: Mapped[str] = mapped_column(String)
    consent_given_at: Mapped[datetime] = mapped_column(DateTime)
    consent_withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class WearableActivity(Base):
    __tablename__ = "wearable_activity"

    terra_user_id: Mapped[str] = mapped_column(String, primary_key=True)
    date: Mapped[date] = mapped_column(Date, primary_key=True)
    steps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    active_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sedentary_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    walking_cadence_avg: Mapped[float | None] = mapped_column(Float, nullable=True)
    distance_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    wear_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_device: Mapped[str | None] = mapped_column(String, nullable=True)


class WearableBody(Base):
    __tablename__ = "wearable_body"

    terra_user_id: Mapped[str] = mapped_column(String, primary_key=True)
    date: Mapped[date] = mapped_column(Date, primary_key=True)
    hr_resting: Mapped[float | None] = mapped_column(Float, nullable=True)
    hr_avg: Mapped[float | None] = mapped_column(Float, nullable=True)
    hrv_rmssd: Mapped[float | None] = mapped_column(Float, nullable=True)
    spo2_avg: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_device: Mapped[str | None] = mapped_column(String, nullable=True)


class WearableSleep(Base):
    __tablename__ = "wearable_sleep"

    terra_user_id: Mapped[str] = mapped_column(String, primary_key=True)
    date: Mapped[date] = mapped_column(Date, primary_key=True)
    total_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    deep_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rem_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    awake_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    efficiency_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_device: Mapped[str | None] = mapped_column(String, nullable=True)


class WearableEvent(Base):
    __tablename__ = "wearable_events"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    terra_user_id: Mapped[str] = mapped_column(String, index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    event_type: Mapped[str] = mapped_column(String)
    payload_json: Mapped[dict] = mapped_column(JSON)
    source_device: Mapped[str | None] = mapped_column(String, nullable=True)
