"""Migration 15 — add pre_tandem_s to patients, post_tandem_s to sessions."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import text
from db import _get_engine


def main() -> None:
    print("Running migration 15 ...")
    engine = _get_engine()

    with engine.connect() as conn:
        conn.execute(text(
            "ALTER TABLE patients ADD COLUMN IF NOT EXISTS pre_tandem_s NUMERIC(7,2)"
        ))
        conn.commit()
        print("  patients.pre_tandem_s: OK")

        conn.execute(text(
            "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS post_tandem_s NUMERIC(7,2)"
        ))
        conn.commit()
        print("  sessions.post_tandem_s: OK")

    print("Migration 15 complete.")


if __name__ == "__main__":
    main()
