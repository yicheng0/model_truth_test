from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import BaselineResult, BaselineSnapshot, Channel, ChannelAlert, Comparison, PatrolJob, PatrolJobAttempt, Report, Result, Run, RunChannel, ScheduledChannelTest
from ..redaction import merge_redacted_config
from ..seed_utils import ensure_seed_data_when_empty
from ..schemas import (
    CacheHitRateTestCreate,
    CacheHitRateTestRead,
    ChannelCreate,
    ChannelRead,
    ChannelUpdate,
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
    create_cache_hit_rate_test,
    create_channel,
    create_model_request_test,
    create_openai_resource_check,
    create_signature_interop_test,
    fetch_channel_models,
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
