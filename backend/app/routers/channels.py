from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import BaselineResult, BaselineSnapshot, Channel, ChannelAlert, Comparison, PatrolJob, PatrolJobAttempt, Report, Result, Run, RunChannel, ScheduledChannelTest
from ..redaction import merge_redacted_config, redact_secrets, redact_text
from ..seed_utils import ensure_seed_data_when_empty
from ..schemas import (
    CacheHitRateTestCreate,
    CacheHitRateTestRead,
    ChannelCreate,
    ChannelHealthProfileRead,
    ChannelRead,
    ChannelUpdate,
    GeminiResourceCheckCreate,
    GeminiResourceCheckRead,
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
    create_gemini_resource_check,
    create_model_request_test,
    create_openai_resource_check,
    create_signature_interop_test,
    fetch_channel_models,
    request_id_from_normalized,
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


@router.get("/api/channels", response_model=list[ChannelRead])
def list_channels(db: Session = Depends(get_db)) -> list[Channel]:
    ensure_seed_data_when_empty(db, Channel)
    return list(db.scalars(select(Channel).order_by(Channel.role, Channel.name)).all())


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
    if data.is_reference is not None and data.role is None:
        channel.role = "gold" if channel.is_reference else "candidate"
    db.commit()
    db.refresh(channel)
    return channel


def _count_for(db: Session, model: type, *criteria) -> int:  # noqa: ANN001
    if not criteria:
        return int(db.scalar(select(func.count()).select_from(model)) or 0)
    return int(db.scalar(select(func.count()).select_from(model).where(*criteria)) or 0)


def _id_set_for(db: Session, model: type, *criteria) -> set[str]:  # noqa: ANN001
    if not criteria:
        return {str(item) for item in db.scalars(select(model.id)).all()}
    return {str(item) for item in db.scalars(select(model.id).where(*criteria)).all()}


def _channel_delete_run_ids(db: Session, channel_id: str) -> set[str]:
    run_ids = set(db.scalars(select(RunChannel.run_id).where(RunChannel.channel_id == channel_id)).all())
    run_ids.update(db.scalars(select(Result.run_id).where(Result.channel_id == channel_id)).all())
    run_ids.update(db.scalars(select(Report.run_id).where(Report.channel_id == channel_id)).all())
    run_ids.update(db.scalars(select(ChannelAlert.run_id).where(ChannelAlert.channel_id == channel_id)).all())
    run_ids.update(db.scalars(select(Comparison.run_id).where(Comparison.candidate_channel_id == channel_id)).all())
    run_ids.update(db.scalars(select(PatrolJob.run_id).where(PatrolJob.channel_id == channel_id, PatrolJob.run_id.is_not(None))).all())
    return {str(run_id) for run_id in run_ids if run_id}


def _run_ids_deletable_after_channel_cleanup(db: Session, run_ids: set[str], channel_id: str) -> set[str]:
    deletable: set[str] = set()
    for run_id in run_ids:
        other_run_channels = _count_for(db, RunChannel, RunChannel.run_id == run_id, RunChannel.channel_id != channel_id)
        other_results = _count_for(db, Result, Result.run_id == run_id, Result.channel_id != channel_id)
        other_reports = _count_for(db, Report, Report.run_id == run_id, Report.channel_id != channel_id)
        other_alerts = _count_for(db, ChannelAlert, ChannelAlert.run_id == run_id, ChannelAlert.channel_id != channel_id)
        other_comparisons = _count_for(db, Comparison, Comparison.run_id == run_id, Comparison.candidate_channel_id != channel_id)
        other_jobs = _count_for(db, PatrolJob, PatrolJob.run_id == run_id, PatrolJob.channel_id != channel_id)
        if not any([other_run_channels, other_results, other_reports, other_alerts, other_comparisons, other_jobs]):
            deletable.add(run_id)
    return deletable


def _delete_channel_and_related_data(db: Session, channel: Channel) -> dict[str, object]:
    channel_id = channel.id
    touched_run_ids = _channel_delete_run_ids(db, channel_id)
    deletable_run_ids = _run_ids_deletable_after_channel_cleanup(db, touched_run_ids, channel_id)
    baseline_source_run_ids = set(db.scalars(select(BaselineSnapshot.source_run_id).where(BaselineSnapshot.source_run_id.in_(deletable_run_ids))).all()) if deletable_run_ids else set()
    deletable_run_ids -= {str(run_id) for run_id in baseline_source_run_ids if run_id}

    job_ids = set(db.scalars(select(PatrolJob.id).where(PatrolJob.channel_id == channel_id)).all())
    job_ids.update(db.scalars(select(PatrolJob.id).where(PatrolJob.run_id.in_(deletable_run_ids))).all() if deletable_run_ids else [])

    run_channel_ids = _id_set_for(db, RunChannel, RunChannel.channel_id == channel_id)
    result_ids = _id_set_for(db, Result, Result.channel_id == channel_id)
    comparison_ids = _id_set_for(db, Comparison, Comparison.candidate_channel_id == channel_id)
    report_ids = _id_set_for(db, Report, Report.channel_id == channel_id)
    alert_ids = _id_set_for(db, ChannelAlert, ChannelAlert.channel_id == channel_id)
    if deletable_run_ids:
        run_channel_ids |= _id_set_for(db, RunChannel, RunChannel.run_id.in_(deletable_run_ids))
        result_ids |= _id_set_for(db, Result, Result.run_id.in_(deletable_run_ids))
        comparison_ids |= _id_set_for(db, Comparison, Comparison.run_id.in_(deletable_run_ids))
        report_ids |= _id_set_for(db, Report, Report.run_id.in_(deletable_run_ids))
        alert_ids |= _id_set_for(db, ChannelAlert, ChannelAlert.run_id.in_(deletable_run_ids))

    stats = {
        "deleted": True,
        "deleted_runs": len(deletable_run_ids),
        "deleted_run_channels": len(run_channel_ids),
        "deleted_results": len(result_ids),
        "deleted_comparisons": len(comparison_ids),
        "deleted_reports": len(report_ids),
        "deleted_alerts": len(alert_ids),
        "deleted_schedules": _count_for(db, ScheduledChannelTest, ScheduledChannelTest.channel_id == channel_id),
        "deleted_baselines": _count_for(db, BaselineResult, BaselineResult.channel_id == channel_id),
        "deleted_patrol_jobs": len(job_ids),
    }

    schedule_ids = set(db.scalars(select(ScheduledChannelTest.id).where(ScheduledChannelTest.channel_id == channel_id)).all())
    if job_ids:
        db.execute(delete(PatrolJobAttempt).where(PatrolJobAttempt.job_id.in_(job_ids)))
        db.execute(delete(PatrolJob).where(PatrolJob.id.in_(job_ids)))
    if schedule_ids:
        db.execute(delete(ChannelAlert).where(ChannelAlert.scheduled_test_id.in_(schedule_ids)))
        db.execute(delete(ScheduledChannelTest).where(ScheduledChannelTest.id.in_(schedule_ids)))

    db.execute(delete(ChannelAlert).where(ChannelAlert.channel_id == channel_id))
    db.execute(delete(BaselineResult).where(BaselineResult.channel_id == channel_id))
    db.execute(delete(Report).where(Report.channel_id == channel_id))
    db.execute(delete(Comparison).where(Comparison.candidate_channel_id == channel_id))
    db.execute(delete(Result).where(Result.channel_id == channel_id))
    db.execute(delete(RunChannel).where(RunChannel.channel_id == channel_id))

    if deletable_run_ids:
        db.execute(delete(PatrolJobAttempt).where(PatrolJobAttempt.run_id.in_(deletable_run_ids)))
        db.execute(update(ScheduledChannelTest).where(ScheduledChannelTest.last_run_id.in_(deletable_run_ids)).values(last_run_id=None))
        db.execute(delete(ChannelAlert).where(ChannelAlert.run_id.in_(deletable_run_ids)))
        db.execute(delete(Report).where(Report.run_id.in_(deletable_run_ids)))
        db.execute(delete(Comparison).where(Comparison.run_id.in_(deletable_run_ids)))
        db.execute(delete(Result).where(Result.run_id.in_(deletable_run_ids)))
        db.execute(delete(RunChannel).where(RunChannel.run_id.in_(deletable_run_ids)))
        db.execute(delete(Run).where(Run.id.in_(deletable_run_ids)))

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


def _signature_payload(result: Result) -> dict[str, Any] | None:
    payload = _signature_interop_signature_from_result(result)
    return payload if isinstance(payload, dict) else None


def _channel_health_status(total_results: int, failure_rate: float | None, pending_alerts: int) -> str:
    if total_results <= 0:
        return "insufficient_data"
    if (failure_rate or 0) >= 30 or pending_alerts > 0:
        return "degraded"
    return "ok"


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
    payload = {
        "channel": channel,
        "days": days,
        "status": _channel_health_status(len(results), failure_rate, int(patrol_summary["pending_alert_count"])),
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
