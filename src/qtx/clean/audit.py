"""Build and persist the cleaning audit trail to data/audit/.

Collects cell-level change records produced by normalise and plausibility
steps, attaches timestamps and rule labels, and writes a CSV audit log
alongside a summary Parquet for downstream reporting.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

from qtx.utils.config import get_project_root
from qtx.utils.logging import get_logger

log = get_logger(__name__)

_DEFAULT_AUDIT_PATH = Path("data/audit/clean_audit.csv")
_COLUMNS = ["record_id", "module", "field", "before", "after", "reason"]


class AuditLog:
    """Accumulates cleaning audit rows and writes to data/audit/clean_audit.csv."""

    def __init__(self) -> None:
        self._rows: list[dict[str, Any]] = []

    def log(
        self,
        record_id: str,
        module: str,
        field: str,
        before: Any,
        after: Any,
        reason: str,
    ) -> None:
        """Append one audit row."""
        self._rows.append(
            {
                "record_id": record_id,
                "module": module,
                "field": field,
                "before": before,
                "after": after,
                "reason": reason,
            }
        )

    def save(self, path: Path | str | None = None) -> Path:
        """Write accumulated rows to CSV. Default path: data/audit/clean_audit.csv."""
        if path is None:
            resolved = get_project_root() / _DEFAULT_AUDIT_PATH
        else:
            resolved = Path(path)

        resolved.parent.mkdir(parents=True, exist_ok=True)

        with resolved.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=_COLUMNS)
            writer.writeheader()
            writer.writerows(self._rows)

        log.info("Audit log: %d rows written to %s", len(self._rows), resolved)
        return resolved

    def __len__(self) -> int:
        """Return number of logged rows."""
        return len(self._rows)
