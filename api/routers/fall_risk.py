"""Fall risk prediction endpoint."""
from __future__ import annotations

from typing import Literal
from fastapi import APIRouter
import pandas as pd
from pydantic import BaseModel, field_validator

import deps

router = APIRouter()


class FallRiskRequest(BaseModel):
    # Patient self-report
    age: int
    gender: Literal["M", "F"]
    falls_history: int       # 0 | 1 | 2  (0=none, 1=one, 2=two or more)
    walking_aid: Literal["none", "stick", "frame"]
    exercise_frequency: Literal["rarely", "1-2", "3+"]
    has_oa: int              # 0 | 1
    has_diabetes: int        # 0 | 1
    has_stroke: int          # 0 | 1
    has_parkinsons: int      # 0 | 1
    has_heart_disease: int   # 0 | 1
    polypharmacy: int        # 0 | 1
    # Clinician fields (optional)
    pre_tug_s: float | None = None
    pre_5xsst_s: float | None = None
    pre_normal_gs_ms: float | None = None
    baseline_sppb: float | None = None
    pre_vas: float | None = None

    @field_validator("age")
    @classmethod
    def age_positive(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("age must be positive")
        return v


_FEATURE_META: dict[str, tuple[str, str, str]] = {
    "pre_tug_s":         ("Timed Up & Go speed",        "Slower TUG scores indicate reduced mobility and higher fall risk",                          "high"),
    "pre_normal_gs_ms":  ("Walking speed",               "Gait speed below 0.8 m/s is a key fall risk indicator",                                    "high"),
    "baseline_sppb":     ("Physical performance (SPPB)", "Low SPPB scores reflect reduced balance and leg strength",                                  "high"),
    "pre_5xsst_s":       ("Sit-to-stand time",           "Slower sit-to-stand reflects lower leg muscle strength",                                    "moderate"),
    "pre_vas":           ("Pain level",                  "Higher pain levels reduce mobility confidence and increase fall risk",                       "moderate"),
    "has_oa":            ("Osteoarthritis",               "Joint pain and reduced stability from OA elevate fall risk",                                "moderate"),
    "has_frailty":       ("Frailty",                     "Frailty is a major independent fall risk factor",                                           "high"),
    "has_stroke":        ("Stroke history",               "Stroke can impair balance and coordination",                                               "high"),
    "has_parkinsons":    ("Parkinson's disease",          "Parkinson's significantly increases fall risk through gait and balance changes",            "high"),
    "has_diabetes":      ("Diabetes",                    "Peripheral neuropathy from diabetes can impair proprioception and balance",                  "moderate"),
    "has_hypertension":  ("Hypertension",                "Antihypertensive medications can cause dizziness and orthostatic hypotension",              "moderate"),
    "age":               ("Age",                         "Fall risk increases with age due to reduced muscle strength and postural stability",         "moderate"),
}


def _build_feature_vector(req: FallRiskRequest, medians: dict) -> pd.DataFrame:
    row: dict[str, float] = {
        "age":              float(req.age),
        "gender_M":         1.0 if req.gender.upper() == "M" else 0.0,
        "has_oa":           float(req.has_oa),
        "has_diabetes":     float(req.has_diabetes),
        "has_stroke":       float(req.has_stroke),
        "has_parkinsons":   float(req.has_parkinsons),
        "has_frailty":      1.0 if req.walking_aid == "frame" else 0.0,
        "has_hypertension": float(req.has_heart_disease),  # proxy: heart_disease → hypertension (closest training feature)
        "pre_tug_s":        req.pre_tug_s   if req.pre_tug_s   is not None else medians.get("pre_tug_s",   12.0),
        "pre_5xsst_s":      req.pre_5xsst_s if req.pre_5xsst_s is not None else medians.get("pre_5xsst_s", 15.0),
        "pre_normal_gs_ms": req.pre_normal_gs_ms if req.pre_normal_gs_ms is not None else medians.get("pre_normal_gs_ms", 0.85),
        "baseline_sppb":    req.baseline_sppb    if req.baseline_sppb    is not None else medians.get("baseline_sppb",    8.0),
        "pre_vas":          req.pre_vas          if req.pre_vas          is not None else medians.get("pre_vas",           4.0),
    }
    model = deps.models["fall_risk"]
    feature_names = list(model.feature_names_in_)
    present = {k: v for k, v in row.items() if k in feature_names}
    for feat in feature_names:
        if feat not in present:
            present[feat] = medians.get(feat, 0.0)
    return pd.DataFrame([present], columns=feature_names)


def _adjust_score(base_proba: float, req: FallRiskRequest) -> float:
    score = base_proba * 100
    score += req.falls_history * 7        # +7 per prior fall
    if req.walking_aid == "stick":
        score += 5
    elif req.walking_aid == "frame":
        score += 12
    if req.exercise_frequency == "3+":
        score -= 6
    elif req.exercise_frequency == "rarely":
        score += 4
    if req.polypharmacy:
        score += 5
    return float(max(0.0, min(100.0, score)))


def _risk_label(score: float) -> str:
    if score < 30:  return "low"
    if score < 50:  return "moderate"
    if score < 70:  return "elevated"
    return "high"


def _top_factors(req: FallRiskRequest, provided: set[str]) -> list[dict]:
    factors: list[dict] = []

    # Patient-reported factors first (not in model)
    if req.falls_history >= 1:
        n = "1" if req.falls_history == 1 else "2+"
        factors.append({
            "label": "Previous fall history",
            "impact": "high",
            "explanation": f"{n} fall(s) in the past 12 months significantly increases recurrence risk",
        })
    if req.walking_aid == "frame":
        factors.append({
            "label": "Walking frame required",
            "impact": "high",
            "explanation": "Requiring a walking frame indicates significant mobility impairment and balance difficulty",
        })
    elif req.walking_aid == "stick":
        factors.append({
            "label": "Walking stick required",
            "impact": "moderate",
            "explanation": "Use of a walking stick indicates existing balance or lower-limb challenges",
        })
    if req.polypharmacy:
        factors.append({
            "label": "Multiple medications (4+)",
            "impact": "moderate",
            "explanation": "Taking 4+ medications daily increases fall risk through dizziness and balance side effects",
        })

    # Model-based factors from feature importances
    model = deps.models["fall_risk"]
    feature_names = list(model.feature_names_in_)
    importances = model.feature_importances_
    ranked = sorted(zip(feature_names, importances), key=lambda x: -x[1])

    for feat, imp in ranked:
        if len(factors) >= 4:
            break
        if feat not in _FEATURE_META:
            continue
        if feat in provided or imp > 0.08:
            label, explanation, impact = _FEATURE_META[feat]
            factors.append({"label": label, "impact": impact, "explanation": explanation})

    return factors[:4]


def _cohort_stat(age: int, gender: str) -> dict:
    df = deps.df
    cohort = df[(df["age"] >= age - 8) & (df["age"] <= age + 8) & (df["gender"] == gender)]
    if len(cohort) < 10:
        cohort = df[(df["age"] >= age - 15) & (df["age"] <= age + 15)]
    responders = cohort[cohort["overall_responder"].notna()] if "overall_responder" in cohort.columns else pd.DataFrame()
    if len(responders) == 0:
        return {"improvement_pct": 45, "cohort_size": len(cohort)}
    pct = int((responders["overall_responder"] == 1).mean() * 100)
    return {"improvement_pct": pct, "cohort_size": len(cohort)}


@router.post("/predict/fall-risk")
def predict_fall_risk(req: FallRiskRequest) -> dict:
    model = deps.models["fall_risk"]
    medians = deps.models["fall_risk_medians"]

    provided: set[str] = {
        f for f in ("pre_tug_s", "pre_5xsst_s", "pre_normal_gs_ms", "baseline_sppb", "pre_vas")
        if getattr(req, f) is not None
    }
    has_clinician_data = len(provided) >= 2

    X = _build_feature_vector(req, medians)
    base_proba = float(model.predict_proba(X)[0][1])
    risk_score = int(round(_adjust_score(base_proba, req)))

    return {
        "risk_score":   risk_score,
        "risk_label":   _risk_label(risk_score),
        "confidence":   "high" if has_clinician_data else "standard",
        "top_factors":  _top_factors(req, provided),
        "cohort_stat":  _cohort_stat(req.age, req.gender.upper()),
    }
