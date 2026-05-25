"""SQLAlchemy engine and session for all application data storage.

Engine is created lazily on first use so importing this module never
requires DATABASE_URL to be set — tests that override get_db() won't
accidentally trigger a connection attempt.
"""
from __future__ import annotations

import os
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase, Session

_engine = None
_SessionLocal = None


class Base(DeclarativeBase):
    pass


def _get_engine():
    """Return the shared engine, creating it on first call."""
    global _engine, _SessionLocal
    if _engine is None:
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError(
                "DATABASE_URL environment variable is not set. "
                "Example: postgresql+psycopg2://user:pass@localhost:5432/qtxah"
            )
        _engine = create_engine(url, pool_pre_ping=True)
        _SessionLocal = sessionmaker(bind=_engine)
    return _engine


def get_db():
    """FastAPI dependency: yield a DB session, roll back on error."""
    _get_engine()  # ensure _SessionLocal is initialised
    db: Session = _SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db() -> None:
    """Create all tables and enable pgvector. Called once at app startup."""
    engine = _get_engine()
    with engine.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.commit()
    from models import wearable   # noqa: F401 — registers wearable models with Base
    from models import clinical   # noqa: F401 — registers clinical models with Base
    Base.metadata.create_all(bind=engine)
