from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any


class InMemoryJobStore:
    """Small TTL-backed store for best-effort background job progress."""

    def __init__(self, *, ttl: timedelta) -> None:
        self.ttl = ttl
        self._jobs: dict[str, dict[str, Any]] = {}

    def set(self, job_id: str, payload: dict[str, Any]) -> None:
        self.cleanup()
        self._jobs[job_id] = dict(payload)

    def get(self, job_id: str) -> dict[str, Any] | None:
        self.cleanup()
        payload = self._jobs.get(job_id)
        if payload is None:
            return None
        return dict(payload)

    def update(self, job_id: str, payload: dict[str, Any]) -> bool:
        self.cleanup()
        current = self._jobs.get(job_id)
        if current is None:
            return False
        current.update(payload)
        current["updated_at"] = datetime.now(timezone.utc)
        return True

    def cleanup(self) -> int:
        now = datetime.now(timezone.utc)
        expired = [
            job_id
            for job_id, payload in self._jobs.items()
            if self._expires_at(payload, now) <= now
        ]
        for job_id in expired:
            del self._jobs[job_id]
        return len(expired)

    def total_count(self, job_id: str) -> int:
        payload = self._jobs.get(job_id) or {}
        return int(payload.get("total_count") or 0)

    def _expires_at(self, payload: dict[str, Any], now: datetime) -> datetime:
        finished_at = _coerce_datetime(payload.get("finished_at"))
        if finished_at is not None:
            return finished_at + self.ttl
        updated_at = _coerce_datetime(payload.get("updated_at"))
        started_at = _coerce_datetime(payload.get("started_at"))
        return (updated_at or started_at or now) + self.ttl


def _coerce_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value
    return None
