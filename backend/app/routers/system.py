from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..admin import configured_admin_key, require_configured_admin
from ..database import DATABASE_URL, get_db
from ..models import BaselineSnapshot, ChannelAlert, Comparison, Report, Result, Run, RunChannel, ScheduledChannelTest, TestSuite
from ..schemas import RunLogCleanupRead, SystemUsageRead


router = APIRouter()
logger = logging.getLogger(__name__)

TERMINAL_RUN_STATUSES = {"completed", "failed", "canceled", "interrupted"}
ACTIVE_RUN_STATUSES = {"pending", "running"}


def _database_file_path() -> Path | None:
    if not DATABASE_URL.startswith("sqlite:///"):
        return None
    raw_path = DATABASE_URL.removeprefix("sqlite:///")
    return Path(raw_path).resolve()


def _database_size_bytes() -> int | None:
    path = _database_file_path()
    if not path or not path.exists():
        return None
    return path.stat().st_size


def _memory_usage() -> dict[str, int | float | None]:
    try:
        import psutil  # type: ignore
    except Exception:
        psutil = None
    if psutil is not None:
        mem = psutil.virtual_memory()
        return {
            "memory_total_bytes": int(mem.total),
            "memory_available_bytes": int(mem.available),
            "memory_used_bytes": int(mem.used),
            "memory_used_percent": round(float(mem.percent), 2),
        }
    meminfo = Path("/proc/meminfo")
    if not meminfo.exists():
        return {
            "memory_total_bytes": None,
            "memory_available_bytes": None,
            "memory_used_bytes": None,
            "memory_used_percent": None,
        }
    values: dict[str, int] = {}
    for line in meminfo.read_text(encoding="utf-8").splitlines():
        key, _, rest = line.partition(":")
        parts = rest.strip().split()
        if not parts:
            continue
        try:
            values[key] = int(parts[0]) * 1024
        except ValueError:
            continue
    total = values.get("MemTotal")
    available = values.get("MemAvailable")
    used = total - available if total is not None and available is not None else None
    used_percent = round((used / total) * 100, 2) if total and used is not None else None
    return {
        "memory_total_bytes": total,
        "memory_available_bytes": available,
        "memory_used_bytes": used,
        "memory_used_percent": used_percent,
    }


def _cleanup_candidate_run_ids(db: Session) -> tuple[list[str], int, int]:
    terminal_run_ids = list(db.scalars(select(Run.id).where(Run.status.in_(TERMINAL_RUN_STATUSES))).all())
    if not terminal_run_ids:
        return [], 0, int(db.scalar(select(func.count()).select_from(Run).where(Run.status.in_(ACTIVE_RUN_STATUSES))) or 0)
    baseline_run_ids = set(db.scalars(select(BaselineSnapshot.source_run_id).where(BaselineSnapshot.source_run_id.in_(terminal_run_ids))).all())
    candidate_ids = [run_id for run_id in terminal_run_ids if run_id not in baseline_run_ids]
    active_count = int(db.scalar(select(func.count()).select_from(Run).where(Run.status.in_(ACTIVE_RUN_STATUSES))) or 0)
    return candidate_ids, len(baseline_run_ids), active_count


@router.get("/api/health")
def health(db: Session = Depends(get_db)) -> dict[str, str]:
    db.scalar(select(TestSuite).limit(1))
    return {"status": "ok", "database": "ok"}


@router.get("/api/system/usage", response_model=SystemUsageRead)
def system_usage(
    db: Session = Depends(get_db),
    x_admin_key: str | None = Header(None, alias="X-Admin-Key"),
) -> SystemUsageRead:
    expected = configured_admin_key()
    if expected and x_admin_key != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")
    disk_path = Path.cwd()
    disk = shutil.disk_usage(disk_path)
    candidate_run_ids, skipped_baseline_runs, active_runs = _cleanup_candidate_run_ids(db)
    database_path = _database_file_path()
    return SystemUsageRead(
        disk_path=str(disk_path),
        disk_total_bytes=disk.total,
        disk_used_bytes=disk.used,
        disk_free_bytes=disk.free,
        disk_used_percent=round((disk.used / disk.total) * 100, 2) if disk.total else 0,
        database_path=str(database_path) if database_path else None,
        database_size_bytes=_database_size_bytes(),
        run_count=int(db.scalar(select(func.count()).select_from(Run)) or 0),
        result_count=int(db.scalar(select(func.count()).select_from(Result)) or 0),
        comparison_count=int(db.scalar(select(func.count()).select_from(Comparison)) or 0),
        report_count=int(db.scalar(select(func.count()).select_from(Report)) or 0),
        alert_count=int(db.scalar(select(func.count()).select_from(ChannelAlert)) or 0),
        cleanup_candidate_run_count=len(candidate_run_ids),
        cleanup_skipped_baseline_run_count=skipped_baseline_runs + active_runs,
        **_memory_usage(),
    )


@router.post("/api/system/cleanup-run-logs", response_model=RunLogCleanupRead)
def cleanup_run_logs(
    dry_run: bool = Query(False),
    _admin: None = Depends(require_configured_admin),
    db: Session = Depends(get_db),
) -> RunLogCleanupRead:
    try:
        candidate_run_ids, skipped_baseline_runs, active_runs = _cleanup_candidate_run_ids(db)
    except Exception:
        db.rollback()
        logger.warning("cleanup_run_logs: failed to collect candidate runs", exc_info=True)
        if dry_run:
            active_runs = int(db.scalar(select(func.count()).select_from(Run).where(Run.status.in_(ACTIVE_RUN_STATUSES))) or 0)
            return RunLogCleanupRead(dry_run=True, skipped_running_runs=active_runs)
        raise
    if not candidate_run_ids:
        return RunLogCleanupRead(
            dry_run=dry_run,
            skipped_running_runs=active_runs,
            skipped_baseline_runs=skipped_baseline_runs,
        )

    def count_for(model: type, field) -> int:  # noqa: ANN001
        return int(db.scalar(select(func.count()).select_from(model).where(field.in_(candidate_run_ids))) or 0)

    try:
        scheduled_refs = list(db.scalars(select(ScheduledChannelTest).where(ScheduledChannelTest.last_run_id.in_(candidate_run_ids))).all())
        payload = RunLogCleanupRead(
            dry_run=dry_run,
            deleted_runs=len(candidate_run_ids),
            deleted_run_channels=count_for(RunChannel, RunChannel.run_id),
            deleted_results=count_for(Result, Result.run_id),
            deleted_comparisons=count_for(Comparison, Comparison.run_id),
            deleted_reports=count_for(Report, Report.run_id),
            deleted_alerts=count_for(ChannelAlert, ChannelAlert.run_id),
            cleared_scheduled_last_run_refs=len(scheduled_refs),
            skipped_running_runs=active_runs,
            skipped_baseline_runs=skipped_baseline_runs,
        )
    except Exception:
        db.rollback()
        logger.warning("cleanup_run_logs: failed to build cleanup summary", exc_info=True)
        if dry_run:
            return RunLogCleanupRead(
                dry_run=True,
                deleted_runs=len(candidate_run_ids),
                skipped_running_runs=active_runs,
                skipped_baseline_runs=skipped_baseline_runs,
            )
        raise
    if dry_run:
        return payload

    for scheduled in scheduled_refs:
        scheduled.last_run_id = None
    db.execute(delete(ChannelAlert).where(ChannelAlert.run_id.in_(candidate_run_ids)))
    db.execute(delete(RunChannel).where(RunChannel.run_id.in_(candidate_run_ids)))
    db.execute(delete(Result).where(Result.run_id.in_(candidate_run_ids)))
    db.execute(delete(Comparison).where(Comparison.run_id.in_(candidate_run_ids)))
    db.execute(delete(Report).where(Report.run_id.in_(candidate_run_ids)))
    db.execute(delete(Run).where(Run.id.in_(candidate_run_ids)))
    db.commit()
    return payload
