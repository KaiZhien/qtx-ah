"""Compile regex pattern lists from config/phenotypes.yaml into callable matchers.

Provides functions to build group, region, and flag matchers from the YAML
config so that classify.py can apply them consistently across both the
tags and pain_location text columns.
"""

from __future__ import annotations

import re
from typing import Any

from qtx.utils.config import get_phenotypes_config

# ---------------------------------------------------------------------------
# Module-level cache (patterns compiled once per process)
# ---------------------------------------------------------------------------

_rules_cache: dict[str, Any] | None = None


def _compile_pattern_list(patterns: list[str]) -> list[re.Pattern]:
    """Compile a list of regex pattern strings with IGNORECASE."""
    return [re.compile(p, re.IGNORECASE) for p in patterns]


def _compile_section(section: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert a YAML section (groups/regions/flags) into a list of compiled rule dicts."""
    compiled: list[dict[str, Any]] = []
    for key, spec in section.items():
        compiled.append(
            {
                "key": key,
                "label": spec.get("label", key),
                "patterns": _compile_pattern_list(spec.get("patterns", [])),
            }
        )
    return compiled


def load_rules() -> dict[str, Any]:
    """Load config/phenotypes.yaml and compile all regex patterns.

    Returns a dict with keys: 'groups', 'regions', 'flags', 'priority', 'cohort_rollup'

    Each entry under groups/regions/flags is a list of dicts with:
      - key: str (YAML key, e.g. "joint_disease")
      - label: str (human-readable label)
      - patterns: list[re.Pattern]  (compiled with re.IGNORECASE)

    'priority' is a list of group keys in priority order.
    'cohort_rollup' maps cohort label -> list of group keys.

    Caches result (patterns only compiled once per process).
    """
    global _rules_cache
    if _rules_cache is not None:
        return _rules_cache

    cfg = get_phenotypes_config()

    groups = _compile_section(cfg.get("groups", {}))
    regions = _compile_section(cfg.get("regions", {}))
    flags = _compile_section(cfg.get("flags", {}))

    priority: list[str] = cfg.get("priority", [])

    # cohort_rollup: cohort_label -> list[group_key]
    cohort_rollup: dict[str, list[str]] = cfg.get("cohort_rollup", {})

    _rules_cache = {
        "groups": groups,
        "regions": regions,
        "flags": flags,
        "priority": priority,
        "cohort_rollup": cohort_rollup,
    }
    return _rules_cache
