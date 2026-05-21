"""Patient list and detail endpoints."""
from __future__ import annotations

from typing import List, Optional, Any
import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query

import deps

router = APIRouter()


def _df_to_records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    """Convert DataFrame to list of dicts, replacing NaN/NA with None."""
    return [
        {k: (None if isinstance(v, float) and np.isnan(v) else v)
         for k, v in row.items()}
        for row in frame.to_dict(orient="records")
    ]


@router.get("/patients")
def list_patients(
    cohort: List[str] = Query(default=[]),
    usage: List[str] = Query(default=[]),
    age_band: List[str] = Query(default=[]),
    gender: List[str] = Query(default=[]),
    fu_only: bool = Query(default=False),
) -> list[dict[str, Any]]:
    """Return filtered patient records."""
    frame = deps.df.copy()

    if cohort:
        frame = frame[frame["cohort"].isin(cohort)]
    if usage:
        frame = frame[frame["usage_frequency"].isin(usage)]
    if age_band:
        frame = frame[frame["age_band"].isin(age_band)]
    if gender:
        frame = frame[frame["gender"].isin(gender)]
    if fu_only:
        frame = frame[frame["is_dropout"] != 1]

    return _df_to_records(frame)


@router.get("/patient/{sn}")
def get_patient(sn: str) -> dict[str, Any]:
    """Return a single patient record by sn."""
    # sn column is stored as strings like "1.0"
    match = deps.df[deps.df["sn"].astype(str) == sn]
    if match.empty:
        # Also try matching as float string e.g. "1" -> "1.0"
        try:
            sn_float_str = str(float(sn))
            match = deps.df[deps.df["sn"].astype(str) == sn_float_str]
        except (ValueError, TypeError):
            pass
    if match.empty:
        raise HTTPException(status_code=404, detail=f"Patient with sn={sn!r} not found")
    row = match.iloc[[0]]
    records = _df_to_records(row)
    return records[0]
