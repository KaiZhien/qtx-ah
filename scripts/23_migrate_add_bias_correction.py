"""Migration 23 — add bias_correction NUMERIC column to session_predictions."""
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

from sqlalchemy import create_engine, text
import os

DB_URL = os.environ.get("DATABASE_URL", "postgresql+psycopg2://qtx:secret@localhost:5432/qtxah")

def main():
    engine = create_engine(DB_URL)
    with engine.begin() as conn:
        conn.execute(text("""
            ALTER TABLE session_predictions
            ADD COLUMN IF NOT EXISTS bias_correction NUMERIC(7,4)
        """))
    print("Migration 23 complete — bias_correction column added.")

if __name__ == "__main__":
    main()
