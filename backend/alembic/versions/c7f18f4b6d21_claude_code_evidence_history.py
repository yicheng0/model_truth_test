"""claude code evidence history

Revision ID: c7f18f4b6d21
Revises: 8c2e7db1f4a3
Create Date: 2026-05-26 20:30:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "c7f18f4b6d21"
down_revision = "8c2e7db1f4a3"
branch_labels = None
depends_on = None


TABLE_NAME = "claude_code_evidences"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if TABLE_NAME in set(inspector.get_table_names()):
        return
    op.create_table(
        TABLE_NAME,
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("channel_label", sa.String(length=200), nullable=False),
        sa.Column("base_url", sa.String(length=500), nullable=False),
        sa.Column("model_name", sa.String(length=200), nullable=False),
        sa.Column("provider_type", sa.String(length=50), nullable=False),
        sa.Column("request_protocol", sa.String(length=50), nullable=True),
        sa.Column("source_channel_id", sa.String(length=100), nullable=True),
        sa.Column("image_url", sa.String(length=1000), nullable=True),
        sa.Column("include_expensive_context", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("ok", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("score", sa.Float(), nullable=False, server_default=sa.text("0")),
        sa.Column("risk_level", sa.String(length=20), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("result_payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_claude_code_evidences_base_url", TABLE_NAME, ["base_url"])
    op.create_index("ix_claude_code_evidences_created_at", TABLE_NAME, ["created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if TABLE_NAME not in set(inspector.get_table_names()):
        return
    existing_indexes = {index["name"] for index in inspector.get_indexes(TABLE_NAME)}
    if "ix_claude_code_evidences_created_at" in existing_indexes:
        op.drop_index("ix_claude_code_evidences_created_at", table_name=TABLE_NAME)
    if "ix_claude_code_evidences_base_url" in existing_indexes:
        op.drop_index("ix_claude_code_evidences_base_url", table_name=TABLE_NAME)
    op.drop_table(TABLE_NAME)
