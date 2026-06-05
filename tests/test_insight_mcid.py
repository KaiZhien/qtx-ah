"""Unit tests asserting MCID clinical thresholds are present in _SYSTEM_PROMPT."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'api'))

from services.insight import _SYSTEM_PROMPT


def test_tug_mcid_present():
    assert "3.5" in _SYSTEM_PROMPT, "TUG MCID (3.5 s) not found in _SYSTEM_PROMPT"


def test_tug_fall_risk_threshold_present():
    assert "12" in _SYSTEM_PROMPT, "TUG fall-risk threshold (12 s) not found in _SYSTEM_PROMPT"


def test_5xsts_mcid_present():
    assert "2.3" in _SYSTEM_PROMPT, "5xSTS MCID (2.3 s) not found in _SYSTEM_PROMPT"


def test_gait_speed_frailty_threshold_present():
    assert "0.6" in _SYSTEM_PROMPT, "Gait speed frailty threshold (0.6 m/s) not found in _SYSTEM_PROMPT"


def test_vas_pain_mcid_lower_bound_present():
    assert "1.5" in _SYSTEM_PROMPT, "VAS pain MCID lower bound (1.5) not found in _SYSTEM_PROMPT"


def test_sppb_mcid_present():
    # SPPB MCID = 1 point — check it appears alongside "SPPB"
    assert "SPPB" in _SYSTEM_PROMPT, "SPPB label not found in _SYSTEM_PROMPT"
    sppb_idx = _SYSTEM_PROMPT.index("SPPB")
    sppb_context = _SYSTEM_PROMPT[sppb_idx:sppb_idx + 20]
    assert "1" in sppb_context, f"SPPB MCID (1 point) not found near 'SPPB' in: {sppb_context!r}"
