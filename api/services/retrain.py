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

    def check_and_trigger(self, session_count: int, background_tasks) -> None:
        """Queue retrain job via BackgroundTasks if threshold exceeded.

        Returns immediately; the subprocess runs after the HTTP response is sent.
        Safe to call on every session creation.
        """
        state = self._read_state()
        last_count = state.get("last_retrain_session_count", 0)
        delta = session_count - last_count

        if delta < self._threshold:
            return

        logger.info(
            "Retrain threshold reached (delta=%d >= %d) — queuing background retrain",
            delta, self._threshold,
        )
        background_tasks.add_task(self._spawn_retrain_subprocess)

    def _spawn_retrain_subprocess(self) -> None:
        """Run the retrain script in-process after the HTTP response completes."""
        try:
            python = sys.executable
            env = os.environ.copy()
            env["PYTHONPATH"] = str(_ROOT / "src") + os.pathsep + str(_ROOT / "api")
            result = subprocess.run(
                [python, str(_RETRAIN_SCRIPT)],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if result.returncode != 0:
                logger.error("Retrain script exited with non-zero code %d", result.returncode)
            else:
                logger.info("Retrain script completed successfully")
        except Exception as exc:
            logger.error("Failed to spawn retrain subprocess: %s", exc)
