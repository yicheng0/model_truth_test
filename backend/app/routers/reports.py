from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..admin import require_admin
from ..database import get_db
from ..models import ChannelAlert, Report
from ..schemas import ReportCompareRead, ReportDetailRead, ReportRead, ReportSummaryRead
from ..services import compare_reports, get_report_detail, hydrate_report_markdown, list_report_summaries


router = APIRouter()


@router.get("/api/reports", response_model=list[ReportRead])
def list_reports_alias(db: Session = Depends(get_db)) -> list[Report]:
    return list(db.scalars(select(Report).order_by(Report.created_at.desc())).all())


def _delete_report_by_id(db: Session, report_id: str) -> bool:
    report = db.get(Report, report_id)
    if not report:
        return False
    db.execute(delete(ChannelAlert).where(ChannelAlert.report_id == report_id))
    db.delete(report)
    return True


@router.post("/api/reports/bulk-delete")
def bulk_delete_reports(
    payload: dict[str, list[str]] = Body(...),
    _admin: None = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    report_ids = [str(item).strip() for item in payload.get("ids", []) if str(item).strip()]
    if not report_ids:
        raise HTTPException(status_code=400, detail="Select at least one report")
    deleted = 0
    missing: list[str] = []
    for report_id in dict.fromkeys(report_ids):
        if _delete_report_by_id(db, report_id):
            deleted += 1
        else:
            missing.append(report_id)
    db.commit()
    return {"deleted": deleted, "missing": missing}


@router.delete("/api/reports/{report_id}")
def delete_report_alias(
    report_id: str,
    _admin: None = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    if not _delete_report_by_id(db, report_id):
        raise HTTPException(status_code=404, detail="Report not found")
    db.commit()
    return {"deleted": True}


@router.get("/api/reports/summary", response_model=list[ReportSummaryRead])
def list_report_summary_alias(db: Session = Depends(get_db)) -> list[dict[str, object]]:
    return list_report_summaries(db)


@router.get("/api/reports/compare", response_model=ReportCompareRead)
def compare_reports_alias(ids: str = Query(..., description="Comma-separated report ids, 2-3 reports"), db: Session = Depends(get_db)) -> dict[str, object]:
    report_ids = [item.strip() for item in ids.split(",") if item.strip()]
    if len(report_ids) < 2:
        raise HTTPException(status_code=400, detail="Select at least 2 reports")
    if len(report_ids) > 3:
        raise HTTPException(status_code=400, detail="Select at most 3 reports")
    try:
        return compare_reports(db, report_ids)
    except ValueError as exc:
        if "modes must match" in str(exc):
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/api/reports/{report_id}/detail", response_model=ReportDetailRead)
def get_report_detail_alias(report_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    detail = get_report_detail(db, report_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Report not found")
    report = db.get(Report, report_id)
    if report and hydrate_report_markdown(db, report):
        db.commit()
        detail["report"] = ReportRead.model_validate(report)
    return detail


@router.get("/api/reports/{report_id}", response_model=ReportRead)
def get_report_alias(report_id: str, db: Session = Depends(get_db)) -> Report:
    report = db.get(Report, report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    if hydrate_report_markdown(db, report):
        db.commit()
    return report


@router.get("/api/reports/{report_id}/markdown")
def get_report_markdown_alias(report_id: str, db: Session = Depends(get_db)) -> dict[str, str | None]:
    report = get_report_alias(report_id, db)
    return {"id": report.id, "markdown": report.markdown}
