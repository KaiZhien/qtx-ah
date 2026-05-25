"""Import endpoints: seed from local parquet or accept CSV/Excel upload."""
from __future__ import annotations

import io
import sys
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session

from db import get_db
from services.ingest import IngestPipeline, IngestSummary

router = APIRouter()

_PARQUET_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "processed" / "dashboard_data.parquet"
_MAX_FILE_BYTES = 50 * 1024 * 1024  # 50 MB
_ACCEPTED_EXTENSIONS = {".csv", ".xlsx", ".xls"}

# Add src/ to path so qtx pipeline modules are importable when running via uvicorn
_SRC = Path(__file__).resolve().parent.parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))


def _run_upsert(df: pd.DataFrame, db: Session, source: str) -> dict:
    """Run IngestPipeline and return a JSON-serialisable summary dict."""
    pipeline = IngestPipeline(db, source_filename=source)
    try:
        summary = pipeline.upsert(df)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Batch rolled back: {exc}") from exc

    return {
        "inserted": summary.inserted,
        "updated": summary.updated,
        "skipped": summary.skipped,
        "error_count": len(summary.errors),
        "errors": [{"row_index": e.row_index, "sn": e.sn, "reason": e.reason} for e in summary.errors],
    }


@router.post("/import/seed")
def seed_from_parquet(db: Session = Depends(get_db)) -> dict:
    """Seed the database from the local dashboard_data.parquet.

    Safe to call multiple times (upserts). Intended for initial migration
    and disaster-recovery re-seeding. Protected by X-Api-Key middleware.
    """
    if not _PARQUET_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Parquet file not found at {_PARQUET_PATH}. Run scripts 01–07 first.",
        )
    df = pd.read_parquet(_PARQUET_PATH)
    return _run_upsert(df, db, source=_PARQUET_PATH.name)


@router.post("/import/file")
async def import_file(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> dict:
    """Accept a CSV or Excel file upload and ingest it into the database.

    The file must be in the raw clinic Excel format (same as the source
    workbook). It is run through the src/qtx processing pipeline in-memory
    (load_raw → normalise → phenotype → outcomes) before upserting.

    Max file size: 50 MB.
    """
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _ACCEPTED_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported file type {suffix!r}. Accepted: {sorted(_ACCEPTED_EXTENSIONS)}",
        )

    contents = await file.read()
    if len(contents) > _MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 50 MB limit.")

    try:
        from qtx.io.load_raw import load_raw_bytes
        from qtx.pipeline.clean import normalise
        from qtx.pipeline.phenotype import assign_phenotypes
        from qtx.pipeline.outcomes import compute_outcomes

        raw_df = load_raw_bytes(contents, filename=file.filename)
        cleaned = normalise(raw_df)
        phenotyped = assign_phenotypes(cleaned)
        df = compute_outcomes(phenotyped)
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Pipeline failed to process uploaded file: {exc}",
        ) from exc

    return _run_upsert(df, db, source=file.filename or "upload")
