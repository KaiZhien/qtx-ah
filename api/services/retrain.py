# api/services/retrain.py
"""RetrainService — check session count threshold and spawn background retrain job."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parent.parent.parent
_RETRAIN_SCRIPT = _ROOT / "scripts" / "18_scheduled_retrain.py"
_DEFAULT_STATE_PATH = _ROOT / "retrain_state.json"
_DEFAULT_THRESHOLD = int(os.environ.get("RETRAIN_THRESHOLD", "50"))
_LOG_DIR = Path(os.environ.get("QTX_RETRAIN_LOG_DIR", str(_ROOT / "logs")))


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
        """Run the retrain script in-process after the HTTP response completes.

        stdout/stderr are captured to a timestamped log file under the logs/ dir
        (QTX_RETRAIN_LOG_DIR) rather than discarded, and the log path + exit code
        are logged so failed retrains are diagnosable.
        """
        log_path: Path | None = None
        try:
            python = sys.executable
            env = os.environ.copy()
            env["PYTHONPATH"] = str(_ROOT / "src") + os.pathsep + str(_ROOT / "api")

            _LOG_DIR.mkdir(parents=True, exist_ok=True)
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            log_path = _LOG_DIR / f"retrain_{ts}.log"

            with open(log_path, "w") as log_file:
                result = subprocess.run(
                    [python, str(_RETRAIN_SCRIPT)],
                    env=env,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                )
            if result.returncode != 0:
                logger.error(
                    "Retrain script exited with non-zero code %d — log: %s",
                    result.returncode, log_path,
                )
            else:
                logger.info("Retrain script completed successfully — log: %s", log_path)
        except Exception as exc:
            logger.error("Failed to spawn retrain subprocess (log: %s): %s", log_path, exc)
