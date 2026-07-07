"""Load and merge YAML config files into a unified settings object.

Provides typed access to all config/ YAML files. Configs are cached
after first read so disk I/O only happens once per process.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

# ---------------------------------------------------------------------------
# Project root discovery
# ---------------------------------------------------------------------------

def get_project_root() -> Path:
    """Return the project root (directory containing pyproject.toml).

    Walks upward from this file until pyproject.toml is found.
    Raises RuntimeError if not found.
    """
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "pyproject.toml").exists():
            return parent
    raise RuntimeError(
        f"Could not find pyproject.toml starting from {current}. "
        "Is the package installed inside the project tree?"
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_cache: dict[str, Any] = {}


def _load_yaml(filename: str) -> dict[str, Any]:
    """Load a YAML file from config/ by filename, with caching."""
    if filename in _cache:
        return _cache[filename]

    config_path = get_project_root() / "config" / filename
    if not config_path.exists():
        raise FileNotFoundError(
            f"Config file not found: {config_path}. "
            f"Expected it at {config_path.resolve()}"
        )
    with config_path.open("r", encoding="utf-8") as fh:
        data: dict[str, Any] = yaml.safe_load(fh) or {}
    _cache[filename] = data
    return data


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

def get_settings() -> dict[str, Any]:
    """Load and return config/settings.yaml."""
    return _load_yaml("settings.yaml")


def get_cleaning_config() -> dict[str, Any]:
    """Load and return config/cleaning.yaml."""
    return _load_yaml("cleaning.yaml")


def get_phenotypes_config() -> dict[str, Any]:
    """Load and return config/phenotypes.yaml."""
    return _load_yaml("phenotypes.yaml")


def get_outcomes_config() -> dict[str, Any]:
    """Load and return config/outcomes.yaml."""
    return _load_yaml("outcomes.yaml")


def get_missingness_config() -> dict[str, Any]:
    """Load and return config/missingness.yaml."""
    return _load_yaml("missingness.yaml")


def get_models_config() -> dict[str, Any]:
    """Load and return config/models.yaml."""
    return _load_yaml("models.yaml")


def get_dosage_config() -> dict[str, Any]:
    """Load and return config/dosage.yaml."""
    return _load_yaml("dosage.yaml")


def get_path(key: str) -> Path:
    """Resolve a path key from the 'paths' section of settings.yaml.

    The returned Path is absolute (resolved relative to project root).

    Args:
        key: A key present in the ``paths`` block of settings.yaml
             (e.g. ``"processed"``, ``"raw_excel"``).

    Raises:
        KeyError: If the key is not found in the paths section.
        FileNotFoundError: If settings.yaml is missing.
    """
    settings = get_settings()
    paths_section: dict[str, str] = settings.get("paths", {})
    if key not in paths_section:
        available = ", ".join(paths_section.keys())
        raise KeyError(
            f"Path key {key!r} not found in settings.yaml paths section. "
            f"Available keys: {available}"
        )
    return get_project_root() / paths_section[key]
