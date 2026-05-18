"""Configure Rich-based structured logging for the QTX pipeline.

Provides get_logger(name) that returns a logger with a RichHandler,
honouring the LOG_LEVEL env var and config/settings.yaml logging.level.
All pipeline scripts should call setup_logging() as their first action.
"""

from __future__ import annotations

import logging
import os

from rich.logging import RichHandler

# Sentinel so we only initialise once
_logging_configured = False


def setup_logging(level: str | None = None) -> None:
    """Initialise Rich logging for the entire process.

    Safe to call multiple times — duplicate handlers are never added.

    Priority order for log level:
      1. *level* argument passed directly
      2. ``LOG_LEVEL`` environment variable
      3. ``logging.level`` key in ``config/settings.yaml``
      4. ``"INFO"`` as hard default

    Args:
        level: Optional explicit log level string (e.g. ``"DEBUG"``).
    """
    global _logging_configured

    # Resolve the desired level string
    resolved_level = _resolve_level(level)
    numeric_level = getattr(logging, resolved_level.upper(), logging.INFO)

    root_logger = logging.getLogger()

    # Avoid adding a second RichHandler if already set up
    if _logging_configured:
        root_logger.setLevel(numeric_level)
        return

    handler = RichHandler(
        rich_tracebacks=True,
        show_path=False,
    )
    handler.setLevel(numeric_level)

    logging.basicConfig(
        level=numeric_level,
        format="%(message)s",
        datefmt="[%X]",
        handlers=[handler],
    )

    _logging_configured = True


def get_logger(name: str) -> logging.Logger:
    """Return a configured logger for the given module name.

    Calls :func:`setup_logging` lazily with defaults if it has not yet
    been called by the entry point.

    Args:
        name: Typically ``__name__`` of the calling module.

    Returns:
        A :class:`logging.Logger` instance ready to use.
    """
    if not _logging_configured:
        setup_logging()
    return logging.getLogger(name)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _resolve_level(explicit: str | None) -> str:
    """Return the log level string from available sources."""
    if explicit:
        return explicit

    env_level = os.environ.get("LOG_LEVEL")
    if env_level:
        return env_level

    # Lazy import to avoid circular dependency (config imports nothing from
    # logging; logging optionally reads config but falls back gracefully).
    try:
        from qtx.utils.config import get_settings  # noqa: PLC0415
        settings = get_settings()
        return settings.get("logging", {}).get("level", "INFO")
    except Exception:  # noqa: BLE001
        return "INFO"
