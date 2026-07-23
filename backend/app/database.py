from __future__ import annotations

import os
from collections.abc import Generator
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import JSON, Column, DateTime, Integer, String, Text, create_engine, inspect, text
from sqlalchemy.schema import CreateColumn
from sqlalchemy.orm import Session, sessionmaker

from .models import Base


def _add_column_if_missing(table_name: str, existing_columns: set[str], column: Column) -> None:
    if column.name in existing_columns:
        return
    ddl = str(CreateColumn(column).compile(dialect=engine.dialect))
    with engine.begin() as connection:
        connection.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {ddl}"))
    existing_columns.add(column.name)


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./claude_eval.db")

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def _alembic_config() -> Config:
    alembic_ini = Path(__file__).resolve().parent.parent / "alembic.ini"
    cfg = Config(str(alembic_ini))
    cfg.set_main_option("sqlalchemy.url", DATABASE_URL)
    return cfg


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    command.upgrade(_alembic_config(), "head")
    repair_schema()


def repair_schema() -> None:
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())

    if "scheduled_channel_tests" in table_names:
        scheduled_columns = {column["name"] for column in inspector.get_columns("scheduled_channel_tests")}
        _add_column_if_missing("scheduled_channel_tests", scheduled_columns, Column("patrol_modules", JSON, nullable=True))
        _add_column_if_missing("scheduled_channel_tests", scheduled_columns, Column("model_request_probe_keys", JSON, nullable=True))

    if "results" in table_names:
        result_columns = {column["name"] for column in inspector.get_columns("results")}
        _add_column_if_missing("results", result_columns, Column("upstream_response_id", String(255), nullable=True))
        _add_column_if_missing("results", result_columns, Column("upstream_request_id", String(255), nullable=True))
        result_indexes = {index["name"] for index in inspect(engine).get_indexes("results")}
        with engine.begin() as connection:
            for name, column in (
                ("ix_results_upstream_response_id", "upstream_response_id"),
                ("ix_results_upstream_request_id", "upstream_request_id"),
            ):
                if name in result_indexes:
                    continue
                if engine.dialect.name == "sqlite":
                    connection.execute(text(f"CREATE INDEX IF NOT EXISTS {name} ON results ({column})"))
                else:
                    connection.execute(text(f"CREATE INDEX {name} ON results ({column})"))

    if "channel_alerts" not in table_names:
        return

    alert_columns = {column["name"] for column in inspector.get_columns("channel_alerts")}
    for column in _missing_channel_alert_columns(alert_columns):
        _add_column_if_missing("channel_alerts", alert_columns, column)

    inspector = inspect(engine)
    alert_indexes = {index["name"] for index in inspector.get_indexes("channel_alerts")}
    if "ix_channel_alerts_dedupe_key" not in alert_indexes:
        with engine.begin() as connection:
            if engine.dialect.name == "sqlite":
                connection.execute(text("CREATE INDEX IF NOT EXISTS ix_channel_alerts_dedupe_key ON channel_alerts (dedupe_key)"))
            else:
                connection.execute(text("CREATE INDEX ix_channel_alerts_dedupe_key ON channel_alerts (dedupe_key)"))


def _missing_channel_alert_columns(existing_columns: set[str]) -> list:
    expected = {
        "dedupe_key": String(200),
        "notification_attempt_count": Integer(),
        "last_notification_attempt_at": DateTime(timezone=True),
        "notified_at": DateTime(timezone=True),
        "reviewer_name": String(100),
        "review_note": Text(),
        "reviewed_at": DateTime(timezone=True),
        "first_seen_at": DateTime(timezone=True),
        "last_seen_at": DateTime(timezone=True),
        "consecutive_windows": Integer(),
        "resolved_at": DateTime(timezone=True),
    }
    return [
        _column_for_alert_repair(name, type_)
        for name, type_ in expected.items()
        if name not in existing_columns
    ]


def _column_for_alert_repair(name: str, type_) -> object:  # noqa: ANN001
    if name == "notification_attempt_count":
        return Column(name, type_, nullable=False, server_default=text("0"))
    if name == "consecutive_windows":
        return Column(name, type_, nullable=False, server_default=text("1"))
    return Column(name, type_, nullable=True)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
