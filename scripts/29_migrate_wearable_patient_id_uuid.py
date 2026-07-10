"""Migration 29 — convert wearable_enrollments.patient_id from VARCHAR to UUID
with a foreign key to patients(id).

The column previously stored str(patients.id) and was joined via string
casting. This migration:
  1. aborts (exit 1) if any existing patient_id is not a syntactically valid
     UUID, or does not match a patients.id row — such junk must be fixed or
     deleted by hand first (it is clinical consent data; never auto-drop it);
  2. ALTER COLUMN ... TYPE uuid USING patient_id::uuid, SET NOT NULL;
  3. adds fk_wearable_enrollments_patient_id (ON DELETE CASCADE).

Idempotent — skips steps that were already applied.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import text
from db import _get_engine

_UUID_RE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"


def main() -> None:
    print("Running migration 29 ...")

    engine = _get_engine()

    with engine.connect() as conn:
        current_type = conn.execute(text(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_name = 'wearable_enrollments' AND column_name = 'patient_id'"
        )).scalar()

        if current_type is None:
            print("  wearable_enrollments.patient_id not found — nothing to do.")
            return

        if current_type != "uuid":
            # Guard 1: non-UUID junk values.
            bad = conn.execute(text(
                "SELECT id, patient_id FROM wearable_enrollments "
                f"WHERE patient_id IS NULL OR patient_id !~ '{_UUID_RE}'"
            )).fetchall()
            if bad:
                print("  ABORT — non-UUID patient_id values found; fix these rows first:")
                for row in bad:
                    print(f"    enrollment id={row[0]!r} patient_id={row[1]!r}")
                sys.exit(1)

            # Guard 2: orphans that would violate the new FK.
            orphans = conn.execute(text(
                "SELECT e.id, e.patient_id FROM wearable_enrollments e "
                "LEFT JOIN patients p ON p.id = e.patient_id::uuid "
                "WHERE p.id IS NULL"
            )).fetchall()
            if orphans:
                print("  ABORT — enrollments referencing missing patients; fix these rows first:")
                for row in orphans:
                    print(f"    enrollment id={row[0]!r} patient_id={row[1]!r}")
                sys.exit(1)

            conn.execute(text(
                "ALTER TABLE wearable_enrollments "
                "ALTER COLUMN patient_id TYPE uuid USING patient_id::uuid"
            ))
            conn.execute(text(
                "ALTER TABLE wearable_enrollments ALTER COLUMN patient_id SET NOT NULL"
            ))
            conn.commit()
            print("  wearable_enrollments.patient_id: VARCHAR -> UUID NOT NULL: OK")
        else:
            print("  wearable_enrollments.patient_id already uuid: skipped")

        fk_exists = conn.execute(text(
            "SELECT 1 FROM pg_constraint "
            "WHERE conname = 'fk_wearable_enrollments_patient_id'"
        )).scalar()
        if not fk_exists:
            conn.execute(text(
                "ALTER TABLE wearable_enrollments "
                "ADD CONSTRAINT fk_wearable_enrollments_patient_id "
                "FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE"
            ))
            conn.commit()
            print("  fk_wearable_enrollments_patient_id (ON DELETE CASCADE): OK")
        else:
            print("  fk_wearable_enrollments_patient_id already present: skipped")

    print("Migration 29 complete.")


if __name__ == "__main__":
    main()
