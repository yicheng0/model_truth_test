from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AuditLog, BaselineResult, BaselineSnapshot, Channel, ChannelAlert, ChannelGroup, ChannelGroupMember, Comparison, PatrolJob, PatrolJobAttempt, Report, Result, Run, RunChannel, ScheduledChannelTest, TestCase
from ..redaction import merge_redacted_config, redact_secrets, redact_text
from ..seed_utils import ensure_seed_data_when_empty
from ..schemas import (
    CacheHitRateTestCreate,
    CacheHitRateTestRead,
    ChannelCreate,
    ChannelGroupCreate,
    ChannelGroupMembershipUpdate,
    ChannelGroupRead,
    ChannelGroupUpdate,
    ChannelHealthProfileRead,
    ChannelRead,
    ChannelUpdate,
    GeminiResourceCheckCreate,
    GeminiResourceCheckRead,
    FullModelCheckCreate,
    FullModelCheckPlanCreate,
    FullModelCheckRead,
    ModelRequestTestCreate,
    ModelRequestTestRead,
    OpenAIResourceCheckCreate,
    OpenAIResourceCheckRead,
    RunRead,
    SignatureInteropTestCreate,
    SignatureInteropTestRead,
)
from ..services import (
    _clean_auth_config,
    _avg,
    create_cache_hit_rate_test,
    create_channel,
    create_full_model_check,
    full_model_check_plan,
    create_gemini_resource_check,
    create_model_request_test,
    create_openai_resource_check,
    create_signature_interop_test,
    fetch_channel_models,
    request_id_from_normalized,
    replace_channel_groups,
    _metric_number,
    _pct,
    _percentile,
)


router = APIRouter()
logger = logging.getLogger(__name__)


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


def channel_group_read(db: Session, group: ChannelGroup) -> dict[str, object]:
    channel_count = int(db.scalar(select(func.count()).select_from(ChannelGroupMember).where(ChannelGroupMember.group_id == group.id)) or 0)
    enabled_channel_count = int(
        db.scalar(
            select(func.count())
            .select_from(ChannelGroupMember)
            .join(Channel, Channel.id == ChannelGroupMember.channel_id)
            .where(ChannelGroupMember.group_id == group.id, Channel.enabled.is_(True))
        )
        or 0
    )
    return {
        "id": group.id,
        "key": group.key,
        "name": group.name,
        "description": group.description,
        "color": group.color,
        "sort_order": group.sort_order,
        "enabled": group.enabled,
        "channel_count": channel_count,
        "enabled_channel_count": enabled_channel_count,
        "created_at": group.created_at,
        "updated_at": group.updated_at,
    }


@router.get("/api/channel-groups", response_model=list[ChannelGroupRead])
def list_channel_groups(db: Session = Depends(get_db)) -> list[dict[str, object]]:
    groups = db.scalars(select(ChannelGroup).order_by(ChannelGroup.sort_order, ChannelGroup.name, ChannelGroup.id)).all()
    return [channel_group_read(db, group) for group in groups]


@router.post("/api/channel-groups", response_model=ChannelGroupRead)
def add_channel_group(data: ChannelGroupCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    import uuid

    group = ChannelGroup(id=f"grp_{uuid.uuid4().hex[:12]}", **data.model_dump())
    db.add(group)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Channel group key already exists") from exc
    db.refresh(group)
    return channel_group_read(db, group)


@router.patch("/api/channel-groups/{group_id}", response_model=ChannelGroupRead)
def update_channel_group(group_id: str, data: ChannelGroupUpdate, db: Session = Depends(get_db)) -> dict[str, object]:
    group = db.get(ChannelGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Channel group not found")
    values = data.model_dump(exclude_unset=True)
    if "name" in values:
        values["name"] = values["name"].strip()
    for key, value in values.items():
        setattr(group, key, value)
    db.commit()
    db.refresh(group)
    return channel_group_read(db, group)


@router.delete("/api/channel-groups/{group_id}")
def remove_channel_group(group_id: str, db: Session = Depends(get_db)) -> dict[str, object]:
    group = db.get(ChannelGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Channel group not found")
    unlinked = int(db.scalar(select(func.count()).select_from(ChannelGroupMember).where(ChannelGroupMember.group_id == group_id)) or 0)
    db.execute(delete(ChannelGroupMember).where(ChannelGroupMember.group_id == group_id))
    db.delete(group)
    db.commit()
    return {"deleted": True, "unlinked_channels": unlinked}


@router.get("/api/channels", response_model=list[ChannelRead])
def list_channels(group_id: str | None = None, db: Session = Depends(get_db)) -> list[Channel]:
    ensure_seed_data_when_empty(db, Channel)
    stmt = select(Channel).order_by(Channel.role, Channel.name)
    if group_id:
        if not db.get(ChannelGroup, group_id):
            raise HTTPException(status_code=404, detail="Channel group not found")
        stmt = stmt.join(ChannelGroupMember, ChannelGroupMember.channel_id == Channel.id).where(ChannelGroupMember.group_id == group_id)
    return list(db.scalars(stmt).unique().all())


@router.post("/api/channels", response_model=ChannelRead)
def add_channel(data: ChannelCreate, db: Session = Depends(get_db)) -> Channel:
    try:
        return create_channel(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/channels/{channel_id}", response_model=ChannelRead)
def get_channel(channel_id: str, db: Session = Depends(get_db)) -> Channel:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    return channel


@router.patch("/api/channels/{channel_id}", response_model=ChannelRead)
def update_channel(channel_id: str, data: ChannelUpdate, db: Session = Depends(get_db)) -> Channel:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    safe_columns = {"name", "provider_type", "role", "base_url", "model_name", "is_reference", "enabled", "auth_config"}
    for key, value in data.model_dump(exclude_unset=True).items():
        if key not in safe_columns:
            continue
        if key == "auth_config":
            channel.auth_config_encrypted = _clean_auth_config(merge_redacted_config(channel.auth_config_encrypted, value))
        else:
            setattr(channel, key, value)
    if data.group_ids is not None:
        try:
            replace_channel_groups(db, channel, data.group_ids, commit=False)
        except ValueError as exc:
            db.rollback()
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    if data.is_reference is not None and data.role is None:
        channel.role = "gold" if channel.is_reference else "candidate"
    db.commit()
    db.refresh(channel)
    return channel


@router.put("/api/channels/{channel_id}/groups", response_model=ChannelRead)
def set_channel_groups(channel_id: str, data: ChannelGroupMembershipUpdate, db: Session = Depends(get_db)) -> Channel:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    try:
        return replace_channel_groups(db, channel, data.group_ids)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _count_for(db: Session, model: type, *criteria) -> int:  # noqa: ANN001
    if not criteria:
        return int(db.scalar(select(func.count()).select_from(model)) or 0)
    return int(db.scalar(select(func.count()).select_from(model).where(*criteria)) or 0)


def _id_set_for(db: Session, model: type, *criteria) -> set[str]:  # noqa: ANN001
    if not criteria:
        return {str(item) for item in db.scalars(select(model.id)).all()}
    return {str(item) for item in db.scalars(select(model.id).where(*criteria)).all()}


def _rowcount(result) -> int:  # noqa: ANN001
    return int(result.rowcount or 0)


def _in_or_false(column, values: set[str]):  # noqa: ANN001
    return column.in_(values) if values else False


def _channel_or_deletable_run_filter(channel_column, channel_id: str, run_column, run_ids: set[str]):  # noqa: ANN001
    if run_ids:
        return or_(channel_column == channel_id, run_column.in_(run_ids))
    return channel_column == channel_id


def _channel_delete_run_ids(db: Session, channel_id: str) -> set[str]:
    run_ids = set(db.scalars(select(RunChannel.run_id).where(RunChannel.channel_id == channel_id)).all())
    run_ids.update(db.scalars(select(Result.run_id).where(Result.channel_id == channel_id)).all())
    run_ids.update(db.scalars(select(Report.run_id).where(Report.channel_id == channel_id)).all())
    run_ids.update(db.scalars(select(ChannelAlert.run_id).where(ChannelAlert.channel_id == channel_id)).all())
    run_ids.update(db.scalars(select(Comparison.run_id).where(Comparison.candidate_channel_id == channel_id)).all())
    run_ids.update(db.scalars(select(PatrolJob.run_id).where(PatrolJob.channel_id == channel_id, PatrolJob.run_id.is_not(None))).all())
    return {str(run_id) for run_id in run_ids if run_id}


def _run_ids_deletable_after_channel_cleanup(db: Session, run_ids: set[str], channel_id: str) -> set[str]:
    if not run_ids:
        return set()
    shared_run_ids: set[str] = set()
    shared_run_ids.update(db.scalars(select(RunChannel.run_id).where(RunChannel.run_id.in_(run_ids), RunChannel.channel_id != channel_id)).all())
    shared_run_ids.update(db.scalars(select(Result.run_id).where(Result.run_id.in_(run_ids), Result.channel_id != channel_id)).all())
    shared_run_ids.update(db.scalars(select(Report.run_id).where(Report.run_id.in_(run_ids), Report.channel_id != channel_id)).all())
    shared_run_ids.update(db.scalars(select(ChannelAlert.run_id).where(ChannelAlert.run_id.in_(run_ids), ChannelAlert.channel_id != channel_id)).all())
    shared_run_ids.update(db.scalars(select(Comparison.run_id).where(Comparison.run_id.in_(run_ids), Comparison.candidate_channel_id != channel_id)).all())
    shared_run_ids.update(db.scalars(select(PatrolJob.run_id).where(PatrolJob.run_id.in_(run_ids), PatrolJob.channel_id != channel_id)).all())
    return {str(run_id) for run_id in run_ids if run_id and str(run_id) not in {str(item) for item in shared_run_ids if item}}


def _delete_channel_and_related_data(db: Session, channel: Channel) -> dict[str, object]:
    channel_id = channel.id
    touched_run_ids = _channel_delete_run_ids(db, channel_id)
    deletable_run_ids = _run_ids_deletable_after_channel_cleanup(db, touched_run_ids, channel_id)
    baseline_source_run_ids = set(db.scalars(select(BaselineSnapshot.source_run_id).where(BaselineSnapshot.source_run_id.in_(deletable_run_ids))).all()) if deletable_run_ids else set()
    deletable_run_ids -= {str(run_id) for run_id in baseline_source_run_ids if run_id}

    schedule_ids = set(db.scalars(select(ScheduledChannelTest.id).where(ScheduledChannelTest.channel_id == channel_id)).all())
    job_filter = _channel_or_deletable_run_filter(PatrolJob.channel_id, channel_id, PatrolJob.run_id, deletable_run_ids)
    job_id_query = select(PatrolJob.id).where(job_filter)

    stats = {"deleted": True, "deleted_runs": 0}
    stats["deleted_patrol_job_attempts"] = _rowcount(
        db.execute(
            delete(PatrolJobAttempt).where(
                or_(
                    PatrolJobAttempt.job_id.in_(job_id_query),
                    _in_or_false(PatrolJobAttempt.run_id, deletable_run_ids),
                )
            )
        )
    )
    stats["deleted_patrol_jobs"] = _rowcount(db.execute(delete(PatrolJob).where(job_filter)))
    if schedule_ids:
        stats["deleted_alerts"] = _rowcount(db.execute(delete(ChannelAlert).where(ChannelAlert.scheduled_test_id.in_(schedule_ids))))
        stats["deleted_schedules"] = _rowcount(db.execute(delete(ScheduledChannelTest).where(ScheduledChannelTest.id.in_(schedule_ids))))
    else:
        stats["deleted_alerts"] = 0
        stats["deleted_schedules"] = 0

    if deletable_run_ids:
        db.execute(update(ScheduledChannelTest).where(ScheduledChannelTest.last_run_id.in_(deletable_run_ids)).values(last_run_id=None))

    stats["deleted_alerts"] += _rowcount(db.execute(delete(ChannelAlert).where(_channel_or_deletable_run_filter(ChannelAlert.channel_id, channel_id, ChannelAlert.run_id, deletable_run_ids))))
    stats["deleted_baselines"] = _rowcount(db.execute(delete(BaselineResult).where(BaselineResult.channel_id == channel_id)))
    stats["deleted_reports"] = _rowcount(db.execute(delete(Report).where(_channel_or_deletable_run_filter(Report.channel_id, channel_id, Report.run_id, deletable_run_ids))))
    stats["deleted_comparisons"] = _rowcount(db.execute(delete(Comparison).where(_channel_or_deletable_run_filter(Comparison.candidate_channel_id, channel_id, Comparison.run_id, deletable_run_ids))))
    stats["deleted_results"] = _rowcount(db.execute(delete(Result).where(_channel_or_deletable_run_filter(Result.channel_id, channel_id, Result.run_id, deletable_run_ids))))
    stats["deleted_run_channels"] = _rowcount(db.execute(delete(RunChannel).where(_channel_or_deletable_run_filter(RunChannel.channel_id, channel_id, RunChannel.run_id, deletable_run_ids))))

    if deletable_run_ids:
        stats["deleted_runs"] = _rowcount(db.execute(delete(Run).where(Run.id.in_(deletable_run_ids))))

    db.execute(delete(ChannelGroupMember).where(ChannelGroupMember.channel_id == channel_id))
    db.delete(channel)
    return stats


@router.delete("/api/channels/{channel_id}")
def remove_channel(
    channel_id: str,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    payload = _delete_channel_and_related_data(db, channel)
    db.commit()
    return payload


@router.post("/api/channels/{channel_id}/health-check")
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


def _dt_key(value: datetime | None) -> str:
    if not value:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).date().isoformat()


def _sorted_counts(values: list[str]) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for value in values:
        if value:
            counts[value] += 1
    return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))


def _result_error_type(result: Result) -> str | None:
    metrics = result.metrics if isinstance(result.metrics, dict) else {}
    normalized = result.normalized_response if isinstance(result.normalized_response, dict) else {}
    raw = result.raw_response if isinstance(result.raw_response, dict) else {}
    error_type = metrics.get("error_type") or normalized.get("error_type")
    if error_type:
        return str(error_type)
    raw_error = raw.get("error")
    if isinstance(raw_error, dict):
        return str(raw_error.get("type") or raw_error.get("code") or raw_error.get("status") or "provider_error")
    if normalized.get("error"):
        return "request_failed"
    return None


def _result_error_excerpt(result: Result) -> str | None:
    normalized = result.normalized_response if isinstance(result.normalized_response, dict) else {}
    raw = result.raw_response if isinstance(result.raw_response, dict) else {}
    for value in (normalized.get("error"), raw.get("error")):
        if not value:
            continue
        if isinstance(value, str):
            return redact_text(value)[:500]
        return redact_text(str(redact_secrets(value)))[:500]
    return None


def _result_http_status(result: Result) -> int | None:
    metrics = result.metrics if isinstance(result.metrics, dict) else {}
    normalized = result.normalized_response if isinstance(result.normalized_response, dict) else {}
    for source in (metrics, normalized):
        value = source.get("status_code") or source.get("http_status")
        if isinstance(value, int):
            return value
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def _result_message_id(result: Result) -> str | None:
    normalized = result.normalized_response if isinstance(result.normalized_response, dict) else {}
    raw = result.raw_response if isinstance(result.raw_response, dict) else {}
    value = normalized.get("provider_message_id") or raw.get("id") or raw.get("message_id")
    return str(value) if value else None


def _result_failed(result: Result) -> bool:
    normalized = result.normalized_response if isinstance(result.normalized_response, dict) else {}
    status_code = _result_http_status(result)
    return bool(normalized.get("error") or (status_code is not None and status_code >= 400) or "request_failed" in (result.labels or []) or (result.score <= 0 and result.labels))


def _result_failure_kind(result: Result | dict[str, Any]) -> str | None:
    """Classify a result for health dimensions without changing its base score."""
    if isinstance(result, dict):
        normalized = result.get("normalized_response") if isinstance(result.get("normalized_response"), dict) else {}
        metrics = result.get("metrics") if isinstance(result.get("metrics"), dict) else {}
        labels = result.get("labels") if isinstance(result.get("labels"), list) else []
        score = result.get("score")
    else:
        normalized = result.normalized_response if isinstance(result.normalized_response, dict) else {}
        metrics = result.metrics if isinstance(result.metrics, dict) else {}
        labels = result.labels if isinstance(result.labels, list) else []
        score = result.score

    label_set = {str(label) for label in labels if label}
    status_code = metrics.get("status_code") or metrics.get("http_status")
    try:
        status_code = int(status_code) if status_code is not None else None
    except (TypeError, ValueError):
        status_code = None
    if normalized.get("error") or "request_failed" in label_set or (status_code is not None and status_code >= 400):
        return "request_failed"

    protocol_labels = {
        "protocol_mismatch",
        "model_name_mismatch",
        "usage_missing",
        "streaming_event_missing",
        "tool_use_invalid",
        "max_tokens_not_enforced",
        "stop_reason_openai_style",
    }
    if label_set & protocol_labels:
        return "protocol_failure"

    if "quality_regression" in label_set or "suspected_model_swap" in label_set or (isinstance(score, (int, float)) and score < 65):
        return "quality_regression"

    operational_labels = {"latency_outlier", "ttft_outlier", "suspected_cache", "context_loss"}
    if label_set & operational_labels:
        return "operational_anomaly"
    return None


def _signature_payload(result: Result) -> dict[str, Any] | None:
    payload = _signature_interop_signature_from_result(result)
    return payload if isinstance(payload, dict) else None


def _channel_health_status(total_results: int, failure_rate: float | None, pending_alerts: int) -> str:
    if total_results <= 0:
        return "insufficient_data"
    if (failure_rate or 0) >= 30 or pending_alerts > 0:
        return "degraded"
    return "ok"


def _health_confidence(db: Session, results: list[Result], days: int, latest_historical_result: Result | None = None) -> dict[str, Any]:
    sample_count = len(results)
    independent_run_count = len({result.run_id for result in results})
    case_ids = {result.test_case_id for result in results if result.test_case_id}
    modules = set(db.scalars(select(TestCase.module).where(TestCase.id.in_(case_ids))).all()) if case_ids else set()
    module_coverage = min(1.0, len(modules) / 4) if modules else 0.0
    latest = results[0].created_at if results else (latest_historical_result.created_at if latest_historical_result else None)
    now = datetime.now(timezone.utc)
    if latest and latest.tzinfo is None:
        latest = latest.replace(tzinfo=timezone.utc)
    freshness_hours = round(max(0.0, (now - latest).total_seconds() / 3600), 2) if latest else None
    reasons: list[str] = []
    if sample_count < 10:
        reasons.append("sample_count_low")
    if independent_run_count < 2:
        reasons.append("independent_runs_low")
    if module_coverage < 0.5:
        reasons.append("module_coverage_low")
    stale_after_hours = max(24.0, days * 24.0 * 2)
    if freshness_hours is None or freshness_hours > stale_after_hours:
        reasons.append("data_stale")

    sample_factor = min(1.0, sample_count / 30)
    run_factor = min(1.0, independent_run_count / 3)
    coverage_factor = min(1.0, module_coverage)
    freshness_factor = 0.0 if freshness_hours is None else max(0.0, min(1.0, 1 - freshness_hours / stale_after_hours))
    score = round((sample_factor * 0.35 + run_factor * 0.25 + coverage_factor * 0.2 + freshness_factor * 0.2) * 100, 2)
    if sample_count >= 30 and independent_run_count >= 3 and module_coverage >= 0.75 and not (freshness_hours is None or freshness_hours > stale_after_hours):
        level = "high"
    elif sample_count >= 10 and independent_run_count >= 2 and module_coverage >= 0.5 and not (freshness_hours is None or freshness_hours > stale_after_hours):
        level = "medium"
    else:
        level = "low"
    return {
        "level": level,
        "score": score,
        "sample_count": sample_count,
        "independent_run_count": independent_run_count,
        "module_coverage": round(module_coverage, 4),
        "freshness_hours": freshness_hours,
        "reasons": reasons,
    }


def _dimension_status(score: float, *, inconclusive: bool = False) -> str:
    if inconclusive:
        return "inconclusive"
    if score >= 90:
        return "healthy"
    if score >= 75:
        return "watch"
    if score >= 50:
        return "degraded"
    return "critical"


def _health_dimensions(db: Session, channel_id: str, results: list[Result]) -> dict[str, Any]:
    failures = [result for result in results if _result_failed(result)]
    success_results = [result for result in results if not _result_failed(result)]
    success_rate = (len(success_results) / len(results) * 100) if results else 0.0
    request_failures = [result for result in failures if _result_failure_kind(result) == "request_failed"]
    availability_score = max(0.0, min(100.0, success_rate - (len(request_failures) / len(results) * 30 if results else 0)))
    availability_reasons: list[str] = []
    if request_failures:
        availability_reasons.append("request_failures_present")
    availability = {
        "score": round(availability_score, 2),
        "status": _dimension_status(availability_score, inconclusive=not results),
        "reasons": availability_reasons,
        "details": {"success_rate": round(success_rate, 2), "failure_count": len(failures), "request_failure_count": len(request_failures)},
    }

    successful_latencies = [_metric_number(result, "latency_ms") for result in success_results]
    successful_ttfts = [_metric_number(result, "ttft_ms") or _metric_number(result, "first_token_ms") for result in success_results]
    successful_tps = [_metric_number(result, "tokens_per_second") for result in success_results]
    latency_p95 = _percentile(successful_latencies, 95)
    latency_p50 = _percentile(successful_latencies, 50)
    latency_p99 = _percentile(successful_latencies, 99)
    ttft_p95 = _percentile(successful_ttfts, 95)
    tps_p50 = _percentile(successful_tps, 50)
    performance_score = 100.0
    performance_reasons: list[str] = []
    if latency_p95 is not None and latency_p95 > 2500:
        performance_score -= min(45.0, (latency_p95 - 2500) / 50)
        performance_reasons.append("latency_p95_high")
    if ttft_p95 is not None and ttft_p95 > 1500:
        performance_score -= min(35.0, (ttft_p95 - 1500) / 40)
        performance_reasons.append("ttft_p95_high")
    if tps_p50 is not None and tps_p50 < 5:
        performance_score -= 20
        performance_reasons.append("throughput_low")
    performance = {
        "score": round(max(0.0, performance_score), 2),
        "status": _dimension_status(performance_score, inconclusive=not successful_latencies),
        "reasons": performance_reasons,
        "details": {"p50_latency_ms": latency_p50, "p95_latency_ms": latency_p95, "p99_latency_ms": latency_p99, "p95_ttft_ms": ttft_p95, "p50_tokens_per_second": tps_p50, "successful_sample_count": len(success_results)},
    }

    protocol_labels = {"protocol_mismatch", "model_name_mismatch", "usage_missing", "streaming_event_missing", "tool_use_invalid", "max_tokens_not_enforced", "stop_reason_openai_style"}
    protocol_issues = [label for result in results for label in (result.labels or []) if label in protocol_labels]
    protocol_score = max(0.0, 100.0 - len(protocol_issues) / len(results) * 100) if results else 0.0
    protocol = {
        "score": round(protocol_score, 2),
        "status": _dimension_status(protocol_score, inconclusive=not results),
        "reasons": sorted(set(protocol_issues)),
        "details": {"issue_count": len(protocol_issues), "issue_rate": round(len(protocol_issues) / len(results) * 100, 2) if results else 0.0},
    }

    comparisons = list(db.scalars(select(Comparison).where(Comparison.candidate_channel_id == channel_id, Comparison.run_id.in_({result.run_id for result in results}))).all()) if results else []
    gold_similarity = _avg([comparison.gold_similarity for comparison in comparisons])
    cloud_similarity = _avg([comparison.official_cloud_similarity for comparison in comparisons])
    quality_score = gold_similarity if gold_similarity is not None else (_avg([result.score for result in results]) if results else None)
    quality_reasons: list[str] = []
    if quality_score is not None and quality_score < 80:
        quality_reasons.append("quality_regression")
    quality = {
        "score": round(quality_score if quality_score is not None else 0.0, 2),
        "status": _dimension_status(quality_score or 0.0, inconclusive=quality_score is None),
        "reasons": quality_reasons,
        "details": {"gold_similarity": gold_similarity, "official_cloud_similarity": cloud_similarity, "comparison_count": len(comparisons)},
    }
    return {"availability": availability, "performance": performance, "protocol": protocol, "quality": quality}


def _reference_metric(candidate: float | None, values: list[float | None]) -> dict[str, Any]:
    clean = [value for value in values if value is not None]
    lower = _percentile(clean, 5) if clean else None
    upper = _percentile(clean, 95) if clean else None
    deviation = None
    if candidate is not None and clean:
        if candidate < (lower or candidate):
            deviation = round((candidate - (lower or candidate)) / max(abs(lower or 1), 1), 4)
        elif candidate > (upper or candidate):
            deviation = round((candidate - (upper or candidate)) / max(abs(upper or 1), 1), 4)
        else:
            deviation = 0.0
    return {"candidate": candidate, "lower": lower, "upper": upper, "deviation_ratio": deviation}


def _health_reference_band(db: Session, channel_id: str, results: list[Result]) -> dict[str, Any]:
    if not results:
        return {"status": "baseline_inconclusive", "p95_latency_ms": {}, "ttft_ms": {}, "gold_similarity": {}, "official_cloud_similarity": {}}
    run_ids = {result.run_id for result in results}
    candidate_latencies = [_metric_number(result, "latency_ms") for result in results if not _result_failed(result)]
    candidate_ttfts = [_metric_number(result, "ttft_ms") or _metric_number(result, "first_token_ms") for result in results if not _result_failed(result)]
    candidate_comparisons = list(db.scalars(select(Comparison).where(Comparison.candidate_channel_id == channel_id, Comparison.run_id.in_(run_ids))).all())
    candidate_channel = db.get(Channel, channel_id)
    all_channels = list(db.scalars(select(Channel).where(Channel.role.in_(["gold", "official_cloud"]))).all())
    if candidate_channel and candidate_channel.model_name:
        matching = [channel for channel in all_channels if not channel.model_name or channel.model_name == candidate_channel.model_name]
        all_channels = matching or all_channels
    if not all_channels:
        return {"status": "baseline_inconclusive", "p95_latency_ms": _reference_metric(_percentile(candidate_latencies, 95), []), "ttft_ms": _reference_metric(_percentile(candidate_ttfts, 95), []), "gold_similarity": _reference_metric(_avg([item.gold_similarity for item in candidate_comparisons]), []), "official_cloud_similarity": _reference_metric(_avg([item.official_cloud_similarity for item in candidate_comparisons]), [])}
    candidate_runs = list(db.scalars(select(Run).where(Run.id.in_({result.run_id for result in results}))).all())
    suite_ids = {run.suite_id for run in candidate_runs}
    case_ids = {result.test_case_id for result in results}
    reference_results = list(
        db.scalars(
            select(Result)
            .join(Run, Run.id == Result.run_id)
            .where(
                Result.channel_id.in_([channel.id for channel in all_channels]),
                Result.test_case_id.in_(case_ids),
                Run.suite_id.in_(suite_ids),
                Result.created_at >= min(result.created_at for result in results),
            )
        ).all()
    )
    gold_results = [result for result in reference_results if next((channel.role for channel in all_channels if channel.id == result.channel_id), None) == "gold"]
    cloud_results = [result for result in reference_results if next((channel.role for channel in all_channels if channel.id == result.channel_id), None) == "official_cloud"]
    gold_comparisons = [item for item in candidate_comparisons if item.gold_similarity > 0]
    cloud_comparisons = [item for item in candidate_comparisons if item.official_cloud_similarity > 0]
    reference_failure_rate = len([result for result in reference_results if _result_failed(result)]) / len(reference_results) if reference_results else 0.0
    status = "baseline_unhealthy" if reference_results and reference_failure_rate >= 0.30 else "ready" if gold_results or cloud_results or gold_comparisons or cloud_comparisons else "baseline_inconclusive"
    return {
        "status": status,
        "p95_latency_ms": _reference_metric(_percentile(candidate_latencies, 95), [_metric_number(item, "latency_ms") for item in gold_results + cloud_results]),
        "ttft_ms": _reference_metric(_percentile(candidate_ttfts, 95), [_metric_number(item, "ttft_ms") or _metric_number(item, "first_token_ms") for item in gold_results + cloud_results]),
        "gold_similarity": _reference_metric(_avg([item.gold_similarity for item in candidate_comparisons]), [item.gold_similarity for item in gold_comparisons]),
        "official_cloud_similarity": _reference_metric(_avg([item.official_cloud_similarity for item in candidate_comparisons]), [item.official_cloud_similarity for item in cloud_comparisons]),
    }


def _health_status_reasons(dimensions: dict[str, Any], reference_band: dict[str, Any], pending_alerts: int) -> list[dict[str, Any]]:
    reasons: list[dict[str, Any]] = []
    for dimension, payload in dimensions.items():
        for code in payload.get("reasons", []):
            details = payload.get("details") or {}
            value = details.get("p95_latency_ms") if code == "latency_p95_high" else details.get("p95_ttft_ms") if code == "ttft_p95_high" else details.get("success_rate")
            threshold = 2500 if code == "latency_p95_high" else 1500 if code == "ttft_p95_high" else None
            reasons.append({"dimension": dimension, "code": code, "value": value, "threshold": threshold, "impact": "影响健康画像评分，需要结合样本和参考带复核。", "labels": [code]})
    if reference_band.get("status") != "ready":
        reasons.append({"dimension": "protocol", "code": reference_band.get("status", "baseline_inconclusive"), "value": None, "threshold": None, "impact": "官方参考样本不足，来源一致性暂不下结论。", "labels": [reference_band.get("status", "baseline_inconclusive")]})
    if pending_alerts:
        reasons.append({"dimension": "availability", "code": "pending_alerts", "value": pending_alerts, "threshold": 0, "impact": "存在待复审告警。", "labels": ["pending_alerts"]})
    return reasons[:5]


def _health_window_state(results: list[Result], days: int) -> dict[str, Any]:
    """Evaluate adjacent half-windows so transient spikes do not downgrade a channel."""
    if not results:
        return {"current_issue": False, "previous_issue": False, "current_healthy": False, "previous_healthy": False, "severe": False}
    now = datetime.now(timezone.utc)
    midpoint = now - timedelta(days=max(days / 2, 0.5))
    current = [result for result in results if (result.created_at or now).replace(tzinfo=timezone.utc) >= midpoint]
    previous = [result for result in results if (result.created_at or now).replace(tzinfo=timezone.utc) < midpoint]

    def issue(items: list[Result]) -> bool:
        if not items:
            return False
        failures = [item for item in items if _result_failed(item)]
        return len(failures) / len(items) >= 0.30

    severe_labels = {"protocol_mismatch", "streaming_event_missing", "tool_use_invalid", "model_name_mismatch"}
    severe = any(severe_labels.intersection(set(result.labels or [])) for result in results)
    ordered = sorted(results, key=lambda item: item.created_at or now, reverse=True)
    consecutive_failures = 0
    for result in ordered:
        if _result_failed(result):
            consecutive_failures += 1
        else:
            break
    return {
        "current_issue": issue(current),
        "previous_issue": issue(previous),
        "current_healthy": bool(current) and not issue(current),
        "previous_healthy": bool(previous) and not issue(previous),
        "severe": severe or consecutive_failures >= 3,
        "consecutive_failures": consecutive_failures,
    }


@router.get("/api/channels/{channel_id}/health-profile", response_model=ChannelHealthProfileRead)
def channel_health_profile(channel_id: str, days: int = 7, db: Session = Depends(get_db)) -> dict[str, object]:
    if days not in {1, 7, 30}:
        raise HTTPException(status_code=400, detail="days must be one of 1, 7, 30")
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    since = datetime.now(timezone.utc) - timedelta(days=days)
    results = list(
        db.scalars(
            select(Result)
            .where(Result.channel_id == channel_id, Result.created_at >= since)
            .order_by(Result.created_at.desc(), Result.id.desc())
        ).all()
    )
    latest_historical_result = None
    if not results:
        latest_historical_result = db.scalar(
            select(Result)
            .where(Result.channel_id == channel_id)
            .order_by(Result.created_at.desc(), Result.id.desc())
            .limit(1)
        )
    run_ids = {result.run_id for result in results}
    linked_runs = list(
        db.scalars(
            select(Run)
            .join(RunChannel, RunChannel.run_id == Run.id)
            .where(RunChannel.channel_id == channel_id, Run.created_at >= since)
            .order_by(Run.created_at.desc())
        ).all()
    )
    for run in linked_runs:
        run_ids.add(run.id)
    runs_by_id = {run.id: run for run in linked_runs}
    if run_ids:
        for run in db.scalars(select(Run).where(Run.id.in_(run_ids))).all():
            runs_by_id[run.id] = run

    failures = [result for result in results if _result_failed(result)]
    successes = [result for result in results if not _result_failed(result)]
    latencies = [_metric_number(result, "latency_ms") for result in results]
    labels = [label for result in results for label in (result.labels or []) if label]
    error_types = [_result_error_type(result) or "unknown_error" for result in failures]

    by_date: dict[str, list[Result]] = defaultdict(list)
    for result in results:
        by_date[_dt_key(result.created_at)].append(result)
    trend = []
    for offset in range(days - 1, -1, -1):
        day = (datetime.now(timezone.utc) - timedelta(days=offset)).date().isoformat()
        day_results = by_date.get(day, [])
        day_failures = [result for result in day_results if _result_failed(result)]
        day_run_ids = {result.run_id for result in day_results}
        trend.append(
            {
                "date": day,
                "run_count": len(day_run_ids),
                "result_count": len(day_results),
                "success_count": len(day_results) - len(day_failures),
                "failure_count": len(day_failures),
                "avg_latency_ms": _avg([_metric_number(result, "latency_ms") for result in day_results]),
                "success_rate": _pct(len(day_results) - len(day_failures), len(day_results)),
                "p95_latency_ms": _percentile([_metric_number(result, "latency_ms") for result in day_results if not _result_failed(result)], 95),
                "avg_ttft_ms": _avg([_metric_number(result, "ttft_ms") or _metric_number(result, "first_token_ms") for result in day_results if not _result_failed(result)]),
            }
        )

    probe_summaries = []
    by_probe: dict[str, list[Result]] = defaultdict(list)
    for result in results:
        key = result.test_case_id or "unknown_probe"
        if _signature_payload(result):
            key = "signature_interop"
        by_probe[key].append(result)
    for key, items in sorted(by_probe.items()):
        failed = [result for result in items if _result_failed(result)]
        probe_summaries.append(
            {
                "key": key,
                "total": len(items),
                "success_count": len(items) - len(failed),
                "failure_count": len(failed),
                "success_rate": _pct(len(items) - len(failed), len(items)),
                "avg_latency_ms": _avg([_metric_number(result, "latency_ms") for result in items]),
                "p95_latency_ms": _percentile([_metric_number(result, "latency_ms") for result in items], 95),
            }
        )

    signature_results = [result for result in results if _signature_payload(result)]
    signature_payloads = [_signature_payload(result) or {} for result in signature_results]
    signature_pass = [payload for payload in signature_payloads if str(payload.get("status") or "").lower() == "pass" or payload.get("ok") is True]
    latest_signature = signature_payloads[0] if signature_payloads else {}
    signature_summary = {
        "total": len(signature_payloads),
        "pass_count": len(signature_pass),
        "fail_count": max(0, len(signature_payloads) - len(signature_pass)),
        "pass_rate": _pct(len(signature_pass), len(signature_payloads)),
        "latest_status": latest_signature.get("status"),
        "latest_reason": redact_text(str(latest_signature.get("reason") or ""))[:500] or None,
        "latest_created_at": signature_results[0].created_at if signature_results else None,
    }

    schedules = list(db.scalars(select(ScheduledChannelTest).where(ScheduledChannelTest.channel_id == channel_id)).all())
    alerts = list(db.scalars(select(ChannelAlert).where(ChannelAlert.channel_id == channel_id, ChannelAlert.created_at >= since)).all())
    jobs = list(db.scalars(select(PatrolJob).where(PatrolJob.channel_id == channel_id, PatrolJob.created_at >= since)).all())
    job_ids = [job.id for job in jobs]
    attempts = list(db.scalars(select(PatrolJobAttempt).where(PatrolJobAttempt.job_id.in_(job_ids))).all()) if job_ids else []
    latest_schedule = max(schedules, key=lambda item: item.last_finished_at or item.last_started_at or item.created_at) if schedules else None
    patrol_summary = {
        "schedule_count": len(schedules),
        "enabled_schedule_count": len([item for item in schedules if item.enabled]),
        "latest_status": latest_schedule.last_status if latest_schedule else None,
        "latest_error": redact_text(latest_schedule.last_error)[:500] if latest_schedule and latest_schedule.last_error else None,
        "latest_finished_at": latest_schedule.last_finished_at if latest_schedule else None,
        "alert_count": len(alerts),
        "pending_alert_count": len([alert for alert in alerts if alert.status == "pending_review"]),
        "job_status_counts": _sorted_counts([job.status for job in jobs]),
        "attempt_status_counts": _sorted_counts([attempt.status for attempt in attempts]),
    }

    recent_failures = []
    for result in failures[:10]:
        run = runs_by_id.get(result.run_id)
        normalized = result.normalized_response if isinstance(result.normalized_response, dict) else {}
        recent_failures.append(
            {
                "result_id": result.id,
                "run_id": result.run_id,
                "run_name": run.name if run else None,
                "created_at": result.created_at,
                "http_status": _result_http_status(result),
                "request_id": request_id_from_normalized(normalized),
                "message_id": _result_message_id(result),
                "error_type": _result_error_type(result),
                "error_excerpt": _result_error_excerpt(result),
                "labels": result.labels or [],
                "latency_ms": _metric_number(result, "latency_ms"),
            }
        )

    failure_rate = _pct(len(failures), len(results))
    confidence = _health_confidence(db, results, days, latest_historical_result)
    dimensions = _health_dimensions(db, channel_id, results)
    reference_band = _health_reference_band(db, channel_id, results)
    status_reasons = _health_status_reasons(dimensions, reference_band, int(patrol_summary["pending_alert_count"]))
    status = _channel_health_status(len(results), failure_rate, int(patrol_summary["pending_alert_count"]))
    if confidence["reasons"] and ("data_stale" in confidence["reasons"]):
        status = "stale" if (results or latest_historical_result) else "insufficient_data"
    elif len(results) < 10:
        status = "insufficient_data"
    window_state = _health_window_state(results, days)
    if status != "stale" and window_state["severe"]:
        status = "critical"
        status_reasons.insert(0, {"dimension": "protocol", "code": "critical_consecutive_failure" if window_state["consecutive_failures"] >= 3 else "critical_protocol_anomaly", "value": window_state["consecutive_failures"], "threshold": 3, "impact": "严重协议异常或连续失败，立即升级。", "labels": ["critical"]})
    elif status not in {"stale", "insufficient_data"} and window_state["current_issue"] and window_state["previous_issue"]:
        status = "degraded"
        status_reasons.insert(0, {"dimension": "availability", "code": "degraded_two_windows", "value": 2, "threshold": 2, "impact": "普通异常已连续两个窗口出现。", "labels": ["window_debounce"]})
    elif status not in {"stale", "insufficient_data"} and (window_state["current_issue"] or window_state["previous_issue"] or status == "degraded"):
        status = "watch"
        status_reasons.insert(0, {"dimension": "availability", "code": "watch_single_window", "value": 1, "threshold": 2, "impact": "异常尚未连续两个窗口，进入观察而非直接降级。", "labels": ["window_debounce"]})
    elif status not in {"stale", "insufficient_data"} and window_state["current_healthy"] and window_state["previous_healthy"]:
        status = "healthy" if confidence["level"] == "high" else "watch"
        if any(alert.status == "resolved" for alert in alerts):
            status_reasons.insert(0, {"dimension": "availability", "code": "recovered_two_windows", "value": 2, "threshold": 2, "impact": "连续两个窗口恢复正常。", "labels": ["resolved"]})
    status_reasons = status_reasons[:5]
    latest_config_change_at = db.scalar(
        select(func.max(AuditLog.created_at)).where(AuditLog.target_type == "channel", AuditLog.target_id == channel_id)
    )
    payload = {
        "channel": channel,
        "days": days,
        "status": status,
        "total_runs": len(run_ids),
        "total_results": len(results),
        "success_count": len(successes),
        "failure_count": len(failures),
        "success_rate": _pct(len(successes), len(results)),
        "failure_rate": failure_rate,
        "avg_latency_ms": _avg(latencies),
        "p95_latency_ms": _percentile(latencies, 95),
        "latest_result_at": results[0].created_at if results else None,
        "label_distribution": _sorted_counts(labels),
        "error_type_distribution": _sorted_counts(error_types),
        "probe_summaries": probe_summaries,
        "signature_summary": signature_summary,
        "patrol_summary": patrol_summary,
        "confidence": confidence,
        "dimensions": dimensions,
        "reference_band": reference_band,
        "status_reasons": status_reasons,
        "latest_config_change_at": latest_config_change_at,
        "trend": trend,
        "recent_failures": recent_failures,
    }
    return redact_secrets(payload)


def _signature_interop_signature_from_result(result: Result) -> dict[str, object] | None:
    payload = result.raw_response if isinstance(result.raw_response, dict) else {}
    signature = payload.get("signature_interop") if isinstance(payload.get("signature_interop"), dict) else payload
    if not isinstance(signature, dict) or not isinstance(signature.get("steps"), list):
        normalized = result.normalized_response if isinstance(result.normalized_response, dict) else {}
        normalized_signature = normalized.get("signature_interop")
        signature = normalized_signature if isinstance(normalized_signature, dict) else None
    if not isinstance(signature, dict) or not isinstance(signature.get("steps"), list):
        return None
    return signature


def _signature_interop_payload_from_result(db: Session, result: Result) -> dict[str, object]:
    signature = _signature_interop_signature_from_result(result)
    if not isinstance(signature, dict):
        raise HTTPException(status_code=404, detail="Signature result not found")
    raw_request = result.raw_request if isinstance(result.raw_request, dict) else {}
    run = db.get(Run, result.run_id)
    enriched: dict[str, object] = dict(signature)
    if raw_request.get("client_probe_id") and not enriched.get("client_probe_id"):
        enriched["client_probe_id"] = raw_request.get("client_probe_id")
    if run:
        enriched["run"] = run_read(db, run)
    enriched["result"] = result
    return enriched


def _signature_interop_matches(result: Result, *, source_channel_id: str, relay_channel_id: str, stream: bool) -> bool:
    signature = _signature_interop_signature_from_result(result)
    if not signature:
        return False
    raw_request = result.raw_request if isinstance(result.raw_request, dict) else {}
    source_id = raw_request.get("source_channel_id") or signature.get("source_channel_id")
    relay_id = raw_request.get("relay_channel_id") or signature.get("relay_channel_id")
    if source_id != source_channel_id or relay_id != relay_channel_id:
        return False
    raw_stream = raw_request.get("stream", signature.get("stream", False))
    return bool(raw_stream) == bool(stream)


@router.get("/api/channels/signature-interop-test/latest", response_model=SignatureInteropTestRead)
def latest_channel_signature_interop_test(
    source_channel_id: str,
    relay_channel_id: str,
    stream: bool = False,
    client_probe_id: str | None = None,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    if client_probe_id:
        rows = list(
            db.scalars(
                select(Result)
                .where(Result.raw_request["client_probe_id"].as_string() == client_probe_id)
                .order_by(Result.created_at.desc(), Result.id.desc())
                .limit(20)
            ).all()
        )
        for result in rows:
            if _signature_interop_signature_from_result(result):
                return _signature_interop_payload_from_result(db, result)

    rows = list(
        db.scalars(
            select(Result)
            .where(Result.channel_id == relay_channel_id)
            .order_by(Result.created_at.desc(), Result.id.desc())
            .limit(200)
        ).all()
    )
    for result in rows:
        if _signature_interop_matches(result, source_channel_id=source_channel_id, relay_channel_id=relay_channel_id, stream=stream):
            return _signature_interop_payload_from_result(db, result)
    raise HTTPException(status_code=404, detail="未找到本次 Signature 检测日志")


@router.post("/api/channels/signature-interop-test", response_model=SignatureInteropTestRead)
async def channel_signature_interop_test(data: SignatureInteropTestCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    source = db.get(Channel, data.source_channel_id)
    relay = db.get(Channel, data.relay_channel_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source channel not found")
    if not relay:
        raise HTTPException(status_code=404, detail="Relay channel not found")
    payload = await create_signature_interop_test(db, source, relay, data.stream, data.client_probe_id)
    if isinstance(payload.get("run"), Run):
        payload["run"] = run_read(db, payload["run"])
    return payload


@router.post("/api/channels/{channel_id}/model-request-test", response_model=ModelRequestTestRead)
async def channel_model_request_test(channel_id: str, data: ModelRequestTestCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    try:
        return await create_model_request_test(db, channel, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.TimeoutException as exc:
        logger.exception("Model request test timed out for channel %s", channel_id)
        raise HTTPException(status_code=504, detail="Upstream request timed out") from exc
    except httpx.HTTPStatusError as exc:
        logger.exception("Model request test failed for channel %s", channel_id)
        raise HTTPException(status_code=502, detail="Upstream service returned an error") from exc
    except Exception as exc:
        logger.exception("Model request test failed for channel %s", channel_id)
        raise HTTPException(status_code=502, detail="Upstream request failed") from exc


@router.post("/api/full-model-check/plan")
async def full_model_check_plan_route(data: FullModelCheckPlanCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return full_model_check_plan(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Full model check plan failed")
        raise HTTPException(status_code=502, detail="Full model check plan failed") from exc


@router.post("/api/full-model-check", response_model=FullModelCheckRead)
async def full_model_check(data: FullModelCheckCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        return await create_full_model_check(db, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.TimeoutException as exc:
        logger.exception("Full model check timed out")
        raise HTTPException(status_code=504, detail="Full model check timed out") from exc
    except Exception as exc:
        logger.exception("Full model check failed")
        raise HTTPException(status_code=502, detail="Full model check failed") from exc


@router.post("/api/openai-resource-check", response_model=OpenAIResourceCheckRead)
async def openai_resource_check(data: OpenAIResourceCheckCreate) -> dict[str, object]:
    try:
        return await create_openai_resource_check(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("OpenAI resource check failed")
        raise HTTPException(status_code=502, detail="OpenAI resource check failed") from exc


@router.post("/api/gemini-resource-check", response_model=GeminiResourceCheckRead)
async def gemini_resource_check(data: GeminiResourceCheckCreate) -> dict[str, object]:
    try:
        return await create_gemini_resource_check(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Gemini resource check failed")
        raise HTTPException(status_code=502, detail="Gemini resource check failed") from exc


@router.post("/api/channels/{channel_id}/cache-hit-rate-test", response_model=CacheHitRateTestRead)
async def channel_cache_hit_rate_test(channel_id: str, data: CacheHitRateTestCreate, db: Session = Depends(get_db)) -> dict[str, object]:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    try:
        return await create_cache_hit_rate_test(db, channel, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.TimeoutException as exc:
        logger.exception("Cache hit rate test timed out for channel %s", channel_id)
        raise HTTPException(status_code=504, detail="Upstream request timed out") from exc
    except Exception as exc:
        logger.exception("Cache hit rate test failed for channel %s", channel_id)
        raise HTTPException(status_code=502, detail="Upstream request failed") from exc


@router.get("/api/channels/{channel_id}/models", response_model=list[str])
async def channel_models(channel_id: str, db: Session = Depends(get_db)) -> list[str]:
    channel = db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    try:
        return await fetch_channel_models(channel)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.TimeoutException as exc:
        logger.exception("Model list fetch timed out for channel %s", channel_id)
        raise HTTPException(status_code=504, detail="Upstream request timed out") from exc
    except httpx.HTTPStatusError as exc:
        logger.exception("Model list fetch failed for channel %s", channel_id)
        raise HTTPException(status_code=502, detail="Upstream service returned an error") from exc
    except Exception as exc:
        logger.exception("Model list fetch failed for channel %s", channel_id)
        raise HTTPException(status_code=502, detail="Upstream request failed") from exc
