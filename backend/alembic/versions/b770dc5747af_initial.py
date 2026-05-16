# Initial migration — baseline for fresh databases created by Base.metadata.create_all().
# This migration is intentionally empty: all tables and columns are created by create_all().
# Future model changes will produce incremental migrations.

"""initial

Revision ID: b770dc5747af
Revises: 
Create Date: 2026-05-16 21:36:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b770dc5747af'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
