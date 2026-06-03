from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..admin import require_admin
from ..database import get_db
from ..models import Channel, TestCase, TestSuite
from ..services import seed_demo_data


router = APIRouter()
logger = logging.getLogger(__name__)


def seed_status_payload(db: Session) -> dict[str, object]:
    return {
        "channels": db.scalar(select(func.count()).select_from(Channel)),
        "test_suites": db.scalar(select(func.count()).select_from(TestSuite)),
        "test_cases": db.scalar(select(func.count()).select_from(TestCase)),
        "builtin_suite_exists": db.scalar(select(TestSuite).where(TestSuite.id == "claude_full_35")) is not None,
    }


def reseed_payload(db: Session) -> dict[str, object]:
    before = seed_status_payload(db)
    try:
        seed_demo_data(db)
    except Exception as exc:
        logger.exception("Seed recovery failed")
        raise HTTPException(status_code=500, detail=f"Reseed failed: {exc}") from exc
    return {"ok": True, "before": before, "after": seed_status_payload(db)}


@router.get("/api/seed-status")
def public_seed_status(_admin: None = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, object]:
    """Return current seed data counts for diagnostics."""
    return seed_status_payload(db)


@router.post("/api/reseed")
def public_reseed(_admin: None = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, object]:
    """Create missing built-in seed data without deleting or overwriting existing rows."""
    return reseed_payload(db)


@router.get("/api/admin/seed-status")
def admin_seed_status(
    _admin: None = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Return current seed data counts for diagnostics."""
    return seed_status_payload(db)


@router.post("/api/admin/reseed")
def admin_reseed(
    _admin: None = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Re-run seed to create any missing built-in data."""
    return reseed_payload(db)
