from __future__ import annotations

import logging

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import Channel, TestCase, TestSuite
from .services import seed_demo_data
from .suite_seed import DEFAULT_SUITE_ID, default_cases


logger = logging.getLogger(__name__)


def ensure_seed_data_when_empty(db: Session, model: type | None = None) -> None:
    """Re-seed when a requested seed table is empty or a fresh DB missed lifespan seed."""
    channels_empty = not db.scalar(select(func.count()).select_from(Channel))
    suites_empty = not db.scalar(select(func.count()).select_from(TestSuite))
    model_empty = bool(model and not db.scalar(select(func.count()).select_from(model)))
    default_case_ids = [case["id"] for case in default_cases()]
    default_suite_missing = db.get(TestSuite, DEFAULT_SUITE_ID) is None
    default_cases_missing = bool(
        default_case_ids
        and db.scalar(select(func.count()).select_from(TestCase).where(TestCase.id.in_(default_case_ids))) < len(default_case_ids)
    )
    if model_empty or (channels_empty and suites_empty) or default_suite_missing or default_cases_missing:
        logger.warning("Core tables empty - triggering emergency re-seed")
        seed_demo_data(db)
