from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
import uuid

from fastapi import Header
from sqlalchemy.orm import Session

from .models import AuditLog
from .redaction import redact_secrets


def _new_audit_id() -> str:
    return f"audit_{uuid.uuid4().hex[:12]}"


def audit_actor(
    x_actor: str | None = Header(default=None, alias="X-Actor"),
    x_request_id: str | None = Header(default=None, alias="X-Request-Id"),
) -> dict[str, str | None]:
    actor = (x_actor or "").strip() or "system"
    return {
        "actor_id": actor,
        "actor_name": actor,
        "request_id": (x_request_id or "").strip() or None,
    }


def audit_log_read(log: AuditLog) -> dict[str, Any]:
    return {
        "id": log.id,
        "actor_id": log.actor_id,
        "actor_name": log.actor_name,
        "action": log.action,
        "target_type": log.target_type,
        "target_id": log.target_id,
        "request_id": log.request_id,
        "before_summary": log.before_summary,
        "after_summary": log.after_summary,
        "audit_metadata": log.audit_metadata,
        "created_at": log.created_at,
    }


def record_audit_log(
    db: Session,
    *,
    actor: dict[str, str | None] | None,
    action: str,
    target_type: str,
    target_id: str,
    before_summary: dict[str, Any] | None = None,
    after_summary: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> AuditLog:
    actor = actor or {}
    log = AuditLog(
        id=_new_audit_id(),
        actor_id=actor.get("actor_id") or "system",
        actor_name=actor.get("actor_name") or actor.get("actor_id") or "system",
        action=action,
        target_type=target_type,
        target_id=target_id,
        request_id=actor.get("request_id"),
        before_summary=redact_secrets(before_summary or {}),
        after_summary=redact_secrets(after_summary or {}),
        audit_metadata=redact_secrets(metadata or {}),
        created_at=datetime.now(timezone.utc),
    )
    db.add(log)
    db.flush()
    return log


def scheduled_test_audit_summary(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    return {
        "id": getattr(value, "id", None),
        "name": getattr(value, "name", None),
        "channel_id": getattr(value, "channel_id", None),
        "suite_id": getattr(value, "suite_id", None),
        "baseline_snapshot_id": getattr(value, "baseline_snapshot_id", None),
        "enabled": getattr(value, "enabled", None),
        "interval_minutes": getattr(value, "interval_minutes", None),
        "run_window_start": getattr(value, "run_window_start", None),
        "run_window_end": getattr(value, "run_window_end", None),
        "test_scope": getattr(value, "test_scope", None),
        "quiet_minutes": getattr(value, "quiet_minutes", None),
        "max_retries": getattr(value, "max_retries", None),
        "retry_interval_minutes": getattr(value, "retry_interval_minutes", None),
        "last_status": getattr(value, "last_status", None),
        "last_run_id": getattr(value, "last_run_id", None),
        "next_run_at": _iso_or_none(getattr(value, "next_run_at", None)),
    }


def _iso_or_none(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    return None if value is None else str(value)
