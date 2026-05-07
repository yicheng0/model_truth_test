from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .database import SessionLocal, get_db, init_db
from .models import Channel, Comparison, Report, Result, Run, RunChannel, TestCase, TestSuite
from .schemas import (
    ChannelCreate,
    ChannelRead,
    ChannelUpdate,
    ComparisonRead,
    ManualScoreUpdate,
    ReportRead,
    ResultRead,
    RunChannelRead,
    RunCreate,
    RunRead,
    RunResultsRead,
    TestCaseCreate,
    TestCaseRead,
    TestCaseUpdate,
    TestSuiteCreate,
    TestSuiteRead,
    TestSuiteUpdate,
)
from .services import build_comparisons, build_reports, create_case, create_channel, create_run, create_suite, execute_run, seed_demo_data


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    with SessionLocal() as db:
        seed_demo_data(db)
    yield


app = FastAPI(title="Claude Channel Authenticity Eval", version="0.1.0", lifespan=lifespan)


def cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins or ["http://localhost:5173", "http://127.0.0.1:5173"]


allowed_origins = cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials="*" not in allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health(db: Session = Depends(get_db)) -> dict[str, str]:
    db.scalar(select(TestSuite).limit(1))
    return {"status": "ok", "database": "ok"}


@app.get("/api/channels", response_model=list[ChannelRead])
def list_channels(db: Session = Depends(get_db)) -> list[Channel]:
    return list(db.scalars(select(Channel).order_by(Channel.role, Channel.name)).all())


@app.post("/api/channels", response_model=ChannelRead)
def add_channel(data: ChannelCreate, db: Session = Depends(get_db)) -> Channel:
    return create_channel(db, data)


@app.get("/api/channels/{channel_id}", response_model=ChannelRead)
def get_channel(channel_id: str, db: Session = Depends(get_db)) -> Channel:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    return channel


@app.patch("/api/channels/{channel_id}", response_model=ChannelRead)
def update_channel(channel_id: str, data: ChannelUpdate, db: Session = Depends(get_db)) -> Channel:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(channel, key, value)
    db.commit()
    db.refresh(channel)
    return channel


@app.delete("/api/channels/{channel_id}")
def remove_channel(channel_id: str, db: Session = Depends(get_db)) -> dict[str, bool]:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    db.delete(channel)
    db.commit()
    return {"deleted": True}


@app.post("/api/channels/{channel_id}/health-check")
def channel_health(channel_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    return {
        "channel_id": channel.id,
        "ok": channel.enabled,
        "latency_ms": 380 + len(channel.name) * 8,
        "provider_type": channel.provider_type,
        "message": "MVP health check uses configured metadata; live probes are handled by eval runs.",
    }


@app.get("/api/suites", response_model=list[TestSuiteRead])
def list_suites(db: Session = Depends(get_db)) -> list[TestSuite]:
    return list(db.scalars(select(TestSuite).order_by(TestSuite.name)).all())


@app.get("/api/test-suites", response_model=list[TestSuiteRead])
def list_test_suites_alias(db: Session = Depends(get_db)) -> list[TestSuite]:
    return list_suites(db)


@app.post("/api/test-suites", response_model=TestSuiteRead)
def add_test_suite_alias(data: TestSuiteCreate, db: Session = Depends(get_db)) -> TestSuite:
    return create_suite(db, data)


@app.get("/api/test-suites/{suite_id}", response_model=TestSuiteRead)
def get_test_suite_alias(suite_id: str, db: Session = Depends(get_db)) -> TestSuite:
    suite = db.get(TestSuite, suite_id)
    if not suite:
        raise HTTPException(status_code=404, detail="Test suite not found")
    return suite


@app.patch("/api/test-suites/{suite_id}", response_model=TestSuiteRead)
def update_test_suite_alias(suite_id: str, data: TestSuiteUpdate, db: Session = Depends(get_db)) -> TestSuite:
    suite = db.get(TestSuite, suite_id)
    if not suite:
        raise HTTPException(status_code=404, detail="Test suite not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(suite, key, value)
    db.commit()
    db.refresh(suite)
    return suite


@app.get("/api/suites/{suite_id}/cases", response_model=list[TestCaseRead])
def list_cases(suite_id: str, db: Session = Depends(get_db)) -> list[TestCase]:
    return list(
        db.scalars(
            select(TestCase)
            .where(TestCase.suite_id == suite_id)
            .order_by(TestCase.sort_order, TestCase.module, TestCase.id)
        ).all()
    )


@app.get("/api/test-cases", response_model=list[TestCaseRead])
def list_test_cases_alias(suite_id: str | None = Query(default=None), db: Session = Depends(get_db)) -> list[TestCase]:
    stmt = select(TestCase).order_by(TestCase.sort_order, TestCase.module, TestCase.id)
    if suite_id:
        stmt = stmt.where(TestCase.suite_id == suite_id)
    return list(db.scalars(stmt).all())


@app.post("/api/test-cases", response_model=TestCaseRead)
def add_test_case_alias(data: TestCaseCreate, db: Session = Depends(get_db)) -> TestCase:
    return create_case(db, data)


@app.get("/api/test-cases/{case_id}", response_model=TestCaseRead)
def get_test_case_alias(case_id: str, db: Session = Depends(get_db)) -> TestCase:
    case = db.get(TestCase, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Test case not found")
    return case


@app.patch("/api/test-cases/{case_id}", response_model=TestCaseRead)
def update_test_case_alias(case_id: str, data: TestCaseUpdate, db: Session = Depends(get_db)) -> TestCase:
    case = db.get(TestCase, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Test case not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(case, key, value)
    db.commit()
    db.refresh(case)
    return case


@app.delete("/api/test-cases/{case_id}")
def remove_test_case_alias(case_id: str, db: Session = Depends(get_db)) -> dict[str, bool]:
    case = db.get(TestCase, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Test case not found")
    db.execute(delete(Result).where(Result.test_case_id == case_id))
    db.execute(delete(Comparison).where(Comparison.test_case_id == case_id))
    db.delete(case)
    db.commit()
    return {"deleted": True}


@app.post("/api/eval-runs", response_model=RunRead)
def start_run(data: RunCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)) -> Run:
    run = create_run(db, data)
    background_tasks.add_task(execute_run, SessionLocal, run.id, data.runtime_credentials, data.use_mock)
    return run


@app.get("/api/eval-runs", response_model=list[RunRead])
def list_runs(db: Session = Depends(get_db)) -> list[Run]:
    return list(db.scalars(select(Run).order_by(Run.created_at.desc())).all())


@app.get("/api/runs", response_model=list[RunRead])
def list_runs_alias(db: Session = Depends(get_db)) -> list[Run]:
    return list_runs(db)


@app.post("/api/runs", response_model=RunRead)
def start_run_alias(data: RunCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)) -> Run:
    return start_run(data, background_tasks, db)


@app.get("/api/eval-runs/{run_id}", response_model=RunRead)
def get_run(run_id: str, db: Session = Depends(get_db)) -> Run:
    run = db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@app.get("/api/runs/{run_id}", response_model=RunRead)
def get_run_alias(run_id: str, db: Session = Depends(get_db)) -> Run:
    return get_run(run_id, db)


@app.get("/api/runs/{run_id}/progress")
def run_progress_alias(run_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    run = get_run(run_id, db)
    percent = 100 if run.total_jobs == 0 else round(run.completed_jobs / run.total_jobs * 100, 1)
    return {"run_id": run.id, "status": run.status, "completed_jobs": run.completed_jobs, "total_jobs": run.total_jobs, "percent": percent}


@app.get("/api/eval-runs/{run_id}/results", response_model=RunResultsRead)
def get_run_results(run_id: str, db: Session = Depends(get_db)) -> RunResultsRead:
    run = db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    run_channels = db.scalars(select(RunChannel).where(RunChannel.run_id == run_id).order_by(RunChannel.role_in_run, RunChannel.channel_id)).all()
    results = db.scalars(select(Result).where(Result.run_id == run_id).order_by(Result.test_case_id, Result.channel_id)).all()
    comparisons = db.scalars(select(Comparison).where(Comparison.run_id == run_id).order_by(Comparison.test_case_id)).all()
    reports = db.scalars(select(Report).where(Report.run_id == run_id).order_by(Report.final_score.desc())).all()
    return RunResultsRead(run=run, run_channels=list(run_channels), results=list(results), comparisons=list(comparisons), reports=list(reports))


@app.get("/api/runs/{run_id}/results", response_model=RunResultsRead)
def get_run_results_alias(run_id: str, db: Session = Depends(get_db)) -> RunResultsRead:
    return get_run_results(run_id, db)


@app.get("/api/runs/{run_id}/raw-results", response_model=list[ResultRead])
def get_run_raw_results_alias(run_id: str, db: Session = Depends(get_db)) -> list[Result]:
    get_run(run_id, db)
    return list(db.scalars(select(Result).where(Result.run_id == run_id).order_by(Result.test_case_id, Result.channel_id)).all())


@app.get("/api/runs/{run_id}/comparisons", response_model=list[ComparisonRead])
def get_run_comparisons_alias(run_id: str, db: Session = Depends(get_db)) -> list[Comparison]:
    get_run(run_id, db)
    return list(db.scalars(select(Comparison).where(Comparison.run_id == run_id).order_by(Comparison.test_case_id)).all())


@app.get("/api/runs/{run_id}/comparisons/{test_case_id}", response_model=list[ComparisonRead])
def get_run_case_comparisons_alias(run_id: str, test_case_id: str, db: Session = Depends(get_db)) -> list[Comparison]:
    get_run(run_id, db)
    return list(db.scalars(select(Comparison).where(Comparison.run_id == run_id, Comparison.test_case_id == test_case_id)).all())


@app.post("/api/runs/{run_id}/cancel")
def cancel_run_alias(run_id: str, db: Session = Depends(get_db)) -> dict[str, str]:
    run = get_run(run_id, db)
    if run.status not in {"completed", "failed"}:
        run.status = "canceled"
        db.commit()
    return {"status": run.status}


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: str, db: Session = Depends(get_db)) -> dict[str, bool]:
    run = db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status == "running":
        raise HTTPException(status_code=409, detail="Running runs must be canceled before deletion")
    db.execute(delete(RunChannel).where(RunChannel.run_id == run_id))
    db.execute(delete(Result).where(Result.run_id == run_id))
    db.execute(delete(Comparison).where(Comparison.run_id == run_id))
    db.execute(delete(Report).where(Report.run_id == run_id))
    db.delete(run)
    db.commit()
    return {"deleted": True}


@app.post("/api/runs/{run_id}/generate-report", response_model=list[ReportRead])
def generate_report_alias(run_id: str, db: Session = Depends(get_db)) -> list[Report]:
    get_run(run_id, db)
    build_comparisons(db, run_id)
    build_reports(db, run_id)
    return list(db.scalars(select(Report).where(Report.run_id == run_id).order_by(Report.final_score.desc())).all())


@app.patch("/api/eval-runs/{run_id}/scores/{result_id}", response_model=ResultRead)
def update_score(run_id: str, result_id: str, data: ManualScoreUpdate, db: Session = Depends(get_db)) -> Result:
    result = db.get(Result, result_id)
    if not result or result.run_id != run_id:
        raise HTTPException(status_code=404, detail="Result not found")
    result.score = data.final_score
    if data.labels is not None:
        result.labels = data.labels
    db.commit()
    db.refresh(result)
    return result


@app.post("/api/eval-runs/{run_id}/finalize")
def finalize_run(run_id: str, db: Session = Depends(get_db)) -> dict[str, str]:
    run = db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    build_comparisons(db, run_id)
    build_reports(db, run_id)
    return {"status": "ok"}


@app.post("/api/runs/{run_id}/finalize")
def finalize_run_alias(run_id: str, db: Session = Depends(get_db)) -> dict[str, str]:
    return finalize_run(run_id, db)


@app.get("/api/eval-runs/{run_id}/report.md")
def download_report(run_id: str, db: Session = Depends(get_db)) -> Response:
    reports = db.scalars(select(Report).where(Report.run_id == run_id).order_by(Report.final_score.asc())).all()
    if not reports:
        raise HTTPException(status_code=404, detail="Report not found")
    markdown = "\n\n---\n\n".join(report.markdown or "" for report in reports)
    return Response(markdown, media_type="text/markdown; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{run_id}.md"'})


@app.get("/api/runs/{run_id}/report.md")
def download_report_alias(run_id: str, db: Session = Depends(get_db)) -> Response:
    return download_report(run_id, db)


@app.get("/api/reports", response_model=list[ReportRead])
def list_reports_alias(db: Session = Depends(get_db)) -> list[Report]:
    return list(db.scalars(select(Report).order_by(Report.created_at.desc())).all())


@app.get("/api/reports/{report_id}", response_model=ReportRead)
def get_report_alias(report_id: str, db: Session = Depends(get_db)) -> Report:
    report = db.get(Report, report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return report


@app.get("/api/reports/{report_id}/markdown")
def get_report_markdown_alias(report_id: str, db: Session = Depends(get_db)) -> dict[str, str | None]:
    report = get_report_alias(report_id, db)
    return {"id": report.id, "markdown": report.markdown}
