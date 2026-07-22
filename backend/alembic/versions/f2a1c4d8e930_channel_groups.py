"""channel groups

Revision ID: f2a1c4d8e930
Revises: e19a7d2c5b41
Create Date: 2026-07-22 12:00:00.000000
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "f2a1c4d8e930"
down_revision = "e19a7d2c5b41"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    tables = set(inspector.get_table_names())
    if "channel_groups" not in tables:
        op.create_table(
            "channel_groups",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("key", sa.String(length=64), nullable=False),
            sa.Column("name", sa.String(length=100), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("color", sa.String(length=32), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="1000"),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("key"),
        )
        op.create_index("ix_channel_groups_key", "channel_groups", ["key"], unique=True)
    inspector = inspect(bind)
    if "channel_group_members" not in set(inspector.get_table_names()):
        op.create_table(
            "channel_group_members",
            sa.Column("group_id", sa.String(), nullable=False),
            sa.Column("channel_id", sa.String(), nullable=False),
            sa.ForeignKeyConstraint(["channel_id"], ["channels.id"]),
            sa.ForeignKeyConstraint(["group_id"], ["channel_groups.id"]),
            sa.PrimaryKeyConstraint("group_id", "channel_id"),
        )
        op.create_index("ix_channel_group_members_channel_id", "channel_group_members", ["channel_id"])


def downgrade() -> None:
    bind = op.get_bind()
    tables = set(inspect(bind).get_table_names())
    if "channel_group_members" in tables:
        op.drop_index("ix_channel_group_members_channel_id", table_name="channel_group_members")
        op.drop_table("channel_group_members")
    if "channel_groups" in tables:
        op.drop_index("ix_channel_groups_key", table_name="channel_groups")
        op.drop_table("channel_groups")
