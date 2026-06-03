from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..admin import require_admin
from ..database import get_db
from ..models import Comparison, Result, TestCase, TestSuite
from ..schemas import (
    EvalScopeJsonlImportCreate,
    TestCaseCreate,
    TestCaseRead,
    TestCaseUpdate,
    TestSuiteBundle,
    TestSuiteCoverageRead,
    TestSuiteCreate,
    TestSuiteDiffRead,
    TestSuiteRead,
    TestSuiteUpdate,
    TestSuiteValidationRead,
)
from ..seed_utils import ensure_seed_data_when_empty
from ..services import (
    MANUAL_PROBE_MODE,
    MANUAL_PROBE_SUITE_ID,
    create_case,
    create_suite,
    export_suite_bundle,
    import_evalscope_jsonl,
    import_suite_bundle,
    suite_coverage,
    suite_diff,
    validate_suite_cases,
)


router = APIRouter()


@router.get("/api/suites", response_model=list[TestSuiteRead])
def list_suites(db: Session = Depends(get_db)) -> list[TestSuite]:
    ensure_seed_data_when_empty(db, TestSuite)
    return list(db.scalars(select(TestSuite).where(TestSuite.id != MANUAL_PROBE_SUITE_ID).order_by(TestSuite.name)).all())


@router.get("/api/test-suites", response_model=list[TestSuiteRead])
def list_test_suites_alias(db: Session = Depends(get_db)) -> list[TestSuite]:
    return list_suites(db)


@router.post("/api/test-suites", response_model=TestSuiteRead)
def add_test_suite_alias(data: TestSuiteCreate, db: Session = Depends(get_db)) -> TestSuite:
    return create_suite(db, data)


@router.get("/api/test-suites/{suite_id}", response_model=TestSuiteRead)
def get_test_suite_alias(suite_id: str, db: Session = Depends(get_db)) -> TestSuite:
    suite = db.get(TestSuite, suite_id)
    if not suite:
        raise HTTPException(status_code=404, detail="Test suite not found")
    return suite


@router.patch("/api/test-suites/{suite_id}", response_model=TestSuiteRead)
def update_test_suite_alias(suite_id: str, data: TestSuiteUpdate, db: Session = Depends(get_db)) -> TestSuite:
    suite = db.get(TestSuite, suite_id)
    if not suite:
        raise HTTPException(status_code=404, detail="Test suite not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(suite, key, value)
    db.commit()
    db.refresh(suite)
    return suite


@router.post("/api/test-suites/import")
def import_test_suite_bundle(data: TestSuiteBundle, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return import_suite_bundle(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/test-suites/import-evalscope-jsonl")
def import_evalscope_jsonl_bundle(data: EvalScopeJsonlImportCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return import_evalscope_jsonl(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/test-suites/{suite_id}/export")
def export_test_suite_bundle(suite_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return export_suite_bundle(db, suite_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/api/test-suites/{suite_id}/diff", response_model=TestSuiteDiffRead)
def diff_test_suite_bundle(suite_id: str, against: str = Query(...), db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return suite_diff(db, suite_id, against)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/api/test-suites/{suite_id}/validate", response_model=TestSuiteValidationRead)
def validate_test_suite_cases(suite_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return validate_suite_cases(db, suite_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/api/test-suites/{suite_id}/coverage", response_model=TestSuiteCoverageRead)
def get_test_suite_coverage(suite_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return suite_coverage(db, suite_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/api/suites/{suite_id}/cases", response_model=list[TestCaseRead])
def list_cases(suite_id: str, db: Session = Depends(get_db)) -> list[TestCase]:
    ensure_seed_data_when_empty(db, TestCase)
    return list(
        db.scalars(
            select(TestCase)
            .where(TestCase.suite_id == suite_id)
            .order_by(TestCase.sort_order, TestCase.module, TestCase.id)
        ).all()
    )


@router.get("/api/test-cases", response_model=list[TestCaseRead])
def list_test_cases_alias(suite_id: str | None = Query(default=None), db: Session = Depends(get_db)) -> list[TestCase]:
    ensure_seed_data_when_empty(db, TestCase)
    stmt = select(TestCase).order_by(TestCase.sort_order, TestCase.module, TestCase.id)
    if suite_id:
        stmt = stmt.where(TestCase.suite_id == suite_id)
    else:
        stmt = stmt.where(TestCase.suite_id != MANUAL_PROBE_SUITE_ID, TestCase.module != MANUAL_PROBE_MODE)
    return list(db.scalars(stmt).all())


@router.post("/api/test-cases", response_model=TestCaseRead)
def add_test_case_alias(data: TestCaseCreate, db: Session = Depends(get_db)) -> TestCase:
    return create_case(db, data)


@router.get("/api/test-cases/{case_id}", response_model=TestCaseRead)
def get_test_case_alias(case_id: str, db: Session = Depends(get_db)) -> TestCase:
    case = db.get(TestCase, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Test case not found")
    return case


@router.patch("/api/test-cases/{case_id}", response_model=TestCaseRead)
def update_test_case_alias(case_id: str, data: TestCaseUpdate, db: Session = Depends(get_db)) -> TestCase:
    case = db.get(TestCase, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Test case not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(case, key, value)
    db.commit()
    db.refresh(case)
    return case


@router.delete("/api/test-cases/{case_id}")
def remove_test_case_alias(
    case_id: str,
    _admin: None = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    case = db.get(TestCase, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Test case not found")
    db.execute(delete(Result).where(Result.test_case_id == case_id))
    db.execute(delete(Comparison).where(Comparison.test_case_id == case_id))
    db.delete(case)
    db.commit()
    return {"deleted": True}
