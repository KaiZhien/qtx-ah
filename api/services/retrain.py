# api/services/retrain.py
"""RetrainService — check session count threshold and spawn background retrain job."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parent.parent.parent
_RETRAIN_SCRIPT = _ROOT / "scripts" / "18_scheduled_retrain.py"
_DEFAULT_STATE_PATH = _ROOT / "retrain_state.json"
_DEFAULT_THRESHOLD = int(os.environ.get("RETRAIN_THRESHOLD", "50"))


class RetrainService:
    def __init__(
        self,
        state_path: Path = _DEFAULT_STATE_PATH,
        threshold: int = _DEFAULT_THRESHOLD,
    ) -> None:
        self._state_path = state_path
        self._threshold = threshold

    def _read_state(self) -> dict:
        if not self._state_path.exists():
            return {"last_retrain_session_count": 0}
        try:
            return json.loads(self._state_path.read_text())
        except Exception:
            return {"last_retrain_session_count": 0}

    def check_and_trigger(self, session_count: int) -> None:
        """Spawn retrain job as background subprocess if threshold exceeded.

        Non-blocking — returns immediately. Safe to call on every session creation.
        """
        state = self._read_state()
        last_count = state.get("last_retrain_session_count", 0)
        delta = session_count - last_count

        if delta < self._threshold:
            return

        logger.info(
            "Retrain threshold reached (delta=%d >= %d) — spawning background retrain",
            delta, self._threshold,
        )
        try:
            python = sys.executable
            env = os.environ.copy()
            env["PYTHONPATH"] = str(_ROOT / "src") + os.pathsep + str(_ROOT / "api")
            subprocess.Popen(
                [python, str(_RETRAIN_SCRIPT)],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as exc:
            logger.warning("Failed to spawn retrain subprocess: %s", exc)
