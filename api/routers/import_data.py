"""Import endpoints: seed from local parquet or accept CSV/Excel upload."""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session

from db import get_db
from routers.admin import require_admin_key
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
    pipeline = IngestPipeline(db, source_filename=source)
    try:
        summary = pipeline.upsert(df)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="Batch rolled back: {}".format(exc)) from exc

    return {
        "inserted": summary.inserted,
        "updated": summary.updated,
        "skipped": summary.skipped,
        "error_count": len(summary.errors),
        "errors": [{"row_index": e.row_index, "sn": e.sn, "reason": e.reason} for e in summary.errors],
    }


@router.post("/import/seed", dependencies=[Depends(require_admin_key)])
def seed_from_parquet(db: Session = Depends(get_db)) -> dict:
    if not _PARQUET_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail="Parquet file not found at {}. Run scripts 01-07 first.".format(_PARQUET_PATH),
        )
    df = pd.read_parquet(_PARQUET_PATH)
    return _run_upsert(df, db, source=_PARQUET_PATH.name)


@router.post("/import/file", dependencies=[Depends(require_admin_key)])
async def import_file(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> dict:
    """Accept a CSV or Excel file upload and run it through the qtx pipeline.

    The file is written to a temp path, run through the src/qtx processing
    pipeline (load_raw -> normalise -> classify -> change_scores -> composite ->
    responders -> build_feature_matrix), then upserted into the database.
    The temp file is always removed, even on error.

    Max file size: 50 MB.
    """
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _ACCEPTED_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail="Unsupported file type {!r}. Accepted: {}".format(suffix, sorted(_ACCEPTED_EXTENSIONS)),
        )

    contents = await file.read()
    if len(contents) > _MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 50 MB limit.")

    tmp_path = None
    df = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(contents)
            tmp_path = Path(tmp.name)

        try:
            from qtx.clean.normalise import normalise
            from qtx.features.build import build_feature_matrix
            from qtx.outcomes.change_scores import compute_change_scores
            from qtx.outcomes.composite import compute_composite
            from qtx.outcomes.responders import compute_responders
            from qtx.phenotype.classify import classify

            if suffix == ".csv":
                raw_df = pd.read_csv(tmp_path)
            else:
                from qtx.io.load_raw import load_raw
                raw_df = load_raw(path=tmp_path)

            cleaned = normalise(raw_df)
            phenotyped = classify(cleaned)
            with_changes = compute_change_scores(phenotyped)
            with_composite = compute_composite(with_changes)
            with_responders = compute_responders(with_composite)
            df = build_feature_matrix(with_responders)
        except Exception as exc:
            raise HTTPException(
                status_code=422,
                detail="Pipeline failed to process uploaded file: {}".format(exc),
            ) from exc
    finally:
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink()

    return _run_upsert(df, db, source=file.filename or "upload")


@router.post("/import/seed_parquet", dependencies=[Depends(require_admin_key)])
async def seed_from_parquet_upload(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> dict:
    """Accept a .parquet upload and seed the database (admin-gated).

    Replaces seeding from a git-tracked parquet: a one-shot manual upload of
    data/processed/dashboard_data.parquet. The file is written to a temp path,
    read with pandas, and upserted via the same ingest service used by
    /import/seed. The temp file is always removed, even on error.

    Max file size: 50 MB.
    """
    suffix = Path(file.filename or "").suffix.lower()
    if suffix != ".parquet":
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type {!r}. Expected a .parquet file.".format(suffix),
        )

    contents = await file.read()
    if len(contents) > _MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 50 MB limit.")

    tmp_path = None
    df = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(contents)
            tmp_path = Path(tmp.name)

        try:
            df = pd.read_parquet(tmp_path)
        except Exception as exc:
            raise HTTPException(
                status_code=422,
                detail="Failed to read parquet file: {}".format(exc),
            ) from exc
    finally:
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink()

    return _run_upsert(df, db, source=file.filename or "upload.parquet")
