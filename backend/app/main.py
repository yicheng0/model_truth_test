from __future__ import annotations

import os
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .database import SessionLocal, get_db, init_db
from .models import BaselineResult, BaselineSnapshot, Channel, ChannelAlert, Comparison, Report, Result, Run, RunChannel, ScheduledChannelTest, TestCase, TestSuite
from .schemas import (
    BaselineBuildCreate,
    BaselineResultRead,
    BaselineSnapshotRead,
    BaselineSnapshotUpdate,
    ArenaRunCreate,
    ChannelAlertRead,
    ChannelAlertReviewUpdate,
    ChannelCreate,
    ChannelRead,
    SignatureInteropTestCreate,
    SignatureInteropTestRead,
    ChannelTaxonomySettingRead,
    ChannelTaxonomySettingUpdate,
    ChannelUpdate,
    ComparisonRead,
    EvalScopeJsonlImportCreate,
    FeishuBroadcastSettingRead,
    FeishuBroadcastSettingUpdate,
    FeishuTestMessageRead,
    ManualScoreUpdate,
    ModelRequestTestCreate,
    ModelRequestTestRead,
    ReportRead,
    ReportCompareRead,
    ReportDetailRead,
    ReportSummaryRead,
    ResultRead,
    RunChannelRead,
    RunCreate,
    RunRead,
    RunResultsRead,
    RunSummaryRead,
    SamplePlanCreate,
    SamplePlanRead,
    TestSuiteBundle,
    TestSuiteCoverageRead,
    TestSuiteDiffRead,
    TestSuiteValidationRead,
    ScheduledChannelTestCreate,
    ScheduledChannelTestRead,
    ScheduledChannelTestUpdate,
    SmartPatrolReportRead,
    TestCaseCreate,
    TestCaseRead,
    TestCaseUpdate,
    TestSuiteCreate,
    TestSuiteRead,
    TestSuiteUpdate,
)
from .services import (
    build_comparisons,
    build_reports,
    build_special_run_reports,
    build_run_summary,
    build_smart_patrol_report,
    channel_taxonomy_setting_read,
    channel_alert_read,
    create_alerts_for_run,
    create_baseline_build,
    create_case,
    create_channel,
    create_model_request_test,
    create_run,
    create_scheduled_channel_test,
    create_suite,
    compare_reports,
    export_suite_bundle,
    execute_run,
    execute_scheduled_channel_test,
    fetch_channel_models,
    finalize_baseline_from_run,
    build_sample_plan,
    get_or_create_channel_taxonomy_setting,
    feishu_setting_read,
    get_or_create_feishu_setting,
    get_report_detail,
    list_report_summaries,
    MANUAL_PROBE_MODE,
    MANUAL_PROBE_SUITE_ID,
    refresh_baseline_status,
    import_suite_bundle,
    import_evalscope_jsonl,
    scheduled_test_loop,
    send_alert_notification,
    send_daily_patrol_report,
    send_feishu_test_message,
    seed_demo_data,
    smart_patrol_report_markdown,
    suite_diff,
    suite_coverage,
    test_signature_interop,
    update_channel_taxonomy_setting,
    update_feishu_setting,
    validate_baseline_for_run,
    validate_scheduled_channel_test,
    validate_suite_cases,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    with SessionLocal() as db:
        seed_demo_data(db)
    scheduler_task = None
    if os.getenv("AUTO_SCHEDULER_ENABLED", "true").lower() not in {"0", "false", "no"}:
        scheduler_task = asyncio.create_task(scheduled_test_loop(SessionLocal))
        _app.state.scheduler_task = scheduler_task
    yield
    if scheduler_task:
        scheduler_task.cancel()
        try:
            await scheduler_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Claude Channel Authenticity Eval", version="0.1.0", lifespan=lifespan)


def cors_origins() -> list[str]:
    raw = os.getenv(
        "CORS_ORIGINS",
        ",".join(
            [
                "http://localhost:5173",
                "http://127.0.0.1:5173",
                "http://localhost:5174",
                "http://127.0.0.1:5174",
                "http://localhost:5175",
                "http://127.0.0.1:5175",
            ]
        ),
    )
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins or ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5175", "http://127.0.0.1:5175"]


allowed_origins = cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials="*" not in allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _baseline_reference_conflict(db: Session, baseline_id: str, source_run_id: str | None = None) -> str | None:
    run_stmt = select(Run).where(Run.baseline_snapshot_id == baseline_id)
    if source_run_id:
        run_stmt = run_stmt.where(Run.id != source_run_id)
    if db.scalar(run_stmt.limit(1)):
        return "Baseline snapshot is referenced by existing comparison runs"
    if db.scalar(select(ScheduledChannelTest).where(ScheduledChannelTest.baseline_snapshot_id == baseline_id).limit(1)):
        return "Baseline snapshot is referenced by scheduled tests"
    return None


@app.get("/api/health")
def health(db: Session = Depends(get_db)) -> dict[str, str]:
    db.scalar(select(TestSuite).limit(1))
    return {"status": "ok", "database": "ok"}


@app.get("/api/channels", response_model=list[ChannelRead])
def list_channels(db: Session = Depends(get_db)) -> list[Channel]:
    return list(db.scalars(select(Channel).order_by(Channel.role, Channel.name)).all())


@app.post("/api/channels", response_model=ChannelRead)
def add_channel(data: ChannelCreate, db: Session = Depends(get_db)) -> Channel:
    try:
        return create_channel(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
    if data.is_reference is not None and data.role is None:
        channel.role = "gold" if channel.is_reference else "candidate"
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


@app.post("/api/channels/signature-interop-test", response_model=SignatureInteropTestRead)
async def channel_signature_interop_test(data: SignatureInteropTestCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    source = db.get(Channel, data.source_channel_id)
    relay = db.get(Channel, data.relay_channel_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source channel not found")
    if not relay:
        raise HTTPException(status_code=404, detail="Relay channel not found")
    try:
        return await test_signature_interop(source, relay, data.stream)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/channels/{channel_id}/model-request-test", response_model=ModelRequestTestRead)
async def channel_model_request_test(channel_id: str, data: ModelRequestTestCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    try:
        return await create_model_request_test(db, channel, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/channels/{channel_id}/models", response_model=list[str])
async def channel_models(channel_id: str, db: Session = Depends(get_db)) -> list[str]:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    try:
        return await fetch_channel_models(channel)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/suites", response_model=list[TestSuiteRead])
def list_suites(db: Session = Depends(get_db)) -> list[TestSuite]:
    return list(db.scalars(select(TestSuite).where(TestSuite.id != MANUAL_PROBE_SUITE_ID).order_by(TestSuite.name)).all())


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


@app.post("/api/test-suites/import")
def import_test_suite_bundle(data: TestSuiteBundle, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return import_suite_bundle(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/test-suites/import-evalscope-jsonl")
def import_evalscope_jsonl_bundle(data: EvalScopeJsonlImportCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return import_evalscope_jsonl(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/test-suites/{suite_id}/export")
def export_test_suite_bundle(suite_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return export_suite_bundle(db, suite_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/test-suites/{suite_id}/diff", response_model=TestSuiteDiffRead)
def diff_test_suite_bundle(suite_id: str, against: str = Query(...), db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return suite_diff(db, suite_id, against)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/test-suites/{suite_id}/validate", response_model=TestSuiteValidationRead)
def validate_test_suite_cases(suite_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return validate_suite_cases(db, suite_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/test-suites/{suite_id}/coverage", response_model=TestSuiteCoverageRead)
def get_test_suite_coverage(suite_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return suite_coverage(db, suite_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


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
    else:
        stmt = stmt.where(TestCase.suite_id != MANUAL_PROBE_SUITE_ID, TestCase.module != MANUAL_PROBE_MODE)
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
    try:
        run = create_run(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    background_tasks.add_task(
        execute_run,
        SessionLocal,
        run.id,
        data.runtime_credentials,
        data.use_mock,
        benchmark_config=data.benchmark_config.model_dump() if data.benchmark_config else None,
    )
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


@app.post("/api/runs/sample-plan", response_model=SamplePlanRead)
def preview_run_sample_plan(data: SamplePlanCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return build_sample_plan(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/runs/arena", response_model=RunRead)
def start_arena_run(data: ArenaRunCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)) -> Run:
    channel_ids = {"candidate": data.candidate_channel_ids}
    if data.judge_channel_id and not db.get(Channel, data.judge_channel_id):
        raise HTTPException(status_code=404, detail="Judge channel not found")
    try:
        run = create_run(
            db,
            RunCreate(
                name=data.name,
                suite_id=data.suite_id,
                channel_ids=channel_ids,
                repeat_count=data.repeat_count,
                concurrency=data.concurrency,
                use_mock=data.use_mock,
                mode="arena_comparison",
                test_scope=data.test_scope,
                runtime_credentials=data.runtime_credentials,
                benchmark_config=None,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    background_tasks.add_task(
        execute_run,
        SessionLocal,
        run.id,
        data.runtime_credentials,
        data.use_mock,
        arena_config={"judge_channel_id": data.judge_channel_id, "judge_mode": data.judge_mode, "judge_rubric": data.judge_rubric},
    )
    return run


@app.get("/api/baselines", response_model=list[BaselineSnapshotRead])
def list_baselines(
    suite_id: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> list[BaselineSnapshot]:
    stmt = select(BaselineSnapshot).order_by(BaselineSnapshot.created_at.desc())
    if suite_id:
        stmt = stmt.where(BaselineSnapshot.suite_id == suite_id)
    if status:
        stmt = stmt.where(BaselineSnapshot.status == status)
    snapshots = list(db.scalars(stmt).all())
    for snapshot in snapshots:
        refresh_baseline_status(db, snapshot)
    return snapshots


@app.get("/api/baselines/{baseline_id}", response_model=BaselineSnapshotRead)
def get_baseline(baseline_id: str, db: Session = Depends(get_db)) -> BaselineSnapshot:
    snapshot = db.get(BaselineSnapshot, baseline_id)
    if not snapshot:
        raise HTTPException(status_code=404, detail="Baseline not found")
    return refresh_baseline_status(db, snapshot)


@app.patch("/api/baselines/{baseline_id}", response_model=BaselineSnapshotRead)
def update_baseline(baseline_id: str, data: BaselineSnapshotUpdate, db: Session = Depends(get_db)) -> BaselineSnapshot:
    snapshot = db.get(BaselineSnapshot, baseline_id)
    if not snapshot:
        raise HTTPException(status_code=404, detail="Baseline not found")
    values = data.model_dump(exclude_unset=True)
    if "name" in values:
        name = (values["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="Baseline name cannot be empty")
        snapshot.name = name
    db.commit()
    db.refresh(snapshot)
    return refresh_baseline_status(db, snapshot)


@app.delete("/api/baselines/{baseline_id}")
def delete_baseline(baseline_id: str, db: Session = Depends(get_db)) -> dict[str, bool]:
    snapshot = db.get(BaselineSnapshot, baseline_id)
    if not snapshot:
        raise HTTPException(status_code=404, detail="Baseline not found")
    conflict = _baseline_reference_conflict(db, baseline_id, snapshot.source_run_id)
    if conflict:
        raise HTTPException(status_code=409, detail=conflict)
    for run in db.scalars(select(Run).where(Run.baseline_snapshot_id == baseline_id)).all():
        run.baseline_snapshot_id = None
    db.execute(delete(BaselineResult).where(BaselineResult.baseline_snapshot_id == baseline_id))
    db.delete(snapshot)
    db.commit()
    return {"deleted": True}


@app.get("/api/baselines/{baseline_id}/results", response_model=list[BaselineResultRead])
def get_baseline_results(baseline_id: str, db: Session = Depends(get_db)) -> list[BaselineResult]:
    get_baseline(baseline_id, db)
    return list(
        db.scalars(
            select(BaselineResult)
            .where(BaselineResult.baseline_snapshot_id == baseline_id)
            .order_by(BaselineResult.test_case_id, BaselineResult.channel_id, BaselineResult.attempt_index)
        ).all()
    )


@app.post("/api/baselines/build", response_model=RunRead)
def build_baseline(data: BaselineBuildCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)) -> Run:
    try:
        run, _snapshot = create_baseline_build(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    background_tasks.add_task(
        execute_run,
        SessionLocal,
        run.id,
        data.runtime_credentials,
        data.use_mock,
    )
    return run


@app.post("/api/baselines/{baseline_id}/validate", response_model=BaselineSnapshotRead)
def validate_baseline(baseline_id: str, db: Session = Depends(get_db)) -> BaselineSnapshot:
    snapshot = get_baseline(baseline_id, db)
    try:
        return validate_baseline_for_run(db, baseline_id, snapshot.suite_id)
    except ValueError:
        db.refresh(snapshot)
        return snapshot


@app.get("/api/settings/feishu-broadcast", response_model=FeishuBroadcastSettingRead)
def get_feishu_broadcast_setting(db: Session = Depends(get_db)) -> dict[str, object]:
    return feishu_setting_read(get_or_create_feishu_setting(db))


@app.patch("/api/settings/feishu-broadcast", response_model=FeishuBroadcastSettingRead)
def patch_feishu_broadcast_setting(data: FeishuBroadcastSettingUpdate, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        setting = update_feishu_setting(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return feishu_setting_read(setting)


@app.post("/api/settings/feishu-broadcast/test", response_model=FeishuTestMessageRead)
async def test_feishu_broadcast_setting(db: Session = Depends(get_db)) -> dict[str, object]:
    return await send_feishu_test_message(db)


@app.get("/api/settings/channel-taxonomy", response_model=ChannelTaxonomySettingRead)
def get_channel_taxonomy_setting(db: Session = Depends(get_db)) -> dict[str, object]:
    return channel_taxonomy_setting_read(get_or_create_channel_taxonomy_setting(db))


@app.patch("/api/settings/channel-taxonomy", response_model=ChannelTaxonomySettingRead)
def patch_channel_taxonomy_setting(data: ChannelTaxonomySettingUpdate, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        setting = update_channel_taxonomy_setting(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return channel_taxonomy_setting_read(setting)


@app.get("/api/scheduled-tests", response_model=list[ScheduledChannelTestRead])
def list_scheduled_tests(
    channel_id: str | None = Query(default=None),
    enabled: bool | None = Query(default=None),
    db: Session = Depends(get_db),
) -> list[ScheduledChannelTest]:
    stmt = select(ScheduledChannelTest).order_by(ScheduledChannelTest.enabled.desc(), ScheduledChannelTest.next_run_at)
    if channel_id:
        stmt = stmt.where(ScheduledChannelTest.channel_id == channel_id)
    if enabled is not None:
        stmt = stmt.where(ScheduledChannelTest.enabled.is_(enabled))
    return list(db.scalars(stmt).all())


@app.post("/api/scheduled-tests", response_model=ScheduledChannelTestRead)
def add_scheduled_test(data: ScheduledChannelTestCreate, db: Session = Depends(get_db)) -> ScheduledChannelTest:
    try:
        return create_scheduled_channel_test(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/scheduled-tests/report", response_model=SmartPatrolReportRead)
def get_smart_patrol_report(
    from_at: datetime | None = Query(default=None, alias="from"),
    to_at: datetime | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    to_at = to_at or datetime.now(timezone.utc)
    from_at = from_at or (to_at - timedelta(days=7))
    return build_smart_patrol_report(db, from_at, to_at)


@app.get("/api/scheduled-tests/report.md")
def download_smart_patrol_report(
    from_at: datetime | None = Query(default=None, alias="from"),
    to_at: datetime | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
) -> Response:
    to_at = to_at or datetime.now(timezone.utc)
    from_at = from_at or (to_at - timedelta(days=7))
    report = build_smart_patrol_report(db, from_at, to_at)
    return Response(
        smart_patrol_report_markdown(report),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="smart-patrol-report.md"'},
    )


@app.post("/api/scheduled-tests/report/send-daily", response_model=FeishuTestMessageRead)
async def send_smart_patrol_daily_report() -> dict[str, object]:
    return await send_daily_patrol_report(SessionLocal, force=True)


@app.get("/api/scheduled-tests/{scheduled_id}", response_model=ScheduledChannelTestRead)
def get_scheduled_test(scheduled_id: str, db: Session = Depends(get_db)) -> ScheduledChannelTest:
    scheduled = db.get(ScheduledChannelTest, scheduled_id)
    if not scheduled:
        raise HTTPException(status_code=404, detail="Scheduled test not found")
    return scheduled


@app.patch("/api/scheduled-tests/{scheduled_id}", response_model=ScheduledChannelTestRead)
def update_scheduled_test(scheduled_id: str, data: ScheduledChannelTestUpdate, db: Session = Depends(get_db)) -> ScheduledChannelTest:
    scheduled = db.get(ScheduledChannelTest, scheduled_id)
    if not scheduled:
        raise HTTPException(status_code=404, detail="Scheduled test not found")
    previous = {
        "channel_id": scheduled.channel_id,
        "suite_id": scheduled.suite_id,
        "baseline_snapshot_id": scheduled.baseline_snapshot_id,
        "interval_minutes": scheduled.interval_minutes,
        "test_scope": scheduled.test_scope,
    }
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(scheduled, key, value)
    if scheduled.enabled and scheduled.next_run_at is None:
        scheduled.next_run_at = datetime.now(timezone.utc) + timedelta(minutes=max(5, scheduled.interval_minutes))
    try:
        validate_scheduled_channel_test(db, scheduled)
    except ValueError as exc:
        for key, value in previous.items():
            setattr(scheduled, key, value)
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if "interval_minutes" in data.model_fields_set and "next_run_at" not in data.model_fields_set:
        scheduled.next_run_at = datetime.now(timezone.utc) + timedelta(minutes=max(5, scheduled.interval_minutes))
    db.commit()
    db.refresh(scheduled)
    return scheduled


@app.delete("/api/scheduled-tests/{scheduled_id}")
def delete_scheduled_test(scheduled_id: str, db: Session = Depends(get_db)) -> dict[str, bool]:
    scheduled = db.get(ScheduledChannelTest, scheduled_id)
    if not scheduled:
        raise HTTPException(status_code=404, detail="Scheduled test not found")
    for alert in db.scalars(select(ChannelAlert).where(ChannelAlert.scheduled_test_id == scheduled_id)).all():
        alert.scheduled_test_id = None
    db.delete(scheduled)
    db.commit()
    return {"deleted": True}


@app.post("/api/scheduled-tests/{scheduled_id}/run-now", response_model=ScheduledChannelTestRead)
async def run_scheduled_test_now(scheduled_id: str, db: Session = Depends(get_db)) -> ScheduledChannelTestRead:
    scheduled = get_scheduled_test(scheduled_id, db)
    try:
        validate_scheduled_channel_test(db, scheduled)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    scheduled.last_status = "queued"
    scheduled.last_error = None
    db.commit()
    db.refresh(scheduled)
    await execute_scheduled_channel_test(SessionLocal, scheduled.id)
    with SessionLocal() as read_db:
        refreshed = read_db.get(ScheduledChannelTest, scheduled.id)
        if not refreshed:
            raise HTTPException(status_code=404, detail="Scheduled test not found")
        return ScheduledChannelTestRead.model_validate(refreshed)


@app.get("/api/alerts", response_model=list[ChannelAlertRead])
def list_alerts(
    status: str | None = Query(default=None),
    channel_id: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    stmt = select(ChannelAlert).order_by(ChannelAlert.created_at.desc())
    if status:
        stmt = stmt.where(ChannelAlert.status == status)
    if channel_id:
        stmt = stmt.where(ChannelAlert.channel_id == channel_id)
    return [channel_alert_read(db, alert) for alert in db.scalars(stmt).all()]


@app.get("/api/alerts/{alert_id}", response_model=ChannelAlertRead)
def get_alert(alert_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    alert = db.get(ChannelAlert, alert_id)
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    return channel_alert_read(db, alert)


@app.patch("/api/alerts/{alert_id}/review", response_model=ChannelAlertRead)
def review_alert(alert_id: str, data: ChannelAlertReviewUpdate, db: Session = Depends(get_db)) -> dict[str, object]:
    alert = db.get(ChannelAlert, alert_id)
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    if data.status not in {"confirmed_issue", "false_positive", "resolved"}:
        raise HTTPException(status_code=400, detail="Unsupported review status")
    alert.status = data.status
    alert.reviewer_name = data.reviewer_name
    alert.review_note = data.review_note
    alert.reviewed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(alert)
    return channel_alert_read(db, alert)


@app.post("/api/alerts/{alert_id}/resend-notification", response_model=ChannelAlertRead)
async def resend_alert_notification(alert_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    if not db.get(ChannelAlert, alert_id):
        raise HTTPException(status_code=404, detail="Alert not found")
    alert = await send_alert_notification(SessionLocal, alert_id)
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    return channel_alert_read(db, alert)


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


@app.get("/api/runs/{run_id}/summary", response_model=RunSummaryRead)
def get_run_summary_alias(run_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return build_run_summary(db, run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/eval-runs/{run_id}/results", response_model=RunResultsRead)
def get_run_results(run_id: str, db: Session = Depends(get_db)) -> RunResultsRead:
    run = db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    run_channels = db.scalars(select(RunChannel).where(RunChannel.run_id == run_id).order_by(RunChannel.role_in_run, RunChannel.channel_id)).all()
    results = db.scalars(select(Result).where(Result.run_id == run_id).order_by(Result.test_case_id, Result.channel_id)).all()
    comparisons = db.scalars(select(Comparison).where(Comparison.run_id == run_id).order_by(Comparison.test_case_id)).all()
    reports = db.scalars(select(Report).where(Report.run_id == run_id).order_by(Report.final_score.desc())).all()
    baseline_snapshot = db.get(BaselineSnapshot, run.baseline_snapshot_id) if run.baseline_snapshot_id else None
    baseline_results = []
    if baseline_snapshot:
        refresh_baseline_status(db, baseline_snapshot)
        baseline_results = list(
            db.scalars(
                select(BaselineResult)
                .where(BaselineResult.baseline_snapshot_id == baseline_snapshot.id)
                .order_by(BaselineResult.test_case_id, BaselineResult.channel_id, BaselineResult.attempt_index)
            ).all()
        )
    return RunResultsRead(
        run=run,
        run_channels=list(run_channels),
        results=list(results),
        comparisons=list(comparisons),
        reports=list(reports),
        baseline_snapshot=baseline_snapshot,
        baseline_results=baseline_results,
    )


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
    if run.status in {"pending", "running"}:
        run.status = "canceled"
        run.finished_at = datetime.now(timezone.utc)
        db.commit()
    return {"status": run.status}


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: str, db: Session = Depends(get_db)) -> dict[str, bool]:
    run = db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status == "running":
        raise HTTPException(status_code=409, detail="Running runs must be canceled before deletion")
    source_snapshots = list(db.scalars(select(BaselineSnapshot).where(BaselineSnapshot.source_run_id == run_id)).all())
    for snapshot in source_snapshots:
        conflict = _baseline_reference_conflict(db, snapshot.id, run_id)
        if conflict:
            raise HTTPException(status_code=409, detail=conflict)
    db.execute(delete(RunChannel).where(RunChannel.run_id == run_id))
    db.execute(delete(Result).where(Result.run_id == run_id))
    db.execute(delete(Comparison).where(Comparison.run_id == run_id))
    db.execute(delete(Report).where(Report.run_id == run_id))
    for snapshot in source_snapshots:
        db.execute(delete(BaselineResult).where(BaselineResult.baseline_snapshot_id == snapshot.id))
        db.delete(snapshot)
    db.delete(run)
    db.commit()
    return {"deleted": True}


@app.post("/api/runs/{run_id}/generate-report", response_model=list[ReportRead])
def generate_report_alias(run_id: str, db: Session = Depends(get_db)) -> list[Report]:
    run = get_run(run_id, db)
    build_comparisons(db, run_id, run.baseline_snapshot_id)
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
    if run.mode == "baseline_build":
        finalize_baseline_from_run(db, run_id)
    elif run.mode in {"performance_benchmark", "arena_comparison"}:
        build_special_run_reports(db, run_id)
    else:
        build_comparisons(db, run_id, run.baseline_snapshot_id)
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


@app.get("/api/reports/summary", response_model=list[ReportSummaryRead])
def list_report_summary_alias(db: Session = Depends(get_db)) -> list[dict[str, object]]:
    return list_report_summaries(db)


@app.get("/api/reports/compare", response_model=ReportCompareRead)
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


@app.get("/api/reports/{report_id}/detail", response_model=ReportDetailRead)
def get_report_detail_alias(report_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    detail = get_report_detail(db, report_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Report not found")
    return detail


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
