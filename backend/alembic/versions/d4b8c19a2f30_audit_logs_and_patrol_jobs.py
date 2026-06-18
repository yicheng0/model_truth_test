"""audit logs and patrol jobs

Revision ID: d4b8c19a2f30
Revises: c7f18f4b6d21
Create Date: 2026-06-18 17:50:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "d4b8c19a2f30"
down_revision = "c7f18f4b6d21"
branch_labels = None
depends_on = None


def _create_index_if_missing(table_name: str, index_name: str, columns: list[str]) -> None:
    inspector = inspect(op.get_bind())
    existing = {index["name"] for index in inspector.get_indexes(table_name)} if table_name in inspector.get_table_names() else set()
    if index_name not in existing:
        op.create_index(index_name, table_name, columns)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    tables = set(inspector.get_table_names())

    if "audit_logs" not in tables:
        op.create_table(
            "audit_logs",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("actor_id", sa.String(length=100), nullable=True),
            sa.Column("actor_name", sa.String(length=200), nullable=True),
            sa.Column("action", sa.String(length=100), nullable=False),
            sa.Column("target_type", sa.String(length=100), nullable=False),
            sa.Column("target_id", sa.String(length=200), nullable=False),
            sa.Column("request_id", sa.String(length=100), nullable=True),
            sa.Column("before_summary", sa.JSON(), nullable=True),
            sa.Column("after_summary", sa.JSON(), nullable=True),
            sa.Column("metadata", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )
    for index_name, columns in {
        "ix_audit_logs_actor_id": ["actor_id"],
        "ix_audit_logs_action": ["action"],
        "ix_audit_logs_target_type": ["target_type"],
        "ix_audit_logs_target_id": ["target_id"],
        "ix_audit_logs_request_id": ["request_id"],
        "ix_audit_logs_created_at": ["created_at"],
    }.items():
        _create_index_if_missing("audit_logs", index_name, columns)

    if "patrol_jobs" not in tables:
        op.create_table(
            "patrol_jobs",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("scheduled_test_id", sa.String(), nullable=False),
            sa.Column("channel_id", sa.String(), nullable=False),
            sa.Column("status", sa.String(length=30), nullable=False, server_default=sa.text("'queued'")),
            sa.Column("priority", sa.Integer(), nullable=False, server_default=sa.text("100")),
            sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("claimed_by", sa.String(length=100), nullable=True),
            sa.Column("claimed_until", sa.DateTime(timezone=True), nullable=True),
            sa.Column("run_id", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("metadata", sa.JSON(), nullable=True),
            sa.ForeignKeyConstraint(["channel_id"], ["channels.id"]),
            sa.ForeignKeyConstraint(["run_id"], ["runs.id"]),
            sa.ForeignKeyConstraint(["scheduled_test_id"], ["scheduled_channel_tests.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
    for index_name, columns in {
        "ix_patrol_jobs_scheduled_test_id": ["scheduled_test_id"],
        "ix_patrol_jobs_channel_id": ["channel_id"],
        "ix_patrol_jobs_status": ["status"],
        "ix_patrol_jobs_due_at": ["due_at"],
        "ix_patrol_jobs_claimed_by": ["claimed_by"],
        "ix_patrol_jobs_claimed_until": ["claimed_until"],
        "ix_patrol_jobs_run_id": ["run_id"],
        "ix_patrol_jobs_created_at": ["created_at"],
    }.items():
        _create_index_if_missing("patrol_jobs", index_name, columns)

    if "patrol_job_attempts" not in tables:
        op.create_table(
            "patrol_job_attempts",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("job_id", sa.String(), nullable=False),
            sa.Column("attempt_index", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("worker_id", sa.String(length=100), nullable=True),
            sa.Column("status", sa.String(length=30), nullable=False, server_default=sa.text("'running'")),
            sa.Column("run_id", sa.String(), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("timeout_seconds", sa.Integer(), nullable=True),
            sa.Column("error_type", sa.String(length=100), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("metadata", sa.JSON(), nullable=True),
            sa.ForeignKeyConstraint(["job_id"], ["patrol_jobs.id"]),
            sa.ForeignKeyConstraint(["run_id"], ["runs.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
    for index_name, columns in {
        "ix_patrol_job_attempts_job_id": ["job_id"],
        "ix_patrol_job_attempts_worker_id": ["worker_id"],
        "ix_patrol_job_attempts_status": ["status"],
        "ix_patrol_job_attempts_run_id": ["run_id"],
        "ix_patrol_job_attempts_started_at": ["started_at"],
    }.items():
        _create_index_if_missing("patrol_job_attempts", index_name, columns)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    for table_name in ["patrol_job_attempts", "patrol_jobs", "audit_logs"]:
        if table_name in inspector.get_table_names():
            for index in inspector.get_indexes(table_name):
                op.drop_index(index["name"], table_name=table_name)
            op.drop_table(table_name)
