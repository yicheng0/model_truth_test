"""scheduled tests schema backfill

Revision ID: 8c2e7db1f4a3
Revises: b770dc5747af
Create Date: 2026-05-17 00:00:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "8c2e7db1f4a3"
down_revision = "b770dc5747af"
branch_labels = None
depends_on = None


TABLE_NAME = "scheduled_channel_tests"
ALERT_TABLE_NAME = "channel_alerts"

NEW_COLUMNS = (
    sa.Column("run_window_start", sa.String(length=5), nullable=True),
    sa.Column("run_window_end", sa.String(length=5), nullable=True),
    sa.Column("alert_grade_threshold", sa.String(length=2), nullable=False, server_default=sa.text("'D'")),
    sa.Column("alert_score_threshold", sa.Float(), nullable=True),
    sa.Column("alert_red_flags_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
    sa.Column("quiet_minutes", sa.Integer(), nullable=False, server_default=sa.text("0")),
    sa.Column("max_retries", sa.Integer(), nullable=False, server_default=sa.text("0")),
    sa.Column("retry_interval_minutes", sa.Integer(), nullable=False, server_default=sa.text("5")),
    sa.Column("locked_by", sa.String(length=100), nullable=True),
    sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
    sa.Column("last_queued_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("last_started_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("last_finished_at", sa.DateTime(timezone=True), nullable=True),
)

NEW_INDEXES = (
    ("ix_scheduled_channel_tests_locked_by", ("locked_by",)),
    ("ix_scheduled_channel_tests_locked_until", ("locked_until",)),
)

ALERT_COLUMNS = (
    sa.Column("dedupe_key", sa.String(length=200), nullable=True),
)

ALERT_INDEXES = (
    ("ix_channel_alerts_dedupe_key", ("dedupe_key",)),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    table_names = set(inspector.get_table_names())

    if TABLE_NAME in table_names:
        existing_columns = {column["name"] for column in inspector.get_columns(TABLE_NAME)}
        for column in NEW_COLUMNS:
            if column.name not in existing_columns:
                op.add_column(TABLE_NAME, column)

        existing_indexes = {index["name"] for index in inspector.get_indexes(TABLE_NAME)}
        for index_name, columns in NEW_INDEXES:
            if index_name not in existing_indexes:
                op.create_index(index_name, TABLE_NAME, list(columns))

    if ALERT_TABLE_NAME in table_names:
        existing_alert_columns = {column["name"] for column in inspector.get_columns(ALERT_TABLE_NAME)}
        for column in ALERT_COLUMNS:
            if column.name not in existing_alert_columns:
                op.add_column(ALERT_TABLE_NAME, column)

        existing_alert_indexes = {index["name"] for index in inspector.get_indexes(ALERT_TABLE_NAME)}
        for index_name, columns in ALERT_INDEXES:
            if index_name not in existing_alert_indexes:
                op.create_index(index_name, ALERT_TABLE_NAME, list(columns))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    table_names = set(inspector.get_table_names())

    if ALERT_TABLE_NAME in table_names:
        existing_alert_indexes = {index["name"] for index in inspector.get_indexes(ALERT_TABLE_NAME)}
        for index_name, columns in reversed(ALERT_INDEXES):
            if index_name in existing_alert_indexes:
                op.drop_index(index_name, table_name=ALERT_TABLE_NAME)

        existing_alert_columns = {column["name"] for column in inspector.get_columns(ALERT_TABLE_NAME)}
        for column in reversed(ALERT_COLUMNS):
            if column.name in existing_alert_columns:
                op.drop_column(ALERT_TABLE_NAME, column.name)

    if TABLE_NAME not in table_names:
        return

    existing_indexes = {index["name"] for index in inspector.get_indexes(TABLE_NAME)}
    for index_name, columns in reversed(NEW_INDEXES):
        if index_name in existing_indexes:
            op.drop_index(index_name, table_name=TABLE_NAME)

    existing_columns = {column["name"] for column in inspector.get_columns(TABLE_NAME)}
    for column in reversed(NEW_COLUMNS):
        if column.name in existing_columns:
            op.drop_column(TABLE_NAME, column.name)
