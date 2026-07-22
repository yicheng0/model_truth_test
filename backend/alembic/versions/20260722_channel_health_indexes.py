"""Add composite indexes used by channel health aggregation."""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "20260722_health_indexes"
down_revision = "f2a1c4d8e930"
branch_labels = None
depends_on = None


def _create_if_missing(table: str, name: str, columns: list[str]) -> None:
    inspector = inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return
    indexes = {item["name"] for item in inspector.get_indexes(table)}
    if name not in indexes:
        op.create_index(name, table, columns)


def upgrade() -> None:
    inspector = inspect(op.get_bind())
    if "channel_alerts" in inspector.get_table_names():
        columns = {item["name"] for item in inspector.get_columns("channel_alerts")}
        for name, column in {
            "first_seen_at": sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=True),
            "last_seen_at": sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
            "consecutive_windows": sa.Column("consecutive_windows", sa.Integer(), nullable=False, server_default=sa.text("1")),
            "resolved_at": sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        }.items():
            if name not in columns:
                op.add_column("channel_alerts", column)
    _create_if_missing("results", "ix_results_channel_created_at", ["channel_id", "created_at"])
    _create_if_missing("channel_alerts", "ix_channel_alerts_channel_created_at", ["channel_id", "created_at"])


def downgrade() -> None:
    inspector = inspect(op.get_bind())
    for table, name in (("results", "ix_results_channel_created_at"), ("channel_alerts", "ix_channel_alerts_channel_created_at")):
        indexes = {item["name"] for item in inspector.get_indexes(table)} if table in inspector.get_table_names() else set()
        if name in indexes:
            op.drop_index(name, table_name=table)
