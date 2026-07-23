"""Persist upstream response and request IDs on results."""
from __future__ import annotations

from typing import Any

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "a6d9c2e4f701"
down_revision = "20260722_health_indexes"
branch_labels = None
depends_on = None


def _text(value: Any) -> str | None:
    return str(value) if value is not None and str(value).strip() else None


def _request_id(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    direct = payload.get("request_id") or payload.get("requestId")
    if direct:
        return _text(direct)
    error = payload.get("error")
    if isinstance(error, dict):
        nested = error.get("request_id") or error.get("requestId")
        if nested:
            return _text(nested)
    metadata = payload.get("_response_metadata")
    if isinstance(metadata, dict) and metadata.get("request_id"):
        return _text(metadata.get("request_id"))
    wrapper = payload.get("cloud_wrapper")
    if isinstance(wrapper, dict):
        wrapped = wrapper.get("request_id") or wrapper.get("requestId")
        if wrapped:
            return _text(wrapped)
    response_metadata = payload.get("ResponseMetadata")
    if isinstance(response_metadata, dict):
        return _text(response_metadata.get("RequestId") or response_metadata.get("RequestID"))
    return None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "results" not in inspector.get_table_names():
        return
    columns = {item["name"] for item in inspector.get_columns("results")}
    if "upstream_response_id" not in columns:
        op.add_column("results", sa.Column("upstream_response_id", sa.String(length=255), nullable=True))
    if "upstream_request_id" not in columns:
        op.add_column("results", sa.Column("upstream_request_id", sa.String(length=255), nullable=True))

    results = sa.table(
        "results",
        sa.column("id", sa.String()),
        sa.column("normalized_response", sa.JSON()),
        sa.column("raw_response", sa.JSON()),
        sa.column("upstream_response_id", sa.String()),
        sa.column("upstream_request_id", sa.String()),
    )
    rows = bind.execute(sa.select(results.c.id, results.c.normalized_response, results.c.raw_response)).mappings().all()
    for row in rows:
        normalized = row["normalized_response"] if isinstance(row["normalized_response"], dict) else {}
        raw_response = row["raw_response"] if isinstance(row["raw_response"], dict) else {}
        response_id = _text(normalized.get("provider_message_id") or raw_response.get("id"))
        request_id = _request_id(raw_response) or _request_id(normalized)
        if response_id or request_id:
            bind.execute(
                results.update().where(results.c.id == row["id"]).values(
                    upstream_response_id=response_id,
                    upstream_request_id=request_id,
                )
            )

    inspector = inspect(bind)
    indexes = {item["name"] for item in inspector.get_indexes("results")}
    if "ix_results_upstream_response_id" not in indexes:
        op.create_index("ix_results_upstream_response_id", "results", ["upstream_response_id"])
    if "ix_results_upstream_request_id" not in indexes:
        op.create_index("ix_results_upstream_request_id", "results", ["upstream_request_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "results" not in inspector.get_table_names():
        return
    indexes = {item["name"] for item in inspector.get_indexes("results")}
    if "ix_results_upstream_request_id" in indexes:
        op.drop_index("ix_results_upstream_request_id", table_name="results")
    if "ix_results_upstream_response_id" in indexes:
        op.drop_index("ix_results_upstream_response_id", table_name="results")
    columns = {item["name"] for item in inspect(bind).get_columns("results")}
    if "upstream_request_id" in columns:
        op.drop_column("results", "upstream_request_id")
    if "upstream_response_id" in columns:
        op.drop_column("results", "upstream_response_id")
