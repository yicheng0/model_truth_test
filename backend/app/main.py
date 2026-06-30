from __future__ import annotations

from collections import defaultdict
import asyncio
import logging
import uuid
import os
import inspect
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import time as time_module
from fastapi import BackgroundTasks, Body, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .admin import require_admin, require_admin_if_configured, require_configured_admin
from .audit import audit_actor, audit_log_read, record_audit_log, scheduled_test_audit_summary
from .database import SessionLocal, get_db, init_db
from .claude_code_check import claude_code_check_steps, claude_code_status, run_claude_code_check, run_claude_code_check_with_progress
from .job_store import InMemoryJobStore
from .models import AuditLog, BaselineResult, BaselineSnapshot, Channel, ChannelAlert, ClaudeCodeEvidence, Comparison, PatrolJob, PatrolJobAttempt, Report, Result, Run, RunChannel, ScheduledChannelTest, TestCase, TestSuite
from .restored_seed import restored_seed_data
from .suite_seed import DEFAULT_SUITE_ID, default_cases
from .schemas import (
    BaselineBuildCreate,
    BaselineResultRead,
    BaselineSnapshotRead,
    BaselineSnapshotUpdate,
    ArenaRunCreate,
    AuditLogRead,
    ChannelAlertRead,
    ChannelAlertReviewUpdate,
    ClaudeCodeCheckCreate,
    ClaudeCodeEvidenceListItemRead,
    ClaudeCodeEvidenceRead,
    ClaudeCodeJobCreateRead,
    ClaudeCodeJobStatusRead,
    ClaudeCodeCheckRead,
    ClaudeCodeCheckStatusRead,
    ClaudeCodeEphemeralTestCreate,
    ClaudeCodeSourceChannelRead,
    ClaudeCodeTestCreate,
    ClaudeCodeTestRead,
    BulkDeleteRequest,
    CacheHitRateJobCreateRead,
    CacheHitRateJobStatusRead,
    CacheHitRateTestCreate,
    ChannelTaxonomySettingRead,
    ChannelTaxonomySettingUpdate,
    ComparisonRead,
    FeishuBroadcastSettingRead,
    FeishuBroadcastSettingUpdate,
    FeishuTestMessageRead,
    ManualScoreUpdate,
    ReportRead,
    ResultRead,
    RunChannelRead,
    RunCreate,
    RunRead,
    RunResultsRead,
    RunSummaryRead,
    SamplePlanCreate,
    SamplePlanRead,
    ScheduledChannelTestCreate,
    ScheduledChannelTestRead,
    ScheduledTestHealthRead,
    ScheduledChannelTestUpdate,
    SmartPatrolReportRead,
)
from .services import (
    _claude_code_probe_configs,
    _claude_code_section_for_category,
    build_comparisons,
    build_reports,
    build_special_run_reports,
    build_run_summary,
    build_smart_patrol_report,
    channel_taxonomy_setting_read,
    channel_alert_read,
    create_alerts_for_run,
    create_claude_code_evidence,
    create_claude_code_test,
    create_baseline_build,
    claude_code_source_channels,
    claude_code_evidence_detail,
    claude_code_evidence_list,
    create_cache_hit_rate_test,
    create_run,
    create_scheduled_channel_test,
    claim_scheduled_test,
    execute_run,
    execute_scheduled_channel_test,
    finalize_baseline_from_run,
    build_sample_plan,
    get_or_create_channel_taxonomy_setting,
    feishu_setting_read,
    get_or_create_feishu_setting,
    list_channel_alerts,
    refresh_baseline_status,
    next_run_for_scheduled_test,
    recover_stale_scheduled_tests,
    scheduler_enabled,
    scheduled_tests_health,
    scheduled_test_loop,
    scheduled_channel_test_read,
    send_alert_notification,
    send_daily_patrol_report,
    send_feishu_test_message,
    seed_demo_data,
    hydrate_report_markdown,
    smart_patrol_report_markdown,
    update_channel_taxonomy_setting,
    update_feishu_setting,
    validate_baseline_for_run,
    validate_scheduled_channel_test,
)
from .redaction import redact_text
from .routers.channels import router as channels_router
from .routers.reports import router as reports_router
from .routers.seed import router as seed_router
from .routers.suites import router as suites_router
from .routers.system import router as system_router
from .routers.new_api import router as new_api_router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    init_db()
    with SessionLocal() as db:
        try:
            seed_demo_data(db)
            recovered = recover_stale_scheduled_tests(db)
            if recovered:
                logger.warning("Recovered stale scheduled tests on startup count=%d", recovered)
            logger.info("Seed data initialized successfully")
        except Exception:
            logger.exception("Seed data initialization failed — app will continue but data may be incomplete")
    scheduler_task = None
    if scheduler_enabled():
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
logger = logging.getLogger(__name__)
app.include_router(channels_router)
app.include_router(reports_router)
app.include_router(seed_router)
app.include_router(suites_router)
app.include_router(system_router)
app.include_router(new_api_router)


JOB_TTL = timedelta(hours=6)
CLAUDE_CODE_JOB_STORE = InMemoryJobStore(ttl=JOB_TTL)
CLAUDE_CODE_JOB_LOCK = asyncio.Lock()
CACHE_HIT_RATE_JOB_STORE = InMemoryJobStore(ttl=JOB_TTL)
CACHE_HIT_RATE_JOB_LOCK = asyncio.Lock()
JOB_NOT_FOUND_DETAIL = "任务不存在，可能是服务重启或任务状态已过期，请重新发起检测。"


def _job_percent(completed_count: int, total_count: int) -> float:
    if total_count <= 0:
        return 0.0
    return round(min(100.0, max(0.0, completed_count / total_count * 100.0)), 1)


def _relay_job_sections(probes: list[dict[str, object]]) -> list[dict[str, object]]:
    ordered = ["fingerprint", "structure", "behavior", "signature", "multimodal", "web_capability"]
    titles = {
        "fingerprint": "ClaudeCode 兼容指纹",
        "structure": "Claude 基础结构",
        "behavior": "行为验证",
        "signature": "ClaudeCode / Thinking Signature",
        "multimodal": "能力参考：多模态",
        "web_capability": "能力参考：Web",
    }
    grouped: dict[str, list[dict[str, object]]] = defaultdict(list)
    for probe in probes:
        section = str(probe.get("section") or "")
        if section:
            grouped[section].append(probe)
    sections = []
    for key in ordered:
        items = grouped.get(key, [])
        if not items:
            continue
        statuses = {str(item.get("status")) for item in items}
        if "fail" in statuses and key not in {"multimodal", "web_capability"}:
            status = "fail"
        elif "warning" in statuses or ("fail" in statuses and key in {"multimodal", "web_capability"}):
            status = "warning"
        elif statuses == {"skipped"}:
            status = "skipped"
        elif "running" in statuses:
            status = "running"
        elif "queued" in statuses:
            status = "queued"
        else:
            status = "pass"
        completed_scores = [float(item.get("score") or 0) for item in items if str(item.get("status")) not in {"queued", "running", "skipped"}]
        sections.append(
            {
                "key": key,
                "title": titles.get(key, key),
                "status": status,
                "score": round(sum(completed_scores) / len(completed_scores), 2) if completed_scores else 0.0,
                "probe_count": len(items),
                "pass_count": sum(1 for item in items if item.get("status") == "pass"),
                "fail_count": sum(1 for item in items if item.get("status") == "fail"),
                "warning_count": sum(1 for item in items if item.get("status") == "warning"),
                "skipped_count": sum(1 for item in items if item.get("status") == "skipped"),
                "probes": items,
            }
        )
    return sections


def _initial_relay_job_state(include_expensive_context: bool, image_url: str | None) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    section_titles = {
        "fingerprint": "ClaudeCode 兼容指纹",
        "structure": "Claude 基础结构",
        "behavior": "行为验证",
        "signature": "ClaudeCode / Thinking Signature",
        "multimodal": "能力参考：多模态",
        "web_capability": "能力参考：Web",
    }
    probes: list[dict[str, object]] = []
    for config in _claude_code_probe_configs(image_url, include_expensive_context):
        probes.append(
            {
                "key": str(config.get("key") or ""),
                "title": str(config.get("title") or ""),
                "category": str(config.get("category") or ""),
                "section": _claude_code_section_for_category(str(config.get("category") or "")),
                "status": "queued",
                "severity": str(config.get("severity") or ""),
                "score": 0.0,
                "labels": [],
                "run_id": None,
                "result_id": None,
                "message_id": None,
                "request_id": None,
                "request_protocol": None,
                "provider_endpoint": None,
                "evidence_excerpt": None,
            }
        )
    probes.append(
        {
            "key": "signature_interop",
            "title": "Signature 跨渠道互通",
            "category": "signature",
            "section": "signature",
            "status": "queued",
            "severity": "core",
            "score": 0.0,
            "labels": [],
            "run_id": None,
            "result_id": None,
            "message_id": None,
            "request_id": None,
            "request_protocol": None,
            "provider_endpoint": None,
            "evidence_excerpt": None,
        }
    )
    sections = _relay_job_sections(probes)
    for section in sections:
        section["title"] = section_titles.get(str(section["key"]), str(section["title"]))
    return probes, sections


def _initial_cli_job_state() -> list[dict[str, object]]:
    return [
        {"key": item["key"], "title": item["title"], "status": "queued", "score": 0, "detail": ""}
        for item in claude_code_check_steps()
    ]


async def _job_update(job_id: str, payload: dict[str, object]) -> None:
    async with CLAUDE_CODE_JOB_LOCK:
        if not CLAUDE_CODE_JOB_STORE.update(job_id, payload):
            logger.info("ClaudeCode job update skipped because job was missing", extra={"job_id": job_id})


def _job_snapshot(job_id: str) -> dict[str, object] | None:
    return CLAUDE_CODE_JOB_STORE.get(job_id)


async def _cache_job_update(job_id: str, payload: dict[str, object]) -> None:
    async with CACHE_HIT_RATE_JOB_LOCK:
        if not CACHE_HIT_RATE_JOB_STORE.update(job_id, payload):
            logger.info("Cache hit rate job update skipped because job was missing", extra={"job_id": job_id})


def _cache_job_snapshot(job_id: str) -> dict[str, object] | None:
    return CACHE_HIT_RATE_JOB_STORE.get(job_id)


def _cache_job_progress_payload(job_id: str, payload: dict[str, object], total_count: int, status: str = "running") -> dict[str, object]:
    warmup = payload.get("warmup")
    attempts = list(payload.get("attempts") or [])
    completed_count = (1 if warmup else 0) + len(attempts)
    measured_total = int(payload.get("total") or 0)
    if not warmup:
        current_title = "准备预热请求"
    elif measured_total < max(0, total_count - 1):
        current_title = f"测量请求 {measured_total} / {max(0, total_count - 1)}"
    else:
        current_title = "缓存命中率测试完成"
    return {
        "job_id": job_id,
        "kind": "cache_hit_rate",
        "status": status,
        "current_title": current_title,
        "completed_count": completed_count,
        "percent": _job_percent(completed_count, total_count),
        "warmup": warmup,
        "attempts": attempts,
        "requested_cache_ttl": str(payload.get("requested_cache_ttl") or "5m"),
        "cache_probe_id": payload.get("cache_probe_id"),
        "total": measured_total,
        "hits": int(payload.get("hits") or 0),
        "request_hit_rate": float(payload.get("request_hit_rate") or 0),
        "total_prompt_tokens": int(payload.get("total_prompt_tokens") or 0),
        "total_cached_tokens": int(payload.get("total_cached_tokens") or 0),
        "token_hit_rate": float(payload.get("token_hit_rate") or 0),
        "avg_cached_tokens": float(payload.get("avg_cached_tokens") or 0),
        "warmup_cache_creation_input_tokens": int(payload.get("warmup_cache_creation_input_tokens") or 0),
        "warmup_cache_creation_ephemeral_5m_input_tokens": int(payload.get("warmup_cache_creation_ephemeral_5m_input_tokens") or 0),
        "warmup_cache_creation_ephemeral_1h_input_tokens": int(payload.get("warmup_cache_creation_ephemeral_1h_input_tokens") or 0),
        "message_channel_type": str(payload.get("message_channel_type") or "未知"),
        "request_protocol": payload.get("request_protocol"),
        "provider_endpoint": payload.get("provider_endpoint"),
    }


async def _run_cache_hit_rate_job(job_id: str, channel_id: str, payload: CacheHitRateTestCreate, db_factory: callable) -> None:
    total_count = payload.test_count + 1
    try:
        async def progress(update: dict[str, object]) -> None:
            await _cache_job_update(job_id, _cache_job_progress_payload(job_id, update, total_count, status="running"))

        with db_factory() as db:
            channel = db.get(Channel, channel_id)
            if not channel:
                raise ValueError("Channel not found")
            result = await create_cache_hit_rate_test(db, channel, payload, progress_callback=progress)

        await _cache_job_update(
            job_id,
            {
                **_cache_job_progress_payload(job_id, result, total_count, status="completed"),
                "finished_at": datetime.now(timezone.utc),
                "completed_count": total_count,
                "percent": 100.0,
                "result": result,
                "error": None,
            },
        )
    except Exception as exc:
        logger.exception("Cache hit rate job failed")
        await _cache_job_update(
            job_id,
            {
                "status": "failed",
                "finished_at": datetime.now(timezone.utc),
                "current_title": None,
                "error": str(exc),
            },
        )


async def _run_relay_job(job_id: str, payload: ClaudeCodeEphemeralTestCreate, db_factory: callable) -> None:
    try:
        base_url = payload.base_url.strip()
        api_key = payload.api_key.strip()
        model_name = payload.model_name.strip()
        channel_label = (payload.channel_label or "").strip() or "Claude 资源临时检测渠道"
        channel = Channel(
            id=f"ephemeral_claude_code_test_{job_id}",
            name=channel_label,
            provider_type=payload.provider_type.strip() or "third_party_anthropic",
            role="candidate",
            base_url=base_url,
            model_name=model_name,
            is_reference=False,
            enabled=True,
        )

        async def progress(update: dict[str, object]) -> None:
            probes = list(update.get("probes") or [])
            completed = sum(1 for item in probes if str(item.get("status")) not in {"queued", "running"})
            sections = _relay_job_sections(probes)
            current_key = update.get("current_key")
            current_title = update.get("current_title")
            current_section = update.get("current_section")
            if current_key and not current_title:
                current = next((item for item in probes if item.get("key") == current_key), None)
                if current:
                    current_title = current.get("title")
                    current_section = current.get("section")
            await _job_update(
                job_id,
                {
                    "status": "running",
                    "current_key": current_key,
                    "current_title": current_title,
                    "current_section": current_section,
                    "completed_count": completed,
                    "percent": _job_percent(completed, CLAUDE_CODE_JOB_STORE.total_count(job_id)),
                    "probes": probes,
                    "sections": sections,
                },
            )

        with db_factory() as db:
            result = await create_claude_code_test(
                db,
                channel,
                source_channel_id=payload.source_channel_id,
                image_url=payload.image_url,
                include_expensive_context=payload.include_expensive_context,
                credentials_override={
                    "api_key": api_key,
                    "base_url": base_url,
                    "model": model_name,
                    "request_protocol": payload.request_protocol,
                },
                persist_results=False,
                progress_callback=progress,
            )
            create_claude_code_evidence(
                db,
                channel_label=channel.name,
                base_url=base_url,
                model_name=model_name,
                provider_type=channel.provider_type,
                request_protocol=payload.request_protocol,
                source_channel_id=payload.source_channel_id,
                image_url=payload.image_url,
                include_expensive_context=payload.include_expensive_context,
                result_payload=result,
            )
        await _job_update(
            job_id,
            {
                "status": "completed",
                "finished_at": datetime.now(timezone.utc),
                "current_key": None,
                "current_title": None,
                "current_section": None,
                "completed_count": CLAUDE_CODE_JOB_STORE.total_count(job_id),
                "percent": 100.0,
                "probes": result.get("probes", []),
                "sections": result.get("sections", []),
                "result": result,
                "error": None,
            },
        )
    except Exception as exc:
        logger.exception("ClaudeCode relay job failed")
        await _job_update(
            job_id,
            {
                "status": "failed",
                "finished_at": datetime.now(timezone.utc),
                "current_key": None,
                "current_title": None,
                "current_section": None,
                "error": str(exc),
            },
        )


async def _run_cli_job(job_id: str, payload: ClaudeCodeCheckCreate) -> None:
    try:
        async def progress(update: dict[str, object]) -> None:
            raw_checks = list(update.get("checks") or [])
            known = {str(item.get("key")): dict(item) for item in raw_checks}
            checks = []
            for step in claude_code_check_steps():
                item = known.get(step["key"])
                if item is None:
                    checks.append({"key": step["key"], "title": step["title"], "status": "queued", "score": 0, "detail": ""})
                else:
                    checks.append(item)
            completed = sum(1 for item in checks if str(item.get("status")) not in {"queued", "running"})
            current_key = update.get("current_key")
            current_title = next((item["title"] for item in checks if item["key"] == current_key), None)
            await _job_update(
                job_id,
                {
                    "status": "running",
                    "current_key": current_key,
                    "current_title": current_title,
                    "current_section": "cli",
                    "completed_count": completed,
                    "percent": _job_percent(completed, CLAUDE_CODE_JOB_STORE.total_count(job_id)),
                    "checks": checks,
                },
            )

        result = await run_claude_code_check_with_progress(payload, progress_callback=progress)
        await _job_update(
            job_id,
            {
                "status": "completed",
                "finished_at": datetime.now(timezone.utc),
                "current_key": None,
                "current_title": None,
                "current_section": None,
                "completed_count": CLAUDE_CODE_JOB_STORE.total_count(job_id),
                "percent": 100.0,
                "checks": result.get("checks", []),
                "result": result,
                "error": None,
            },
        )
    except Exception as exc:
        logger.exception("Claude Code CLI job failed")
        await _job_update(
            job_id,
            {
                "status": "failed",
                "finished_at": datetime.now(timezone.utc),
                "current_key": None,
                "current_title": None,
                "current_section": None,
                "error": str(exc),
            },
        )


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

# --- Rate limiting ---
_rate_limit_buckets: defaultdict[str, list[float]] = defaultdict(list)


def _rate_limit_per_minute() -> int:
    raw = os.getenv("RATE_LIMIT_PER_MINUTE", "100") or "100"
    try:
        return int(raw)
    except ValueError:
        return 100


def _trust_proxy_headers() -> bool:
    return os.getenv("TRUST_PROXY_HEADERS", "false").strip().lower() in {"1", "true", "yes"}


def _client_ip(request: Request) -> str:
    if _trust_proxy_headers():
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@app.middleware("http")
async def rate_limit(request: Request, call_next) -> Response:
    rate_limit_per_minute = _rate_limit_per_minute()
    if rate_limit_per_minute <= 0:
        return await call_next(request)
    now = time_module.monotonic()
    ip = _client_ip(request)
    window = _rate_limit_buckets[ip]
    window[:] = [t for t in window if t > now - 60.0]
    if len(window) >= rate_limit_per_minute:
        return JSONResponse(status_code=429, content={"detail": "Too many requests"}, headers={"Retry-After": "60"})
    window.append(now)
    return await call_next(request)


@app.middleware("http")
async def add_request_id(request: Request, call_next) -> Response:
    request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
    request.state.request_id = request_id
    response: Response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response


def run_read(db: Session, run: Run) -> RunRead:
    payload = RunRead.model_validate(run)
    run_channels = db.scalars(select(RunChannel).where(RunChannel.run_id == run.id).order_by(RunChannel.role_in_run, RunChannel.channel_id)).all()
    channel_by_id = {channel.id: channel for channel in db.scalars(select(Channel).where(Channel.id.in_([item.channel_id for item in run_channels]))).all()} if run_channels else {}
    payload.channels = [
        {
            "channel_id": item.channel_id,
            "channel_name": channel_by_id[item.channel_id].name if item.channel_id in channel_by_id else None,
            "role_in_run": item.role_in_run,
        }
        for item in run_channels
    ]
    patrol_channel: Channel | None = None
    if run.scheduled_test_id:
        scheduled = db.get(ScheduledChannelTest, run.scheduled_test_id)
        if scheduled:
            patrol_channel = db.get(Channel, scheduled.channel_id)
        else:
            logger.warning("run_read: scheduled_test_id=%s not found for run_id=%s", run.scheduled_test_id, run.id)
    if not patrol_channel and (run.scheduled_test_id or run.test_scope == "scheduled_probe"):
        report = db.scalar(select(Report).where(Report.run_id == run.id).order_by(Report.created_at.desc()))
        if report:
            patrol_channel = db.get(Channel, report.channel_id)
    if patrol_channel:
        payload.patrol_channel_id = patrol_channel.id
        payload.patrol_channel_name = patrol_channel.name
        payload.patrol_channel_provider_type = patrol_channel.provider_type
        payload.patrol_channel_account_type = (patrol_channel.auth_config or {}).get("account_type")
    return payload


def _baseline_reference_conflict(db: Session, baseline_id: str, source_run_id: str | None = None) -> str | None:
    run_stmt = select(Run).where(Run.baseline_snapshot_id == baseline_id)
    if source_run_id:
        run_stmt = run_stmt.where(Run.id != source_run_id)
    if db.scalar(run_stmt.limit(1)):
        return "Baseline snapshot is referenced by existing comparison runs"
    if db.scalar(select(ScheduledChannelTest).where(ScheduledChannelTest.baseline_snapshot_id == baseline_id).limit(1)):
        return "Baseline snapshot is referenced by scheduled tests"
    return None


def _channel_has_references(db: Session, channel_id: str) -> bool:
    checks = [
        select(RunChannel.id).where(RunChannel.channel_id == channel_id).limit(1),
        select(Result.id).where(Result.channel_id == channel_id).limit(1),
        select(Comparison.id).where(Comparison.candidate_channel_id == channel_id).limit(1),
        select(Report.id).where(Report.channel_id == channel_id).limit(1),
        select(ChannelAlert.id).where(ChannelAlert.channel_id == channel_id).limit(1),
        select(ScheduledChannelTest.id).where(ScheduledChannelTest.channel_id == channel_id).limit(1),
        select(BaselineResult.id).where(BaselineResult.channel_id == channel_id).limit(1),
    ]
    return any(db.scalar(stmt) is not None for stmt in checks)


@app.post("/api/reseed/cleanup-restored-fixture")
def cleanup_restored_fixture(_admin: None = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, object]:
    data = restored_seed_data()
    default_case_ids = {str(item["id"]) for item in default_cases() if item.get("id")}
    fixture_case_ids = [str(item["id"]) for item in data["test_cases"] if item.get("id") and str(item["id"]) not in default_case_ids]
    fixture_suite_ids = [str(item["id"]) for item in data["test_suites"] if item.get("id") and str(item["id"]) != DEFAULT_SUITE_ID]
    fixture_channel_ids = [str(item["id"]) for item in data["channels"] if item.get("id")]
    deleted_cases = 0
    deleted_suites = 0
    deleted_channels = 0
    skipped_channels: list[dict[str, str]] = []
    skipped_cases = len(default_case_ids.intersection({str(item["id"]) for item in data["test_cases"] if item.get("id")}))

    for case_id in fixture_case_ids:
        case = db.get(TestCase, case_id)
        if not case:
            continue
        db.execute(delete(Result).where(Result.test_case_id == case_id))
        db.execute(delete(Comparison).where(Comparison.test_case_id == case_id))
        db.execute(delete(BaselineResult).where(BaselineResult.test_case_id == case_id))
        db.delete(case)
        deleted_cases += 1

    for suite_id in fixture_suite_ids:
        suite = db.get(TestSuite, suite_id)
        if not suite:
            continue
        has_cases = db.scalar(select(TestCase.id).where(TestCase.suite_id == suite_id).limit(1))
        has_runs = db.scalar(select(Run.id).where(Run.suite_id == suite_id).limit(1))
        if has_cases or has_runs:
            continue
        db.delete(suite)
        deleted_suites += 1

    for channel_id in fixture_channel_ids:
        channel = db.get(Channel, channel_id)
        if not channel:
            continue
        if (channel.auth_config or {}).get("api_key"):
            skipped_channels.append({"id": channel_id, "reason": "has_api_key"})
            continue
        if _channel_has_references(db, channel_id):
            skipped_channels.append({"id": channel_id, "reason": "referenced"})
            continue
        db.delete(channel)
        deleted_channels += 1

    db.commit()
    return {
        "deleted_cases": deleted_cases,
        "deleted_suites": deleted_suites,
        "deleted_channels": deleted_channels,
        "skipped_channels": skipped_channels,
        "skipped_default_cases": skipped_cases,
    }


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception):
    request_id = getattr(_request.state, "request_id", None) or "unknown"
    logger.exception("Unhandled application error", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error",
            "request_id": request_id,
            "path": str(_request.url.path),
        },
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_request: Request, exc: RequestValidationError):
    request_id = getattr(_request.state, "request_id", None) or "unknown"
    errors = []
    for error in exc.errors():
        field = ".".join(str(loc) for loc in error["loc"])
        errors.append({"field": field, "message": error["msg"], "type": error["type"]})
    return JSONResponse(
        status_code=422,
        content={"detail": "Validation error", "errors": errors, "request_id": request_id},
    )


@app.post("/api/channels/{channel_id}/cache-hit-rate-test/jobs", response_model=CacheHitRateJobCreateRead)
async def start_channel_cache_hit_rate_test_job(channel_id: str, data: CacheHitRateTestCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    job_id = str(uuid.uuid4())
    total_count = data.test_count + 1
    async with CACHE_HIT_RATE_JOB_LOCK:
        now = datetime.now(timezone.utc)
        CACHE_HIT_RATE_JOB_STORE.set(job_id, {
            "job_id": job_id,
            "kind": "cache_hit_rate",
            "status": "queued",
            "started_at": now,
            "updated_at": now,
            "finished_at": None,
            "current_title": "排队中",
            "completed_count": 0,
            "total_count": total_count,
            "percent": 0.0,
            "warmup": None,
            "attempts": [],
            "requested_cache_ttl": data.cache_ttl,
            "cache_probe_id": None,
            "total": 0,
            "hits": 0,
            "request_hit_rate": 0.0,
            "total_prompt_tokens": 0,
            "total_cached_tokens": 0,
            "token_hit_rate": 0.0,
            "avg_cached_tokens": 0.0,
            "warmup_cache_creation_input_tokens": 0,
            "warmup_cache_creation_ephemeral_5m_input_tokens": 0,
            "warmup_cache_creation_ephemeral_1h_input_tokens": 0,
            "message_channel_type": "未知",
            "request_protocol": None,
            "provider_endpoint": None,
            "result": None,
            "error": None,
        })
    asyncio.create_task(_run_cache_hit_rate_job(job_id, channel_id, data, SessionLocal))
    return {"job_id": job_id, "status": "queued"}


@app.get("/api/cache-hit-rate-test/jobs/{job_id}", response_model=CacheHitRateJobStatusRead)
def get_cache_hit_rate_test_job(job_id: str) -> dict[str, object]:
    payload = _cache_job_snapshot(job_id)
    if not payload or payload.get("kind") != "cache_hit_rate":
        raise HTTPException(status_code=404, detail=JOB_NOT_FOUND_DETAIL)
    return payload


@app.post("/api/channels/{channel_id}/claude-code-test", response_model=ClaudeCodeTestRead)
async def channel_claude_code_test(channel_id: str, data: ClaudeCodeTestCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    try:
        return await create_claude_code_test(
            db,
            channel,
            source_channel_id=data.source_channel_id,
            image_url=data.image_url,
            include_expensive_context=data.include_expensive_context,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Claude resource fingerprint test failed for channel %s", channel_id)
        raise HTTPException(status_code=502, detail="Claude resource fingerprint test failed") from exc


@app.post("/api/claude-code-test", response_model=ClaudeCodeTestRead)
async def ephemeral_claude_code_test(data: ClaudeCodeEphemeralTestCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    base_url = data.base_url.strip()
    api_key = data.api_key.strip()
    model_name = data.model_name.strip()
    channel_label = (data.channel_label or "").strip() or "Claude 资源临时检测渠道"
    if not base_url:
        raise HTTPException(status_code=400, detail="Base URL is required")
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key is required")
    if not model_name:
        raise HTTPException(status_code=400, detail="Model name is required")
    channel = Channel(
        id="ephemeral_claude_code_test",
        name=channel_label,
        provider_type=data.provider_type.strip() or "third_party_anthropic",
        role="candidate",
        base_url=base_url,
        model_name=model_name,
        is_reference=False,
        enabled=True,
    )
    try:
        return await create_claude_code_test(
            db,
            channel,
            source_channel_id=data.source_channel_id,
            image_url=data.image_url,
            include_expensive_context=data.include_expensive_context,
            credentials_override={
                "api_key": api_key,
                "base_url": base_url,
                "model": model_name,
                "request_protocol": data.request_protocol,
            },
            persist_results=False,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Ephemeral Claude resource fingerprint test failed")
        raise HTTPException(status_code=502, detail="Claude resource fingerprint test failed") from exc


@app.post("/api/claude-code-test/jobs", response_model=ClaudeCodeJobCreateRead)
async def start_ephemeral_claude_code_test_job(data: ClaudeCodeEphemeralTestCreate) -> dict[str, object]:
    base_url = data.base_url.strip()
    api_key = data.api_key.strip()
    model_name = data.model_name.strip()
    if not base_url:
        raise HTTPException(status_code=400, detail="Base URL is required")
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key is required")
    if not model_name:
        raise HTTPException(status_code=400, detail="Model name is required")

    job_id = str(uuid.uuid4())
    probes, sections = _initial_relay_job_state(data.include_expensive_context, data.image_url)
    async with CLAUDE_CODE_JOB_LOCK:
        now = datetime.now(timezone.utc)
        CLAUDE_CODE_JOB_STORE.set(job_id, {
            "job_id": job_id,
            "kind": "relay",
            "status": "queued",
            "started_at": now,
            "updated_at": now,
            "finished_at": None,
            "current_key": None,
            "current_title": None,
            "current_section": None,
            "completed_count": 0,
            "total_count": len(probes),
            "percent": 0.0,
            "sections": sections,
            "probes": probes,
            "checks": [],
            "result": None,
            "error": None,
        })
    asyncio.create_task(_run_relay_job(job_id, data, SessionLocal))
    return {"job_id": job_id, "status": "queued"}


@app.get("/api/claude-code-test/jobs/{job_id}", response_model=ClaudeCodeJobStatusRead)
def get_ephemeral_claude_code_test_job(job_id: str) -> dict[str, object]:
    payload = _job_snapshot(job_id)
    if not payload or payload.get("kind") != "relay":
        raise HTTPException(status_code=404, detail=JOB_NOT_FOUND_DETAIL)
    return payload


@app.get("/api/claude-code-test/source-channels", response_model=list[ClaudeCodeSourceChannelRead])
def list_claude_code_source_channels(db: Session = Depends(get_db)) -> list[dict[str, object]]:
    return claude_code_source_channels(db)


@app.get("/api/claude-code-history", response_model=list[ClaudeCodeEvidenceListItemRead])
def list_claude_code_history(db: Session = Depends(get_db)) -> list[dict[str, object]]:
    return claude_code_evidence_list(db)


@app.get("/api/claude-code-history/{evidence_id}", response_model=ClaudeCodeEvidenceRead)
def get_claude_code_history_detail(evidence_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    payload = claude_code_evidence_detail(db, evidence_id)
    if not payload:
        raise HTTPException(status_code=404, detail="ClaudeCode history not found")
    return payload


@app.delete("/api/claude-code-history/{evidence_id}")
def delete_claude_code_history(evidence_id: str, _admin: None = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, object]:
    item = db.get(ClaudeCodeEvidence, evidence_id)
    if not item:
        raise HTTPException(status_code=404, detail="ClaudeCode history not found")
    db.delete(item)
    db.commit()
    return {"deleted": True}


@app.get("/api/claude-code-check/status", response_model=ClaudeCodeCheckStatusRead)
def get_claude_code_check_status() -> dict[str, object]:
    return claude_code_status()


@app.post("/api/claude-code-check/run", response_model=ClaudeCodeCheckRead)
async def post_claude_code_check(data: ClaudeCodeCheckCreate) -> dict[str, object]:
    try:
        return await run_claude_code_check(data)
    except Exception as exc:
        logger.exception("Claude Code check failed")
        raise HTTPException(status_code=500, detail=f"Claude Code check failed: {exc}") from exc


@app.post("/api/claude-code-check/jobs", response_model=ClaudeCodeJobCreateRead)
async def start_claude_code_check_job(data: ClaudeCodeCheckCreate) -> dict[str, object]:
    job_id = str(uuid.uuid4())
    checks = _initial_cli_job_state()
    async with CLAUDE_CODE_JOB_LOCK:
        now = datetime.now(timezone.utc)
        CLAUDE_CODE_JOB_STORE.set(job_id, {
            "job_id": job_id,
            "kind": "cli",
            "status": "queued",
            "started_at": now,
            "updated_at": now,
            "finished_at": None,
            "current_key": None,
            "current_title": None,
            "current_section": None,
            "completed_count": 0,
            "total_count": len(checks),
            "percent": 0.0,
            "sections": [],
            "probes": [],
            "checks": checks,
            "result": None,
            "error": None,
        })
    asyncio.create_task(_run_cli_job(job_id, data))
    return {"job_id": job_id, "status": "queued"}


@app.get("/api/claude-code-check/jobs/{job_id}", response_model=ClaudeCodeJobStatusRead)
def get_claude_code_check_job(job_id: str) -> dict[str, object]:
    payload = _job_snapshot(job_id)
    if not payload or payload.get("kind") != "cli":
        raise HTTPException(status_code=404, detail=JOB_NOT_FOUND_DETAIL)
    return payload


@app.post("/api/eval-runs", response_model=RunRead)
def start_run(data: RunCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)) -> RunRead:
    try:
        run = create_run(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    benchmark_config = data.benchmark_config.model_dump() if data.benchmark_config else None
    if data.use_mock:
        asyncio.run(
            execute_run(
                SessionLocal,
                run.id,
                data.runtime_credentials,
                data.use_mock,
                benchmark_config=benchmark_config,
            )
        )
    else:
        background_tasks.add_task(
            execute_run,
            SessionLocal,
            run.id,
            data.runtime_credentials,
            data.use_mock,
            benchmark_config=benchmark_config,
        )
    refreshed = db.get(Run, run.id) or run
    return run_read(db, refreshed)


@app.get("/api/eval-runs", response_model=list[RunRead])
def list_runs(db: Session = Depends(get_db)) -> list[RunRead]:
    return [run_read(db, run) for run in db.scalars(select(Run).order_by(Run.created_at.desc())).all()]


@app.get("/api/runs", response_model=list[RunRead])
def list_runs_alias(db: Session = Depends(get_db)) -> list[RunRead]:
    return list_runs(db)


@app.post("/api/runs", response_model=RunRead)
def start_run_alias(data: RunCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)) -> RunRead:
    return start_run(data, background_tasks, db)


@app.post("/api/runs/sample-plan", response_model=SamplePlanRead)
def preview_run_sample_plan(data: SamplePlanCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return build_sample_plan(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/runs/arena", response_model=RunRead)
def start_arena_run(data: ArenaRunCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)) -> RunRead:
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
    arena_config = {"judge_channel_id": data.judge_channel_id, "judge_mode": data.judge_mode, "judge_rubric": data.judge_rubric}
    if data.use_mock:
        asyncio.run(
            execute_run(
                SessionLocal,
                run.id,
                data.runtime_credentials,
                data.use_mock,
                arena_config=arena_config,
            )
        )
    else:
        background_tasks.add_task(
            execute_run,
            SessionLocal,
            run.id,
            data.runtime_credentials,
            data.use_mock,
            arena_config=arena_config,
        )
    refreshed = db.get(Run, run.id) or run
    return run_read(db, refreshed)


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
def delete_baseline(
    baseline_id: str,
    _admin: None = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
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
    if data.use_mock:
        asyncio.run(
            execute_run(
                SessionLocal,
                run.id,
                data.runtime_credentials,
                data.use_mock,
            )
        )
    else:
        background_tasks.add_task(
            execute_run,
            SessionLocal,
            run.id,
            data.runtime_credentials,
            data.use_mock,
        )
    refreshed = db.get(Run, run.id) or run
    return run_read(db, refreshed)


@app.post("/api/baselines/{baseline_id}/validate", response_model=BaselineSnapshotRead)
def validate_baseline(baseline_id: str, db: Session = Depends(get_db)) -> BaselineSnapshot:
    snapshot = get_baseline(baseline_id, db)
    try:
        return validate_baseline_for_run(db, baseline_id, snapshot.suite_id)
    except ValueError:
        db.refresh(snapshot)
        return snapshot


@app.get("/api/audit-logs", response_model=list[AuditLogRead])
def list_audit_logs(
    action: str | None = Query(default=None),
    target_type: str | None = Query(default=None),
    target_id: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(limit)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if target_type:
        stmt = stmt.where(AuditLog.target_type == target_type)
    if target_id:
        stmt = stmt.where(AuditLog.target_id == target_id)
    return [audit_log_read(log) for log in db.scalars(stmt).all()]


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
) -> list[dict[str, object]]:
    stmt = select(ScheduledChannelTest).order_by(ScheduledChannelTest.enabled.desc(), ScheduledChannelTest.next_run_at)
    if channel_id:
        stmt = stmt.where(ScheduledChannelTest.channel_id == channel_id)
    if enabled is not None:
        stmt = stmt.where(ScheduledChannelTest.enabled.is_(enabled))
    return [scheduled_channel_test_read(db, scheduled) for scheduled in db.scalars(stmt).all()]


@app.post("/api/scheduled-tests", response_model=ScheduledChannelTestRead)
def add_scheduled_test(
    data: ScheduledChannelTestCreate,
    actor: dict[str, str | None] = Depends(audit_actor),
    db: Session = Depends(get_db),
) -> ScheduledChannelTest:
    try:
        scheduled = create_scheduled_channel_test(db, data)
        record_audit_log(
            db,
            actor=actor,
            action="scheduled_test.create",
            target_type="scheduled_test",
            target_id=scheduled.id,
            after_summary=scheduled_test_audit_summary(scheduled),
        )
        db.commit()
        db.refresh(scheduled)
        return scheduled
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


@app.get("/api/scheduled-tests/health", response_model=ScheduledTestHealthRead)
def get_scheduled_tests_health(db: Session = Depends(get_db)) -> dict[str, object]:
    return scheduled_tests_health(db)


@app.post("/api/scheduled-tests/report/send-daily", response_model=FeishuTestMessageRead)
async def send_smart_patrol_daily_report() -> dict[str, object]:
    return await send_daily_patrol_report(SessionLocal, force=True)


@app.get("/api/scheduled-tests/{scheduled_id}", response_model=ScheduledChannelTestRead)
def get_scheduled_test(scheduled_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    scheduled = db.get(ScheduledChannelTest, scheduled_id)
    if not scheduled:
        raise HTTPException(status_code=404, detail="Scheduled test not found")
    return scheduled_channel_test_read(db, scheduled)


@app.patch("/api/scheduled-tests/{scheduled_id}", response_model=ScheduledChannelTestRead)
def update_scheduled_test(
    scheduled_id: str,
    data: ScheduledChannelTestUpdate,
    actor: dict[str, str | None] = Depends(audit_actor),
    db: Session = Depends(get_db),
) -> ScheduledChannelTest:
    scheduled = db.get(ScheduledChannelTest, scheduled_id)
    if not scheduled:
        raise HTTPException(status_code=404, detail="Scheduled test not found")
    before_summary = scheduled_test_audit_summary(scheduled)
    previous = {
        "channel_id": scheduled.channel_id,
        "suite_id": scheduled.suite_id,
        "baseline_snapshot_id": scheduled.baseline_snapshot_id,
        "interval_minutes": scheduled.interval_minutes,
        "run_window_start": scheduled.run_window_start,
        "run_window_end": scheduled.run_window_end,
        "test_scope": scheduled.test_scope,
        "patrol_modules": scheduled.patrol_modules,
    }
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(scheduled, key, value)
    if scheduled.enabled and scheduled.next_run_at is None:
        scheduled.next_run_at = next_run_for_scheduled_test(scheduled)
    try:
        validate_scheduled_channel_test(db, scheduled)
    except ValueError as exc:
        for key, value in previous.items():
            setattr(scheduled, key, value)
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    schedule_fields = {"interval_minutes", "run_window_start", "run_window_end"}
    if schedule_fields.intersection(data.model_fields_set) and "next_run_at" not in data.model_fields_set:
        scheduled.next_run_at = next_run_for_scheduled_test(scheduled)
    db.flush()
    record_audit_log(
        db,
        actor=actor,
        action="scheduled_test.update",
        target_type="scheduled_test",
        target_id=scheduled.id,
        before_summary=before_summary,
        after_summary=scheduled_test_audit_summary(scheduled),
        metadata={"changed_fields": sorted(data.model_fields_set)},
    )
    db.commit()
    db.refresh(scheduled)
    return scheduled


@app.delete("/api/scheduled-tests/{scheduled_id}")
def delete_scheduled_test(
    scheduled_id: str,
    actor: dict[str, str | None] = Depends(audit_actor),
    _admin: None = Depends(require_admin_if_configured),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    scheduled = db.get(ScheduledChannelTest, scheduled_id)
    if not scheduled:
        raise HTTPException(status_code=404, detail="Scheduled test not found")
    before_summary = scheduled_test_audit_summary(scheduled)
    # Remove scheduler queue records first: patrol jobs keep a non-null FK to the schedule.
    job_ids = list(db.scalars(select(PatrolJob.id).where(PatrolJob.scheduled_test_id == scheduled_id)).all())
    if job_ids:
        db.execute(delete(PatrolJobAttempt).where(PatrolJobAttempt.job_id.in_(job_ids)))
        db.execute(delete(PatrolJob).where(PatrolJob.id.in_(job_ids)))
    # Detach evidence/history references so orphaned runs/alerts don't break the frontend.
    for alert in db.scalars(select(ChannelAlert).where(ChannelAlert.scheduled_test_id == scheduled_id)).all():
        alert.scheduled_test_id = None
    for run in db.scalars(select(Run).where(Run.scheduled_test_id == scheduled_id)).all():
        run.scheduled_test_id = None
    db.flush()
    db.delete(scheduled)
    record_audit_log(
        db,
        actor=actor,
        action="scheduled_test.delete",
        target_type="scheduled_test",
        target_id=scheduled_id,
        before_summary=before_summary,
    )
    db.commit()
    return {"deleted": True}


@app.post("/api/scheduled-tests/{scheduled_id}/run-now", response_model=ScheduledChannelTestRead)
async def run_scheduled_test_now(
    scheduled_id: str,
    background_tasks: BackgroundTasks,
    actor: dict[str, str | None] = Depends(audit_actor),
    db: Session = Depends(get_db),
) -> ScheduledChannelTestRead:
    scheduled = db.get(ScheduledChannelTest, scheduled_id)
    if not scheduled:
        raise HTTPException(status_code=404, detail="Scheduled test not found")
    try:
        validate_scheduled_channel_test(db, scheduled)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    claimed = claim_scheduled_test(db, scheduled.id, force=True)
    if claimed:
        record_audit_log(
            db,
            actor=actor,
            action="scheduled_test.run_now",
            target_type="scheduled_test",
            target_id=claimed.id,
            after_summary=scheduled_test_audit_summary(claimed),
        )
        db.commit()
        db.refresh(claimed)
        background_tasks.add_task(execute_scheduled_channel_test, SessionLocal, claimed.id)
        scheduled = claimed
    else:
        db.refresh(scheduled)
    return ScheduledChannelTestRead.model_validate(scheduled_channel_test_read(db, scheduled))


@app.get("/api/alerts", response_model=list[ChannelAlertRead])
def list_alerts(
    status: str | None = Query(default=None),
    channel_id: str | None = Query(default=None),
    id_query: str | None = Query(default=None),
    created_from: datetime | None = Query(default=None),
    created_to: datetime | None = Query(default=None),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    alerts = list_channel_alerts(
        db,
        status=status,
        channel_id=channel_id,
        id_query=id_query,
        created_from=created_from,
        created_to=created_to,
    )
    return [channel_alert_read(db, alert) for alert in alerts]


@app.get("/api/alerts/{alert_id}", response_model=ChannelAlertRead)
def get_alert(alert_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    alert = db.get(ChannelAlert, alert_id)
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    return channel_alert_read(db, alert)


@app.delete("/api/alerts/{alert_id}")
def delete_alert(
    alert_id: str,
    _admin: None = Depends(require_admin_if_configured),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    alert = db.get(ChannelAlert, alert_id)
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    db.delete(alert)
    db.commit()
    return {"deleted": True}


@app.post("/api/alerts/bulk-delete")
def bulk_delete_alerts(
    data: BulkDeleteRequest,
    _admin: None = Depends(require_admin_if_configured),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    if not data.ids:
        return {"deleted": 0, "missing": []}
    existing_ids = set(db.scalars(select(ChannelAlert.id).where(ChannelAlert.id.in_(data.ids))).all())
    missing = [alert_id for alert_id in data.ids if alert_id not in existing_ids]
    if existing_ids:
        db.execute(delete(ChannelAlert).where(ChannelAlert.id.in_(existing_ids)))
        db.commit()
    return {"deleted": len(existing_ids), "missing": missing}


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
def get_run(run_id: str, db: Session = Depends(get_db)) -> RunRead:
    run = db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run_read(db, run)


def require_run(db: Session, run_id: str) -> Run:
    run = db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@app.get("/api/runs/{run_id}", response_model=RunRead)
def get_run_alias(run_id: str, db: Session = Depends(get_db)) -> RunRead:
    return get_run(run_id, db)


@app.get("/api/runs/{run_id}/progress")
def run_progress_alias(run_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    run = db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
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
        run=run_read(db, run),
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
    require_run(db, run_id)
    return list(db.scalars(select(Result).where(Result.run_id == run_id).order_by(Result.test_case_id, Result.channel_id)).all())


@app.get("/api/runs/{run_id}/comparisons", response_model=list[ComparisonRead])
def get_run_comparisons_alias(run_id: str, db: Session = Depends(get_db)) -> list[Comparison]:
    require_run(db, run_id)
    return list(db.scalars(select(Comparison).where(Comparison.run_id == run_id).order_by(Comparison.test_case_id)).all())


@app.get("/api/runs/{run_id}/comparisons/{test_case_id}", response_model=list[ComparisonRead])
def get_run_case_comparisons_alias(run_id: str, test_case_id: str, db: Session = Depends(get_db)) -> list[Comparison]:
    require_run(db, run_id)
    return list(db.scalars(select(Comparison).where(Comparison.run_id == run_id, Comparison.test_case_id == test_case_id)).all())


@app.post("/api/runs/{run_id}/cancel")
def cancel_run_alias(run_id: str, db: Session = Depends(get_db)) -> dict[str, str]:
    run = require_run(db, run_id)
    if run.status in {"pending", "running"}:
        run.status = "canceled"
        run.finished_at = datetime.now(timezone.utc)
        db.commit()
    return {"status": run.status}


def _rowcount(result) -> int:  # noqa: ANN001
    return int(result.rowcount or 0)


def _delete_patrol_jobs_for_runs(db: Session, run_ids: set[str]) -> int:
    if not run_ids:
        return 0
    deleted = 0
    job_ids = list(db.scalars(select(PatrolJob.id).where(PatrolJob.run_id.in_(run_ids))).all())
    if job_ids:
        deleted += _rowcount(db.execute(delete(PatrolJobAttempt).where(PatrolJobAttempt.job_id.in_(job_ids))))
        deleted += _rowcount(db.execute(delete(PatrolJob).where(PatrolJob.id.in_(job_ids))))
    deleted += _rowcount(db.execute(delete(PatrolJobAttempt).where(PatrolJobAttempt.run_id.in_(run_ids))))
    deleted += _rowcount(db.execute(delete(PatrolJob).where(PatrolJob.run_id.in_(run_ids))))
    return deleted


def _refresh_scheduled_state_after_run_delete(db: Session, scheduled: ScheduledChannelTest, deleted_run_ids: set[str]) -> None:
    fallback_run_id = db.scalar(
        select(Run.id)
        .where(
            Run.scheduled_test_id == scheduled.id,
            Run.id.not_in(deleted_run_ids),
        )
        .order_by(Run.created_at.desc(), Run.id.desc())
        .limit(1)
    )
    scheduled.last_run_id = fallback_run_id
    if fallback_run_id:
        fallback = db.get(Run, fallback_run_id)
        scheduled.last_status = fallback.status if fallback else "idle"
        scheduled.last_error = None
        scheduled.last_started_at = fallback.started_at if fallback else None
        scheduled.last_finished_at = fallback.finished_at if fallback else None
    else:
        scheduled.last_status = "idle"
        scheduled.last_error = None
        scheduled.last_started_at = None
        scheduled.last_finished_at = None


def _baseline_snapshots_for_deletable_runs(db: Session, run_ids: set[str]) -> list[BaselineSnapshot]:
    if not run_ids:
        return []
    return list(db.scalars(select(BaselineSnapshot).where(BaselineSnapshot.source_run_id.in_(run_ids))).all())


def _delete_runs_by_ids(db: Session, run_ids: set[str], *, repair_refs: bool = True) -> int:
    if not run_ids:
        return 0
    source_snapshots = _baseline_snapshots_for_deletable_runs(db, run_ids)
    if repair_refs:
        _repair_scheduled_last_run_refs_before_delete(db, run_ids)
    _delete_patrol_jobs_for_runs(db, run_ids)
    db.execute(delete(ChannelAlert).where(ChannelAlert.run_id.in_(run_ids)))
    db.execute(delete(RunChannel).where(RunChannel.run_id.in_(run_ids)))
    db.execute(delete(Result).where(Result.run_id.in_(run_ids)))
    db.execute(delete(Comparison).where(Comparison.run_id.in_(run_ids)))
    db.execute(delete(Report).where(Report.run_id.in_(run_ids)))
    for snapshot in source_snapshots:
        db.execute(delete(BaselineResult).where(BaselineResult.baseline_snapshot_id == snapshot.id))
    if source_snapshots:
        db.execute(delete(BaselineSnapshot).where(BaselineSnapshot.id.in_([snapshot.id for snapshot in source_snapshots])))
    return _rowcount(db.execute(delete(Run).where(Run.id.in_(run_ids))))


def _delete_run_by_id(db: Session, run_id: str, *, repair_refs: bool = True, excluded_run_ids: set[str] | None = None) -> bool:
    run = db.get(Run, run_id)
    if not run:
        return False
    if run.status == "running":
        raise HTTPException(status_code=409, detail="Running runs must be canceled before deletion")
    source_snapshots = _baseline_snapshots_for_deletable_runs(db, {run_id})
    for snapshot in source_snapshots:
        conflict = _baseline_reference_conflict(db, snapshot.id, run_id)
        if conflict:
            raise HTTPException(status_code=409, detail=conflict)
    deleted_run_ids = excluded_run_ids or {run_id}
    if repair_refs and deleted_run_ids != {run_id}:
        _repair_scheduled_last_run_refs_before_delete(db, deleted_run_ids)
    return _delete_runs_by_ids(db, {run_id}, repair_refs=repair_refs) > 0


def _repair_scheduled_last_run_refs_before_delete(db: Session, run_ids: set[str]) -> int:
    if not run_ids:
        return 0
    scheduled_refs = list(db.scalars(select(ScheduledChannelTest).where(ScheduledChannelTest.last_run_id.in_(run_ids))).all())
    for scheduled in scheduled_refs:
        fallback_run_id = db.scalar(
            select(Run.id)
            .where(
                Run.scheduled_test_id == scheduled.id,
                Run.id.not_in(run_ids),
            )
            .order_by(Run.created_at.desc(), Run.id.desc())
            .limit(1)
        )
        _refresh_scheduled_state_after_run_delete(db, scheduled, run_ids)
    return len(scheduled_refs)


def _run_ids_blocked_by_baseline_refs(db: Session, run_ids: set[str]) -> dict[str, str]:
    blocked: dict[str, str] = {}
    for snapshot in _baseline_snapshots_for_deletable_runs(db, run_ids):
        if not snapshot.source_run_id:
            continue
        conflict = _baseline_reference_conflict(db, snapshot.id, snapshot.source_run_id)
        if conflict:
            blocked[str(snapshot.source_run_id)] = conflict
    return blocked


def _preflight_deletable_run_ids(db: Session, run_ids: list[str]) -> tuple[set[str], list[str], dict[str, str]]:
    requested = list(dict.fromkeys(str(item).strip() for item in run_ids if str(item).strip()))
    if not requested:
        return set(), [], {}
    runs = {run.id: run for run in db.scalars(select(Run).where(Run.id.in_(requested))).all()}
    blocked_by_baseline = _run_ids_blocked_by_baseline_refs(db, set(runs))
    deletable: set[str] = set()
    missing: list[str] = []
    failed: dict[str, str] = {}
    for run_id in requested:
        run = runs.get(run_id)
        if not run:
            missing.append(run_id)
            continue
        if run.status == "running":
            failed[run_id] = "Running runs must be canceled before deletion"
            continue
        if run_id in blocked_by_baseline:
            failed[run_id] = blocked_by_baseline[run_id]
            continue
        deletable.add(run_id)
    return deletable, missing, failed


@app.post("/api/runs/bulk-delete")
def bulk_delete_runs(
    data: BulkDeleteRequest,
    _admin: None = Depends(require_admin_if_configured),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    if not data.ids:
        return {"deleted": 0, "missing": [], "failed": {}}
    run_ids = list(dict.fromkeys(str(item).strip() for item in data.ids if str(item).strip()))
    deletable_ids, missing, failed = _preflight_deletable_run_ids(db, run_ids)
    deleted = _delete_runs_by_ids(db, deletable_ids, repair_refs=True)
    db.commit()
    return {"deleted": deleted, "missing": missing, "failed": failed}


@app.delete("/api/runs/{run_id}")
def delete_run(
    run_id: str,
    _admin: None = Depends(require_admin_if_configured),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    if not _delete_run_by_id(db, run_id):
        raise HTTPException(status_code=404, detail="Run not found")
    db.commit()
    return {"deleted": True}


@app.post("/api/runs/{run_id}/generate-report", response_model=list[ReportRead])
def generate_report_alias(run_id: str, db: Session = Depends(get_db)) -> list[Report]:
    run = require_run(db, run_id)
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
    updated = False
    for report in reports:
        updated = hydrate_report_markdown(db, report) or updated
    if updated:
        db.commit()
    markdown = redact_text("\n\n---\n\n".join(report.markdown or "" for report in reports))
    return Response(markdown, media_type="text/markdown; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{run_id}.md"'})


@app.get("/api/runs/{run_id}/report.md")
def download_report_alias(run_id: str, db: Session = Depends(get_db)) -> Response:
    return download_report(run_id, db)
