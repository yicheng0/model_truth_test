from __future__ import annotations

import hashlib
import re
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..admin import require_admin
from ..database import get_db
from ..models import Channel, ScheduledChannelTest
from ..schemas import ChannelCreate, NewApiSyncRead, NewApiSyncRequest, ScheduledChannelTestCreate
from ..services import create_channel, create_scheduled_channel_test


router = APIRouter()

NEW_API_ANTHROPIC_TYPE = 14
NEW_API_AWS_TYPE = 33
CLAUDE_MATCH_RE = re.compile(r"(claude|anthropic)", re.IGNORECASE)


def _normalized_base_url(base_url: str) -> str:
    value = base_url.strip().rstrip("/")
    if not value:
        raise ValueError("new-api Base URL cannot be empty")
    if not value.startswith(("http://", "https://")):
        value = f"http://{value}"
    return value


def _instance_hash(base_url: str) -> str:
    return hashlib.sha1(base_url.encode("utf-8")).hexdigest()[:10]


def _sync_channel_id(base_url: str, remote_id: Any) -> str:
    safe_remote_id = re.sub(r"[^A-Za-z0-9_-]+", "_", str(remote_id).strip())[:64] or "unknown"
    return f"newapi_{_instance_hash(base_url)}_{safe_remote_id}"


def _model_candidates(remote: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for key in ("test_model", "model", "models"):
        value = remote.get(key)
        if isinstance(value, str):
            values.extend(part.strip() for part in re.split(r"[,;\n]", value) if part.strip())
        elif isinstance(value, list):
            values.extend(str(part).strip() for part in value if str(part).strip())
    return values


def _pick_model(remote: dict[str, Any]) -> str | None:
    models = _model_candidates(remote)
    return next((model for model in models if CLAUDE_MATCH_RE.search(model)), models[0] if models else None)


def _matches_claude(remote: dict[str, Any]) -> bool:
    if remote.get("type") in {NEW_API_ANTHROPIC_TYPE, NEW_API_AWS_TYPE}:
        return True
    haystack = " ".join(
        str(remote.get(key) or "")
        for key in ("name", "models", "test_model", "tag", "remark")
    )
    return bool(CLAUDE_MATCH_RE.search(haystack))


def _matches_requested_tag(remote: dict[str, Any], tag: str | None) -> bool:
    expected = (tag or "").strip()
    if not expected:
        return True
    return str(remote.get("tag") or "").strip() == expected


def _provider_type(remote: dict[str, Any]) -> str:
    return "new_api_aws_relay" if remote.get("type") == NEW_API_AWS_TYPE else "new_api_anthropic_relay"


def _relay_token_for_channel(relay_token: str, remote_id: Any) -> str:
    token = relay_token.strip()
    bare = token[3:] if token.startswith("sk-") else token
    remote = str(remote_id).strip()
    if not remote:
        return token
    if bare.endswith(f"-{remote}"):
        return token if token.startswith("sk-") else f"sk-{bare}"
    return f"sk-{bare}-{remote}"


def _remote_enabled(remote: dict[str, Any]) -> bool:
    try:
        return int(remote.get("status", 1)) == 1
    except Exception:
        return True


def _remote_to_channel_create(remote: dict[str, Any], data: NewApiSyncRequest, base_url: str) -> ChannelCreate:
    remote_id = remote.get("id")
    model_name = _pick_model(remote)
    auth_config = {
        "api_key": _relay_token_for_channel(data.relay_token, remote_id),
        "request_protocol": "anthropic_messages",
        "account_type": "new-api",
        "new_api_channel_id": str(remote_id),
        "new_api_source_base_url": base_url,
        "new_api_channel_type": remote.get("type"),
        "new_api_channel_tag": remote.get("tag"),
    }
    return ChannelCreate(
        id=_sync_channel_id(base_url, remote_id),
        name=f"new-api #{remote_id} · {remote.get('name') or remote_id}",
        provider_type=_provider_type(remote),
        role="candidate",
        base_url=base_url,
        model_name=model_name,
        auth_config=auth_config,
        is_reference=False,
        enabled=bool(data.enabled and _remote_enabled(remote)),
    )


def _extract_remote_channels(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        data = payload.get("data", payload)
        if isinstance(data, dict):
            items = data.get("items") or data.get("channels") or data.get("data")
            if isinstance(items, list):
                return [item for item in items if isinstance(item, dict)]
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


async def _fetch_new_api_channels(data: NewApiSyncRequest) -> tuple[str, list[dict[str, Any]]]:
    base_url = _normalized_base_url(data.base_url)
    params: dict[str, str | int] = {
        "p": 1,
        "page_size": data.page_size,
        "status": data.status or "enabled",
    }
    if data.group:
        params["group"] = data.group.strip()
    if data.model_keyword:
        params["model"] = data.model_keyword.strip()
    headers = {"Authorization": f"Bearer {data.admin_access_token.strip()}"}
    channels: list[dict[str, Any]] = []
    timeout = httpx.Timeout(connect=10, read=30, write=10, pool=10)
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        while True:
            response = await client.get(f"{base_url}/api/channel/", params=params, headers=headers)
            response.raise_for_status()
            payload = response.json()
            if isinstance(payload, dict) and payload.get("success") is False:
                raise ValueError(str(payload.get("message") or "new-api returned success=false"))
            batch = _extract_remote_channels(payload)
            channels.extend(batch)
            total = None
            data_payload = payload.get("data") if isinstance(payload, dict) else None
            if isinstance(data_payload, dict):
                total = data_payload.get("total")
            if not isinstance(total, int) or len(channels) >= total or not batch:
                break
            params["p"] = int(params["p"]) + 1
    return base_url, channels


def _build_sync_payload(db: Session, base_url: str, remotes: list[dict[str, Any]], data: NewApiSyncRequest, *, apply: bool) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    matched_remotes = [
        remote
        for remote in remotes
        if remote.get("id") is not None and _matches_requested_tag(remote, data.tag) and _matches_claude(remote)
    ]
    for remote in matched_remotes:
        channel_data = _remote_to_channel_create(remote, data, base_url)
        existing = db.get(Channel, channel_data.id)
        schedule = db.scalar(select(ScheduledChannelTest).where(ScheduledChannelTest.channel_id == channel_data.id).limit(1))
        action = "update" if existing else "create"
        schedule_action = "exists" if schedule else "create"
        if apply:
            channel = create_channel(db, channel_data)
            if not schedule:
                create_scheduled_channel_test(
                    db,
                    ScheduledChannelTestCreate(
                        name=f"{channel.name} 自动巡检",
                        channel_id=channel.id,
                        enabled=data.enabled,
                        interval_minutes=data.default_interval_minutes,
                        test_scope="scheduled_probe",
                        repeat_count=1,
                        concurrency=1,
                        use_mock=False,
                        alert_grade_threshold="D",
                        alert_score_threshold=None,
                        alert_red_flags_enabled=True,
                        quiet_minutes=0,
                        max_retries=0,
                        retry_interval_minutes=5,
                    ),
                )
        items.append(
            {
                "new_api_channel_id": str(remote.get("id")),
                "channel_id": str(channel_data.id),
                "name": channel_data.name,
                "model_name": channel_data.model_name,
                "provider_type": channel_data.provider_type,
                "action": action,
                "schedule_action": schedule_action,
                "reason": None,
            }
        )
    create_count = sum(1 for item in items if item["action"] == "create")
    update_count = sum(1 for item in items if item["action"] == "update")
    schedule_create_count = sum(1 for item in items if item["schedule_action"] == "create")
    return {
        "base_url": base_url,
        "total_remote": len(remotes),
        "matched": len(matched_remotes),
        "create_count": create_count,
        "update_count": update_count,
        "skip_count": len(remotes) - len(matched_remotes),
        "schedule_create_count": schedule_create_count,
        "schedule_exists_count": len(items) - schedule_create_count,
        "items": items,
    }


async def _sync_new_api(data: NewApiSyncRequest, db: Session, *, apply: bool) -> dict[str, Any]:
    try:
        base_url, remotes = await _fetch_new_api_channels(data)
        return _build_sync_payload(db, base_url, remotes, data, apply=apply)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"new-api returned HTTP {exc.response.status_code}") from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"new-api request failed: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/integrations/new-api/preview", response_model=NewApiSyncRead)
async def preview_new_api_sync(data: NewApiSyncRequest, _admin: None = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    return await _sync_new_api(data, db, apply=False)


@router.post("/api/integrations/new-api/apply", response_model=NewApiSyncRead)
async def apply_new_api_sync(data: NewApiSyncRequest, _admin: None = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    return await _sync_new_api(data, db, apply=True)
