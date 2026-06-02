"""Unit tests for RAISE data ingestion mapper — no DB required."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

# Module names starting with a digit can't be imported normally — load via spec.
_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "16_ingest_raise_data.py"


def _m():
    """Load the ingestion module fresh (avoids digit-prefix import issue)."""
    spec = importlib.util.spec_from_file_location("ingest_raise", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── age_band ─────────────────────────────────────────────────────────────────

def test_age_band_under_50():
    assert _m()._age_band(45) == "<50"

def test_age_band_50s():
    assert _m()._age_band(55) == "50-59"

def test_age_band_60s():
    assert _m()._age_band(65) == "60-69"

def test_age_band_70s():
    assert _m()._age_band(74) == "70-79"

def test_age_band_80_plus():
    assert _m()._age_band(84) == "80+"


# ── _parse_tags ───────────────────────────────────────────────────────────────

def test_parse_tags_stroke_diabetes():
    flags = _m()._parse_tags("Stroke, Diabetes, Shoulder pain")
    assert flags["has_stroke"] is True
    assert flags["has_diabetes"] is True
    assert flags["has_shoulder_issue"] is True
    assert flags["has_oa"] is False

def test_parse_tags_oa_hypertension():
    flags = _m()._parse_tags("OA Knees, Hypertension, Back Pain")
    assert flags["has_oa"] is True
    assert flags["has_hypertension"] is True
    assert flags["has_spinal_issue"] is True
    assert flags["has_stroke"] is False

def test_parse_tags_empty():
    flags = _m()._parse_tags("")
    assert flags["has_stroke"] is False
    assert flags["has_oa"] is False

def test_parse_tags_none():
    flags = _m()._parse_tags(None)
    assert flags["has_stroke"] is False

def test_parse_tags_numbness_maps_to_neuropathy():
    flags = _m()._parse_tags("Numbness, Cramps")
    assert flags["has_neuropathy"] is True

def test_parse_tags_parkinson_maps_neurological():
    flags = _m()._parse_tags("Parkinsons disease")
    assert flags["has_parkinsons"] is True
    assert flags["has_neurological"] is True
    assert flags["grp_neurological"] is True

def test_parse_tags_grp_balance_falls_always_true():
    flags = _m()._parse_tags("General fitness")
    assert flags["grp_balance_falls"] is True


# ── _to_float / _to_int ───────────────────────────────────────────────────────

def test_to_float_numeric():
    assert _m()._to_float(12.5) == 12.5

def test_to_float_string_number():
    assert _m()._to_float("14.3") == 14.3

def test_to_float_none_returns_none():
    assert _m()._to_float(None) is None

def test_to_float_text_returns_none():
    assert _m()._to_float("NA") is None

def test_to_int_returns_int():
    assert _m()._to_int(7.0) == 7

def test_to_int_none_returns_none():
    assert _m()._to_int(None) is None
