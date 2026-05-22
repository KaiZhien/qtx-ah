"""Tests for Terra webhook ingestion."""
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

@pytest.fixture
def db_engine(tmp_path):
    from api.db import Base
    engine = create_engine(f"sqlite:///{tmp_path}/test.db")
    Base.metadata.create_all(engine)
    return engine

@pytest.fixture
def db(db_engine):
    Session = sessionmaker(bind=db_engine)
    session = Session()
    yield session
    session.close()

def test_tables_created(db_engine):
    with db_engine.connect() as conn:
        tables = conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table'")
        ).scalars().all()
    assert "wearable_enrollments" in tables
    assert "wearable_activity" in tables
    assert "wearable_body" in tables
    assert "wearable_sleep" in tables
    assert "wearable_events" in tables
