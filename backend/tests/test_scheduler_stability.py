from datetime import datetime, timedelta, timezone

from app import services as services_module


def test_scheduler_lock_expiry_covers_task_timeout(monkeypatch) -> None:
    now = datetime(2026, 5, 15, 0, 0, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(services_module, "SCHEDULER_LOCK_MINUTES", 30)
    monkeypatch.setattr(services_module, "SCHEDULED_TEST_TASK_TIMEOUT_SECONDS", 7200)
    monkeypatch.setattr(services_module, "SCHEDULER_LOCK_GRACE_SECONDS", 300)

    expires_at = services_module._lock_expiry(now)

    assert expires_at >= now + timedelta(seconds=7500)
