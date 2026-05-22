"""SQLAlchemy engine and session for wearable data storage."""
from __future__ import annotations

from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase, Session

_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "wearable.db"
_engine = create_engine(
    f"sqlite:///{_DB_PATH}",
    connect_args={"check_same_thread": False},
)
_SessionLocal = sessionmaker(bind=_engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db: Session = _SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from api.models import wearable  # noqa: F401 — registers ORM models with Base
    Base.metadata.create_all(bind=_engine)
