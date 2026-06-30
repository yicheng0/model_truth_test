"""scheduled patrol module selection

Revision ID: e19a7d2c5b41
Revises: d4b8c19a2f30
Create Date: 2026-06-30 00:00:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "e19a7d2c5b41"
down_revision = "d4b8c19a2f30"
branch_labels = None
depends_on = None

TABLE_NAME = "scheduled_channel_tests"
COLUMN_NAME = "patrol_modules"


def upgrade() -> None:
    inspector = inspect(op.get_bind())
    if TABLE_NAME not in set(inspector.get_table_names()):
        return
    existing_columns = {column["name"] for column in inspector.get_columns(TABLE_NAME)}
    if COLUMN_NAME not in existing_columns:
        op.add_column(TABLE_NAME, sa.Column(COLUMN_NAME, sa.JSON(), nullable=True))


def downgrade() -> None:
    inspector = inspect(op.get_bind())
    if TABLE_NAME not in set(inspector.get_table_names()):
        return
    existing_columns = {column["name"] for column in inspector.get_columns(TABLE_NAME)}
    if COLUMN_NAME in existing_columns:
        op.drop_column(TABLE_NAME, COLUMN_NAME)
