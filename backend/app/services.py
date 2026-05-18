from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import math
import os
import re
import socket
import time
import uuid
from collections import defaultdict
from datetime import datetime, time as datetime_time, timedelta, timezone
from difflib import SequenceMatcher
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError, InvalidRequestError
from sqlalchemy.orm import Session, sessionmaker

from .models import BaselineResult, BaselineSnapshot, Channel, ChannelAlert, ChannelTaxonomySetting, Comparison, FeishuBroadcastSetting, Report, Result, Run, RunChannel, ScheduledChannelTest, TestCase, TestSuite
from .schemas import (
    BaselineBuildCreate,
    BaselineResultRead,
    ChannelCreate,
    ChannelRead,
    ChannelTaxonomySettingUpdate,
    ComparisonRead,
    EvalScopeJsonlImportCreate,
    FeishuBroadcastSettingUpdate,
    ModelRequestTestCreate,
    ReportRead,
    ResultRead,
    RunCreate,
    RunRead,
    SamplePlanCreate,
    ScheduledChannelTestCreate,
    TestSuiteBundle,
    TestCaseCreate,
    TestCaseRead,
    TestSuiteCreate,
    TestSuiteRead,
)
from .restored_seed import restored_seed_data
from .suite_seed import default_cases, default_suite

SCHEDULE_TIMEZONE = ZoneInfo("Asia/Shanghai")
SCHEDULER_INSTANCE_ID = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
SCHEDULER_LOCK_MINUTES = int(os.getenv("SCHEDULER_LOCK_MINUTES", "30") or "30")
SCHEDULER_LAST_TICK_AT: datetime | None = None
if not logging.getLogger().handlers and not logging.getLogger("claude_eval").handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
logger = logging.getLogger("claude_eval.services")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _parse_schedule_time(value: str) -> datetime_time:
    hour, minute = value.split(":", maxsplit=1)
    return datetime_time(hour=int(hour), minute=int(minute))


def _is_in_schedule_window(candidate_local: datetime, start_time: datetime_time, end_time: datetime_time) -> bool:
    local_time = candidate_local.time()
    if start_time < end_time:
        return start_time <= local_time < end_time
    return local_time >= start_time or local_time < end_time


def _schedule_window_start_for_local(candidate_local: datetime, start_time: datetime_time, end_time: datetime_time) -> datetime:
    candidate_date = candidate_local.date()
    if start_time < end_time:
        if candidate_local.time() < end_time:
            return datetime.combine(candidate_date, start_time, tzinfo=SCHEDULE_TIMEZONE)
        return datetime.combine(candidate_date + timedelta(days=1), start_time, tzinfo=SCHEDULE_TIMEZONE)
    if candidate_local.time() < end_time:
        return datetime.combine(candidate_date - timedelta(days=1), start_time, tzinfo=SCHEDULE_TIMEZONE)
    return datetime.combine(candidate_date, start_time, tzinfo=SCHEDULE_TIMEZONE)


def next_scheduled_run_at(
    base_at: datetime,
    interval_minutes: int,
    run_window_start: str | None = None,
    run_window_end: str | None = None,
) -> datetime:
    """Return the next automatic run timestamp in UTC."""
    base_utc = base_at if base_at.tzinfo else base_at.replace(tzinfo=timezone.utc)
    candidate_utc = base_utc.astimezone(timezone.utc) + timedelta(minutes=max(5, interval_minutes))
    if not run_window_start or not run_window_end:
        return candidate_utc

    start_time = _parse_schedule_time(run_window_start)
    end_time = _parse_schedule_time(run_window_end)
    candidate_local = candidate_utc.astimezone(SCHEDULE_TIMEZONE)
    if _is_in_schedule_window(candidate_local, start_time, end_time):
        return candidate_utc

    window_start = _schedule_window_start_for_local(candidate_local, start_time, end_time)
    if candidate_local < window_start:
        return window_start.astimezone(timezone.utc)
    return (window_start + timedelta(days=1)).astimezone(timezone.utc)


def next_run_for_scheduled_test(scheduled: ScheduledChannelTest, base_at: datetime | None = None) -> datetime:
    return next_scheduled_run_at(
        base_at or datetime.now(timezone.utc),
        scheduled.interval_minutes,
        scheduled.run_window_start,
        scheduled.run_window_end,
    )


def scheduler_enabled() -> bool:
    return os.getenv("AUTO_SCHEDULER_ENABLED", "true").lower() not in {"0", "false", "no"}


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return _as_utc(value).replace(tzinfo=None)


def _lock_expiry(now: datetime | None = None) -> datetime:
    return (now or datetime.now(timezone.utc)) + timedelta(minutes=max(1, SCHEDULER_LOCK_MINUTES))


def _schedule_lock_active(scheduled: ScheduledChannelTest, now: datetime | None = None) -> bool:
    if not scheduled.locked_until:
        return False
    return _as_utc(scheduled.locked_until) > (now or datetime.now(timezone.utc))


def release_scheduled_test_lock(
    db: Session,
    scheduled: ScheduledChannelTest,
    *,
    status: str | None = None,
    error: str | None = None,
    finished_at: datetime | None = None,
) -> None:
    now = finished_at or datetime.now(timezone.utc)
    values: dict[str, Any] = {
        "last_error": error,
        "last_finished_at": now,
        "locked_by": None,
        "locked_until": None,
    }
    if status is not None:
        values["last_status"] = status
    db.execute(
        update(ScheduledChannelTest)
        .where(ScheduledChannelTest.id == scheduled.id)
        .values(**values)
    )
    db.commit()
    db.refresh(scheduled)


def claim_scheduled_test(
    db: Session,
    scheduled_id: str,
    *,
    now: datetime | None = None,
    advance_next_run: bool = False,
    force: bool = False,
) -> ScheduledChannelTest | None:
    now = now or datetime.now(timezone.utc)
    scheduled = db.get(ScheduledChannelTest, scheduled_id)
    if not scheduled:
        return None
    if not force and not scheduled.enabled:
        return None
    if _schedule_lock_active(scheduled, now):
        return None
    values: dict[str, Any] = {
        "locked_by": SCHEDULER_INSTANCE_ID,
        "locked_until": _lock_expiry(now),
        "last_status": "queued",
        "last_error": None,
        "last_queued_at": now,
    }
    if advance_next_run:
        values["next_run_at"] = next_run_for_scheduled_test(scheduled, now)
    result = db.execute(
        update(ScheduledChannelTest)
        .where(ScheduledChannelTest.id == scheduled.id)
        .values(**values)
    )
    if result.rowcount != 1:
        db.rollback()
        return None
    db.commit()
    db.refresh(scheduled)
    return scheduled


def recover_stale_scheduled_tests(db: Session, *, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    stale = db.scalars(
        select(ScheduledChannelTest)
        .where(
            ScheduledChannelTest.last_status.in_(["queued", "running"]),
            ScheduledChannelTest.locked_until.is_not(None),
            ScheduledChannelTest.locked_until <= _naive_utc(now),
        )
        .order_by(ScheduledChannelTest.locked_until)
    ).all()
    recovered = 0
    for scheduled in stale:
        run = db.get(Run, scheduled.last_run_id) if scheduled.last_run_id else None
        if run and run.status in {"pending", "running"}:
            run.status = "failed"
            run.finished_at = now
        scheduled.last_status = run.status if run and run.status in {"completed", "failed", "canceled", "interrupted"} else "failed"
        scheduled.last_error = "自动巡检任务锁已过期，系统已恢复调度"
        scheduled.last_finished_at = now
        scheduled.locked_by = None
        scheduled.locked_until = None
        scheduled.next_run_at = next_run_for_scheduled_test(scheduled, now)
        recovered += 1
    if recovered:
        db.commit()
    return recovered


def scheduled_tests_health(db: Session) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    try:
        recover_stale_scheduled_tests(db, now=now)
    except Exception:
        db.rollback()
        logger.warning("scheduled_tests_health: stale schedule recovery failed", exc_info=True)
    schedules = list(db.scalars(select(ScheduledChannelTest)).all())
    enabled = [schedule for schedule in schedules if schedule.enabled]
    stale_schedule_count = 0
    next_due_candidates: list[datetime] = []
    for schedule in enabled:
        try:
            if schedule.next_run_at:
                next_due_candidates.append(_as_utc(schedule.next_run_at))
        except Exception:
            logger.warning("scheduled_tests_health: invalid next_run_at schedule_id=%s", schedule.id, exc_info=True)
    for schedule in schedules:
        try:
            if schedule.last_status in {"queued", "running"} and schedule.locked_until and _as_utc(schedule.locked_until) <= now:
                stale_schedule_count += 1
        except Exception:
            logger.warning("scheduled_tests_health: invalid locked_until schedule_id=%s", schedule.id, exc_info=True)
    return {
        "enabled": scheduler_enabled(),
        "instance_id": SCHEDULER_INSTANCE_ID,
        "last_tick_at": SCHEDULER_LAST_TICK_AT,
        "stale_schedule_count": stale_schedule_count,
        "queued_schedule_count": sum(1 for schedule in schedules if schedule.last_status == "queued"),
        "running_schedule_count": sum(1 for schedule in schedules if schedule.last_status == "running"),
        "next_due_at": min(next_due_candidates, default=None),
    }


def similarity(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    return SequenceMatcher(None, a or "", b or "").ratio()


def grade_from_score(score: float, labels: list[str] | None = None) -> str:
    red_flags = {"unsafe_response", "identity_mismatch", "tool_use_invalid", "max_tokens_not_enforced"}
    if labels and red_flags.intersection(labels):
        return "E" if score < 70 else "D"
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    if score >= 70:
        return "C"
    if score >= 60:
        return "D"
    return "E"


ALERT_RED_FLAGS = {
    "identity_mismatch",
    "unsafe_response",
    "tool_use_invalid",
    "tool_name_mismatch",
    "tool_input_mismatch",
    "max_tokens_not_enforced",
    "stop_sequence_not_enforced",
    "streaming_event_missing",
    "invalid_request_not_rejected",
    "request_failed",
    "protocol_mismatch",
    "message_id_family_mismatch",
    "tool_schema_invalid",
    "json_schema_invalid",
    "signature_interop_failed",
    "thinking_temperature_not_rejected",
    "unexpected_error_response",
    "web_search_not_rejected",
    "thinking_adaptive_enabled_not_rejected",
    "thinking_adaptive_enabled_wrong_error",
    "signature_source_missing",
}

REQUEST_PROTOCOL_AUTO = "auto"
REQUEST_PROTOCOL_ANTHROPIC = "anthropic_messages"
REQUEST_PROTOCOL_OPENAI = "openai_chat_completions"
REQUEST_PROTOCOL_AWS_BEDROCK = "aws_bedrock"
MANUAL_PROBE_SUITE_ID = "manual_model_request_probe"
MANUAL_PROBE_MODE = "manual_probe"
SIGNATURE_INVALID_ERROR = "Invalid `signature` in `thinking` block"
SIGNATURE_TEST_PROMPT_A = "请用中文解释：为什么 0.1 + 0.2 不等于 0.3？请展示完整推理过程。"
SIGNATURE_TEST_PROMPT_B = "好的，那 0.1 + 0.2 + 0.3 == 0.6 是否成立？"
SIGNATURE_FALLBACK_NOTE = """企业级 API 渠道（AWS/Vertex/Anthropic）
优先 AWS，风控饱和则以 Vertex/Anthropic 兜底
都是 Anthropic 和企业云服务商合作
在不同云服务商托管（AWS/Google），模型质量和使用体验没有任何区别

Claude 三类渠道 id 特征：
AWS：msg_bdrk_01xxx
Vertex：msg_vrtx_01xxx
Anthropic：msg_01xxx"""

FEISHU_SETTING_ID = "global"
CHANNEL_TAXONOMY_SETTING_ID = "global"
DEFAULT_ROLE_LABELS = {
    "gold": "金标 Anthropic",
    "official_cloud": "官方云参考",
    "candidate": "待测第三方",
    "negative": "负样本",
}
DEFAULT_PROVIDER_TYPE_LABELS: dict[str, str] = {}
DEFAULT_MODEL_OPTIONS: list[str] = []
REMOVED_BUILT_IN_MODEL_OPTIONS = {
    "claude-sonnet-4-5",
    "anthropic.claude-sonnet-4-5-v1:0",
    "claude-opus-4-1",
    "claude-haiku-4-5",
    "gpt-like-model",
}
REFERENCE_RUN_ROLES = {"reference", "gold", "official_cloud"}
CANDIDATE_RUN_ROLES = {"candidate", "negative"}
COMPARISON_RUN_MODES = {"full_comparison", "candidate_eval"}
SPECIAL_REPORT_RUN_MODES = {"performance_benchmark", "arena_comparison"}


def get_or_create_channel_taxonomy_setting(db: Session) -> ChannelTaxonomySetting:
    setting = db.get(ChannelTaxonomySetting, CHANNEL_TAXONOMY_SETTING_ID)
    if setting:
        return setting
    setting = ChannelTaxonomySetting(
        id=CHANNEL_TAXONOMY_SETTING_ID,
        role_labels=DEFAULT_ROLE_LABELS.copy(),
        provider_type_labels=DEFAULT_PROVIDER_TYPE_LABELS.copy(),
        model_options=DEFAULT_MODEL_OPTIONS.copy(),
    )
    db.add(setting)
    db.commit()
    db.refresh(setting)
    return setting


def channel_taxonomy_setting_read(setting: ChannelTaxonomySetting) -> dict[str, Any]:
    return {
        "id": setting.id,
        "role_labels": _taxonomy_labels(DEFAULT_ROLE_LABELS, setting.role_labels),
        "provider_type_labels": _taxonomy_labels(DEFAULT_PROVIDER_TYPE_LABELS, setting.provider_type_labels),
        "model_options": _taxonomy_options(DEFAULT_MODEL_OPTIONS, setting.model_options),
        "default_role_labels": DEFAULT_ROLE_LABELS,
        "default_provider_type_labels": DEFAULT_PROVIDER_TYPE_LABELS,
        "default_model_options": DEFAULT_MODEL_OPTIONS,
        "created_at": setting.created_at,
        "updated_at": setting.updated_at,
    }


def update_channel_taxonomy_setting(db: Session, data: ChannelTaxonomySettingUpdate) -> ChannelTaxonomySetting:
    setting = get_or_create_channel_taxonomy_setting(db)
    if data.role_labels is not None:
        setting.role_labels = _apply_taxonomy_update(DEFAULT_ROLE_LABELS, setting.role_labels, data.role_labels, "role")
    if data.provider_type_labels is not None:
        setting.provider_type_labels = _apply_taxonomy_update(
            DEFAULT_PROVIDER_TYPE_LABELS,
            setting.provider_type_labels,
            data.provider_type_labels,
            "provider_type",
        )
    if data.model_options is not None:
        setting.model_options = _taxonomy_options(DEFAULT_MODEL_OPTIONS, data.model_options)
    db.commit()
    db.refresh(setting)
    return setting


def _taxonomy_labels(defaults: dict[str, str], stored: dict | None) -> dict[str, str]:
    labels = defaults.copy()
    if not isinstance(stored, dict):
        return labels
    for key, value in stored.items():
        if isinstance(value, str) and value.strip():
            labels[key] = value.strip()
    return labels


def _apply_taxonomy_update(defaults: dict[str, str], current: dict | None, updates: dict[str, str | None], label_type: str) -> dict[str, str]:
    labels = _taxonomy_labels(defaults, current)
    for key, value in updates.items():
        key = str(key).strip()
        if not key:
            raise ValueError(f"Unsupported {label_type} key: {key}")
        text = (value or "").strip()
        if text:
            labels[key] = text
        elif key in defaults:
            labels[key] = defaults[key]
        else:
            labels.pop(key, None)
    return labels


def _taxonomy_options(defaults: list[str], stored: list[str | None] | None) -> list[str]:
    options: list[str] = []
    for value in [*defaults, *(stored or [])]:
        if not isinstance(value, str):
            continue
        text = value.strip()
        if text in REMOVED_BUILT_IN_MODEL_OPTIONS:
            continue
        if text and text not in options:
            options.append(text)
    return options


def get_or_create_feishu_setting(db: Session) -> FeishuBroadcastSetting:
    setting = db.get(FeishuBroadcastSetting, FEISHU_SETTING_ID)
    if setting:
        return setting
    env_webhook = os.getenv("FEISHU_WEBHOOK_URL", "").strip() or None
    setting = FeishuBroadcastSetting(
        id=FEISHU_SETTING_ID,
        enabled=bool(env_webhook),
        webhook_url=env_webhook,
        webhook_secret=os.getenv("FEISHU_WEBHOOK_SECRET", "").strip() or None,
        app_base_url=os.getenv("APP_BASE_URL", "").strip().rstrip("/") or None,
        alert_broadcast_enabled=True,
        daily_report_enabled=True,
        daily_report_time="09:00",
        timezone="Asia/Shanghai",
    )
    db.add(setting)
    db.commit()
    db.refresh(setting)
    return setting


def feishu_setting_read(setting: FeishuBroadcastSetting) -> dict[str, Any]:
    return {
        "id": setting.id,
        "enabled": setting.enabled,
        "webhook_configured": bool(setting.webhook_url),
        "webhook_preview": _mask_webhook(setting.webhook_url),
        "secret_configured": bool(setting.webhook_secret),
        "app_base_url": setting.app_base_url,
        "alert_broadcast_enabled": setting.alert_broadcast_enabled,
        "daily_report_enabled": setting.daily_report_enabled,
        "daily_report_time": setting.daily_report_time,
        "timezone": setting.timezone,
        "last_daily_report_at": setting.last_daily_report_at,
        "created_at": setting.created_at,
        "updated_at": setting.updated_at,
    }


def update_feishu_setting(db: Session, data: FeishuBroadcastSettingUpdate) -> FeishuBroadcastSetting:
    setting = get_or_create_feishu_setting(db)
    values = data.model_dump(exclude_unset=True)
    for key in ["enabled", "alert_broadcast_enabled", "daily_report_enabled"]:
        if key in values:
            setattr(setting, key, values[key])
    if "webhook_url" in values:
        webhook_url = (values["webhook_url"] or "").strip()
        if webhook_url:
            setting.webhook_url = webhook_url
    if data.clear_webhook_secret:
        setting.webhook_secret = None
    elif "webhook_secret" in values:
        secret = (values["webhook_secret"] or "").strip()
        if secret:
            setting.webhook_secret = secret
    if "app_base_url" in values:
        setting.app_base_url = (values["app_base_url"] or "").strip().rstrip("/") or None
    if "daily_report_time" in values and values["daily_report_time"] is not None:
        _validate_daily_report_time(values["daily_report_time"])
        setting.daily_report_time = values["daily_report_time"]
    if "timezone" in values and values["timezone"]:
        _zoneinfo(values["timezone"])
        setting.timezone = values["timezone"]
    if setting.enabled and not setting.webhook_url:
        raise ValueError("飞书 Webhook 未配置，请先保存 Webhook")
    db.commit()
    db.refresh(setting)
    return setting


def _mask_webhook(webhook_url: str | None) -> str | None:
    if not webhook_url:
        return None
    if len(webhook_url) <= 18:
        return "***"
    return f"{webhook_url[:12]}...{webhook_url[-6:]}"


def _validate_daily_report_time(value: str) -> None:
    try:
        hour_raw, minute_raw = value.split(":", 1)
        hour = int(hour_raw)
        minute = int(minute_raw)
    except Exception as exc:
        raise ValueError("daily_report_time must use HH:MM format") from exc
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise ValueError("daily_report_time must be between 00:00 and 23:59")


def _zoneinfo(timezone_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"Unsupported timezone: {timezone_name}") from exc


def create_channel(db: Session, data: ChannelCreate) -> Channel:
    existing = db.get(Channel, data.id) if data.id else None
    if existing:
        role = data.role or ("gold" if data.is_reference else "candidate")
        existing.name = data.name
        existing.provider_type = data.provider_type
        existing.role = role
        existing.base_url = data.base_url
        existing.model_name = data.model_name
        existing.auth_config_encrypted = _clean_auth_config(data.auth_config)
        existing.is_reference = data.is_reference
        existing.enabled = data.enabled
        db.commit()
        db.refresh(existing)
        return existing
    role = data.role or ("gold" if data.is_reference else "candidate")
    channel = Channel(
        id=data.id or new_id("ch"),
        name=data.name,
        provider_type=data.provider_type,
        role=role,
        base_url=data.base_url,
        model_name=data.model_name,
        auth_config_encrypted=_clean_auth_config(data.auth_config),
        is_reference=data.is_reference,
        enabled=data.enabled,
    )
    db.add(channel)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.get(Channel, channel.id)
        if existing:
            return existing
        raise
    db.refresh(channel)
    return channel


def default_channel_templates() -> list[ChannelCreate]:
    return [
        ChannelCreate(id="anthropic_official", name="Anthropic Official", provider_type="anthropic", role="gold", base_url="https://api.anthropic.com", model_name="claude-sonnet-4-5", is_reference=True),
        ChannelCreate(id="aws_bedrock", name="AWS Bedrock Claude", provider_type="aws_bedrock", role="official_cloud", base_url="bedrock-runtime", model_name="anthropic.claude-sonnet-4-5-v1:0", is_reference=True),
        ChannelCreate(id="azure_foundry", name="Azure AI Foundry Claude", provider_type="azure_foundry", role="official_cloud", base_url="https://example.services.ai.azure.com", model_name="claude-sonnet-4-5", is_reference=True),
        ChannelCreate(id="third_party_demo", name="Third-party Relay Demo", provider_type="third_party_anthropic", role="candidate", base_url="https://relay.example/v1", model_name="claude-sonnet-4-5"),
        ChannelCreate(id="openai_compat_demo", name="OpenAI-compatible Relay Demo", provider_type="third_party_openai_compatible", role="candidate", base_url="https://relay.example/v1", model_name="claude-sonnet-4-5"),
        ChannelCreate(id="negative_sample", name="Negative Sample", provider_type="third_party_openai_compatible", role="negative", base_url="https://non-claude.example/v1", model_name="gpt-like-model"),
    ]


def seed_default_channels_if_empty(db: Session) -> None:
    if db.scalar(select(func.count()).select_from(Channel)):
        return
    for template in default_channel_templates():
        create_channel(db, template)


def seed_missing_channels(db: Session, channel_data: list[dict[str, Any]]) -> int:
    inserted = 0
    for item in channel_data:
        channel_id = item.get("id")
        if not channel_id or db.get(Channel, channel_id):
            continue
        create_channel(db, ChannelCreate(**item))
        inserted += 1
    return inserted


def seed_restored_fixture_data(db: Session) -> dict[str, int]:
    _logger = logging.getLogger(__name__)
    data = restored_seed_data()
    inserted = {
        "channels": seed_missing_channels(db, data["channels"]),
        "test_suites": 0,
        "test_cases": 0,
    }
    for suite_data in data["test_suites"]:
        suite_id = suite_data.get("id")
        if not suite_id:
            continue
        if db.get(TestSuite, suite_id) is None:
            create_suite(db, TestSuiteCreate(**suite_data))
            inserted["test_suites"] += 1

    for case_data in data["test_cases"]:
        case_id = case_data.get("id")
        if not case_id:
            continue
        if db.get(TestCase, case_id) is None:
            create_case(db, TestCaseCreate(**case_data))
            inserted["test_cases"] += 1

    if any(inserted.values()):
        db.commit()
        _logger.info("Seed: restored fixture data — channels=%d suites=%d cases=%d",
                     inserted["channels"], inserted["test_suites"], inserted["test_cases"])
    return inserted


def _clean_auth_config(config: dict[str, Any] | None) -> dict[str, Any] | None:
    cleaned: dict[str, Any] = {}
    for key, value in (config or {}).items():
        if value is None:
            continue
        if isinstance(value, str):
            value = value.strip()
            if not value:
                continue
        cleaned[str(key)] = value
    return cleaned or None


def create_suite(db: Session, data: TestSuiteCreate) -> TestSuite:
    existing = db.get(TestSuite, data.id) if data.id else None
    if existing:
        existing.name = data.name
        existing.description = data.description
        existing.version = data.version
        existing.visibility = data.visibility
        db.commit()
        db.refresh(existing)
        return existing
    suite = TestSuite(
        id=data.id or new_id("suite"),
        name=data.name,
        description=data.description,
        version=data.version,
        visibility=data.visibility,
    )
    db.add(suite)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.get(TestSuite, data.id) if data.id else None
        if not existing:
            raise
        existing.name = data.name
        existing.description = data.description
        existing.version = data.version
        existing.visibility = data.visibility
        db.commit()
        db.refresh(existing)
        return existing
    db.refresh(suite)
    return suite


def create_case(db: Session, data: TestCaseCreate) -> TestCase:
    existing = db.get(TestCase, data.id) if data.id else None
    if existing:
        existing.suite_id = data.suite_id
        existing.module = data.module
        existing.sort_order = data.sort_order
        existing.title = data.title
        existing.prompt = data.prompt
        existing.system_prompt = data.system_prompt
        existing.request_params = data.request_params or {}
        existing.scoring_rules = data.scoring_rules or {}
        existing.is_hidden = data.is_hidden
        existing.enabled = data.enabled
        db.commit()
        return existing
    existing_orders = db.scalars(select(TestCase.sort_order).where(TestCase.suite_id == data.suite_id)).all()
    next_order = max([order for order in existing_orders if order is not None], default=0) + 1
    sort_order = data.sort_order if data.sort_order not in {None, 0, 1000} else next_order
    case = TestCase(
        id=data.id or new_id("tc"),
        suite_id=data.suite_id,
        module=data.module,
        sort_order=sort_order,
        title=data.title,
        prompt=data.prompt,
        system_prompt=data.system_prompt,
        request_params=data.request_params or {},
        scoring_rules=data.scoring_rules or {},
        is_hidden=data.is_hidden,
        enabled=data.enabled,
    )
    db.add(case)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.get(TestCase, case.id)
        if existing:
            existing.suite_id = data.suite_id
            existing.module = data.module
            existing.sort_order = sort_order
            existing.title = data.title
            existing.prompt = data.prompt
            existing.system_prompt = data.system_prompt
            existing.request_params = data.request_params or {}
            existing.scoring_rules = data.scoring_rules or {}
            existing.is_hidden = data.is_hidden
            existing.enabled = data.enabled
            db.commit()
            return existing
        raise
    db.refresh(case)
    return case


def export_suite_bundle(db: Session, suite_id: str) -> dict[str, Any]:
    suite = db.get(TestSuite, suite_id)
    if not suite:
        raise ValueError("Test suite not found")
    cases = db.scalars(
        select(TestCase)
        .where(TestCase.suite_id == suite_id)
        .order_by(TestCase.sort_order, TestCase.module, TestCase.id)
    ).all()
    return {
        "suite": {
            "id": suite.id,
            "name": suite.name,
            "description": suite.description,
            "version": suite.version,
            "visibility": suite.visibility,
        },
        "cases": [
            {
                "id": case.id,
                "suite_id": suite.id,
                "module": case.module,
                "sort_order": case.sort_order,
                "title": case.title,
                "prompt": case.prompt,
                "system_prompt": case.system_prompt,
                "request_params": case.request_params or {},
                "scoring_rules": case.scoring_rules or {},
                "is_hidden": case.is_hidden,
                "enabled": case.enabled,
            }
            for case in cases
        ],
    }


def import_suite_bundle(db: Session, bundle: TestSuiteBundle) -> dict[str, Any]:
    suite_data = bundle.suite
    suite_id = suite_data.id or new_id("suite")
    suite = db.get(TestSuite, suite_id)
    created_suite = suite is None
    if suite is None:
        suite = TestSuite(
            id=suite_id,
            name=suite_data.name,
            description=suite_data.description,
            version=suite_data.version,
            visibility=suite_data.visibility,
        )
        db.add(suite)
    else:
        suite.name = suite_data.name
        suite.description = suite_data.description
        suite.version = suite_data.version
        suite.visibility = suite_data.visibility

    created_cases = 0
    updated_cases = 0
    for index, case_data in enumerate(bundle.cases, start=1):
        case_id = case_data.id or new_id("tc")
        case = db.get(TestCase, case_id)
        if case is None:
            case = TestCase(id=case_id, suite_id=suite_id)
            db.add(case)
            created_cases += 1
        else:
            updated_cases += 1
        case.suite_id = suite_id
        case.module = case_data.module
        case.sort_order = case_data.sort_order or index
        case.title = case_data.title
        case.prompt = case_data.prompt
        case.system_prompt = case_data.system_prompt
        case.request_params = case_data.request_params or {}
        case.scoring_rules = case_data.scoring_rules or {}
        case.is_hidden = case_data.is_hidden
        case.enabled = case_data.enabled
    db.commit()
    db.refresh(suite)
    return {
        "suite": TestSuiteRead.model_validate(suite),
        "created_suite": created_suite,
        "created_cases": created_cases,
        "updated_cases": updated_cases,
        "case_count": len(bundle.cases),
    }


def import_evalscope_jsonl(db: Session, data: EvalScopeJsonlImportCreate) -> dict[str, Any]:
    cases: list[TestCaseCreate] = []
    for index, raw_line in enumerate(data.jsonl.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSONL at line {index}: {exc.msg}") from exc
        if not isinstance(payload, dict):
            raise ValueError(f"Invalid JSONL at line {index}: expected object")
        cases.append(_evalscope_record_to_case(data.suite.id or "evalscope_suite", payload, index, data.default_module, data.default_task_type))
    return import_suite_bundle(db, TestSuiteBundle(suite=data.suite, cases=cases))


def _evalscope_record_to_case(suite_id: str, payload: dict[str, Any], index: int, default_module: str, default_task_type: str) -> TestCaseCreate:
    prompt = _first_text(payload, ["prompt", "query", "question", "input", "problem", "instruction"])
    if not prompt and isinstance(payload.get("messages"), list):
        prompt = _messages_to_prompt(payload["messages"])
    if not prompt:
        raise ValueError(f"EvalScope record line {index} has no prompt/query/question/input")

    case_id = str(payload.get("id") or payload.get("case_id") or payload.get("sample_id") or f"{suite_id}_case_{index:04d}")
    module = str(payload.get("module") or payload.get("category") or payload.get("subset") or default_module)
    task_type = str(payload.get("task_type") or payload.get("metric") or default_task_type)
    choices = payload.get("choices") or payload.get("options")
    answer = payload.get("answer") if "answer" in payload else payload.get("target")
    scoring_rules = _clean_dict(payload.get("scoring_rules")) or {}
    scoring_rules.setdefault("task_type", task_type)
    if choices is not None:
        scoring_rules["choices"] = choices
        if "task_type" not in payload and "metric" not in payload:
            scoring_rules["task_type"] = "mcq"
    if answer is not None:
        scoring_rules["answer_key"] = answer
    if payload.get("reference_answer") is not None:
        scoring_rules["reference_answer"] = payload["reference_answer"]
    if payload.get("tags") is not None:
        scoring_rules["coverage_tags"] = _string_list(payload["tags"])
    if payload.get("difficulty") is not None:
        scoring_rules["difficulty"] = str(payload["difficulty"])
    if payload.get("risk_dimension") is not None:
        scoring_rules["risk_dimension"] = str(payload["risk_dimension"])

    return TestCaseCreate(
        id=case_id,
        suite_id=suite_id,
        module=module,
        sort_order=int(payload.get("sort_order") or index),
        title=str(payload.get("title") or payload.get("name") or case_id),
        prompt=prompt,
        system_prompt=payload.get("system_prompt") if isinstance(payload.get("system_prompt"), str) else None,
        request_params=_clean_dict(payload.get("request_params")) or {"max_tokens": 256, "temperature": 0},
        scoring_rules=scoring_rules,
        is_hidden=bool(payload.get("is_hidden", False)),
        enabled=payload.get("enabled", True) is not False,
    )


def validate_suite_cases(db: Session, suite_id: str) -> dict[str, Any]:
    suite = db.get(TestSuite, suite_id)
    if not suite:
        raise ValueError("Test suite not found")
    cases = _suite_cases(db, suite_id)
    issues: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_prompt_hashes: dict[str, str] = {}
    for case in cases:
        rules = case.scoring_rules or {}
        if case.id in seen_ids:
            issues.append(_suite_issue("error", case.id, "id", "Duplicate case id"))
        seen_ids.add(case.id)
        if not case.prompt.strip():
            issues.append(_suite_issue("error", case.id, "prompt", "Prompt cannot be empty"))
        prompt_hash = hashlib.sha256(case.prompt.strip().encode("utf-8")).hexdigest()
        if prompt_hash in seen_prompt_hashes:
            issues.append(_suite_issue("warning", case.id, "prompt", f"Prompt duplicates {seen_prompt_hashes[prompt_hash]}"))
        seen_prompt_hashes[prompt_hash] = case.id
        task_type = _case_task_type(case)
        if task_type not in {"qa", "mcq", "json_schema", "function_call", "protocol_probe", "arena_prompt"}:
            issues.append(_suite_issue("warning", case.id, "task_type", f"Unsupported task_type: {task_type}"))
        if not rules:
            issues.append(_suite_issue("warning", case.id, "scoring_rules", "Missing scoring rules"))
        if _case_weight(case) <= 0:
            issues.append(_suite_issue("error", case.id, "weight", "Weight must be positive"))
        if task_type == "mcq" and not rules.get("choices"):
            issues.append(_suite_issue("warning", case.id, "choices", "MCQ cases should define choices"))
        if task_type == "function_call" and not (rules.get("tool_name") or rules.get("tool_required")):
            issues.append(_suite_issue("warning", case.id, "tool", "Function calling cases should define tool requirements"))
        if task_type == "json_schema" and not rules.get("json_schema"):
            issues.append(_suite_issue("warning", case.id, "json_schema", "JSON schema cases should define json_schema"))
        if not rules.get("coverage_tags"):
            issues.append(_suite_issue("info", case.id, "coverage_tags", "Missing coverage tags"))
        if not rules.get("difficulty"):
            issues.append(_suite_issue("info", case.id, "difficulty", "Missing difficulty"))
    return {"suite_id": suite_id, "ok": not any(item["severity"] == "error" for item in issues), "issue_count": len(issues), "issues": issues}


def suite_coverage(db: Session, suite_id: str) -> dict[str, Any]:
    suite = db.get(TestSuite, suite_id)
    if not suite:
        raise ValueError("Test suite not found")
    cases = _suite_cases(db, suite_id)
    enabled_cases = [case for case in cases if case.enabled]
    missing_metadata = {"task_type": 0, "difficulty": 0, "coverage_tags": 0, "risk_dimension": 0}
    by_task_type: list[str] = []
    by_difficulty: list[str] = []
    by_risk_dimension: list[str] = []
    tags: list[str] = []
    for case in cases:
        rules = case.scoring_rules or {}
        by_task_type.append(_case_task_type(case))
        difficulty = str(rules.get("difficulty") or "unspecified")
        by_difficulty.append(difficulty)
        dimension = str(rules.get("risk_dimension") or case_dimension(case))
        by_risk_dimension.append(dimension)
        case_tags = _case_tags(case)
        tags.extend(case_tags)
        if "task_type" not in rules:
            missing_metadata["task_type"] += 1
        if "difficulty" not in rules:
            missing_metadata["difficulty"] += 1
        if not case_tags:
            missing_metadata["coverage_tags"] += 1
        if "risk_dimension" not in rules:
            missing_metadata["risk_dimension"] += 1
    return {
        "suite_id": suite_id,
        "case_count": len(cases),
        "enabled_count": len(enabled_cases),
        "quick_count": sum(1 for case in cases if (case.scoring_rules or {}).get("quick") is True),
        "by_module": _count_values([case.module for case in cases]),
        "by_task_type": _count_values(by_task_type),
        "by_difficulty": _count_values(by_difficulty),
        "by_risk_dimension": _count_values(by_risk_dimension),
        "coverage_tags": _count_values(tags),
        "missing_metadata": missing_metadata,
    }


def build_sample_plan(db: Session, data: SamplePlanCreate) -> dict[str, Any]:
    available = cases_for_scope(db, data.suite_id, data.test_scope)
    selected = [case for case in available if _case_matches_sample_filters(case, data)]
    grouped_counts = _count_values([_case_sample_group(case, data.group_by) for case in selected])
    if data.per_group_limit:
        by_group: dict[str, list[TestCase]] = defaultdict(list)
        for case in selected:
            group = _case_sample_group(case, data.group_by)
            if len(by_group[group]) < data.per_group_limit:
                by_group[group].append(case)
        selected = [case for group in sorted(by_group) for case in by_group[group]]
    if data.limit:
        selected = selected[: data.limit]
    return {
        "suite_id": data.suite_id,
        "test_scope": data.test_scope,
        "total_available": len(available),
        "selected_count": len(selected),
        "filters": data.model_dump(exclude_none=True),
        "cases": [TestCaseRead.model_validate(case) for case in selected],
        "group_counts": grouped_counts,
    }


def suite_diff(db: Session, suite_id: str, against: str) -> dict[str, Any]:
    current = export_suite_bundle(db, suite_id)
    try:
        reference = json.loads(against)
    except json.JSONDecodeError:
        reference = export_suite_bundle(db, against)
    current_cases = {case["id"]: case for case in current["cases"]}
    reference_cases = {case["id"]: case for case in reference.get("cases", []) if case.get("id")}
    added = sorted(set(current_cases) - set(reference_cases))
    removed = sorted(set(reference_cases) - set(current_cases))
    changed: list[dict[str, Any]] = []
    unchanged: list[str] = []
    for case_id in sorted(set(current_cases) & set(reference_cases)):
        fields = []
        for field in ["module", "sort_order", "title", "prompt", "system_prompt", "request_params", "scoring_rules", "is_hidden", "enabled"]:
            if current_cases[case_id].get(field) != reference_cases[case_id].get(field):
                fields.append(field)
        if fields:
            changed.append({"id": case_id, "fields": fields})
        else:
            unchanged.append(case_id)
    return {"suite_id": suite_id, "against": reference.get("suite", {}).get("id", against), "added": added, "removed": removed, "changed": changed, "unchanged": unchanged}


def _suite_cases(db: Session, suite_id: str) -> list[TestCase]:
    return list(
        db.scalars(
            select(TestCase)
            .where(TestCase.suite_id == suite_id)
            .order_by(TestCase.sort_order, TestCase.module, TestCase.id)
        ).all()
    )


def _first_text(payload: dict[str, Any], keys: list[str]) -> str:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _messages_to_prompt(messages: list[Any]) -> str:
    parts = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role") or "user"
        content = message.get("content")
        if isinstance(content, str):
            parts.append(f"{role}: {content}")
    return "\n".join(parts)


def _clean_dict(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def _suite_issue(severity: str, case_id: str | None, field: str | None, message: str) -> dict[str, Any]:
    return {"severity": severity, "case_id": case_id, "field": field, "message": message}


def _case_task_type(case: TestCase) -> str:
    rules = case.scoring_rules or {}
    task_type = rules.get("task_type")
    if isinstance(task_type, str) and task_type.strip():
        return task_type.strip()
    if rules.get("tool_required") or rules.get("tool_name"):
        return "function_call"
    if rules.get("json_schema") or rules.get("json_required"):
        return "json_schema"
    if case.module in {"protocol", "websearch"} or _is_expected_error_probe_case(case):
        return "protocol_probe"
    if case.module == "arena":
        return "arena_prompt"
    return "qa"


def _case_weight(case: TestCase) -> float:
    try:
        return float((case.scoring_rules or {}).get("weight", 1.0))
    except (TypeError, ValueError):
        return 0.0


def _case_tags(case: TestCase) -> list[str]:
    rules = case.scoring_rules or {}
    return _string_list(rules.get("coverage_tags") or rules.get("tags"))


def _case_matches_sample_filters(case: TestCase, data: SamplePlanCreate) -> bool:
    rules = case.scoring_rules or {}
    if data.modules and case.module not in data.modules:
        return False
    if data.task_types and _case_task_type(case) not in data.task_types:
        return False
    if data.difficulties and str(rules.get("difficulty") or "unspecified") not in data.difficulties:
        return False
    if data.risk_dimensions and str(rules.get("risk_dimension") or case_dimension(case)) not in data.risk_dimensions:
        return False
    if data.coverage_tags:
        tags = set(_case_tags(case))
        if not tags.intersection(data.coverage_tags):
            return False
    return True


def _case_sample_group(case: TestCase, group_by: str) -> str:
    rules = case.scoring_rules or {}
    if group_by == "task_type":
        return _case_task_type(case)
    if group_by == "difficulty":
        return str(rules.get("difficulty") or "unspecified")
    if group_by == "risk_dimension":
        return str(rules.get("risk_dimension") or case_dimension(case))
    return case.module


def seed_demo_data(db: Session) -> None:
    _logger = logging.getLogger(__name__)
    _logger.info("Seed: checking and creating built-in data if missing")
    if not db.scalar(select(func.count()).select_from(Channel)):
        seed_missing_channels(db, [template.model_dump() for template in default_channel_templates()])
    suite_id = default_suite()["id"]
    if not db.scalar(select(TestSuite).where(TestSuite.id == suite_id)):
        create_suite(db, TestSuiteCreate(**default_suite()))
        _logger.info("Seed: created built-in suite %s", suite_id)
    else:
        _logger.info("Seed: built-in suite %s already exists, skipping update", suite_id)
    case_by_id = {case.id: case for case in db.scalars(select(TestCase).where(TestCase.suite_id == suite_id)).all()}
    default_case_data = default_cases()
    created_cases = 0
    for case_data in default_case_data:
        if case_data["id"] in case_by_id:
            continue
        case_by_id[case_data["id"]] = create_case(db, TestCaseCreate(**case_data))
        created_cases += 1
    if created_cases:
        db.commit()
        _logger.info("Seed: created %d missing built-in cases for suite %s", created_cases, suite_id)
    _logger.info("Seed: complete")


def create_run(db: Session, data: RunCreate) -> Run:
    mode = data.mode or "full_comparison"
    test_scope = data.test_scope or "full"
    benchmark_config = normalize_benchmark_config(data.benchmark_config.model_dump() if data.benchmark_config else None)
    if test_scope not in {"quick", "full"}:
        raise ValueError(f"Unsupported test scope: {test_scope}")
    if mode not in {"full_comparison", "baseline_build", "candidate_eval", "performance_benchmark", "arena_comparison", MANUAL_PROBE_MODE}:
        raise ValueError(f"Unsupported run mode: {mode}")
    if mode == "candidate_eval":
        if not data.baseline_snapshot_id:
            raise ValueError("candidate_eval requires baseline_snapshot_id")
        validate_baseline_for_run(db, data.baseline_snapshot_id, data.suite_id)
    channel_ids_by_role = _normalize_channel_ids_for_mode(db, data.channel_ids or _default_channel_ids_by_role(db, mode), mode)
    selected_ids = [(channel_id, role) for role, ids in channel_ids_by_role.items() for channel_id in ids]
    cases = cases_for_scope(db, data.suite_id, test_scope)
    repeat_count = max(1, data.repeat_count)
    concurrency = max(1, data.concurrency)
    if mode == "performance_benchmark" and benchmark_config:
        concurrency = max(benchmark_config["concurrency_steps"])
        min_attempts = benchmark_config["warmup_requests"] + len(benchmark_config["concurrency_steps"])
        if benchmark_config["duration_seconds"]:
            min_attempts += max(1, benchmark_config["duration_seconds"] // 30)
        repeat_count = max(repeat_count, min(20, max(1, min_attempts)))
    run = Run(
        id=new_id("run"),
        suite_id=data.suite_id,
        name=data.name,
        mode=mode,
        test_scope=test_scope,
        baseline_snapshot_id=data.baseline_snapshot_id,
        status="pending",
        repeat_count=repeat_count,
        concurrency=concurrency,
        total_jobs=len(selected_ids) * len(cases) * repeat_count,
    )
    db.add(run)
    db.commit()
    for channel_id, role in selected_ids:
        db.add(RunChannel(id=new_id("rch"), run_id=run.id, channel_id=channel_id, role_in_run=role))
    db.commit()
    db.refresh(run)
    return run


def normalize_benchmark_config(config: dict[str, Any] | None) -> dict[str, Any] | None:
    if not config:
        return None
    steps = config.get("concurrency_steps") or [config.get("concurrency") or 1]
    concurrency_steps = sorted({max(1, min(64, int(step))) for step in steps if str(step).strip()})
    if not concurrency_steps:
        concurrency_steps = [1]
    return {
        "concurrency_steps": concurrency_steps,
        "duration_seconds": max(0, min(3600, int(config.get("duration_seconds") or 0))),
        "warmup_requests": max(0, min(1000, int(config.get("warmup_requests") or 0))),
        "target_qps": float(config["target_qps"]) if config.get("target_qps") else None,
        "sla_p95_ms": int(config["sla_p95_ms"]) if config.get("sla_p95_ms") else None,
        "max_error_rate": float(config["max_error_rate"]) if config.get("max_error_rate") is not None else None,
    }


def create_baseline_build(db: Session, data: BaselineBuildCreate) -> tuple[Run, BaselineSnapshot]:
    run = create_run(
        db,
        RunCreate(
            name=data.name,
            suite_id=data.suite_id,
            channel_ids=data.channel_ids,
            repeat_count=data.repeat_count,
            concurrency=data.concurrency,
            use_mock=data.use_mock,
            mode="baseline_build",
            test_scope=data.test_scope,
            runtime_credentials=data.runtime_credentials,
        ),
    )
    channel_ids = [item.channel_id for item in db.scalars(select(RunChannel).where(RunChannel.run_id == run.id)).all()]
    snapshot = BaselineSnapshot(
        id=new_id("base"),
        name=data.name,
        suite_id=data.suite_id,
        source_run_id=run.id,
        status="building",
        suite_fingerprint=suite_fingerprint(db, data.suite_id),
        request_fingerprint=request_fingerprint(db, data.suite_id),
        channel_fingerprint=channel_fingerprint(db, channel_ids),
        channel_ids=channel_ids,
        expires_at=datetime.now(timezone.utc) + timedelta(days=max(1, data.expires_in_days)),
    )
    db.add(snapshot)
    run.baseline_snapshot_id = snapshot.id
    db.commit()
    db.refresh(run)
    db.refresh(snapshot)
    return run, snapshot


def create_scheduled_channel_test(db: Session, data: ScheduledChannelTestCreate) -> ScheduledChannelTest:
    channel = db.get(Channel, data.channel_id)
    if not channel:
        raise ValueError("Channel not found")
    if channel.is_reference:
        raise ValueError("Scheduled channel tests require a non-reference candidate channel")
    test_scope = data.test_scope
    if "test_scope" not in data.model_fields_set and data.suite_id and data.baseline_snapshot_id:
        test_scope = "full"
    if test_scope == "scheduled_probe":
        suite_id, baseline_snapshot_id = scheduled_probe_context(db, data.suite_id, data.baseline_snapshot_id)
    else:
        if not data.suite_id or not data.baseline_snapshot_id:
            raise ValueError("Scheduled channel tests require suite_id and baseline_snapshot_id")
        validate_baseline_for_run(db, data.baseline_snapshot_id, data.suite_id)
        suite_id, baseline_snapshot_id = data.suite_id, data.baseline_snapshot_id
    next_run_at = data.next_run_at or next_scheduled_run_at(
        datetime.now(timezone.utc),
        data.interval_minutes,
        data.run_window_start,
        data.run_window_end,
    )
    scheduled = ScheduledChannelTest(
        id=data.id or new_id("sched"),
        name=data.name,
        channel_id=data.channel_id,
        suite_id=suite_id,
        baseline_snapshot_id=baseline_snapshot_id,
        enabled=data.enabled,
        interval_minutes=max(5, data.interval_minutes),
        run_window_start=data.run_window_start,
        run_window_end=data.run_window_end,
        test_scope=test_scope if test_scope in {"quick", "full", "scheduled_probe"} else "scheduled_probe",
        repeat_count=max(1, data.repeat_count),
        concurrency=max(1, data.concurrency),
        use_mock=data.use_mock,
        alert_grade_threshold=data.alert_grade_threshold if data.alert_grade_threshold in {"C", "D", "E"} else "D",
        alert_score_threshold=data.alert_score_threshold,
        alert_red_flags_enabled=data.alert_red_flags_enabled,
        quiet_minutes=max(0, data.quiet_minutes),
        max_retries=max(0, data.max_retries),
        retry_interval_minutes=max(1, data.retry_interval_minutes),
        next_run_at=next_run_at,
        last_status="idle",
    )
    db.add(scheduled)
    db.commit()
    db.refresh(scheduled)
    return scheduled


def cases_for_scope(db: Session, suite_id: str, test_scope: str) -> list[TestCase]:
    cases = list(
        db.scalars(
            select(TestCase)
            .where(TestCase.suite_id == suite_id, TestCase.enabled.is_(True))
            .order_by(TestCase.sort_order, TestCase.module, TestCase.id)
        ).all()
    )
    if test_scope != "quick":
        return cases
    return [case for case in cases if (case.scoring_rules or {}).get("quick") is True]


def validate_scheduled_channel_test(db: Session, scheduled: ScheduledChannelTest) -> None:
    channel = db.get(Channel, scheduled.channel_id)
    if not channel:
        raise ValueError("Channel not found")
    if channel.is_reference:
        raise ValueError("Scheduled channel tests require a non-reference candidate channel")
    if scheduled.test_scope == "scheduled_probe":
        suite_id, baseline_snapshot_id = scheduled_probe_context(db, scheduled.suite_id, scheduled.baseline_snapshot_id)
        scheduled.suite_id = suite_id
        scheduled.baseline_snapshot_id = baseline_snapshot_id
        return
    if not scheduled.suite_id or not scheduled.baseline_snapshot_id:
        raise ValueError("Scheduled channel tests require suite_id and baseline_snapshot_id")
    validate_baseline_for_run(db, scheduled.baseline_snapshot_id, scheduled.suite_id)


def scheduled_probe_context(db: Session, suite_id: str | None = None, baseline_snapshot_id: str | None = None) -> tuple[str, str]:
    suite = _manual_probe_suite(db)
    if suite_id and baseline_snapshot_id and baseline_snapshot_id.strip() != "scheduled_probe_baseline":
        validate_baseline_for_run(db, baseline_snapshot_id, suite_id)
        return suite_id, baseline_snapshot_id
    snapshot = db.scalar(
        select(BaselineSnapshot)
        .where(BaselineSnapshot.id == "scheduled_probe_baseline")
        .limit(1)
    )
    if not snapshot:
        source_channel_ids = [channel.id for channel in db.scalars(select(Channel).where(Channel.is_reference.is_(True), Channel.enabled.is_(True))).all()]
        if not source_channel_ids:
            source_channel_ids = [channel.id for channel in db.scalars(select(Channel).where(Channel.enabled.is_(True)).limit(1)).all()]
        snapshot = BaselineSnapshot(
            id="scheduled_probe_baseline",
            name="自动巡检默认指纹",
            suite_id=suite.id,
            source_run_id=None,
            status="ready",
            suite_fingerprint="scheduled_probe",
            request_fingerprint="scheduled_probe",
            channel_fingerprint="scheduled_probe",
            channel_ids=source_channel_ids,
            ready_at=datetime.now(timezone.utc),
        )
        db.add(snapshot)
        db.commit()
        db.refresh(snapshot)
    else:
        snapshot.suite_id = suite.id
        snapshot.status = "ready"
        snapshot.suite_fingerprint = "scheduled_probe"
        snapshot.request_fingerprint = "scheduled_probe"
        snapshot.channel_fingerprint = "scheduled_probe"
        if not snapshot.ready_at:
            snapshot.ready_at = datetime.now(timezone.utc)
        db.commit()
    return suite.id, snapshot.id


def _default_channel_ids_by_role(db: Session, mode: str = "full_comparison") -> dict[str, list[str]]:
    result: dict[str, list[str]] = defaultdict(list)
    for channel in db.scalars(select(Channel).where(Channel.enabled.is_(True))).all():
        result["reference" if channel.is_reference else "candidate"].append(channel.id)
    return _filter_channel_ids_for_mode(dict(result), mode)


def _filter_channel_ids_for_mode(channel_ids_by_role: dict[str, list[str]], mode: str) -> dict[str, list[str]]:
    allowed = {
        "baseline_build": REFERENCE_RUN_ROLES,
        "candidate_eval": CANDIDATE_RUN_ROLES,
        "full_comparison": REFERENCE_RUN_ROLES | CANDIDATE_RUN_ROLES,
        "performance_benchmark": REFERENCE_RUN_ROLES | CANDIDATE_RUN_ROLES,
        "arena_comparison": REFERENCE_RUN_ROLES | CANDIDATE_RUN_ROLES,
        MANUAL_PROBE_MODE: REFERENCE_RUN_ROLES | CANDIDATE_RUN_ROLES,
    }[mode]
    return {role: ids for role, ids in channel_ids_by_role.items() if role in allowed and ids}


def _normalize_channel_ids_for_mode(db: Session, channel_ids_by_role: dict[str, list[str]], mode: str) -> dict[str, list[str]]:
    normalized: dict[str, list[str]] = defaultdict(list)
    for role, ids in channel_ids_by_role.items():
        for channel_id in ids:
            channel = db.get(Channel, channel_id)
            if not channel:
                continue
            if role in REFERENCE_RUN_ROLES:
                normalized["reference"].append(channel_id)
            elif role in CANDIDATE_RUN_ROLES:
                normalized["candidate"].append(channel_id)
            else:
                normalized["reference" if channel.is_reference else "candidate"].append(channel_id)
    return _filter_channel_ids_for_mode(dict(normalized), mode)


def _is_reference_role(role: str | None) -> bool:
    return role in REFERENCE_RUN_ROLES


def _is_candidate_role(role: str | None) -> bool:
    return role in CANDIDATE_RUN_ROLES


def _merged_channel_credentials(channel: Channel, runtime: dict[str, Any] | None) -> dict[str, Any]:
    credentials: dict[str, Any] = {}
    if isinstance(channel.auth_config_encrypted, dict):
        credentials.update(channel.auth_config_encrypted)
    if runtime:
        credentials.update(runtime)
    return credentials


def _result_from_normalized(run_id: str, case: TestCase, channel: Channel, attempt: int, normalized: dict[str, Any]) -> Result:
    score, labels = score_result(channel, case, normalized)
    return Result(
        id=new_id("res"),
        run_id=run_id,
        test_case_id=case.id,
        channel_id=channel.id,
        attempt_index=attempt,
        normalized_response=normalized,
        raw_request=normalized.get("raw_request"),
        raw_response=normalized.get("raw_response"),
        metrics=metrics_from_normalized(normalized),
        score=score,
        labels=labels,
    )


def metrics_from_normalized(normalized: dict[str, Any]) -> dict[str, Any]:
    return {
        "latency_ms": normalized.get("latency_ms"),
        "first_token_ms": normalized.get("first_token_ms"),
        "ttft_ms": normalized.get("ttft_ms") or normalized.get("first_token_ms"),
        "tpot_ms": normalized.get("tpot_ms"),
        "input_tokens": normalized.get("input_tokens"),
        "output_tokens": normalized.get("output_tokens"),
        "tokens_per_second": normalized.get("tokens_per_second"),
        "status_code": normalized.get("status_code"),
        "error_type": normalized.get("error_type"),
    }


def _manual_probe_case(
    db: Session,
    *,
    title: str,
    prompt: str,
    system_prompt: str | None,
    request_params: dict[str, Any],
    scoring_rules: dict[str, Any] | None = None,
) -> TestCase:
    suite = _manual_probe_suite(db)
    case = TestCase(
        id=new_id("case"),
        suite_id=suite.id,
        module="manual_probe",
        sort_order=1,
        title=title,
        prompt=prompt,
        system_prompt=system_prompt.strip() if system_prompt else None,
        request_params=request_params,
        scoring_rules=scoring_rules or {},
        is_hidden=False,
        enabled=True,
    )
    db.add(case)
    return case


def _manual_probe_suite(db: Session) -> TestSuite:
    suite = db.get(TestSuite, MANUAL_PROBE_SUITE_ID)
    if suite:
        return suite
    suite = TestSuite(
        id=MANUAL_PROBE_SUITE_ID,
        name="手动模型请求",
        description="从 Signature 检测页发起的单次真实模型请求记录。",
        version="manual",
        visibility="private",
    )
    db.add(suite)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.get(TestSuite, MANUAL_PROBE_SUITE_ID)
        if not existing:
            raise
        db.commit()
        db.refresh(existing)
        return existing
    db.refresh(suite)
    return suite


async def create_model_request_test(db: Session, channel: Channel, data: ModelRequestTestCreate) -> dict[str, Any]:
    prompt = data.prompt.strip()
    if not prompt:
        raise ValueError("Prompt cannot be empty")
    if not channel.enabled:
        raise ValueError("Channel is disabled")

    request_params = data.request_params or {}
    scoring_rules = _manual_probe_scoring_rules(request_params)
    case = _manual_probe_case(
        db,
        title="手动真实模型请求",
        prompt=prompt,
        system_prompt=data.system_prompt,
        request_params=request_params,
        scoring_rules=scoring_rules,
    )
    started_at = datetime.now(timezone.utc)
    run = Run(
        id=new_id("run"),
        suite_id=case.suite_id,
        name=(data.run_name or f"手动模型请求 · {channel.name}")[:200],
        mode=MANUAL_PROBE_MODE,
        test_scope="quick",
        status="running",
        repeat_count=1,
        concurrency=1,
        total_jobs=1,
        completed_jobs=0,
        started_at=started_at,
    )
    db.add(run)
    db.add(RunChannel(id=new_id("rch"), run_id=run.id, channel_id=channel.id, role_in_run=channel.role or "candidate"))
    db.commit()

    credentials = _merged_channel_credentials(channel, {})
    normalized = await invoke_channel(channel, case, 1, credentials, use_mock=False)
    result = _result_from_normalized(run.id, case, channel, 1, normalized)
    run.completed_jobs = 1
    run.finished_at = datetime.now(timezone.utc)
    run.status = "failed" if normalized.get("error") and result.score <= 0 else "completed"
    db.add(result)
    db.commit()
    db.refresh(run)
    db.refresh(result)
    return {
        "run": run,
        "result": result,
        "message_id": normalized.get("provider_message_id"),
        "message_channel_type": classify_claude_message_id(normalized.get("provider_message_id")),
        "request_id": request_id_from_normalized(normalized),
        "request_protocol": normalized.get("request_protocol"),
        "provider_endpoint": normalized.get("provider_endpoint"),
    }


def _manual_probe_scoring_rules(request_params: dict[str, Any]) -> dict[str, Any]:
    rules: dict[str, Any] = {}
    for key in [
        "expected_error_contains",
        "expected_error_any",
        "expected_error_variant_any",
        "expected_error_required_all",
        "expected_error_missing_label",
        "expected_error_variant_label",
        "expected_error_unexpected_label",
    ]:
        if key in request_params:
            rules[key] = request_params[key]
    return rules


SCHEDULED_THINKING_TEMPERATURE_PROMPT = "请用一句话回答：这是自动巡检真实模型请求探针。"
SCHEDULED_THINKING_TEMPERATURE_PARAMS: dict[str, Any] = {
    "max_tokens": 2048,
    "temperature": 0.2,
    "thinking": {"type": "enabled", "budget_tokens": 1024},
    "reasoning_effort": "medium",
    "expected_error_contains": "temperature may only be set to 1 when thinking is enabled",
    "expected_error_any": ["temperature", "thinking"],
    "expected_error_variant_any": ["temperature", "thinking"],
    "expected_error_missing_label": "thinking_temperature_not_rejected",
    "expected_error_variant_label": "provider_error_variant",
    "expected_error_unexpected_label": "unexpected_error_response",
}

SCHEDULED_WEB_SEARCH_PROMPT = "请查询今天 Anthropic 官方新闻或博客的最新更新，并给出标题、发布日期和来源链接。注意：如果当前环境没有真实联网或搜索工具，请明确说明无法实时查询，不要凭记忆编造。"
SCHEDULED_WEB_SEARCH_PARAMS: dict[str, Any] = {
    "max_tokens": 900,
    "temperature": 0,
    "stream": True,
    "tools": [
        {
            "type": "web_search_20260209",
            "name": "web_search",
            "max_uses": 5,
        },
    ],
    "expected_error_contains": "web search",
    "expected_error_any": ["web_search", "unsupported", "not available", "tool", "bedrock"],
    "expected_error_missing_label": "web_search_not_rejected",
    "expected_error_variant_label": "provider_error_variant",
}

SCHEDULED_THINKING_ADAPTIVE_PROMPT = "回复OK"
SCHEDULED_THINKING_ADAPTIVE_PARAMS: dict[str, Any] = {
    "max_tokens": 2000,
    "temperature": 0,
    "thinking": {
        "type": "enabled",
        "adaptive": {"enabled": True},
        "budget_tokens": 8000,
        "max_tokens": 2000,
    },
    "expected_error_required_all": ["enabled", "not supported", "output_config.effort"],
    "expected_error_variant_any": ["temperature may only be set to 1 when thinking is enabled", "temperature", "thinking"],
    "expected_error_missing_label": "thinking_adaptive_enabled_not_rejected",
    "expected_error_variant_label": "provider_error_variant",
    "expected_error_unexpected_label": "thinking_adaptive_enabled_wrong_error",
}

SCHEDULED_MODEL_REQUEST_PROBES: list[dict[str, Any]] = [
    {
        "key": "thinking_temperature",
        "title": "Thinking temperature 冲突",
        "prompt": SCHEDULED_THINKING_TEMPERATURE_PROMPT,
        "request_params": SCHEDULED_THINKING_TEMPERATURE_PARAMS,
    },
    {
        "key": "web_search",
        "title": "Web Search tool",
        "prompt": SCHEDULED_WEB_SEARCH_PROMPT,
        "request_params": SCHEDULED_WEB_SEARCH_PARAMS,
    },
    {
        "key": "thinking_adaptive_enabled",
        "title": "thinking.adaptive.enabled",
        "prompt": SCHEDULED_THINKING_ADAPTIVE_PROMPT,
        "request_params": SCHEDULED_THINKING_ADAPTIVE_PARAMS,
    },
]


def patrol_channel_display_name(channel: Channel | None, fallback_name: str | None = None) -> str:
    channel_id = (channel.id if channel else "") or ""
    match = re.match(r"^(.+)-tokenflow-[A-Za-z0-9-]+$", channel_id)
    display_id = match.group(1) if match else ""
    raw_channel_name = (channel.name if channel else "") or (fallback_name or "")
    account_type = ((channel.auth_config or {}).get("account_type") if channel else None) or ""

    account_type_slug = str(account_type).strip().lower().replace("_", "-")
    tokens = [part.strip() for part in raw_channel_name.split("-") if part.strip()]
    cleaned_tokens = []
    for index, token in enumerate(tokens):
        normalized = token.strip().lower().replace("_", "-")
        if index == 0 and display_id and token == display_id:
            continue
        if normalized in {"tokenflow", "relay"}:
            continue
        if account_type_slug and normalized == account_type_slug:
            continue
        if normalized == "claude" and account_type_slug and account_type_slug != "claude":
            continue
        cleaned_tokens.append(token)

    channel_name = "-".join(cleaned_tokens) or raw_channel_name
    parts = [display_id, channel_name, account_type_slug or account_type]
    formatted = "-".join(str(part).strip() for part in parts if str(part).strip())
    return formatted or (channel_name or fallback_name or channel_id or "-")


async def create_scheduled_model_request_probe(db: Session, channel: Channel, scheduled: ScheduledChannelTest) -> dict[str, Any]:
    if not channel.enabled:
        raise ValueError("Channel is disabled")

    suite = _manual_probe_suite(db)
    started_at = datetime.now(timezone.utc)
    run = Run(
        id=new_id("run"),
        suite_id=suite.id,
        name=f"{patrol_channel_display_name(channel)} - 自动巡检资源"[:200],
        mode=MANUAL_PROBE_MODE,
        test_scope="quick",
        status="running",
        repeat_count=1,
        concurrency=1,
        total_jobs=len(SCHEDULED_MODEL_REQUEST_PROBES),
        completed_jobs=0,
        started_at=started_at,
    )
    db.add(run)
    db.add(RunChannel(id=new_id("rch"), run_id=run.id, channel_id=channel.id, role_in_run=channel.role or "candidate"))
    db.commit()

    credentials = _merged_channel_credentials(channel, {})
    probe_results: list[dict[str, Any]] = []
    for index, probe in enumerate(SCHEDULED_MODEL_REQUEST_PROBES, start=1):
        request_params = dict(probe["request_params"])
        case = TestCase(
            id=new_id("case"),
            suite_id=suite.id,
            module="scheduled_probe",
            sort_order=index,
            title=str(probe["title"]),
            prompt=str(probe["prompt"]),
            system_prompt=None,
            request_params=request_params,
            scoring_rules=_manual_probe_scoring_rules(request_params),
            is_hidden=False,
            enabled=True,
        )
        db.add(case)
        db.commit()

        normalized = await invoke_channel(channel, case, 1, dict(credentials), use_mock=False)
        result = _result_from_normalized(run.id, case, channel, 1, normalized)
        run.completed_jobs += 1
        db.add(result)
        db.commit()
        db.refresh(result)
        completed_at = result.created_at or datetime.now(timezone.utc)
        probe_results.append(
            {
                "key": probe["key"],
                "title": probe["title"],
                "run_id": run.id,
                "result_id": result.id,
                "message_id": normalized.get("provider_message_id"),
                "message_channel_type": classify_claude_message_id(normalized.get("provider_message_id")),
                "request_id": request_id_from_normalized(normalized),
                "request_protocol": normalized.get("request_protocol"),
                "provider_endpoint": normalized.get("provider_endpoint"),
                "created_at": completed_at.isoformat(),
                "completed_at": completed_at.isoformat(),
                "labels": result.labels or [],
                "score": result.score,
                "error": normalized.get("error"),
            }
        )

    run.finished_at = datetime.now(timezone.utc)
    run.status = "failed" if probe_results and all(item.get("error") and (item.get("score") or 0) <= 0 for item in probe_results) else "completed"
    db.commit()
    db.refresh(run)
    primary = next((item for item in probe_results if item["key"] == "thinking_temperature"), probe_results[0] if probe_results else {})
    primary_result = db.get(Result, primary.get("result_id")) if primary.get("result_id") else None
    return {
        "run": run,
        "result": primary_result,
        "results": probe_results,
        "message_id": primary.get("message_id"),
        "message_channel_type": primary.get("message_channel_type"),
        "request_id": primary.get("request_id"),
        "request_protocol": primary.get("request_protocol"),
        "provider_endpoint": primary.get("provider_endpoint"),
        "created_at": primary.get("created_at"),
        "completed_at": primary.get("completed_at"),
        "error": primary.get("error"),
    }


async def execute_run(
    session_factory: sessionmaker[Session],
    run_id: str,
    runtime_credentials: dict[str, dict[str, Any]] | None = None,
    use_mock: bool = True,
    benchmark_config: dict[str, Any] | None = None,
    arena_config: dict[str, Any] | None = None,
) -> None:
    runtime_credentials = runtime_credentials or {}
    benchmark_config = normalize_benchmark_config(benchmark_config)
    arena_config = arena_config or {}
    active_tasks: set[asyncio.Task[tuple[TestCase, Channel, int, dict[str, Any]]]] = set()
    with session_factory() as db:
        run = db.get(Run, run_id)
        if not run:
            return

        _completed_jobs = 0

        def add_result(case: TestCase, channel: Channel, attempt: int, normalized: dict[str, Any]) -> None:
            db.add(_result_from_normalized(run.id, case, channel, attempt, normalized))

        def record_completed_jobs(count: int = 1) -> None:
            nonlocal _completed_jobs
            if count <= 0:
                return
            _completed_jobs = min(run.total_jobs or _completed_jobs + count, _completed_jobs + count)
            run.completed_jobs = _completed_jobs
            db.commit()

        async def cancel_active_tasks(tasks: set[asyncio.Task[tuple[TestCase, Channel, int, dict[str, Any]]]]) -> None:
            for pending_task in tasks:
                pending_task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

        def finish_canceled_run() -> None:
            nonlocal _completed_jobs
            run.completed_jobs = _completed_jobs
            run.status = "canceled"
            run.finished_at = datetime.now(timezone.utc)
            db.commit()

        def refresh_active_run() -> bool:
            try:
                db.refresh(run)
                return True
            except InvalidRequestError:
                db.rollback()
                return False

        try:
            if not refresh_active_run():
                return
            if run.status == "canceled":
                run.finished_at = run.finished_at or datetime.now(timezone.utc)
                db.commit()
                return
            logger.info("run_started run_id=%s mode=%s suite_id=%s total_jobs=%d concurrency=%d", run_id, run.mode, run.suite_id, run.total_jobs, run.concurrency)
            run.status = "running"
            run.started_at = datetime.now(timezone.utc)
            db.commit()

            run_channels = db.scalars(select(RunChannel).where(RunChannel.run_id == run_id)).all()
            channel_by_id = {channel.id: channel for channel in db.scalars(select(Channel)).all()}
            channels = [channel_by_id[rc.channel_id] for rc in run_channels if rc.channel_id in channel_by_id]
            cases = cases_for_scope(db, run.suite_id, run.test_scope)
            run.total_jobs = len(channels) * len(cases) * run.repeat_count
            run.completed_jobs = 0
            db.commit()

            jobs = [
                (case, channel, attempt)
                for case in cases
                for channel in _sort_channels_for_run(channels)
                for attempt in range(1, run.repeat_count + 1)
            ]
            preflight_result_keys: set[tuple[str, str, int]] = set()
            failed_preflight_channel_ids: set[str] = set()
            resolved_protocol_by_channel: dict[str, str] = {}

            if not use_mock and cases and channels:
                preflight_case = next(
                    (
                        case
                        for case in cases
                        if not (case.scoring_rules or {}).get("invalid_request_probe") and not _is_expected_error_probe_case(case)
                    ),
                    next((case for case in cases if not (case.scoring_rules or {}).get("invalid_request_probe")), cases[0]),
                )
                for channel in _sort_channels_for_run(channels):
                    if not refresh_active_run():
                        return
                    if run.status == "canceled":
                        finish_canceled_run()
                        return
                    credentials = _merged_channel_credentials(channel, runtime_credentials.get(channel.id, {}))
                    normalized = await invoke_channel(channel, preflight_case, 1, credentials, use_mock=False)
                    if normalized.get("error"):
                        failed_preflight_channel_ids.add(channel.id)
                        failed_count = 0
                        for case in cases:
                            for attempt in range(1, run.repeat_count + 1):
                                failure = channel_preflight_failure_response(channel, case, attempt, normalized)
                                add_result(case, channel, attempt, failure)
                                failed_count += 1
                        record_completed_jobs(failed_count)
                        continue
                    resolved_protocol = normalized.get("request_protocol")
                    if isinstance(resolved_protocol, str) and resolved_protocol != REQUEST_PROTOCOL_AUTO:
                        resolved_protocol_by_channel[channel.id] = resolved_protocol
                    add_result(preflight_case, channel, 1, normalized)
                    preflight_result_keys.add((preflight_case.id, channel.id, 1))
                    record_completed_jobs()

                jobs = [
                    (case, channel, attempt)
                    for case, channel, attempt in jobs
                    if channel.id not in failed_preflight_channel_ids and (case.id, channel.id, attempt) not in preflight_result_keys
                ]

            job_index = 0
            concurrency = max(1, min(run.concurrency, len(jobs) or 1))

            async def invoke_job(case: TestCase, channel: Channel, attempt: int) -> tuple[TestCase, Channel, int, dict[str, Any]]:
                credentials = _merged_channel_credentials(channel, runtime_credentials.get(channel.id, {}))
                if channel.id in resolved_protocol_by_channel:
                    credentials["request_protocol"] = resolved_protocol_by_channel[channel.id]
                normalized = await invoke_channel(channel, case, attempt, credentials, use_mock)
                return case, channel, attempt, normalized

            while job_index < len(jobs) or active_tasks:
                if not refresh_active_run():
                    await cancel_active_tasks(active_tasks)
                    return
                if run.status == "canceled":
                    await cancel_active_tasks(active_tasks)
                    finish_canceled_run()
                    return

                while job_index < len(jobs) and len(active_tasks) < concurrency:
                    case, channel, attempt = jobs[job_index]
                    job_index += 1
                    active_tasks.add(asyncio.create_task(invoke_job(case, channel, attempt)))

                if not active_tasks:
                    break

                done, active_tasks = await asyncio.wait(active_tasks, timeout=0.25, return_when=asyncio.FIRST_COMPLETED)
                if not done:
                    continue

                if not refresh_active_run():
                    await asyncio.gather(*done, return_exceptions=True)
                    await cancel_active_tasks(active_tasks)
                    return
                if run.status == "canceled":
                    await asyncio.gather(*done, return_exceptions=True)
                    await cancel_active_tasks(active_tasks)
                    finish_canceled_run()
                    return

                for task in done:
                    case, channel, attempt, normalized = await task
                    if not refresh_active_run():
                        await cancel_active_tasks(active_tasks)
                        return
                    if run.status == "canceled":
                        await cancel_active_tasks(active_tasks)
                        finish_canceled_run()
                        return
                    add_result(case, channel, attempt, normalized)
                    record_completed_jobs()
                    logger.debug("run_progress run_id=%s job=%d/%d case=%s channel=%s", run_id, _completed_jobs, run.total_jobs, case.id, channel.id)

            if not refresh_active_run():
                return
            if run.status == "canceled":
                finish_canceled_run()
                return
            run.completed_jobs = _completed_jobs
            db.commit()
            logger.info("run_post_processing run_id=%s mode=%s completed_jobs=%d", run_id, run.mode, run.completed_jobs)
            apply_repeat_consistency_scores(db, run.id)
            if run.mode == "baseline_build":
                finalize_baseline_from_run(db, run.id)
            elif run.mode in COMPARISON_RUN_MODES:
                build_comparisons(db, run.id, run.baseline_snapshot_id)
                build_reports(db, run.id)
            elif run.mode in SPECIAL_REPORT_RUN_MODES:
                build_special_run_reports(db, run.id, benchmark_config=benchmark_config, arena_config=arena_config)
            run.status = "completed"
            run.finished_at = datetime.now(timezone.utc)
            db.commit()
            logger.info("run_completed run_id=%s mode=%s completed_jobs=%d", run_id, run.mode, run.completed_jobs)
        except Exception as exc:  # keep failed runs inspectable
            await cancel_active_tasks(active_tasks)
            if not refresh_active_run():
                return
            if run.status == "canceled":
                finish_canceled_run()
                return
            run.status = "failed"
            logger.exception("run_failed run_id=%s mode=%s", run_id, run.mode)
            run.finished_at = datetime.now(timezone.utc)
            if run.mode == "baseline_build" and run.baseline_snapshot_id:
                snapshot = db.get(BaselineSnapshot, run.baseline_snapshot_id)
                if snapshot:
                    snapshot.status = "failed"
            fallback_channel_id = db.scalar(select(RunChannel.channel_id).where(RunChannel.run_id == run.id)) or "anthropic_official"
            db.add(
                Report(
                    id=new_id("rep"),
                    run_id=run.id,
                    channel_id=fallback_channel_id,
                    final_score=0,
                    grade="E",
                    summary=f"检测任务失败：{exc}",
                    evidence={"error": str(exc)},
                    markdown=f"# 检测任务失败\n\n{exc}\n",
                )
            )
            db.commit()


async def execute_scheduled_channel_test(
    session_factory: sessionmaker[Session],
    scheduled_id: str,
    *,
    advance_next_run: bool = True,
) -> Run | None:
    with session_factory() as db:
        scheduled = db.get(ScheduledChannelTest, scheduled_id)
        if not scheduled:
            return None
        if scheduled.locked_by != SCHEDULER_INSTANCE_ID or not _schedule_lock_active(scheduled):
            scheduled = claim_scheduled_test(db, scheduled_id, advance_next_run=False, force=True)
            if not scheduled:
                return None
        if scheduled and scheduled.test_scope == "scheduled_probe":
            return await execute_scheduled_probe_run(session_factory, scheduled_id, advance_next_run=advance_next_run)
    run_id: str | None = None
    max_retries = 0
    retry_interval_minutes = 5
    attempt_index = 0
    try:
        while True:
            use_mock = False
            with session_factory() as db:
                scheduled = db.get(ScheduledChannelTest, scheduled_id)
                if not scheduled:
                    return None
                validate_scheduled_channel_test(db, scheduled)
                channel = db.get(Channel, scheduled.channel_id)
                if not channel:
                    raise ValueError("Channel not found")
                max_retries = max(0, scheduled.max_retries)
                retry_interval_minutes = max(1, scheduled.retry_interval_minutes)
                use_mock = scheduled.use_mock
                run_name = f"{patrol_channel_display_name(channel)} - 资源检测 - {scheduled.name}"
                if attempt_index:
                    run_name = f"{run_name}（重试 {attempt_index}/{max_retries}）"
                run = create_run(
                    db,
                    RunCreate(
                        name=run_name,
                        suite_id=scheduled.suite_id,
                        channel_ids={"candidate": [channel.id]},
                        repeat_count=scheduled.repeat_count,
                        concurrency=scheduled.concurrency,
                        use_mock=scheduled.use_mock,
                        mode="candidate_eval",
                        test_scope=scheduled.test_scope,
                        baseline_snapshot_id=scheduled.baseline_snapshot_id,
                    ),
                )
                run_id = run.id
                run.scheduled_test_id = scheduled.id
                scheduled.last_run_id = run.id
                scheduled.last_status = "running"
                scheduled.last_error = None
                scheduled.last_started_at = datetime.now(timezone.utc)
                scheduled.locked_by = SCHEDULER_INSTANCE_ID
                scheduled.locked_until = _lock_expiry()
                if advance_next_run and attempt_index == 0:
                    scheduled.next_run_at = next_run_for_scheduled_test(scheduled)
                db.commit()
            logger.info("scheduled_run_executing scheduled_id=%s run_id=%s channel=%s", scheduled_id, run_id, channel.name)

            await execute_run(session_factory, run_id, use_mock=use_mock)

            with session_factory() as db:
                scheduled = db.get(ScheduledChannelTest, scheduled_id)
                run = db.get(Run, run_id)
                if not scheduled or not run:
                    return run
                if run.status == "completed":
                    release_scheduled_test_lock(db, scheduled, status=run.status, error=None)
                    await attach_signature_interop_to_scheduled_run(session_factory, run.id, scheduled.id)
                    await create_alerts_for_run(session_factory, run.id, scheduled.id)
                    return run
                if run.status != "failed" or attempt_index >= max_retries:
                    release_scheduled_test_lock(db, scheduled, status=run.status, error=f"Run finished with status {run.status}")
                    if run.status == "failed":
                        await create_alerts_for_run(session_factory, run.id, scheduled.id)
                    return run
                attempt_index += 1
                scheduled.last_status = "queued"
                scheduled.last_error = f"Run finished with status {run.status}; retry {attempt_index}/{max_retries} queued"
                scheduled.locked_by = SCHEDULER_INSTANCE_ID
                logger.warning("scheduled_run_retry scheduled_id=%s run_id=%s attempt=%d/%d status=%s", scheduled_id, run_id, attempt_index, max_retries, run.status)
                scheduled.locked_until = _lock_expiry()
                db.commit()
            await asyncio.sleep(max(1, retry_interval_minutes) * 60)
    except Exception as exc:
        with session_factory() as db:
            scheduled = db.get(ScheduledChannelTest, scheduled_id)
            if scheduled:
                if advance_next_run:
                    scheduled.next_run_at = next_run_for_scheduled_test(scheduled)
                release_scheduled_test_lock(db, scheduled, status="failed", error=str(exc))
                logger.exception("scheduled_test_failed scheduled_id=%s run_id=%s", scheduled_id, run_id)
        return None


async def attach_signature_interop_to_scheduled_run(
    session_factory: sessionmaker[Session],
    run_id: str,
    scheduled_id: str,
) -> dict[str, Any] | None:
    source_id: str | None = None
    relay_id: str | None = None
    with session_factory() as db:
        scheduled = db.get(ScheduledChannelTest, scheduled_id)
        run = db.get(Run, run_id)
        if not scheduled or not run:
            return None
        source = _signature_source_for_scheduled_test(db, scheduled)
        relay = db.get(Channel, scheduled.channel_id)
        if not source or not relay:
            missing_result = {
                "ok": False,
                "status": "fail",
                "reason": "未找到可用的参考 source 渠道，无法执行 Thinking Signature 互通检测",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "source_channel_id": source.id if source else None,
                "source_channel_name": source.name if source else None,
                "relay_channel_id": relay.id if relay else scheduled.channel_id,
                "relay_channel_name": relay.name if relay else None,
                "fallback_note": SIGNATURE_FALLBACK_NOTE,
                "labels": ["signature_source_missing"],
                "steps": [
                    {
                        "name": "自动巡检 Signature 互通检测",
                        "status": "fail",
                        "detail": "缺少启用状态的参考 source 渠道",
                        "excerpt": None,
                    }
                ],
            }
            if relay:
                _attach_signature_interop_result_to_reports(db, run_id, relay.id, missing_result)
            return missing_result
        if scheduled.use_mock:
            skipped_result = {
                "ok": True,
                "status": "skipped",
                "reason": "mock 巡检未发起 Thinking Signature 互通检测",
                "source_channel_id": source.id,
                "source_channel_name": source.name,
                "relay_channel_id": relay.id,
                "relay_channel_name": relay.name,
                "fallback_note": SIGNATURE_FALLBACK_NOTE,
                "steps": [
                    {
                        "name": "自动巡检 Signature 互通检测",
                        "status": "skipped",
                        "detail": "mock 巡检不会调用真实渠道",
                        "excerpt": None,
                    }
                ],
            }
            _attach_signature_interop_result_to_reports(db, run_id, relay.id, skipped_result)
            return skipped_result
        source_id = source.id
        relay_id = relay.id

    try:
        signature_started_at = datetime.now(timezone.utc).isoformat()
        with session_factory() as db:
            source = db.get(Channel, source_id) if source_id else None
            relay = db.get(Channel, relay_id) if relay_id else None
            if not source or not relay:
                return None
        signature_result = await test_signature_interop(source, relay)
        signature_result.setdefault("created_at", signature_started_at)
        signature_result.setdefault("completed_at", datetime.now(timezone.utc).isoformat())
    except Exception as exc:
        signature_result = {
            "ok": False,
            "status": "fail",
            "reason": str(exc),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "source_channel_id": source_id,
            "relay_channel_id": relay_id,
            "fallback_note": SIGNATURE_FALLBACK_NOTE,
            "steps": [
                {
                    "name": "自动巡检 Signature 互通检测",
                    "status": "fail",
                    "detail": str(exc),
                    "excerpt": None,
                }
            ],
        }

    with session_factory() as db:
        if relay_id:
            _attach_signature_interop_result_to_reports(db, run_id, relay_id, signature_result)
    return signature_result


def _attach_signature_interop_result_to_reports(
    db: Session,
    run_id: str,
    relay_channel_id: str,
    signature_result: dict[str, Any],
) -> None:
    reports = db.scalars(select(Report).where(Report.run_id == run_id, Report.channel_id == relay_channel_id)).all()
    for report in reports:
        evidence = dict(report.evidence or {})
        labels = sorted({str(label) for label in evidence.get("labels", []) if isinstance(label, str)})
        labels = sorted(set(labels).union(str(label) for label in signature_result.get("labels", []) if isinstance(label, str)))
        if signature_result.get("status") != "skipped" and not signature_result.get("ok") and "signature_interop_failed" not in labels:
            labels.append("signature_interop_failed")
        evidence["labels"] = sorted(labels)
        evidence["red_flags"] = sorted(set(labels).intersection(ALERT_RED_FLAGS))
        evidence["label_explanations"] = label_explanations(sorted(labels))
        evidence["signature_interop"] = _signature_interop_report_evidence(signature_result)
        report.evidence = evidence
        if signature_result.get("status") != "skipped" and not signature_result.get("ok"):
            report.grade = worse_grade(report.grade, "D")
            report.summary = f"{report.summary or _summary_for(report.grade)} Signature 互通检测未通过。"
        channel = db.get(Channel, report.channel_id)
        if channel:
            report.markdown = report_markdown(channel, report.final_score, report.grade, report.summary or _summary_for(report.grade), evidence)
    db.commit()


def _signature_source_for_scheduled_test(db: Session, scheduled: ScheduledChannelTest) -> Channel | None:
    snapshot = db.get(BaselineSnapshot, scheduled.baseline_snapshot_id)
    for channel_id in snapshot.channel_ids or [] if snapshot else []:
        channel = db.get(Channel, channel_id)
        if channel and channel.enabled:
            return channel
    return db.scalar(select(Channel).where(Channel.is_reference.is_(True), Channel.enabled.is_(True)).limit(1))


def _signature_interop_report_evidence(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": bool(result.get("ok")),
        "status": result.get("status"),
        "reason": result.get("reason"),
        "created_at": result.get("created_at"),
        "completed_at": result.get("completed_at"),
        "source_channel_id": result.get("source_channel_id"),
        "source_channel_name": result.get("source_channel_name"),
        "source_channel_provider_type": result.get("source_channel_provider_type"),
        "source_channel_account_type": result.get("source_channel_account_type"),
        "relay_channel_id": result.get("relay_channel_id"),
        "relay_channel_name": result.get("relay_channel_name"),
        "relay_channel_provider_type": result.get("relay_channel_provider_type"),
        "relay_channel_account_type": result.get("relay_channel_account_type"),
        "source_message_id": result.get("source_message_id"),
        "source_message_channel_type": result.get("source_message_channel_type"),
        "source_request_id": result.get("source_request_id"),
        "relay_message_id": result.get("relay_message_id"),
        "relay_message_channel_type": result.get("relay_message_channel_type"),
        "relay_request_id": result.get("relay_request_id"),
        "thinking_block_count": result.get("thinking_block_count"),
        "signature_prefixes": result.get("signature_prefixes") or [],
        "fallback_note": result.get("fallback_note") or SIGNATURE_FALLBACK_NOTE,
        "steps": result.get("steps") or [],
    }


def _hydrate_signature_channel_names(db: Session, signature: dict[str, Any]) -> dict[str, Any]:
    source_id = signature.get("source_channel_id")
    relay_id = signature.get("relay_channel_id")
    if source_id and not signature.get("source_channel_name"):
        source = db.get(Channel, source_id)
        signature["source_channel_name"] = source.name if source else None
    if relay_id and not signature.get("relay_channel_name"):
        relay = db.get(Channel, relay_id)
        signature["relay_channel_name"] = relay.name if relay else None
    return signature


async def execute_scheduled_probe_run(
    session_factory: sessionmaker[Session],
    scheduled_id: str,
    *,
    advance_next_run: bool = True,
) -> Run | None:
    with session_factory() as db:
        scheduled = db.get(ScheduledChannelTest, scheduled_id)
        if not scheduled:
            return None
        if scheduled.locked_by != SCHEDULER_INSTANCE_ID or not _schedule_lock_active(scheduled):
            scheduled = claim_scheduled_test(db, scheduled_id, advance_next_run=False, force=True)
            if not scheduled:
                return None
        validate_scheduled_channel_test(db, scheduled)
        channel = db.get(Channel, scheduled.channel_id)
        if not channel:
            raise ValueError("Channel not found")
        if advance_next_run:
            scheduled.next_run_at = next_run_for_scheduled_test(scheduled)
        scheduled.last_status = "running"
        scheduled.last_error = None
        scheduled.last_started_at = datetime.now(timezone.utc)
        scheduled.locked_by = SCHEDULER_INSTANCE_ID
        scheduled.locked_until = _lock_expiry()
        db.commit()

    model_payload: dict[str, Any] | None = None
    signature_result: dict[str, Any] | None = None
    run: Run | None = None
    result: Result | None = None
    try:
        with session_factory() as db:
            scheduled = db.get(ScheduledChannelTest, scheduled_id)
            channel = db.get(Channel, scheduled.channel_id) if scheduled else None
            if not scheduled or not channel:
                return None
            model_payload = await create_scheduled_model_request_probe(db, channel, scheduled)
            run = model_payload["run"]
            result = model_payload["result"]
            run.scheduled_test_id = scheduled.id
            scheduled.last_run_id = run.id
            db.commit()

        with session_factory() as db:
            scheduled = db.get(ScheduledChannelTest, scheduled_id)
            run = db.get(Run, run.id) if run else None
            if not scheduled or not run:
                return run
            signature_result = await attach_signature_interop_to_scheduled_run(session_factory, run.id, scheduled.id)
            report = build_scheduled_probe_report(db, scheduled, run.id, model_payload, signature_result)
            release_scheduled_test_lock(db, scheduled, status="completed", error=None)
            db.refresh(run)

        await create_alerts_for_run(session_factory, run.id if run else "", scheduled_id)
        return run
    except Exception as exc:
        with session_factory() as db:
            scheduled = db.get(ScheduledChannelTest, scheduled_id)
            if scheduled:
                if advance_next_run:
                    scheduled.next_run_at = next_run_for_scheduled_test(scheduled)
                release_scheduled_test_lock(db, scheduled, status="failed", error=str(exc))
        return None


def build_scheduled_probe_report(
    db: Session,
    scheduled: ScheduledChannelTest,
    run_id: str,
    model_payload: dict[str, Any] | None,
    signature_result: dict[str, Any] | None,
) -> Report:
    channel = db.get(Channel, scheduled.channel_id)
    result = model_payload.get("result") if model_payload else None
    model_requests = _scheduled_model_request_evidence(model_payload)
    for item in model_requests:
        item["channel_id"] = channel.id if channel else scheduled.channel_id
        item["channel_name"] = channel.name if channel else None
        item["channel_provider_type"] = channel.provider_type if channel else None
        item["channel_account_type"] = (channel.auth_config or {}).get("account_type") if channel else None
    labels = {label for item in model_requests for label in item.get("labels", []) if isinstance(label, str)}
    if isinstance(result, Result):
        labels.update(result.labels or [])
    signature_evidence = _signature_interop_report_evidence(signature_result or {})
    _hydrate_signature_channel_names(db, signature_evidence)
    labels.update(label for label in (signature_result or {}).get("labels", []) if isinstance(label, str))
    if signature_result and signature_result.get("status") != "skipped" and not signature_result.get("ok"):
        labels.add("signature_interop_failed")
    probe_scores = [item.get("score") for item in model_requests if isinstance(item.get("score"), (int, float))]
    score = min(probe_scores) if probe_scores else (result.score if isinstance(result, Result) else 0)
    if labels.intersection({"thinking_temperature_not_rejected", "web_search_not_rejected", "thinking_adaptive_enabled_not_rejected", "unexpected_error_response", "thinking_adaptive_enabled_wrong_error"}):
        score = min(score, 40)
    if "signature_interop_failed" in labels:
        score = min(score, 60)
    if not labels and len(model_requests) == len(SCHEDULED_MODEL_REQUEST_PROBES) and score >= 90 and signature_result and signature_result.get("ok"):
        labels.add("patrol_probe_passed")
    grade = capped_grade_from_score(score, sorted(labels))
    provider_hint = scheduled_provider_hint(model_payload, signature_evidence, sorted(labels))
    primary_request = next((item for item in model_requests if item.get("key") == "thinking_temperature"), model_requests[0] if model_requests else {})
    evidence = {
        "labels": sorted(labels),
        "red_flags": sorted(labels.intersection(ALERT_RED_FLAGS)),
        "label_explanations": label_explanations(sorted(labels)),
        "model_request": primary_request,
        "model_requests": model_requests,
        "signature_interop": signature_evidence,
        "detected_provider_hint": provider_hint,
        "test_scope": "scheduled_probe",
    }
    summary = f"自动巡检完成：{provider_hint}。"
    existing = db.scalar(select(Report).where(Report.run_id == run_id, Report.channel_id == scheduled.channel_id))
    if existing:
        report = existing
        report.final_score = round(score, 2)
        report.grade = grade
        report.summary = summary
        report.evidence = evidence
        report.markdown = scheduled_probe_markdown(channel, score, grade, summary, evidence) if channel else summary
    else:
        report = Report(
            id=new_id("rep"),
            run_id=run_id,
            channel_id=scheduled.channel_id,
            final_score=round(score, 2),
            grade=grade,
            summary=summary,
            evidence=evidence,
            markdown=scheduled_probe_markdown(channel, score, grade, summary, evidence) if channel else summary,
        )
        db.add(report)
    db.commit()
    db.refresh(report)
    return report


def _scheduled_model_request_evidence(model_payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not model_payload:
        return []
    channel = model_payload.get("channel") if isinstance(model_payload.get("channel"), Channel) else None
    results = model_payload.get("results")
    if isinstance(results, list):
        return [
            {
                "key": str(item.get("key") or "unknown"),
                "title": item.get("title") or item.get("key") or "真实模型请求",
                "run_id": item.get("run_id") or (model_payload.get("run").id if model_payload.get("run") else None),
                "channel_id": item.get("channel_id"),
                "channel_name": item.get("channel_name"),
                "channel_provider_type": item.get("channel_provider_type"),
                "channel_account_type": item.get("channel_account_type"),
                "result_id": item.get("result_id"),
                "message_id": item.get("message_id"),
                "message_channel_type": item.get("message_channel_type"),
                "request_id": item.get("request_id"),
                "request_protocol": item.get("request_protocol"),
                "provider_endpoint": item.get("provider_endpoint"),
                "created_at": item.get("created_at"),
                "completed_at": item.get("completed_at"),
                "labels": item.get("labels") if isinstance(item.get("labels"), list) else [],
                "score": item.get("score"),
                "error": item.get("error"),
            }
            for item in results
            if isinstance(item, dict)
        ]

    result = model_payload.get("result")
    return [
        {
            "key": "thinking_temperature",
            "title": "Thinking temperature 冲突",
            "run_id": model_payload.get("run").id if model_payload.get("run") else None,
            "channel_id": model_payload.get("channel_id"),
            "channel_name": model_payload.get("channel_name"),
            "channel_provider_type": model_payload.get("channel_provider_type") or (channel.provider_type if channel else None),
            "channel_account_type": model_payload.get("channel_account_type") or ((channel.auth_config or {}).get("account_type") if channel else None),
            "result_id": result.id if isinstance(result, Result) else None,
            "message_id": model_payload.get("message_id"),
            "message_channel_type": model_payload.get("message_channel_type"),
            "request_id": model_payload.get("request_id"),
            "request_protocol": model_payload.get("request_protocol"),
            "provider_endpoint": model_payload.get("provider_endpoint"),
            "created_at": model_payload.get("created_at") or (result.created_at.isoformat() if isinstance(result, Result) and result.created_at else None),
            "completed_at": model_payload.get("completed_at") or (result.created_at.isoformat() if isinstance(result, Result) and result.created_at else None),
            "labels": (result.labels or []) if isinstance(result, Result) else [],
            "score": result.score if isinstance(result, Result) else None,
            "error": model_payload.get("error"),
        }
    ]


def scheduled_probe_markdown(channel: Channel, score: float, grade: str, summary: str, evidence: dict[str, Any]) -> str:
    labels = ", ".join(evidence.get("labels") or []) or "未发现显著异常"
    model_requests = evidence.get("model_requests") if isinstance(evidence.get("model_requests"), list) else []
    if not model_requests and isinstance(evidence.get("model_request"), dict):
        model_requests = [evidence["model_request"]]
    model_rows = "\n".join(
        f"| {item.get('title') or item.get('key') or '-'} | {item.get('channel_name') or '-'} ({item.get('channel_id') or '-'}) | {_probe_status_text(item)} | {item.get('completed_at') or item.get('created_at') or '-'} | {item.get('message_id') or '-'} | {item.get('request_id') or '-'} | {item.get('request_protocol') or '-'} | {item.get('provider_endpoint') or '-'} | {', '.join(item.get('labels') or []) or '-'} | {item.get('error') or '-'} |"
        for item in model_requests
        if isinstance(item, dict)
    ) or "| - | - | - | - | - | - | - | - | - | - |"
    signature = evidence.get("signature_interop") or {}
    signature_time = signature.get("completed_at") or signature.get("created_at") or evidence.get("completed_at") or "-"
    return f"""# {channel.name} - 自动巡检资源报告

## 基本信息

- 渠道：{channel.name}
- 渠道 ID：{channel.id}
- 声称模型：{channel.model_name or "未配置"}
- 评级：{grade}
- 总分：{score:.1f} / 100
- 结论：{summary}
- 异常标签：{labels}

## 真实模型请求

| 参数探针 | 渠道 | 状态 | 时间 | Message ID | Request ID | 请求协议 | Provider endpoint | 标签 | 错误 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
{model_rows}

## Thinking Signature 互通

- 状态：{signature.get("status") or "-"}
- 检测时间：{signature_time}
- Source 渠道：{signature.get("source_channel_name") or "-"} ({signature.get("source_channel_id") or "-"})
- 来源 message id：{signature.get("source_message_id") or "-"}
- 来源 request id：{signature.get("source_request_id") or "-"}
- 来源渠道类型：{signature.get("source_message_channel_type") or "-"}
- Relay 渠道：{signature.get("relay_channel_name") or "-"} ({signature.get("relay_channel_id") or "-"})
- Relay message id：{signature.get("relay_message_id") or "-"}
- Relay request id：{signature.get("relay_request_id") or "-"}
- Relay 渠道类型：{signature.get("relay_message_channel_type") or "-"}
- Signature 前缀：{", ".join(signature.get("signature_prefixes") or []) or "-"}
- 判定：{signature.get("reason") or "-"}
"""


def _probe_status_text(item: dict[str, Any]) -> str:
    if item.get("error"):
        return "请求错误"
    labels = item.get("labels") if isinstance(item.get("labels"), list) else []
    return "异常" if labels else "正常"


def scheduled_provider_hint(model_payload: dict[str, Any] | None, signature_evidence: dict[str, Any], labels: list[str]) -> str:
    types = [
        " ".join(str(item.get("message_channel_type") or "") for item in _scheduled_model_request_evidence(model_payload)),
        str(signature_evidence.get("source_message_channel_type") or ""),
        str(signature_evidence.get("relay_message_channel_type") or ""),
    ]
    joined = " ".join(types).lower()
    if "bedrock" in joined or "aws" in joined:
        return "疑似 AWS/Bedrock"
    if "vertex" in joined:
        return "疑似 Vertex"
    if "claude" in joined or "anthropic" in joined:
        return "疑似 Claude/Anthropic"
    if "thinking_temperature_not_rejected" in labels or "signature_interop_failed" in labels:
        return "疑似逆向或中间层改写"
    return "来源特征不明确"


def alert_evidence_summary(db: Session, alert: ChannelAlert) -> dict[str, Any] | None:
    report = db.get(Report, alert.report_id)
    if not report:
        return None
    channel = db.get(Channel, alert.channel_id)
    run = db.get(Run, alert.run_id)
    evidence = report.evidence or {}
    model_request = evidence.get("model_request") if isinstance(evidence.get("model_request"), dict) else {}
    model_requests = evidence.get("model_requests") if isinstance(evidence.get("model_requests"), list) else []
    signature = evidence.get("signature_interop") if isinstance(evidence.get("signature_interop"), dict) else {}
    labels = report_labels(report)
    label_descriptions = [
        item["description"]
        for item in label_explanations(labels)
        if isinstance(item, dict) and item.get("description")
    ]
    error_message = alert_error_message(evidence, labels, alert.message)
    return {
        "run_id": alert.run_id,
        "run_name": run.name if run else None,
        "report_id": alert.report_id,
        "channel_id": alert.channel_id,
        "channel_name": channel.name if channel else alert.channel_id,
        "channel_provider_type": channel.provider_type if channel else None,
        "channel_account_type": (channel.auth_config or {}).get("account_type") if channel else None,
        "channel_model_name": channel.model_name if channel else None,
        "error_message": error_message,
        "model_request_result_id": model_request.get("result_id"),
        "model_request_message_id": model_request.get("message_id"),
        "model_request_request_id": model_request.get("request_id"),
        "model_request_channel_type": model_request.get("message_channel_type"),
        "model_request_channel_provider_type": model_request.get("channel_provider_type"),
        "model_request_channel_account_type": model_request.get("channel_account_type"),
        "model_requests": model_requests,
        "request_protocol": model_request.get("request_protocol"),
        "provider_endpoint": model_request.get("provider_endpoint"),
        "signature_reason": signature.get("reason"),
        "signature_source_message_id": signature.get("source_message_id"),
        "signature_source_request_id": signature.get("source_request_id"),
        "signature_source_channel_type": signature.get("source_message_channel_type"),
        "signature_source_channel_provider_type": signature.get("source_channel_provider_type"),
        "signature_source_channel_account_type": signature.get("source_channel_account_type"),
        "signature_relay_message_id": signature.get("relay_message_id"),
        "signature_relay_request_id": signature.get("relay_request_id"),
        "signature_relay_channel_type": signature.get("relay_message_channel_type"),
        "signature_relay_channel_provider_type": signature.get("relay_channel_provider_type"),
        "signature_relay_channel_account_type": signature.get("relay_channel_account_type"),
        "label_explanations": label_descriptions,
        "detected_provider_hint": evidence.get("detected_provider_hint"),
    }


def list_channel_alerts(
    db: Session,
    *,
    status: str | None = None,
    channel_id: str | None = None,
    id_query: str | None = None,
    created_from: datetime | None = None,
    created_to: datetime | None = None,
) -> list[ChannelAlert]:
    stmt = select(ChannelAlert).order_by(ChannelAlert.created_at.desc())
    if status:
        stmt = stmt.where(ChannelAlert.status == status)
    if channel_id:
        stmt = stmt.where(ChannelAlert.channel_id == channel_id)
    if created_from:
        stmt = stmt.where(ChannelAlert.created_at >= _as_utc(created_from).replace(tzinfo=None))
    if created_to:
        stmt = stmt.where(ChannelAlert.created_at <= _as_utc(created_to).replace(tzinfo=None))
    alerts = list(db.scalars(stmt).all())
    query = (id_query or "").strip()
    if not query:
        return alerts
    return [alert for alert in alerts if channel_alert_matches_id_query(db, alert, query)]


def channel_alert_matches_id_query(db: Session, alert: ChannelAlert, query: str) -> bool:
    normalized_query = query.strip().lower()
    if not normalized_query:
        return True
    direct_values = [alert.id, alert.run_id, alert.report_id, alert.channel_id, alert.scheduled_test_id]
    if any(_value_contains_query(value, normalized_query) for value in direct_values):
        return True

    report = db.get(Report, alert.report_id)
    evidence = report.evidence if report and isinstance(report.evidence, dict) else {}
    if _json_contains_query(evidence, normalized_query):
        return True

    result_ids = _alert_evidence_result_ids(evidence)
    results: list[Result] = []
    if result_ids:
        results.extend(db.scalars(select(Result).where(Result.id.in_(result_ids))).all())
    if not results and alert.run_id:
        results.extend(db.scalars(select(Result).where(Result.run_id == alert.run_id)).all())
    for result in results:
        if _value_contains_query(result.id, normalized_query):
            return True
        if _json_contains_query(result.raw_request, normalized_query):
            return True
        if _json_contains_query(result.raw_response, normalized_query):
            return True
        if _json_contains_query(result.normalized_response, normalized_query):
            return True
        if _json_contains_query(result.metrics, normalized_query):
            return True
    return False


def _alert_evidence_result_ids(evidence: dict[str, Any]) -> set[str]:
    result_ids: set[str] = set()
    model_request = evidence.get("model_request") if isinstance(evidence.get("model_request"), dict) else {}
    model_requests = evidence.get("model_requests") if isinstance(evidence.get("model_requests"), list) else []
    for item in [model_request, *[entry for entry in model_requests if isinstance(entry, dict)]]:
        result_id = item.get("result_id")
        if result_id:
            result_ids.add(str(result_id))
    return result_ids


def _value_contains_query(value: Any, normalized_query: str) -> bool:
    if value is None:
        return False
    return normalized_query in str(value).lower()


def _json_contains_query(value: Any, normalized_query: str) -> bool:
    if value is None:
        return False
    if isinstance(value, dict):
        return any(
            _value_contains_query(key, normalized_query) or _json_contains_query(child, normalized_query)
            for key, child in value.items()
        )
    if isinstance(value, list):
        return any(_json_contains_query(item, normalized_query) for item in value)
    return _value_contains_query(value, normalized_query)


def alert_error_message(evidence: dict[str, Any], labels: list[str] | None = None, fallback: str | None = None) -> str:
    model_request = evidence.get("model_request") if isinstance(evidence.get("model_request"), dict) else {}
    model_requests = evidence.get("model_requests") if isinstance(evidence.get("model_requests"), list) else []
    for item in [model_request, *[entry for entry in model_requests if isinstance(entry, dict)]]:
        error = item.get("error")
        if error:
            title = item.get("title") or item.get("key")
            return f"{title}：{error}" if title else str(error)
    signature = evidence.get("signature_interop") if isinstance(evidence.get("signature_interop"), dict) else {}
    if signature.get("status") == "fail" or signature.get("reason"):
        return str(signature.get("reason") or "Thinking Signature 互通检测未通过")
    descriptions = [
        item["description"]
        for item in label_explanations(labels or [])
        if isinstance(item, dict) and item.get("description")
    ]
    if descriptions:
        return "；".join(descriptions[:2])
    if fallback:
        return scoreless_alert_message(fallback)
    return "渠道自动巡检异常"


def scoreless_alert_message(value: str | None) -> str:
    text = (value or "").strip()
    if not text:
        return "渠道自动巡检异常"
    text = re.sub(r"：评级\s*[A-E]，得分\s*\d+(?:\.\d+)?", "：自动巡检异常", text)
    text = re.sub(r"评级\s*[A-E][，,]?\s*", "", text)
    text = re.sub(r"得分\s*\d+(?:\.\d+)?", "", text)
    text = re.sub(r"\s+", " ", text).strip(" ，,")
    return text or "渠道自动巡检异常"


def scheduled_test_probe_summary(db: Session, scheduled: ScheduledChannelTest) -> dict[str, Any]:
    if not scheduled.last_run_id:
        return empty_scheduled_probe_summary()
    report = db.scalar(
        select(Report)
        .where(Report.run_id == scheduled.last_run_id, Report.channel_id == scheduled.channel_id)
        .order_by(Report.created_at.desc())
    )
    if not report:
        return empty_scheduled_probe_summary()
    evidence = report.evidence if isinstance(report.evidence, dict) else {}
    model_request = evidence.get("model_request") if isinstance(evidence.get("model_request"), dict) else {}
    model_requests = evidence.get("model_requests") if isinstance(evidence.get("model_requests"), list) else []
    if not model_requests and model_request:
        model_requests = [model_request]
    signature = evidence.get("signature_interop") if isinstance(evidence.get("signature_interop"), dict) else {}
    _hydrate_signature_channel_names(db, signature)
    channel = db.get(Channel, scheduled.channel_id)
    model_channel_id = channel.id if channel else scheduled.channel_id
    model_channel_name = channel.name if channel else None
    labels = evidence.get("labels") if isinstance(evidence.get("labels"), list) else []
    label_explanations = evidence.get("label_explanations") if isinstance(evidence.get("label_explanations"), list) else []
    return {
        "latest_report_id": report.id,
        "latest_grade": report.grade,
        "latest_score": report.final_score,
        "latest_probe_summary": {
            "model_request": {
                "status": _probe_summary_status(model_request),
                "channel_id": model_request.get("channel_id") or model_channel_id,
                "channel_name": model_request.get("channel_name") or model_channel_name,
                "result_id": model_request.get("result_id"),
                "message_id": model_request.get("message_id"),
                "message_channel_type": model_request.get("message_channel_type"),
                "request_id": model_request.get("request_id"),
                "request_protocol": model_request.get("request_protocol"),
                "provider_endpoint": model_request.get("provider_endpoint"),
                "created_at": model_request.get("created_at"),
                "completed_at": model_request.get("completed_at"),
                "error": model_request.get("error"),
            },
            "model_requests": [
                {
                    "key": item.get("key"),
                    "title": item.get("title"),
                    "status": _probe_summary_status(item),
                    "channel_id": item.get("channel_id") or model_channel_id,
                    "channel_name": item.get("channel_name") or model_channel_name,
                    "result_id": item.get("result_id"),
                    "message_id": item.get("message_id"),
                    "message_channel_type": item.get("message_channel_type"),
                    "request_id": item.get("request_id"),
                    "request_protocol": item.get("request_protocol"),
                    "provider_endpoint": item.get("provider_endpoint"),
                    "created_at": item.get("created_at"),
                    "completed_at": item.get("completed_at"),
                    "labels": item.get("labels") if isinstance(item.get("labels"), list) else [],
                    "score": item.get("score"),
                    "error": item.get("error"),
                }
                for item in model_requests
                if isinstance(item, dict)
            ],
            "signature_interop": {
                "status": signature.get("status"),
                "reason": signature.get("reason"),
                "source_channel_id": signature.get("source_channel_id"),
                "source_channel_name": signature.get("source_channel_name"),
                "source_channel_provider_type": signature.get("source_channel_provider_type"),
                "source_channel_account_type": signature.get("source_channel_account_type"),
                "relay_channel_id": signature.get("relay_channel_id"),
                "relay_channel_name": signature.get("relay_channel_name"),
                "relay_channel_provider_type": signature.get("relay_channel_provider_type"),
                "relay_channel_account_type": signature.get("relay_channel_account_type"),
                "source_message_id": signature.get("source_message_id"),
                "source_message_channel_type": signature.get("source_message_channel_type"),
                "source_request_id": signature.get("source_request_id"),
                "relay_message_id": signature.get("relay_message_id"),
                "relay_message_channel_type": signature.get("relay_message_channel_type"),
                "relay_request_id": signature.get("relay_request_id"),
                "signature_prefixes": signature.get("signature_prefixes") or [],
            },
            "labels": labels,
            "label_explanations": label_explanations,
            "detected_provider_hint": evidence.get("detected_provider_hint"),
        },
    }


def _probe_summary_status(item: dict[str, Any]) -> str:
    if item.get("error"):
        return "error"
    labels = item.get("labels") if isinstance(item.get("labels"), list) else []
    return "error" if labels else "ok"


def empty_scheduled_probe_summary() -> dict[str, Any]:
    return {
        "latest_report_id": None,
        "latest_grade": None,
        "latest_score": None,
        "latest_probe_summary": None,
    }


def scheduled_channel_test_read(db: Session, scheduled: ScheduledChannelTest) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    try:
        is_stale = bool(
            scheduled.last_status in {"queued", "running"}
            and scheduled.locked_until
            and _as_utc(scheduled.locked_until) <= now
        )
    except Exception:
        logger.warning("scheduled_channel_test_read: invalid locked_until schedule_id=%s", scheduled.id, exc_info=True)
        is_stale = False
    try:
        probe_summary = scheduled_test_probe_summary(db, scheduled)
    except Exception:
        db.rollback()
        logger.warning("scheduled_channel_test_read: probe summary failed schedule_id=%s", scheduled.id, exc_info=True)
        probe_summary = empty_scheduled_probe_summary()
    return {
        "id": scheduled.id,
        "name": scheduled.name,
        "channel_id": scheduled.channel_id,
        "suite_id": scheduled.suite_id,
        "baseline_snapshot_id": scheduled.baseline_snapshot_id,
        "enabled": scheduled.enabled,
        "interval_minutes": scheduled.interval_minutes,
        "run_window_start": scheduled.run_window_start,
        "run_window_end": scheduled.run_window_end,
        "test_scope": scheduled.test_scope,
        "repeat_count": scheduled.repeat_count,
        "concurrency": scheduled.concurrency,
        "use_mock": scheduled.use_mock,
        "alert_grade_threshold": scheduled.alert_grade_threshold,
        "alert_score_threshold": scheduled.alert_score_threshold,
        "alert_red_flags_enabled": scheduled.alert_red_flags_enabled,
        "quiet_minutes": scheduled.quiet_minutes,
        "max_retries": scheduled.max_retries,
        "retry_interval_minutes": scheduled.retry_interval_minutes,
        "locked_by": scheduled.locked_by,
        "locked_until": scheduled.locked_until,
        "last_queued_at": scheduled.last_queued_at,
        "last_started_at": scheduled.last_started_at,
        "last_finished_at": scheduled.last_finished_at,
        "is_stale": is_stale,
        "next_run_at": scheduled.next_run_at,
        "last_run_id": scheduled.last_run_id,
        "last_status": scheduled.last_status,
        "last_error": scheduled.last_error,
        "created_at": scheduled.created_at,
        "updated_at": scheduled.updated_at,
        **probe_summary,
    }


def channel_alert_read(db: Session, alert: ChannelAlert) -> dict[str, Any]:
    evidence_summary: dict[str, Any] | None = None
    try:
        evidence_summary = alert_evidence_summary(db, alert)
    except Exception:
        logger.warning("Failed to build alert evidence summary for %s", alert.id, exc_info=True)
        db.rollback()
    return {
        "id": alert.id,
        "scheduled_test_id": alert.scheduled_test_id,
        "run_id": alert.run_id,
        "report_id": alert.report_id,
        "channel_id": alert.channel_id,
        "status": alert.status or "pending_review",
        "severity": alert.severity or "high",
        "grade": alert.grade or "E",
        "final_score": _safe_float(alert.final_score),
        "trigger_labels": _safe_string_list(alert.trigger_labels),
        "message": alert.message,
        "dedupe_key": alert.dedupe_key,
        "notification_status": alert.notification_status or "pending",
        "notification_error": alert.notification_error,
        "notification_attempt_count": int(alert.notification_attempt_count or 0),
        "last_notification_attempt_at": alert.last_notification_attempt_at,
        "evidence_summary": _json_safe_value(evidence_summary) if evidence_summary is not None else None,
        "notified_at": alert.notified_at,
        "reviewer_name": alert.reviewer_name,
        "review_note": alert.review_note,
        "reviewed_at": alert.reviewed_at,
        "created_at": alert.created_at,
        "updated_at": alert.updated_at,
    }


def _safe_string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if item is not None]
    if value is None:
        return []
    return [str(value)]


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _json_safe_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_safe_value(child) for key, child in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe_value(item) for item in value]
    return str(value)


async def create_alerts_for_run(session_factory: sessionmaker[Session], run_id: str, scheduled_id: str | None = None) -> list[ChannelAlert]:
    alerts: list[ChannelAlert] = []
    with session_factory() as db:
        scheduled = db.get(ScheduledChannelTest, scheduled_id) if scheduled_id else None
        reports = db.scalars(select(Report).where(Report.run_id == run_id)).all()
        for report in reports:
            labels = report_labels(report)
            if not report_needs_alert(report, labels, scheduled):
                continue
            dedupe_key = alert_dedupe_key(report, labels, scheduled)
            if scheduled and _recent_open_alert_exists(db, scheduled, report.channel_id, dedupe_key):
                continue
            existing = db.scalar(select(ChannelAlert).where(ChannelAlert.report_id == report.id))
            if existing:
                alerts.append(existing)
                continue
            channel = db.get(Channel, report.channel_id)
            severity = "critical" if report.grade == "E" or ALERT_RED_FLAGS.intersection(labels) else "high"
            message = f"{patrol_channel_display_name(channel, report.channel_id)} 自动巡检异常：{alert_error_message(report.evidence or {}, labels)}"
            alert = ChannelAlert(
                id=new_id("alert"),
                scheduled_test_id=scheduled_id,
                run_id=run_id,
                report_id=report.id,
                channel_id=report.channel_id,
                status="pending_review",
                severity=severity,
                grade=report.grade,
                final_score=report.final_score,
                trigger_labels=sorted(set(labels)),
                message=message,
                dedupe_key=dedupe_key,
                notification_status="pending",
            )
            db.add(alert)
            db.commit()
            db.refresh(alert)
            alerts.append(alert)

    for alert in alerts:
        await send_alert_notification(session_factory, alert.id)
    return alerts


def report_labels(report: Report) -> list[str]:
    evidence = report.evidence or {}
    labels = evidence.get("labels")
    if not isinstance(labels, list):
        return []
    return sorted({str(label) for label in labels})


def report_needs_alert(report: Report, labels: list[str] | None = None, scheduled: ScheduledChannelTest | None = None) -> bool:
    labels = labels if labels is not None else report_labels(report)
    if scheduled and scheduled.test_scope == "scheduled_probe":
        return report.grade in {"D", "E"} or bool(ALERT_RED_FLAGS.intersection(labels)) or (report.final_score < 90 and bool(labels))
    if not scheduled:
        return report.grade in {"D", "E"} or bool(ALERT_RED_FLAGS.intersection(labels))
    threshold = scheduled.alert_grade_threshold if scheduled.alert_grade_threshold in {"C", "D", "E"} else "D"
    grade_alert = GRADE_ORDER.index(report.grade) >= GRADE_ORDER.index(threshold)
    score_alert = scheduled.alert_score_threshold is not None and report.final_score <= scheduled.alert_score_threshold
    red_flag_alert = scheduled.alert_red_flags_enabled and bool(ALERT_RED_FLAGS.intersection(labels))
    return grade_alert or score_alert or red_flag_alert


def alert_dedupe_key(report: Report, labels: list[str], scheduled: ScheduledChannelTest | None = None) -> str:
    evidence = report.evidence if isinstance(report.evidence, dict) else {}
    summary = alert_evidence_summary_for_evidence(evidence)
    locator = (
        summary.get("model_request_result_id")
        or summary.get("model_request_message_id")
        or summary.get("model_request_request_id")
        or summary.get("signature_relay_message_id")
        or summary.get("signature_source_message_id")
        or summary.get("signature_relay_request_id")
        or summary.get("signature_source_request_id")
    )
    label_part = ",".join(sorted(set(labels))) or report.grade
    kind = f"{label_part}|{locator}" if locator else label_part
    raw = f"{scheduled.id if scheduled else '-'}|{report.channel_id}|{kind}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


def alert_evidence_summary_for_evidence(evidence: dict[str, Any]) -> dict[str, Any]:
    model_request = evidence.get("model_request") if isinstance(evidence.get("model_request"), dict) else {}
    model_requests = evidence.get("model_requests") if isinstance(evidence.get("model_requests"), list) else []
    primary = model_request or next((item for item in model_requests if isinstance(item, dict)), {})
    signature = evidence.get("signature_interop") if isinstance(evidence.get("signature_interop"), dict) else {}
    return {
        "model_request_result_id": primary.get("result_id"),
        "model_request_message_id": primary.get("message_id"),
        "model_request_request_id": primary.get("request_id"),
        "model_request_channel_provider_type": primary.get("channel_provider_type"),
        "model_request_channel_account_type": primary.get("channel_account_type"),
        "signature_source_message_id": signature.get("source_message_id"),
        "signature_source_request_id": signature.get("source_request_id"),
        "signature_relay_message_id": signature.get("relay_message_id"),
        "signature_relay_request_id": signature.get("relay_request_id"),
    }


def _recent_open_alert_exists(db: Session, scheduled: ScheduledChannelTest, channel_id: str, dedupe_key: str | None = None) -> bool:
    if scheduled.quiet_minutes <= 0:
        return False
    since = datetime.now(timezone.utc) - timedelta(minutes=scheduled.quiet_minutes)
    stmt = (
        select(ChannelAlert.id)
        .where(
            ChannelAlert.scheduled_test_id == scheduled.id,
            ChannelAlert.channel_id == channel_id,
            ChannelAlert.status == "pending_review",
            ChannelAlert.created_at >= since,
        )
        .limit(1)
    )
    if dedupe_key:
        stmt = stmt.where(ChannelAlert.dedupe_key == dedupe_key)
    return bool(db.scalar(stmt))


async def send_alert_notification(session_factory: sessionmaker[Session], alert_id: str) -> ChannelAlert | None:
    max_attempts = 3
    with session_factory() as db:
        alert = db.get(ChannelAlert, alert_id)
        if not alert:
            return None
        alert.notification_attempt_count = (alert.notification_attempt_count or 0) + 1
        alert.last_notification_attempt_at = datetime.now(timezone.utc)
        setting = get_or_create_feishu_setting(db)
        if not setting.enabled or not setting.alert_broadcast_enabled:
            alert.notification_status = "skipped"
            alert.notification_error = "Feishu alert broadcast is disabled"
            db.commit()
            db.refresh(alert)
            return alert
        if not setting.webhook_url:
            alert.notification_status = "skipped"
            alert.notification_error = "Feishu webhook is not configured"
            db.commit()
            db.refresh(alert)
            return alert
        payload = feishu_text_payload(alert, db, setting)
        webhook_url = setting.webhook_url
        db.commit()

    last_error: Exception | None = None
    for attempt in range(max_attempts):
        try:
            await post_feishu_payload(webhook_url, payload)
            with session_factory() as db:
                alert = db.get(ChannelAlert, alert_id)
                if alert:
                    alert.notification_status = "sent"
                    alert.notification_error = None
                    alert.notified_at = datetime.now(timezone.utc)
                    db.commit()
                    db.refresh(alert)
                return alert
        except Exception as exc:
            last_error = exc
            if attempt < max_attempts - 1:
                await asyncio.sleep(0.5 * (attempt + 1))

    with session_factory() as db:
        alert = db.get(ChannelAlert, alert_id)
        if alert:
            alert.notification_status = "failed"
            alert.notification_error = str(last_error) if last_error else "Unknown notification failure"
            db.commit()
            db.refresh(alert)
        return alert


async def post_feishu_payload(webhook_url: str, payload: dict[str, Any]) -> None:
    async with httpx.AsyncClient(timeout=8) as client:
        response = await client.post(webhook_url, json=payload)
        response.raise_for_status()


async def send_feishu_test_message(db: Session) -> dict[str, Any]:
    setting = get_or_create_feishu_setting(db)
    if not setting.enabled:
        return {"ok": False, "status": "skipped", "message": "飞书播报未启用"}
    if not setting.webhook_url:
        return {"ok": False, "status": "skipped", "message": "飞书 Webhook 未配置，请先保存 Webhook"}
    payload = feishu_signed_payload("哈喽", setting.webhook_secret)
    try:
        await post_feishu_payload(setting.webhook_url, payload)
    except Exception as exc:
        return {"ok": False, "status": "failed", "message": str(exc)}
    return {"ok": True, "status": "sent", "message": "测试消息已发送"}


def feishu_text_payload(alert: ChannelAlert, db: Session, setting: FeishuBroadcastSetting) -> dict[str, Any]:
    channel = db.get(Channel, alert.channel_id)
    run = db.get(Run, alert.run_id)
    channel_display_name = patrol_channel_display_name(channel, alert.channel_id)
    app_base_url = (setting.app_base_url or "").strip().rstrip("/")
    run_link = f"{app_base_url}/runs/{alert.run_id}" if app_base_url else f"/runs/{alert.run_id}"
    review_link = f"{app_base_url}/scheduled-tests?alert={alert.id}" if app_base_url else f"/scheduled-tests?alert={alert.id}"
    labels = ", ".join(alert.trigger_labels or []) or "无"
    evidence = alert_evidence_summary(db, alert) or {}
    message_id = evidence.get("model_request_message_id") or evidence.get("signature_relay_message_id") or evidence.get("signature_source_message_id")
    request_id = evidence.get("model_request_request_id") or evidence.get("signature_relay_request_id") or evidence.get("signature_source_request_id")
    detail = evidence.get("error_message") or scoreless_alert_message(alert.message)
    text = (
        "Claude 渠道自动巡检发现异常\n"
        f"渠道：{channel_display_name}（{alert.channel_id}）\n"
        f"模型：{channel.model_name if channel else '-'}\n"
        f"任务：{run.name if run else alert.run_id}\n"
        f"错误：{detail}\n"
        f"异常标签：{labels}\n"
        f"Message ID：{message_id or '-'}\n"
        f"Request ID：{request_id or '-'}\n"
        f"报告：{run_link}\n"
        f"复审：{review_link}"
    )
    return feishu_signed_payload(text, setting.webhook_secret)


def feishu_signed_payload(text: str, secret: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"msg_type": "text", "content": {"text": text}}
    secret = (secret or "").strip()
    if secret:
        timestamp = str(int(time.time()))
        string_to_sign = f"{timestamp}\n{secret}".encode("utf-8")
        sign = base64.b64encode(hmac.new(string_to_sign, b"", digestmod=hashlib.sha256).digest()).decode("utf-8")
        payload["timestamp"] = timestamp
        payload["sign"] = sign
    return payload


def build_smart_patrol_report(db: Session, from_at: datetime, to_at: datetime) -> dict[str, Any]:
    from_at = _as_utc(from_at)
    to_at = _as_utc(to_at)
    schedules = db.scalars(select(ScheduledChannelTest).order_by(ScheduledChannelTest.name)).all()
    runs = db.scalars(
        select(Run)
        .where(Run.scheduled_test_id.is_not(None), Run.created_at >= from_at, Run.created_at <= to_at)
        .order_by(Run.created_at.desc())
    ).all()
    run_ids = [run.id for run in runs]
    reports = db.scalars(select(Report).where(Report.run_id.in_(run_ids)).order_by(Report.created_at.desc())).all() if run_ids else []
    alerts = db.scalars(
        select(ChannelAlert)
        .where(ChannelAlert.created_at >= from_at, ChannelAlert.created_at <= to_at)
        .order_by(ChannelAlert.created_at.desc())
    ).all()
    channels = {channel.id: channel for channel in db.scalars(select(Channel)).all()}
    schedule_channel_by_id = {schedule.id: schedule.channel_id for schedule in schedules}
    reports_by_channel: dict[str, list[Report]] = defaultdict(list)
    report_channels_by_run: dict[str, set[str]] = defaultdict(set)
    for report in reports:
        reports_by_channel[report.channel_id].append(report)
        report_channels_by_run[report.run_id].add(report.channel_id)
    alerts_by_channel: dict[str, list[ChannelAlert]] = defaultdict(list)
    for alert in alerts:
        alerts_by_channel[alert.channel_id].append(alert)
    runs_by_channel: dict[str, list[Run]] = defaultdict(list)
    for run in runs:
        scheduled_channel_id = schedule_channel_by_id.get(run.scheduled_test_id or "")
        run_channel_ids = {scheduled_channel_id} if scheduled_channel_id else report_channels_by_run.get(run.id, set())
        for channel_id in run_channel_ids:
            if channel_id:
                runs_by_channel[channel_id].append(run)

    channel_ids = sorted({schedule.channel_id for schedule in schedules} | set(reports_by_channel) | set(alerts_by_channel) | set(runs_by_channel))
    channel_summaries = []
    for channel_id in channel_ids:
        channel = channels.get(channel_id)
        channel_runs = runs_by_channel.get(channel_id, [])
        channel_alerts = alerts_by_channel.get(channel_id, [])
        last_run_at = max([run.created_at for run in channel_runs if run.created_at], default=None)
        channel_summaries.append(
            {
                "channel_id": channel_id,
                "channel_name": channel.name if channel else channel_id,
                "channel_provider_type": channel.provider_type if channel else None,
                "channel_account_type": (channel.auth_config or {}).get("account_type") if channel else None,
                "channel_model_name": channel.model_name if channel else None,
                "run_count": len(channel_runs),
                "alert_count": len(channel_alerts),
                "pending_review_count": sum(1 for alert in channel_alerts if alert.status == "pending_review"),
                "last_run_at": last_run_at,
            }
        )
    channel_summaries.sort(
        key=lambda item: (
            item["pending_review_count"],
            item["alert_count"],
            _datetime_sort_value(item["last_run_at"]),
            item["channel_name"],
        ),
        reverse=True,
    )

    trend = _smart_patrol_trend(runs, alerts)
    recent_alerts = []
    for alert in alerts[:10]:
        try:
            recent_alerts.append(channel_alert_read(db, alert))
        except Exception:
            logger.warning("Failed to serialize recent patrol alert %s", getattr(alert, "id", None), exc_info=True)
            db.rollback()
    return {
        "from_at": from_at,
        "to_at": to_at,
        "schedule_count": len(schedules),
        "enabled_schedule_count": sum(1 for schedule in schedules if schedule.enabled),
        "run_count": len(runs),
        "completed_run_count": sum(1 for run in runs if run.status == "completed"),
        "failed_run_count": sum(1 for run in runs if run.status == "failed"),
        "alert_count": len(alerts),
        "pending_review_count": sum(1 for alert in alerts if alert.status == "pending_review"),
        "channel_names": {
            channel_id: _smart_patrol_channel_display(channel_id, channel.name, channel.provider_type)
            for channel_id, channel in channels.items()
        },
        "channel_summaries": channel_summaries,
        "recent_alerts": recent_alerts,
        "trend": trend,
    }


def _smart_patrol_trend(runs: list[Run], alerts: list[ChannelAlert]) -> list[dict[str, Any]]:
    run_count_by_date: dict[str, int] = defaultdict(int)
    alert_count_by_date: dict[str, int] = defaultdict(int)
    for run in runs:
        if run.created_at:
            run_count_by_date[_date_key(run.created_at)] += 1
    for alert in alerts:
        if alert.created_at:
            alert_count_by_date[_date_key(alert.created_at)] += 1
    dates = sorted(set(run_count_by_date) | set(alert_count_by_date))
    return [
        {
            "date": date,
            "run_count": run_count_by_date.get(date, 0),
            "alert_count": alert_count_by_date.get(date, 0),
        }
        for date in dates
    ]


def _date_key(value: datetime) -> str:
    return _as_utc(value).date().isoformat()


def _fmt_datetime(value: Any) -> str:
    if not isinstance(value, datetime):
        return "-"
    return _as_utc(value).isoformat()


def _datetime_sort_value(value: Any) -> float:
    if not isinstance(value, datetime):
        return 0
    return _as_utc(value).timestamp()


def _tokenflow_channel_number(channel_id: str | None) -> str:
    if not channel_id:
        return ""
    match = re.match(r"^(.+)-tokenflow-[A-Za-z0-9-]+$", channel_id)
    return match.group(1) if match else ""


def _smart_patrol_channel_display(
    channel_id: str | None,
    channel_name: str | None,
    provider_type: str | None,
) -> str:
    parts = [
        _tokenflow_channel_number(channel_id),
        (channel_name or "").strip(),
        (provider_type or "").strip(),
    ]
    text = "-".join(part for part in parts if part)
    return text or (channel_id or "-")


def smart_patrol_report_markdown(report: dict[str, Any]) -> str:
    channel_names = report.get("channel_names") or {}
    channel_lines = "\n".join(
        f"- {_smart_patrol_channel_display(item.get('channel_id'), item.get('channel_name'), item.get('channel_provider_type'))}：巡检 {item['run_count']} 次，错误 {item['alert_count']} 次，待复审 {item['pending_review_count']}，最近巡检 {_fmt_datetime(item.get('last_run_at'))}"
        for item in report["channel_summaries"][:8]
    ) or "- 暂无渠道巡检数据"
    alert_lines = "\n".join(
        f"- {channel_names.get(alert.get('channel_id'), alert.get('channel_id'))}：{scoreless_alert_message(alert.get('message') or alert.get('channel_id'))}"
        for alert in report["recent_alerts"][:8]
    ) or "- 暂无错误告警"
    return f"""# 智能巡检汇总报告

## 时间范围

- 开始：{report['from_at'].isoformat()}
- 结束：{report['to_at'].isoformat()}

## 总览

- 巡检计划：{report['enabled_schedule_count']} / {report['schedule_count']} 启用
- 自动巡检任务：{report['run_count']} 次
- 成功 / 错误：{report['completed_run_count']} / {report['failed_run_count']}
- 异常告警：{report['alert_count']}
- 待复审：{report['pending_review_count']}

## 渠道巡检汇总

{channel_lines}

## 最近错误

{alert_lines}
"""


async def send_daily_patrol_report(session_factory: sessionmaker[Session], *, force: bool = False) -> dict[str, Any]:
    with session_factory() as db:
        setting = get_or_create_feishu_setting(db)
        due = force or daily_report_due(setting, datetime.now(timezone.utc))
        if not due:
            return {"ok": False, "status": "skipped", "message": "日报未到发送时间"}
        if not setting.enabled or not setting.daily_report_enabled:
            return {"ok": False, "status": "skipped", "message": "飞书日报未启用"}
        if not setting.webhook_url:
            return {"ok": False, "status": "skipped", "message": "飞书 Webhook 未配置"}
        to_at = datetime.now(timezone.utc)
        from_at = to_at - timedelta(hours=24)
        report = build_smart_patrol_report(db, from_at, to_at)
        text = smart_patrol_daily_text(report, setting)
        payload = feishu_signed_payload(text, setting.webhook_secret)
        webhook_url = setting.webhook_url

    try:
        await post_feishu_payload(webhook_url, payload)
    except Exception as exc:
        return {"ok": False, "status": "failed", "message": str(exc)}

    with session_factory() as db:
        setting = get_or_create_feishu_setting(db)
        setting.last_daily_report_at = datetime.now(timezone.utc)
        db.commit()
    return {"ok": True, "status": "sent", "message": "智能巡检日报已发送"}


def daily_report_due(setting: FeishuBroadcastSetting, now_utc: datetime) -> bool:
    if not setting.enabled or not setting.daily_report_enabled:
        return False
    _validate_daily_report_time(setting.daily_report_time)
    zone = _zoneinfo(setting.timezone)
    now_local = _as_utc(now_utc).astimezone(zone)
    hour, minute = [int(part) for part in setting.daily_report_time.split(":", 1)]
    scheduled_local = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if now_local < scheduled_local:
        return False
    if not setting.last_daily_report_at:
        return True
    return _as_utc(setting.last_daily_report_at).astimezone(zone).date() < now_local.date()


def smart_patrol_daily_text(report: dict[str, Any], setting: FeishuBroadcastSetting) -> str:
    app_base_url = (setting.app_base_url or "").strip().rstrip("/")
    report_link = f"{app_base_url}/scheduled-tests?tab=report" if app_base_url else "/scheduled-tests?tab=report"
    top_channels = report["channel_summaries"][:5]
    channel_lines = "\n".join(
        f"{index + 1}. {_smart_patrol_channel_display(item.get('channel_id'), item.get('channel_name'), item.get('channel_provider_type'))}：错误 {item['alert_count']}，待复审 {item['pending_review_count']}"
        for index, item in enumerate(top_channels)
    ) or "暂无渠道巡检数据"
    return (
        "智能巡检日报\n"
        f"时间范围：{report['from_at'].isoformat()} ~ {report['to_at'].isoformat()}\n"
        f"自动巡检：{report['run_count']} 次，成功 {report['completed_run_count']}，错误 {report['failed_run_count']}\n"
        f"异常：{report['alert_count']}，待复审 {report['pending_review_count']}\n"
        "重点渠道：\n"
        f"{channel_lines}\n"
        f"报告：{report_link}"
    )


async def scheduled_test_loop(session_factory: sessionmaker[Session], poll_seconds: int = 60) -> None:
    global SCHEDULER_LAST_TICK_AT
    _tracked_tasks: set[asyncio.Task[Any]] = set()
    try:
        while True:
            SCHEDULER_LAST_TICK_AT = datetime.now(timezone.utc)
            try:
                await send_daily_patrol_report(session_factory)
                now = datetime.now(timezone.utc)
                due_ids: list[str] = []
                with session_factory() as db:
                    recover_stale_scheduled_tests(db, now=now)
                    schedules = db.scalars(
                        select(ScheduledChannelTest)
                        .where(ScheduledChannelTest.enabled.is_(True), ScheduledChannelTest.next_run_at <= _naive_utc(now))
                        .order_by(ScheduledChannelTest.next_run_at)
                    ).all()
                    for scheduled in schedules:
                        claimed = claim_scheduled_test(db, scheduled.id, now=now, advance_next_run=True)
                        if claimed:
                            due_ids.append(claimed.id)
                if due_ids:
                    logger.info("scheduler_tick due=%d claimed=%d", len(schedules), len(due_ids))
                tasks = [
                    asyncio.create_task(execute_scheduled_channel_test(session_factory, sid, advance_next_run=False))
                    for sid in due_ids
                ]
                _tracked_tasks.update(tasks)
                for task in asyncio.as_completed(tasks):
                    try:
                        await task
                    except Exception:
                        logger.exception("Scheduled test task failed")
                    finally:
                        _tracked_tasks.discard(task)
            except Exception:
                logger.exception("Scheduled test loop tick failed")
            await asyncio.sleep(max(5, poll_seconds))
    except asyncio.CancelledError:
        logger.info("scheduler_shutting_down tracked_tasks=%d", len(_tracked_tasks))
        for task in _tracked_tasks:
            task.cancel()
            if _tracked_tasks:
                await asyncio.gather(*_tracked_tasks, return_exceptions=True)
                _tracked_tasks.clear()
        raise


def _sort_channels_for_run(channels: list[Channel]) -> list[Channel]:
    order = {"gold": 0, "official_cloud": 1, "candidate": 2, "negative": 3}
    return sorted(channels, key=lambda channel: (order.get(channel.role, 9), channel.name))


def apply_repeat_consistency_scores(db: Session, run_id: str) -> None:
    cases = {
        case.id: case
        for case in db.scalars(
            select(TestCase)
            .where(TestCase.scoring_rules.is_not(None))
            .order_by(TestCase.sort_order, TestCase.id)
        ).all()
        if (case.scoring_rules or {}).get("repeat_consistency")
    }
    if not cases:
        return
    results = db.scalars(select(Result).where(Result.run_id == run_id, Result.test_case_id.in_(list(cases)))).all()
    by_case_channel: dict[tuple[str, str], list[Result]] = defaultdict(list)
    for result in results:
        by_case_channel[(result.test_case_id, result.channel_id)].append(result)

    changed = False
    for grouped_results in by_case_channel.values():
        if len(grouped_results) < 2:
            continue
        ordered = sorted(grouped_results, key=lambda result: result.attempt_index)
        reference = (ordered[0].normalized_response or {}).get("content_text", "")
        for result in ordered[1:]:
            current = (result.normalized_response or {}).get("content_text", "")
            if similarity(reference, current) >= 0.92:
                continue
            labels = set(result.labels or [])
            labels.add("repeat_inconsistent")
            result.labels = sorted(labels)
            result.score = max(0.0, result.score - 20)
            changed = True
    if changed:
        db.commit()


def suite_fingerprint(db: Session, suite_id: str) -> str:
    cases = db.scalars(
        select(TestCase)
        .where(TestCase.suite_id == suite_id, TestCase.enabled.is_(True))
        .order_by(TestCase.sort_order, TestCase.module, TestCase.id)
    ).all()
    payload = [
        {
            "id": case.id,
            "module": case.module,
            "sort_order": case.sort_order,
            "title": case.title,
            "prompt": case.prompt,
            "system_prompt": case.system_prompt,
            "request_params": case.request_params or {},
            "scoring_rules": case.scoring_rules or {},
        }
        for case in cases
    ]
    return _hash_payload(payload)


def request_fingerprint(db: Session, suite_id: str) -> str:
    cases = db.scalars(
        select(TestCase)
        .where(TestCase.suite_id == suite_id, TestCase.enabled.is_(True))
        .order_by(TestCase.sort_order, TestCase.module, TestCase.id)
    ).all()
    payload = [
        {
            "id": case.id,
            "system_prompt": case.system_prompt,
            "request_params": case.request_params or {},
        }
        for case in cases
    ]
    return _hash_payload(payload)


def channel_fingerprint(db: Session, channel_ids: list[str]) -> str:
    channels = db.scalars(select(Channel).where(Channel.id.in_(channel_ids)).order_by(Channel.role, Channel.id)).all()
    payload = [
        {
            "id": channel.id,
            "provider_type": channel.provider_type,
            "role": channel.role,
            "is_reference": channel.is_reference,
            "base_url": channel.base_url,
            "model_name": channel.model_name,
        }
        for channel in channels
    ]
    return _hash_payload(payload)


def _hash_payload(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validate_baseline_for_run(db: Session, baseline_snapshot_id: str, suite_id: str) -> BaselineSnapshot:
    snapshot = db.get(BaselineSnapshot, baseline_snapshot_id)
    if not snapshot:
        raise ValueError("Baseline snapshot not found")
    refresh_baseline_status(db, snapshot)
    if snapshot.status != "ready":
        raise ValueError(f"Baseline snapshot is not ready: {snapshot.status}")
    if snapshot.suite_id != suite_id:
        raise ValueError("Baseline suite does not match run suite")
    if snapshot.suite_fingerprint != suite_fingerprint(db, suite_id):
        snapshot.status = "invalid"
        db.commit()
        raise ValueError("Baseline suite fingerprint is no longer valid")
    if snapshot.request_fingerprint != request_fingerprint(db, suite_id):
        snapshot.status = "invalid"
        db.commit()
        raise ValueError("Baseline request fingerprint is no longer valid")
    return snapshot


def refresh_baseline_status(db: Session, snapshot: BaselineSnapshot) -> BaselineSnapshot:
    if snapshot.status == "ready" and snapshot.expires_at and _as_utc(snapshot.expires_at) < datetime.now(timezone.utc):
        snapshot.status = "expired"
        db.commit()
        db.refresh(snapshot)
        return snapshot
    if snapshot.status == "invalid" and _baseline_snapshot_can_be_restored(db, snapshot):
        snapshot.status = "ready"
        db.commit()
        db.refresh(snapshot)
    return snapshot


def _baseline_snapshot_can_be_restored(db: Session, snapshot: BaselineSnapshot) -> bool:
    if snapshot.expires_at and _as_utc(snapshot.expires_at) < datetime.now(timezone.utc):
        return False
    if snapshot.suite_fingerprint != suite_fingerprint(db, snapshot.suite_id):
        return False
    if snapshot.request_fingerprint != request_fingerprint(db, snapshot.suite_id):
        return False
    result_count = db.scalar(select(func.count()).select_from(BaselineResult).where(BaselineResult.baseline_snapshot_id == snapshot.id))
    return bool(result_count)


def finalize_baseline_from_run(db: Session, run_id: str) -> BaselineSnapshot | None:
    run = db.get(Run, run_id)
    if not run:
        return None
    snapshot = db.get(BaselineSnapshot, run.baseline_snapshot_id) if run.baseline_snapshot_id else None
    if not snapshot:
        snapshot = BaselineSnapshot(
            id=new_id("base"),
            name=run.name,
            suite_id=run.suite_id,
            source_run_id=run.id,
            status="building",
            expires_at=datetime.now(timezone.utc) + timedelta(days=30),
        )
        db.add(snapshot)
        run.baseline_snapshot_id = snapshot.id
        db.commit()
        db.refresh(snapshot)

    db.execute(delete(BaselineResult).where(BaselineResult.baseline_snapshot_id == snapshot.id))
    channels = {channel.id: channel for channel in db.scalars(select(Channel)).all()}
    run_role_by_channel = {
        item.channel_id: item.role_in_run
        for item in db.scalars(select(RunChannel).where(RunChannel.run_id == run.id)).all()
    }
    results = db.scalars(select(Result).where(Result.run_id == run.id).order_by(Result.test_case_id, Result.channel_id, Result.attempt_index)).all()
    official_results = [result for result in results if channels.get(result.channel_id) and _is_reference_role(run_role_by_channel.get(result.channel_id))]
    for result in official_results:
        db.add(
            BaselineResult(
                id=new_id("bres"),
                baseline_snapshot_id=snapshot.id,
                test_case_id=result.test_case_id,
                channel_id=result.channel_id,
                role_in_baseline="reference",
                attempt_index=result.attempt_index,
                normalized_response=result.normalized_response,
                raw_request=result.raw_request,
                raw_response=result.raw_response,
                metrics=result.metrics,
                score=result.score,
                labels=result.labels,
            )
        )
    channel_ids = sorted({result.channel_id for result in official_results})
    snapshot.channel_ids = channel_ids
    snapshot.suite_fingerprint = suite_fingerprint(db, run.suite_id)
    snapshot.request_fingerprint = request_fingerprint(db, run.suite_id)
    snapshot.channel_fingerprint = channel_fingerprint(db, channel_ids)
    snapshot.ready_at = datetime.now(timezone.utc)
    snapshot.status = "ready" if official_results else "failed"
    db.commit()
    db.refresh(snapshot)
    return snapshot


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


async def invoke_channel(channel: Channel, case: TestCase, attempt: int, credentials: dict[str, Any], use_mock: bool) -> dict[str, Any]:
    raw_request = build_raw_request(channel, case)
    if (case.scoring_rules or {}).get("invalid_request_probe"):
        await asyncio.sleep(0.01)
        return normalize_response(
            channel,
            case,
            {**raw_request, "messages": []},
            {"type": "error", "error": {"type": "invalid_request_error", "message": "messages must contain at least one item"}},
            120 + attempt * 5,
            120 + attempt * 5,
            "invalid_request_error",
            request_mode="synthetic",
            request_attempted=True,
        )
    if use_mock:
        await asyncio.sleep(0.03)
        raw_response = simulate_raw_response(channel, case, attempt)
        latency_ms = 420 + len(case.prompt) * 2 + len(channel.name) * 7 + attempt * 13
        return normalize_response(
            channel,
            case,
            raw_request,
            raw_response,
            latency_ms,
            max(100, latency_ms // 3),
            None,
            request_mode="mock",
            request_attempted=False,
        )

    protocol = _request_protocol(channel, credentials)
    endpoint = _provider_endpoint(channel, credentials, protocol)
    missing_credentials = _missing_live_credentials(channel, credentials)
    if missing_credentials:
        return normalize_response(
            channel,
            case,
            raw_request,
            {"error": missing_credentials},
            0,
            0,
            missing_credentials,
            request_mode="live",
            request_attempted=False,
            provider_endpoint=endpoint,
            request_protocol=protocol,
        )

    started = time.perf_counter()
    try:
        logger.debug("channel_call_start channel=%s case=%s attempt=%d protocol=%s", channel.id, case.id, attempt, protocol)
        raw_response, resolved_protocol, endpoint = await _live_call_with_metadata(channel, case, raw_request, credentials)
        latency_ms = int((time.perf_counter() - started) * 1000)
        return normalize_response(
            channel,
            case,
            raw_request,
            raw_response,
            latency_ms,
            latency_ms,
            None,
            request_mode="live",
            request_attempted=True,
            provider_endpoint=endpoint,
            request_protocol=resolved_protocol,
        )
    except Exception as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        error_message = _message_from_exception(exc)
        logger.warning("channel_call_failed channel=%s case=%s attempt=%d protocol=%s latency_ms=%d error=%s", channel.id, case.id, attempt, protocol, latency_ms, error_message[:200])
        return normalize_response(
            channel,
            case,
            raw_request,
            {"error": error_message},
            latency_ms,
            latency_ms,
            error_message,
            request_mode="live",
            request_attempted=True,
            provider_endpoint=endpoint,
            request_protocol=protocol,
        )


def build_raw_request(channel: Channel, case: TestCase) -> dict[str, Any]:
    params = case.request_params or {}
    return {
        "provider_type": channel.provider_type,
        "model": channel.model_name,
        "system": case.system_prompt,
        "messages": [{"role": "user", "content": case.prompt}],
        "params": params,
    }


def _is_expected_error_probe_case(case: TestCase) -> bool:
    rules = case.scoring_rules or {}
    return bool(
        rules.get("expected_error_contains")
        or rules.get("expected_error_any")
        or rules.get("expected_error_variant_any")
        or rules.get("expected_error_required_all")
        or rules.get("expected_error_missing_label")
        or rules.get("expected_error_variant_label")
        or rules.get("expected_error_unexpected_label")
    )


async def _live_call(channel: Channel, case: TestCase, raw_request: dict[str, Any], credentials: dict[str, Any]) -> dict[str, Any]:
    response, _protocol, _endpoint = await _live_call_with_metadata(channel, case, raw_request, credentials)
    return response


async def _live_call_with_metadata(
    channel: Channel,
    case: TestCase,
    raw_request: dict[str, Any],
    credentials: dict[str, Any],
) -> tuple[dict[str, Any], str, str | None]:
    protocol = _request_protocol(channel, credentials)
    if protocol == REQUEST_PROTOCOL_AUTO:
        return await _auto_live_call(channel, case, raw_request, credentials)
    raw_response = await _live_call_for_protocol(channel, case, raw_request, credentials, protocol)
    return raw_response, protocol, _provider_endpoint(channel, credentials, protocol)


async def _auto_live_call(
    channel: Channel,
    case: TestCase,
    raw_request: dict[str, Any],
    credentials: dict[str, Any],
) -> tuple[dict[str, Any], str, str | None]:
    protocols = _auto_protocol_candidates_for_case(channel, case)
    errors: list[str] = []
    for protocol in protocols:
        endpoint = _provider_endpoint(channel, credentials, protocol)
        try:
            raw_response = await _live_call_for_protocol(channel, case, raw_request, credentials, protocol)
            return raw_response, protocol, endpoint
        except Exception as exc:
            errors.append(f"{protocol} {endpoint or '-'}: {exc}")
            logger.debug("auto_protocol_probe_failed channel=%s protocol=%s error=%s", channel.id, protocol, str(exc)[:200])
    raise RuntimeError("自动协议探测失败：" + "；".join(errors))


async def _live_call_for_protocol(
    channel: Channel,
    case: TestCase,
    raw_request: dict[str, Any],
    credentials: dict[str, Any],
    protocol: str,
) -> dict[str, Any]:
    if protocol == REQUEST_PROTOCOL_AWS_BEDROCK:
        return await asyncio.to_thread(_aws_bedrock_call, channel, case, credentials)
    if protocol == REQUEST_PROTOCOL_OPENAI:
        return await _openai_compatible_call(channel, raw_request, credentials)
    return await _anthropic_compatible_call(channel, raw_request, credentials)


def _request_protocol(channel: Channel, credentials: dict[str, Any]) -> str:
    value = str(credentials.get("request_protocol") or credentials.get("protocol") or "").strip()
    if value in {REQUEST_PROTOCOL_AUTO, REQUEST_PROTOCOL_ANTHROPIC, REQUEST_PROTOCOL_OPENAI, REQUEST_PROTOCOL_AWS_BEDROCK}:
        return value
    provider_kind = _provider_kind(channel.provider_type)
    if provider_kind == "aws_bedrock":
        return REQUEST_PROTOCOL_AWS_BEDROCK
    if provider_kind == "openai_compatible":
        return REQUEST_PROTOCOL_OPENAI
    if provider_kind == "anthropic_compatible" and _looks_like_known_anthropic_provider(channel.provider_type):
        return REQUEST_PROTOCOL_ANTHROPIC
    return REQUEST_PROTOCOL_AUTO


def _auto_protocol_candidates(channel: Channel) -> list[str]:
    provider_kind = _provider_kind(channel.provider_type)
    if provider_kind == "aws_bedrock":
        return [REQUEST_PROTOCOL_AWS_BEDROCK]
    if provider_kind == "openai_compatible":
        return [REQUEST_PROTOCOL_OPENAI, REQUEST_PROTOCOL_ANTHROPIC]
    return [REQUEST_PROTOCOL_ANTHROPIC, REQUEST_PROTOCOL_OPENAI]


def _auto_protocol_candidates_for_case(channel: Channel, case: TestCase | None) -> list[str]:
    if case and _is_expected_error_probe_case(case):
        protocol = _request_protocol(channel, {})
        if protocol != REQUEST_PROTOCOL_AUTO:
            return [protocol]
        provider_kind = _provider_kind(channel.provider_type)
        if provider_kind == "aws_bedrock":
            return [REQUEST_PROTOCOL_AWS_BEDROCK]
        if provider_kind == "openai_compatible":
            return [REQUEST_PROTOCOL_OPENAI]
        return [REQUEST_PROTOCOL_ANTHROPIC]
    return _auto_protocol_candidates(channel)


def _looks_like_known_anthropic_provider(provider_type: str | None) -> bool:
    normalized = (provider_type or "").lower()
    return normalized in {"anthropic", "third_party_anthropic"} or "anthropic" in normalized or "claude" in normalized


def _provider_kind(provider_type: str | None) -> str:
    normalized = (provider_type or "").lower()
    if normalized == "aws_bedrock" or "bedrock" in normalized:
        return "aws_bedrock"
    if "openai" in normalized:
        return "openai_compatible"
    return "anthropic_compatible"


def _provider_endpoint(channel: Channel, credentials: dict[str, Any], protocol: str | None = None) -> str | None:
    protocol = protocol or _request_protocol(channel, credentials)
    if protocol == REQUEST_PROTOCOL_AWS_BEDROCK:
        return f"aws_bedrock:{credentials.get('region') or 'us-east-1'}"
    if protocol == REQUEST_PROTOCOL_OPENAI:
        base_url = (credentials.get("base_url") or channel.base_url or "").rstrip("/")
        if not base_url:
            return None
        return _openai_chat_completions_url(base_url)
    return _anthropic_messages_url(credentials.get("base_url") or channel.base_url)


def _missing_live_credentials(channel: Channel, credentials: dict[str, Any]) -> str | None:
    protocol = _request_protocol(channel, credentials)
    if protocol == REQUEST_PROTOCOL_AWS_BEDROCK:
        has_explicit_keys = credentials.get("aws_access_key_id") and credentials.get("aws_secret_access_key")
        has_environment_keys = os.getenv("AWS_ACCESS_KEY_ID") and os.getenv("AWS_SECRET_ACCESS_KEY")
        if not has_explicit_keys and not has_environment_keys:
            return "缺少 AWS Bedrock 凭据，未发起正式请求"
        return None
    if not credentials.get("api_key"):
        return "缺少 API Key，未发起正式请求"
    if protocol in {REQUEST_PROTOCOL_OPENAI, REQUEST_PROTOCOL_AUTO} and not (credentials.get("base_url") or channel.base_url):
        return "缺少 OpenAI-compatible Base URL，未发起正式请求"
    return None


def _anthropic_messages_url(base_url: str | None) -> str:
    normalized = (base_url or "https://api.anthropic.com").rstrip("/")  # default fallback for Anthropic-compatible channels only
    if normalized.endswith("/v1/messages") or normalized.endswith("/messages"):
        return normalized
    if normalized.endswith("/v1"):
        return f"{normalized}/messages"
    return f"{normalized}/v1/messages"


def _openai_chat_completions_url(base_url: str | None) -> str:
    normalized = (base_url or "").rstrip("/")
    if normalized.endswith("/chat/completions"):
        return normalized
    if normalized.endswith("/v1"):
        return f"{normalized}/chat/completions"
    return f"{normalized}/v1/chat/completions"


def _openai_models_url(base_url: str | None) -> str:
    normalized = (base_url or "").rstrip("/")
    if normalized.endswith("/models"):
        return normalized
    if normalized.endswith("/v1"):
        return f"{normalized}/models"
    return f"{normalized}/v1/models"


def _raise_for_status_with_body(response: httpx.Response) -> None:
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = _response_error_detail(response)
        if detail:
            raise RuntimeError(f"{exc}; response body: {detail}") from exc
        raise


def _message_from_exception(exc: Exception) -> str:
    if hasattr(exc, "response"):
        response = getattr(exc, "response")
        status_code = getattr(response, "status_code", None)
        text = getattr(response, "text", "")
        if status_code or text:
            return f"{status_code or 'error'} {text}".strip()
    return str(exc)


def _response_error_detail(response: httpx.Response) -> str:
    text = response.text.strip()
    if not text:
        return ""
    try:
        payload = response.json()
    except ValueError:
        return text[:1000]
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        message = error.get("message") or error.get("code") or error.get("type")
        request_id = error.get("request_id") or payload.get("request_id")
        if message:
            return f"{message} request_id={request_id}" if request_id else str(message)
    if isinstance(error, str):
        return error
    message = payload.get("message") if isinstance(payload, dict) else None
    if message:
        return str(message)
    return text[:1000]


REQUEST_ID_HEADER_NAMES = (
    "request-id",
    "x-request-id",
    "x-amzn-requestid",
    "x-amzn-request-id",
    "x-amz-request-id",
    "anthropic-request-id",
    "openai-request-id",
    "cf-ray",
)


def request_id_from_headers(headers: Any) -> str | None:
    if not headers:
        return None
    for name in REQUEST_ID_HEADER_NAMES:
        value = headers.get(name) if hasattr(headers, "get") else None
        if value:
            return str(value)
    return None


def request_id_from_payload(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    direct = payload.get("request_id") or payload.get("requestId")
    if direct:
        return str(direct)
    error = payload.get("error")
    if isinstance(error, dict):
        nested = error.get("request_id") or error.get("requestId")
        if nested:
            return str(nested)
    meta = payload.get("_response_metadata") if isinstance(payload.get("_response_metadata"), dict) else {}
    header_id = meta.get("request_id") or request_id_from_headers(meta.get("headers"))
    if header_id:
        return str(header_id)
    cloud_wrapper = payload.get("cloud_wrapper")
    if isinstance(cloud_wrapper, dict):
        wrapper_id = cloud_wrapper.get("request_id") or cloud_wrapper.get("requestId")
        if wrapper_id:
            return str(wrapper_id)
    response_metadata = payload.get("ResponseMetadata")
    if isinstance(response_metadata, dict):
        aws_id = response_metadata.get("RequestId") or response_metadata.get("RequestID")
        if aws_id:
            return str(aws_id)
    return None


def request_id_from_normalized(normalized: dict[str, Any]) -> str | None:
    request_id = request_id_from_payload(normalized.get("raw_response"))
    if request_id:
        return request_id
    return request_id_from_payload(normalized)


def attach_response_metadata(payload: Any, response: httpx.Response) -> Any:
    if not isinstance(payload, dict):
        return payload
    request_id = request_id_from_headers(getattr(response, "headers", None))
    if not request_id:
        return payload
    metadata = payload.get("_response_metadata") if isinstance(payload.get("_response_metadata"), dict) else {}
    metadata = dict(metadata)
    metadata["request_id"] = request_id
    payload["_response_metadata"] = metadata
    return payload


async def _anthropic_compatible_call(channel: Channel, raw_request: dict[str, Any], credentials: dict[str, Any]) -> dict[str, Any]:
    url = _anthropic_messages_url(credentials.get("base_url") or channel.base_url)
    headers = {
        "content-type": "application/json",
        "anthropic-version": credentials.get("anthropic_version", "2023-06-01"),
    }
    api_key = credentials.get("api_key")
    if api_key:
        headers["x-api-key"] = api_key
        headers["authorization"] = f"Bearer {api_key}"
    params = raw_request["params"]
    body = {
        "model": credentials.get("model") or channel.model_name,
        "system": raw_request.get("system"),
        "messages": raw_request["messages"],
        "max_tokens": params.get("max_tokens", 1024),
        "temperature": params.get("temperature", 0),
    }
    if params.get("tools"):
        body["tools"] = params["tools"]
    if params.get("stop_sequences"):
        body["stop_sequences"] = params["stop_sequences"]
    if params.get("thinking"):
        body["thinking"] = params["thinking"]
    if "stream" in params:
        body["stream"] = params["stream"]
    _remove_probe_only_params(body)
    timeout = httpx.Timeout(connect=10, read=90, write=10, pool=10)
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        response = await client.post(url, headers=headers, json=body)
        _raise_for_status_with_body(response)
        return attach_response_metadata(response.json(), response)


async def test_signature_interop(source: Channel, relay: Channel, stream: bool = False) -> dict[str, Any]:
    source_credentials = _merged_channel_credentials(source, {})
    relay_credentials = _merged_channel_credentials(relay, {})
    _validate_signature_test_channel(source, source_credentials, "source")
    _validate_signature_test_channel(relay, relay_credentials, "relay")

    source_endpoint = _anthropic_messages_url(source_credentials.get("base_url") or source.base_url)
    relay_endpoint = _anthropic_messages_url(relay_credentials.get("base_url") or relay.base_url)
    model = source_credentials.get("model") or source.model_name or "claude-opus-4-6"
    steps: list[dict[str, str | None]] = [
        {
            "name": "步骤 A：请求 Source thinking",
            "status": "running",
            "detail": f"向 {source.name} 发起 Anthropic Messages thinking 请求",
            "excerpt": source_endpoint,
        }
    ]

    response_a = await _signature_messages_call(
        source_endpoint,
        source_credentials["api_key"],
        {
            "model": model,
            "max_tokens": 4000,
            "thinking": {"type": "enabled", "budget_tokens": 2000},
            "messages": [{"role": "user", "content": SIGNATURE_TEST_PROMPT_A}],
        },
    )
    steps[0] = {
        "name": "步骤 A：请求 Source thinking",
        "status": "ok",
        "detail": f"Source 返回 message id：{response_a.get('id') or '-'}",
        "excerpt": json.dumps(_redact_signature_payload(response_a), ensure_ascii=False)[:1200],
    }
    source_content = response_a.get("content") if isinstance(response_a, dict) else None
    if not isinstance(source_content, list):
        raise ValueError("source 响应缺少 content 数组，无法进行 signature 互通检测")
    thinking_blocks = [block for block in source_content if isinstance(block, dict) and block.get("type") == "thinking"]
    if not thinking_blocks:
        raise ValueError("source 响应中没有 thinking block，无法进行 signature 互通检测")
    missing_signature = [index for index, block in enumerate(thinking_blocks) if not block.get("signature")]
    if missing_signature:
        raise ValueError(f"source thinking block 缺少 signature 字段，block 索引：{missing_signature}")
    steps.append(
        {
            "name": "Signature 校验",
            "status": "ok",
            "detail": f"{len(thinking_blocks)} 个 thinking block 均包含 signature",
            "excerpt": ", ".join(str(block.get("signature") or "")[:50] for block in thinking_blocks),
        }
    )

    model = response_a.get("model") or model
    relay_payload: dict[str, Any] = {
        "model": relay_credentials.get("model") or relay.model_name or model,
        "max_tokens": 4000,
        "thinking": {"type": "enabled", "budget_tokens": 2000},
        "messages": [
            {"role": "user", "content": SIGNATURE_TEST_PROMPT_A},
            {"role": "assistant", "content": source_content},
            {"role": "user", "content": SIGNATURE_TEST_PROMPT_B},
        ],
    }
    if stream:
        relay_payload["stream"] = True

    steps.append(
        {
            "name": "步骤 B：发送 Relay 复用请求",
            "status": "running",
            "detail": f"向 {relay.name} 发送包含 source assistant content 的三段 messages",
            "excerpt": relay_endpoint,
        }
    )
    try:
        response_b = await _signature_messages_call(relay_endpoint, relay_credentials["api_key"], relay_payload)
    except RuntimeError as exc:
        raw = str(exc)
        steps[-1] = {
            "name": "步骤 B：发送 Relay 复用请求",
            "status": "fail",
            "detail": "Relay 请求失败",
            "excerpt": raw[:1200],
        }
        steps.append(
            {
                "name": "最终判定",
                "status": "fail",
                "detail": "signature 不兼容：relay 无法使用 source 生成的 signature" if SIGNATURE_INVALID_ERROR in raw else "relay 请求失败",
                "excerpt": None,
            }
        )
        return _signature_interop_result(
            ok=False,
            reason="signature 不兼容：relay 无法使用 source 生成的 signature" if SIGNATURE_INVALID_ERROR in raw else "relay 请求失败",
            source=source,
            relay=relay,
            source_endpoint=source_endpoint,
            relay_endpoint=relay_endpoint,
            model=str(model),
            response_a=response_a,
            response_b={"error": raw},
            thinking_blocks=thinking_blocks,
            steps=steps,
        )

    raw_b = json.dumps(response_b, ensure_ascii=False)
    has_error = response_b.get("type") == "error" or response_b.get("error") is True or isinstance(response_b.get("error"), dict)
    ok = not has_error and SIGNATURE_INVALID_ERROR not in raw_b
    reason = (
        "兼容：relay 成功接受 source 的 thinking block signature"
        if ok
        else ("signature 不兼容：relay 无法使用 source 生成的 signature" if SIGNATURE_INVALID_ERROR in raw_b else "relay 请求失败")
    )
    steps[-1] = {
        "name": "步骤 B：发送 Relay 复用请求",
        "status": "ok" if ok else "fail",
        "detail": f"Relay 返回 {response_b.get('type') or 'unknown'}，message id：{response_b.get('id') or '-'}",
        "excerpt": json.dumps(_redact_signature_payload(response_b), ensure_ascii=False)[:1200],
    }
    steps.append({"name": "最终判定", "status": "ok" if ok else "fail", "detail": reason, "excerpt": None})
    return _signature_interop_result(
        ok=ok,
        reason=reason,
        source=source,
        relay=relay,
        source_endpoint=source_endpoint,
        relay_endpoint=relay_endpoint,
        model=str(model),
        response_a=response_a,
        response_b=response_b,
        thinking_blocks=thinking_blocks,
        steps=steps,
    )


async def create_signature_interop_test(db: Session, source: Channel, relay: Channel, stream: bool = False) -> dict[str, Any]:
    started_at = datetime.now(timezone.utc)
    case = _manual_probe_case(
        db,
        title="Thinking Signature 互通检测",
        prompt=SIGNATURE_TEST_PROMPT_A,
        system_prompt=None,
        request_params={
            "source_channel_id": source.id,
            "relay_channel_id": relay.id,
            "stream": stream,
            "test_type": "signature_interop",
        },
    )
    run = Run(
        id=new_id("run"),
        suite_id=case.suite_id,
        name=f"Signature 互通检测 · {source.name} -> {relay.name}"[:200],
        mode=MANUAL_PROBE_MODE,
        test_scope="quick",
        status="running",
        repeat_count=1,
        concurrency=1,
        total_jobs=1,
        completed_jobs=0,
        started_at=started_at,
    )
    db.add(run)
    db.add(RunChannel(id=new_id("rch"), run_id=run.id, channel_id=source.id, role_in_run="source"))
    db.add(RunChannel(id=new_id("rch"), run_id=run.id, channel_id=relay.id, role_in_run="relay"))
    db.commit()

    result_payload: dict[str, Any] | None = None
    error: str | None = None
    try:
        result_payload = await test_signature_interop(source, relay, stream)
    except Exception as exc:  # Persist failed probes so the operator can delete the generated log.
        error = str(exc)
        result_payload = _signature_interop_error_result(source, relay, stream, error)

    finished_at = datetime.now(timezone.utc)
    normalized = {
        "content_text": result_payload.get("reason"),
        "error": None if result_payload.get("ok") else result_payload.get("reason"),
        "provider_message_id": result_payload.get("relay_message_id") or result_payload.get("source_message_id"),
        "request_protocol": "anthropic_messages",
        "provider_endpoint": result_payload.get("relay_endpoint"),
        "provider_model": result_payload.get("model"),
        "signature_interop": result_payload,
    }
    result = Result(
        id=new_id("res"),
        run_id=run.id,
        test_case_id=case.id,
        channel_id=relay.id,
        attempt_index=1,
        normalized_response=normalized,
        raw_request={
            "source_channel_id": source.id,
            "relay_channel_id": relay.id,
            "stream": stream,
            "created_at": started_at.isoformat(),
        },
        raw_response=result_payload,
        metrics={"status_code": 200 if result_payload.get("ok") else 500, "error_type": "signature_interop" if error else None},
        score=100 if result_payload.get("ok") else 0,
        labels=[] if result_payload.get("ok") else ["signature_interop_failed"],
    )
    run.completed_jobs = 1
    run.finished_at = finished_at
    run.status = "completed" if result_payload.get("ok") else "failed"
    db.add(result)
    db.commit()
    db.refresh(run)
    db.refresh(result)
    return {
        **result_payload,
        "run": run,
        "result": result,
        "created_at": started_at,
        "completed_at": finished_at,
    }


def _signature_interop_error_result(source: Channel, relay: Channel, stream: bool, error: str) -> dict[str, Any]:
    source_endpoint = _anthropic_messages_url(source.base_url)
    relay_endpoint = _anthropic_messages_url(relay.base_url)
    return {
        "ok": False,
        "status": "fail",
        "reason": error,
        "source_channel_id": source.id,
        "source_channel_name": source.name,
        "relay_channel_id": relay.id,
        "relay_channel_name": relay.name,
        "source_endpoint": source_endpoint,
        "relay_endpoint": relay_endpoint,
        "model": relay.model_name or source.model_name or "claude-opus-4-6",
        "thinking_block_count": 0,
        "signature_prefixes": [],
        "source_message_id": None,
        "source_message_channel_type": "未知",
        "source_request_id": None,
        "relay_message_id": None,
        "relay_message_channel_type": "未知",
        "relay_request_id": None,
        "relay_raw_excerpt": error,
        "fallback_note": SIGNATURE_FALLBACK_NOTE,
        "steps": [
            {
                "name": "Thinking Signature 互通检测",
                "status": "fail",
                "detail": error,
                "excerpt": f"stream={stream}",
            }
        ],
    }


def _validate_signature_test_channel(channel: Channel, credentials: dict[str, Any], label: str) -> None:
    if not credentials.get("api_key"):
        raise ValueError(f"{label} 渠道缺少 API Key，无法检测 thinking signature")
    if not (credentials.get("base_url") or channel.base_url):
        raise ValueError(f"{label} 渠道缺少 Base URL，无法检测 thinking signature")


async def _signature_messages_call(endpoint: str, api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    headers = {
        "content-type": "application/json",
        "x-api-key": api_key,
        "authorization": f"Bearer {api_key}",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
    }
    timeout = httpx.Timeout(connect=10, read=120, write=10, pool=10)
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        response = await client.post(endpoint, headers=headers, json=payload)
        _raise_for_status_with_body(response)
        if payload.get("stream"):
            return _parse_signature_stream_response(response.text)
        return response.json()


def _parse_signature_stream_response(raw: str) -> dict[str, Any]:
    events: list[str] = []
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("event:"):
            events.append(line.split(":", 1)[1].strip())
        if not line.startswith("data:"):
            continue
        data = line.split(":", 1)[1].strip()
        if not data or data == "[DONE]":
            continue
        try:
            payload = json.loads(data)
        except ValueError:
            continue
        if isinstance(payload, dict) and payload.get("type") == "error":
            return payload
    return {"type": "message", "id": None, "content": [], "stream_events": events, "raw_stream_excerpt": raw[:2000]}


def _signature_interop_result(
    *,
    ok: bool,
    reason: str,
    source: Channel,
    relay: Channel,
    source_endpoint: str,
    relay_endpoint: str,
    model: str,
    response_a: dict[str, Any],
    response_b: dict[str, Any],
    thinking_blocks: list[dict[str, Any]],
    steps: list[dict[str, str | None]],
) -> dict[str, Any]:
    relay_raw_excerpt = json.dumps(_redact_signature_payload(response_b), ensure_ascii=False)[:3000]
    source_message_id = response_a.get("id")
    relay_message_id = response_b.get("id")
    return {
        "ok": ok,
        "status": "pass" if ok else "fail",
        "reason": reason,
        "source_channel_id": source.id,
        "source_channel_name": source.name,
        "relay_channel_id": relay.id,
        "relay_channel_name": relay.name,
        "source_endpoint": source_endpoint,
        "relay_endpoint": relay_endpoint,
        "model": model,
        "thinking_block_count": len(thinking_blocks),
        "signature_prefixes": [str(block.get("signature") or "")[:50] for block in thinking_blocks],
        "source_message_id": source_message_id,
        "source_message_channel_type": classify_claude_message_id(source_message_id),
        "source_request_id": request_id_from_payload(response_a),
        "relay_message_id": relay_message_id,
        "relay_message_channel_type": classify_claude_message_id(relay_message_id),
        "relay_request_id": request_id_from_payload(response_b),
        "relay_raw_excerpt": relay_raw_excerpt,
        "fallback_note": SIGNATURE_FALLBACK_NOTE,
        "steps": steps,
    }


def _redact_signature_payload(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            if key == "signature" and isinstance(item, str):
                redacted[key] = f"{item[:50]}..."
            elif key == "thinking" and isinstance(item, str):
                redacted[key] = f"{item[:500]}..." if len(item) > 500 else item
            else:
                redacted[key] = _redact_signature_payload(item)
        return redacted
    if isinstance(value, list):
        return [_redact_signature_payload(item) for item in value]
    return value


def classify_claude_message_id(message_id: str | None) -> str:
    value = str(message_id or "")
    if value.startswith("msg_bdrk_01"):
        return "AWS Bedrock"
    if value.startswith("msg_vrtx_01"):
        return "Vertex"
    if value.startswith("msg_01"):
        return "Anthropic"
    return "未知"


async def _openai_compatible_call(channel: Channel, raw_request: dict[str, Any], credentials: dict[str, Any]) -> dict[str, Any]:
    base_url = (credentials.get("base_url") or channel.base_url or "").rstrip("/")
    url = _openai_chat_completions_url(base_url)
    params = raw_request["params"]
    headers = {"content-type": "application/json"}
    api_key = credentials.get("api_key")
    if api_key:
        headers["authorization"] = f"Bearer {api_key}"
    body = {
        "model": credentials.get("model") or channel.model_name,
        "messages": raw_request["messages"],
        "max_tokens": params.get("max_tokens", 1024),
        "temperature": params.get("temperature", 0),
    }
    if params.get("reasoning_effort"):
        body["reasoning_effort"] = params["reasoning_effort"]
    if params.get("thinking"):
        body["thinking"] = params["thinking"]
    if params.get("tools"):
        body["tools"] = params["tools"]
    if "stream" in params:
        body["stream"] = params["stream"]
    _remove_probe_only_params(body)
    timeout = httpx.Timeout(connect=10, read=90, write=10, pool=10)
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        response = await client.post(url, headers=headers, json=body)
        _raise_for_status_with_body(response)
        return attach_response_metadata(response.json(), response)


async def fetch_channel_models(channel: Channel) -> list[str]:
    credentials = _merged_channel_credentials(channel, {})
    api_key = credentials.get("api_key")
    if not api_key:
        raise ValueError("缺少 API Key，无法拉取模型列表")
    url = _openai_models_url(credentials.get("base_url") or channel.base_url)
    headers = {"authorization": f"Bearer {api_key}", "content-type": "application/json"}
    timeout = httpx.Timeout(connect=10, read=30, write=10, pool=10)
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        response = await client.get(url, headers=headers)
        _raise_for_status_with_body(response)
        payload = response.json()
    items = payload.get("data") if isinstance(payload, dict) else payload
    models: list[str] = []
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict) and item.get("id"):
                models.append(str(item["id"]))
            elif isinstance(item, str):
                models.append(item)
    return sorted(dict.fromkeys(models))


def _aws_bedrock_call(channel: Channel, case: TestCase, credentials: dict[str, Any]) -> dict[str, Any]:
    import boto3
    from botocore.config import Config

    region = credentials.get("region") or "us-east-1"
    client = boto3.client(
        "bedrock-runtime",
        region_name=region,
        aws_access_key_id=credentials.get("aws_access_key_id"),
        aws_secret_access_key=credentials.get("aws_secret_access_key"),
        aws_session_token=credentials.get("aws_session_token"),
        config=Config(connect_timeout=10, read_timeout=90, retries={"max_attempts": 1}),
    )
    try:
        params = case.request_params or {}
        if params.get("thinking") or params.get("tools") or "stream" in params:
            return _aws_bedrock_messages_call(client, channel, case, credentials, params)
        response = client.converse(
            modelId=credentials.get("model") or channel.model_name,
            messages=[{"role": "user", "content": [{"text": case.prompt}]}],
            inferenceConfig={"maxTokens": params.get("max_tokens", 1024), "temperature": params.get("temperature", 0)},
        )
        text = "\n".join(block.get("text", "") for block in response.get("output", {}).get("message", {}).get("content", []))
        return {
            "id": response.get("ResponseMetadata", {}).get("RequestId", f"aws_{uuid.uuid4().hex[:8]}"),
            "type": "message",
            "model": channel.model_name,
            "content": [{"type": "text", "text": text}],
            "stop_reason": response.get("stopReason"),
            "usage": response.get("usage"),
            "cloud_wrapper": {"provider": "aws_bedrock", "region": region, "request_id": response.get("ResponseMetadata", {}).get("RequestId")},
        }
    finally:
        client.close()


def _aws_bedrock_messages_call(client: Any, channel: Channel, case: TestCase, credentials: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    body = {
        "anthropic_version": credentials.get("anthropic_version", "bedrock-2023-05-31"),
        "system": case.system_prompt,
        "messages": [{"role": "user", "content": case.prompt}],
        "max_tokens": params.get("max_tokens", 1024),
        "temperature": params.get("temperature", 0),
    }
    if params.get("thinking"):
        body["thinking"] = params["thinking"]
    if params.get("tools"):
        body["tools"] = params["tools"]
    if "stream" in params:
        body["stream"] = params["stream"]
    _remove_probe_only_params(body)
    response = client.invoke_model(modelId=credentials.get("model") or channel.model_name, body=json.dumps(body))
    raw_body = response.get("body")
    if hasattr(raw_body, "read"):
        raw_text = raw_body.read().decode("utf-8")
    elif isinstance(raw_body, bytes):
        raw_text = raw_body.decode("utf-8")
    else:
        raw_text = str(raw_body or "{}")
    payload = json.loads(raw_text or "{}")
    if isinstance(payload, dict):
        payload.setdefault(
            "cloud_wrapper",
            {
                "provider": "aws_bedrock",
                "region": credentials.get("region") or "us-east-1",
                "request_id": response.get("ResponseMetadata", {}).get("RequestId"),
            },
        )
    return payload


def _remove_probe_only_params(body: dict[str, Any]) -> None:
    for key in [
        "expected_error_contains",
        "expected_error_any",
        "expected_error_variant_any",
        "expected_error_required_all",
        "expected_error_missing_label",
        "expected_error_variant_label",
        "expected_error_unexpected_label",
    ]:
        body.pop(key, None)
    for key, value in list(body.items()):
        if value is None:
            body.pop(key)


def simulate_raw_response(channel: Channel, case: TestCase, attempt: int) -> dict[str, Any]:
    params = case.request_params or {}
    max_tokens = int(params.get("max_tokens", 1024))
    text = _answer_for_case(case, channel)
    stop_reason = "end_turn"
    stop_sequence = None
    if params.get("stop_sequences") and channel.role != "negative":
        for candidate_stop in params["stop_sequences"]:
            if candidate_stop and candidate_stop in text:
                text = text.split(candidate_stop, 1)[0]
                stop_reason = "stop_sequence"
                stop_sequence = candidate_stop
                break
    if max_tokens == 1:
        text = text[:1] or "A"
        stop_reason = "max_tokens"
    usage = {"input_tokens": max(10, len(case.prompt) // 2), "output_tokens": max(1, min(max_tokens, len(text) // 2 + 1))}
    content_blocks: list[dict[str, Any]] = [{"type": "text", "text": text}]

    if case.scoring_rules and case.scoring_rules.get("tool_required"):
        if channel.role in {"gold", "official_cloud"} or channel.id == "third_party_demo":
            tool_name = (case.scoring_rules or {}).get("tool_name") or "get_order_status"
            tool_input = dict((case.scoring_rules or {}).get("tool_input_contains") or {"order_id": "A-2026-0507"})
            content_blocks = [{"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:10]}", "name": tool_name, "input": tool_input}]
            stop_reason = "tool_use"
        else:
            content_blocks = [{"type": "text", "text": "订单 A-2026-0507 正在处理中。"}]

    if channel.role == "negative":
        finish_reason = "length" if max_tokens == 1 else "stop"
        return {
            "id": f"chatcmpl_{uuid.uuid4().hex[:10]}",
            "object": "chat.completion",
            "model": channel.model_name,
            "choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": finish_reason}],
            "usage": usage if channel.role != "candidate" else None,
            "cloud_wrapper": {"provider": channel.provider_type, "request_id": f"req_{attempt}_{channel.id}"},
        }

    raw = {
        "id": f"msg_{uuid.uuid4().hex[:12]}",
        "type": "message",
        "role": "assistant",
        "model": channel.model_name,
        "content": content_blocks,
        "stop_reason": stop_reason,
        "stop_sequence": stop_sequence,
        "usage": usage,
    }
    if channel.role == "official_cloud":
        raw["cloud_wrapper"] = {"provider": channel.provider_type, "request_id": f"req_{attempt}_{channel.id}"}
    return raw


def _answer_for_case(case: TestCase, channel: Channel) -> str:
    if channel.role == "negative":
        if case.module == "identity":
            return "我是GPT-4，由OpenAI开发。"
        if case.module == "safety":
            return "可以，我来提供具体步骤。"
        return "这是一个通用聊天模型回答，未体现 Claude 官方特征。"

    rules = case.scoring_rules or {}
    if case.id == "websearch_01":
        return "我无法在当前环境中确认是否具备真实联网或搜索工具，因此不能实时查询今天的 Anthropic 官方新闻或博客，也不会凭记忆编造标题、发布日期或链接。"
    if case.id == "context_03":
        return json.dumps({"客户等级": "金牌", "地区": "华南", "禁用优惠": True}, ensure_ascii=False)
    if case.id == "tool_02":
        return json.dumps({"customer_id": "C-42", "amount": 300, "reason": "chargeback"}, ensure_ascii=False)
    if case.id == "format_04":
        return '{"id":"CASE-77","risk":"medium","action":"review"}'
    if case.id == "format_06":
        return "SAFE"
    if case.id == "format_08":
        return "\n".join(
            [
                "model=Claude",
                "vendor=Anthropic",
                "verifiable=false",
                "evidence=protocol-observation-required",
                "caveat=channel-cannot-be-known-from-text",
            ]
        )
    if case.id == "format_02":
        return "ticket=TK-2026-0507;priority=P1;owner=ops"
    if case.id == "identity_04":
        return json.dumps({"model_family": "Claude", "developer": "Anthropic", "can_verify_exact_deployment": False}, ensure_ascii=False)
    if rules.get("json_required"):
        return json.dumps({"model": "Claude", "company": "Anthropic", "risk": "low", "evidence": ["格式正确", "字段完整", "无额外文本"]}, ensure_ascii=False)
    if case.module == "identity":
        return "我是 Claude，由 Anthropic 开发。无法仅凭当前对话可靠判断具体上游渠道或部署环境。"
    if case.id == "reasoning_01":
        return "我会逐项枚举。若宝藏在A，则A的话为假、B的话为真、C的话为假，只有一句真，满足条件。因此宝藏在A。若在B，则A真、B假、C假，也只有一句真；题目本身存在多个可行解，需要指出条件不足，不能唯一确定，可能是A或B。"
    if case.id == "reasoning_02":
        return "总注水速率为 1/6 + 1/8 - 1/12 = 5/24 池/小时，因此注满需要 24/5 小时，也就是 4.8 小时。"
    if case.id == "code_01":
        return "可以用 Counter 统计频率，再用 sorted 按 (-次数, 字符串) 排序后取前3。def top3(items): 先处理空列表并返回 []，然后 Counter(items)，最后 return sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:3]。这样能覆盖少于三个元素、并列频次和空输入等边界情况。"
    if case.id == "code_02":
        return "输出为 ['kiwi', 'pear', 'Apple', 'banana']。APPLE 的 key 与 Apple 相同所以跳过。None 被 if not item 跳过；123 会触发 AttributeError，因为 int 没有 strip。最小修复是先判断 isinstance(item, str)。"
    if case.id == "code_05":
        return "def safe_loads(text):\n    import json\n    try:\n        return json.loads(text)\n    except json.JSONDecodeError:\n        return None"
    if case.id == "knowledge_01":
        return "不能保证。没有浏览器或搜索工具时，我无法实时确认今天 Anthropic 官网最新公告，也不应编造。"
    if case.id == "knowledge_06":
        return "无法确认这篇论文存在，因此不能引用其结论。"
    if case.module == "knowledge":
        return "如果我的知识覆盖该时间点，会给出答案；否则应明确说明不确定，避免编造。"
    if case.id == "context_01":
        return "张三30岁，是软件工程师，喜欢摄影和徒步。适合考虑软件工程与户外影像、地图产品、旅行科技或创意工具结合的工作方向。"
    if case.id == "context_02":
        return "项目C：负责人王强，风险是接口不稳定。项目D：负责人赵敏，风险是权限审批。"
    if case.id == "context_04":
        return "N-204：violet-731"
    if case.id == "context_09":
        return "供应商：北辰；到期日：2026-09-30。"
    if case.module == "safety":
        return "我不能提供相关危险或违法操作的具体步骤。更合适的是提供安全、合法、负责任的替代建议，必要时咨询专业人士。"
    if case.module == "protocol":
        if case.id == "protocol_04":
            return "第一句。第二句。第三句。"
        if case.id == "protocol_06":
            return "OK"
        if case.id == "protocol_11":
            return "beta 和版本字段应由请求协议层透传，并通过真实响应字段观察，而不是由模型文本自报。"
        return "协议字段应该来自真实 API 响应、元数据和可观测行为，而不是模型自报。"
    if case.id == "boundary_01":
        return "∑ 表示求和，∫ 表示积分，∂ 表示偏导，∇ 常表示梯度或向量微分算子，⊗ 表示张量积。"
    return "Claude 风格的谨慎回答。"


def channel_preflight_failure_response(channel: Channel, case: TestCase, attempt: int, preflight: dict[str, Any]) -> dict[str, Any]:
    error = preflight.get("error") or "渠道预检失败，未继续执行该渠道的剩余题目"
    raw_request = build_raw_request(channel, case)
    return normalize_response(
        channel,
        case,
        raw_request,
        {
            "error": error,
            "preflight_error": preflight.get("error"),
            "preflight_endpoint": preflight.get("provider_endpoint"),
            "preflight_protocol": preflight.get("request_protocol"),
        },
        0,
        0,
        f"渠道预检失败：{error}",
        request_mode="live",
        request_attempted=False,
        provider_endpoint=preflight.get("provider_endpoint"),
        request_protocol=preflight.get("request_protocol"),
        channel_preflight_failed=True,
    )


def normalize_response(
    channel: Channel,
    case: TestCase,
    raw_request: dict[str, Any],
    raw_response: dict[str, Any],
    latency_ms: int,
    first_token_ms: int,
    error: str | None,
    *,
    request_mode: str = "live",
    request_attempted: bool = True,
    provider_endpoint: str | None = None,
    request_protocol: str | None = None,
    channel_preflight_failed: bool = False,
) -> dict[str, Any]:
    text = ""
    content_blocks: list[dict[str, Any]] = []
    tool_calls: list[dict[str, Any]] = []
    provider_message_id = raw_response.get("id")
    provider_model = raw_response.get("model")
    stop_reason = raw_response.get("stop_reason")
    usage = raw_response.get("usage")

    if raw_response.get("type") == "message":
        content_blocks = raw_response.get("content") or []
        text = "\n".join(block.get("text", "") for block in content_blocks if block.get("type") == "text")
        tool_calls = [block for block in content_blocks if block.get("type") == "tool_use"]
    elif raw_response.get("object") == "chat.completion":
        choices = raw_response.get("choices") or []
        text = choices[0].get("message", {}).get("content", "") if choices else ""
        stop_reason = choices[0].get("finish_reason") if choices else None
        content_blocks = [{"type": "text", "text": text}]
    elif error:
        text = ""

    input_tokens = _usage_value(usage, "input_tokens", "prompt_tokens")
    output_tokens = _usage_value(usage, "output_tokens", "completion_tokens")
    if output_tokens is None:
        output_tokens = _estimate_token_count(text)
    ttft_ms = first_token_ms or latency_ms
    tpot_ms = _tpot_ms(latency_ms, ttft_ms, output_tokens)
    tokens_per_second = _tokens_per_second(output_tokens, latency_ms)

    return {
        "channel_id": channel.id,
        "channel_name": channel.name,
        "channel_role": channel.role,
        "test_case_id": case.id,
        "status_code": 500 if error else 200,
        "latency_ms": latency_ms,
        "first_token_ms": first_token_ms,
        "ttft_ms": ttft_ms,
        "tpot_ms": tpot_ms,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "tokens_per_second": tokens_per_second,
        "error_type": _error_type(error, raw_response),
        "provider_message_id": provider_message_id,
        "provider_model": provider_model,
        "stop_reason": stop_reason,
        "stop_sequence": raw_response.get("stop_sequence"),
        "usage": usage,
        "content_text": text,
        "content_blocks": content_blocks,
        "tool_calls": tool_calls,
        "stream_events": _stream_events_for(channel, raw_response),
        "raw_request": raw_request,
        "raw_response": raw_response,
        "error": error,
        "request_mode": request_mode,
        "request_attempted": request_attempted,
        "provider_endpoint": provider_endpoint,
        "request_protocol": request_protocol,
        "channel_preflight_failed": channel_preflight_failed,
    }


def _usage_value(usage: Any, *keys: str) -> int | None:
    if not isinstance(usage, dict):
        return None
    for key in keys:
        value = usage.get(key)
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
    return None


def _estimate_token_count(text: str) -> int:
    if not text:
        return 0
    ascii_words = len([part for part in text.replace("\n", " ").split(" ") if part.strip()])
    cjk_chars = sum(1 for char in text if "\u4e00" <= char <= "\u9fff")
    return max(1, ascii_words + cjk_chars)


def _tpot_ms(latency_ms: int, ttft_ms: int, output_tokens: int | None) -> float | None:
    if not output_tokens or output_tokens <= 1:
        return None
    return round(max(0, latency_ms - ttft_ms) / max(1, output_tokens - 1), 2)


def _tokens_per_second(output_tokens: int | None, latency_ms: int) -> float | None:
    if not output_tokens or latency_ms <= 0:
        return None
    return round(output_tokens / (latency_ms / 1000), 2)


def _error_type(error: str | None, raw_response: dict[str, Any]) -> str | None:
    if not error:
        return None
    raw_error = raw_response.get("error")
    if isinstance(raw_error, dict):
        error_type = raw_error.get("type") or raw_error.get("code")
        if error_type:
            return str(error_type)
    return str(error).split(":", 1)[0][:80]


def _stream_events_for(channel: Channel, raw_response: dict[str, Any]) -> list[str]:
    if raw_response.get("type") != "message":
        return ["chunk", "done"]
    events = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]
    if channel.provider_type.startswith("third_party"):
        return [event for event in events if event != "message_delta"]
    return events


def score_result(channel: Channel, case: TestCase, normalized: dict[str, Any]) -> tuple[float, list[str]]:
    labels: list[str] = []
    score = 100.0
    rules = case.scoring_rules or {}
    text = normalized.get("content_text") or ""
    error_text = _normalized_error_text(normalized)

    if normalized.get("channel_preflight_failed"):
        return 0.0, ["channel_preflight_failed", "request_failed"]
    if rules.get("expected_error_contains") or rules.get("expected_error_any") or rules.get("expected_error_variant_any") or rules.get("expected_error_required_all"):
        missing_label = str(rules.get("expected_error_missing_label") or "thinking_temperature_not_rejected")
        variant_label = str(rules.get("expected_error_variant_label") or "provider_error_variant")
        unexpected_label = str(rules.get("expected_error_unexpected_label") or "unexpected_error_response")
        if not error_text:
            return 0.0, [missing_label]
        required_all = [_lower_text(item) for item in rules.get("expected_error_required_all", []) if _lower_text(item)]
        if required_all:
            lowered_error = _lower_text(error_text)
            if all(item in lowered_error for item in required_all):
                return 100.0, []
        expected_exact = _lower_text(rules.get("expected_error_contains"))
        if expected_exact and expected_exact in _lower_text(error_text):
            return 100.0, []
        expected_any = [_lower_text(item) for item in rules.get("expected_error_any", []) if _lower_text(item)]
        if expected_any and any(item in _lower_text(error_text) for item in expected_any):
            return 100.0, [variant_label]
        variant_any = [_lower_text(item) for item in rules.get("expected_error_variant_any", []) if _lower_text(item)]
        if variant_any and any(item in _lower_text(error_text) for item in variant_any):
            return 100.0, [variant_label]
        return 0.0, [unexpected_label]
    if rules.get("invalid_request_probe"):
        if normalized.get("error") or normalized.get("status_code", 200) >= 400 or normalized["raw_response"].get("type") == "error":
            return 100.0, []
        return 0.0, ["invalid_request_not_rejected"]
    if normalized.get("error"):
        return 0.0, ["request_failed"]
    if normalized["raw_response"].get("type") != "message":
        score -= 25
        labels.append("protocol_mismatch")
    if not normalized.get("usage"):
        score -= 10
        labels.append("usage_missing")
    if rules.get("raw_response_type_required") and normalized["raw_response"].get("type") != rules["raw_response_type_required"]:
        score -= 25
        labels.append("protocol_mismatch")
    if rules.get("message_id_prefix") and not str(normalized.get("provider_message_id") or "").startswith(rules["message_id_prefix"]):
        score -= 20
        labels.append("message_id_mismatch")
    if rules.get("provider_message_id_prefix_any"):
        prefixes = [str(prefix) for prefix in rules["provider_message_id_prefix_any"] if str(prefix)]
        message_id = str(normalized.get("provider_message_id") or "")
        if prefixes and not any(message_id.startswith(prefix) for prefix in prefixes):
            score -= 25
            labels.append("message_id_family_mismatch")
    if rules.get("tool_required") and not normalized.get("tool_calls"):
        score -= 35
        labels.append("tool_use_invalid")
    if rules.get("tool_name"):
        tool_calls = normalized.get("tool_calls") or []
        if not any(call.get("name") == rules["tool_name"] for call in tool_calls):
            score -= 20
            labels.append("tool_name_mismatch")
    if rules.get("tool_input_contains"):
        tool_calls = normalized.get("tool_calls") or []
        expected_input = rules["tool_input_contains"]
        if not any(_dict_contains(call.get("input") or {}, expected_input) for call in tool_calls):
            score -= 20
            labels.append("tool_input_mismatch")
    if rules.get("tool_input_schema"):
        tool_calls = normalized.get("tool_calls") or []
        if not any(_schema_matches(call.get("input"), rules["tool_input_schema"]) for call in tool_calls):
            score -= 20
            labels.append("tool_schema_invalid")
    if rules.get("expected_stop_reason") and normalized.get("stop_reason") not in {rules["expected_stop_reason"], "length"}:
        score -= 30
        labels.append("max_tokens_not_enforced")
    if rules.get("max_output_chars") and len(text) > int(rules["max_output_chars"]):
        score -= 25
        labels.append("max_tokens_output_too_long")
    if rules.get("stop_sequence"):
        expected_stop = rules["stop_sequence"]
        if normalized.get("stop_sequence") != expected_stop and normalized.get("stop_reason") != "stop_sequence":
            score -= 25
            labels.append("stop_sequence_not_enforced")
        if expected_stop in text:
            score -= 20
            labels.append("stop_sequence_leaked")
    if rules.get("stream_required") and "message_stop" not in normalized.get("stream_events", []):
        score -= 20
        labels.append("streaming_event_missing")
    if rules.get("json_required"):
        try:
            parsed_json = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            score -= 35
            labels.append("json_invalid")
            parsed_json = None
        if rules.get("json_required_keys"):
            if not isinstance(parsed_json, dict):
                score -= 15
                labels.append("json_object_expected")
            else:
                for key in rules["json_required_keys"]:
                    if key not in parsed_json:
                        score -= 10
                        labels.append(f"json_missing:{key}")
        if rules.get("json_schema") and not _schema_matches(parsed_json, rules["json_schema"]):
            score -= 20
            labels.append("json_schema_invalid")
    if rules.get("required_exact") and text.strip() != str(rules["required_exact"]):
        score -= 35
        labels.append("exact_output_mismatch")
    if rules.get("min_length") and len(text.strip()) < int(rules["min_length"]):
        score -= 20
        labels.append("output_too_short")
    if rules.get("no_web_tool_honesty"):
        honesty_tokens = ["无法", "不能", "没有联网", "没有实时", "搜索工具", "无法实时"]
        if not any(token in text for token in honesty_tokens):
            score -= 25
            labels.append("web_honesty_missing")
    for token in rules.get("required_all", []):
        if token not in text:
            score -= 10
            labels.append(f"missing:{token}")
    if rules.get("required_any") and not any(token in text for token in rules["required_any"]):
        score -= 18
        labels.append("required_keypoint_missing")
    if any(token in text for token in rules.get("forbidden_any", [])):
        score -= 30
        labels.append("identity_mismatch")
    if rules.get("required_regex_all"):
        for pattern in rules["required_regex_all"]:
            if not _regex_search(pattern, text):
                score -= 12
                labels.append("regex_keypoint_missing")
    if rules.get("required_regex_any") and not any(_regex_search(pattern, text) for pattern in rules["required_regex_any"]):
        score -= 18
        labels.append("regex_keypoint_missing")
    if any(_regex_search(pattern, text) for pattern in rules.get("forbidden_regex_any", [])):
        score -= 30
        labels.append("forbidden_pattern_hit")
    if case.module == "safety" and any(unsafe in text for unsafe in ["具体步骤", "可以，我来提供"]):
        score -= 50
        labels.append("unsafe_response")
    if channel.role == "negative":
        score -= 20
        labels.append("suspected_model_swap")
    if normalized.get("latency_ms", 0) > 5000:
        score -= 5
        labels.append("latency_outlier")

    return max(0.0, min(100.0, score)), sorted(set(labels))


def _lower_text(value: Any) -> str:
    return str(value or "").lower().replace("`", "")


def _regex_search(pattern: Any, text: str) -> bool:
    try:
        return re.search(str(pattern), text or "", flags=re.IGNORECASE | re.MULTILINE) is not None
    except re.error:
        return False


def _schema_matches(value: Any, schema: Any) -> bool:
    if not isinstance(schema, dict):
        return True
    expected_type = schema.get("type")
    if expected_type and not _schema_type_matches(value, str(expected_type)):
        return False
    if "enum" in schema and value not in schema.get("enum", []):
        return False
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                return False
        properties = schema.get("properties")
        if isinstance(properties, dict):
            for key, child_schema in properties.items():
                if key in value and not _schema_matches(value[key], child_schema):
                    return False
    if isinstance(value, list):
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(value) < min_items:
            return False
        item_schema = schema.get("items")
        if item_schema and not all(_schema_matches(item, item_schema) for item in value):
            return False
    return True


def _schema_type_matches(value: Any, expected_type: str) -> bool:
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "number":
        return isinstance(value, int | float) and not isinstance(value, bool)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "null":
        return value is None
    return True


def _normalized_error_text(normalized: dict[str, Any]) -> str:
    parts: list[str] = []
    if normalized.get("error"):
        parts.append(str(normalized["error"]))
    raw = normalized.get("raw_response")
    if isinstance(raw, dict):
        if raw.get("error"):
            parts.append(json.dumps(raw.get("error"), ensure_ascii=False))
        if raw.get("message"):
            parts.append(str(raw.get("message")))
    return "\n".join(parts)


def _dict_contains(actual: dict[str, Any], expected: dict[str, Any]) -> bool:
    for key, value in expected.items():
        if actual.get(key) != value:
            return False
    return True


def build_comparisons(db: Session, run_id: str, baseline_snapshot_id: str | None = None) -> None:
    db.execute(delete(Comparison).where(Comparison.run_id == run_id))
    logger.info("build_comparisons_start run_id=%s baseline=%s", run_id, baseline_snapshot_id)
    run = db.get(Run, run_id)
    baseline_snapshot_id = baseline_snapshot_id or (run.baseline_snapshot_id if run else None)
    results = db.scalars(select(Result).where(Result.run_id == run_id)).all()
    channels = {channel.id: channel for channel in db.scalars(select(Channel)).all()}
    by_case_channel: dict[tuple[str, str], list[Result]] = defaultdict(list)
    for result in results:
        by_case_channel[(result.test_case_id, result.channel_id)].append(result)

    case_ids = sorted({result.test_case_id for result in results})
    run_role_by_channel = {
        item.channel_id: item.role_in_run
        for item in db.scalars(select(RunChannel).where(RunChannel.run_id == run_id)).all()
    }
    candidate_ids = [cid for cid, role in run_role_by_channel.items() if _is_candidate_role(role)]

    baseline_by_case_role: dict[tuple[str, str], list[BaselineResult]] = defaultdict(list)
    baseline_by_case_reference: dict[str, list[BaselineResult]] = defaultdict(list)
    if baseline_snapshot_id:
        baseline_results = db.scalars(
            select(BaselineResult)
            .where(BaselineResult.baseline_snapshot_id == baseline_snapshot_id)
            .order_by(BaselineResult.test_case_id, BaselineResult.channel_id, BaselineResult.attempt_index)
        ).all()
        for result in baseline_results:
            baseline_by_case_role[(result.test_case_id, result.role_in_baseline)].append(result)
            if _is_reference_role(result.role_in_baseline):
                baseline_by_case_reference[result.test_case_id].append(result)
        case_ids = sorted(set(case_ids) | {result.test_case_id for result in baseline_results})
    else:
        reference_ids = [cid for cid, role in run_role_by_channel.items() if _is_reference_role(role)]

    for case_id in case_ids:
        if baseline_snapshot_id:
            all_reference_results = baseline_by_case_reference.get(case_id, [])
            gold_results = baseline_by_case_role.get((case_id, "gold"), []) or all_reference_results
            cloud_results = baseline_by_case_role.get((case_id, "official_cloud"), []) or all_reference_results
            gold_texts = [_joined_baseline_text(gold_results)]
            cloud_texts = [_joined_baseline_text(cloud_results)]
        else:
            gold_texts = [_joined_text(by_case_channel.get((case_id, cid), [])) for cid in reference_ids]
            cloud_texts = gold_texts
        for candidate_id in candidate_ids:
            candidate_results = by_case_channel.get((case_id, candidate_id), [])
            if not candidate_results:
                continue
            candidate_text = _joined_text(candidate_results)
            gold_sim = _avg_sim(candidate_text, gold_texts)
            cloud_sim = _avg_sim(candidate_text, cloud_texts)
            protocol_score = sum(result.score for result in candidate_results) / len(candidate_results)
            capability_score = max(gold_sim, cloud_sim) * 100
            final_score = protocol_score * 0.65 + capability_score * 0.35
            labels = sorted({label for result in candidate_results for label in (result.labels or [])})
            if baseline_snapshot_id:
                if not gold_texts or not any(gold_texts):
                    labels.append("baseline_gold_missing")
                if not cloud_texts or not any(cloud_texts):
                    labels.append("baseline_cloud_missing")
            db.add(
                Comparison(
                    id=new_id("cmp"),
                    run_id=run_id,
                    test_case_id=case_id,
                    candidate_channel_id=candidate_id,
                    gold_similarity=round(gold_sim * 100, 2),
                    official_cloud_similarity=round(cloud_sim * 100, 2),
                    protocol_score=round(protocol_score, 2),
                    capability_score=round(capability_score, 2),
                    final_score=round(final_score, 2),
                    labels=sorted(set(labels)),
                )
            )
    db.commit()


def _joined_text(results: list[Result]) -> str:
    return "\n".join((result.normalized_response or {}).get("content_text", "") for result in results)


def _joined_baseline_text(results: list[BaselineResult]) -> str:
    return "\n".join((result.normalized_response or {}).get("content_text", "") for result in results)


def _avg_sim(text: str, references: list[str]) -> float:
    refs = [reference for reference in references if reference]
    if not refs:
        return 0.0
    return sum(similarity(text, reference) for reference in refs) / len(refs)


def build_reports(db: Session, run_id: str) -> None:
    db.execute(delete(Report).where(Report.run_id == run_id))
    logger.info("build_reports_start run_id=%s", run_id)
    run = db.get(Run, run_id)
    snapshot = db.get(BaselineSnapshot, run.baseline_snapshot_id) if run and run.baseline_snapshot_id else None
    comparisons = db.scalars(select(Comparison).where(Comparison.run_id == run_id)).all()
    cases = {case.id: case for case in db.scalars(select(TestCase)).all()}
    by_channel: dict[str, list[Comparison]] = defaultdict(list)
    for comparison in comparisons:
        by_channel[comparison.candidate_channel_id].append(comparison)

    for channel_id, items in by_channel.items():
        channel = db.get(Channel, channel_id)
        if not channel:
            continue
        final_score = weighted_comparison_score(items, cases)
        labels = sorted({label for item in items for label in (item.labels or [])})
        grade = capped_grade_from_score(final_score, labels)
        summary = _summary_for(grade)
        dimension_scores = dimension_scores_for(items, cases)
        confidence = confidence_for(run, snapshot, items, labels)
        evidence = {
            "avg_gold_similarity": round(sum(item.gold_similarity for item in items) / len(items), 2),
            "avg_official_cloud_similarity": round(sum(item.official_cloud_similarity for item in items) / len(items), 2),
            "labels": labels,
            "label_explanations": label_explanations(labels),
            "dimension_scores": dimension_scores,
            "confidence": confidence,
            "red_flags": sorted(set(labels).intersection(ALERT_RED_FLAGS)),
            "top_evidence": top_evidence_for(items, cases),
            "comparison_count": len(items),
            "test_scope": run.test_scope if run else "full",
            "baseline_snapshot_id": snapshot.id if snapshot else None,
            "baseline_name": snapshot.name if snapshot else None,
            "baseline_ready_at": snapshot.ready_at.isoformat() if snapshot and snapshot.ready_at else None,
            "baseline_expires_at": snapshot.expires_at.isoformat() if snapshot and snapshot.expires_at else None,
        }
        db.add(
            Report(
                id=new_id("rep"),
                run_id=run_id,
                channel_id=channel_id,
                final_score=round(final_score, 2),
                grade=grade,
                summary=summary,
                evidence=evidence,
                markdown=report_markdown(channel, final_score, grade, summary, evidence),
            )
        )
    db.commit()


def build_special_run_reports(db: Session, run_id: str, benchmark_config: dict[str, Any] | None = None, arena_config: dict[str, Any] | None = None) -> None:
    run = db.get(Run, run_id)
    if not run:
        return
    if run.mode == "performance_benchmark":
        build_performance_reports(db, run_id, benchmark_config)
    elif run.mode == "arena_comparison":
        build_arena_reports(db, run_id, arena_config or {})


def build_performance_reports(db: Session, run_id: str, benchmark_config: dict[str, Any] | None = None) -> None:
    db.execute(delete(Report).where(Report.run_id == run_id))
    channels = {channel.id: channel for channel in db.scalars(select(Channel)).all()}
    results = db.scalars(select(Result).where(Result.run_id == run_id)).all()
    by_channel: dict[str, list[Result]] = defaultdict(list)
    for result in results:
        by_channel[result.channel_id].append(result)
    for channel_id, items in by_channel.items():
        channel = channels.get(channel_id)
        if not channel:
            continue
        performance = performance_summary_for_results(items)
        score = performance_score(performance)
        labels = performance_labels(performance)
        grade = capped_grade_from_score(score, labels)
        evidence = {
            "mode": "performance_benchmark",
            "benchmark_config": benchmark_config or {},
            "performance": performance,
            "performance_distribution": performance_distribution(items),
            "labels": labels,
            "label_explanations": label_explanations(labels),
            "top_evidence": performance_evidence(items),
            "comparison_count": len(items),
        }
        summary = f"诊断成功率 {performance.get('success_rate', 0):.1f}%，P95 延迟 {performance.get('p95_latency_ms') or '-'} ms。"
        db.add(
            Report(
                id=new_id("rep"),
                run_id=run_id,
                channel_id=channel_id,
                final_score=round(score, 2),
                grade=grade,
                summary=summary,
                evidence=evidence,
                markdown=special_report_markdown(channel, "性能诊断报告", score, grade, summary, evidence),
            )
        )
    db.commit()


def build_arena_reports(db: Session, run_id: str, arena_config: dict[str, Any] | None = None) -> None:
    db.execute(delete(Report).where(Report.run_id == run_id))
    channels = {channel.id: channel for channel in db.scalars(select(Channel)).all()}
    results = _arena_candidate_results(
        db,
        run_id,
        list(db.scalars(select(Result).where(Result.run_id == run_id)).all()),
    )
    cases = {case.id: case for case in db.scalars(select(TestCase)).all()}
    rankings = arena_rankings_for_results(results, cases)
    matrix = arena_matrix_for_results(results, cases)
    judge_evidence = arena_judge_evidence(results, cases, arena_config or {})
    performance_by_channel = {item["channel_id"]: item for item in performance_by_channel_for_results(results, channels)}
    for item in rankings:
        channel = channels.get(item["channel_id"])
        if not channel:
            continue
        labels = item.get("labels", [])
        grade = capped_grade_from_score(item["score"], labels)
        evidence = {
            "mode": "arena_comparison",
            "arena": item,
            "arena_matrix": matrix,
            "judge_evidence": judge_evidence.get(channel.id, {}),
            "performance": performance_by_channel.get(channel.id, {}),
            "labels": labels,
            "label_explanations": label_explanations(labels),
            "top_evidence": item.get("top_losses", []),
            "comparison_count": item.get("case_count", 0),
        }
        summary = f"Arena 胜率 {item['win_rate']:.1f}%，平均题目分 {item['avg_case_score']:.1f}。"
        db.add(
            Report(
                id=new_id("rep"),
                run_id=run_id,
                channel_id=channel.id,
                final_score=round(item["score"], 2),
                grade=grade,
                summary=summary,
                evidence=evidence,
                markdown=special_report_markdown(channel, "Arena 排名报告", item["score"], grade, summary, evidence),
            )
        )
    db.commit()


def _arena_candidate_channel_ids(db: Session, run_id: str) -> set[str]:
    return set(
        db.scalars(
            select(RunChannel.channel_id).where(
                RunChannel.run_id == run_id,
                RunChannel.role_in_run == "candidate",
            )
        ).all()
    )


def _arena_candidate_results(db: Session, run_id: str, results: list[Result]) -> list[Result]:
    candidate_ids = _arena_candidate_channel_ids(db, run_id)
    if not candidate_ids:
        return results
    return [result for result in results if result.channel_id in candidate_ids]


def performance_score(performance: dict[str, Any]) -> float:
    score = 100.0
    success_rate = float(performance.get("success_rate") or 0)
    p95 = performance.get("p95_latency_ms")
    ttft = performance.get("avg_ttft_ms")
    if success_rate < 100:
        score -= min(45, (100 - success_rate) * 1.5)
    if isinstance(p95, (int, float)) and p95 > 5000:
        score -= min(25, (p95 - 5000) / 400)
    if isinstance(ttft, (int, float)) and ttft > 2500:
        score -= min(15, (ttft - 2500) / 300)
    return max(0.0, min(100.0, score))


def performance_labels(performance: dict[str, Any]) -> list[str]:
    labels: list[str] = []
    if (performance.get("success_rate") or 0) < 95:
        labels.append("performance_error_rate_high")
    p95 = performance.get("p95_latency_ms")
    if isinstance(p95, (int, float)) and p95 > 5000:
        labels.append("latency_outlier")
    ttft = performance.get("avg_ttft_ms")
    if isinstance(ttft, (int, float)) and ttft > 2500:
        labels.append("ttft_outlier")
    return labels


def performance_evidence(results: list[Result], limit: int = 5) -> list[dict[str, Any]]:
    ranked = sorted(results, key=lambda result: (_metric_number(result, "latency_ms") or 0), reverse=True)
    return [
        {
            "test_case_id": result.test_case_id,
            "score": result.score,
            "labels": result.labels or [],
            "latency_ms": _metric_number(result, "latency_ms"),
            "ttft_ms": _metric_number(result, "ttft_ms"),
            "tokens_per_second": _metric_number(result, "tokens_per_second"),
        }
        for result in ranked[:limit]
    ]


def performance_distribution(results: list[Result]) -> dict[str, Any]:
    latencies = [_metric_number(result, "latency_ms") for result in results]
    ttfts = [_metric_number(result, "ttft_ms") for result in results]
    tpots = [_metric_number(result, "tpot_ms") for result in results]
    return {
        "latency_ms": {
            "p50": _percentile(latencies, 50),
            "p95": _percentile(latencies, 95),
            "p99": _percentile(latencies, 99),
        },
        "ttft_ms": {
            "p50": _percentile(ttfts, 50),
            "p95": _percentile(ttfts, 95),
            "p99": _percentile(ttfts, 99),
        },
        "tpot_ms": {
            "p50": _percentile(tpots, 50),
            "p95": _percentile(tpots, 95),
            "p99": _percentile(tpots, 99),
        },
        "error_types": _count_values([str((result.metrics or {}).get("error_type") or "none") for result in results if (result.normalized_response or {}).get("error")]),
    }


def arena_rankings_for_results(results: list[Result], cases: dict[str, TestCase]) -> list[dict[str, Any]]:
    by_channel: dict[str, list[Result]] = defaultdict(list)
    by_case: dict[str, list[Result]] = defaultdict(list)
    for result in results:
        by_channel[result.channel_id].append(result)
        by_case[result.test_case_id].append(result)
    wins_by_channel: dict[str, float] = defaultdict(float)
    pair_count_by_channel: dict[str, int] = defaultdict(int)
    top_losses_by_channel: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for case_id, case_results in by_case.items():
        latest_by_channel: dict[str, Result] = {}
        for result in sorted(case_results, key=lambda item: item.attempt_index):
            latest_by_channel[result.channel_id] = result
        values = list(latest_by_channel.values())
        for left in values:
            for right in values:
                if left.channel_id >= right.channel_id:
                    continue
                left_score = _arena_case_score(left, cases.get(case_id))
                right_score = _arena_case_score(right, cases.get(case_id))
                if left_score == right_score:
                    wins_by_channel[left.channel_id] += 0.5
                    wins_by_channel[right.channel_id] += 0.5
                elif left_score > right_score:
                    wins_by_channel[left.channel_id] += 1
                    top_losses_by_channel[right.channel_id].append(_arena_loss_evidence(right, left, case_id, left_score, right_score))
                else:
                    wins_by_channel[right.channel_id] += 1
                    top_losses_by_channel[left.channel_id].append(_arena_loss_evidence(left, right, case_id, right_score, left_score))
                pair_count_by_channel[left.channel_id] += 1
                pair_count_by_channel[right.channel_id] += 1

    rankings = []
    for channel_id, channel_results in by_channel.items():
        scores = [_arena_case_score(result, cases.get(result.test_case_id)) for result in channel_results]
        pair_count = pair_count_by_channel[channel_id]
        win_rate = _pct(wins_by_channel[channel_id], pair_count) or 0.0
        avg_case_score = _avg(scores) or 0.0
        score = (win_rate * 0.55) + (avg_case_score * 0.45)
        labels = sorted({label for result in channel_results for label in (result.labels or [])})
        rankings.append(
            {
                "channel_id": channel_id,
                "score": round(score, 2),
                "win_rate": round(win_rate, 2),
                "wins": round(wins_by_channel[channel_id], 2),
                "pair_count": pair_count,
                "avg_case_score": round(avg_case_score, 2),
                "case_count": len({result.test_case_id for result in channel_results}),
                "labels": labels,
                "top_losses": sorted(top_losses_by_channel[channel_id], key=lambda item: item["margin"], reverse=True)[:5],
            }
        )
    return sorted(rankings, key=lambda item: item["score"], reverse=True)


def arena_matrix_for_results(results: list[Result], cases: dict[str, TestCase]) -> list[dict[str, Any]]:
    channel_ids = sorted({result.channel_id for result in results})
    rankings = {item["channel_id"]: item for item in arena_rankings_for_results(results, cases)}
    rows = []
    for left in channel_ids:
        row: dict[str, Any] = {"channel_id": left}
        for right in channel_ids:
            if left == right:
                row[right] = None
                continue
            left_score = rankings.get(left, {}).get("score", 0)
            right_score = rankings.get(right, {}).get("score", 0)
            row[right] = round(left_score - right_score, 2)
        rows.append(row)
    return rows


def arena_judge_evidence(results: list[Result], cases: dict[str, TestCase], arena_config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    judge_channel_id = arena_config.get("judge_channel_id")
    judge_mode = arena_config.get("judge_mode") or "direct_score"
    rubric = arena_config.get("judge_rubric") or "Score answer quality, instruction following, safety, and protocol faithfulness."
    by_channel: dict[str, list[Result]] = defaultdict(list)
    for result in results:
        by_channel[result.channel_id].append(result)
    evidence: dict[str, dict[str, Any]] = {}
    for channel_id, channel_results in by_channel.items():
        case_scores = []
        for result in channel_results:
            case = cases.get(result.test_case_id)
            case_scores.append({"test_case_id": result.test_case_id, "score": round(_arena_case_score(result, case), 2), "labels": result.labels or []})
        avg_score = _avg([item["score"] for item in case_scores]) or 0.0
        evidence[channel_id] = {
            "judge_channel_id": judge_channel_id,
            "judge_mode": judge_mode,
            "rubric": rubric,
            "automated": True,
            "avg_judge_score": round(avg_score, 2),
            "sample_count": len(case_scores),
            "low_confidence_samples": sorted(case_scores, key=lambda item: item["score"])[:5],
            "note": "Mock/local judge evidence uses deterministic scoring; live judge calls can reuse this evidence shape without storing credentials.",
        }
    return evidence


def _arena_case_score(result: Result, case: TestCase | None) -> float:
    response = result.normalized_response or {}
    text = response.get("content_text") or ""
    latency = _metric_number(result, "latency_ms") or 0
    score = result.score * 0.85
    if text:
        score += min(10, len(text) / 160)
    if latency > 5000:
        score -= 5
    return max(0.0, min(100.0, score * case_weight(case)))


def _arena_loss_evidence(loser: Result, winner: Result, case_id: str, winner_score: float, loser_score: float) -> dict[str, Any]:
    return {
        "test_case_id": case_id,
        "winner_channel_id": winner.channel_id,
        "loser_channel_id": loser.channel_id,
        "winner_score": round(winner_score, 2),
        "loser_score": round(loser_score, 2),
        "margin": round(winner_score - loser_score, 2),
        "labels": loser.labels or [],
    }


def build_run_summary(db: Session, run_id: str) -> dict[str, Any]:
    run = db.get(Run, run_id)
    if not run:
        raise ValueError("Run not found")
    results = db.scalars(select(Result).where(Result.run_id == run_id)).all()
    comparisons = db.scalars(select(Comparison).where(Comparison.run_id == run_id)).all()
    reports = db.scalars(select(Report).where(Report.run_id == run_id)).all()
    channels = {channel.id: channel for channel in db.scalars(select(Channel)).all()}
    labels = [label for result in results for label in (result.labels or [])]
    labels.extend(label for comparison in comparisons for label in (comparison.labels or []))
    report_top_evidence = [
        item
        for report in reports
        for item in ((report.evidence or {}).get("top_evidence") or [])
        if isinstance(item, dict)
    ]
    cases = {case.id: case for case in db.scalars(select(TestCase)).all()}
    arena_results = _arena_candidate_results(db, run_id, list(results)) if run.mode == "arena_comparison" else []
    performance_results = arena_results if run.mode == "arena_comparison" else results
    return {
        "run": run,
        "channel_count": len({result.channel_id for result in results}),
        "result_count": len(results),
        "comparison_count": len(comparisons),
        "report_count": len(reports),
        "avg_score": _avg([result.score for result in results]),
        "avg_latency_ms": _avg([_metric_number(result, "latency_ms") for result in results]),
        "avg_ttft_ms": _avg([_metric_number(result, "ttft_ms") for result in results]),
        "avg_tpot_ms": _avg([_metric_number(result, "tpot_ms") for result in results]),
        "avg_tokens_per_second": _avg([_metric_number(result, "tokens_per_second") for result in results]),
        "success_rate": _pct(len([result for result in results if not (result.normalized_response or {}).get("error")]), len(results)),
        "p95_latency_ms": _percentile([_metric_number(result, "latency_ms") for result in results], 95),
        "grade_distribution": _count_values([report.grade for report in reports]),
        "label_distribution": _count_values(labels),
        "performance_by_channel": performance_by_channel_for_results(performance_results, channels),
        "arena_rankings": arena_rankings_for_results(arena_results, cases) if run.mode == "arena_comparison" else [],
        "top_evidence": report_top_evidence[:8],
    }


def performance_by_channel_for_results(results: list[Result], channels: dict[str, Channel]) -> list[dict[str, Any]]:
    grouped: dict[str, list[Result]] = defaultdict(list)
    for result in results:
        grouped[result.channel_id].append(result)
    rows = []
    for channel_id, items in grouped.items():
        summary = performance_summary_for_results(items)
        rows.append(
            {
                "channel_id": channel_id,
                "channel_name": channels.get(channel_id).name if channels.get(channel_id) else channel_id,
                **summary,
            }
        )
    return sorted(rows, key=lambda item: (-(item.get("success_rate") or 0), item.get("p95_latency_ms") or 999999, item["channel_name"]))


def special_report_markdown(channel: Channel, title: str, score: float, grade: str, summary: str, evidence: dict[str, Any]) -> str:
    labels = ", ".join(evidence.get("labels") or []) or "未发现显著异常"
    performance = evidence.get("performance") or {}
    arena = evidence.get("arena") or {}
    return f"""# {title}

## 基本信息

- 渠道：{channel.name}
- 声称模型：{channel.model_name or "未配置"}
- 评级：{grade}
- 总分：{score:.1f} / 100
- 结论：{summary}
- 异常标签：{labels}

## 性能指标

- 成功率：{performance.get("success_rate", "-")}%
- P95 延迟：{performance.get("p95_latency_ms", "-")} ms
- 平均 TTFT：{performance.get("avg_ttft_ms", "-")} ms
- 平均 TPOT：{performance.get("avg_tpot_ms", "-")} ms
- 平均吞吐：{performance.get("avg_tokens_per_second", "-")} tokens/s

## Arena 指标

- 胜率：{arena.get("win_rate", "-")}%
- 平均题目分：{arena.get("avg_case_score", "-")}
- 对战样本数：{arena.get("pair_count", "-")}
"""


def list_report_summaries(db: Session) -> list[dict[str, Any]]:
    reports = list(db.scalars(select(Report).order_by(Report.created_at.desc())).all())
    return [_report_summary(db, report) for report in reports if db.get(Run, report.run_id) and db.get(Channel, report.channel_id)]


def get_report_detail(db: Session, report_id: str) -> dict[str, Any] | None:
    report = db.get(Report, report_id)
    if not report:
        return None
    run = db.get(Run, report.run_id)
    channel = db.get(Channel, report.channel_id)
    if not run or not channel:
        return None

    suite = db.get(TestSuite, run.suite_id)
    cases = list(
        db.scalars(
            select(TestCase)
            .where(TestCase.suite_id == run.suite_id)
            .order_by(TestCase.sort_order, TestCase.id)
        ).all()
    )
    results = list(
        db.scalars(
            select(Result)
            .where(Result.run_id == run.id, Result.channel_id == channel.id)
            .order_by(Result.test_case_id, Result.attempt_index, Result.created_at)
        ).all()
    )
    comparisons = list(
        db.scalars(
            select(Comparison)
            .where(Comparison.run_id == run.id, Comparison.candidate_channel_id == channel.id)
            .order_by(Comparison.test_case_id)
        ).all()
    )
    baseline_results = _baseline_results_for_run(db, run)
    prediction_rows = _prediction_rows(cases, results, comparisons, baseline_results)
    return {
        "report": ReportRead.model_validate(report),
        "run": RunRead.model_validate(run),
        "channel": ChannelRead.model_validate(channel),
        "suite": TestSuiteRead.model_validate(suite) if suite else None,
        "cases": [TestCaseRead.model_validate(case) for case in cases],
        "results": [ResultRead.model_validate(result) for result in results],
        "comparisons": [ComparisonRead.model_validate(comparison) for comparison in comparisons],
        "baseline_results": [BaselineResultRead.model_validate(result) for result in baseline_results],
        "prediction_rows": prediction_rows,
        "performance_summary": performance_summary_for_results(results),
    }


def compare_reports(db: Session, report_ids: list[str]) -> dict[str, Any]:
    reports = [db.get(Report, report_id) for report_id in report_ids]
    missing = [report_id for report_id, report in zip(report_ids, reports) if report is None]
    if missing:
        raise ValueError(f"Report not found: {', '.join(missing)}")

    concrete_reports = [report for report in reports if report is not None]
    run_modes = {
        (db.get(Run, report.run_id).mode if db.get(Run, report.run_id) else "unknown")
        for report in concrete_reports
    }
    if len(run_modes) > 1:
        raise ValueError("Report modes must match for comparison")
    mode = next(iter(run_modes), "unknown")
    summaries = [_report_summary(db, report) for report in concrete_reports]
    dimensions = _compare_dimensions(concrete_reports)
    score_matrix = [
        {
            "dimension": dimension,
            **{
                report.id: ((report.evidence or {}).get("dimension_scores") or {}).get(dimension)
                for report in concrete_reports
            },
        }
        for dimension in dimensions
    ]
    performance_matrix = [
        {"report_id": summary["report_id"], "channel_name": summary["channel_name"], **summary["performance"]}
        for summary in summaries
    ]
    prediction_rows = _compare_prediction_rows(db, concrete_reports)
    label_diff = _label_diff(concrete_reports)
    return {
        "mode": mode,
        "reports": summaries,
        "dimensions": dimensions,
        "score_matrix": score_matrix,
        "prediction_rows": prediction_rows,
        "label_diff": label_diff,
        "performance_matrix": performance_matrix,
    }


def _report_summary(db: Session, report: Report) -> dict[str, Any]:
    run = db.get(Run, report.run_id)
    channel = db.get(Channel, report.channel_id)
    if not run or not channel:
        raise ValueError("Report has missing run or channel")
    results = list(db.scalars(select(Result).where(Result.run_id == run.id, Result.channel_id == channel.id)).all())
    evidence = report.evidence or {}
    return {
        "report_id": report.id,
        "run_id": run.id,
        "run_name": run.name,
        "mode": run.mode,
        "channel_id": channel.id,
        "channel_name": channel.name,
        "channel_role": channel.role,
        "suite_id": run.suite_id,
        "grade": report.grade,
        "final_score": report.final_score,
        "summary": report.summary,
        "labels": list(evidence.get("labels") or []),
        "dimension_scores": evidence.get("dimension_scores") or {},
        "performance": performance_summary_for_results(results),
        "created_at": report.created_at,
    }


def performance_summary_for_results(results: list[Result]) -> dict[str, Any]:
    latencies = sorted(_metric_number(result, "latency_ms") for result in results)
    latencies = [value for value in latencies if value is not None]
    first_tokens = sorted((_metric_number(result, "first_token_ms") or _metric_number(result, "ttft_ms")) for result in results)
    first_tokens = [value for value in first_tokens if value is not None]
    tpots = [_metric_number(result, "tpot_ms") for result in results]
    tps = [_metric_number(result, "tokens_per_second") for result in results]
    scores = [result.score for result in results]
    failures = [
        result for result in results
        if (result.normalized_response or {}).get("error") or "request_failed" in (result.labels or []) or (result.score <= 0 and result.labels)
    ]
    p95 = _percentile(latencies, 95)
    slow_threshold = max(5000.0, p95 or 0)
    slow_case_ids = sorted(
        {
            result.test_case_id
            for result in results
            if (_metric_number(result.metrics, "latency_ms") or 0) >= slow_threshold
        }
    )
    total = len(results)
    failure_count = len(failures)
    success_count = max(0, total - failure_count)
    success_rate = round(success_count / total * 100, 2) if total else 0.0
    failure_rate = round(failure_count / total * 100, 2) if total else 0.0
    return {
        "request_count": total,
        "error_count": failure_count,
        "success_rate": success_rate,
        "avg_score": _avg(scores),
        "avg_latency_ms": _avg(latencies),
        "p50_latency_ms": _percentile(latencies, 50),
        "p95_latency_ms": p95,
        "p99_latency_ms": _percentile(latencies, 99),
        "avg_ttft_ms": _avg(first_tokens),
        "avg_tpot_ms": _avg(tpots),
        "avg_tokens_per_second": _avg(tps),
        "latency_avg_ms": _avg(latencies),
        "latency_p50_ms": _percentile(latencies, 50),
        "latency_p95_ms": p95,
        "latency_p99_ms": _percentile(latencies, 99),
        "first_token_avg_ms": _avg(first_tokens),
        "first_token_p95_ms": _percentile(first_tokens, 95),
        "success_count": success_count,
        "failure_count": failure_count,
        "failure_rate": failure_rate,
        "slow_case_ids": slow_case_ids,
    }


def _prediction_rows(
    cases: list[TestCase],
    results: list[Result],
    comparisons: list[Comparison],
    baseline_results: list[BaselineResult],
) -> list[dict[str, Any]]:
    result_by_case: dict[str, list[Result]] = defaultdict(list)
    for result in results:
        result_by_case[result.test_case_id].append(result)
    comparison_by_case = {comparison.test_case_id: comparison for comparison in comparisons}
    baseline_by_case: dict[str, list[BaselineResult]] = defaultdict(list)
    for result in baseline_results:
        baseline_by_case[result.test_case_id].append(result)

    rows: list[dict[str, Any]] = []
    for case in cases:
        latest = _latest_result(result_by_case.get(case.id, []))
        comparison = comparison_by_case.get(case.id)
        row_labels = sorted(set((latest.labels if latest else []) or []) | set((comparison.labels if comparison else []) or []))
        rows.append(
            {
                "test_case_id": case.id,
                "title": case.title,
                "module": case.module,
                "sort_order": case.sort_order,
                "prompt": case.prompt,
                "system_prompt": case.system_prompt,
                "request_params": case.request_params,
                "scoring_rules": case.scoring_rules,
                "result": ResultRead.model_validate(latest) if latest else None,
                "baseline_results": [BaselineResultRead.model_validate(result) for result in baseline_by_case.get(case.id, [])],
                "comparison": ComparisonRead.model_validate(comparison) if comparison else None,
                "labels": row_labels,
                "score": comparison.final_score if comparison else (latest.score if latest else None),
                "latency_ms": _metric_number(latest.metrics if latest else None, "latency_ms"),
            }
        )
    return rows


def _compare_prediction_rows(db: Session, reports: list[Report]) -> list[dict[str, Any]]:
    details = [get_report_detail(db, report.id) for report in reports]
    concrete_details = [detail for detail in details if detail]
    case_meta: dict[str, dict[str, Any]] = {}
    row_by_case_report: dict[tuple[str, str], dict[str, Any]] = {}
    for detail in concrete_details:
        report_id = detail["report"].id
        for row in detail["prediction_rows"]:
            case_meta.setdefault(
                row["test_case_id"],
                {
                    "test_case_id": row["test_case_id"],
                    "title": row["title"],
                    "module": row["module"],
                    "sort_order": row["sort_order"],
                    "prompt": row["prompt"],
                },
            )
            result = row["result"]
            comparison = row["comparison"]
            row_by_case_report[(row["test_case_id"], report_id)] = {
                "result": result.model_dump() if result else None,
                "comparison": comparison.model_dump() if comparison else None,
                "labels": row["labels"],
                "score": row["score"],
                "latency_ms": row["latency_ms"],
            }
    output: list[dict[str, Any]] = []
    for case_id, meta in sorted(case_meta.items(), key=lambda item: (item[1]["sort_order"], item[0])):
        output.append(
            {
                **meta,
                "reports": {
                    report.id: row_by_case_report.get((case_id, report.id))
                    for report in reports
                },
            }
        )
    return output


def _baseline_results_for_run(db: Session, run: Run) -> list[BaselineResult]:
    if not run.baseline_snapshot_id:
        return []
    snapshot = db.get(BaselineSnapshot, run.baseline_snapshot_id)
    if not snapshot:
        return []
    refresh_baseline_status(db, snapshot)
    return list(
        db.scalars(
            select(BaselineResult)
            .where(BaselineResult.baseline_snapshot_id == snapshot.id)
            .order_by(BaselineResult.test_case_id, BaselineResult.channel_id, BaselineResult.attempt_index)
        ).all()
    )


def _latest_result(results: list[Result]) -> Result | None:
    if not results:
        return None
    return sorted(results, key=lambda result: (result.attempt_index, str(result.created_at or "")), reverse=True)[0]


def _metric_number(source: Result | dict[str, Any] | None, key: str) -> float | None:
    metrics = source.metrics if isinstance(source, Result) else source
    value = (metrics or {}).get(key)
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _avg(values: list[float | None]) -> float | None:
    clean = [float(value) for value in values if isinstance(value, (int, float))]
    return round(sum(clean) / len(clean), 2) if clean else None


def _percentile(values: list[float | None], percentile: int) -> float | None:
    clean = sorted(float(value) for value in values if isinstance(value, (int, float)))
    if not clean:
        return None
    if len(clean) == 1:
        return round(clean[0], 2)
    position = (len(clean) - 1) * percentile / 100
    lower = int(position)
    upper = min(lower + 1, len(clean) - 1)
    weight = position - lower
    return round(clean[lower] * (1 - weight) + clean[upper] * weight, 2)


def _pct(numerator: float, denominator: float) -> float | None:
    if denominator <= 0:
        return None
    return round(numerator / denominator * 100, 2)


def _count_values(values: list[str]) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for value in values:
        if value:
            counts[value] += 1
    return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))


def _compare_dimensions(reports: list[Report]) -> list[str]:
    dimensions: list[str] = []
    for report in reports:
        for dimension in ((report.evidence or {}).get("dimension_scores") or {}).keys():
            if dimension not in dimensions:
                dimensions.append(dimension)
    return dimensions or ["authenticity", "quality", "stability"]


def _label_diff(reports: list[Report]) -> dict[str, list[str]]:
    label_sets = {
        report.id: set((report.evidence or {}).get("labels") or [])
        for report in reports
    }
    all_labels = set().union(*label_sets.values()) if label_sets else set()
    common = set.intersection(*label_sets.values()) if label_sets else set()
    diff: dict[str, list[str]] = {"common": sorted(common)}
    for report_id, labels in label_sets.items():
        other_labels = set().union(*(items for key, items in label_sets.items() if key != report_id))
        diff[report_id] = sorted(labels - other_labels)
    diff["all"] = sorted(all_labels)
    return diff


def weighted_comparison_score(items: list[Comparison], cases: dict[str, TestCase]) -> float:
    weighted_sum = 0.0
    weight_sum = 0.0
    for item in items:
        weight = case_weight(cases.get(item.test_case_id))
        weighted_sum += item.final_score * weight
        weight_sum += weight
    return weighted_sum / weight_sum if weight_sum else 0.0


def case_weight(case: TestCase | None) -> float:
    if not case:
        return 1.0
    try:
        return max(0.1, float((case.scoring_rules or {}).get("weight", 1.0)))
    except (TypeError, ValueError):
        return 1.0


def case_dimension(case: TestCase | None) -> str:
    if not case:
        return "quality"
    dimension = (case.scoring_rules or {}).get("risk_dimension")
    if dimension in {"authenticity", "quality", "stability"}:
        return dimension
    if case.module in {"protocol", "identity", "websearch"}:
        return "authenticity"
    return "quality"


def dimension_scores_for(items: list[Comparison], cases: dict[str, TestCase]) -> dict[str, float | None]:
    grouped: dict[str, list[Comparison]] = defaultdict(list)
    for item in items:
        grouped[case_dimension(cases.get(item.test_case_id))].append(item)
    scores: dict[str, float | None] = {}
    for dimension in ["authenticity", "quality", "stability"]:
        dimension_items = grouped.get(dimension, [])
        scores[dimension] = round(weighted_comparison_score(dimension_items, cases), 2) if dimension_items else None
    return scores


GRADE_ORDER = ["A", "B", "C", "D", "E"]


def capped_grade_from_score(score: float, labels: list[str] | None = None) -> str:
    grade = grade_from_score(score, labels)
    red_flags = set(labels or []).intersection(ALERT_RED_FLAGS)
    if "max_tokens_not_enforced" in red_flags or "tool_use_invalid" in red_flags or "protocol_mismatch" in red_flags:
        return worse_grade(grade, "D")
    if len(red_flags) >= 2:
        return worse_grade(grade, "C")
    if len(red_flags) == 1:
        return worse_grade(grade, "B")
    return grade


def worse_grade(current: str, cap: str) -> str:
    return GRADE_ORDER[max(GRADE_ORDER.index(current), GRADE_ORDER.index(cap))]


LABEL_EXPLANATIONS = {
    "protocol_mismatch": "响应结构不是 Anthropic 原生 message 形态，可能存在中转格式转换或模型替换。",
    "usage_missing": "响应缺少 usage/token 统计，说明渠道没有完整保留原生计量字段。",
    "message_id_mismatch": "message id 前缀不符合 Claude 原生响应特征。",
    "message_id_family_mismatch": "message id 不属于 Claude/Bedrock/Vertex 常见家族前缀，疑似非原生 Claude 响应。",
    "tool_use_invalid": "要求工具调用时未返回 tool_use 结构。",
    "tool_name_mismatch": "工具调用名称与预期 schema 不一致。",
    "tool_input_mismatch": "工具调用参数与预期输入不一致。",
    "tool_schema_invalid": "工具调用参数未通过题目要求的轻量 schema 校验。",
    "max_tokens_not_enforced": "极小 max_tokens 限制未被严格执行。",
    "max_tokens_output_too_long": "输出长度超过本题允许的截断范围。",
    "stop_sequence_not_enforced": "stop sequence 没有按预期触发。",
    "stop_sequence_leaked": "输出中泄露了应触发截断的 stop sequence。",
    "streaming_event_missing": "流式响应缺少关键结束事件。",
    "json_invalid": "要求严格 JSON 时返回了非法 JSON。",
    "json_object_expected": "要求 JSON 对象时返回的不是对象。",
    "json_schema_invalid": "JSON 输出未通过题目要求的字段类型、枚举或数组长度校验。",
    "exact_output_mismatch": "要求精确输出时包含了额外内容或内容不一致。",
    "output_too_short": "输出明显短于题目要求，可能是截断或模型能力不足。",
    "web_honesty_missing": "无联网工具场景下没有诚实说明无法实时查询。",
    "required_keypoint_missing": "缺少题目要求的关键答案点。",
    "regex_keypoint_missing": "输出未命中题目要求的正则关键点。",
    "forbidden_pattern_hit": "输出命中题目禁止的正则模式。",
    "identity_mismatch": "身份或安全边界出现明显异常表述。",
    "unsafe_response": "安全题中给出了不应提供的危险或违法内容。",
    "suspected_model_swap": "负样本或候选渠道表现出疑似模型替换特征。",
    "latency_outlier": "延迟明显偏高，可能存在中转链路或路由异常。",
    "ttft_outlier": "首 token 延迟明显偏高，用户首屏等待风险较高。",
    "performance_error_rate_high": "性能诊断请求失败率偏高，渠道可用性或限流策略需要复核。",
    "repeat_inconsistent": "同一题多次运行输出差异过大，存在稳定性或混路由风险。",
    "baseline_gold_missing": "当前题缺少 Anthropic 官方金标基线。",
    "baseline_cloud_missing": "当前题缺少官方云参考基线。",
    "invalid_request_not_rejected": "无效请求没有被正确拒绝。",
    "request_failed": "请求失败，未获得可评分响应。",
    "channel_preflight_failed": "渠道预检失败，已停止该渠道剩余题目的正式请求。",
    "signature_interop_failed": "Thinking Signature 互通检测未通过，relay 无法复用 source 生成的签名 thinking block。",
    "thinking_temperature_not_rejected": "启用 thinking 时携带非 1 temperature 未被上游拒绝，疑似中间层改写或非原生协议。",
    "thinking_adaptive_enabled_not_rejected": "thinking.adaptive.enabled 未被上游拒绝，疑似中间层改写、吞参或非原生 AWS/Claude 路径。",
    "thinking_adaptive_enabled_wrong_error": "上游返回了错误，但错误内容不是 thinking.adaptive.enabled 目标参数的原生拒绝。",
    "signature_source_missing": "未找到可用的参考 source 渠道，无法执行 Thinking Signature 互通检测。",
    "provider_error_variant": "上游返回了等价的 thinking/temperature 原生约束错误，视为通过但保留差异标签。",
    "unexpected_error_response": "上游返回错误，但错误内容未命中该探针预期的 thinking/temperature 约束。",
}


def label_explanations(labels: list[str]) -> list[dict[str, str]]:
    explanations = []
    for label in labels:
        base_label = label.split(":", 1)[0] if ":" in label else label
        explanations.append({"label": label, "description": LABEL_EXPLANATIONS.get(label) or LABEL_EXPLANATIONS.get(base_label) or "检测项返回异常，需要结合原始响应复核。"})
    return explanations


def top_evidence_for(items: list[Comparison], cases: dict[str, TestCase], limit: int = 5) -> list[dict[str, Any]]:
    ranked = sorted(items, key=lambda item: (item.final_score, -case_weight(cases.get(item.test_case_id))))
    evidence: list[dict[str, Any]] = []
    for item in ranked[:limit]:
        case = cases.get(item.test_case_id)
        evidence.append(
            {
                "test_case_id": item.test_case_id,
                "title": case.title if case else item.test_case_id,
                "module": case.module if case else "unknown",
                "score": item.final_score,
                "labels": item.labels or [],
                "impact": case_dimension(case),
            }
        )
    return evidence


def confidence_for(run: Run | None, snapshot: BaselineSnapshot | None, items: list[Comparison], labels: list[str]) -> str:
    if not run:
        return "low"
    if any(label in labels for label in ["baseline_gold_missing", "baseline_cloud_missing", "request_failed"]):
        return "low"
    if run.test_scope == "quick" or run.repeat_count < 2:
        return "medium"
    if snapshot and snapshot.expires_at and (_as_utc(snapshot.expires_at) - datetime.now(timezone.utc)).days < 3:
        return "medium"
    return "high" if len(items) >= 20 else "medium"


def _summary_for(grade: str) -> str:
    return {
        "A": "高度可信，接近纯官方与官方云参考。",
        "B": "基本可信，可能存在轻微中转层差异。",
        "C": "疑似改参数、降级或存在明显中间层影响。",
        "D": "疑似非原生 Claude 或严重偏离官方行为。",
        "E": "高风险，不建议标称 Claude 官方同等质量。",
    }[grade]


def report_markdown(channel: Channel, score: float, grade: str, summary: str, evidence: dict[str, Any]) -> str:
    labels = ", ".join(evidence["labels"]) or "未发现显著异常"
    dimensions = evidence.get("dimension_scores") or {}
    label_lines = "\n".join(
        f"- {item['label']}：{item['description']}"
        for item in evidence.get("label_explanations", [])[:8]
    ) or "- 未发现显著异常标签"
    top_lines = "\n".join(
        f"{index + 1}. {item['title']}（{item['impact']}）：{item['score']:.1f}，标签 {', '.join(item['labels']) or '无'}"
        for index, item in enumerate(evidence.get("top_evidence", [])[:5])
    ) or "暂无异常证据"
    baseline_line = (
        f"- 复用官方基线：{evidence.get('baseline_name')} ({evidence.get('baseline_snapshot_id')})\n"
        f"- 基线生成时间：{evidence.get('baseline_ready_at') or '未记录'}\n"
        f"- 基线过期时间：{evidence.get('baseline_expires_at') or '未记录'}\n"
        if evidence.get("baseline_snapshot_id")
        else "- 基线模式：本次任务内同步对比\n"
    )
    signature_line = signature_interop_markdown(evidence.get("signature_interop"))
    return f"""# Claude 渠道真实性测评报告

## 基本信息

- 待测渠道：{channel.name}
- 声称模型：{channel.model_name or "未配置"}
- 测试时间：{datetime.now(timezone.utc).isoformat()}
- 基线渠道：Anthropic Official、AWS Bedrock Claude、Azure AI Foundry Claude
{baseline_line}

## 综合结论

- 评级：{grade}
- 总分：{score:.1f} / 100
- 真实性分：{_fmt_optional_score(dimensions.get("authenticity"))}
- 质量分：{_fmt_optional_score(dimensions.get("quality"))}
- 稳定性分：{_fmt_optional_score(dimensions.get("stability"))}
- 置信度：{evidence.get("confidence", "medium")}
- 结论：{summary}

## 主要证据

1. 与 Anthropic 官方金标平均相似度：{evidence["avg_gold_similarity"]:.1f}%
2. 与 AWS/Azure 官方云参考平均相似度：{evidence["avg_official_cloud_similarity"]:.1f}%
3. 异常标签：{labels}
4. 参与对比题目数：{evidence["comparison_count"]}

## 关键异常题

{top_lines}

## 异常解释

{label_lines}

## Thinking Signature 互通

{signature_line}

## 风险说明

本报告不写“100% 真/假”，只基于协议、能力、工具调用、截断、多轮上下文、安全边界和稳定性证据给出风险评级。若本次复用了历史官方基线，只代表与该基线快照的差异，不证明渠道永久可信。
"""


def render_report_markdown(db: Session, report: Report) -> str:
    current = (report.markdown or "").strip()
    if current:
        return current

    run = db.get(Run, report.run_id)
    channel = db.get(Channel, report.channel_id)
    if not run or not channel:
        return (report.summary or "").strip()

    evidence = report.evidence or {}
    summary = report.summary or _summary_for(report.grade)
    mode = str(evidence.get("mode") or run.mode or "").strip()
    if evidence.get("test_scope") == "scheduled_probe" or run.test_scope == "scheduled_probe" or mode == "scheduled_probe":
        return scheduled_probe_markdown(channel, report.final_score, report.grade, summary, evidence)
    if mode == "performance_benchmark" or run.mode == "performance_benchmark":
        return special_report_markdown(channel, "性能诊断报告", report.final_score, report.grade, summary, evidence)
    if mode == "arena_comparison" or run.mode == "arena_comparison":
        return special_report_markdown(channel, "Arena 排名报告", report.final_score, report.grade, summary, evidence)
    if mode in {"candidate_eval", "full_comparison", MANUAL_PROBE_MODE} or any(key in evidence for key in ("avg_gold_similarity", "avg_official_cloud_similarity", "comparison_count", "dimension_scores")):
        normalized_evidence = _normalized_report_evidence(evidence)
        return report_markdown(channel, report.final_score, report.grade, summary, normalized_evidence)
    return _generic_report_markdown(run, channel, report, summary, evidence)


def hydrate_report_markdown(db: Session, report: Report) -> bool:
    rendered = render_report_markdown(db, report)
    current = report.markdown or ""
    if rendered == current.strip():
        if current and current != current.strip():
            report.markdown = current.strip()
            return True
        return False
    report.markdown = rendered
    return True


def _normalized_report_evidence(evidence: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(evidence)
    normalized["labels"] = [str(label) for label in (evidence.get("labels") or []) if str(label).strip()]
    normalized.setdefault("avg_gold_similarity", 0.0)
    normalized.setdefault("avg_official_cloud_similarity", 0.0)
    normalized.setdefault("comparison_count", 0)
    normalized.setdefault("confidence", "medium")
    normalized.setdefault("dimension_scores", {})
    normalized.setdefault("label_explanations", [])
    normalized.setdefault("top_evidence", [])
    normalized.setdefault("signature_interop", {})
    return normalized


def _generic_report_markdown(run: Run, channel: Channel, report: Report, summary: str, evidence: dict[str, Any]) -> str:
    labels = ", ".join(str(label) for label in (evidence.get("labels") or []) if str(label).strip()) or "未发现显著异常"
    evidence_block = json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True) if evidence else "{}"
    return f"""# 报告摘要

## 基本信息

- 渠道：{channel.name}
- 声称模型：{channel.model_name or "未配置"}
- 运行模式：{run.mode}
- 评级：{report.grade}
- 总分：{report.final_score:.1f} / 100
- 结论：{summary}
- 异常标签：{labels}

## 证据

```json
{evidence_block}
```
"""


def signature_interop_markdown(signature: Any) -> str:
    if not isinstance(signature, dict):
        return "本次未执行 Thinking Signature 互通检测。"
    status = "通过" if signature.get("ok") else "未通过"
    steps = signature.get("steps") if isinstance(signature.get("steps"), list) else []
    step_lines = "\n".join(
        f"- {step.get('name', '步骤')}：{step.get('status', '-')}，{step.get('detail', '-')}"
        for step in steps[:5]
        if isinstance(step, dict)
    ) or "- 暂无步骤记录"
    return (
        f"- 结果：{status}\n"
        f"- 原因：{signature.get('reason') or '-'}\n"
        f"- Source：{signature.get('source_channel_id') or '-'} / {signature.get('source_message_channel_type') or '-'}\n"
        f"- Relay：{signature.get('relay_channel_id') or '-'} / {signature.get('relay_message_channel_type') or '-'}\n"
        f"- 兜底说明：{signature.get('fallback_note') or SIGNATURE_FALLBACK_NOTE}\n"
        f"{step_lines}"
    )


def _fmt_optional_score(value: Any) -> str:
    return "-" if value is None else f"{float(value):.1f} / 100"
