"""Track the last completed hourly patrol summary."""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "b7e3c1a9d502"
down_revision = "a6d9c2e4f701"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "feishu_broadcast_settings" not in inspector.get_table_names():
        return
    columns = {item["name"] for item in inspector.get_columns("feishu_broadcast_settings")}
    if "last_hourly_summary_at" not in columns:
        op.add_column("feishu_broadcast_settings", sa.Column("last_hourly_summary_at", sa.DateTime(timezone=True), nullable=True))
    if "hourly_summary_lock_token" not in columns:
        op.add_column("feishu_broadcast_settings", sa.Column("hourly_summary_lock_token", sa.String(length=64), nullable=True))
    if "hourly_summary_locked_until" not in columns:
        op.add_column("feishu_broadcast_settings", sa.Column("hourly_summary_locked_until", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "feishu_broadcast_settings" not in inspector.get_table_names():
        return
    columns = {item["name"] for item in inspector.get_columns("feishu_broadcast_settings")}
    if "hourly_summary_locked_until" in columns:
        op.drop_column("feishu_broadcast_settings", "hourly_summary_locked_until")
    if "hourly_summary_lock_token" in columns:
        op.drop_column("feishu_broadcast_settings", "hourly_summary_lock_token")
    if "last_hourly_summary_at" in columns:
        op.drop_column("feishu_broadcast_settings", "last_hourly_summary_at")
