"""PDF report endpoint — GET /api/patient/{sn}/report.pdf"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session as DBSession

import deps
from db import get_db
from services.report import ReportService

router = APIRouter()


def _check_db_ready() -> None:
    if not deps._db_ready:
        raise HTTPException(
            status_code=503,
            detail="Patient data not available — DB is empty or unreachable.",
        )


@router.get("/patient/{sn}/report.pdf")
def get_patient_report(
    sn: str,
    db: DBSession = Depends(get_db),
) -> Response:
    """Generate and return a PDF clinical summary for the given patient."""
    _check_db_ready()

    try:
        pdf_bytes = ReportService(db).generate(sn)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Patient sn={sn!r} not found")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {exc}")

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="patient_{sn}_report.pdf"',
        },
    )
