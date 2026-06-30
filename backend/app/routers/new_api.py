from __future__ import annotations

import hashlib
import json
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
NEW_API_AZURE_TYPE = 3
NEW_API_AWS_TYPE = 33
NEW_API_VERTEX_TYPE = 41
CLAUDE_MATCH_RE = re.compile(r"(claude|anthropic)", re.IGNORECASE)
TEXT_SPLIT_RE = re.compile(r"[,;\n]")
NEW_API_CLAUDE_NATIVE_TYPES = {
    NEW_API_ANTHROPIC_TYPE: "type=14 Anthropic Claude",
    NEW_API_AWS_TYPE: "type=33 AWS Claude",
}
NEW_API_CLAUDE_TYPE_PROBES = [NEW_API_ANTHROPIC_TYPE, NEW_API_AWS_TYPE, NEW_API_VERTEX_TYPE]
COMMON_CLAUDE_GROUP_PROBES = [
    "claude",
    "claude-code",
    "default-claude",
    "azure-claude",
    "vertex-claude",
    "mix-claude",
    "kimi-claude",
    "minimax-claude",
    "glm-claude",
    "anthropic",
]


def _normalized_base_url(base_url: str) -> str:
    value = base_url.strip().rstrip("/")
    if not value:
        raise ValueError("new-api Base URL cannot be empty")
    if not value.startswith(("http://", "https://")):
        value = f"http://{value}"
    return value


def _instance_hash(base_url: str) -> str:
    return hashlib.sha1(base_url.encode("utf-8")).hexdigest()[:10]


def _safe_id_part(value: Any, max_length: int = 64) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(value).strip())[:max_length] or "unknown"


def _sync_channel_id(base_url: str, remote_id: Any, model_name: str | None = None, *, force_model_suffix: bool = False) -> str:
    safe_remote_id = re.sub(r"[^A-Za-z0-9_-]+", "_", str(remote_id).strip())[:64] or "unknown"
    base_id = f"newapi_{_instance_hash(base_url)}_{safe_remote_id}"
    if model_name or force_model_suffix:
        safe_model = _safe_id_part(model_name or "model", 72)
        model_hash = hashlib.sha1(str(model_name or "").encode("utf-8")).hexdigest()[:8]
        return f"{base_id}_{safe_model}_{model_hash}"
    return base_id


def _split_filter_values(value: str | None) -> list[str]:
    return [part.strip() for part in TEXT_SPLIT_RE.split(value or "") if part.strip()]


def _text_parts(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in TEXT_SPLIT_RE.split(value) if part.strip()] or [value.strip()]
    if isinstance(value, (int, float, bool)):
        return [str(value)]
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            parts.extend(_text_parts(item))
        return parts
    if isinstance(value, dict):
        parts = []
        for child in [*value.keys(), *value.values()]:
            parts.extend(_text_parts(child))
        return parts
    return [str(value)]


def _json_object(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                parsed = json.loads(stripped)
            except Exception:
                return None
            return parsed if isinstance(parsed, dict) else None
    return None


def _model_mapping_candidates(value: Any) -> list[str]:
    mapping = _json_object(value)
    if not mapping:
        return _text_parts(value)
    # new-api model_mapping usually maps exposed model -> upstream model.
    # The exposed model key is what this platform must request from the relay,
    # so prefer keys and keep values as a fallback for incomplete channel rows.
    values: list[str] = []
    for key in mapping.keys():
        values.extend(_text_parts(key))
    if values:
        return values
    for child in mapping.values():
        values.extend(_text_parts(child))
    return values


def _model_candidates(remote: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for key in ("test_model", "model", "models"):
        values.extend(_text_parts(remote.get(key)))
    for key in ("model_mapping", "model_map"):
        values.extend(_model_mapping_candidates(remote.get(key)))
    return list(dict.fromkeys(value for value in values if value))


def _claude_keywords(model_keyword: str | None) -> list[str]:
    keywords = _split_filter_values(model_keyword)
    if not keywords:
        keywords = ["claude", "anthropic", "sonnet", "opus", "haiku"]
    return [keyword.lower() for keyword in keywords]


def _pick_model(remote: dict[str, Any], keywords: list[str] | None = None) -> str | None:
    models = _model_candidates(remote)
    lowered = keywords or ["claude", "anthropic"]
    return next((model for model in models if any(keyword in model.lower() for keyword in lowered)), models[0] if models else None)


def _matching_models(remote: dict[str, Any], keywords: list[str], match_reason: str) -> list[str | None]:
    models = _model_candidates(remote)
    if not models:
        return [None]
    claude_family_keywords = list(dict.fromkeys([*keywords, "claude", "anthropic", "sonnet", "opus", "haiku"]))
    claude_like_models = [model for model in models if any(keyword in model.lower() for keyword in claude_family_keywords)]
    # If the channel itself is identified as Claude by type/name/group/tag/remark,
    # all advertised models on that new-api channel should be represented locally.
    # This covers screenshots where one new-api channel exposes several Claude
    # aliases but the individual model strings may be shortened like "sonnet".
    channel_level_hit = remote.get("type") in NEW_API_CLAUDE_NATIVE_TYPES or any(
        label in match_reason for label in ("name", "group", "groups", "tag", "remark")
    )
    if channel_level_hit:
        return claude_like_models or models[:1]
    matched_models = [model for model in models if any(keyword in model.lower() for keyword in keywords)]
    return matched_models or models


def _remote_search_fields(remote: dict[str, Any]) -> dict[str, str]:
    fields: dict[str, str] = {}
    for key in ("name", "models", "test_model", "model", "tag", "remark", "group", "groups", "model_mapping", "model_map"):
        parts = _text_parts(remote.get(key))
        if parts:
            fields[key] = " ".join(parts)
    return fields


def _claude_match_reason(remote: dict[str, Any], keywords: list[str]) -> tuple[bool, str]:
    if remote.get("type") in NEW_API_CLAUDE_NATIVE_TYPES:
        return True, NEW_API_CLAUDE_NATIVE_TYPES[remote.get("type")]
    matched: list[str] = []
    for key, value in _remote_search_fields(remote).items():
        lowered = value.lower()
        if any(keyword in lowered for keyword in keywords):
            matched.append(key)
    if matched:
        return True, "命中字段：" + ", ".join(matched)
    return False, "未命中 Claude 关键词"


def _matches_requested_tag(remote: dict[str, Any], tag: str | None) -> bool:
    expected = _split_filter_values(tag)
    if not expected:
        return True
    actual = str(remote.get("tag") or "").strip().lower()
    return any(item.lower() == actual for item in expected)


def _matches_requested_group(remote: dict[str, Any], group: str | None) -> bool:
    expected = [item.lower() for item in _split_filter_values(group)]
    if not expected:
        return True
    actual_values = " ".join(_text_parts(remote.get("group") or remote.get("groups"))).lower()
    if not actual_values:
        # Some new-api list responses omit group even when the server-side group
        # filter was applied. Do not drop those records locally.
        return True
    return any(item == actual_values or item in actual_values for item in expected)


def _provider_type(remote: dict[str, Any]) -> str:
    remote_type = remote.get("type")
    if remote_type == NEW_API_AWS_TYPE:
        return "new_api_aws_relay"
    if remote_type == NEW_API_VERTEX_TYPE:
        return "new_api_vertex_relay"
    if remote_type == NEW_API_AZURE_TYPE:
        return "new_api_azure_relay"
    return "new_api_anthropic_relay"


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
    status = remote.get("status", 1)
    if isinstance(status, str):
        lowered = status.strip().lower()
        if lowered in {"enabled", "enable", "true", "1"}:
            return True
        if lowered in {"disabled", "disable", "false", "0", "2", "3"}:
            return False
    try:
        return int(status) == 1
    except Exception:
        return True


def _remote_to_channel_create(
    remote: dict[str, Any],
    data: NewApiSyncRequest,
    base_url: str,
    *,
    model_name: str | None = None,
    force_model_suffix: bool = False,
) -> ChannelCreate:
    remote_id = remote.get("id")
    selected_model = model_name if model_name is not None else _pick_model(remote, _claude_keywords(data.model_keyword))
    auth_config = {
        "api_key": _relay_token_for_channel(data.relay_token, remote_id),
        "request_protocol": "anthropic_messages",
        "account_type": "new-api",
        "new_api_channel_id": str(remote_id),
        "new_api_model_name": selected_model,
        "new_api_source_base_url": base_url,
        "new_api_channel_type": remote.get("type"),
        "new_api_channel_tag": remote.get("tag"),
        "new_api_channel_group": remote.get("group") or remote.get("groups"),
    }
    remote_name = remote.get("name") or remote_id
    display_name = f"new-api #{remote_id} · {remote_name}"
    if force_model_suffix and selected_model:
        display_name = f"{display_name} · {selected_model}"
    return ChannelCreate(
        id=_sync_channel_id(base_url, remote_id, selected_model, force_model_suffix=force_model_suffix),
        name=display_name,
        provider_type=_provider_type(remote),
        role="candidate",
        base_url=base_url,
        model_name=selected_model,
        auth_config=auth_config,
        is_reference=False,
        enabled=bool(data.enabled and _remote_enabled(remote)),
    )


def _extract_remote_channels(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        data = payload.get("data", payload)
        if isinstance(data, dict):
            items = data.get("items") or data.get("channels") or data.get("rows") or data.get("records") or data.get("list") or data.get("data")
            if isinstance(items, list):
                return [item for item in items if isinstance(item, dict)]
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


def _extract_total(payload: Any) -> int | None:
    if not isinstance(payload, dict):
        return None
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        return None
    total = data.get("total") or data.get("count")
    try:
        return int(total)
    except Exception:
        return None


async def _request_new_api_json(
    client: httpx.AsyncClient,
    base_url: str,
    path: str,
    params: dict[str, str | int | bool],
    headers: dict[str, str],
    *,
    optional: bool = False,
) -> Any:
    response = await client.get(f"{base_url}{path}", params=params, headers=headers)
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        if optional and exc.response.status_code in {404, 405}:
            return None
        raise
    payload = response.json()
    if isinstance(payload, dict) and payload.get("success") is False:
        message = str(payload.get("message") or "new-api returned success=false")
        if optional and ("not found" in message.lower() or "no route" in message.lower()):
            return None
        raise ValueError(message)
    return payload


async def _fetch_new_api_pages(
    client: httpx.AsyncClient,
    base_url: str,
    path: str,
    base_params: dict[str, str | int | bool | None],
    headers: dict[str, str],
    page_size: int,
    *,
    optional: bool = False,
) -> list[dict[str, Any]]:
    params = {key: value for key, value in base_params.items() if value not in (None, "")}
    params["p"] = 1
    params["page_size"] = page_size
    channels: list[dict[str, Any]] = []
    while True:
        payload = await _request_new_api_json(client, base_url, path, params, headers, optional=optional)
        if payload is None:
            return []
        batch = _extract_remote_channels(payload)
        channels.extend(batch)
        total = _extract_total(payload)
        if total is None or len(channels) >= total or not batch:
            break
        params["p"] = int(params["p"]) + 1
    return channels


def _status_param(status: str | None) -> str:
    value = str(status or "enabled").strip().lower()
    if value in {"all", "-1"}:
        return "all"
    if value in {"disabled", "0"}:
        return "disabled"
    return "enabled"


def _base_channel_query_params(data: NewApiSyncRequest, group_filter: str | None = None) -> dict[str, str | int | bool | None]:
    return {
        "status": _status_param(data.status),
        "group": group_filter,
    }


async def _fetch_new_api_channels(data: NewApiSyncRequest) -> tuple[str, list[dict[str, Any]]]:
    base_url = _normalized_base_url(data.base_url)
    group_filters = _split_filter_values(data.group) or [None]
    headers = {"Authorization": f"Bearer {data.admin_access_token.strip()}"}
    channels: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    timeout = httpx.Timeout(connect=10, read=30, write=10, pool=10)

    def add_channels(batch: list[dict[str, Any]]) -> None:
        for remote in batch:
            remote_key = str(remote.get("id") if remote.get("id") is not None else id(remote))
            if remote_key in seen_ids:
                continue
            seen_ids.add(remote_key)
            channels.append(remote)

    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        if any(group_filter for group_filter in group_filters):
            # new-api exposes /api/channel/search with an exact group parameter.
            # Query each requested group directly, then fall back to the paged list
            # endpoint for older deployments where /search is absent.
            for group_filter in [item for item in group_filters if item]:
                params = _base_channel_query_params(data, group_filter)
                batch = await _fetch_new_api_pages(client, base_url, "/api/channel/search", params, headers, data.page_size, optional=True)
                if not batch:
                    batch = await _fetch_new_api_pages(client, base_url, "/api/channel/", params, headers, data.page_size)
                add_channels(batch)
        else:
            keywords = _claude_keywords(data.model_keyword)
            # Search endpoint is fast for large new-api instances and covers
            # common cases where Claude is encoded in name, model, or tag.
            for keyword in keywords:
                add_channels(
                    await _fetch_new_api_pages(
                        client,
                        base_url,
                        "/api/channel/search",
                        {**_base_channel_query_params(data), "keyword": keyword},
                        headers,
                        data.page_size,
                        optional=True,
                    )
                )
                add_channels(
                    await _fetch_new_api_pages(
                        client,
                        base_url,
                        "/api/channel/search",
                        {**_base_channel_query_params(data), "model": keyword},
                        headers,
                        data.page_size,
                        optional=True,
                    )
                )
                add_channels(
                    await _fetch_new_api_pages(
                        client,
                        base_url,
                        "/api/channel/search",
                        {**_base_channel_query_params(data), "keyword": keyword, "tag_mode": True},
                        headers,
                        data.page_size,
                        optional=True,
                    )
                )
            # Many operators isolate Claude routes by group names such as
            # claude-code, azure-claude, or vertex-claude. Probe those groups even
            # when the user leaves the group box empty.
            for group_filter in COMMON_CLAUDE_GROUP_PROBES:
                add_channels(
                    await _fetch_new_api_pages(
                        client,
                        base_url,
                        "/api/channel/search",
                        _base_channel_query_params(data, group_filter),
                        headers,
                        data.page_size,
                        optional=True,
                    )
                )
            # Official Anthropic/AWS type probes are decisive; Vertex is only a
            # discovery probe and still needs local Claude keyword evidence below.
            for type_filter in NEW_API_CLAUDE_TYPE_PROBES:
                add_channels(
                    await _fetch_new_api_pages(
                        client,
                        base_url,
                        "/api/channel/",
                        {**_base_channel_query_params(data), "type": type_filter},
                        headers,
                        data.page_size,
                    )
                )
            # Final complete scan keeps the sync accurate even when Claude is
            # represented by custom aliases, model_mapping, or remarks that
            # new-api's server-side search does not cover.
            add_channels(await _fetch_new_api_pages(client, base_url, "/api/channel/", _base_channel_query_params(data), headers, data.page_size))
    return base_url, channels


def _build_sync_payload(db: Session, base_url: str, remotes: list[dict[str, Any]], data: NewApiSyncRequest, *, apply: bool) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    keywords = _claude_keywords(data.model_keyword)
    matched_remotes: list[tuple[dict[str, Any], str]] = []
    for remote in remotes:
        if remote.get("id") is None or not _matches_requested_tag(remote, data.tag) or not _matches_requested_group(remote, data.group):
            continue
        matched, reason = _claude_match_reason(remote, keywords)
        if matched:
            matched_remotes.append((remote, reason))
    for remote, match_reason in matched_remotes:
        remote_models = _matching_models(remote, keywords, match_reason)
        force_model_suffix = len(remote_models) > 1
        for index, selected_model in enumerate(remote_models):
            legacy_id = _sync_channel_id(base_url, remote.get("id"))
            legacy_existing = db.get(Channel, legacy_id) if force_model_suffix and index == 0 else None
            use_legacy_id = legacy_existing is not None
            channel_data = _remote_to_channel_create(remote, data, base_url, model_name=selected_model, force_model_suffix=force_model_suffix and not use_legacy_id)
            existing = db.get(Channel, channel_data.id)
            schedule = db.scalar(select(ScheduledChannelTest).where(ScheduledChannelTest.channel_id == channel_data.id).limit(1))
            if not schedule and legacy_existing is not None:
                schedule = db.scalar(select(ScheduledChannelTest).where(ScheduledChannelTest.channel_id == legacy_id).limit(1))
            action = "update" if existing or legacy_existing else "create"
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
                    "remote_models": [model for model in remote_models if model],
                    "provider_type": channel_data.provider_type,
                    "group": remote.get("group") or remote.get("groups"),
                    "tag": remote.get("tag"),
                    "remote_type": remote.get("type"),
                    "remote_status": remote.get("status"),
                    "remote_enabled": _remote_enabled(remote),
                    "action": action,
                    "schedule_action": schedule_action,
                    "reason": match_reason,
                }
            )
    create_count = sum(1 for item in items if item["action"] == "create")
    update_count = sum(1 for item in items if item["action"] == "update")
    schedule_create_count = sum(1 for item in items if item["schedule_action"] == "create")
    return {
        "base_url": base_url,
        "total_remote": len(remotes),
        "matched": len(matched_remotes),
        "matched_models": len(items),
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
