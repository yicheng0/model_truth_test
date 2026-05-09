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
    _ensure_channel_columns()
    _ensure_channel_taxonomy_columns()
    _remove_builtin_demo_channels()
    _ensure_test_case_sort_order_column()
    _ensure_run_baseline_columns()


def _ensure_channel_columns() -> None:
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    if "channels" not in tables:
        return
    columns = {column["name"] for column in inspector.get_columns("channels")}
    with engine.begin() as connection:
        if "auth_config_encrypted" not in columns:
            connection.execute(text("ALTER TABLE channels ADD COLUMN auth_config_encrypted JSON"))
        if "is_reference" not in columns:
            connection.execute(text("ALTER TABLE channels ADD COLUMN is_reference BOOLEAN NOT NULL DEFAULT 0"))
            connection.execute(text("UPDATE channels SET is_reference = 1 WHERE role IN ('gold', 'official_cloud')"))


def _ensure_channel_taxonomy_columns() -> None:
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    if "channel_taxonomy_settings" not in tables:
        return
    columns = {column["name"] for column in inspector.get_columns("channel_taxonomy_settings")}
    with engine.begin() as connection:
        if "model_options" not in columns:
            connection.execute(text("ALTER TABLE channel_taxonomy_settings ADD COLUMN model_options JSON"))


def _remove_builtin_demo_channels() -> None:
    if os.getenv("SKIP_BUILTIN_CHANNEL_CLEANUP", "").lower() in {"1", "true", "yes"}:
        return
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    if "channels" not in tables:
        return
    demo_ids = (
        "'anthropic_official'",
        "'aws_bedrock'",
        "'azure_foundry'",
        "'third_party_demo'",
        "'openai_compat_demo'",
        "'negative_sample'",
    )
    with engine.begin() as connection:
        connection.execute(text(f"DELETE FROM channels WHERE id IN ({','.join(demo_ids)})"))


def _ensure_test_case_sort_order_column() -> None:
    inspector = inspect(engine)
    columns = {column["name"] for column in inspector.get_columns("test_cases")}
    if "sort_order" in columns:
        return
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE test_cases ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 1000"))


def _ensure_run_baseline_columns() -> None:
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    if "runs" not in tables:
        return
    columns = {column["name"] for column in inspector.get_columns("runs")}
    with engine.begin() as connection:
        if "mode" not in columns:
            connection.execute(text("ALTER TABLE runs ADD COLUMN mode VARCHAR(30) NOT NULL DEFAULT 'full_comparison'"))
        if "baseline_snapshot_id" not in columns:
            connection.execute(text("ALTER TABLE runs ADD COLUMN baseline_snapshot_id VARCHAR"))
        if "scheduled_test_id" not in columns:
            connection.execute(text("ALTER TABLE runs ADD COLUMN scheduled_test_id VARCHAR"))
        if "test_scope" not in columns:
            connection.execute(text("ALTER TABLE runs ADD COLUMN test_scope VARCHAR(30) NOT NULL DEFAULT 'full'"))

    if "scheduled_channel_tests" not in tables:
        return
    scheduled_columns = {column["name"] for column in inspector.get_columns("scheduled_channel_tests")}
    with engine.begin() as connection:
        if "test_scope" not in scheduled_columns:
            connection.execute(text("ALTER TABLE scheduled_channel_tests ADD COLUMN test_scope VARCHAR(30) NOT NULL DEFAULT 'quick'"))


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
