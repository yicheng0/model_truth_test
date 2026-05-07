from __future__ import annotations

import os
from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from .models import Base


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./claude_eval.db")

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _ensure_test_case_sort_order_column()


def _ensure_test_case_sort_order_column() -> None:
    inspector = inspect(engine)
    columns = {column["name"] for column in inspector.get_columns("test_cases")}
    if "sort_order" in columns:
        return
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE test_cases ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 1000"))


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
