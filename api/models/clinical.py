"""SQLAlchemy ORM models for clinical patient data."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean, Date, DateTime, Numeric, SmallInteger,
    String, Text, UniqueConstraint, ForeignKey,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from db import Base


class Patient(Base):
    __tablename__ = "patients"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sn: Mapped[str] = mapped_column(String(20), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    gender: Mapped[str | None] = mapped_column(String(1), nullable=True)
    age: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    age_band: Mapped[str | None] = mapped_column(String(10), nullable=True)
    phone_number: Mapped[str | None] = mapped_column(String(30), nullable=True)
    tags: Mapped[str | None] = mapped_column(Text, nullable=True)
    primary_indication: Mapped[str | None] = mapped_column(Text, nullable=True)
    cohort: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    record_type: Mapped[str] = mapped_column(String(10), nullable=False, index=True)

    # Phenotype flags
    has_oa: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_diabetes: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_stroke: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_parkinsons: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_sarcopenia: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_frailty: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_balance_issue: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_post_surgery: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_chronic_pain: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_neuropathy: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_cancer: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_cardiovascular: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_hypertension: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_osteoporosis: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_spinal_issue: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_knee_issue: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_hip_issue: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_shoulder_issue: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_neurological: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_fracture: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_autoimmune: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_metabolic: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_wellness_only: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_fall_risk: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Cohort group flags
    grp_joint_disease: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_spine_back: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_neurological: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_post_surgical: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_frailty_sarcopenia: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_balance_falls: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_metabolic: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_cardiovascular: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_oncology: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_autoimmune: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_softtissue_injury: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_generalised_pain: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_osteoporosis: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    grp_wellness: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Body region flags
    rgn_knee: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    rgn_hip: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    rgn_spine: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    rgn_shoulder: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    rgn_ankle_foot: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    rgn_lower_limb: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    rgn_upper_limb: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    rgn_bilateral: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    rgn_trunk: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class Session(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        UniqueConstraint("patient_id", "session_number", name="uq_sessions_patient_session_number"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    patient_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("patients.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    session_number: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    session_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    usage_frequency: Mapped[str | None] = mapped_column(String(60), nullable=True)
    has_followup: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    joined_with_pain: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    pain_improved: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    pain_location: Mapped[str | None] = mapped_column(String(200), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # VAS
    pre_vas: Mapped[float | None] = mapped_column(Numeric(5, 1), nullable=True)
    post_vas: Mapped[float | None] = mapped_column(Numeric(5, 1), nullable=True)
    vas_change: Mapped[float | None] = mapped_column(Numeric(5, 1), nullable=True)

    # TUG
    pre_tug_s: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    post_tug_s: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    tug_change_s: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    tug_change_pct: Mapped[float | None] = mapped_column(Numeric(7, 4), nullable=True)

    # 5xSST
    pre_5xsst_s: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    post_5xsst_s: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    sst_change_s: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    sst_change_pct: Mapped[float | None] = mapped_column(Numeric(7, 4), nullable=True)

    # Normal gait
    pre_normal_time_s: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    post_normal_time_s: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    pre_normal_gs_ms: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    post_normal_gs_ms: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    normal_gs_change_ms: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    normal_gs_change_pct: Mapped[float | None] = mapped_column(Numeric(7, 4), nullable=True)

    # Fast gait
    pre_fast_time_s: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    post_fast_time_s: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    pre_fast_gs_ms: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    post_fast_gs_ms: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    fast_gs_change_ms: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    fast_gs_change_pct: Mapped[float | None] = mapped_column(Numeric(7, 4), nullable=True)

    # SPPB
    baseline_sppb: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    post_sppb: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    sppb_change: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    sppb_source: Mapped[str | None] = mapped_column(String(50), nullable=True)

    # Outcomes
    n_pre_post_pairs: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    composite_improvement: Mapped[float | None] = mapped_column(Numeric(7, 4), nullable=True)
    overall_responder: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    breadth_of_response: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    is_dropout: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)

    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    ingested_from: Mapped[str | None] = mapped_column(String(200), nullable=True)


class PatientCondition(Base):
    __tablename__ = "patient_conditions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    patient_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("patients.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    condition_group: Mapped[str] = mapped_column(String(50), nullable=False)
    condition_label: Mapped[str] = mapped_column(String(100), nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="tag_regex")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class PatientTrend(Base):
    __tablename__ = "patient_trends"
    __table_args__ = (
        UniqueConstraint("patient_id", "metric", name="uq_patient_trends_patient_metric"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    patient_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("patients.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    metric: Mapped[str] = mapped_column(String(50), nullable=False)
    direction: Mapped[str] = mapped_column(String(20), nullable=False)
    sessions_used: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    magnitude: Mapped[float | None] = mapped_column(Numeric(8, 3), nullable=True)
    first_value: Mapped[float | None] = mapped_column(Numeric(8, 3), nullable=True)
    last_value: Mapped[float | None] = mapped_column(Numeric(8, 3), nullable=True)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
