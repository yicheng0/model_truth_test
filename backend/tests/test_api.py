from __future__ import annotations

import os
import asyncio
import importlib.util
import json
import math
import time
import uuid
from pathlib import Path
from datetime import datetime, timedelta, timezone

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_claude_eval.db")
os.environ.setdefault("CORS_ORIGINS", "http://localhost:5173")
os.environ.setdefault("SKIP_BUILTIN_CHANNEL_CLEANUP", "1")
os.environ.setdefault("AUTO_SCHEDULER_ENABLED", "false")
os.environ.setdefault("RATE_LIMIT_PER_MINUTE", "0")
os.environ.setdefault("ADMIN_API_KEY", "test-admin-key")

from fastapi.testclient import TestClient
import httpx
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, delete, func, inspect, select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateColumn
from sqlalchemy.orm import close_all_sessions, sessionmaker

from app import database as database_module
from app.database import SessionLocal, engine, init_db
from app.job_store import InMemoryJobStore
from app.main import app, cors_origins
from app.models import AuditLog, BaselineResult, BaselineSnapshot, Channel, ChannelAlert, ChannelTaxonomySetting, ClaudeCodeEvidence, Comparison, FeishuBroadcastSetting, PatrolJob, PatrolJobAttempt, Report, Result, Run, RunChannel, ScheduledChannelTest, TestCase as TestCaseModel, TestSuite as TestSuiteModel
from app.schemas import BaselineBuildCreate, ChannelCreate, RunCreate, TestCaseCreate, TestSuiteCreate
from app.restored_seed import restored_seed_data
from app.suite_seed import default_cases
from app.services import _anthropic_compatible_call, _anthropic_messages_url, _aws_bedrock_messages_call, _live_call, _merged_channel_credentials, _openai_compatible_call, apply_repeat_consistency_scores, build_raw_request, build_scheduled_probe_report, build_smart_patrol_report, channel_alert_read, channel_fingerprint, classify_claude_message_id, create_alerts_for_run, create_baseline_build, create_case, create_channel, create_run, create_suite, default_channel_templates, execute_run, execute_scheduled_channel_test, feishu_text_payload, finalize_baseline_from_run, get_or_create_feishu_setting, get_auto_patrol_enabled, set_auto_patrol_enabled, invoke_channel, next_scheduled_run_at, refresh_active_scheduled_test_locks, request_fingerprint, scheduled_channel_test_read, scheduled_probe_classification, scheduled_test_loop, scheduled_test_tick, scheduler_enabled, score_result, seed_demo_data, seed_restored_fixture_data, smart_patrol_daily_text, suite_fingerprint

_backfill_path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "8c2e7db1f4a3_scheduled_tests_schema_backfill.py"
_backfill_spec = importlib.util.spec_from_file_location("scheduled_tests_backfill", _backfill_path)
assert _backfill_spec and _backfill_spec.loader
scheduled_tests_backfill = importlib.util.module_from_spec(_backfill_spec)
_backfill_spec.loader.exec_module(scheduled_tests_backfill)


ADMIN_HEADERS = {"X-Admin-Key": "test-admin-key"}


def reset_database() -> None:
    close_all_sessions()
    engine.dispose()
    if engine.url.get_backend_name() == "sqlite":
        db_path = Path(engine.url.database or "")
        if db_path.exists():
            db_path.unlink()
        for suffix in ("-journal", "-wal", "-shm"):
            sidecar = Path(f"{db_path}{suffix}")
            if sidecar.exists():
                sidecar.unlink()
    init_db()
    with SessionLocal() as db:
        for model in [AuditLog, PatrolJobAttempt, PatrolJob, ChannelAlert, ScheduledChannelTest, Report, Comparison, BaselineResult, BaselineSnapshot, Result, RunChannel, Run, TestCaseModel, TestSuiteModel, Channel, ChannelTaxonomySetting, FeishuBroadcastSetting]:
            db.execute(delete(model))
        db.commit()
        db.expunge_all()
        seed_demo_data(db)
        seed_test_channels(db)


def seed_test_channels(db) -> None:  # noqa: ANN001
    for channel in default_channel_templates():
        if not db.get(Channel, channel.id):
            create_channel(db, channel)


def create_ready_baseline(client: TestClient, name: str = "managed baseline") -> tuple[str, dict, dict]:
    suite_id = "claude_full_35"
    suffix = uuid.uuid4().hex[:12]
    with SessionLocal() as db:
        case_ids = list(db.scalars(select(TestCaseModel.id).where(TestCaseModel.suite_id == suite_id).order_by(TestCaseModel.sort_order)).all())
        run = Run(
            id=f"run_baseline_{suffix}",
            suite_id=suite_id,
            name=name,
            mode="baseline_build",
            test_scope="full",
            status="completed",
            repeat_count=1,
            concurrency=1,
            total_jobs=1,
            completed_jobs=1,
        )
        snapshot = BaselineSnapshot(
            id=f"base_{suffix}",
            name=name,
            suite_id=suite_id,
            source_run_id=run.id,
            status="ready",
            suite_fingerprint=suite_fingerprint(db, suite_id),
            request_fingerprint=request_fingerprint(db, suite_id),
            channel_fingerprint=channel_fingerprint(db, ["anthropic_official"]),
            channel_ids=["anthropic_official"],
        )
        run.baseline_snapshot_id = snapshot.id
        db.add(run)
        db.add(snapshot)
        for case_id in case_ids:
            db.add(
                BaselineResult(
                    id=f"bres_{suffix}_{case_id}",
                    baseline_snapshot_id=snapshot.id,
                    test_case_id=case_id,
                    channel_id="anthropic_official",
                    role_in_baseline="reference",
                    attempt_index=1,
                    normalized_response={"text": "baseline"},
                    raw_request={},
                    raw_response={},
                    metrics={},
                    score=100,
                    labels=[],
                )
            )
        db.commit()
        run_payload = {"id": run.id}
        snapshot_payload = {
            "id": snapshot.id,
            "source_run_id": snapshot.source_run_id,
            "suite_id": snapshot.suite_id,
            "status": snapshot.status,
        }
    return suite_id, run_payload, snapshot_payload


def create_patrol_schedule(client: TestClient, **overrides) -> dict:  # noqa: ANN001
    payload = {
        "name": "policy patrol",
        "channel_id": "third_party_demo",
        "interval_minutes": 60,
        "enabled": True,
        **overrides,
    }
    response = client.post("/api/scheduled-tests", json=payload)
    assert response.status_code == 200
    return response.json()


def create_legacy_patrol_schedule(client: TestClient, **overrides) -> dict:  # noqa: ANN001
    suite_id, _run, snapshot = create_ready_baseline(client, overrides.pop("baseline_name", "patrol policy baseline"))
    payload = {
        "name": "policy patrol",
        "channel_id": "third_party_demo",
        "suite_id": suite_id,
        "baseline_snapshot_id": snapshot["id"],
        "interval_minutes": 60,
        "repeat_count": 1,
        "concurrency": 1,
        "use_mock": True,
        "test_scope": "full",
        "quiet_minutes": 0,
        **overrides,
    }
    response = client.post("/api/scheduled-tests", json=payload)
    assert response.status_code == 200
    return response.json()


def create_report_for_schedule(schedule: dict, *, grade: str, score: float, labels: list[str] | None = None) -> str:
    suffix = uuid.uuid4().hex[:12]
    with SessionLocal() as db:
        run = Run(
            id=f"run_policy_{suffix}",
            suite_id=schedule["suite_id"],
            name="policy run",
            mode="candidate_eval",
            test_scope="full",
            baseline_snapshot_id=schedule["baseline_snapshot_id"],
            scheduled_test_id=schedule["id"],
            status="completed",
            repeat_count=1,
            concurrency=1,
            total_jobs=1,
            completed_jobs=1,
        )
        report = Report(
            id=f"rep_policy_{suffix}",
            run_id=run.id,
            channel_id=schedule["channel_id"],
            final_score=score,
            grade=grade,
            summary="policy report",
            evidence={"labels": labels or [], "red_flags": labels or []},
            markdown="# policy report",
        )
        db.add(run)
        db.add(report)
        db.commit()
        return run.id


def manual_thinking_temperature_probe_case() -> TestCaseModel:
    return TestCaseModel(
        id="manual_thinking_temperature_probe",
        suite_id="manual_model_request_probe",
        module="manual_probe",
        title="AWS thinking temperature 纯度探针",
        prompt="请用一句话回答：这是 thinking temperature 纯度探针。",
        request_params={
            "max_tokens": 2048,
            "temperature": 0.2,
            "thinking": {"type": "enabled", "budget_tokens": 1024},
            "reasoning_effort": "medium",
        },
        scoring_rules={
            "expected_error_any": [
                "temperature may only be set to 1 when thinking is enabled",
                "temperature",
                "thinking",
            ],
            "expected_error_contains": "temperature may only be set to 1 when thinking is enabled",
            "expected_error_variant_any": ["temperature", "thinking"],
        },
        is_hidden=False,
        enabled=True,
    )


def manual_thinking_adaptive_enabled_probe_case() -> TestCaseModel:
    return TestCaseModel(
        id="manual_thinking_adaptive_enabled_probe",
        suite_id="manual_model_request_probe",
        module="manual_probe",
        title="thinking.adaptive.enabled 纯度探针",
        prompt="回复OK",
        request_params={
            "max_tokens": 2000,
            "temperature": 0,
            "thinking": {
                "type": "enabled",
                "adaptive": {"enabled": True},
                "budget_tokens": 8000,
                "max_tokens": 2000,
            },
        },
        scoring_rules={
            "expected_error_required_all": ["enabled", "not supported", "output_config.effort"],
            "expected_error_variant_any": ["temperature may only be set to 1 when thinking is enabled", "temperature", "thinking"],
            "expected_error_missing_label": "thinking_adaptive_enabled_not_rejected",
            "expected_error_variant_label": "provider_error_variant",
            "expected_error_unexpected_label": "thinking_adaptive_enabled_wrong_error",
        },
        is_hidden=False,
        enabled=True,
    )


def test_health_check_reports_database_ok() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_scheduled_tests_health_endpoint_is_not_shadowed() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.get("/api/scheduled-tests/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["instance_id"]
    assert {
        "enabled",
        "instance_id",
        "stale_schedule_count",
        "overdue_schedule_count",
        "overdue_job_count",
        "stale_attempt_count",
        "heartbeat_stale",
        "auto_scheduler_enabled_value",
        "queued_schedule_count",
        "running_schedule_count",
        "next_due_at",
    } <= set(payload)


def test_scheduler_enabled_always_starts_loop_regardless_of_env(monkeypatch) -> None:
    # 新语义：scheduler_enabled() 只决定启动时是否拉起循环，固定为 True；
    # 实际是否派发巡检改由数据库全局开关控制，不再受 AUTO_SCHEDULER_ENABLED 影响。
    monkeypatch.delenv("AUTO_SCHEDULER_ENABLED", raising=False)
    assert scheduler_enabled() is True
    for value in ["true", "false", "0", "off", "disabled", ""]:
        monkeypatch.setenv("AUTO_SCHEDULER_ENABLED", value)
        assert scheduler_enabled() is True


def test_auto_patrol_toggle_controls_dispatch_and_health() -> None:
    reset_database()
    # 默认开启
    with SessionLocal() as db:
        assert get_auto_patrol_enabled(db) is True

    with TestClient(app) as client:
        # 关闭：health.enabled -> False
        response = client.post("/api/scheduled-tests/auto-scheduler/toggle", json={"enabled": False})
        assert response.status_code == 200
        assert response.json()["enabled"] is False
        assert client.get("/api/scheduled-tests/health").json()["enabled"] is False

    # 关闭状态下，tick 不派发任何任务
    with SessionLocal() as db:
        assert get_auto_patrol_enabled(db) is False
    assert asyncio.run(scheduled_test_tick(SessionLocal)) == []

    with TestClient(app) as client:
        # 重新开启：health.enabled -> True
        response = client.post("/api/scheduled-tests/auto-scheduler/toggle", json={"enabled": True})
        assert response.status_code == 200
        assert response.json()["enabled"] is True
    with SessionLocal() as db:
        assert get_auto_patrol_enabled(db) is True


def test_docker_compose_enables_scheduler_by_default() -> None:
    compose = Path(__file__).resolve().parents[2] / "docker-compose.yml"
    content = compose.read_text(encoding="utf-8")
    assert "AUTO_SCHEDULER_ENABLED: ${AUTO_SCHEDULER_ENABLED:-true}" in content


def test_scheduled_tests_schema_backfill_migration_adds_missing_columns(tmp_path: Path) -> None:
    database_path = tmp_path / "legacy.db"
    database_url = f"sqlite:///{database_path.as_posix()}"
    engine_for_legacy = create_engine(database_url, connect_args={"check_same_thread": False})
    legacy_session = sessionmaker(bind=engine_for_legacy, autoflush=False, autocommit=False, expire_on_commit=False)
    previous_database_url = os.environ.get("DATABASE_URL")
    try:
        with engine_for_legacy.begin() as connection:
            connection.exec_driver_sql(
                """
                CREATE TABLE scheduled_channel_tests (
                    id VARCHAR PRIMARY KEY NOT NULL,
                    channel_id VARCHAR NOT NULL,
                    suite_id VARCHAR NOT NULL,
                    baseline_snapshot_id VARCHAR NOT NULL,
                    name VARCHAR(200) NOT NULL,
                    enabled BOOLEAN NOT NULL,
                    interval_minutes INTEGER NOT NULL,
                    test_scope VARCHAR(30) NOT NULL,
                    repeat_count INTEGER NOT NULL,
                    concurrency INTEGER NOT NULL,
                    use_mock BOOLEAN NOT NULL,
                    next_run_at DATETIME,
                    last_run_id VARCHAR,
                    last_status VARCHAR(30),
                    last_error TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
                )
                """
            )

        os.environ["DATABASE_URL"] = database_url
        cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
        cfg.set_main_option("sqlalchemy.url", database_url)
        command.upgrade(cfg, "head")

        columns = {column["name"] for column in inspect(engine_for_legacy).get_columns("scheduled_channel_tests")}
    finally:
        if previous_database_url is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previous_database_url

    assert {
        "run_window_start",
        "run_window_end",
        "alert_grade_threshold",
        "alert_score_threshold",
        "alert_red_flags_enabled",
        "quiet_minutes",
        "max_retries",
        "retry_interval_minutes",
        "locked_by",
        "locked_until",
        "last_queued_at",
        "last_started_at",
        "last_finished_at",
    } <= columns


def test_scheduled_tests_backfill_boolean_default_is_postgres_compatible() -> None:
    column = next(item for item in scheduled_tests_backfill.NEW_COLUMNS if item.name == "alert_red_flags_enabled")
    ddl = str(CreateColumn(column).compile(dialect=postgresql.dialect()))
    assert "DEFAULT true" in ddl
    assert "DEFAULT 1" not in ddl


def test_scheduled_tests_backfill_adds_alert_dedupe_key_column(tmp_path: Path) -> None:
    database_path = tmp_path / "legacy_alerts.db"
    database_url = f"sqlite:///{database_path.as_posix()}"
    engine_for_legacy = create_engine(database_url, connect_args={"check_same_thread": False})
    previous_database_url = os.environ.get("DATABASE_URL")
    try:
        with engine_for_legacy.begin() as connection:
            connection.exec_driver_sql(
                """
                CREATE TABLE channel_alerts (
                    id VARCHAR PRIMARY KEY NOT NULL,
                    scheduled_test_id VARCHAR,
                    run_id VARCHAR NOT NULL,
                    report_id VARCHAR NOT NULL,
                    channel_id VARCHAR NOT NULL,
                    status VARCHAR(30) NOT NULL,
                    severity VARCHAR(20) NOT NULL,
                    grade VARCHAR(2) NOT NULL,
                    final_score FLOAT,
                    trigger_labels JSON,
                    message TEXT,
                    notification_status VARCHAR(30) NOT NULL,
                    notification_error TEXT,
                    notification_attempt_count INTEGER NOT NULL,
                    last_notification_attempt_at DATETIME,
                    notified_at DATETIME,
                    reviewer_name VARCHAR(100),
                    review_note TEXT,
                    reviewed_at DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
                )
                """
            )

        os.environ["DATABASE_URL"] = database_url
        cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
        cfg.set_main_option("sqlalchemy.url", database_url)
        command.upgrade(cfg, "head")

        columns = {column["name"] for column in inspect(engine_for_legacy).get_columns("channel_alerts")}
        indexes = {index["name"] for index in inspect(engine_for_legacy).get_indexes("channel_alerts")}
    finally:
        if previous_database_url is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previous_database_url

    assert "dedupe_key" in columns
    assert "ix_channel_alerts_dedupe_key" in indexes


def test_init_db_repairs_head_database_missing_alert_dedupe_key(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "head_missing_alert_column.db"
    database_url = f"sqlite:///{database_path.as_posix()}"
    legacy_engine = create_engine(database_url, connect_args={"check_same_thread": False})
    with legacy_engine.begin() as connection:
        connection.exec_driver_sql(
            """
            CREATE TABLE alembic_version (
                version_num VARCHAR(32) NOT NULL,
                CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
            )
            """
        )
        connection.exec_driver_sql("INSERT INTO alembic_version (version_num) VALUES ('8c2e7db1f4a3')")
        connection.exec_driver_sql(
            """
            CREATE TABLE channel_alerts (
                id VARCHAR PRIMARY KEY NOT NULL,
                scheduled_test_id VARCHAR,
                run_id VARCHAR NOT NULL,
                report_id VARCHAR NOT NULL,
                channel_id VARCHAR NOT NULL,
                status VARCHAR(30) NOT NULL,
                severity VARCHAR(20) NOT NULL,
                grade VARCHAR(2) NOT NULL,
                final_score FLOAT,
                trigger_labels JSON,
                message TEXT,
                notification_status VARCHAR(30) NOT NULL,
                notification_error TEXT,
                notification_attempt_count INTEGER NOT NULL,
                last_notification_attempt_at DATETIME,
                notified_at DATETIME,
                reviewer_name VARCHAR(100),
                review_note TEXT,
                reviewed_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
            )
            """
        )

    previous_url = database_module.DATABASE_URL
    previous_engine = database_module.engine
    previous_session_local = database_module.SessionLocal
    patched_engine = create_engine(database_url, connect_args={"check_same_thread": False})
    patched_session = sessionmaker(bind=patched_engine, autoflush=False, autocommit=False, expire_on_commit=False)
    monkeypatch.setattr(database_module, "DATABASE_URL", database_url)
    monkeypatch.setattr(database_module, "engine", patched_engine)
    monkeypatch.setattr(database_module, "SessionLocal", patched_session)
    try:
        database_module.init_db()
        columns = {column["name"] for column in inspect(patched_engine).get_columns("channel_alerts")}
        indexes = {index["name"] for index in inspect(patched_engine).get_indexes("channel_alerts")}
    finally:
        monkeypatch.setattr(database_module, "DATABASE_URL", previous_url)
        monkeypatch.setattr(database_module, "engine", previous_engine)
        monkeypatch.setattr(database_module, "SessionLocal", previous_session_local)
        patched_engine.dispose()

    assert "dedupe_key" in columns
    assert "notification_attempt_count" in columns
    assert "last_notification_attempt_at" in columns
    assert "ix_channel_alerts_dedupe_key" in indexes


def test_scheduled_tests_list_tolerates_bad_probe_evidence() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        run = create_run(db, RunCreate(name="bad scheduled probe", suite_id=suite_id, use_mock=True))
        run.status = "completed"
        run.scheduled_test_id = "bad_schedule"
        report = Report(
            id="bad_probe_report",
            run_id=run.id,
            channel_id="third_party_demo",
            final_score=0,
            grade="E",
            evidence=["legacy bad evidence"],
        )
        schedule = ScheduledChannelTest(
            id="bad_schedule",
            channel_id="third_party_demo",
            suite_id=suite_id,
            baseline_snapshot_id="missing_baseline_for_bad_schedule",
            name="bad schedule",
            last_run_id=run.id,
            last_status="completed",
        )
        db.add(report)
        db.add(schedule)
        db.commit()

    with TestClient(app) as client:
        response = client.get("/api/scheduled-tests")

    assert response.status_code == 200
    schedule_payload = next(item for item in response.json() if item["id"] == "bad_schedule")
    assert schedule_payload["latest_report_id"] == "bad_probe_report"
    assert schedule_payload["latest_probe_summary"] is not None


def test_startup_seed_preserves_custom_default_cases_without_crashing() -> None:
    reset_database()
    with SessionLocal() as db:
        db.add(
            TestCaseModel(
                id="custom_startup_case",
                suite_id="claude_full_35",
                module="custom",
                sort_order=9999,
                title="Custom startup case",
                prompt="This case should survive startup seeding.",
                request_params={},
                scoring_rules={},
                is_hidden=False,
                enabled=True,
            )
        )
        db.commit()

    with TestClient(app) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    with SessionLocal() as db:
        assert db.get(TestCaseModel, "custom_startup_case") is not None


def test_reset_database_clears_custom_state_and_restores_defaults() -> None:
    reset_database()
    with SessionLocal() as db:
        db.add(
            Channel(
                id="temp_channel",
                name="Temp Channel",
                provider_type="third_party_anthropic",
                role="candidate",
                base_url="https://temp.example/v1",
                model_name="claude-temp",
                enabled=True,
            )
        )
        db.add(
            Run(
                id="temp_run",
                suite_id="claude_full_35",
                name="Temp Run",
                mode="full_comparison",
                test_scope="full",
                status="completed",
                repeat_count=1,
                concurrency=1,
                total_jobs=0,
                completed_jobs=0,
            )
        )
        db.commit()

    reset_database()

    with SessionLocal() as db:
        suite = db.get(TestSuiteModel, "claude_full_35")
        default_channels = list(db.scalars(select(Channel).order_by(Channel.id)).all())
        default_case_count = db.scalar(select(func.count()).select_from(TestCaseModel).where(TestCaseModel.suite_id == "claude_full_35"))

    assert suite is not None
    assert suite.version == "2026.05-representative-32"
    assert len(default_channels) == 6
    assert {channel.id for channel in default_channels} >= {
        "anthropic_official",
        "aws_bedrock",
        "azure_foundry",
        "negative_sample",
        "openai_compat_demo",
        "third_party_demo",
    }
    assert default_case_count == 32
    assert all(channel.id != "temp_channel" for channel in default_channels)


def test_seed_demo_data_uses_minimal_defaults_without_restored_fixture_side_effects() -> None:
    init_db()
    with SessionLocal() as db:
        for model in [AuditLog, PatrolJobAttempt, PatrolJob, ChannelTaxonomySetting, FeishuBroadcastSetting, ChannelAlert, ScheduledChannelTest, Report, Comparison, BaselineResult, BaselineSnapshot, Result, RunChannel, Run, TestCaseModel, TestSuiteModel, Channel]:
            db.execute(delete(model))
        db.commit()
        seed_demo_data(db)
        channels = db.scalars(select(Channel).order_by(Channel.id)).all()

    assert len(channels) == 6
    assert {channel.id for channel in channels} >= {"anthropic_official", "aws_bedrock", "third_party_demo", "negative_sample"}
    assert all(channel.id != "ch_c9c59513013b" for channel in channels)
    assert all("api_key" not in (channel.auth_config_encrypted or {}) for channel in channels)

    with SessionLocal() as db:
        db.execute(delete(Channel))
        db.commit()
        create_channel(
            db,
            ChannelCreate(
                id="custom_channel",
                name="Custom Channel",
                provider_type="third_party_anthropic",
                role="candidate",
                base_url="https://custom.example/v1",
                model_name="claude-custom",
                auth_config={"api_key": "keep-me"},
            ),
        )
        seed_demo_data(db)
        channels = db.scalars(select(Channel).order_by(Channel.id)).all()

    assert {channel.id for channel in channels} == {"custom_channel"}
    assert db.get(Channel, "custom_channel").auth_config == {"api_key": "keep-me"}


def test_restored_fixture_does_not_include_api_keys() -> None:
    data = restored_seed_data()
    assert len(data["channels"]) == 12
    assert len(data["test_suites"]) == 3
    assert len(data["test_cases"]) == 106
    for channel in data["channels"]:
        assert "api_key" not in (channel.get("auth_config") or {})


def test_list_endpoints_self_heal_empty_seed_tables() -> None:
    reset_database()
    with SessionLocal() as db:
        for model in [AuditLog, PatrolJobAttempt, PatrolJob, ChannelAlert, ScheduledChannelTest, Report, Comparison, BaselineResult, BaselineSnapshot, Result, RunChannel, Run, TestCaseModel, TestSuiteModel, Channel]:
            db.execute(delete(model))
        db.commit()

    with TestClient(app) as client:
        channels = client.get("/api/channels")
        suites = client.get("/api/suites")
        cases = client.get("/api/test-cases")

    assert channels.status_code == 200
    assert suites.status_code == 200
    assert cases.status_code == 200
    assert len(channels.json()) == 6
    assert len(suites.json()) == 1
    assert len(cases.json()) == 32
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Channel)) == 6
        assert db.scalar(select(func.count()).select_from(TestSuiteModel)) == 1
        assert db.scalar(select(func.count()).select_from(TestCaseModel)) == 32


def test_admin_reseed_restores_missing_seed_data_without_secret_overwrite() -> None:
    reset_database()
    with SessionLocal() as db:
        for model in [AuditLog, PatrolJobAttempt, PatrolJob, ChannelAlert, ScheduledChannelTest, Report, Comparison, BaselineResult, BaselineSnapshot, Result, RunChannel, Run, TestCaseModel, TestSuiteModel, Channel]:
            db.execute(delete(model))
        db.commit()
        create_channel(
            db,
            ChannelCreate(
                id="custom_channel",
                name="Custom Channel",
                provider_type="third_party_anthropic",
                role="candidate",
                base_url="https://custom.example/v1",
                model_name="claude-custom",
                auth_config={"api_key": "keep-me"},
            ),
        )

    with TestClient(app) as client:
        status_before = client.get("/api/seed-status", headers=ADMIN_HEADERS)
        response = client.post("/api/reseed", headers=ADMIN_HEADERS)
        status_after = client.get("/api/seed-status", headers=ADMIN_HEADERS)

    assert status_before.status_code == 200
    assert response.status_code == 200
    assert status_after.status_code == 200
    assert response.json()["ok"] is True
    assert status_after.json()["channels"] == 1
    assert status_after.json()["test_suites"] == 1
    assert status_after.json()["test_cases"] == 32
    with SessionLocal() as db:
        assert db.get(Channel, "custom_channel").auth_config == {"api_key": "keep-me"}
        assert all("api_key" not in (channel.auth_config_encrypted or {}) for channel in db.scalars(select(Channel).where(Channel.id != "custom_channel")).all())


def test_seed_demo_data_preserves_custom_default_suite_cases() -> None:
    reset_database()
    with SessionLocal() as db:
        db.add(
            TestCaseModel(
                id="custom_default_suite_case",
                suite_id="claude_full_35",
                module="custom",
                sort_order=9999,
                title="Custom default suite case",
                prompt="Keep this user-authored case.",
                request_params={},
                scoring_rules={},
                is_hidden=False,
                enabled=True,
            )
        )
        db.commit()
        seed_demo_data(db)
        custom_case = db.get(TestCaseModel, "custom_default_suite_case")

    assert custom_case is not None
    assert custom_case.prompt == "Keep this user-authored case."


def test_init_db_does_not_delete_existing_builtin_channel() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = db.get(Channel, "anthropic_official")
        assert channel is not None
        channel.auth_config = {"api_key": "keep-me"}
        db.commit()

    init_db()

    with SessionLocal() as db:
        channel = db.get(Channel, "anthropic_official")

    assert channel is not None
    assert channel.auth_config == {"api_key": "keep-me"}


def test_mock_run_generates_results_comparisons_and_reports() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        response = client.post(
            "/api/runs",
            json={
                "name": "pytest mock run",
                "suite_id": suite_id,
                "test_scope": "full",
                "channel_ids": {
                    "gold": ["anthropic_official"],
                    "candidate": ["third_party_demo"],
                },
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        )
        assert response.status_code == 200
        run = response.json()

        detail = client.get(f"/api/runs/{run['id']}/results")
        assert detail.status_code == 200
        payload = detail.json()
        runs_response = client.get("/api/runs")
        assert runs_response.status_code == 200
        listed_run = next(item for item in runs_response.json() if item["id"] == run["id"])

    assert payload["run"]["status"] == "completed"
    assert payload["run"]["completed_jobs"] == payload["run"]["total_jobs"]
    assert len(payload["results"]) == payload["run"]["total_jobs"]
    assert payload["comparisons"]
    assert payload["reports"]
    assert {(item["channel_id"], item["role_in_run"]) for item in listed_run["channels"]} == {
        ("anthropic_official", "reference"),
        ("third_party_demo", "candidate"),
    }
    assert all(item["channel_name"] for item in listed_run["channels"])


def test_report_summary_detail_and_compare_endpoints() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        first = client.post(
            "/api/runs",
            json={
                "name": "pytest report one",
                "suite_id": suite_id,
                "channel_ids": {"gold": ["anthropic_official"], "candidate": ["third_party_demo"]},
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        ).json()
        second = client.post(
            "/api/runs",
            json={
                "name": "pytest report two",
                "suite_id": suite_id,
                "channel_ids": {"gold": ["anthropic_official"], "candidate": ["negative_sample"]},
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        ).json()

        summary = client.get("/api/reports/summary")
        assert summary.status_code == 200
        summaries = summary.json()
        assert len(summaries) >= 2
        assert summaries[0]["mode"]
        assert summaries[0]["performance"]["success_count"] >= 0

        report_ids = [item["report_id"] for item in summaries if item["run_id"] in {first["id"], second["id"]}][:2]
        detail = client.get(f"/api/reports/{report_ids[0]}/detail")
        assert detail.status_code == 200
        detail_payload = detail.json()
        assert detail_payload["prediction_rows"]
        assert detail_payload["performance_summary"]["failure_rate"] >= 0

        compare = client.get("/api/reports/compare", params={"ids": ",".join(report_ids)})
        assert compare.status_code == 200
        compare_payload = compare.json()
        assert len(compare_payload["reports"]) == 2
        assert compare_payload["score_matrix"]
        assert compare_payload["prediction_rows"]

        assert client.get("/api/reports/compare", params={"ids": report_ids[0]}).status_code == 400
        assert client.get("/api/reports/compare", params={"ids": f"{report_ids[0]},missing"}).status_code == 404


def test_report_detail_backfills_missing_markdown() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    with SessionLocal() as db:
        report = db.scalar(select(Report).where(Report.run_id == run_id))
        assert report is not None
        report_id = report.id
        report.markdown = None
        db.commit()

    with TestClient(app) as client:
        detail = client.get(f"/api/reports/{report_id}")
        markdown = client.get(f"/api/reports/{report_id}/markdown")
        run_markdown = client.get(f"/api/runs/{run_id}/report.md")

    assert detail.status_code == 200
    assert "Claude 渠道真实性测评报告" in detail.json()["markdown"]
    assert markdown.status_code == 200
    assert "Claude 渠道真实性测评报告" in markdown.json()["markdown"]
    assert "Claude 渠道真实性测评报告" in run_markdown.text
    with SessionLocal() as db:
        persisted = db.get(Report, report_id)
        assert persisted is not None
        assert persisted.markdown is not None
        assert "Claude 渠道真实性测评报告" in persisted.markdown


def test_report_delete_removes_report_and_linked_alerts_only() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with SessionLocal() as db:
        report = db.scalar(select(Report).where(Report.run_id == run_id))
        result_count = db.scalar(select(func.count()).select_from(Result).where(Result.run_id == run_id))
        assert report is not None
        report_id = report.id
        assert db.scalar(select(func.count()).select_from(ChannelAlert).where(ChannelAlert.report_id == report_id)) == 1

    with TestClient(app) as client:
        deleted = client.delete(f"/api/reports/{report_id}", headers=ADMIN_HEADERS)
        missing = client.delete("/api/reports/missing_report", headers=ADMIN_HEADERS)

    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert missing.status_code == 404
    with SessionLocal() as db:
        assert db.get(Report, report_id) is None
        assert db.get(Run, run_id) is not None
        assert db.scalar(select(func.count()).select_from(Result).where(Result.run_id == run_id)) == result_count
        assert db.scalar(select(func.count()).select_from(ChannelAlert).where(ChannelAlert.report_id == report_id)) == 0


def test_destructive_endpoints_require_admin_key() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        run = client.post(
            "/api/runs",
            json={
                "name": "admin key check",
                "suite_id": suite_id,
                "channel_ids": {"gold": ["anthropic_official"], "candidate": ["third_party_demo"]},
                "repeat_count": 1,
                "concurrency": 1,
                "use_mock": True,
            },
        ).json()

        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")
        forbidden = client.delete(f"/api/runs/{run['id']}")
        schedule_forbidden = client.delete(f"/api/scheduled-tests/{schedule['id']}")
        cleanup_forbidden = client.post("/api/system/cleanup-run-logs?dry_run=true")

    assert forbidden.status_code in {401, 403}
    assert schedule_forbidden.status_code in {401, 403}
    assert cleanup_forbidden.status_code in {401, 403}


def test_regular_delete_allows_missing_admin_key_when_unconfigured(monkeypatch) -> None:
    monkeypatch.delenv("ADMIN_API_KEY", raising=False)
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        run = client.post(
            "/api/runs",
            json={
                "name": "delete without admin key",
                "suite_id": suite_id,
                "channel_ids": {"gold": ["anthropic_official"], "candidate": ["third_party_demo"]},
                "repeat_count": 1,
                "concurrency": 1,
                "use_mock": True,
            },
        ).json()
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

        deleted = client.delete(f"/api/runs/{run['id']}")
        deleted_schedule = client.delete(f"/api/scheduled-tests/{schedule['id']}")
        cleanup_forbidden = client.post("/api/system/cleanup-run-logs?dry_run=true")

    assert deleted.status_code == 200
    assert deleted_schedule.status_code == 200
    assert cleanup_forbidden.status_code == 403


def test_seed_diagnostics_endpoints_require_admin_key_when_configured(monkeypatch) -> None:
    reset_database()
    monkeypatch.setenv("ADMIN_API_KEY", "configured-admin-key")
    with TestClient(app) as client:
        seed_status = client.get("/api/seed-status")
        reseed = client.post("/api/reseed")
        cleanup_fixture = client.post("/api/reseed/cleanup-restored-fixture")

    assert seed_status.status_code == 401
    assert reseed.status_code == 401
    assert cleanup_fixture.status_code == 401


def test_seed_diagnostics_endpoints_reject_when_admin_key_missing(monkeypatch) -> None:
    reset_database()
    monkeypatch.delenv("ADMIN_API_KEY", raising=False)
    with TestClient(app) as client:
        seed_status = client.get("/api/seed-status")
        reseed = client.post("/api/reseed")
        cleanup_fixture = client.post("/api/reseed/cleanup-restored-fixture")

    assert seed_status.status_code == 403
    assert reseed.status_code == 403
    assert cleanup_fixture.status_code == 403


def test_cleanup_restored_fixture_removes_extra_seed_data_without_referenced_channels() -> None:
    reset_database()
    with SessionLocal() as db:
        default_ids = {case["id"] for case in default_cases()}
        inserted = seed_restored_fixture_data(db)
        assert inserted["test_cases"] > 0
        assert db.get(Channel, "openai_compat_demo") is not None
        assert db.scalar(select(func.count()).select_from(TestCaseModel).where(TestCaseModel.id.in_(default_ids))) == len(default_ids)

    with TestClient(app) as client:
        response = client.post("/api/reseed/cleanup-restored-fixture", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    payload = response.json()
    assert payload["deleted_cases"] > 0
    assert payload["deleted_channels"] > 0
    assert payload["skipped_default_cases"] == 32
    with SessionLocal() as db:
        fixture = restored_seed_data()
        default_ids = {case["id"] for case in default_cases()}
        assert db.scalar(select(func.count()).select_from(TestCaseModel).where(TestCaseModel.id.in_(default_ids))) == len(default_ids)
        fixture_extra_id = next(item["id"] for item in fixture["test_cases"] if item["id"] not in default_ids)
        assert db.get(TestCaseModel, fixture_extra_id) is None
        assert db.get(TestSuiteModel, "claude_full_35") is not None
        assert db.get(Channel, "openai_compat_demo") is None


def test_reseed_restores_default_cases_after_fixture_cleanup_bug() -> None:
    reset_database()
    default_ids = {case["id"] for case in default_cases()}
    with SessionLocal() as db:
        db.execute(delete(TestCaseModel).where(TestCaseModel.id.in_(default_ids)))
        db.commit()
        assert db.scalar(select(func.count()).select_from(TestCaseModel).where(TestCaseModel.id.in_(default_ids))) == 0

    with TestClient(app) as client:
        response = client.post("/api/reseed", headers=ADMIN_HEADERS)
        cases = client.get("/api/test-cases", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    assert cases.status_code == 200
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(TestCaseModel).where(TestCaseModel.id.in_(default_ids))) == len(default_ids)


def test_report_bulk_delete_returns_deleted_count_and_missing_ids() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    first_run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    second_run_id = create_report_for_schedule(schedule, grade="D", score=60, labels=["protocol_drift"])
    with SessionLocal() as db:
        report_ids = list(db.scalars(select(Report.id).where(Report.run_id.in_([first_run_id, second_run_id]))).all())

    with TestClient(app) as client:
        response = client.post("/api/reports/bulk-delete", json={"ids": [*report_ids, "missing_report"]}, headers=ADMIN_HEADERS)

    assert response.status_code == 200
    assert response.json()["deleted"] == len(report_ids)
    assert response.json()["missing"] == ["missing_report"]
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Report).where(Report.id.in_(report_ids))) == 0


def test_alert_delete_removes_alert_only() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with SessionLocal() as db:
        alert = db.scalar(select(ChannelAlert).where(ChannelAlert.run_id == run_id))
        report = db.scalar(select(Report).where(Report.run_id == run_id))
        assert alert is not None
        assert report is not None
        alert_id = alert.id
        report_id = report.id

    with TestClient(app) as client:
        deleted = client.delete(f"/api/alerts/{alert_id}", headers=ADMIN_HEADERS)
        missing = client.delete("/api/alerts/missing_alert", headers=ADMIN_HEADERS)

    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert missing.status_code == 404
    with SessionLocal() as db:
        assert db.get(ChannelAlert, alert_id) is None
        assert db.get(Run, run_id) is not None
        assert db.get(Report, report_id) is not None


def test_alert_bulk_delete_returns_deleted_count_and_missing_ids() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    first_run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    second_run_id = create_report_for_schedule(schedule, grade="D", score=60, labels=["protocol_drift"])
    asyncio.run(create_alerts_for_run(SessionLocal, first_run_id, schedule["id"]))
    asyncio.run(create_alerts_for_run(SessionLocal, second_run_id, schedule["id"]))
    with SessionLocal() as db:
        alert_ids = list(db.scalars(select(ChannelAlert.id).where(ChannelAlert.run_id.in_([first_run_id, second_run_id]))).all())

    with TestClient(app) as client:
        response = client.post("/api/alerts/bulk-delete", json={"ids": [*alert_ids, "missing_alert"]}, headers=ADMIN_HEADERS)

    assert response.status_code == 200
    assert response.json()["deleted"] == len(alert_ids)
    assert response.json()["missing"] == ["missing_alert"]
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(ChannelAlert).where(ChannelAlert.id.in_(alert_ids))) == 0


def test_scheduled_test_delete_cleans_patrol_jobs_and_keeps_history() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        report = db.scalar(select(Report).where(Report.run_id == run_id))
        alert = db.scalar(select(ChannelAlert).where(ChannelAlert.run_id == run_id))
        assert scheduled is not None
        assert report is not None
        assert alert is not None
        scheduled.last_run_id = run_id
        job = PatrolJob(
            id="job_scheduled_delete_keeps_history",
            scheduled_test_id=schedule["id"],
            channel_id=schedule["channel_id"],
            status="completed",
            run_id=run_id,
        )
        db.add(job)
        db.add(
            PatrolJobAttempt(
                id="attempt_scheduled_delete_keeps_history",
                job_id=job.id,
                run_id=run_id,
                status="completed",
            )
        )
        db.commit()
        report_id = report.id
        alert_id = alert.id

    with TestClient(app) as client:
        response = client.delete(f"/api/scheduled-tests/{schedule['id']}", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    assert response.json() == {"deleted": True}
    with SessionLocal() as db:
        assert db.get(ScheduledChannelTest, schedule["id"]) is None
        assert db.get(PatrolJob, "job_scheduled_delete_keeps_history") is None
        assert db.get(PatrolJobAttempt, "attempt_scheduled_delete_keeps_history") is None
        run = db.get(Run, run_id)
        report = db.get(Report, report_id)
        alert = db.get(ChannelAlert, alert_id)
        assert run is not None
        assert report is not None
        assert alert is not None
        assert run.scheduled_test_id is None
        assert alert.scheduled_test_id is None


def test_run_delete_removes_linked_alerts() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))
    with SessionLocal() as db:
        report_id = db.scalar(select(Report.id).where(Report.run_id == run_id))
        assert report_id is not None
        assert db.scalar(select(func.count()).select_from(ChannelAlert).where(ChannelAlert.run_id == run_id)) == 1

    with TestClient(app) as client:
        response = client.delete(f"/api/runs/{run_id}", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    assert response.json() == {"deleted": True}
    with SessionLocal() as db:
        assert db.get(Run, run_id) is None
        assert db.get(Report, report_id) is None
        assert db.scalar(select(func.count()).select_from(ChannelAlert).where(ChannelAlert.run_id == run_id)) == 0


def test_run_delete_clears_scheduled_last_run_reference() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        scheduled.last_run_id = run_id
        db.commit()

    with TestClient(app) as client:
        response = client.delete(f"/api/runs/{run_id}", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        assert scheduled.last_run_id is None


def test_run_delete_repairs_scheduled_last_run_reference_to_previous_run() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    previous_run_id = create_report_for_schedule(schedule, grade="D", score=60, labels=["protocol_drift"])
    latest_run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        scheduled.last_run_id = latest_run_id
        db.commit()

    with TestClient(app) as client:
        response = client.delete(f"/api/runs/{latest_run_id}", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        assert scheduled.last_run_id == previous_run_id
        assert db.get(Run, latest_run_id) is None
        assert db.get(Run, previous_run_id) is not None


def test_run_bulk_delete_clears_scheduled_last_run_when_all_history_deleted() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    first_run_id = create_report_for_schedule(schedule, grade="D", score=60, labels=["protocol_drift"])
    second_run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        scheduled.last_run_id = second_run_id
        db.commit()

    with TestClient(app) as client:
        response = client.post("/api/runs/bulk-delete", json={"ids": [first_run_id, second_run_id]}, headers=ADMIN_HEADERS)

    assert response.status_code == 200
    assert response.json()["deleted"] == 2
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        assert scheduled.last_run_id is None
        assert db.get(Run, first_run_id) is None
        assert db.get(Run, second_run_id) is None


def test_run_bulk_delete_uses_set_based_delete_helper(monkeypatch) -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    first_run_id = create_report_for_schedule(schedule, grade="D", score=60, labels=["protocol_drift"])
    second_run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    calls: list[tuple[set[str], bool]] = []

    import app.main as main_module

    original = main_module._delete_runs_by_ids

    def spy_delete_runs(db, run_ids, *, repair_refs=True):  # noqa: ANN001
        calls.append((set(run_ids), repair_refs))
        return original(db, run_ids, repair_refs=repair_refs)

    monkeypatch.setattr(main_module, "_delete_runs_by_ids", spy_delete_runs)

    with TestClient(app) as client:
        response = client.post("/api/runs/bulk-delete", json={"ids": [first_run_id, second_run_id]}, headers=ADMIN_HEADERS)

    assert response.status_code == 200
    assert response.json()["deleted"] == 2
    assert calls == [({first_run_id, second_run_id}, True)]


def test_run_bulk_delete_large_batch_completes_and_cleans_related_rows() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_ids: list[str] = []
    with SessionLocal() as db:
        for index in range(80):
            run_id = f"bulk_perf_run_{index}"
            report_id = f"bulk_perf_report_{index}"
            run_ids.append(run_id)
            run = Run(
                id=run_id,
                suite_id=schedule["suite_id"],
                name=f"bulk perf {index}",
                mode="candidate_eval",
                test_scope="full",
                baseline_snapshot_id=schedule["baseline_snapshot_id"],
                scheduled_test_id=schedule["id"],
                status="completed",
                repeat_count=1,
                concurrency=1,
                total_jobs=1,
                completed_jobs=1,
            )
            db.add(run)
            db.add(RunChannel(id=f"bulk_perf_rch_{index}", run_id=run_id, channel_id="negative_sample", role_in_run="candidate"))
            db.add(Result(id=f"bulk_perf_result_{index}", run_id=run_id, test_case_id="case_builtin_math_json", channel_id="negative_sample", normalized_response={}, raw_request={}, raw_response={}, metrics={}, score=0, labels=[]))
            db.add(Report(id=report_id, run_id=run_id, channel_id="negative_sample", final_score=60, grade="D", summary="perf"))
            db.add(ChannelAlert(id=f"bulk_perf_alert_{index}", scheduled_test_id=schedule["id"], run_id=run_id, report_id=report_id, channel_id="negative_sample", grade="D", final_score=60))
            job = PatrolJob(id=f"bulk_perf_job_{index}", scheduled_test_id=schedule["id"], channel_id="negative_sample", status="completed", run_id=run_id)
            db.add(job)
            db.add(PatrolJobAttempt(id=f"bulk_perf_attempt_{index}", job_id=job.id, run_id=run_id, status="completed"))
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        scheduled.last_run_id = run_ids[-1]
        db.commit()

    with TestClient(app) as client:
        response = client.post("/api/runs/bulk-delete", json={"ids": run_ids}, headers=ADMIN_HEADERS)

    assert response.status_code == 200
    assert response.json()["deleted"] == len(run_ids)
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Run).where(Run.id.in_(run_ids))) == 0
        assert db.scalar(select(func.count()).select_from(Result).where(Result.run_id.in_(run_ids))) == 0
        assert db.scalar(select(func.count()).select_from(Report).where(Report.run_id.in_(run_ids))) == 0
        assert db.scalar(select(func.count()).select_from(ChannelAlert).where(ChannelAlert.run_id.in_(run_ids))) == 0
        assert db.scalar(select(func.count()).select_from(PatrolJob).where(PatrolJob.run_id.in_(run_ids))) == 0
        assert db.scalar(select(func.count()).select_from(PatrolJobAttempt).where(PatrolJobAttempt.run_id.in_(run_ids))) == 0
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None and scheduled.last_run_id is None

def test_run_bulk_delete_returns_deleted_missing_and_failed() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    first_run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    second_run_id = create_report_for_schedule(schedule, grade="D", score=60, labels=["protocol_drift"])
    asyncio.run(create_alerts_for_run(SessionLocal, first_run_id, schedule["id"]))
    with SessionLocal() as db:
        second_run = db.get(Run, second_run_id)
        assert second_run is not None
        second_run.status = "running"
        db.commit()

    with TestClient(app) as client:
        response = client.post(
            "/api/runs/bulk-delete",
            json={"ids": [first_run_id, second_run_id, "missing_run"]},
            headers=ADMIN_HEADERS,
        )

    assert response.status_code == 200
    assert response.json()["deleted"] == 1
    assert response.json()["missing"] == ["missing_run"]
    assert response.json()["failed"] == {second_run_id: "Running runs must be canceled before deletion"}
    with SessionLocal() as db:
        assert db.get(Run, first_run_id) is None
        assert db.get(Run, second_run_id) is not None
        assert db.scalar(select(func.count()).select_from(ChannelAlert).where(ChannelAlert.run_id == first_run_id)) == 0


def test_report_compare_rejects_mixed_modes() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        compare_run = client.post(
            "/api/runs",
            json={
                "name": "pytest authenticity report",
                "suite_id": suite_id,
                "channel_ids": {"gold": ["anthropic_official"], "candidate": ["third_party_demo"]},
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        ).json()
        performance_run = client.post(
            "/api/runs",
            json={
                "name": "pytest performance report",
                "suite_id": suite_id,
                "mode": "performance_benchmark",
                "test_scope": "quick",
                "channel_ids": {"candidate": ["third_party_demo"]},
                "repeat_count": 1,
                "concurrency": 2,
                "use_mock": True,
            },
        ).json()
        client.get(f"/api/runs/{compare_run['id']}/results")
        client.get(f"/api/runs/{performance_run['id']}/results")
        summaries = client.get("/api/reports/summary").json()
        compare_report_id = next(item["report_id"] for item in summaries if item["run_id"] == compare_run["id"])
        performance_report_id = next(item["report_id"] for item in summaries if item["run_id"] == performance_run["id"])
        response = client.get("/api/reports/compare", params={"ids": f"{compare_report_id},{performance_report_id}"})

    assert response.status_code == 400
    assert "modes must match" in response.json()["detail"]


def test_default_suite_is_representative_32_and_keeps_custom_default_suite_cases() -> None:
    reset_database()
    with SessionLocal() as db:
        create_case(
            db,
            TestCaseCreate(
                id="identity_03",
                suite_id="claude_full_35",
                module="identity",
                title="stale case",
                prompt="stale",
                enabled=True,
            ),
        )
        seed_demo_data(db)
        suite = db.get(TestSuiteModel, "claude_full_35")
        case_ids = list(db.scalars(select(TestCaseModel.id).where(TestCaseModel.suite_id == "claude_full_35").order_by(TestCaseModel.sort_order)).all())

    assert suite is not None
    assert suite.version == "2026.05-representative-32"
    assert len(case_ids) == 33
    assert case_ids[:5] == ["websearch_01", "protocol_01", "protocol_02", "protocol_03", "protocol_04"]
    assert "protocol_09" in case_ids
    assert "tool_01" in case_ids
    assert {"format_08", "tool_08", "context_09", "knowledge_06", "code_05"}.issubset(case_ids)
    assert "identity_03" in case_ids
    with SessionLocal() as db:
        quick_count = sum(
            1
            for case in db.scalars(select(TestCaseModel).where(TestCaseModel.suite_id == "claude_full_35")).all()
            if (case.scoring_rules or {}).get("quick") is True
        )
    assert quick_count == 12


def test_default_suite_has_evalscope_inspired_coverage_tags() -> None:
    reset_database()
    with TestClient(app) as client:
        coverage = client.get("/api/test-suites/claude_full_35/coverage")

    assert coverage.status_code == 200
    tags = coverage.json()["coverage_tags"]
    for tag in ["instruction_following", "function_call", "long_context", "hallucination", "reasoning", "code"]:
        assert tags[tag] > 0


def test_quick_run_uses_only_quick_cases() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        response = client.post(
            "/api/runs",
            json={
                "name": "pytest quick run",
                "suite_id": suite_id,
                "test_scope": "quick",
                "channel_ids": {"gold": ["anthropic_official"], "candidate": ["third_party_demo"]},
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        )
        assert response.status_code == 200
        run = response.json()
        payload = client.get(f"/api/runs/{run['id']}/results").json()

    assert payload["run"]["test_scope"] == "quick"
    assert payload["run"]["total_jobs"] == 24
    assert len(payload["results"]) == 24


def test_performance_benchmark_writes_evalscope_style_metrics_and_summary() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        response = client.post(
            "/api/runs",
            json={
                "name": "pytest perf run",
                "suite_id": suite_id,
                "test_scope": "quick",
                "mode": "performance_benchmark",
                "channel_ids": {"candidate": ["third_party_demo"]},
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
                "benchmark_config": {
                    "concurrency_steps": [1, 3],
                    "warmup_requests": 1,
                    "sla_p95_ms": 5000,
                    "max_error_rate": 5,
                },
            },
        )
        assert response.status_code == 200
        run = response.json()
        payload = client.get(f"/api/runs/{run['id']}/results").json()
        summary = client.get(f"/api/runs/{run['id']}/summary").json()

    assert payload["run"]["status"] == "completed"
    assert payload["reports"]
    first_metrics = payload["results"][0]["metrics"]
    assert first_metrics["ttft_ms"] is not None
    assert "tpot_ms" in first_metrics
    assert "tokens_per_second" in first_metrics
    assert summary["avg_ttft_ms"] is not None
    assert summary["performance_by_channel"][0]["channel_id"] == "third_party_demo"
    assert payload["reports"][0]["evidence"]["benchmark_config"]["concurrency_steps"] == [1, 3]
    assert "performance_distribution" in payload["reports"][0]["evidence"]


def test_arena_run_generates_rankings_and_reports() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        response = client.post(
            "/api/runs/arena",
            json={
                "name": "pytest arena run",
                "suite_id": suite_id,
                "candidate_channel_ids": ["third_party_demo", "negative_sample"],
                "judge_channel_id": "anthropic_official",
                "judge_mode": "direct_score",
                "judge_rubric": "Prefer safe, concise, instruction-following answers.",
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        )
        assert response.status_code == 200
        run = response.json()
        payload = client.get(f"/api/runs/{run['id']}/results").json()
        summary = client.get(f"/api/runs/{run['id']}/summary").json()

    assert payload["run"]["mode"] == "arena_comparison"
    assert {item["channel_id"] for item in payload["run_channels"]} == {"third_party_demo", "negative_sample"}
    assert all(item["role_in_run"] == "candidate" for item in payload["run_channels"])
    assert payload["reports"]
    assert summary["arena_rankings"]
    assert {item["channel_id"] for item in summary["arena_rankings"]} == {"third_party_demo", "negative_sample"}
    assert "anthropic_official" not in {item["channel_id"] for item in summary["arena_rankings"]}
    assert payload["reports"][0]["evidence"]["arena_matrix"]
    assert payload["reports"][0]["evidence"]["judge_evidence"]["judge_channel_id"] == "anthropic_official"


def test_suite_bundle_import_export_and_diff() -> None:
    reset_database()
    bundle = {
        "suite": {"id": "custom_suite", "name": "Custom Suite", "description": "demo", "version": "v1", "visibility": "public"},
        "cases": [
            {
                "id": "custom_case_1",
                "suite_id": "custom_suite",
                "module": "identity",
                "sort_order": 1,
                "title": "Identity",
                "prompt": "你是谁？",
                "request_params": {"max_tokens": 64},
                "scoring_rules": {"required_any": ["Claude"]},
                "enabled": True,
            }
        ],
    }
    with TestClient(app) as client:
        imported = client.post("/api/test-suites/import", json=bundle)
        assert imported.status_code == 200
        exported = client.get("/api/test-suites/custom_suite/export")
        assert exported.status_code == 200
        changed_bundle = exported.json()
        changed_bundle["cases"][0]["prompt"] = "你是谁？请只用一句话回答。"
        diff = client.get("/api/test-suites/custom_suite/diff", params={"against": json.dumps(changed_bundle, ensure_ascii=False)})
        assert diff.status_code == 200

    assert imported.json()["created_cases"] == 1
    assert exported.json()["suite"]["id"] == "custom_suite"
    assert diff.json()["changed"][0]["id"] == "custom_case_1"


def test_evalscope_jsonl_import_validation_coverage_and_sample_plan() -> None:
    reset_database()
    jsonl = "\n".join(
        [
            json.dumps(
                {
                    "id": "eval_mcq_1",
                    "question": "Which model family is developed by Anthropic?",
                    "choices": ["Claude", "GPT", "Gemini"],
                    "answer": "Claude",
                    "category": "identity",
                    "difficulty": "easy",
                    "tags": ["identity", "vendor"],
                }
            ),
            json.dumps(
                {
                    "id": "eval_tool_1",
                    "prompt": "Call get_order_status for A-1.",
                    "task_type": "function_call",
                    "module": "tool",
                    "scoring_rules": {"tool_required": True, "tool_name": "get_order_status", "coverage_tags": ["tool"], "difficulty": "medium"},
                }
            ),
        ]
    )
    with TestClient(app) as client:
        imported = client.post(
            "/api/test-suites/import-evalscope-jsonl",
            json={
                "suite": {"id": "evalscope_suite", "name": "EvalScope Suite", "description": "jsonl", "version": "v1", "visibility": "public"},
                "jsonl": jsonl,
                "default_module": "custom",
                "default_task_type": "qa",
            },
        )
        coverage = client.get("/api/test-suites/evalscope_suite/coverage")
        validation = client.post("/api/test-suites/evalscope_suite/validate")
        sample = client.post(
            "/api/runs/sample-plan",
            json={"suite_id": "evalscope_suite", "test_scope": "full", "coverage_tags": ["identity"], "group_by": "task_type"},
        )

    assert imported.status_code == 200
    assert imported.json()["created_cases"] in {0, 2}
    assert coverage.status_code == 200
    assert coverage.json()["by_task_type"]["mcq"] == 1
    assert coverage.json()["coverage_tags"]["identity"] == 1
    assert validation.status_code == 200
    assert validation.json()["ok"] is True
    assert sample.status_code == 200
    assert sample.json()["selected_count"] == 1
    assert sample.json()["cases"][0]["id"] == "eval_mcq_1"


def test_score_result_supports_discriminative_rules() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = db.get(Channel, "anthropic_official")
        case = db.get(TestCaseModel, "protocol_02")
        assert channel is not None and case is not None
        score, labels = score_result(
            channel,
            case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "provider_message_id": "msg_test",
                "tool_calls": [{"type": "tool_use", "name": "wrong_tool", "input": {"order_id": "bad"}}],
                "stop_reason": "tool_use",
                "stream_events": ["message_stop"],
                "content_text": "",
                "status_code": 200,
            },
        )

        message_case = db.get(TestCaseModel, "protocol_01")
        assert message_case is not None
        message_score, message_labels = score_result(
            channel,
            message_case,
            {
                "raw_response": {"object": "chat.completion"},
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "provider_message_id": "chatcmpl_test",
                "tool_calls": [],
                "stop_reason": "stop",
                "stream_events": ["done"],
                "content_text": "协议字段应该来自真实 API 响应。",
                "status_code": 200,
            },
        )

        json_case = db.get(TestCaseModel, "format_01")
        json_score, json_labels = score_result(
            channel,
            json_case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "provider_message_id": "msg_test",
                "tool_calls": [],
                "stop_reason": "end_turn",
                "stream_events": ["message_stop"],
                "content_text": '{"risk":"low"}',
                "status_code": 200,
            },
        )

        regex_case = db.get(TestCaseModel, "format_02")
        assert regex_case is not None
        regex_score, regex_labels = score_result(
            channel,
            regex_case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "provider_message_id": "msg_test",
                "tool_calls": [],
                "stop_reason": "end_turn",
                "stream_events": ["message_stop"],
                "content_text": "ticket=TK-2026-0507;priority=P2;owner=ops\n说明：已处理",
                "status_code": 200,
            },
        )

        stop_case = db.get(TestCaseModel, "protocol_04")
        stop_score, stop_labels = score_result(
            channel,
            stop_case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "provider_message_id": "msg_test",
                "tool_calls": [],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "stream_events": ["message_stop"],
                "content_text": "第一句。第二句。",
                "status_code": 200,
            },
        )

    assert score < 100
    assert "tool_name_mismatch" in labels
    assert "tool_input_mismatch" in labels
    assert "tool_schema_invalid" in labels
    assert message_score < 100
    assert "message_id_family_mismatch" in message_labels
    assert "protocol_mismatch" in message_labels
    assert json_score < 100
    assert "json_missing:evidence" in json_labels
    assert "json_schema_invalid" in json_labels
    assert regex_score < 100
    assert "regex_keypoint_missing" in regex_labels
    assert "forbidden_pattern_hit" in regex_labels
    assert stop_score < 100
    assert "stop_sequence_not_enforced" in stop_labels
    assert "stop_sequence_leaked" in stop_labels


def test_score_result_validates_thinking_temperature_expected_error() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = manual_thinking_temperature_probe_case()
        assert channel is not None

        exact_score, exact_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"error": {"message": "`temperature` may only be set to 1 when thinking is enabled"}},
                "error": "`temperature` may only be set to 1 when thinking is enabled",
                "status_code": 500,
                "content_text": "",
            },
        )
        variant_score, variant_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"error": {"message": "Thinking is not compatible with a custom temperature value"}},
                "error": "Thinking is not compatible with a custom temperature value",
                "status_code": 500,
                "content_text": "",
            },
        )
        normal_score, normal_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "provider_message_id": "msg_bdrk_01ok",
                "tool_calls": [],
                "stop_reason": "end_turn",
                "stream_events": ["message_stop"],
                "content_text": "ok",
                "status_code": 200,
            },
        )

    assert exact_score == 100
    assert exact_labels == []
    assert variant_score == 100
    assert variant_labels == ["provider_error_variant"]
    assert normal_score == 0
    assert normal_labels == ["thinking_temperature_not_rejected"]


def test_score_result_validates_thinking_adaptive_enabled_expected_error() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = manual_thinking_adaptive_enabled_probe_case()
        assert channel is not None

        exact_score, exact_labels = score_result(
            channel,
            case,
            {
                "raw_response": {
                    "error": {
                        "message": '"***.***.enabled" is not supported for this model. Use "***.***.adaptive" and "output_config.effort" to control thinking behavior.'
                    }
                },
                "error": '"***.***.enabled" is not supported for this model. Use "***.***.adaptive" and "output_config.effort" to control thinking behavior.',
                "status_code": 400,
                "content_text": "",
            },
        )
        variant_score, variant_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"error": {"message": "`temperature` may only be set to 1 when thinking is enabled"}},
                "error": "`temperature` may only be set to 1 when thinking is enabled",
                "status_code": 400,
                "content_text": "",
            },
        )
        wrong_error_score, wrong_error_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"error": {"message": "unrelated bad request"}},
                "error": "unrelated bad request",
                "status_code": 400,
                "content_text": "",
            },
        )
        unavailable_score, unavailable_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"error": {"message": "No available channel for model claude-sonnet-4-6 under group awsp"}},
                "error": "Server error '503 Service Unavailable'; response body: No available channel for model claude-sonnet-4-6 under group awsp",
                "status_code": 503,
                "content_text": "",
            },
        )
        normal_score, normal_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 16, "output_tokens": 6},
                "provider_message_id": "msg_bdrk_01ok",
                "tool_calls": [],
                "stop_reason": "end_turn",
                "stream_events": ["message_stop"],
                "content_text": "OK",
                "status_code": 200,
            },
        )

    assert exact_score == 100
    assert exact_labels == []
    assert variant_score == 100
    assert variant_labels == ["provider_error_variant"]
    assert wrong_error_score == 0
    assert wrong_error_labels == ["thinking_adaptive_enabled_wrong_error"]
    assert unavailable_score == 0
    assert unavailable_labels == ["provider_temporarily_unavailable"]
    assert normal_score == 0
    assert normal_labels == ["thinking_adaptive_enabled_not_rejected"]


def test_websearch_seed_case_uses_web_search_probe_payload() -> None:
    reset_database()
    with SessionLocal() as db:
        case = db.get(TestCaseModel, "websearch_01")

    assert case is not None
    assert case.title == "Web Search AWS 纯度报错探针"
    assert case.request_params["max_tokens"] == 900
    assert case.request_params["stream"] is True
    assert case.request_params["tools"][0]["type"] == "web_search_20260318"
    assert case.scoring_rules["expected_error_missing_label"] == "web_search_not_rejected"


def test_score_result_validates_web_search_expected_error() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = db.get(TestCaseModel, "websearch_01")
        assert channel is not None and case is not None

        exact_score, exact_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"error": {"message": "web search is not available on this channel"}},
                "error": "web search is not available on this channel",
                "status_code": 500,
                "content_text": "",
            },
        )
        variant_score, variant_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"error": {"message": "unsupported tool web_search_20260318"}},
                "error": "unsupported tool web_search_20260318",
                "status_code": 500,
                "content_text": "",
            },
        )
        normal_score, normal_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "provider_message_id": "msg_bdrk_01ok",
                "tool_calls": [],
                "stop_reason": "end_turn",
                "stream_events": ["message_stop"],
                "content_text": "最新更新：标题、发布日期、链接",
                "status_code": 200,
            },
        )

    assert exact_score == 100
    assert exact_labels == ["provider_error_variant"]
    assert variant_score == 100
    assert variant_labels == ["provider_error_variant"]
    assert normal_score == 0
    assert normal_labels == ["web_search_not_rejected"]


def test_repeat_consistency_penalizes_drift_between_attempts() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        run = create_run(
            db,
            RunCreate(
                name="consistency run",
                suite_id=suite_id,
                channel_ids={"gold": ["anthropic_official"]},
                repeat_count=2,
                concurrency=1,
                use_mock=True,
            ),
        )
        db.add(
            Result(
                id="res_consistency_1",
                run_id=run.id,
                test_case_id="protocol_05",
                channel_id="anthropic_official",
                attempt_index=1,
                normalized_response={"content_text": "天空是蓝色的，因为瑞利散射。"},
                raw_request={},
                raw_response={},
                metrics={},
                score=100,
                labels=[],
            )
        )
        db.add(
            Result(
                id="res_consistency_2",
                run_id=run.id,
                test_case_id="protocol_05",
                channel_id="anthropic_official",
                attempt_index=2,
                normalized_response={"content_text": "完全不同的回答，讨论数据库事务隔离级别。"},
                raw_request={},
                raw_response={},
                metrics={},
                score=100,
                labels=[],
            )
        )
        db.commit()
        apply_repeat_consistency_scores(db, run.id)
        second = db.get(Result, "res_consistency_2")

    assert second is not None
    assert second.score == 80
    assert "repeat_inconsistent" in second.labels


def test_execute_run_honors_concurrency_and_result_count() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        run = create_run(
            db,
            RunCreate(
                name="direct mock run",
                suite_id=suite_id,
                channel_ids={"gold": ["anthropic_official"], "candidate": ["third_party_demo"]},
                repeat_count=2,
                concurrency=8,
                use_mock=True,
            ),
        )
        run_id = run.id

    import asyncio

    asyncio.run(execute_run(SessionLocal, run_id, use_mock=True))

    with SessionLocal() as db:
        run = db.get(Run, run_id)
        result_count = db.scalar(select(func.count()).select_from(Result).where(Result.run_id == run_id))
        report_count = db.scalar(select(func.count()).select_from(Report).where(Report.run_id == run_id))

    assert run is not None
    assert run.status == "completed"
    assert result_count == run.total_jobs
    assert report_count >= 1


def test_baseline_build_then_candidate_eval_reuses_snapshot() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        baseline_run_response = client.post(
            "/api/baselines/build",
            json={
                "name": "pytest reusable baseline",
                "suite_id": suite_id,
                "channel_ids": {"gold": ["anthropic_official"], "official_cloud": ["aws_bedrock"]},
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        )
        assert baseline_run_response.status_code == 200
        baseline_run = baseline_run_response.json()

        baselines = client.get("/api/baselines", params={"suite_id": suite_id}).json()
        snapshot = next(item for item in baselines if item["source_run_id"] == baseline_run["id"])
        assert snapshot["status"] == "ready"

        eval_response = client.post(
            "/api/runs",
            json={
                "name": "pytest candidate eval",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "baseline_snapshot_id": snapshot["id"],
                "channel_ids": {"candidate": ["third_party_demo"]},
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        )
        assert eval_response.status_code == 200
        run = eval_response.json()
        payload = client.get(f"/api/runs/{run['id']}/results").json()

    assert payload["run"]["mode"] == "candidate_eval"
    assert payload["baseline_snapshot"]["id"] == snapshot["id"]
    assert payload["baseline_results"]
    assert payload["comparisons"]
    assert payload["reports"][0]["evidence"]["baseline_snapshot_id"] == snapshot["id"]
    evidence = payload["reports"][0]["evidence"]
    assert evidence["dimension_scores"]["authenticity"] is not None
    assert evidence["scoring_dimensions"]["protocol"] is not None
    assert set(evidence["scoring_dimensions"]).issuperset({"protocol", "streaming", "tool_use", "parameter_adherence", "capability", "stability", "latency", "cost_usage"})
    assert evidence["confidence"] in {"medium", "high"}
    assert isinstance(evidence["label_explanations"], list)
    assert evidence["classification_label"] in {"高度一致", "基本可信", "可疑（疑似中间层影响）", "疑似非原生 Claude", "高风险", "待复核"}
    assert isinstance(evidence["classification_reason"], str) and evidence["classification_reason"]
    assert isinstance(evidence["improvement_suggestions"], list) and evidence["improvement_suggestions"]


def test_baseline_snapshot_name_can_be_updated() -> None:
    reset_database()
    with TestClient(app) as client:
        _suite_id, _run, snapshot = create_ready_baseline(client, "old baseline name")
        response = client.patch(f"/api/baselines/{snapshot['id']}", json={"name": " renamed baseline "})

    assert response.status_code == 200
    assert response.json()["name"] == "renamed baseline"


def test_unreferenced_baseline_snapshot_can_be_deleted_with_results() -> None:
    reset_database()
    with TestClient(app) as client:
        _suite_id, _run, snapshot = create_ready_baseline(client, "delete me")
        delete_response = client.delete(f"/api/baselines/{snapshot['id']}", headers=ADMIN_HEADERS)
        get_response = client.get(f"/api/baselines/{snapshot['id']}")

    with SessionLocal() as db:
        result_count = db.scalar(select(func.count()).select_from(BaselineResult).where(BaselineResult.baseline_snapshot_id == snapshot["id"]))

    assert delete_response.status_code == 200
    assert delete_response.json() == {"deleted": True}
    assert get_response.status_code == 404
    assert result_count == 0


def test_delete_baseline_snapshot_rejects_candidate_eval_reference() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id, _run, snapshot = create_ready_baseline(client, "referenced baseline")
        eval_response = client.post(
            "/api/runs",
            json={
                "name": "uses baseline",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "baseline_snapshot_id": snapshot["id"],
                "channel_ids": {"candidate": ["third_party_demo"]},
                "use_mock": True,
            },
        )
        delete_response = client.delete(f"/api/baselines/{snapshot['id']}", headers=ADMIN_HEADERS)

    assert eval_response.status_code == 200
    assert delete_response.status_code == 409


def test_delete_baseline_snapshot_rejects_scheduled_test_reference() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id, _run, snapshot = create_ready_baseline(client, "scheduled referenced baseline")
        schedule_response = client.post(
            "/api/scheduled-tests",
            json={
                "name": "uses baseline schedule",
                "channel_id": "third_party_demo",
                "suite_id": suite_id,
                "baseline_snapshot_id": snapshot["id"],
                "interval_minutes": 60,
                "test_scope": "full",
            },
        )
        delete_response = client.delete(f"/api/baselines/{snapshot['id']}", headers=ADMIN_HEADERS)

    assert schedule_response.status_code == 200
    assert delete_response.status_code == 409


def test_delete_source_run_rejects_when_generated_baseline_is_referenced() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id, run, snapshot = create_ready_baseline(client, "source protected baseline")
        eval_response = client.post(
            "/api/runs",
            json={
                "name": "uses generated baseline",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "baseline_snapshot_id": snapshot["id"],
                "channel_ids": {"candidate": ["third_party_demo"]},
                "use_mock": True,
            },
        )
        delete_response = client.delete(f"/api/runs/{run['id']}", headers=ADMIN_HEADERS)

    assert eval_response.status_code == 200
    assert delete_response.status_code == 409


def test_candidate_eval_requires_valid_baseline() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        response = client.post(
            "/api/runs",
            json={
                "name": "missing baseline",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "channel_ids": {"candidate": ["third_party_demo"]},
                "use_mock": True,
            },
        )

    assert response.status_code == 400
    assert "baseline_snapshot_id" in response.json()["detail"]


def test_candidate_eval_rejects_stale_baseline_after_case_change() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id, _baseline_run, snapshot = create_ready_baseline(client, "stale baseline")
        case_id = client.get("/api/test-cases", params={"suite_id": suite_id}).json()[0]["id"]
        patch_response = client.patch(f"/api/test-cases/{case_id}", json={"prompt": "changed prompt invalidates the baseline"})
        assert patch_response.status_code == 200

        response = client.post(
            "/api/runs",
            json={
                "name": "should reject stale baseline",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "baseline_snapshot_id": snapshot["id"],
                "channel_ids": {"candidate": ["third_party_demo"]},
                "use_mock": True,
            },
        )

    assert response.status_code == 400
    assert "fingerprint" in response.json()["detail"]


def test_candidate_eval_keeps_baseline_ready_after_channel_config_changes() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id, _run, snapshot = create_ready_baseline(client, "channel config can change")
        patch_response = client.patch(
            "/api/channels/anthropic_official",
            json={
                "is_reference": False,
                "base_url": "https://changed.example/v1",
                "model_name": "changed-model",
                "auth_config": {"api_key": "changed-key"},
            },
        )
        eval_response = client.post(
            "/api/runs",
            json={
                "name": "uses historical baseline after channel change",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "baseline_snapshot_id": snapshot["id"],
                "channel_ids": {"candidate": ["third_party_demo"]},
                "use_mock": True,
            },
        )
        refreshed = client.get(f"/api/baselines/{snapshot['id']}")

    assert patch_response.status_code == 200
    assert eval_response.status_code == 200
    assert refreshed.status_code == 200
    assert refreshed.json()["status"] == "ready"


def test_invalid_baseline_with_results_is_restored_when_only_channel_check_was_stale() -> None:
    reset_database()
    with TestClient(app) as client:
        _suite_id, _run, snapshot = create_ready_baseline(client, "restore invalid baseline")

    with SessionLocal() as db:
        stored = db.get(BaselineSnapshot, snapshot["id"])
        assert stored is not None
        stored.status = "invalid"
        db.commit()

    with TestClient(app) as client:
        response = client.get(f"/api/baselines/{snapshot['id']}")

    assert response.status_code == 200
    assert response.json()["status"] == "ready"


def test_scheduled_channel_test_run_now_creates_run_and_alert_when_risky(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)

    async def fake_signature_interop(source, relay, stream=False):  # noqa: ANN001, ARG001
        return {
            "ok": True,
            "status": "pass",
            "reason": "兼容：relay 成功接受 source 的 thinking block signature",
            "source_channel_id": source.id,
            "relay_channel_id": relay.id,
            "source_message_id": "msg_bdrk_01source",
            "source_message_channel_type": "AWS Bedrock",
            "relay_message_id": "msg_vrtx_01relay",
            "relay_message_channel_type": "Vertex",
            "thinking_block_count": 1,
            "signature_prefixes": ["sig-source"],
            "fallback_note": "fallback note",
            "steps": [{"name": "最终判定", "status": "ok", "detail": "兼容", "excerpt": None}],
        }

    monkeypatch.setattr("app.services.test_signature_interop", fake_signature_interop)
    reset_database()
    with TestClient(app) as client:
        schedule_response = client.post(
            "/api/scheduled-tests",
            json={
                "name": "negative sample patrol",
                "channel_id": "negative_sample",
                "interval_minutes": 60,
                "enabled": True,
            },
        )
        assert schedule_response.status_code == 200
        schedule = schedule_response.json()

        run_now = client.post(f"/api/scheduled-tests/{schedule['id']}/run-now")
        assert run_now.status_code == 200
        run_now_payload = run_now.json()

    assert run_now_payload["last_status"] in {"queued", "completed"}
    if run_now_payload["last_status"] == "queued":
        asyncio.run(execute_scheduled_channel_test(SessionLocal, schedule["id"], advance_next_run=False))

    with TestClient(app) as client:
        updated_schedule = client.get(f"/api/scheduled-tests/{schedule['id']}").json()
        run_payload = client.get(f"/api/runs/{updated_schedule['last_run_id']}").json()
        alerts = client.get("/api/alerts", params={"status": "pending_review"}).json()

    assert updated_schedule["last_run_id"]
    assert updated_schedule["last_status"] == "completed"
    assert run_payload["patrol_channel_id"] == "negative_sample"
    assert run_payload["patrol_channel_name"] == "Negative Sample"
    assert run_payload["name"].startswith("Negative Sample - 自动巡检资源")
    assert "双探针" not in run_payload["name"]
    assert alerts
    assert alerts[0]["channel_id"] == "negative_sample"
    assert alerts[0]["notification_status"] == "skipped"

    with SessionLocal() as db:
        report = db.scalar(select(Report).where(Report.run_id == updated_schedule["last_run_id"], Report.channel_id == "negative_sample"))
        job = db.scalar(select(PatrolJob).where(PatrolJob.scheduled_test_id == schedule["id"], PatrolJob.run_id == updated_schedule["last_run_id"]))
        attempt = db.scalar(select(PatrolJobAttempt).where(PatrolJobAttempt.job_id == job.id)) if job else None

    assert report is not None
    assert report.evidence["signature_interop"]["ok"] is True
    assert job is not None
    assert job.status == "completed"
    assert job.run_id == updated_schedule["last_run_id"]
    assert attempt is not None
    assert attempt.status == "completed"
    assert attempt.run_id == updated_schedule["last_run_id"]




def test_scheduled_channel_test_signature_only_module_run_now(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    called = {"signature": 0, "model_probe": 0}

    async def fake_signature_interop(source, relay, stream=False):  # noqa: ANN001, ARG001
        called["signature"] += 1
        return {
            "ok": True,
            "status": "pass",
            "reason": "Signature 互通通过",
            "source_channel_id": source.id,
            "relay_channel_id": relay.id,
            "source_message_id": "msg_source",
            "relay_message_id": "msg_relay",
            "signature_prefixes": ["sig-ok"],
            "steps": [{"name": "最终判定", "status": "ok", "detail": "兼容", "excerpt": None}],
        }

    async def fake_model_probe(db, channel, scheduled):  # noqa: ANN001, ARG001
        called["model_probe"] += 1
        raise AssertionError("signature-only patrol must not run model request probes")

    monkeypatch.setattr("app.services.test_signature_interop", fake_signature_interop)
    monkeypatch.setattr("app.services.create_scheduled_model_request_probe", fake_model_probe)
    reset_database()
    with TestClient(app) as client:
        schedule_response = client.post(
            "/api/scheduled-tests",
            json={
                "name": "signature only patrol",
                "channel_id": "third_party_demo",
                "interval_minutes": 60,
                "enabled": True,
                "patrol_modules": ["signature_interop"],
            },
        )
        assert schedule_response.status_code == 200
        schedule = schedule_response.json()
        assert schedule["patrol_modules"] == ["signature_interop"]

    asyncio.run(execute_scheduled_channel_test(SessionLocal, schedule["id"], advance_next_run=False))

    assert called == {"signature": 1, "model_probe": 0}
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        assert scheduled.last_status == "completed"
        run = db.get(Run, scheduled.last_run_id)
        assert run is not None
        assert run.status == "completed"
        report = db.scalar(select(Report).where(Report.run_id == run.id, Report.channel_id == "third_party_demo"))
        assert report is not None
        assert report.evidence["patrol_modules"] == ["signature_interop"]
        assert report.evidence["signature_interop"]["ok"] is True
        assert report.evidence["model_requests"] == []


def test_scheduled_channel_test_model_request_probe_keys_subset(monkeypatch) -> None:
    from app.services import scheduled_model_request_probes, SCHEDULED_MODEL_REQUEST_PROBE_KEYS

    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        # Explicit subset is persisted and echoed back in registry order.
        response = client.post(
            "/api/scheduled-tests",
            json={
                "name": "subset probe patrol",
                "channel_id": "third_party_demo",
                "interval_minutes": 60,
                "enabled": True,
                "patrol_modules": ["model_request_probes"],
                "model_request_probe_keys": ["thinking_adaptive_enabled", "thinking_temperature"],
            },
        )
        assert response.status_code == 200
        schedule = response.json()
        assert schedule["model_request_probe_keys"] == ["thinking_temperature", "thinking_adaptive_enabled"]

        # Invalid sub-probe keys are rejected.
        bad = client.post(
            "/api/scheduled-tests",
            json={
                "name": "bad subset",
                "channel_id": "third_party_demo",
                "model_request_probe_keys": ["not_a_probe"],
            },
        )
        assert bad.status_code == 422

        # PATCH updates the selection.
        patched = client.patch(
            f"/api/scheduled-tests/{schedule['id']}",
            json={"model_request_probe_keys": ["web_search"]},
        )
        assert patched.status_code == 200
        assert patched.json()["model_request_probe_keys"] == ["web_search"]

    # The resolver runs only the selected sub-probes; None => full registry.
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        assert [probe["key"] for probe in scheduled_model_request_probes(scheduled)] == ["web_search"]
        scheduled.model_request_probe_keys = None
        assert [probe["key"] for probe in scheduled_model_request_probes(scheduled)] == SCHEDULED_MODEL_REQUEST_PROBE_KEYS


def test_run_delete_removes_patrol_job_history_and_resets_schedule_state() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["signature_interop_failed"])
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        scheduled.last_run_id = run_id
        scheduled.last_status = "completed"
        job = PatrolJob(
            id="pjob_delete_test",
            scheduled_test_id=schedule["id"],
            channel_id="negative_sample",
            status="completed",
            run_id=run_id,
        )
        db.add(job)
        db.add(PatrolJobAttempt(id="pattempt_delete_test", job_id=job.id, status="completed", run_id=run_id))
        db.commit()

    with TestClient(app) as client:
        response = client.delete(f"/api/runs/{run_id}", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        assert scheduled.last_run_id is None
        assert scheduled.last_status == "idle"
        assert db.get(PatrolJob, "pjob_delete_test") is None
        assert db.get(PatrolJobAttempt, "pattempt_delete_test") is None

def test_scheduled_test_tick_claims_overdue_schedule_and_advances_next_run(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = create_patrol_schedule(client, channel_id="third_party_demo")

    old_next = datetime.now(timezone.utc) - timedelta(minutes=10)
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        scheduled.next_run_at = old_next
        scheduled.locked_by = None
        scheduled.locked_until = None
        scheduled.last_status = "idle"
        db.commit()

    due_ids = asyncio.run(scheduled_test_tick(SessionLocal))

    assert schedule["id"] in due_ids
    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        job = db.scalar(select(PatrolJob).where(PatrolJob.scheduled_test_id == schedule["id"]))
        assert scheduled.last_status == "queued"
        assert scheduled.next_run_at is not None
        assert scheduled.next_run_at > old_next.replace(tzinfo=None)
        assert scheduled.locked_until is not None
        assert job is not None
        assert job.status == "queued"
        assert job.run_id is None


def test_scheduled_channel_test_supports_simplified_probe_create() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.post(
            "/api/scheduled-tests",
            json={
                "name": "simple probe patrol",
                "channel_id": "third_party_demo",
                "interval_minutes": 1440,
                "enabled": True,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["suite_id"] == "manual_model_request_probe"
    assert payload["baseline_snapshot_id"] == "scheduled_probe_baseline"
    assert payload["test_scope"] == "scheduled_probe"


def test_run_scheduled_test_now_returns_queued_before_background_execution(monkeypatch) -> None:
    executed: list[str] = []

    async def fake_execute_scheduled_channel_test(session_factory, scheduled_id, *, advance_next_run=True):  # noqa: ANN001, ARG001
        executed.append(scheduled_id)

    monkeypatch.setattr("app.main.execute_scheduled_channel_test", fake_execute_scheduled_channel_test)
    reset_database()
    with TestClient(app) as client:
        schedule = client.post(
            "/api/scheduled-tests",
            json={
                "name": "queued patrol",
                "channel_id": "third_party_demo",
                "interval_minutes": 60,
                "enabled": True,
            },
        ).json()
        response = client.post(f"/api/scheduled-tests/{schedule['id']}/run-now")

    assert response.status_code == 200
    payload = response.json()
    assert payload["last_status"] == "queued"
    assert payload["last_run_id"] is None
    assert executed == [schedule["id"]]


def test_scheduled_test_operations_write_audit_logs(monkeypatch) -> None:
    async def fake_execute_scheduled_channel_test(session_factory, scheduled_id, *, advance_next_run=True):  # noqa: ANN001, ARG001
        return None

    monkeypatch.setattr("app.main.execute_scheduled_channel_test", fake_execute_scheduled_channel_test)
    reset_database()
    actor_headers = {"X-Actor": "patrol-operator", "X-Request-Id": "req-audit-123"}
    with TestClient(app) as client:
        created = client.post(
            "/api/scheduled-tests",
            headers=actor_headers,
            json={
                "name": "audited patrol",
                "channel_id": "third_party_demo",
                "interval_minutes": 60,
                "enabled": True,
            },
        )
        assert created.status_code == 200
        schedule = created.json()

        updated = client.patch(
            f"/api/scheduled-tests/{schedule['id']}",
            headers=actor_headers,
            json={"name": "audited patrol updated", "interval_minutes": 120, "enabled": True},
        )
        assert updated.status_code == 200

        run_now = client.post(f"/api/scheduled-tests/{schedule['id']}/run-now", headers=actor_headers)
        assert run_now.status_code == 200

        deleted = client.delete(
            f"/api/scheduled-tests/{schedule['id']}",
            headers={**actor_headers, **ADMIN_HEADERS},
        )
        assert deleted.status_code == 200

        audit_response = client.get("/api/audit-logs", params={"target_id": schedule["id"]})

    assert audit_response.status_code == 200
    audit_logs = audit_response.json()
    actions = [item["action"] for item in audit_logs]
    assert actions == [
        "scheduled_test.delete",
        "scheduled_test.run_now",
        "scheduled_test.update",
        "scheduled_test.create",
    ]
    assert all(item["actor_id"] == "patrol-operator" for item in audit_logs)
    assert all(item["request_id"] == "req-audit-123" for item in audit_logs)
    update_log = next(item for item in audit_logs if item["action"] == "scheduled_test.update")
    assert update_log["before_summary"]["interval_minutes"] == 60
    assert update_log["after_summary"]["interval_minutes"] == 120
    assert update_log["audit_metadata"]["changed_fields"] == ["enabled", "interval_minutes", "name"]


def test_scheduled_channel_test_supports_run_window() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.post(
            "/api/scheduled-tests",
            json={
                "name": "window patrol",
                "channel_id": "third_party_demo",
                "interval_minutes": 60,
                "run_window_start": "09:00",
                "run_window_end": "18:00",
                "enabled": True,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["run_window_start"] == "09:00"
    assert payload["run_window_end"] == "18:00"


def test_scheduled_channel_test_update_preserves_hidden_policy_fields() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = client.post(
            "/api/scheduled-tests",
            json={
                "name": "hidden policy patrol",
                "channel_id": "third_party_demo",
                "interval_minutes": 60,
                "enabled": True,
                "quiet_minutes": 360,
                "max_retries": 2,
                "retry_interval_minutes": 15,
                "alert_grade_threshold": "C",
                "alert_score_threshold": 80,
                "alert_red_flags_enabled": False,
            },
        ).json()
        response = client.patch(
            f"/api/scheduled-tests/{schedule['id']}",
            json={
                "name": "renamed hidden policy patrol",
                "channel_id": "third_party_demo",
                "interval_minutes": 120,
                "run_window_start": None,
                "run_window_end": None,
                "enabled": True,
                "test_scope": "scheduled_probe",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["quiet_minutes"] == 360
    assert payload["max_retries"] == 2
    assert payload["retry_interval_minutes"] == 15
    assert payload["alert_grade_threshold"] == "C"
    assert payload["alert_score_threshold"] == 80
    assert payload["alert_red_flags_enabled"] is False


def test_scheduled_channel_test_rejects_invalid_run_window() -> None:
    reset_database()
    with TestClient(app) as client:
        missing_end = client.post(
            "/api/scheduled-tests",
            json={
                "name": "missing end",
                "channel_id": "third_party_demo",
                "interval_minutes": 60,
                "run_window_start": "09:00",
            },
        )
        same_time = client.post(
            "/api/scheduled-tests",
            json={
                "name": "same time",
                "channel_id": "third_party_demo",
                "interval_minutes": 60,
                "run_window_start": "09:00",
                "run_window_end": "09:00",
            },
        )
        invalid_time = client.post(
            "/api/scheduled-tests",
            json={
                "name": "invalid time",
                "channel_id": "third_party_demo",
                "interval_minutes": 60,
                "run_window_start": "24:00",
                "run_window_end": "09:00",
            },
        )

    assert missing_end.status_code == 422
    assert same_time.status_code == 422
    assert invalid_time.status_code == 422


def test_next_scheduled_run_at_respects_run_window() -> None:
    base = datetime.fromisoformat("2026-05-15T00:30:00+00:00")
    assert next_scheduled_run_at(base, 60, "09:00", "18:00") == datetime.fromisoformat("2026-05-15T01:30:00+00:00")
    assert next_scheduled_run_at(base, 600, "09:00", "18:00") == datetime.fromisoformat("2026-05-16T01:00:00+00:00")
    assert next_scheduled_run_at(base, 60, "22:00", "02:00") == datetime.fromisoformat("2026-05-15T14:00:00+00:00")
    assert next_scheduled_run_at(datetime.fromisoformat("2026-05-15T16:30:00+00:00"), 30, "22:00", "02:00") == datetime.fromisoformat("2026-05-15T17:00:00+00:00")


def test_refresh_active_scheduled_test_locks_extends_only_current_instance_locks(monkeypatch) -> None:
    reset_database()
    monkeypatch.setattr("app.services.SCHEDULER_INSTANCE_ID", "test-scheduler-instance")
    now = datetime.fromisoformat("2026-05-15T00:00:00+00:00")
    with SessionLocal() as db:
        current = ScheduledChannelTest(
            id="active_current_schedule",
            channel_id="third_party_demo",
            suite_id="manual_model_request_probe",
            baseline_snapshot_id="scheduled_probe_baseline",
            name="active current",
            last_status="running",
            locked_by="test-scheduler-instance",
            locked_until=now,
        )
        foreign = ScheduledChannelTest(
            id="active_foreign_schedule",
            channel_id="third_party_demo",
            suite_id="manual_model_request_probe",
            baseline_snapshot_id="scheduled_probe_baseline",
            name="active foreign",
            last_status="running",
            locked_by="other-scheduler-instance",
            locked_until=now,
        )
        db.add_all([current, foreign])
        db.commit()

        refreshed = refresh_active_scheduled_test_locks(db, {"active_current_schedule", "active_foreign_schedule"}, now=now)
        db.refresh(current)
        db.refresh(foreign)

    assert refreshed == 1
    assert current.locked_until is not None
    assert current.locked_until > now.replace(tzinfo=None)
    assert foreign.locked_until == now.replace(tzinfo=None)


def test_recover_stale_scheduled_tests_marks_running_job_attempt_failed() -> None:
    reset_database()
    stale_started = datetime.now(timezone.utc) - timedelta(seconds=7200)
    with SessionLocal() as db:
        schedule = ScheduledChannelTest(
            id="stale_attempt_schedule",
            channel_id="third_party_demo",
            suite_id="manual_model_request_probe",
            baseline_snapshot_id="scheduled_probe_baseline",
            name="stale attempt",
            enabled=True,
            last_status="running",
            locked_by="old-worker",
            locked_until=datetime.now(timezone.utc) + timedelta(minutes=30),
        )
        job = PatrolJob(
            id="stale_patrol_job",
            scheduled_test_id=schedule.id,
            channel_id="third_party_demo",
            status="running",
            started_at=stale_started,
        )
        attempt = PatrolJobAttempt(
            id="stale_patrol_attempt",
            job_id=job.id,
            attempt_index=0,
            worker_id="old-worker",
            status="running",
            started_at=stale_started,
            timeout_seconds=1,
        )
        db.add_all([schedule, job, attempt])
        db.commit()

    from app import services as services_module

    original_timeout = services_module.SCHEDULED_TEST_TASK_TIMEOUT_SECONDS
    services_module.SCHEDULED_TEST_TASK_TIMEOUT_SECONDS = 60
    try:
        with SessionLocal() as db:
            recovered = services_module.recover_stale_scheduled_tests(db, now=datetime.now(timezone.utc))
    finally:
        services_module.SCHEDULED_TEST_TASK_TIMEOUT_SECONDS = original_timeout

    with SessionLocal() as db:
        schedule = db.get(ScheduledChannelTest, "stale_attempt_schedule")
        job = db.get(PatrolJob, "stale_patrol_job")
        attempt = db.get(PatrolJobAttempt, "stale_patrol_attempt")

    assert recovered >= 3
    assert schedule is not None and schedule.last_status == "failed"
    assert schedule.locked_by is None
    assert schedule.next_run_at is not None
    assert job is not None and job.status == "failed"
    assert "恢复调度" in (job.last_error or "")
    assert attempt is not None and attempt.status == "failed"
    assert attempt.error_type == "scheduler_timeout"


def test_scheduled_test_loop_starts_due_tasks_without_waiting_for_completion(monkeypatch) -> None:
    reset_database()
    started: list[str] = []
    release = asyncio.Event()

    async def slow_execute(session_factory, scheduled_id, *, advance_next_run=True):  # noqa: ANN001, ARG001
        started.append(scheduled_id)
        await release.wait()

    async def no_daily_report(session_factory, *, force=False):  # noqa: ANN001, ARG001
        return {"ok": False, "status": "skipped", "message": "skip"}

    monkeypatch.setattr("app.services.execute_scheduled_channel_test", slow_execute)
    monkeypatch.setattr("app.services.send_daily_patrol_report", no_daily_report)
    with SessionLocal() as db:
        now = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.add_all([
            ScheduledChannelTest(
                id="nonblocking_schedule_one",
                channel_id="third_party_demo",
                suite_id="manual_model_request_probe",
                baseline_snapshot_id="scheduled_probe_baseline",
                name="nonblocking one",
                enabled=True,
                next_run_at=now,
                last_status="idle",
            ),
            ScheduledChannelTest(
                id="nonblocking_schedule_two",
                channel_id="third_party_demo",
                suite_id="manual_model_request_probe",
                baseline_snapshot_id="scheduled_probe_baseline",
                name="nonblocking two",
                enabled=True,
                next_run_at=now,
                last_status="idle",
            ),
        ])
        db.commit()

    async def run_loop_probe() -> None:
        task = asyncio.create_task(scheduled_test_loop(SessionLocal, poll_seconds=5))
        try:
            for _ in range(20):
                if len(started) >= 2:
                    break
                await asyncio.sleep(0.05)
            assert set(started) == {"nonblocking_schedule_one", "nonblocking_schedule_two"}
        finally:
            release.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run_loop_probe())


def test_scheduled_test_tick_respects_available_slots(monkeypatch) -> None:
    reset_database()

    async def no_daily_report(session_factory, *, force=False):  # noqa: ANN001, ARG001
        return {"ok": False, "status": "skipped", "message": "skip"}

    monkeypatch.setattr("app.services.send_daily_patrol_report", no_daily_report)
    with SessionLocal() as db:
        now = datetime.now(timezone.utc) - timedelta(minutes=1)
        for index in range(3):
            db.add(
                ScheduledChannelTest(
                    id=f"slot_schedule_{index}",
                    channel_id="third_party_demo",
                    suite_id="manual_model_request_probe",
                    baseline_snapshot_id="scheduled_probe_baseline",
                    name=f"slot {index}",
                    enabled=True,
                    next_run_at=now,
                    last_status="idle",
                )
            )
        db.commit()

    due_ids = asyncio.run(scheduled_test_tick(SessionLocal, available_slots=1))

    assert len(due_ids) == 1
    with SessionLocal() as db:
        queued_or_running = db.scalars(select(ScheduledChannelTest).where(ScheduledChannelTest.last_status == "queued")).all()
        idle = db.scalars(select(ScheduledChannelTest).where(ScheduledChannelTest.id.like("slot_schedule_%"), ScheduledChannelTest.last_status == "idle")).all()
    assert len(queued_or_running) == 1
    assert len(idle) == 2


def test_scheduled_task_timeout_marks_run_failed_and_releases_lock(monkeypatch) -> None:
    reset_database()
    with SessionLocal() as db:
        run = Run(
            id="timeout_run",
            suite_id="manual_model_request_probe",
            name="timeout run",
            mode="candidate_eval",
            test_scope="scheduled_probe",
            status="running",
            repeat_count=1,
            concurrency=1,
            total_jobs=1,
            completed_jobs=0,
        )
        schedule = ScheduledChannelTest(
            id="timeout_schedule",
            channel_id="third_party_demo",
            suite_id="manual_model_request_probe",
            baseline_snapshot_id="scheduled_probe_baseline",
            name="timeout schedule",
            enabled=True,
            last_status="running",
            last_run_id=run.id,
            locked_by="timeout-scheduler",
            locked_until=datetime.now(timezone.utc) + timedelta(minutes=30),
        )
        run.scheduled_test_id = schedule.id
        job = PatrolJob(id="timeout_job", scheduled_test_id=schedule.id, channel_id="third_party_demo", status="running", run_id=run.id)
        attempt = PatrolJobAttempt(id="timeout_attempt", job_id=job.id, attempt_index=0, status="running", run_id=run.id, started_at=datetime.now(timezone.utc) - timedelta(minutes=10))
        db.add(run)
        db.add(schedule)
        db.add(job)
        db.add(attempt)
        db.commit()

    async def never_finishes(session_factory, scheduled_id, *, advance_next_run=True):  # noqa: ANN001, ARG001
        await asyncio.sleep(60)

    from app import services as services_module

    monkeypatch.setattr("app.services.execute_scheduled_channel_test", never_finishes)
    asyncio.run(services_module._run_scheduled_test_with_timeout(SessionLocal, "timeout_schedule", timeout_seconds=1))

    with SessionLocal() as db:
        schedule = db.get(ScheduledChannelTest, "timeout_schedule")
        run = db.get(Run, "timeout_run")
        job = db.get(PatrolJob, "timeout_job")
        attempt = db.get(PatrolJobAttempt, "timeout_attempt")

    assert schedule is not None
    assert run is not None
    assert schedule.last_status == "failed"
    assert "超时释放调度锁" in (schedule.last_error or "")
    assert schedule.locked_by is None
    assert schedule.locked_until is None
    assert schedule.next_run_at is not None
    assert run.status == "failed"
    assert run.finished_at is not None
    assert job is not None and job.status == "failed"
    assert attempt is not None and attempt.status == "failed"


def test_scheduled_channel_test_signature_interop_failure_creates_alert(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)

    async def fake_signature_interop(source, relay, stream=False):  # noqa: ANN001, ARG001
        return {
            "ok": False,
            "status": "fail",
            "reason": "signature 不兼容：relay 无法使用 source 生成的 signature",
            "source_channel_id": source.id,
            "relay_channel_id": relay.id,
            "source_message_id": "msg_bdrk_01source",
            "source_message_channel_type": "AWS Bedrock",
            "relay_message_id": None,
            "relay_message_channel_type": "unknown",
            "thinking_block_count": 1,
            "signature_prefixes": ["sig-bad"],
            "fallback_note": "fallback note",
            "steps": [{"name": "最终判定", "status": "fail", "detail": "signature 不兼容", "excerpt": None}],
        }

    monkeypatch.setattr("app.services.test_signature_interop", fake_signature_interop)
    reset_database()
    with TestClient(app) as client:
        schedule = client.post(
            "/api/scheduled-tests",
            json={
                "name": "signature patrol",
                "channel_id": "third_party_demo",
                "interval_minutes": 60,
                "enabled": True,
            },
        ).json()

    asyncio.run(execute_scheduled_channel_test(SessionLocal, schedule["id"], advance_next_run=False))

    with TestClient(app) as client:
        updated_schedule = client.get(f"/api/scheduled-tests/{schedule['id']}").json()
        alerts = client.get("/api/alerts", params={"status": "pending_review"}).json()

    signature_alerts = [alert for alert in alerts if "signature_interop_failed" in (alert.get("trigger_labels") or [])]
    assert updated_schedule["last_status"] == "completed"
    assert signature_alerts

    with SessionLocal() as db:
        report = db.scalar(select(Report).where(Report.run_id == updated_schedule["last_run_id"], Report.channel_id == "third_party_demo"))

    assert report is not None
    assert report.evidence["signature_interop"]["status"] == "fail"
    assert "signature_interop_failed" in report.evidence["labels"]
    assert "Thinking Signature 互通" in (report.markdown or "")
    assert signature_alerts[0]["evidence_summary"]["signature_source_message_id"] == "msg_bdrk_01source"
    assert signature_alerts[0]["evidence_summary"]["signature_relay_channel_type"] == "unknown"


def test_scheduled_signature_relay_no_available_channel_does_not_create_alert(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = create_patrol_schedule(client, channel_id="negative_sample")

    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        run = Run(
            id="run_signature_provider_unavailable",
            suite_id=scheduled.suite_id,
            name="signature unavailable",
            mode="manual_probe",
            test_scope="quick",
            scheduled_test_id=scheduled.id,
            status="completed",
            repeat_count=1,
            concurrency=1,
            total_jobs=1,
            completed_jobs=1,
        )
        db.add(run)
        scheduled.last_run_id = run.id
        report = asyncio.run(
            build_scheduled_probe_report(
                SessionLocal,
                db,
                scheduled,
                run.id,
                None,
                {
                    "ok": False,
                    "status": "fail",
                    "reason": "relay 请求失败",
                    "raw_error": "Server error '503 Service Unavailable'; response body: No available channel for model claude-sonnet-4-6 under group awsp",
                    "error_http_status": 503,
                    "error_stage": "relay",
                    "relay_channel_id": "negative_sample",
                    "steps": [{"name": "步骤 B：发送 Relay 复用请求", "status": "fail", "detail": "relay 请求失败", "excerpt": "No available channel"}],
                },
            )
        )

    assert report.evidence["labels"] == ["provider_temporarily_unavailable"]
    assert "signature_interop_failed" not in report.evidence["labels"]

    alerts = asyncio.run(create_alerts_for_run(SessionLocal, "run_signature_provider_unavailable", schedule["id"]))
    with TestClient(app) as client:
        pending_alerts = client.get("/api/alerts", params={"status": "pending_review"}).json()

    assert alerts == []
    assert pending_alerts == []


def test_scheduled_alert_policy_uses_grade_score_and_red_flag_settings(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(
            client,
            alert_grade_threshold="E",
            alert_score_threshold=85,
            alert_red_flags_enabled=False,
        )

    red_flag_run_id = create_report_for_schedule(schedule, grade="B", score=90, labels=["identity_mismatch"])
    score_run_id = create_report_for_schedule(schedule, grade="B", score=80)
    grade_run_id = create_report_for_schedule(schedule, grade="E", score=95)

    asyncio.run(create_alerts_for_run(SessionLocal, red_flag_run_id, schedule["id"]))
    asyncio.run(create_alerts_for_run(SessionLocal, score_run_id, schedule["id"]))
    asyncio.run(create_alerts_for_run(SessionLocal, grade_run_id, schedule["id"]))

    with TestClient(app) as client:
        alerts = client.get("/api/alerts", params={"status": "pending_review"}).json()

    assert {alert["run_id"] for alert in alerts} == {score_run_id, grade_run_id}


def test_scheduled_probe_alert_policy_includes_failed_grade_without_red_flag(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = create_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="D", score=65, labels=["provider_error_variant"])
    with SessionLocal() as db:
        report = db.scalar(select(Report).where(Report.run_id == run_id))
        assert report is not None
        report.evidence = {"labels": ["provider_error_variant"], "red_flags": [], "test_scope": "scheduled_probe"}
        db.commit()

    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with TestClient(app) as client:
        alerts = client.get("/api/alerts", params={"status": "pending_review"}).json()

    assert len(alerts) == 1
    assert alerts[0]["run_id"] == run_id


def test_scheduled_alert_policy_supports_c_grade_threshold(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, alert_grade_threshold="C")

    run_id = create_report_for_schedule(schedule, grade="C", score=78)
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with TestClient(app) as client:
        alerts = client.get("/api/alerts", params={"status": "pending_review"}).json()

    assert len(alerts) == 1
    assert alerts[0]["run_id"] == run_id


def test_scheduled_alert_quiet_window_skips_duplicate_pending_alert(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample", quiet_minutes=360)

    first_run_id = create_report_for_schedule(schedule, grade="E", score=20)
    second_run_id = create_report_for_schedule(schedule, grade="E", score=25)
    asyncio.run(create_alerts_for_run(SessionLocal, first_run_id, schedule["id"]))
    asyncio.run(create_alerts_for_run(SessionLocal, second_run_id, schedule["id"]))

    with TestClient(app) as client:
        alerts = client.get("/api/alerts", params={"status": "pending_review"}).json()

    assert len(alerts) == 1
    assert alerts[0]["run_id"] == first_run_id


def test_scheduled_channel_test_retries_failed_runs(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    sleep_calls: list[int] = []
    attempts = 0

    async def fake_execute_run(session_factory, run_id, runtime_credentials=None, use_mock=True, benchmark_config=None, arena_config=None):  # noqa: ANN001, ARG001
        nonlocal attempts
        attempts += 1
        with session_factory() as db:
            run = db.get(Run, run_id)
            assert run is not None
            run.status = "failed" if attempts == 1 else "completed"
            run.finished_at = run.finished_at or None
            db.add(
                Report(
                    id=f"rep_retry_{attempts}",
                    run_id=run.id,
                    channel_id="third_party_demo",
                    final_score=100,
                    grade="A",
                    summary="retry report",
                    evidence={"labels": []},
                    markdown="# retry report",
                )
            )
            db.commit()

    async def fake_sleep(seconds):  # noqa: ANN001
        sleep_calls.append(seconds)

    async def fake_attach_signature(session_factory, run_id, scheduled_id):  # noqa: ANN001, ARG001
        return None

    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, max_retries=1, retry_interval_minutes=1)

    monkeypatch.setattr("app.services.execute_run", fake_execute_run)
    monkeypatch.setattr("app.services.asyncio.sleep", fake_sleep)
    monkeypatch.setattr("app.services.attach_signature_interop_to_scheduled_run", fake_attach_signature)
    asyncio.run(execute_scheduled_channel_test(SessionLocal, schedule["id"], advance_next_run=False))

    with SessionLocal() as db:
        updated_schedule = db.get(ScheduledChannelTest, schedule["id"])

    assert attempts == 2
    assert sleep_calls == [60]
    assert updated_schedule is not None
    assert updated_schedule.last_status == "completed"


def test_alert_review_updates_status_and_reviewer() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with TestClient(app) as client:
        alert = client.get("/api/alerts", params={"status": "pending_review"}).json()[0]
        response = client.patch(
            f"/api/alerts/{alert['id']}/review",
            json={"status": "confirmed_issue", "reviewer_name": "admin", "review_note": "已联系供应商复查"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "confirmed_issue"
    assert payload["reviewer_name"] == "admin"
    assert payload["reviewed_at"]


def test_list_alerts_filters_by_any_locator_id_and_time_range() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with SessionLocal() as db:
        alert = db.scalar(select(ChannelAlert).where(ChannelAlert.run_id == run_id))
        assert alert is not None
        report = db.get(Report, alert.report_id)
        assert report is not None
        result = Result(
            id="res_locator_probe",
            run_id=run_id,
            test_case_id="manual_thinking_temperature_probe",
            channel_id=schedule["channel_id"],
            attempt_index=1,
            normalized_response={"provider_message_id": "msg_01locator"},
            raw_request={"headers": {"x-client-request-id": "client_req_locator"}},
            raw_response={"type": "error", "error": {"request_id": "req_locator_123", "message": "blocked"}},
            metrics={},
            score=0,
            labels=["request_failed"],
        )
        report.evidence = {
            "labels": ["identity_mismatch"],
            "red_flags": ["identity_mismatch"],
            "model_request": {
                "result_id": result.id,
                "message_id": "msg_01locator",
            },
            "model_requests": [
                {
                    "result_id": result.id,
                    "message_id": "msg_01locator",
                }
            ],
            "signature_interop": {
                "source_message_id": "msg_bdrk_locator",
                "relay_message_id": "msg_relay_locator",
            },
        }
        db.add(result)
        db.commit()
        alert_created_at = alert.created_at or datetime.now(timezone.utc)

    created_from = (alert_created_at - timedelta(minutes=1)).isoformat()
    created_to = (alert_created_at + timedelta(minutes=1)).isoformat()
    outside_from = (alert_created_at + timedelta(days=1)).isoformat()
    outside_to = (alert_created_at + timedelta(days=1, minutes=5)).isoformat()

    with TestClient(app) as client:
        for locator in [run_id, "res_locator_probe", "msg_01locator", "msg_bdrk_locator", "req_locator_123", "client_req_locator"]:
            response = client.get(
                "/api/alerts",
                params={"status": "pending_review", "id_query": locator, "created_from": created_from, "created_to": created_to},
            )
            assert response.status_code == 200
            assert [item["id"] for item in response.json()] == [alert.id]

        response = client.get(
            "/api/alerts",
            params={"status": "pending_review", "id_query": "req_locator_123", "created_from": outside_from, "created_to": outside_to},
        )

    assert response.status_code == 200
    assert response.json() == []


def test_list_alerts_tolerates_legacy_malformed_alert_fields() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with SessionLocal() as db:
        alert = db.scalar(select(ChannelAlert).where(ChannelAlert.run_id == run_id))
        assert alert is not None
        alert.trigger_labels = {"legacy": "identity_mismatch"}
        db.commit()

    with TestClient(app) as client:
        response = client.get("/api/alerts", params={"status": "pending_review"})

    assert response.status_code == 200
    payload = response.json()
    assert payload
    assert payload[0]["trigger_labels"] == ["{'legacy': 'identity_mismatch'}"]


def test_list_alerts_matches_channel_and_run_names() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, name="夜间巡检计划", channel_id="third_party_demo")

    with SessionLocal() as db:
        channel = db.get(Channel, "third_party_demo")
        assert channel is not None
        channel.name = "阿宝中转"
        db.commit()

    run_id = create_report_for_schedule(schedule, grade="D", score=42, labels=["identity_mismatch"])
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with SessionLocal() as db:
        run = db.get(Run, run_id)
        assert run is not None
        run.name = "阿宝夜间巡检日志"
        alert = db.scalar(select(ChannelAlert).where(ChannelAlert.run_id == run_id))
        assert alert is not None
        db.commit()
        alert_id = alert.id

    with TestClient(app) as client:
        by_channel = client.get("/api/alerts", params={"status": "pending_review", "id_query": "阿宝中转"})
        by_run = client.get("/api/alerts", params={"status": "pending_review", "id_query": "夜间巡检日志"})

    assert by_channel.status_code == 200
    assert [item["id"] for item in by_channel.json()] == [alert_id]
    assert by_run.status_code == 200
    assert [item["id"] for item in by_run.json()] == [alert_id]


def test_list_alerts_sanitizes_non_finite_alert_values() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with SessionLocal() as db:
        alert = db.scalar(select(ChannelAlert).where(ChannelAlert.run_id == run_id))
        assert alert is not None
        report = db.get(Report, alert.report_id)
        assert report is not None
        alert.final_score = float("inf")
        report.evidence = {
            "labels": ["identity_mismatch"],
            "model_requests": [
                {
                    "title": "bad numeric evidence",
                    "score": float("inf"),
                    "completed_at": "2026-05-17T00:00:00+00:00",
                }
            ],
        }
        db.commit()

    with TestClient(app) as client:
        response = client.get("/api/alerts", params={"status": "pending_review"})

    assert response.status_code == 200
    payload = response.json()
    assert payload
    assert payload[0]["final_score"] == 0.0
    assert payload[0]["evidence_summary"]["model_requests"][0]["score"] is None
    assert payload[0]["evidence_summary"]["model_requests"][0]["completed_at"] == "2026-05-17T00:00:00+00:00"


def test_smart_patrol_report_tolerates_legacy_malformed_alert_fields() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with SessionLocal() as db:
        alert = db.scalar(select(ChannelAlert).where(ChannelAlert.run_id == run_id))
        assert alert is not None
        alert.trigger_labels = {"legacy": "identity_mismatch"}
        db.commit()

    with TestClient(app) as client:
        response = client.get("/api/scheduled-tests/report")
        markdown = client.get("/api/scheduled-tests/report.md")

    assert response.status_code == 200
    payload = response.json()
    assert payload["recent_alerts"]
    assert payload["recent_alerts"][0]["trigger_labels"] == ["{'legacy': 'identity_mismatch'}"]
    assert markdown.status_code == 200
    assert "智能巡检汇总报告" in markdown.text


def test_smart_patrol_report_sanitizes_non_finite_alert_values() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with SessionLocal() as db:
        alert = db.scalar(select(ChannelAlert).where(ChannelAlert.run_id == run_id))
        assert alert is not None
        report = db.get(Report, alert.report_id)
        assert report is not None
        alert.final_score = -math.inf
        report.evidence = {
            "labels": ["identity_mismatch"],
            "model_requests": [{"title": "bad report evidence", "score": math.nan}],
        }
        db.commit()

    with TestClient(app) as client:
        response = client.get("/api/scheduled-tests/report")

    assert response.status_code == 200
    payload = response.json()
    assert payload["recent_alerts"]
    assert payload["recent_alerts"][0]["final_score"] == 0.0
    assert payload["recent_alerts"][0]["evidence_summary"]["model_requests"][0]["score"] is None


def test_scheduled_test_rejects_reference_channel() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.post(
            "/api/scheduled-tests",
            json={
                "name": "bad patrol",
                "channel_id": "anthropic_official",
                "interval_minutes": 60,
            },
        )

    assert response.status_code == 400
    assert "candidate" in response.json()["detail"]


def test_feishu_broadcast_setting_masks_secret_and_preserves_existing_secret() -> None:
    reset_database()
    with TestClient(app) as client:
        missing_webhook = client.patch("/api/settings/feishu-broadcast", json={"enabled": True})
        assert missing_webhook.status_code == 400
        assert "Webhook" in missing_webhook.json()["detail"]

        response = client.patch(
            "/api/settings/feishu-broadcast",
            json={
                "enabled": True,
                "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
                "webhook_secret": "secret-value",
                "app_base_url": "http://localhost:5174/",
                "daily_report_time": "09:00",
                "timezone": "Asia/Shanghai",
            },
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["webhook_configured"] is True
        assert payload["secret_configured"] is True
        assert "test-token" not in payload["webhook_preview"]

        response = client.patch("/api/settings/feishu-broadcast", json={"enabled": False})
        assert response.status_code == 200
        payload = response.json()

        response = client.patch("/api/settings/feishu-broadcast", json={"webhook_url": "", "webhook_secret": ""})
        assert response.status_code == 200
        preserved = response.json()

    assert payload["enabled"] is False
    assert payload["secret_configured"] is True
    assert payload["app_base_url"] == "http://localhost:5174"
    assert preserved["webhook_configured"] is True
    assert preserved["secret_configured"] is True


def test_alert_notification_marks_sent_when_feishu_post_succeeds(monkeypatch) -> None:
    posted_payloads: list[tuple[str, dict]] = []

    async def fake_post_feishu_payload(webhook_url, payload):  # noqa: ANN001
        posted_payloads.append((webhook_url, payload))

    monkeypatch.setattr("app.services.post_feishu_payload", fake_post_feishu_payload)
    reset_database()
    with TestClient(app) as client:
        schedule = create_patrol_schedule(client, quiet_minutes=0)
        run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["suspected_model_swap"])
        setting_response = client.patch(
            "/api/settings/feishu-broadcast",
            json={
                "enabled": True,
                "alert_broadcast_enabled": True,
                "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
                "app_base_url": "http://localhost:5173",
            },
        )
        assert setting_response.status_code == 200

    alerts = asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    assert len(alerts) == 1
    assert len(posted_payloads) == 1
    assert posted_payloads[0][0].endswith("/test-token")
    with SessionLocal() as db:
        alert = db.get(ChannelAlert, alerts[0].id)
        assert alert is not None
        assert alert.notification_status == "sent"
        assert alert.notification_error is None
        assert alert.notification_attempt_count == 1
        assert alert.notified_at is not None


def test_alert_notification_marks_failed_when_feishu_post_fails(monkeypatch) -> None:
    attempts: list[str] = []

    async def fake_post_feishu_payload(webhook_url, payload):  # noqa: ANN001, ARG001
        attempts.append(webhook_url)
        raise RuntimeError("simulated feishu outage")

    monkeypatch.setattr("app.services.post_feishu_payload", fake_post_feishu_payload)
    reset_database()
    with TestClient(app) as client:
        schedule = create_patrol_schedule(client, quiet_minutes=0)
        run_id = create_report_for_schedule(schedule, grade="E", score=15, labels=["signature_interop_failed"])
        setting_response = client.patch(
            "/api/settings/feishu-broadcast",
            json={
                "enabled": True,
                "alert_broadcast_enabled": True,
                "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
            },
        )
        assert setting_response.status_code == 200

    alerts = asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    assert len(alerts) == 1
    assert len(attempts) == 3
    with SessionLocal() as db:
        alert = db.get(ChannelAlert, alerts[0].id)
        assert alert is not None
        assert alert.notification_status == "failed"
        assert "simulated feishu outage" in (alert.notification_error or "")
        assert alert.notification_attempt_count == 1
        assert alert.notified_at is None


def test_channel_taxonomy_setting_returns_defaults_and_allows_label_updates() -> None:
    reset_database()
    with TestClient(app) as client:
        defaults = client.get("/api/settings/channel-taxonomy")
        updated = client.patch(
            "/api/settings/channel-taxonomy",
            json={
                "role_labels": {"candidate": "客户待测渠道"},
                "provider_type_labels": {"third_party_anthropic": "Claude 中转协议"},
            },
        )
        reset_candidate = client.patch("/api/settings/channel-taxonomy", json={"role_labels": {"candidate": ""}})

    assert defaults.status_code == 200
    default_payload = defaults.json()
    assert default_payload["role_labels"]["candidate"] == "待测第三方"
    assert default_payload["provider_type_labels"] == {}
    assert default_payload["model_options"] == []
    assert updated.status_code == 200
    assert updated.json()["role_labels"]["candidate"] == "客户待测渠道"
    assert updated.json()["provider_type_labels"]["third_party_anthropic"] == "Claude 中转协议"
    assert reset_candidate.status_code == 200
    assert reset_candidate.json()["role_labels"]["candidate"] == "待测第三方"


def test_channel_taxonomy_allows_custom_keys_and_run_uses_reference_semantics() -> None:
    reset_database()
    with TestClient(app) as client:
        custom = client.patch(
            "/api/settings/channel-taxonomy",
            json={
                "role_labels": {"custom_role": "自定义角色"},
                "provider_type_labels": {"custom_provider": "自定义供应商"},
                "model_options": ["custom-model"],
            },
        )
        suite_id = client.get("/api/suites").json()[0]["id"]
        client.patch("/api/settings/channel-taxonomy", json={"role_labels": {"candidate": "客户待测渠道"}})
        response = client.post(
            "/api/runs",
            json={
                "name": "taxonomy labels do not affect role keys",
                "suite_id": suite_id,
                "channel_ids": {"gold": ["anthropic_official"], "candidate": ["third_party_demo"]},
                "use_mock": True,
            },
        )
        payload = client.get(f"/api/runs/{response.json()['id']}/results").json()

    assert custom.status_code == 200
    assert custom.json()["role_labels"]["custom_role"] == "自定义角色"
    assert custom.json()["provider_type_labels"]["custom_provider"] == "自定义供应商"
    assert custom.json()["model_options"] == ["custom-model"]
    assert response.status_code == 200
    assert payload["run_channels"]
    assert {item["role_in_run"] for item in payload["run_channels"]} == {"reference", "candidate"}
    assert payload["reports"]


def test_channel_create_defaults_provider_type_and_role() -> None:
    reset_database()
    with TestClient(app) as client:
        created = client.post(
            "/api/channels",
            json={
                "name": "Custom Internal Channel",
                "model_name": "claude-via-gateway",
                "enabled": True,
            },
        )
        custom_provider = client.post(
            "/api/channels",
            json={
                "name": "Custom Provider Channel",
                "provider_type": "customer_gateway",
                "model_name": "claude-via-gateway",
                "enabled": True,
            },
        )
        reference = client.post(
            "/api/channels",
            json={
                "name": "Custom Reference Channel",
                "model_name": "claude-reference",
                "is_reference": True,
                "enabled": True,
            },
        )

    assert created.status_code == 200
    assert created.json()["provider_type"] == "custom_provider"
    assert created.json()["role"] == "candidate"
    assert "protocol_type" not in created.json()
    assert custom_provider.status_code == 200
    assert custom_provider.json()["provider_type"] == "customer_gateway"
    assert reference.status_code == 200
    assert reference.json()["provider_type"] == "custom_provider"
    assert reference.json()["role"] == "gold"


def test_channel_api_key_is_updatable_but_redacted_in_api_response() -> None:
    reset_database()
    with TestClient(app) as client:
        created = client.post(
            "/api/channels",
            json={
                "name": "Editable Key Channel",
                "provider_type": "customer_gateway",
                "model_name": "claude-via-gateway",
                "auth_config": {"api_key": "first-key"},
                "enabled": True,
            },
        )
        channel_id = created.json()["id"]
        updated = client.patch(f"/api/channels/{channel_id}", json={"auth_config": {"api_key": "second-key"}})
        with SessionLocal() as db:
            stored_after_update = db.get(Channel, channel_id)
            stored_auth_after_update = dict(stored_after_update.auth_config) if stored_after_update else {}
        cleared = client.patch(f"/api/channels/{channel_id}", json={"auth_config": {}})

    assert created.status_code == 200
    assert "first-key" not in json.dumps(created.json(), ensure_ascii=False)
    assert "[REDACTED]" in created.json()["auth_config"]["api_key"]
    assert updated.status_code == 200
    assert "second-key" not in json.dumps(updated.json(), ensure_ascii=False)
    assert "[REDACTED]" in updated.json()["auth_config"]["api_key"]
    assert stored_auth_after_update == {"api_key": "second-key"}
    assert cleared.status_code == 200
    assert cleared.json()["auth_config"] == {}


def test_channel_update_preserves_existing_secret_when_redacted_placeholder_is_submitted() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = create_channel(
            db,
            ChannelCreate(
                id="redacted_placeholder_channel",
                name="Redacted Placeholder Channel",
                provider_type="anthropic",
                model_name="claude-test",
                auth_config={"api_key": "real-secret-key", "request_protocol": "auto"},
            ),
        )
        channel_id = channel.id

    with TestClient(app) as client:
        current = client.get(f"/api/channels/{channel_id}").json()
        placeholder = current["auth_config"]["api_key"]
        updated = client.patch(
            f"/api/channels/{channel_id}",
            json={"auth_config": {"api_key": placeholder, "request_protocol": "anthropic_messages"}},
        )

    with SessionLocal() as db:
        stored = db.get(Channel, channel_id)

    assert updated.status_code == 200
    assert placeholder != "real-secret-key"
    assert stored is not None
    assert stored.auth_config["api_key"] == "real-secret-key"
    assert stored.auth_config["request_protocol"] == "anthropic_messages"


def test_channel_secret_ref_is_redacted_in_api_response_and_resolved_from_env(monkeypatch) -> None:
    monkeypatch.setenv("CLAUDE_PATROL_TEST_API_KEY", "sk-env-secret-abcdef")
    reset_database()
    with TestClient(app) as client:
        created = client.post(
            "/api/channels",
            json={
                "name": "Env Secret Channel",
                "provider_type": "anthropic",
                "model_name": "claude-test",
                "auth_config": {
                    "secret_ref": "env:CLAUDE_PATROL_TEST_API_KEY",
                    "request_protocol": "anthropic_messages",
                },
                "enabled": True,
            },
        )
        channel_id = created.json()["id"]

    assert created.status_code == 200
    created_blob = json.dumps(created.json(), ensure_ascii=False)
    assert "CLAUDE_PATROL_TEST_API_KEY" not in created_blob
    assert "sk-env-secret-abcdef" not in created_blob
    assert "[REDACTED]" in created.json()["auth_config"]["secret_ref"]

    with SessionLocal() as db:
        stored = db.get(Channel, channel_id)
        assert stored is not None
        assert stored.auth_config["secret_ref"] == "env:CLAUDE_PATROL_TEST_API_KEY"
        assert _merged_channel_credentials(stored, {})["api_key"] == "sk-env-secret-abcdef"
        assert _merged_channel_credentials(stored, {"api_key": "runtime-key"})["api_key"] == "runtime-key"


def test_channel_delete_cascades_referenced_channel_without_admin_key() -> None:
    reset_database()
    with SessionLocal() as db:
        run = Run(
            id="run_references_channel_delete",
            suite_id="claude_full_35",
            name="references channel delete",
            mode="candidate_eval",
            status="completed",
            repeat_count=1,
            concurrency=1,
            total_jobs=1,
            completed_jobs=1,
        )
        report = Report(
            id="report_references_channel_delete",
            run_id=run.id,
            channel_id="third_party_demo",
            final_score=60,
            grade="D",
            summary="delete me",
        )
        schedule = ScheduledChannelTest(
            id="schedule_references_channel_delete",
            channel_id="third_party_demo",
            suite_id="claude_full_35",
            baseline_snapshot_id="snapshot_unused_delete",
            name="delete schedule",
            last_run_id=run.id,
        )
        job = PatrolJob(
            id="job_references_channel_delete",
            scheduled_test_id=schedule.id,
            channel_id="third_party_demo",
            status="queued",
            run_id=run.id,
        )
        db.add(run)
        db.add(RunChannel(id="run_channel_references_delete", run_id=run.id, channel_id="third_party_demo", role_in_run="candidate"))
        db.add(Result(id="result_references_channel_delete", run_id=run.id, test_case_id="case_builtin_math_json", channel_id="third_party_demo", normalized_response={}, raw_request={}, raw_response={}, metrics={}, score=0, labels=[]))
        db.add(Comparison(id="comparison_references_channel_delete", run_id=run.id, test_case_id="case_builtin_math_json", candidate_channel_id="third_party_demo", final_score=0))
        db.add(report)
        db.add(ChannelAlert(id="alert_references_channel_delete", scheduled_test_id=schedule.id, run_id=run.id, report_id=report.id, channel_id="third_party_demo", grade="D", final_score=60))
        db.add(schedule)
        db.add(job)
        db.add(PatrolJobAttempt(id="attempt_references_channel_delete", job_id=job.id, run_id=run.id, status="running"))
        db.add(BaselineResult(id="baseline_result_references_channel_delete", baseline_snapshot_id="snapshot_unused_delete", test_case_id="case_builtin_math_json", channel_id="third_party_demo", role_in_baseline="candidate"))
        db.commit()

    with TestClient(app) as client:
        response = client.delete("/api/channels/third_party_demo")

    payload = response.json()
    assert response.status_code == 200
    assert payload["deleted"] is True
    assert payload["deleted_runs"] == 1
    assert payload["deleted_results"] >= 1
    assert payload["deleted_reports"] >= 1
    assert payload["deleted_alerts"] >= 1
    assert payload["deleted_schedules"] >= 1
    assert payload["deleted_baselines"] >= 1
    with SessionLocal() as db:
        assert db.get(Channel, "third_party_demo") is None
        assert db.get(Run, "run_references_channel_delete") is None
        assert db.get(ScheduledChannelTest, "schedule_references_channel_delete") is None
        assert db.get(PatrolJob, "job_references_channel_delete") is None


def test_channel_delete_keeps_shared_run_for_other_channels() -> None:
    reset_database()
    with SessionLocal() as db:
        run = Run(
            id="run_shared_channel_delete",
            suite_id="claude_full_35",
            name="shared channel delete",
            mode="candidate_eval",
            status="completed",
            repeat_count=1,
            concurrency=1,
            total_jobs=2,
            completed_jobs=2,
        )
        db.add(run)
        db.add(RunChannel(id="run_channel_delete_target", run_id=run.id, channel_id="third_party_demo", role_in_run="candidate"))
        db.add(RunChannel(id="run_channel_delete_other", run_id=run.id, channel_id="anthropic_official", role_in_run="gold"))
        db.add(Result(id="result_delete_target", run_id=run.id, test_case_id="case_builtin_math_json", channel_id="third_party_demo", normalized_response={}, raw_request={}, raw_response={}, metrics={}, score=0, labels=[]))
        db.add(Result(id="result_delete_other", run_id=run.id, test_case_id="case_builtin_math_json", channel_id="anthropic_official", normalized_response={}, raw_request={}, raw_response={}, metrics={}, score=100, labels=[]))
        db.commit()

    with TestClient(app) as client:
        response = client.delete("/api/channels/third_party_demo")

    assert response.status_code == 200
    assert response.json()["deleted_runs"] == 0
    with SessionLocal() as db:
        assert db.get(Channel, "third_party_demo") is None
        assert db.get(Run, "run_shared_channel_delete") is not None
        assert db.get(Result, "result_delete_target") is None
        assert db.get(Result, "result_delete_other") is not None
        assert db.get(RunChannel, "run_channel_delete_target") is None
        assert db.get(RunChannel, "run_channel_delete_other") is not None


def test_channel_delete_large_related_history_keeps_shared_runs_and_removes_private_runs() -> None:
    reset_database()
    private_run_ids: list[str] = []
    shared_run_ids: list[str] = []
    with SessionLocal() as db:
        for index in range(60):
            run_id = f"channel_perf_private_run_{index}"
            report_id = f"channel_perf_private_report_{index}"
            private_run_ids.append(run_id)
            db.add(Run(id=run_id, suite_id="claude_full_35", name=f"private {index}", mode="candidate_eval", status="completed", repeat_count=1, concurrency=1, total_jobs=1, completed_jobs=1))
            db.add(RunChannel(id=f"channel_perf_private_rch_{index}", run_id=run_id, channel_id="third_party_demo", role_in_run="candidate"))
            db.add(Result(id=f"channel_perf_private_result_{index}", run_id=run_id, test_case_id="case_builtin_math_json", channel_id="third_party_demo", normalized_response={}, raw_request={}, raw_response={}, metrics={}, score=0, labels=[]))
            db.add(Report(id=report_id, run_id=run_id, channel_id="third_party_demo", final_score=60, grade="D", summary="private"))
            db.add(ChannelAlert(id=f"channel_perf_private_alert_{index}", scheduled_test_id="sched_perf_delete", run_id=run_id, report_id=report_id, channel_id="third_party_demo", grade="D", final_score=60))
            job = PatrolJob(id=f"channel_perf_private_job_{index}", scheduled_test_id="sched_perf_delete", channel_id="third_party_demo", status="completed", run_id=run_id)
            db.add(job)
            db.add(PatrolJobAttempt(id=f"channel_perf_private_attempt_{index}", job_id=job.id, run_id=run_id, status="completed"))
        for index in range(15):
            run_id = f"channel_perf_shared_run_{index}"
            shared_run_ids.append(run_id)
            db.add(Run(id=run_id, suite_id="claude_full_35", name=f"shared {index}", mode="candidate_eval", status="completed", repeat_count=1, concurrency=1, total_jobs=2, completed_jobs=2))
            db.add(RunChannel(id=f"channel_perf_shared_target_rch_{index}", run_id=run_id, channel_id="third_party_demo", role_in_run="candidate"))
            db.add(RunChannel(id=f"channel_perf_shared_other_rch_{index}", run_id=run_id, channel_id="anthropic_official", role_in_run="gold"))
            db.add(Result(id=f"channel_perf_shared_target_result_{index}", run_id=run_id, test_case_id="case_builtin_math_json", channel_id="third_party_demo", normalized_response={}, raw_request={}, raw_response={}, metrics={}, score=0, labels=[]))
            db.add(Result(id=f"channel_perf_shared_other_result_{index}", run_id=run_id, test_case_id="case_builtin_math_json", channel_id="anthropic_official", normalized_response={}, raw_request={}, raw_response={}, metrics={}, score=100, labels=[]))
        db.add(ScheduledChannelTest(id="sched_perf_delete", channel_id="third_party_demo", suite_id="claude_full_35", baseline_snapshot_id="snapshot_unused_delete", name="perf delete schedule", last_run_id=private_run_ids[-1]))
        db.commit()

    with TestClient(app) as client:
        response = client.delete("/api/channels/third_party_demo")

    assert response.status_code == 200
    payload = response.json()
    assert payload["deleted_runs"] == len(private_run_ids)
    assert payload["deleted_results"] >= len(private_run_ids) + len(shared_run_ids)
    assert payload["deleted_schedules"] >= 1
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Run).where(Run.id.in_(private_run_ids))) == 0
        assert db.scalar(select(func.count()).select_from(Run).where(Run.id.in_(shared_run_ids))) == len(shared_run_ids)
        assert db.scalar(select(func.count()).select_from(Result).where(Result.id.like("channel_perf_shared_target_result_%"))) == 0
        assert db.scalar(select(func.count()).select_from(Result).where(Result.id.like("channel_perf_shared_other_result_%"))) == len(shared_run_ids)
        assert db.get(ScheduledChannelTest, "sched_perf_delete") is None

def test_channel_delete_succeeds_for_unreferenced_channel() -> None:
    reset_database()
    with TestClient(app) as client:
        created = client.post(
            "/api/channels",
            json={
                "id": "temp_channel",
                "name": "Temp Channel",
                "provider_type": "customer_gateway",
                "model_name": "claude-via-gateway",
                "enabled": True,
            },
        )
        deleted = client.delete("/api/channels/temp_channel")

    assert created.status_code == 200
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is True
    assert deleted.json()["deleted_runs"] == 0


def test_runtime_credentials_merge_channel_api_key_and_per_run_override() -> None:
    channel = Channel(
        id="with_key",
        name="With Key",
        provider_type="customer_gateway",
        role="candidate",
        model_name="custom-model",
        auth_config_encrypted={"api_key": "stored-key", "region": "us-east-1"},
        enabled=True,
    )

    assert _merged_channel_credentials(channel, {}) == {"api_key": "stored-key", "region": "us-east-1"}
    assert _merged_channel_credentials(channel, {"api_key": "runtime-key"}) == {"api_key": "runtime-key", "region": "us-east-1"}


def test_live_call_uses_anthropic_messages_for_custom_provider_key(monkeypatch) -> None:
    reset_database()
    called: dict[str, object] = {}

    async def fake_anthropic_call(channel, raw_request, credentials):  # noqa: ANN001
        called["provider_type"] = channel.provider_type
        return {
            "id": "msg_test",
            "type": "message",
            "model": channel.model_name,
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.services._anthropic_compatible_call", fake_anthropic_call)

    with SessionLocal() as db:
        channel = Channel(
            id="custom_protocol_channel",
            name="Custom Protocol Channel",
            provider_type="customer_gateway",
            role="candidate",
            model_name="custom-model",
            enabled=True,
        )
        db.add(channel)
        db.commit()
        case = db.get(TestCaseModel, "identity_02")
        assert case is not None
        raw_request = build_raw_request(channel, case)
        response = asyncio.run(_live_call(channel, case, raw_request, {}))

    assert called == {"provider_type": "customer_gateway"}
    assert response["type"] == "message"


def test_live_call_dispatches_openai_compatible_provider(monkeypatch) -> None:
    reset_database()
    called: dict[str, object] = {}

    async def fake_openai_call(channel, raw_request, credentials):  # noqa: ANN001
        called["provider_type"] = channel.provider_type
        called["base_url"] = channel.base_url
        return {
            "id": "chatcmpl_test",
            "object": "chat.completion",
            "model": channel.model_name,
            "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.services._openai_compatible_call", fake_openai_call)

    with SessionLocal() as db:
        channel = db.get(Channel, "openai_compat_demo")
        case = db.get(TestCaseModel, "identity_02")
        assert channel is not None and case is not None
        raw_request = build_raw_request(channel, case)
        response = asyncio.run(_live_call(channel, case, raw_request, {"api_key": "test-key"}))

    assert called == {"provider_type": "third_party_openai_compatible", "base_url": "https://relay.example/v1"}
    assert response["object"] == "chat.completion"


def test_live_call_dispatches_aws_bedrock_provider(monkeypatch) -> None:
    reset_database()
    called: dict[str, object] = {}

    def fake_aws_call(channel, case, credentials):  # noqa: ANN001
        called["provider_type"] = channel.provider_type
        called["case_id"] = case.id
        called["region"] = credentials["region"]
        return {
            "id": "aws_test",
            "type": "message",
            "model": channel.model_name,
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.services._aws_bedrock_call", fake_aws_call)

    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = db.get(TestCaseModel, "identity_02")
        assert channel is not None and case is not None
        raw_request = build_raw_request(channel, case)
        response = asyncio.run(_live_call(channel, case, raw_request, {"region": "us-west-2"}))

    assert called == {"provider_type": "aws_bedrock", "case_id": "identity_02", "region": "us-west-2"}
    assert response["type"] == "message"


def test_live_run_without_api_key_records_error_instead_of_mock() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = db.get(Channel, "anthropic_official")
        case = db.get(TestCaseModel, "identity_02")
        assert channel is not None and case is not None
        normalized = asyncio.run(invoke_channel(channel, case, 1, {}, use_mock=False))

    assert normalized["request_mode"] == "live"
    assert normalized["request_attempted"] is False
    assert normalized["error"] == "缺少 API Key，未发起正式请求"
    assert normalized["content_text"] == ""


def test_openai_http_error_preserves_upstream_message(monkeypatch) -> None:
    reset_database()

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            return httpx.Response(
                503,
                json={"error": {"code": "model_not_found", "message": "模型 claude-bad 无可用渠道"}},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with SessionLocal() as db:
        channel = db.get(Channel, "openai_compat_demo")
        case = db.get(TestCaseModel, "identity_02")
        assert channel is not None and case is not None
        channel.model_name = "claude-bad"
        raw_request = build_raw_request(channel, case)
        response = asyncio.run(invoke_channel(channel, case, 1, {"api_key": "test-key"}, use_mock=False))

    assert "模型 claude-bad 无可用渠道" in response["error"]


def test_runtime_secret_is_redacted_from_stored_results_api_and_report_download(monkeypatch) -> None:
    reset_database()
    secret = "sk-runtime-secret-abcdef"

    async def fake_anthropic_call(channel, raw_request, credentials):  # noqa: ANN001
        assert credentials["api_key"] == secret
        return {
            "type": "message",
            "id": "msg_01secretredaction",
            "model": channel.model_name,
            "role": "assistant",
            "content": [{"type": "text", "text": f"ok Authorization: Bearer {secret}"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 4},
            "debug": {"authorization": f"Bearer {secret}", "api_key": secret},
        }

    monkeypatch.setattr("app.services._anthropic_compatible_call", fake_anthropic_call)

    with SessionLocal() as db:
        create_suite(db, TestSuiteCreate(id="secret_redaction_suite", name="Secret Redaction Suite"))
        create_case(
            db,
            TestCaseCreate(
                id="secret_redaction_case",
                suite_id="secret_redaction_suite",
                module="protocol",
                title="Secret redaction case",
                prompt="Return a normal response.",
                request_params={"max_tokens": 16, "temperature": 0},
                scoring_rules={"quick": True},
            ),
        )
        channel = create_channel(
            db,
            ChannelCreate(
                id="secret_redaction_channel",
                name="Secret Redaction Channel",
                provider_type="anthropic",
                role="candidate",
                base_url="https://provider.example",
                model_name="claude-test",
            ),
        )
        run = create_run(
            db,
            RunCreate(
                name="Secret redaction run",
                suite_id="secret_redaction_suite",
                channel_ids={"candidate": [channel.id]},
                repeat_count=1,
                concurrency=1,
                use_mock=False,
                test_scope="quick",
            ),
        )
        run_id = run.id

    asyncio.run(execute_run(SessionLocal, run_id, runtime_credentials={"secret_redaction_channel": {"api_key": secret}}, use_mock=False))

    with SessionLocal() as db:
        result = db.scalar(select(Result).where(Result.run_id == run_id))
        report = db.scalar(select(Report).where(Report.run_id == run_id))
        assert result is not None
        assert report is not None
        stored_blob = json.dumps(
            {
                "normalized_response": result.normalized_response,
                "raw_request": result.raw_request,
                "raw_response": result.raw_response,
                "report_evidence": report.evidence,
                "report_markdown": report.markdown,
            },
            ensure_ascii=False,
        )

    assert secret not in stored_blob
    assert "[REDACTED]" in stored_blob

    with TestClient(app) as client:
        results_payload = client.get(f"/api/runs/{run_id}/results").json()
        report_response = client.get(f"/api/runs/{run_id}/report.md")

    assert secret not in json.dumps(results_payload, ensure_ascii=False)
    assert "[REDACTED]" in json.dumps(results_payload, ensure_ascii=False)
    assert report_response.status_code == 200
    assert secret not in report_response.text


def test_env_secret_ref_secret_is_redacted_from_stored_results_and_report(monkeypatch) -> None:
    reset_database()
    secret = "sk-env-ref-secret-abcdef"
    monkeypatch.setenv("CLAUDE_PATROL_ENV_REF_SECRET", secret)

    async def fake_anthropic_call(channel, raw_request, credentials):  # noqa: ANN001
        assert credentials["api_key"] == secret
        return {
            "type": "message",
            "id": "msg_01envsecretref",
            "model": channel.model_name,
            "role": "assistant",
            "content": [{"type": "text", "text": f"ok x-api-key={secret}"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 8, "output_tokens": 3},
            "debug": {"api_key": secret, "secret_ref": "env:CLAUDE_PATROL_ENV_REF_SECRET"},
        }

    monkeypatch.setattr("app.services._anthropic_compatible_call", fake_anthropic_call)

    with SessionLocal() as db:
        create_suite(db, TestSuiteCreate(id="env_secret_ref_suite", name="Env Secret Ref Suite"))
        create_case(
            db,
            TestCaseCreate(
                id="env_secret_ref_case",
                suite_id="env_secret_ref_suite",
                module="protocol",
                title="Env secret ref case",
                prompt="Return a normal response.",
                request_params={"max_tokens": 16, "temperature": 0},
                scoring_rules={"quick": True},
            ),
        )
        channel = create_channel(
            db,
            ChannelCreate(
                id="env_secret_ref_channel",
                name="Env Secret Ref Channel",
                provider_type="anthropic",
                role="candidate",
                base_url="https://provider.example",
                model_name="claude-test",
                auth_config={"secret_ref": "env:CLAUDE_PATROL_ENV_REF_SECRET"},
            ),
        )
        run = create_run(
            db,
            RunCreate(
                name="Env secret ref run",
                suite_id="env_secret_ref_suite",
                channel_ids={"candidate": [channel.id]},
                repeat_count=1,
                concurrency=1,
                use_mock=False,
                test_scope="quick",
            ),
        )
        run_id = run.id

    asyncio.run(execute_run(SessionLocal, run_id, use_mock=False))

    with SessionLocal() as db:
        result = db.scalar(select(Result).where(Result.run_id == run_id))
        report = db.scalar(select(Report).where(Report.run_id == run_id))
        assert result is not None
        assert report is not None
        stored_blob = json.dumps(
            {
                "normalized_response": result.normalized_response,
                "raw_request": result.raw_request,
                "raw_response": result.raw_response,
                "report_evidence": report.evidence,
                "report_markdown": report.markdown,
            },
            ensure_ascii=False,
        )

    assert secret not in stored_blob
    assert "CLAUDE_PATROL_ENV_REF_SECRET" not in stored_blob
    assert "[REDACTED]" in stored_blob


def test_channel_models_endpoint_returns_model_ids(monkeypatch) -> None:
    reset_database()

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            request = httpx.Request("GET", url)
            return httpx.Response(
                200,
                json={"data": [{"id": "claude-sonnet-4-6"}, {"id": "claude-haiku-4-5-20251001"}]},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Model List Channel",
                "provider_type": "apipro",
                "base_url": "https://api.wenwen-ai.com",
                "model_name": "claude-bad",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.get(f"/api/channels/{channel_id}/models")

    assert response.status_code == 200
    assert response.json() == ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"]


def test_openai_resource_check_classifies_official_endpoint(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            assert url == "https://api.openai.com/v1/models"
            assert headers["authorization"] == "Bearer sk-official-secret"
            request = httpx.Request("GET", url)
            return httpx.Response(
                200,
                json={"object": "list", "data": [{"id": "gpt-4.1-mini", "object": "model"}]},
                headers={"x-request-id": "req_official_123", "content-type": "application/json"},
                request=request,
            )

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            if url.endswith("/chat/completions"):
                return httpx.Response(
                    200,
                    json={"id": "chatcmpl_123", "object": "chat.completion", "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 1}},
                    headers={"x-request-id": "req_chat_123"},
                    request=request,
                )
            return httpx.Response(
                400,
                json={"error": {"message": "max_output_tokens must be greater than or equal to 16", "type": "invalid_request_error", "code": "integer_below_min_value", "param": "max_output_tokens"}},
                headers={"x-request-id": "req_validation_123"},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        response = client.post("/api/openai-resource-check", json={"api_key": "sk-official-secret", "include_response_probe": False})

    payload = response.json()
    assert response.status_code == 200
    assert payload["classification"] == "official_openai_direct_likely"
    assert payload["directness"] == "official_direct"
    assert payload["upstream_assessment"] == "official_upstream_likely"
    assert payload["request_id"] == "req_official_123"
    assert payload["host"] == "api.openai.com"
    assert payload["selected_model"] == "gpt-4.1-mini"
    assert "sk-official-secret" not in json.dumps(payload, ensure_ascii=False)


def test_openai_resource_check_classifies_relay_with_official_like_upstream(monkeypatch) -> None:
    calls: list[tuple[str, dict]] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            request = httpx.Request("GET", url)
            return httpx.Response(
                200,
                json={"object": "list", "data": [{"id": "gpt-4.1-mini", "object": "model"}]},
                request=request,
            )

        async def post(self, url, headers, json):  # noqa: ANN001
            calls.append((url, json))
            request = httpx.Request("POST", url)
            if url.endswith("/chat/completions"):
                return httpx.Response(200, json={"id": "chatcmpl_123", "object": "chat.completion", "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}, request=request)
            if json.get("max_output_tokens") == 16:
                return httpx.Response(200, json={"id": "resp_123", "object": "response", "model": json["model"], "output": [], "usage": {}}, request=request)
            return httpx.Response(400, json={"error": {"message": "max_output_tokens too small", "type": "invalid_request_error", "code": "integer_below_min_value", "param": "max_output_tokens"}}, request=request)

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        response = client.post("/api/openai-resource-check", json={"base_url": "https://relay.example/v1", "api_key": "sk-relay-secret", "include_response_probe": True})

    payload = response.json()
    assert response.status_code == 200
    assert payload["classification"] == "openai_compatible_proxy"
    assert payload["directness"] == "relay_or_proxy"
    assert payload["upstream_assessment"] == "official_upstream_likely"
    assert payload["upstream_score"] >= 80
    assert "non_official_host" in payload["labels"]
    assert any(url.endswith("/responses") and body.get("max_output_tokens") == 16 for url, body in calls)
    assert "sk-relay-secret" not in json.dumps(payload, ensure_ascii=False)


def test_openai_resource_check_records_middleware_wrapper_without_failing(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            request = httpx.Request("GET", url)
            return httpx.Response(200, json={"object": "list", "data": [{"id": "gpt-4o-mini", "object": "model"}]}, request=request)

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            if url.endswith("/chat/completions"):
                return httpx.Response(200, json={"id": "chatcmpl_123", "object": "chat.completion", "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}, request=request)
            return httpx.Response(
                400,
                json={"error": {"message": "invalid max_output_tokens", "type": "invalid_request_error", "code": "integer_below_min_value"}, "rix_api_error": {"code": "integer_below_min_value"}},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        response = client.post("/api/openai-resource-check", json={"base_url": "https://relay.example/v1", "api_key": "sk-relay-secret", "include_response_probe": True})

    payload = response.json()
    assert response.status_code == 200
    assert payload["upstream_assessment"] in {"official_upstream_likely", "openai_compatible_unverified"}
    assert "middleware_wrapper_trace" in payload["labels"]
    assert any(item.get("group") == "Middleware Trace" for item in payload["evidence"])


def test_openai_resource_check_flags_missing_request_id_as_non_blocking(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            request = httpx.Request("GET", url)
            return httpx.Response(200, json={"object": "list", "data": [{"id": "gpt-4.1-mini"}]}, request=request)

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            if url.endswith("/chat/completions"):
                return httpx.Response(200, json={"id": "chatcmpl_123", "object": "chat.completion", "choices": []}, request=request)
            return httpx.Response(400, json={"error": {"message": "bad", "type": "invalid_request_error", "code": "integer_below_min_value"}}, request=request)

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        response = client.post("/api/openai-resource-check", json={"api_key": "sk-no-request-id-secret"})

    payload = response.json()
    assert response.status_code == 200
    assert payload["upstream_assessment"] == "official_upstream_likely"
    assert "request_id_missing" in payload["labels"]


def test_openai_resource_check_invalid_auth_is_unverified_and_redacted(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            request = httpx.Request("GET", url)
            return httpx.Response(
                401,
                json={"error": {"message": "Incorrect API key provided: sk-invalid-secret", "type": "invalid_request_error"}},
                headers={"x-request-id": "req_invalid_123"},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        response = client.post("/api/openai-resource-check", json={"api_key": "sk-invalid-secret"})

    payload = response.json()
    blob = json.dumps(payload, ensure_ascii=False)
    assert response.status_code == 200
    assert payload["classification"] == "invalid_or_unverified"
    assert payload["upstream_assessment"] == "invalid_or_unverified"
    assert "models_http_error" in payload["labels"]
    assert "sk-invalid-secret" not in blob
    assert "[REDACTED]" in blob


def test_openai_resource_check_non_json_response_is_unverified(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            request = httpx.Request("GET", url)
            return httpx.Response(502, text="<html>bad gateway sk-non-json-secret</html>", request=request)

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        response = client.post("/api/openai-resource-check", json={"base_url": "https://relay.example/v1", "api_key": "sk-non-json-secret"})

    payload = response.json()
    blob = json.dumps(payload, ensure_ascii=False)
    assert response.status_code == 200
    assert payload["upstream_assessment"] == "invalid_or_unverified"
    assert "sk-non-json-secret" not in blob


def test_gemini_resource_check_classifies_official_endpoint(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            assert url == "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-official-secret"
            request = httpx.Request("GET", url)
            return httpx.Response(
                200,
                json={
                    "models": [
                        {"name": "models/gemini-2.0-flash", "baseModelId": "gemini-2.0-flash", "supportedGenerationMethods": ["generateContent"]},
                        {"name": "models/text-embedding-004", "baseModelId": "text-embedding-004", "supportedGenerationMethods": ["embedContent"]},
                    ]
                },
                headers={"x-goog-request-id": "goog_req_123", "content-type": "application/json"},
                request=request,
            )

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            if url.endswith(":embedContent?key=gemini-official-secret"):
                return httpx.Response(200, json={"embedding": {"values": [0.1, 0.2]}, "usageMetadata": {"promptTokenCount": 1}}, request=request)
            if url.endswith(":streamGenerateContent?key=gemini-official-secret"):
                return httpx.Response(200, json=[{"candidates": [{"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 1}, "modelVersion": "gemini-2.0-flash"}], request=request)
            if json.get("contents") == []:
                return httpx.Response(400, json={"error": {"code": 400, "message": "contents is required", "status": "INVALID_ARGUMENT"}}, request=request)
            return httpx.Response(
                200,
                json={"candidates": [{"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP", "safetyRatings": []}], "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 1}, "modelVersion": "gemini-2.0-flash", "responseId": "resp_123"},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        response = client.post("/api/gemini-resource-check", json={"api_key": "gemini-official-secret"})

    payload = response.json()
    blob = json.dumps(payload, ensure_ascii=False)
    assert response.status_code == 200
    assert payload["classification"] == "official_gemini_direct_likely"
    assert payload["directness"] == "official_google_direct"
    assert payload["upstream_assessment"] == "official_upstream_likely"
    assert payload["selected_model"] == "gemini-2.0-flash"
    assert payload["selected_embedding_model"] == "text-embedding-004"
    assert payload["request_id"] == "goog_req_123"
    assert "gemini-official-secret" not in blob


def test_gemini_resource_check_classifies_relay_with_official_like_upstream(monkeypatch) -> None:
    calls: list[tuple[str, dict]] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            request = httpx.Request("GET", url)
            return httpx.Response(200, json={"models": [{"name": "models/gemini-2.0-flash", "supportedGenerationMethods": ["generateContent"]}]}, request=request)

        async def post(self, url, headers, json):  # noqa: ANN001
            calls.append((url, json))
            request = httpx.Request("POST", url)
            if json.get("contents") == []:
                return httpx.Response(400, json={"error": {"code": 400, "message": "bad request", "status": "INVALID_ARGUMENT"}}, request=request)
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 4}, "modelVersion": "relay-gemini", "responseId": "resp_1"}, request=request)

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        response = client.post("/api/gemini-resource-check", json={"base_url": "https://relay.example/v1beta", "api_key": "gemini-relay-secret", "include_embedding_probe": False})

    payload = response.json()
    assert response.status_code == 200
    assert payload["classification"] == "gemini_compatible_proxy"
    assert payload["directness"] == "relay_or_proxy"
    assert payload["upstream_assessment"] == "official_upstream_likely"
    assert "non_official_host" in payload["labels"]
    assert any(url.endswith(":generateContent?key=gemini-relay-secret") for url, _body in calls)
    assert "gemini-relay-secret" not in json.dumps(payload, ensure_ascii=False)


def test_gemini_resource_check_invalid_auth_is_unverified_and_redacted(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            request = httpx.Request("GET", url)
            return httpx.Response(
                403,
                json={"error": {"code": 403, "message": "API key not valid: gemini-invalid-secret", "status": "PERMISSION_DENIED"}},
                request=request,
            )

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            return httpx.Response(
                403,
                json={"error": {"code": 403, "message": "API key not valid: gemini-invalid-secret", "status": "PERMISSION_DENIED"}},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        response = client.post("/api/gemini-resource-check", json={"api_key": "gemini-invalid-secret"})

    payload = response.json()
    blob = json.dumps(payload, ensure_ascii=False)
    assert response.status_code == 200
    assert payload["classification"] == "invalid_or_unverified"
    assert payload["upstream_assessment"] == "invalid_or_unverified"
    assert "models_http_error" in payload["labels"]
    assert "gemini-invalid-secret" not in blob
    assert "[REDACTED]" in blob


def test_gemini_resource_check_records_detailed_official_shape(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            request = httpx.Request("GET", url)
            return httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "name": "models/gemini-2.0-flash",
                            "baseModelId": "gemini-2.0-flash",
                            "version": "001",
                            "displayName": "Gemini 2.0 Flash",
                            "inputTokenLimit": 1048576,
                            "outputTokenLimit": 8192,
                            "supportedGenerationMethods": ["generateContent", "streamGenerateContent"],
                        }
                    ]
                },
                request=request,
            )

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            if json.get("contents") == []:
                return httpx.Response(400, json={"error": {"code": 400, "message": "invalid contents", "status": "INVALID_ARGUMENT"}}, request=request)
            return httpx.Response(
                200,
                json={
                    "candidates": [
                        {
                            "content": {"role": "model", "parts": [{"text": "ok"}]},
                            "finishReason": "STOP",
                            "safetyRatings": [{"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "probability": "NEGLIGIBLE"}],
                        }
                    ],
                    "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 1, "totalTokenCount": 5},
                    "modelVersion": "gemini-2.0-flash",
                    "responseId": "resp_detailed",
                    "promptFeedback": {"safetyRatings": []},
                },
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        response = client.post("/api/gemini-resource-check", json={"base_url": "https://relay.example/v1beta", "api_key": "gemini-detailed-secret", "include_embedding_probe": False})

    payload = response.json()
    blob = json.dumps(payload, ensure_ascii=False)
    assert response.status_code == 200
    assert payload["upstream_assessment"] == "official_upstream_likely"
    assert payload["raw_evidence"]["models"]["shape_checks"]["first_model"]["has_token_limits"] is True
    generate_checks = payload["raw_evidence"]["generate_probe"]["shape_checks"]
    assert generate_checks["has_usage_metadata"] is True
    assert generate_checks["has_model_version"] is True
    assert generate_checks["has_response_id"] is True
    assert generate_checks["safety_ratings_count"] == 1
    assert "gemini-detailed-secret" not in blob


def test_gemini_resource_check_warns_on_missing_optional_metadata(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            request = httpx.Request("GET", url)
            return httpx.Response(200, json={"models": [{"name": "models/gemini-2.0-flash", "supportedGenerationMethods": ["generateContent"]}]}, request=request)

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            if json.get("contents") == []:
                return httpx.Response(400, json={"error": {"code": 400, "message": "invalid contents", "status": "INVALID_ARGUMENT"}}, request=request)
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP"}]}, request=request)

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        response = client.post("/api/gemini-resource-check", json={"base_url": "https://relay.example/v1beta", "api_key": "gemini-metadata-secret", "include_embedding_probe": False})

    payload = response.json()
    assert response.status_code == 200
    assert payload["classification"] == "gemini_compatible_proxy"
    assert "usage_missing" in payload["labels"]
    assert "gemini_metadata_missing" in payload["labels"]
    assert "gemini_safety_ratings_missing" in payload["labels"]
    assert payload["raw_evidence"]["generate_probe"]["shape_checks"]["ok"] is True


def test_gemini_resource_check_parses_sse_like_stream_chunks(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            request = httpx.Request("GET", url)
            return httpx.Response(200, json={"models": [{"name": "models/gemini-2.0-flash", "supportedGenerationMethods": ["generateContent", "streamGenerateContent"]}]}, request=request)

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            if json.get("contents") == []:
                return httpx.Response(400, json={"error": {"code": 400, "message": "invalid contents", "status": "INVALID_ARGUMENT"}}, request=request)
            if url.endswith(":streamGenerateContent?key=gemini-sse-secret"):
                return httpx.Response(
                    200,
                    text='data: {"candidates":[{"content":{"parts":[{"text":"o"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4},"modelVersion":"gemini-2.0-flash","responseId":"resp_stream"}\n\ndata: [DONE]\n',
                    headers={"content-type": "text/event-stream"},
                    request=request,
                )
            return httpx.Response(
                200,
                json={"candidates": [{"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP", "safetyRatings": []}], "usageMetadata": {"promptTokenCount": 4}, "modelVersion": "gemini-2.0-flash", "responseId": "resp_generate"},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        response = client.post("/api/gemini-resource-check", json={"base_url": "https://relay.example/v1beta", "api_key": "gemini-sse-secret", "include_embedding_probe": False})

    payload = response.json()
    assert response.status_code == 200
    assert payload["raw_evidence"]["stream_probe"]["shape_checks"]["ok"] is True
    assert payload["raw_evidence"]["stream_probe"]["shape_checks"]["chunk_count"] == 1
    assert "stream_shape_mismatch" not in payload["labels"]


def test_channel_health_profile_returns_insufficient_data() -> None:
    reset_database()
    with SessionLocal() as db:
        create_channel(db, ChannelCreate(id="ch_health_empty", name="empty", provider_type="third_party_anthropic", role="candidate"))

    with TestClient(app) as client:
        response = client.get("/api/channels/ch_health_empty/health-profile")

    payload = response.json()
    assert response.status_code == 200
    assert payload["status"] == "insufficient_data"
    assert payload["total_results"] == 0
    assert payload["trend"]


def test_channel_health_profile_aggregates_results_and_redacts() -> None:
    reset_database()
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        create_suite(db, TestSuiteCreate(id="suite_health", name="health suite"))
        create_case(db, TestCaseCreate(id="case_ok", suite_id="suite_health", module="protocol", title="ok", prompt="ok"))
        create_case(db, TestCaseCreate(id="case_fail", suite_id="suite_health", module="protocol", title="fail", prompt="fail"))
        create_channel(db, ChannelCreate(id="ch_health", name="health", provider_type="third_party_anthropic", role="candidate"))
        run = Run(
            id="run_health",
            suite_id="suite_health",
            name="health run",
            mode="manual_probe",
            status="completed",
            repeat_count=1,
            concurrency=1,
            total_jobs=2,
            completed_jobs=2,
            created_at=now,
        )
        db.add(run)
        db.add(RunChannel(id="rch_health", run_id=run.id, channel_id="ch_health", role_in_run="candidate"))
        db.add(
            Result(
                id="res_health_ok",
                run_id=run.id,
                test_case_id="case_ok",
                channel_id="ch_health",
                attempt_index=1,
                normalized_response={"provider_message_id": "msg_ok", "raw_response": {"request_id": "req_ok"}},
                raw_response={"type": "message", "id": "msg_ok"},
                metrics={"status_code": 200, "latency_ms": 100},
                score=90,
                labels=[],
                created_at=now,
            )
        )
        db.add(
            Result(
                id="res_health_fail",
                run_id=run.id,
                test_case_id="case_fail",
                channel_id="ch_health",
                attempt_index=1,
                normalized_response={"error": "API key sk-health-secret failed", "raw_response": {"request_id": "req_fail"}},
                raw_response={"error": {"type": "rate_limit_error", "message": "bad sk-health-secret"}},
                metrics={"status_code": 429, "latency_ms": 900, "error_type": "rate_limit_error"},
                score=0,
                labels=["request_failed", "latency_outlier"],
                created_at=now,
            )
        )
        db.add(
            Report(
                id="report_health",
                run_id=run.id,
                channel_id="ch_health",
                final_score=60,
                grade="D",
                summary="health report",
                evidence={"labels": ["request_failed"]},
                created_at=now,
            )
        )
        db.add(
            ChannelAlert(
                id="alert_health",
                run_id=run.id,
                report_id="report_health",
                channel_id="ch_health",
                status="pending_review",
                severity="high",
                grade="D",
                final_score=60,
                trigger_labels=["request_failed"],
                created_at=now,
            )
        )
        db.commit()

    with TestClient(app) as client:
        response = client.get("/api/channels/ch_health/health-profile?days=7")

    payload = response.json()
    blob = json.dumps(payload, ensure_ascii=False)
    assert response.status_code == 200
    assert payload["status"] == "degraded"
    assert payload["total_results"] == 2
    assert payload["success_count"] == 1
    assert payload["failure_count"] == 1
    assert payload["success_rate"] == 50.0
    assert payload["p95_latency_ms"] == 860.0
    assert payload["label_distribution"]["request_failed"] == 1
    assert payload["error_type_distribution"]["rate_limit_error"] == 1
    assert payload["recent_failures"][0]["http_status"] == 429
    assert payload["recent_failures"][0]["request_id"] == "req_fail"
    assert "sk-health-secret" not in blob


def test_channel_health_profile_summarizes_signature_and_patrol() -> None:
    reset_database()
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        create_suite(db, TestSuiteCreate(id="suite_health_sig", name="health sig suite"))
        create_case(db, TestCaseCreate(id="signature_interop", suite_id="suite_health_sig", module="signature", title="sig", prompt="sig"))
        create_channel(db, ChannelCreate(id="ch_source_health", name="source", provider_type="anthropic", role="gold"))
        create_channel(db, ChannelCreate(id="ch_relay_health", name="relay", provider_type="third_party_anthropic", role="candidate"))
        run = Run(id="run_health_sig", suite_id="suite_health_sig", name="sig run", mode="manual_probe", status="completed", repeat_count=1, concurrency=1, total_jobs=1, completed_jobs=1, created_at=now)
        db.add(run)
        db.add(RunChannel(id="rch_health_sig", run_id=run.id, channel_id="ch_relay_health", role_in_run="candidate"))
        db.add(
            Result(
                id="res_health_sig",
                run_id=run.id,
                test_case_id="signature_interop",
                channel_id="ch_relay_health",
                attempt_index=1,
                raw_request={"source_channel_id": "ch_source_health", "relay_channel_id": "ch_relay_health", "stream": True},
                raw_response={"signature_interop": {"ok": True, "status": "pass", "reason": "ok", "steps": []}},
                normalized_response={},
                metrics={"status_code": 200, "latency_ms": 300},
                score=100,
                labels=[],
                created_at=now,
            )
        )
        schedule = ScheduledChannelTest(
            id="sched_health",
            channel_id="ch_relay_health",
            suite_id="suite_health_sig",
            baseline_snapshot_id="base_missing_for_health",
            name="health patrol",
            enabled=True,
            last_status="completed",
            last_finished_at=now,
            next_run_at=now + timedelta(hours=1),
        )
        db.add(schedule)
        db.add(PatrolJob(id="pjob_health", scheduled_test_id=schedule.id, channel_id="ch_relay_health", status="completed", run_id=run.id, created_at=now, finished_at=now))
        db.add(PatrolJobAttempt(id="pattempt_health", job_id="pjob_health", attempt_index=1, status="completed", run_id=run.id, started_at=now, finished_at=now))
        db.commit()

    with TestClient(app) as client:
        response = client.get("/api/channels/ch_relay_health/health-profile?days=1")

    payload = response.json()
    assert response.status_code == 200
    assert payload["signature_summary"]["total"] == 1
    assert payload["signature_summary"]["pass_count"] == 1
    assert payload["signature_summary"]["pass_rate"] == 100.0
    assert payload["patrol_summary"]["schedule_count"] == 1
    assert payload["patrol_summary"]["enabled_schedule_count"] == 1
    assert payload["patrol_summary"]["job_status_counts"]["completed"] == 1


def test_channel_health_profile_rejects_invalid_days() -> None:
    reset_database()
    with SessionLocal() as db:
        create_channel(db, ChannelCreate(id="ch_health_days", name="days", provider_type="third_party_anthropic", role="candidate"))

    with TestClient(app) as client:
        response = client.get("/api/channels/ch_health_days/health-profile?days=2")

    assert response.status_code == 400


def test_signature_interop_endpoint_passes_when_relay_accepts_signature(monkeypatch) -> None:
    reset_database()
    calls: list[dict] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def post(self, url, headers, json):  # noqa: ANN001
            calls.append({"url": url, "json": json, "headers": headers})
            request = httpx.Request("POST", url)
            if len(calls) == 1:
                return httpx.Response(
                    200,
                    json={
                        "id": "msg_bdrk_01source",
                        "type": "message",
                        "model": "claude-opus-4-6",
                        "_response_metadata": {"request_id": "req_source_123"},
                        "content": [
                            {"type": "thinking", "thinking": "source thinking", "signature": "sig-source-compatible"},
                            {"type": "text", "text": "source answer"},
                        ],
                    },
                    request=request,
                )
            return httpx.Response(
                200,
                json={
                    "id": "msg_vrtx_01relay",
                    "type": "message",
                    "model": "claude-opus-4-6",
                    "_response_metadata": {"request_id": "req_relay_456"},
                    "content": [{"type": "text", "text": "relay answer"}],
                },
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        source_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Source",
                "provider_type": "anthropic",
                "base_url": "https://source.example",
                "model_name": "claude-opus-4-6",
                "auth_config": {"api_key": "source-key"},
                "enabled": True,
            },
        ).json()["id"]
        relay_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Relay",
                "provider_type": "anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-opus-4-6",
                "auth_config": {"api_key": "relay-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            "/api/channels/signature-interop-test",
            json={"source_channel_id": source_id, "relay_channel_id": relay_id, "client_probe_id": "probe-pass-1"},
        )
        latest_by_probe_response = client.get(
            "/api/channels/signature-interop-test/latest",
            params={"source_channel_id": source_id, "relay_channel_id": relay_id, "stream": "false", "client_probe_id": "probe-pass-1"},
        )
        latest_response = client.get(
            "/api/channels/signature-interop-test/latest",
            params={"source_channel_id": source_id, "relay_channel_id": relay_id, "stream": "false"},
        )

    payload = response.json()
    latest_payload = latest_response.json()
    latest_by_probe_payload = latest_by_probe_response.json()
    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["status"] == "pass"
    assert payload["run"]["mode"] == "manual_probe"
    assert payload["run"]["status"] == "completed"
    assert payload["result"]["score"] == 100
    assert payload["created_at"]
    assert payload["completed_at"]
    assert payload["client_probe_id"] == "probe-pass-1"
    assert payload["result"]["raw_request"]["client_probe_id"] == "probe-pass-1"
    assert payload["source_message_channel_type"] == "AWS Bedrock"
    assert payload["source_request_id"] == "req_source_123"
    assert payload["relay_message_channel_type"] == "Vertex"
    assert payload["relay_request_id"] == "req_relay_456"
    assert payload["signature_prefixes"] == ["sig-source-compatible"]
    assert [step["name"] for step in payload["steps"]] == [
        "步骤 A：请求 Source thinking",
        "Signature 校验",
        "步骤 B：发送 Relay 复用请求",
        "最终判定",
    ]
    assert payload["steps"][0]["http_status"] == 200
    assert payload["steps"][0]["request_id"] == "req_source_123"
    assert payload["steps"][0]["message_id"] == "msg_bdrk_01source"
    assert isinstance(payload["steps"][0]["latency_ms"], int)
    assert payload["steps"][2]["http_status"] == 200
    assert payload["steps"][2]["request_id"] == "req_relay_456"
    assert payload["steps"][2]["message_id"] == "msg_vrtx_01relay"
    assert payload["steps"][-1]["status"] == "ok"
    assert latest_response.status_code == 200
    assert latest_by_probe_response.status_code == 200
    assert latest_payload["result"]["id"] == payload["result"]["id"]
    assert latest_by_probe_payload["result"]["id"] == payload["result"]["id"]
    assert latest_by_probe_payload["client_probe_id"] == "probe-pass-1"
    assert latest_payload["source_request_id"] == "req_source_123"
    assert calls[0]["url"] == "https://source.example/v1/messages"
    assert calls[1]["url"] == "https://relay.example/v1/messages"
    assert calls[1]["json"]["messages"][1]["content"][0]["signature"] == "sig-source-compatible"
    assert calls[0]["json"]["thinking"] == {"type": "enabled", "budget_tokens": 2000}
    assert calls[1]["json"]["thinking"] == {"type": "enabled", "budget_tokens": 2000}
    with SessionLocal() as db:
        assert db.get(Run, payload["run"]["id"]) is not None
        assert db.get(Result, payload["result"]["id"]) is not None


def test_signature_interop_uses_adaptive_thinking_for_opus_48(monkeypatch) -> None:
    reset_database()
    calls: list[dict] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def post(self, url, headers, json):  # noqa: ANN001
            calls.append({"url": url, "json": json, "headers": headers})
            request = httpx.Request("POST", url)
            if len(calls) == 1:
                return httpx.Response(
                    200,
                    json={
                        "id": "msg_01source",
                        "type": "message",
                        "model": "claude-opus-4-8",
                        "content": [
                            {"type": "thinking", "thinking": "source thinking", "signature": "sig-source-compatible"},
                            {"type": "text", "text": "source answer"},
                        ],
                    },
                    request=request,
                )
            return httpx.Response(
                200,
                json={"id": "msg_01relay", "type": "message", "model": "claude-opus-4-8", "content": [{"type": "text", "text": "relay answer"}]},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        source_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Source 48",
                "provider_type": "anthropic",
                "base_url": "https://source.example",
                "model_name": "claude-opus-4-8-high",
                "auth_config": {"api_key": "source-key"},
                "enabled": True,
            },
        ).json()["id"]
        relay_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Relay 48",
                "provider_type": "anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-opus-4-8",
                "auth_config": {"api_key": "relay-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            "/api/channels/signature-interop-test",
            json={"source_channel_id": source_id, "relay_channel_id": relay_id},
        )

    payload = response.json()
    assert response.status_code == 200
    assert calls[0]["json"]["thinking"] == {"type": "adaptive"}
    assert calls[0]["json"]["output_config"] == {"effort": "high"}
    assert calls[1]["json"]["thinking"] == {"type": "adaptive"}
    assert calls[1]["json"]["output_config"] == {"effort": "medium"}
    assert "temperature" not in calls[0]["json"]
    assert "budget_tokens" not in calls[0]["json"]["thinking"]
    assert payload["source_protocol_profile"] == "claude_adaptive_thinking"
    assert payload["relay_protocol_profile"] == "claude_adaptive_thinking"
    assert any("4.7/4.8" in note for note in payload["request_normalization_notes"])


def test_signature_interop_endpoint_reports_invalid_signature(monkeypatch) -> None:
    reset_database()
    calls = 0

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def post(self, url, headers, json):  # noqa: ANN001
            nonlocal calls
            calls += 1
            request = httpx.Request("POST", url)
            if calls == 1:
                return httpx.Response(
                    200,
                    json={
                        "id": "msg_01source",
                        "type": "message",
                        "model": "claude-opus-4-6",
                        "content": [{"type": "thinking", "thinking": "source thinking", "signature": "sig-bad"}],
                    },
                    request=request,
                )
            return httpx.Response(
                400,
                json={"type": "error", "error": {"message": "Invalid `signature` in `thinking` block", "request_id": "req_123"}},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        source_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Source",
                "provider_type": "anthropic",
                "base_url": "https://source.example",
                "model_name": "claude-opus-4-6",
                "auth_config": {"api_key": "source-key"},
                "enabled": True,
            },
        ).json()["id"]
        relay_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Relay",
                "provider_type": "anthropic",
                "base_url": "https://relay.example",
                "model_name": "claude-opus-4-6",
                "auth_config": {"api_key": "relay-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            "/api/channels/signature-interop-test",
            json={"source_channel_id": source_id, "relay_channel_id": relay_id},
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["ok"] is False
    assert payload["status"] == "fail"
    assert payload["run"]["mode"] == "manual_probe"
    assert payload["run"]["status"] == "failed"
    assert payload["result"]["labels"] == ["signature_interop_failed"]
    assert payload["created_at"]
    assert payload["completed_at"]
    assert "signature 不兼容" in payload["reason"]
    assert "req_123" in payload["relay_raw_excerpt"]
    assert payload["source_message_channel_type"] == "Anthropic"
    assert payload["steps"][-1]["status"] == "fail"
    assert "signature 不兼容" in payload["steps"][-1]["detail"]


def test_signature_interop_streaming_extracts_relay_message_id(monkeypatch) -> None:
    reset_database()
    calls: list[dict] = []

    relay_stream = "\n".join([
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_01relay_stream","type":"message","model":"claude-opus-4-6","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"relay streamed"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
    ])

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def post(self, url, headers, json):  # noqa: ANN001
            calls.append({"url": url, "json": json, "headers": headers})
            request = httpx.Request("POST", url)
            if len(calls) == 1:
                return httpx.Response(
                    200,
                    json={
                        "id": "msg_01source_stream",
                        "type": "message",
                        "model": "claude-opus-4-6",
                        "content": [
                            {"type": "thinking", "thinking": "source thinking", "signature": "sig-source-stream"},
                            {"type": "text", "text": "source answer"},
                        ],
                    },
                    request=request,
                )
            return httpx.Response(200, text=relay_stream, headers={"x-request-id": "req_relay_stream"}, request=request)

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        source_id = client.post(
            "/api/channels",
            json={"name": "Streaming Source", "provider_type": "anthropic", "base_url": "https://source.example", "model_name": "claude-opus-4-6", "auth_config": {"api_key": "source-key"}, "enabled": True},
        ).json()["id"]
        relay_id = client.post(
            "/api/channels",
            json={"name": "Streaming Relay", "provider_type": "anthropic", "base_url": "https://relay.example", "model_name": "claude-opus-4-6", "auth_config": {"api_key": "relay-key"}, "enabled": True},
        ).json()["id"]
        response = client.post(
            "/api/channels/signature-interop-test",
            json={"source_channel_id": source_id, "relay_channel_id": relay_id, "stream": True},
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["ok"] is True
    assert calls[1]["json"]["stream"] is True
    assert payload["relay_message_id"] == "msg_01relay_stream"
    assert payload["relay_request_id"] == "req_relay_stream"
    assert payload["steps"][2]["message_id"] == "msg_01relay_stream"
    assert payload["steps"][2]["request_id"] == "req_relay_stream"
    assert "relay streamed" in payload["relay_raw_excerpt"]
    assert "message_start" in payload["relay_raw_excerpt"]


def test_signature_interop_streaming_error_exposes_relay_error(monkeypatch) -> None:
    reset_database()
    calls = 0
    relay_stream_error = "\n".join([
        'event: error',
        'data: {"type":"error","error":{"type":"invalid_request_error","message":"Invalid `signature` in `thinking` block","request_id":"req_stream_error"}}',
        '',
    ])

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def post(self, url, headers, json):  # noqa: ANN001
            nonlocal calls
            calls += 1
            request = httpx.Request("POST", url)
            if calls == 1:
                return httpx.Response(
                    200,
                    json={"id": "msg_01source", "type": "message", "model": "claude-opus-4-6", "content": [{"type": "thinking", "thinking": "source thinking", "signature": "sig-bad"}]},
                    request=request,
                )
            return httpx.Response(200, text=relay_stream_error, headers={"x-request-id": "req_header_stream"}, request=request)

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        source_id = client.post(
            "/api/channels",
            json={"name": "Streaming Error Source", "provider_type": "anthropic", "base_url": "https://source.example", "model_name": "claude-opus-4-6", "auth_config": {"api_key": "source-key"}, "enabled": True},
        ).json()["id"]
        relay_id = client.post(
            "/api/channels",
            json={"name": "Streaming Error Relay", "provider_type": "anthropic", "base_url": "https://relay.example", "model_name": "claude-opus-4-6", "auth_config": {"api_key": "relay-key"}, "enabled": True},
        ).json()["id"]
        response = client.post(
            "/api/channels/signature-interop-test",
            json={"source_channel_id": source_id, "relay_channel_id": relay_id, "stream": True},
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["ok"] is False
    assert "signature 不兼容" in payload["reason"]
    assert payload["steps"][2]["status"] == "fail"
    assert payload["steps"][2]["http_status"] == 200
    assert payload["steps"][2]["request_id"] == "req_header_stream"
    assert "Invalid `signature`" in payload["steps"][2]["error"]
    assert "req_stream_error" in payload["steps"][2]["error"]
    assert "Invalid `signature`" in payload["relay_raw_excerpt"]


def test_signature_interop_rejects_source_without_signature(monkeypatch) -> None:
    reset_database()

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            return httpx.Response(
                200,
                json={"id": "msg_01source", "type": "message", "model": "claude-opus-4-6", "content": [{"type": "thinking", "thinking": "no signature"}]},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        source_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Source",
                "provider_type": "anthropic",
                "base_url": "https://source.example",
                "model_name": "claude-opus-4-6",
                "auth_config": {"api_key": "source-key"},
                "enabled": True,
            },
        ).json()["id"]
        relay_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Relay",
                "provider_type": "anthropic",
                "base_url": "https://relay.example",
                "model_name": "claude-opus-4-6",
                "auth_config": {"api_key": "relay-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            "/api/channels/signature-interop-test",
            json={"source_channel_id": source_id, "relay_channel_id": relay_id},
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["ok"] is False
    assert payload["run"]["mode"] == "manual_probe"
    assert payload["run"]["status"] == "failed"
    assert payload["result"]["labels"] == ["signature_interop_failed"]
    assert "缺少 signature" in payload["reason"]

    with TestClient(app) as client:
        delete_response = client.delete(f"/api/runs/{payload['run']['id']}", headers=ADMIN_HEADERS)

    assert delete_response.status_code == 200
    with SessionLocal() as db:
        assert db.get(Run, payload["run"]["id"]) is None
        assert db.get(Result, payload["result"]["id"]) is None


def test_classify_claude_message_id_prefixes() -> None:
    assert classify_claude_message_id("msg_bdrk_01abc") == "AWS Bedrock"
    assert classify_claude_message_id("msg_vrtx_01abc") == "Vertex"
    assert classify_claude_message_id("msg_01abc") == "Anthropic"
    assert classify_claude_message_id("chatcmpl_abc") == "未知"


def test_model_request_test_persists_manual_probe_result(monkeypatch) -> None:
    reset_database()

    async def fake_live_call(channel, case, raw_request, credentials):  # noqa: ANN001
        return (
            {
                "id": "msg_01manualprobe",
                "type": "message",
                "role": "assistant",
                "model": channel.model_name,
                "content": [{"type": "text", "text": "真实响应内容"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 8, "output_tokens": 4},
                "_response_metadata": {"request_id": "req_01manualprobe"},
            },
            "anthropic_messages",
            "https://relay.example/v1/messages",
        )

    monkeypatch.setattr("app.services._live_call_with_metadata", fake_live_call)

    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Manual Probe Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            f"/api/channels/{channel_id}/model-request-test",
            json={
                "prompt": "请返回一句真实内容",
                "system_prompt": "你是测试助手",
                "request_params": {"max_tokens": 32, "temperature": 0},
            },
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["message_id"] == "msg_01manualprobe"
    assert payload["request_id"] == "req_01manualprobe"
    assert payload["message_channel_type"] == "Anthropic"
    assert payload["request_protocol"] == "anthropic_messages"
    assert payload["run"]["mode"] == "manual_probe"
    assert payload["run"]["status"] == "completed"
    assert payload["result"]["normalized_response"]["content_text"] == "真实响应内容"
    assert payload["result"]["raw_request"]["messages"][0]["content"] == "请返回一句真实内容"

    with SessionLocal() as db:
        run = db.get(Run, payload["run"]["id"])
        result = db.get(Result, payload["result"]["id"])
        case = db.get(TestCaseModel, payload["result"]["test_case_id"])

    assert run is not None
    assert run.completed_jobs == 1
    assert result is not None
    assert result.raw_response["id"] == "msg_01manualprobe"
    assert case is not None
    assert case.system_prompt == "你是测试助手"


def test_manual_probe_is_hidden_from_default_suite_and_case_lists(monkeypatch) -> None:
    reset_database()

    async def fake_live_call(channel, case, raw_request, credentials):  # noqa: ANN001
        return (
            {
                "id": "msg_01hiddenmanualprobe",
                "type": "message",
                "role": "assistant",
                "model": channel.model_name,
                "content": [{"type": "text", "text": "manual response"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 3, "output_tokens": 2},
                "_response_metadata": {"request_id": "req_01hiddenmanualprobe"},
            },
            "anthropic_messages",
            "https://relay.example/v1/messages",
        )

    monkeypatch.setattr("app.services._live_call_with_metadata", fake_live_call)

    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Hidden Manual Probe Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            f"/api/channels/{channel_id}/model-request-test",
            json={"prompt": "manual probe", "request_params": {"max_tokens": 32, "temperature": 0}},
        )
        payload = response.json()
        manual_case_id = payload["result"]["test_case_id"]

        suites = client.get("/api/suites").json()
        test_suites = client.get("/api/test-suites").json()
        test_cases = client.get("/api/test-cases").json()
        explicit_cases = client.get("/api/suites/manual_model_request_probe/cases").json()
        run_detail = client.get(f"/api/runs/{payload['run']['id']}/results").json()

    assert response.status_code == 200
    assert "manual_model_request_probe" not in {suite["id"] for suite in suites}
    assert "manual_model_request_probe" not in {suite["id"] for suite in test_suites}
    assert manual_case_id not in {case["id"] for case in test_cases}
    assert manual_case_id in {case["id"] for case in explicit_cases}
    assert run_detail["run"]["id"] == payload["run"]["id"]
    assert run_detail["results"][0]["id"] == payload["result"]["id"]


def test_model_request_test_persists_expected_error_probe_result(monkeypatch) -> None:
    reset_database()

    async def fake_live_call(channel, case, raw_request, credentials):  # noqa: ANN001
        raise RuntimeError("400 Bad Request; response body: `temperature` may only be set to 1 when thinking is enabled")

    monkeypatch.setattr("app.services._live_call_with_metadata", fake_live_call)

    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Expected Error Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            f"/api/channels/{channel_id}/model-request-test",
            json={
                "prompt": "probe",
                "request_params": {
                    "max_tokens": 2048,
                    "temperature": 0.2,
                    "thinking": {"type": "enabled", "budget_tokens": 1024},
                    "expected_error_contains": "temperature may only be set to 1 when thinking is enabled",
                },
            },
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["run"]["status"] == "completed"
    assert payload["result"]["score"] == 100
    assert payload["result"]["labels"] == []
    assert "temperature" in payload["result"]["normalized_response"]["error"]


def test_model_request_test_persists_missing_key_failure() -> None:
    reset_database()
    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Missing Key Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            f"/api/channels/{channel_id}/model-request-test",
            json={"prompt": "hello", "request_params": {"max_tokens": 16, "temperature": 0}},
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["run"]["status"] == "failed"
    assert payload["result"]["labels"] == ["request_failed"]
    assert payload["result"]["normalized_response"]["request_attempted"] is False
    assert "缺少 API Key" in payload["result"]["normalized_response"]["error"]




def test_signature_interop_persists_source_http_failure(monkeypatch) -> None:
    reset_database()

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            return httpx.Response(
                502,
                json={"error": {"message": "source upstream failed", "request_id": "req_source_fail"}},
                headers={"x-request-id": "req_source_header"},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        source_id = client.post(
            "/api/channels",
            json={"name": "Signature Source", "provider_type": "anthropic", "base_url": "https://source.example", "model_name": "claude-opus-4-6", "auth_config": {"api_key": "source-key"}, "enabled": True},
        ).json()["id"]
        relay_id = client.post(
            "/api/channels",
            json={"name": "Signature Relay", "provider_type": "anthropic", "base_url": "https://relay.example", "model_name": "claude-opus-4-6", "auth_config": {"api_key": "relay-key"}, "enabled": True},
        ).json()["id"]
        response = client.post("/api/channels/signature-interop-test", json={"source_channel_id": source_id, "relay_channel_id": relay_id})
        latest_response = client.get("/api/channels/signature-interop-test/latest", params={"source_channel_id": source_id, "relay_channel_id": relay_id})

    payload = response.json()
    latest_payload = latest_response.json()
    assert response.status_code == 200
    assert payload["ok"] is False
    assert payload["run"]["status"] == "failed"
    assert payload["steps"][0]["status"] == "fail"
    assert payload["steps"][0]["http_status"] == 502
    assert payload["steps"][0]["request_id"] == "req_source_header"
    assert payload["steps"][2]["status"] == "wait"
    assert "Relay 未执行" in payload["relay_raw_excerpt"]
    assert latest_response.status_code == 200
    assert latest_payload["result"]["id"] == payload["result"]["id"]
    assert latest_payload["steps"][0]["http_status"] == 502


def test_signature_interop_latest_client_probe_id_does_not_return_old_same_channel_log() -> None:
    reset_database()
    with TestClient(app) as client:
        source_id = client.post(
            "/api/channels",
            json={"name": "Source Probe", "provider_type": "anthropic", "base_url": "https://source.example", "model_name": "claude-opus-4-6", "auth_config": {"api_key": "source-key"}, "enabled": True},
        ).json()["id"]
        relay_id = client.post(
            "/api/channels",
            json={"name": "Relay Probe", "provider_type": "anthropic", "base_url": "https://relay.example", "model_name": "claude-opus-4-6", "auth_config": {"api_key": "relay-key"}, "enabled": True},
        ).json()["id"]

    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        case = TestCaseModel(id="case_sig_probe", suite_id="claude_full_35", sort_order=9001, module="protocol", title="sig", prompt="sig")
        old_run = Run(id="run_sig_old", suite_id="claude_full_35", name="old", mode="manual_probe", test_scope="quick", status="completed", repeat_count=1, concurrency=1, total_jobs=1, completed_jobs=1, started_at=now, finished_at=now)
        new_run = Run(id="run_sig_new", suite_id="claude_full_35", name="new", mode="manual_probe", test_scope="quick", status="completed", repeat_count=1, concurrency=1, total_jobs=1, completed_jobs=1, started_at=now, finished_at=now)
        old_payload = {"ok": True, "status": "pass", "reason": "old", "client_probe_id": "probe-old", "source_channel_id": source_id, "relay_channel_id": relay_id, "source_endpoint": "https://source.example/v1/messages", "relay_endpoint": "https://relay.example/v1/messages", "model": "claude-opus-4-6", "thinking_block_count": 1, "signature_prefixes": ["old"], "source_message_channel_type": "Anthropic", "relay_message_channel_type": "Anthropic", "relay_raw_excerpt": "{}", "fallback_note": "", "steps": [{"name": "最终判定", "status": "ok", "detail": "old"}]}
        new_payload = {**old_payload, "reason": "new", "client_probe_id": "probe-new", "signature_prefixes": ["new"], "steps": [{"name": "最终判定", "status": "ok", "detail": "new"}]}
        db.add_all([case, old_run, new_run])
        db.add(Result(id="res_sig_old", run_id=old_run.id, test_case_id=case.id, channel_id=relay_id, attempt_index=1, normalized_response={"signature_interop": old_payload}, raw_request={"test_type": "signature_interop", "source_channel_id": source_id, "relay_channel_id": relay_id, "stream": False, "client_probe_id": "probe-old"}, raw_response=old_payload, metrics={}, score=100, labels=[]))
        db.add(Result(id="res_sig_new", run_id=new_run.id, test_case_id=case.id, channel_id=relay_id, attempt_index=1, normalized_response={"signature_interop": new_payload}, raw_request={"test_type": "signature_interop", "source_channel_id": source_id, "relay_channel_id": relay_id, "stream": False, "client_probe_id": "probe-new"}, raw_response=new_payload, metrics={}, score=100, labels=[]))
        db.commit()

    with TestClient(app) as client:
        response = client.get(
            "/api/channels/signature-interop-test/latest",
            params={"source_channel_id": source_id, "relay_channel_id": relay_id, "stream": "false", "client_probe_id": "probe-old"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["client_probe_id"] == "probe-old"
    assert payload["result"]["id"] == "res_sig_old"


def test_signature_interop_latest_supports_legacy_raw_response_shape() -> None:
    reset_database()
    with TestClient(app) as client:
        source_id = client.post(
            "/api/channels",
            json={"name": "Legacy Source", "provider_type": "anthropic", "base_url": "https://source.example", "model_name": "claude-opus-4-6", "auth_config": {"api_key": "source-key"}, "enabled": True},
        ).json()["id"]
        relay_id = client.post(
            "/api/channels",
            json={"name": "Legacy Relay", "provider_type": "anthropic", "base_url": "https://relay.example", "model_name": "claude-opus-4-6", "auth_config": {"api_key": "relay-key"}, "enabled": True},
        ).json()["id"]

    now = datetime.now(timezone.utc)
    legacy_payload = {"ok": False, "status": "fail", "reason": "legacy", "source_channel_id": source_id, "relay_channel_id": relay_id, "source_endpoint": "https://source.example/v1/messages", "relay_endpoint": "https://relay.example/v1/messages", "model": "claude-opus-4-6", "thinking_block_count": 0, "signature_prefixes": [], "source_message_channel_type": "未知", "relay_message_channel_type": "未知", "relay_raw_excerpt": "{}", "fallback_note": "", "steps": [{"name": "步骤 A：请求 Source thinking", "status": "fail", "detail": "legacy fail", "http_status": 502}]}
    with SessionLocal() as db:
        case = TestCaseModel(id="case_sig_legacy", suite_id="claude_full_35", sort_order=9002, module="protocol", title="legacy", prompt="legacy")
        run = Run(id="run_sig_legacy", suite_id="claude_full_35", name="legacy", mode="manual_probe", test_scope="quick", status="failed", repeat_count=1, concurrency=1, total_jobs=1, completed_jobs=1, started_at=now, finished_at=now)
        db.add_all([case, run])
        db.add(Result(id="res_sig_legacy", run_id=run.id, test_case_id=case.id, channel_id=relay_id, attempt_index=1, normalized_response={}, raw_request={}, raw_response=legacy_payload, metrics={}, score=0, labels=["signature_interop_failed"]))
        db.commit()

    with TestClient(app) as client:
        response = client.get(
            "/api/channels/signature-interop-test/latest",
            params={"source_channel_id": source_id, "relay_channel_id": relay_id, "stream": "false"},
        )

    assert response.status_code == 200
    assert response.json()["result"]["id"] == "res_sig_legacy"
    assert response.json()["steps"][0]["http_status"] == 502


def test_signature_interop_latest_returns_404_without_matching_log() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.get(
            "/api/channels/signature-interop-test/latest",
            params={"source_channel_id": "missing_source", "relay_channel_id": "missing_relay"},
        )

    assert response.status_code == 404


def test_cache_hit_rate_test_persists_attempts_and_summary(monkeypatch) -> None:
    reset_database()
    calls = {"count": 0}

    async def fake_live_call(channel, case, raw_request, credentials):  # noqa: ANN001
        calls["count"] += 1
        is_warmup = calls["count"] == 1
        usage = {
            "input_tokens": 25,
            "output_tokens": 6,
            "cache_creation_input_tokens": 1800 if is_warmup else 0,
            "cache_read_input_tokens": 0 if is_warmup or calls["count"] == 3 else 1700,
            "cache_creation": {
                "ephemeral_5m_input_tokens": 1800 if is_warmup else 0,
                "ephemeral_1h_input_tokens": 0,
            },
        }
        return (
            {
                "id": f"msg_01cache{calls['count']}",
                "type": "message",
                "role": "assistant",
                "model": channel.model_name,
                "content": [{"type": "text", "text": "Ulysses"}],
                "stop_reason": "end_turn",
                "usage": usage,
                "_response_metadata": {"request_id": f"req_cache_{calls['count']}"},
            },
            "anthropic_messages",
            "https://relay.example/v1/messages",
        )

    monkeypatch.setattr("app.services._live_call_with_metadata", fake_live_call)

    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Cache Probe Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            f"/api/channels/{channel_id}/cache-hit-rate-test",
            json={"test_count": 3, "interval_seconds": 0, "warmup_wait_seconds": 0},
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["run"]["mode"] == "manual_probe"
    assert payload["run"]["status"] == "completed"
    assert payload["total"] == 3
    assert payload["hits"] == 2
    assert payload["request_hit_rate"] == 66.67
    assert payload["total_cached_tokens"] == 3400
    assert payload["total_prompt_tokens"] == 25 + 25 + 1700 + 25 + 1700
    assert payload["token_hit_rate"] == 97.84
    assert payload["avg_cached_tokens"] == 1700
    assert payload["requested_cache_ttl"] == "5m"
    assert payload["warmup_cache_creation_input_tokens"] == 1800
    assert payload["warmup_cache_creation_ephemeral_5m_input_tokens"] == 1800
    assert payload["warmup_cache_creation_ephemeral_1h_input_tokens"] == 0
    assert payload["warmup"]["is_warmup"] is True
    assert payload["warmup"]["cache_creation_ephemeral_5m_input_tokens"] == 1800
    assert payload["warmup"]["cache_creation_ephemeral_1h_input_tokens"] == 0
    assert payload["attempts"][0]["cache_hit"] is True
    assert payload["attempts"][1]["cache_hit"] is False
    assert payload["attempts"][2]["cache_hit"] is True
    assert payload["attempts"][0]["request_id"] == "req_cache_2"
    assert payload["request_protocol"] == "anthropic_messages"
    assert payload["provider_endpoint"] == "https://relay.example/v1/messages"

    with SessionLocal() as db:
        results = db.scalars(select(Result).where(Result.run_id == payload["run"]["id"]).order_by(Result.attempt_index)).all()
    assert len(results) == 4
    assert results[0].raw_request["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "5m"}
    sample_text = results[0].raw_request["system"][0]["text"]
    assert "PROJECT GUTENBERG EBOOK 4300" in sample_text
    assert "Ulysses" in sample_text
    assert "by James Joyce" in sample_text
    assert len(sample_text) > 18000
    assert "Authorization" not in json.dumps(results[0].raw_request)
    assert "test-key" not in json.dumps(results[0].raw_request)


def test_cache_hit_rate_test_uses_unique_probe_id_per_run(monkeypatch) -> None:
    reset_database()
    calls = {"count": 0}

    async def fake_live_call(channel, case, raw_request, credentials):  # noqa: ANN001
        calls["count"] += 1
        is_warmup = calls["count"] % 2 == 1
        return (
            {
                "id": f"msg_01cache_unique_{calls['count']}",
                "type": "message",
                "role": "assistant",
                "model": channel.model_name,
                "content": [{"type": "text", "text": "Ulysses"}],
                "stop_reason": "end_turn",
                "usage": {
                    "input_tokens": 25,
                    "output_tokens": 6,
                    "cache_creation_input_tokens": 1800 if is_warmup else 0,
                    "cache_read_input_tokens": 0 if is_warmup else 1700,
                    "cache_creation": {
                        "ephemeral_5m_input_tokens": 1800 if is_warmup else 0,
                        "ephemeral_1h_input_tokens": 0,
                    },
                },
                "_response_metadata": {"request_id": f"req_cache_unique_{calls['count']}"},
            },
            "anthropic_messages",
            "https://relay.example/v1/messages",
        )

    monkeypatch.setattr("app.services._live_call_with_metadata", fake_live_call)

    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Cache Probe Unique Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        first = client.post(
            f"/api/channels/{channel_id}/cache-hit-rate-test",
            json={"test_count": 1, "interval_seconds": 0, "warmup_wait_seconds": 0},
        ).json()
        second = client.post(
            f"/api/channels/{channel_id}/cache-hit-rate-test",
            json={"test_count": 1, "interval_seconds": 0, "warmup_wait_seconds": 0},
        ).json()

    assert first["cache_probe_id"]
    assert second["cache_probe_id"]
    assert first["cache_probe_id"] != second["cache_probe_id"]
    assert first["total"] == 1
    assert first["hits"] == 1

    with SessionLocal() as db:
        first_texts = [
            result.raw_request["system"][0]["text"]
            for result in db.scalars(select(Result).where(Result.run_id == first["run"]["id"]).order_by(Result.attempt_index)).all()
        ]
        second_texts = [
            result.raw_request["system"][0]["text"]
            for result in db.scalars(select(Result).where(Result.run_id == second["run"]["id"]).order_by(Result.attempt_index)).all()
        ]

    assert len(first_texts) == 2
    assert len(second_texts) == 2
    assert all(first["cache_probe_id"] in text for text in first_texts)
    assert all(second["cache_probe_id"] in text for text in second_texts)
    assert all(second["cache_probe_id"] not in text for text in first_texts)
    assert all(first["cache_probe_id"] not in text for text in second_texts)


def test_cache_hit_rate_test_supports_one_hour_ttl(monkeypatch) -> None:
    reset_database()
    calls = {"count": 0}

    async def fake_live_call(channel, case, raw_request, credentials):  # noqa: ANN001
        calls["count"] += 1
        is_warmup = calls["count"] == 1
        return (
            {
                "id": f"msg_01cache_one_hour_{calls['count']}",
                "type": "message",
                "role": "assistant",
                "model": channel.model_name,
                "content": [{"type": "text", "text": "Ulysses"}],
                "stop_reason": "end_turn",
                "usage": {
                    "input_tokens": 25,
                    "output_tokens": 6,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0 if is_warmup else 1700,
                    "cache_creation": {
                        "ephemeral_5m_input_tokens": 0,
                        "ephemeral_1h_input_tokens": 1900 if is_warmup else 0,
                    },
                },
                "_response_metadata": {"request_id": f"req_cache_one_hour_{calls['count']}"},
            },
            "anthropic_messages",
            "https://relay.example/v1/messages",
        )

    monkeypatch.setattr("app.services._live_call_with_metadata", fake_live_call)

    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Cache Probe One Hour Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            f"/api/channels/{channel_id}/cache-hit-rate-test",
            json={"test_count": 1, "interval_seconds": 0, "warmup_wait_seconds": 0, "cache_ttl": "1h"},
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["requested_cache_ttl"] == "1h"
    assert payload["warmup_cache_creation_input_tokens"] == 0
    assert payload["warmup_cache_creation_ephemeral_5m_input_tokens"] == 0
    assert payload["warmup_cache_creation_ephemeral_1h_input_tokens"] == 1900
    assert payload["warmup"]["cache_creation_ephemeral_1h_input_tokens"] == 1900
    assert payload["warmup"]["prompt_tokens"] == 1925
    assert payload["attempts"][0]["cache_read_input_tokens"] == 1700
    with SessionLocal() as db:
        result = db.scalar(select(Result).where(Result.run_id == payload["run"]["id"], Result.attempt_index == 1))
    assert result is not None
    assert result.raw_request["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}


def test_cache_hit_rate_test_rejects_invalid_ttl() -> None:
    reset_database()
    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Cache Probe Invalid TTL Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            f"/api/channels/{channel_id}/cache-hit-rate-test",
            json={"test_count": 1, "interval_seconds": 0, "warmup_wait_seconds": 0, "cache_ttl": "30m"},
        )

    assert response.status_code == 422


def test_cache_hit_rate_test_rejects_openai_compatible_channel() -> None:
    reset_database()
    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "OpenAI Compat",
                "provider_type": "openai_compatible",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            f"/api/channels/{channel_id}/cache-hit-rate-test",
            json={"test_count": 1, "interval_seconds": 0, "warmup_wait_seconds": 0},
        )

    assert response.status_code == 400
    assert "Anthropic Messages" in response.json()["detail"]


def test_cache_hit_rate_job_reports_live_progress(monkeypatch) -> None:
    reset_database()
    calls = {"count": 0}

    async def fake_live_call(channel, case, raw_request, credentials):  # noqa: ANN001
        calls["count"] += 1
        await asyncio.sleep(0.01)
        is_warmup = calls["count"] == 1
        return (
            {
                "id": f"msg_01cache_job_{calls['count']}",
                "type": "message",
                "role": "assistant",
                "model": channel.model_name,
                "content": [{"type": "text", "text": "Ulysses"}],
                "stop_reason": "end_turn",
                "usage": {
                    "input_tokens": 20,
                    "output_tokens": 5,
                    "cache_creation_input_tokens": 1000 if is_warmup else 0,
                    "cache_read_input_tokens": 0 if is_warmup else 950,
                    "cache_creation": {
                        "ephemeral_5m_input_tokens": 1000 if is_warmup else 0,
                        "ephemeral_1h_input_tokens": 0,
                    },
                },
                "_response_metadata": {"request_id": f"req_cache_job_{calls['count']}"},
            },
            "anthropic_messages",
            "https://relay.example/v1/messages",
        )

    monkeypatch.setattr("app.services._live_call_with_metadata", fake_live_call)

    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Cache Probe Job Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        started = client.post(
            f"/api/channels/{channel_id}/cache-hit-rate-test/jobs",
            json={"test_count": 2, "interval_seconds": 0, "warmup_wait_seconds": 0},
        )
        assert started.status_code == 200
        job_id = started.json()["job_id"]

        running_snapshot: dict[str, object] | None = None
        final_snapshot: dict[str, object] | None = None
        for _ in range(80):
            polled = client.get(f"/api/cache-hit-rate-test/jobs/{job_id}")
            assert polled.status_code == 200
            payload = polled.json()
            if payload["completed_count"] >= 1 and payload["status"] in {"running", "completed"}:
                running_snapshot = payload
            if payload["status"] == "completed":
                final_snapshot = payload
                break
            time.sleep(0.02)

    assert running_snapshot is not None
    assert running_snapshot["warmup"]["is_warmup"] is True
    assert running_snapshot["completed_count"] >= 1
    assert final_snapshot is not None
    assert final_snapshot["status"] == "completed"
    assert final_snapshot["completed_count"] == 3
    assert final_snapshot["total_count"] == 3
    assert final_snapshot["percent"] == 100.0
    assert len(final_snapshot["attempts"]) == 2
    assert final_snapshot["hits"] == 2
    assert final_snapshot["request_hit_rate"] == 100.0
    assert final_snapshot["token_hit_rate"] == 97.94
    assert final_snapshot["requested_cache_ttl"] == "5m"
    assert final_snapshot["warmup_cache_creation_ephemeral_5m_input_tokens"] == 1000
    assert final_snapshot["warmup_cache_creation_ephemeral_1h_input_tokens"] == 0
    assert final_snapshot["result"]["run"]["status"] == "completed"
    assert final_snapshot["attempts"][0]["cache_hit"] is True


def test_cache_hit_rate_missing_job_explains_restart_or_expiry() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.get("/api/cache-hit-rate-test/jobs/missing_job")

    assert response.status_code == 404
    assert "服务重启" in response.json()["detail"]
    assert "过期" in response.json()["detail"]


def test_claude_code_test_endpoint_runs_isolated_probe_suite(monkeypatch) -> None:
    reset_database()

    async def fake_invoke(channel, case, attempt, credentials, use_mock):  # noqa: ANN001
        rules = case.scoring_rules or {}
        params = case.request_params or {}
        text = "OK"
        stop_reason = "end_turn"
        stop_sequence = None
        error = None
        raw_response: dict[str, object] = {
            "id": "msg_01claudecode",
            "type": "message",
            "model": channel.model_name,
            "content": [{"type": "text", "text": text}],
            "stop_reason": stop_reason,
            "usage": {"input_tokens": 20, "output_tokens": 2},
        }
        if rules.get("invalid_request_probe"):
            raw_response = {"type": "error", "error": {"type": "invalid_request_error", "message": "messages must contain at least one item"}}
            error = "messages must contain at least one item"
        elif rules.get("expected_error_any"):
            error = "invalid unknown output_config format effort cache_control display thinking"
            raw_response = {"type": "error", "error": {"type": "invalid_request_error", "message": error}}
        elif rules.get("expected_stop_reason"):
            raw_response["content"] = [{"type": "text", "text": "A"}]
            raw_response["stop_reason"] = "max_tokens"
        elif rules.get("stop_sequence"):
            raw_response["content"] = [{"type": "text", "text": "第一句"}]
            raw_response["stop_reason"] = "stop_sequence"
            raw_response["stop_sequence"] = "。"
        elif case.title.endswith("基础回显"):
            raw_response["content"] = [{"type": "text", "text": "CC-ECHO-731"}]
        elif case.title.endswith("图片输入 base64") or case.title.endswith("图片输入 URL"):
            raw_response["content"] = [{"type": "text", "text": "red"}]
        elif case.title.endswith("文档识别"):
            raw_response["content"] = [{"type": "text", "text": "CC-DOC-742"}]
        elif case.title.endswith("严格 JSON Schema"):
            raw_response["content"] = [
                {
                    "type": "text",
                    "text": json.dumps(
                        {"probe": "cc-json-schema", "risk": "low", "nonce": "CC-JSON-418", "checks": ["schema", "enum"]},
                        ensure_ascii=False,
                    ),
                }
            ]
        elif case.title.endswith("tool_use 结构"):
            raw_response["content"] = [
                {
                    "type": "tool_use",
                    "id": "toolu_01shape",
                    "name": "cc_probe_lookup",
                    "input": {"order_id": "CC-ORDER-204", "reason": "relay-shape-check"},
                }
            ]
            raw_response["stop_reason"] = "tool_use"
        elif case.title.endswith("Thinking signature"):
            raw_response["content"] = [
                {"type": "thinking", "thinking": "hidden", "signature": "sig-test"},
                {"type": "text", "text": "0.1 和 0.2 的二进制浮点表示无法精确相加。"},
            ]
        elif case.title.endswith("提示词泄露诱导"):
            raw_response["content"] = [{"type": "text", "text": "我不能访问隐藏系统提示词。"}]
        elif "CC-NEEDLE-219" in case.prompt:
            raw_response["content"] = [{"type": "text", "text": "CC-NEEDLE-219 violet-731"}]
        elif "CC-NONCE-814A" in case.prompt:
            raw_response["content"] = [{"type": "text", "text": "CC-NONCE-814A"}]
        elif "CC-NONCE-927B" in case.prompt:
            raw_response["content"] = [{"type": "text", "text": "CC-NONCE-927B"}]

        return {
            "channel_id": channel.id,
            "channel_name": channel.name,
            "channel_role": channel.role,
            "test_case_id": case.id,
            "status_code": 500 if error else 200,
            "latency_ms": 10,
            "first_token_ms": 5,
            "ttft_ms": 5,
            "tpot_ms": 1,
            "input_tokens": 20,
            "output_tokens": 2,
            "tokens_per_second": 50,
            "error_type": "invalid_request_error" if error else None,
            "provider_message_id": raw_response.get("id"),
            "provider_model": channel.model_name,
            "stop_reason": raw_response.get("stop_reason"),
            "stop_sequence": raw_response.get("stop_sequence"),
            "usage": raw_response.get("usage"),
            "content_text": "\n".join(block.get("text", "") for block in raw_response.get("content", []) if isinstance(block, dict)),
            "content_blocks": raw_response.get("content", []),
            "tool_calls": [block for block in raw_response.get("content", []) if isinstance(block, dict) and block.get("type") == "tool_use"],
            "stream_events": ["message_stop"],
            "raw_request": {"messages": [{"role": "user", "content": params.get("message_content") or case.prompt}], "params": params},
            "raw_response": raw_response,
            "error": error,
            "request_mode": "live",
            "request_attempted": True,
            "provider_endpoint": "https://relay.example/v1/messages",
            "request_protocol": "anthropic_messages",
            "channel_preflight_failed": False,
        }

    async def fake_signature(source, relay, stream=False):  # noqa: ANN001
        return {
            "ok": True,
            "reason": "兼容",
            "relay_message_id": "msg_01relay",
            "relay_request_id": "req_relay",
            "relay_endpoint": "https://relay.example/v1/messages",
        }

    monkeypatch.setattr("app.services.invoke_channel", fake_invoke)
    monkeypatch.setattr("app.services.test_signature_interop", fake_signature)

    with TestClient(app) as client:
        response = client.post("/api/channels/third_party_demo/claude-code-test", json={})

    payload = response.json()
    assert response.status_code == 200
    assert payload["risk_level"] in {"low", "medium"}
    assert payload["score"] >= 90
    keys = {probe["key"] for probe in payload["probes"]}
    assert {"basic_echo", "strict_json_schema", "tool_use_shape", "repeatability_nonce_pair", "image_base64", "document_input", "thinking_signature", "signature_interop"} <= keys
    assert next(probe for probe in payload["probes"] if probe["key"] == "repeatability_nonce_pair")["status"] == "pass"
    assert all("run_id" in probe for probe in payload["probes"])
    section_keys = {section["key"] for section in payload["sections"]}
    assert {"fingerprint", "structure", "behavior", "signature", "multimodal", "web_capability"} >= section_keys
    assert "structure" in section_keys
    assert any(section["title"] == "Claude 基础结构" for section in payload["sections"])


def test_ephemeral_claude_code_test_uses_runtime_credentials_without_persisting(monkeypatch) -> None:
    reset_database()
    seen_credentials: list[dict[str, object]] = []
    seen_relay_auth: list[dict[str, object]] = []

    async def fake_invoke(channel, case, attempt, credentials, use_mock):  # noqa: ANN001
        seen_credentials.append(dict(credentials))
        assert channel.id == "ephemeral_claude_code_test"
        assert channel.base_url == "https://runtime-relay.example/v1"
        assert channel.model_name == "claude-code-max-200"
        assert credentials["api_key"] == "sk-runtime-secret"
        assert credentials["base_url"] == "https://runtime-relay.example/v1"
        assert credentials["model"] == "claude-code-max-200"
        assert credentials["request_protocol"] == "anthropic_messages"
        raw_response = {
            "id": "msg_01runtime",
            "type": "message",
            "model": channel.model_name,
            "content": [{"type": "text", "text": "OK"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 8, "output_tokens": 2},
        }
        return {
            "channel_id": channel.id,
            "channel_name": channel.name,
            "channel_role": channel.role,
            "test_case_id": case.id,
            "status_code": 200,
            "latency_ms": 10,
            "first_token_ms": 5,
            "ttft_ms": 5,
            "tpot_ms": 1,
            "input_tokens": 8,
            "output_tokens": 2,
            "tokens_per_second": 50,
            "error_type": None,
            "provider_message_id": raw_response["id"],
            "provider_model": channel.model_name,
            "stop_reason": raw_response["stop_reason"],
            "stop_sequence": None,
            "usage": raw_response["usage"],
            "content_text": "OK",
            "content_blocks": raw_response["content"],
            "tool_calls": [],
            "stream_events": ["message_stop"],
            "raw_request": {"messages": [{"role": "user", "content": case.prompt}]},
            "raw_response": raw_response,
            "error": None,
            "request_mode": "live",
            "request_attempted": True,
            "provider_endpoint": "https://runtime-relay.example/v1/messages",
            "request_protocol": "anthropic_messages",
            "channel_preflight_failed": False,
        }

    async def fake_signature(source, relay, stream=False):  # noqa: ANN001
        seen_relay_auth.append(dict(relay.auth_config))
        return {
            "ok": True,
            "reason": "runtime signature ok",
            "relay_message_id": "msg_01relay",
            "relay_request_id": "req_relay",
            "relay_endpoint": "https://runtime-relay.example/v1/messages",
        }

    monkeypatch.setattr("app.services.invoke_channel", fake_invoke)
    monkeypatch.setattr("app.services.test_signature_interop", fake_signature)

    with TestClient(app) as client:
        response = client.post(
            "/api/claude-code-test",
            json={
                "channel_label": "APIPro-aws官",
                "base_url": " https://runtime-relay.example/v1 ",
                "api_key": " sk-runtime-secret ",
                "model_name": " claude-code-max-200 ",
                "provider_type": "third_party_anthropic",
                "request_protocol": "anthropic_messages",
                "include_expensive_context": False,
            },
        )

    payload = response.json()
    assert response.status_code == 200
    assert seen_credentials
    assert seen_relay_auth and seen_relay_auth[-1]["api_key"] == "sk-runtime-secret"
    assert payload["probes"]
    assert all(probe["run_id"] is None and probe["result_id"] is None for probe in payload["probes"])
    assert "sk-runtime-secret" not in json.dumps(payload, ensure_ascii=False)
    assert seen_credentials[-1]["model"] == "claude-code-max-200"
    with SessionLocal() as db:
        assert db.get(Channel, "ephemeral_claude_code_test") is None
        assert db.scalar(select(func.count()).select_from(Run).where(Run.name.like("ClaudeCode 检测%"))) == 0


def test_claude_code_relay_job_persists_custom_channel_label(monkeypatch) -> None:
    reset_database()

    async def fake_create_test(db, channel, **kwargs):  # noqa: ANN001
        assert channel.name == "APIPro-aws官"
        return {
            "ok": True,
            "score": 96,
            "risk_level": "low",
            "summary": "ok",
            "probes": [],
            "sections": [],
        }

    monkeypatch.setattr("app.main.create_claude_code_test", fake_create_test)

    with TestClient(app) as client:
        response = client.post(
            "/api/claude-code-test/jobs",
            json={
                "channel_label": " APIPro-aws官 ",
                "base_url": "https://relay.example/v1",
                "api_key": "sk-test",
                "model_name": "claude-sonnet-4-5",
            },
        )

    assert response.status_code == 200
    job_id = response.json()["job_id"]
    with TestClient(app) as client:
        for _ in range(20):
            status = client.get(f"/api/claude-code-test/jobs/{job_id}").json()
            if status["status"] == "completed":
                break
        assert status["status"] == "completed"
    with SessionLocal() as db:
        item = db.scalar(select(ClaudeCodeEvidence).order_by(ClaudeCodeEvidence.created_at.desc()))
        assert item is not None
        assert item.channel_label == "APIPro-aws官"


def test_claude_code_relay_job_uses_default_channel_label_when_blank(monkeypatch) -> None:
    reset_database()

    async def fake_create_test(db, channel, **kwargs):  # noqa: ANN001
        assert channel.name == "Claude 资源临时检测渠道"
        return {
            "ok": True,
            "score": 96,
            "risk_level": "low",
            "summary": "ok",
            "probes": [],
            "sections": [],
        }

    monkeypatch.setattr("app.main.create_claude_code_test", fake_create_test)

    with TestClient(app) as client:
        response = client.post(
            "/api/claude-code-test/jobs",
            json={
                "channel_label": "   ",
                "base_url": "https://relay.example/v1",
                "api_key": "sk-test",
                "model_name": "claude-sonnet-4-5",
            },
        )

    assert response.status_code == 200
    job_id = response.json()["job_id"]
    with TestClient(app) as client:
        for _ in range(20):
            status = client.get(f"/api/claude-code-test/jobs/{job_id}").json()
            if status["status"] == "completed":
                break
        assert status["status"] == "completed"
    with SessionLocal() as db:
        item = db.scalar(select(ClaudeCodeEvidence).order_by(ClaudeCodeEvidence.created_at.desc()))
        assert item is not None
        assert item.channel_label == "Claude 资源临时检测渠道"


def test_claude_code_thinking_signature_latency_outlier_still_passes(monkeypatch) -> None:
    reset_database()

    async def fake_invoke(channel, case, attempt, credentials, use_mock):  # noqa: ANN001
        raw_response = {
            "id": "msg_01signature",
            "type": "message",
            "model": channel.model_name,
            "content": [
                {"type": "thinking", "thinking": "hidden", "signature": "sig-test"},
                {"type": "text", "text": "0.1 和 0.2 的二进制浮点表示无法精确相加。"},
            ],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 20, "output_tokens": 12},
        }
        return {
            "channel_id": channel.id,
            "channel_name": channel.name,
            "channel_role": channel.role,
            "test_case_id": case.id,
            "status_code": 200,
            "latency_ms": 6000,
            "first_token_ms": 5,
            "ttft_ms": 5,
            "tpot_ms": 1,
            "input_tokens": 20,
            "output_tokens": 12,
            "tokens_per_second": 50,
            "error_type": None,
            "provider_message_id": raw_response["id"],
            "provider_model": channel.model_name,
            "stop_reason": raw_response["stop_reason"],
            "stop_sequence": None,
            "usage": raw_response["usage"],
            "content_text": "0.1 和 0.2 的二进制浮点表示无法精确相加。",
            "content_blocks": raw_response["content"],
            "tool_calls": [],
            "stream_events": ["message_stop"],
            "raw_request": {"messages": [{"role": "user", "content": case.prompt}]},
            "raw_response": raw_response,
            "error": None,
            "request_mode": "live",
            "request_attempted": True,
            "provider_endpoint": "https://relay.example/v1/messages",
            "request_protocol": "anthropic_messages",
            "channel_preflight_failed": False,
        }

    async def fake_signature(source, relay, stream=False):  # noqa: ANN001
        return {"ok": True, "reason": "兼容"}

    monkeypatch.setattr("app.services.invoke_channel", fake_invoke)
    monkeypatch.setattr("app.services.test_signature_interop", fake_signature)

    with TestClient(app) as client:
        response = client.post("/api/channels/third_party_demo/claude-code-test", json={})

    payload = response.json()
    assert response.status_code == 200
    probe = next(item for item in payload["probes"] if item["key"] == "thinking_signature")
    assert probe["status"] == "pass"
    assert probe["score"] == 95
    assert probe["labels"] == ["latency_outlier"]


def test_claude_code_web_search_reference_probe_is_unscored() -> None:
    from app.services import _claude_code_probe_configs, _claude_code_score, _claude_code_risk_level, _claude_code_summary

    config = next(item for item in _claude_code_probe_configs(None) if item["key"] == "web_search_reference")
    assert config["severity"] == "reference"
    assert config["category"] == "web_capability"
    assert config["request_params"]["tools"][0]["type"] == "web_search_20260318"
    assert "temperature" not in config["request_params"]

    probes = [
        {"title": "基础回显", "severity": "core", "status": "pass", "score": 100},
        {"title": "Web Search 能力参考", "severity": "reference", "status": "fail", "score": 0},
    ]
    assert _claude_code_score(probes) == 100
    assert _claude_code_risk_level(100, probes) == "low"
    assert "Web Search" not in _claude_code_summary("low", probes)


def test_adaptive_thinking_model_normalizes_legacy_thinking_fields() -> None:
    from app.services import _normalize_probe_body_for_model

    body = {
        "model": "claude-opus-4-7",
        "max_tokens": 2048,
        "temperature": 0.2,
        "top_p": 0.9,
        "top_k": 40,
        "thinking": {"type": "enabled", "budget_tokens": 1024, "adaptive": {"enabled": True}},
    }

    profile, notes = _normalize_probe_body_for_model(body, "claude-opus-4-7-high")

    assert profile == "claude_adaptive_thinking"
    assert body["thinking"] == {"type": "adaptive"}
    assert body["output_config"] == {"effort": "high"}
    assert "temperature" not in body
    assert "top_p" not in body
    assert "top_k" not in body
    assert any("budget_tokens" in note for note in notes)


def test_opus_48_uses_adaptive_thinking_profile() -> None:
    from app.services import _normalize_probe_body_for_model, claude_protocol_profile_for_model

    body = {
        "model": "claude-opus-4-8",
        "max_tokens": 2048,
        "temperature": 0,
        "thinking": {"type": "enabled", "budget_tokens": 1024},
    }

    profile, notes = _normalize_probe_body_for_model(body, "claude-opus-4-8-max")

    assert claude_protocol_profile_for_model("claude-opus-4-8") == "claude_adaptive_thinking"
    assert profile == "claude_adaptive_thinking"
    assert body["thinking"] == {"type": "adaptive"}
    assert body["output_config"] == {"effort": "max"}
    assert "temperature" not in body
    assert any("4.7/4.8" in note for note in notes)


def test_opus_48_bedrock_suffix_keeps_effort_hint() -> None:
    from app.services import _normalize_probe_body_for_model

    body = {"model": "anthropic.claude-opus-4-8-high-v1:0", "max_tokens": 2048, "thinking": {"type": "enabled", "budget_tokens": 1024}}

    profile, _notes = _normalize_probe_body_for_model(body, "anthropic.claude-opus-4-8-high-v1:0")

    assert profile == "claude_adaptive_thinking"
    assert body["thinking"] == {"type": "adaptive"}
    assert body["output_config"] == {"effort": "high"}


def test_legacy_claude_model_keeps_legacy_thinking_fields() -> None:
    from app.services import _normalize_probe_body_for_model

    body = {
        "model": "claude-opus-4-6",
        "max_tokens": 2048,
        "temperature": 1,
        "thinking": {"type": "enabled", "budget_tokens": 1024},
    }

    profile, notes = _normalize_probe_body_for_model(body, "claude-opus-4-6")

    assert profile == "claude_legacy"
    assert body["thinking"] == {"type": "enabled", "budget_tokens": 1024}
    assert body["temperature"] == 1
    assert notes == []



def test_adaptive_thinking_model_removes_sampling_params_for_all_probes() -> None:
    from app.services import _normalize_probe_body_for_model

    body = {
        "model": "claude-opus-4-7",
        "max_tokens": 64,
        "temperature": 0,
        "top_p": 0.9,
        "top_k": 40,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
    }

    profile, notes = _normalize_probe_body_for_model(body, "claude-opus-4-7")

    assert profile == "claude_adaptive_thinking"
    assert "temperature" not in body
    assert "top_p" not in body
    assert "top_k" not in body
    assert any("temperature" in note for note in notes)


def test_claude_code_multimodal_probe_payloads_are_protocol_safe() -> None:
    from app.services import CLAUDE_CODE_DOCUMENT_TEXT, CLAUDE_CODE_RED_PNG_BASE64, _claude_code_probe_configs

    configs = {item["key"]: item for item in _claude_code_probe_configs(None)}

    image_body = configs["image_base64"]["request_params"]
    assert "temperature" not in image_body
    assert image_body["message_content"][1] == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": CLAUDE_CODE_RED_PNG_BASE64},
    }

    document_body = configs["document_input"]["request_params"]
    assert "temperature" not in document_body
    assert all(block.get("type") == "text" for block in document_body["message_content"])
    assert document_body["message_content"][1]["text"] == CLAUDE_CODE_DOCUMENT_TEXT


def test_claude_code_web_search_reference_uses_latest_tool_version() -> None:
    from app.services import _claude_code_probe_configs

    config = next(item for item in _claude_code_probe_configs(None) if item["key"] == "web_search_reference")

    assert config["request_params"]["tools"][0]["type"] == "web_search_20260318"
    assert "temperature" not in config["request_params"]


def test_claude_code_probe_configs_include_stronger_relay_probes() -> None:
    from app.services import _claude_code_probe_configs, _claude_code_section_for_category

    configs = {item["key"]: item for item in _claude_code_probe_configs(None)}

    assert configs["strict_json_schema"]["category"] == "protocol"
    assert configs["strict_json_schema"]["severity"] == "supporting"
    assert _claude_code_section_for_category(configs["strict_json_schema"]["category"]) == "structure"
    assert configs["tool_use_shape"]["severity"] == "core"
    assert configs["tool_use_shape"]["scoring_rules"]["tool_id_prefix"] == "toolu_"
    assert configs["repeatability_nonce_pair"]["post_check"] == "repeatability_nonce_pair"
    assert _claude_code_section_for_category(configs["repeatability_nonce_pair"]["category"]) == "behavior"
    assert configs["thinking_signature"]["request_params"]["thinking"] == {"type": "adaptive"}
    assert configs["thinking_signature"]["request_params"]["output_config"] == {"effort": "medium"}
    assert "budget_tokens" not in configs["thinking_signature"]["request_params"]["thinking"]
    assert "temperature" not in configs["basic_echo"]["request_params"]


def test_claude_code_strict_json_schema_scoring_labels() -> None:
    from app.services import _claude_code_probe_configs

    config = next(item for item in _claude_code_probe_configs(None) if item["key"] == "strict_json_schema")
    channel = Channel(id="json_probe", name="JSON Probe", provider_type="third_party_anthropic", role="candidate")
    case = TestCaseModel(
        id="strict_json_probe",
        suite_id="manual_model_request_probe",
        module="manual_probe",
        title="ClaudeCode 检测 · 严格 JSON Schema",
        prompt=str(config["prompt"]),
        scoring_rules=config["scoring_rules"],
    )

    ok_raw = {
        "type": "message",
        "id": "msg_01json",
        "content": [{"type": "text", "text": json.dumps({"probe": "cc-json-schema", "risk": "low", "nonce": "CC-JSON-418", "checks": ["schema", "enum"]})}],
        "usage": {"input_tokens": 20, "output_tokens": 20},
    }
    bad_json_raw = {**ok_raw, "content": [{"type": "text", "text": "Here is the JSON: {broken"}]}
    missing_raw = {**ok_raw, "content": [{"type": "text", "text": json.dumps({"probe": "cc-json-schema", "risk": "low", "nonce": "CC-JSON-418"})}]}
    schema_raw = {**ok_raw, "content": [{"type": "text", "text": json.dumps({"probe": "cc-json-schema", "risk": "medium", "nonce": "wrong", "checks": ["schema"]})}]}

    def normalized(raw: dict[str, object]) -> dict[str, object]:
        content = raw["content"]
        text = content[0]["text"]  # type: ignore[index]
        return {"raw_response": raw, "content_text": text, "usage": raw["usage"], "error": None}

    ok_score, ok_labels = score_result(channel, case, normalized(ok_raw))
    invalid_score, invalid_labels = score_result(channel, case, normalized(bad_json_raw))
    missing_score, missing_labels = score_result(channel, case, normalized(missing_raw))
    schema_score, schema_labels = score_result(channel, case, normalized(schema_raw))

    assert ok_score == 100
    assert ok_labels == []
    assert invalid_score < 100 and "json_invalid" in invalid_labels
    assert missing_score < 100 and "json_missing:checks" in missing_labels and "json_schema_invalid" in missing_labels
    assert schema_score < 100 and "json_schema_invalid" in schema_labels


def test_claude_code_tool_use_shape_scoring_labels() -> None:
    from app.services import _claude_code_probe_configs

    config = next(item for item in _claude_code_probe_configs(None) if item["key"] == "tool_use_shape")
    channel = Channel(id="tool_probe", name="Tool Probe", provider_type="third_party_anthropic", role="candidate")
    case = TestCaseModel(
        id="tool_shape_probe",
        suite_id="manual_model_request_probe",
        module="manual_probe",
        title="ClaudeCode 检测 · tool_use 结构",
        prompt=str(config["prompt"]),
        scoring_rules=config["scoring_rules"],
    )

    valid_tool = {"type": "tool_use", "id": "toolu_01shape", "name": "cc_probe_lookup", "input": {"order_id": "CC-ORDER-204", "reason": "relay-shape-check"}}
    wrong_id_tool = {**valid_tool, "id": "call_01shape"}
    wrong_name_tool = {**valid_tool, "name": "wrong_lookup"}
    wrong_input_tool = {**valid_tool, "input": {"order_id": "CC-ORDER-204", "reason": "changed"}}

    def normalized(tool_calls: list[dict[str, object]]) -> dict[str, object]:
        return {
            "raw_response": {"type": "message", "id": "msg_01tool", "content": tool_calls, "usage": {"input_tokens": 20, "output_tokens": 8}},
            "content_text": "",
            "usage": {"input_tokens": 20, "output_tokens": 8},
            "tool_calls": tool_calls,
            "error": None,
        }

    ok_score, ok_labels = score_result(channel, case, normalized([valid_tool]))
    missing_score, missing_labels = score_result(channel, case, normalized([]))
    id_score, id_labels = score_result(channel, case, normalized([wrong_id_tool]))
    name_score, name_labels = score_result(channel, case, normalized([wrong_name_tool]))
    input_score, input_labels = score_result(channel, case, normalized([wrong_input_tool]))

    assert ok_score == 100
    assert ok_labels == []
    assert missing_score < 100 and "tool_use_invalid" in missing_labels
    assert id_score < 100 and "tool_id_mismatch" in id_labels
    assert name_score < 100 and "tool_name_mismatch" in name_labels
    assert input_score < 100 and "tool_input_mismatch" in input_labels and "tool_schema_invalid" in input_labels


def test_claude_code_repeatability_payload_flags_cache_and_cross_talk() -> None:
    from app.services import _claude_code_probe_configs, _claude_code_repeatability_payload

    config = next(item for item in _claude_code_probe_configs(None) if item["key"] == "repeatability_nonce_pair")
    nonces = config["repeatability_nonces"]
    ok_payload = _claude_code_repeatability_payload(
        config,
        [],
        [
            {"content_text": nonces[0], "provider_message_id": "msg_01a", "latency_ms": 10},
            {"content_text": nonces[1], "provider_message_id": "msg_01b", "latency_ms": 11},
        ],
        nonces,
    )
    cached_payload = _claude_code_repeatability_payload(
        config,
        [],
        [
            {"content_text": nonces[0], "provider_message_id": "msg_01a", "latency_ms": 10},
            {"content_text": nonces[0], "provider_message_id": "msg_01cached", "latency_ms": 9},
        ],
        nonces,
    )

    assert ok_payload["status"] == "pass"
    assert ok_payload["score"] == 100
    assert ok_payload["labels"] == []
    assert cached_payload["status"] == "fail"
    assert "suspected_cache" in cached_payload["labels"]
    assert "nonce_cross_talk" in cached_payload["labels"]


def test_claude_code_response_schema_flags_openai_protocol_shape() -> None:
    from app.services import _claude_code_probe_configs, _claude_code_probe_payload

    config = next(item for item in _claude_code_probe_configs(None) if item["key"] == "response_schema")
    normalized = {
        "provider_message_id": "chatcmpl_123",
        "provider_model": "gpt-4.1-mini",
        "stop_reason": "stop",
        "request_protocol": "openai_chat_completions",
        "usage": {"prompt_tokens": 20, "completion_tokens": 4},
        "content_text": "ok",
        "raw_request": {"model": "claude-code-max-200"},
        "raw_response": {
            "id": "chatcmpl_123",
            "object": "chat.completion",
            "model": "gpt-4.1-mini",
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 4},
        },
        "error": None,
    }

    payload = _claude_code_probe_payload(config, None, normalized, score=100, labels=[])

    assert payload["status"] == "fail"
    assert {
        "openai_shape_response",
        "openai_protocol_fallback",
        "model_name_mismatch",
        "message_id_openai_family",
        "stop_reason_openai_style",
        "usage_missing",
    } <= set(payload["labels"])
    assert "returned_model" in payload["evidence_excerpt"]


def test_claude_code_optional_capability_400_is_skipped() -> None:
    from app.services import _claude_code_probe_configs, _claude_code_probe_payload

    configs = {item["key"]: item for item in _claude_code_probe_configs(None)}
    image_payload = _claude_code_probe_payload(
        configs["image_url"],
        None,
        {"error": "400 Bad Request: image URL not supported by this channel", "raw_response": {"type": "error"}},
        score=0,
        labels=["request_failed"],
    )
    web_payload = _claude_code_probe_payload(
        configs["web_search_reference"],
        None,
        {"error": "400 Bad Request: unsupported tool web_search_20260318", "raw_response": {"type": "error"}},
        score=0,
        labels=["request_failed"],
    )

    assert image_payload["status"] == "skipped"
    assert "image_url_not_supported" in image_payload["labels"]
    assert "capability_not_supported" in image_payload["labels"]
    assert web_payload["status"] == "skipped"
    assert web_payload["labels"] == ["web_search_not_supported"]


def test_claude_code_web_search_reference_detects_server_tool_evidence() -> None:
    from app.services import _claude_code_probe_configs, _claude_code_probe_payload

    config = next(item for item in _claude_code_probe_configs(None) if item["key"] == "web_search_reference")
    normalized = {
        "provider_message_id": "msg_01web",
        "usage": {"input_tokens": 100, "output_tokens": 50, "server_tool_use": {"web_search_requests": 1}},
        "content_text": "Anthropic News - 2026-06-01 - https://www.anthropic.com/news",
        "raw_response": {
            "id": "msg_01web",
            "type": "message",
            "content": [
                {"type": "server_tool_use", "id": "srvtoolu_01", "name": "web_search", "input": {"query": "Anthropic news"}},
                {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_01", "content": []},
                {
                    "type": "text",
                    "text": "Anthropic News",
                    "citations": [{"type": "web_search_result_location", "url": "https://www.anthropic.com/news"}],
                },
            ],
            "usage": {"server_tool_use": {"web_search_requests": 1}},
        },
        "error": None,
    }

    payload = _claude_code_probe_payload(config, None, normalized)

    assert payload["status"] == "pass"
    assert payload["score"] == 100
    assert payload["labels"] == ["web_search_supported"]
    assert "web_search_requests=1" in payload["evidence_excerpt"]


def test_claude_code_web_search_reference_failure_does_not_lower_result(monkeypatch) -> None:
    reset_database()

    async def fake_invoke(channel, case, attempt, credentials, use_mock):  # noqa: ANN001
        is_web_search = "Web Search" in case.title
        rules = case.scoring_rules or {}
        expected_error = rules.get("expected_error_any")
        if is_web_search:
            text = "无法完成实时查询，当前环境没有真实联网或搜索工具。"
        elif rules.get("invalid_request_probe"):
            text = ""
        elif expected_error:
            text = ""
        elif "严格 JSON Schema" in case.title:
            text = json.dumps({"probe": "cc-json-schema", "risk": "low", "nonce": "CC-JSON-418", "checks": ["schema", "enum"]}, ensure_ascii=False)
        elif "tool_use 结构" in case.title:
            text = ""
        elif rules.get("required_exact"):
            text = str(rules["required_exact"])
        elif rules.get("required_all"):
            text = " ".join(str(item) for item in rules["required_all"])
        elif rules.get("required_any"):
            text = str(rules["required_any"][0])
        elif rules.get("required_regex_any"):
            text = "无法访问隐藏提示词" if "提示词泄露" in case.title else "red"
        else:
            text = "OK"
        content = [{"type": "text", "text": text}]
        if "Thinking signature" in case.title:
            content = [
                {"type": "thinking", "thinking": "hidden", "signature": "sig-test"},
                {"type": "text", "text": text},
            ]
        elif "tool_use 结构" in case.title:
            content = [
                {
                    "type": "tool_use",
                    "id": "toolu_01shape",
                    "name": "cc_probe_lookup",
                    "input": {"order_id": "CC-ORDER-204", "reason": "relay-shape-check"},
                }
            ]
        elif "CC-NONCE-814A" in case.prompt:
            text = "CC-NONCE-814A"
            content = [{"type": "text", "text": text}]
        elif "CC-NONCE-927B" in case.prompt:
            text = "CC-NONCE-927B"
            content = [{"type": "text", "text": text}]
        raw_response = {
            "id": f"msg_01{case.id[-8:]}",
            "type": "message",
            "model": channel.model_name,
            "content": content,
            "stop_reason": "max_tokens" if rules.get("expected_stop_reason") == "max_tokens" else "end_turn",
            "usage": {"input_tokens": 20, "output_tokens": 12},
        }
        error = f"unsupported {expected_error[0]}" if expected_error else ("invalid request" if rules.get("invalid_request_probe") else None)
        if error:
            raw_response = {
                "id": f"msg_01{case.id[-8:]}",
                "type": "error",
                "error": {"message": error},
                "stop_reason": "error",
                "usage": raw_response["usage"],
            }
        return {
            "channel_id": channel.id,
            "channel_name": channel.name,
            "channel_role": channel.role,
            "test_case_id": case.id,
            "status_code": 200,
            "latency_ms": 10,
            "first_token_ms": 5,
            "ttft_ms": 5,
            "tpot_ms": 1,
            "input_tokens": 20,
            "output_tokens": 12,
            "tokens_per_second": 50,
            "error_type": None,
            "provider_message_id": raw_response["id"],
            "provider_model": channel.model_name,
            "stop_reason": raw_response["stop_reason"],
            "stop_sequence": rules.get("stop_sequence"),
            "usage": raw_response["usage"],
            "content_text": text,
            "content_blocks": raw_response.get("content", []),
            "tool_calls": [block for block in raw_response.get("content", []) if isinstance(block, dict) and block.get("type") == "tool_use"],
            "stream_events": ["message_stop"],
            "raw_request": {"messages": [{"role": "user", "content": case.prompt}]},
            "raw_response": raw_response,
            "error": error,
            "request_mode": "live",
            "request_attempted": True,
            "provider_endpoint": "https://relay.example/v1/messages",
            "request_protocol": "anthropic_messages",
            "channel_preflight_failed": False,
        }

    async def fake_signature(source, relay, stream=False):  # noqa: ANN001
        return {"ok": True, "reason": "兼容"}

    monkeypatch.setattr("app.services.invoke_channel", fake_invoke)
    monkeypatch.setattr("app.services.test_signature_interop", fake_signature)

    with TestClient(app) as client:
        response = client.post("/api/channels/third_party_demo/claude-code-test", json={})

    payload = response.json()
    assert response.status_code == 200
    probe = next(item for item in payload["probes"] if item["key"] == "web_search_reference")
    assert probe["status"] == "skipped"
    assert probe["severity"] == "reference"
    assert probe["labels"] == ["web_search_not_available"]
    assert payload["score"] == 100
    assert payload["risk_level"] == "low"
    assert "Web Search 能力参考" not in payload["summary"]


def test_claude_fingerprint_classifies_plain_claude_when_optional_capabilities_unsupported() -> None:
    from app.services import _claude_code_classification, _claude_code_risk_level, _claude_code_score, _claude_code_link_score, _claude_code_summary

    probes = [
        {"key": "response_schema", "title": "响应体 message 结构", "section": "structure", "severity": "core", "status": "pass", "score": 100, "labels": [], "message_id": "msg_01plain"},
        {"key": "basic_echo", "title": "基础回显", "section": "structure", "severity": "core", "status": "pass", "score": 100, "labels": []},
        {"key": "tool_use_shape", "title": "tool_use 结构", "section": "structure", "severity": "core", "status": "pass", "score": 100, "labels": []},
        {"key": "context_ladder", "title": "上下文长度阶梯", "section": "behavior", "severity": "supporting", "status": "pass", "score": 100, "labels": []},
        {"key": "thinking_signature", "title": "Thinking signature", "section": "signature", "severity": "core", "status": "warning", "score": 0, "labels": ["signature_not_supported"], "evidence_excerpt": "400 Bad Request: thinking signature not supported"},
        {"key": "image_base64", "title": "图片输入 base64", "section": "multimodal", "severity": "core", "status": "skipped", "score": 0, "labels": ["capability_not_supported"], "evidence_excerpt": "image input not supported"},
    ]

    claude_score = _claude_code_score(probes)
    claude_code_score = _claude_code_link_score(probes)
    classification = _claude_code_classification(probes, claude_score, claude_code_score)

    assert claude_score == 100
    assert _claude_code_risk_level(claude_score, probes) == "low"
    assert classification["classification_status"] == "claude"
    assert classification["capability_flags"]["is_claude_like"] is True
    assert classification["capability_flags"]["is_claude_code_like"] is False
    assert "未要求支持 ClaudeCode" in _claude_code_summary("low", probes, classification)


def test_claude_fingerprint_classifies_claude_code_when_signature_supported() -> None:
    from app.services import _claude_code_classification, _claude_code_score, _claude_code_link_score

    probes = [
        {"key": "response_schema", "title": "响应体 message 结构", "section": "structure", "severity": "core", "status": "pass", "score": 100, "labels": [], "message_id": "msg_01code"},
        {"key": "tool_use_shape", "title": "tool_use 结构", "section": "structure", "severity": "core", "status": "pass", "score": 100, "labels": []},
        {"key": "thinking_signature", "title": "Thinking signature", "section": "signature", "severity": "core", "status": "pass", "score": 100, "labels": []},
        {"key": "signature_interop", "title": "Thinking signature 互通", "section": "signature", "severity": "supporting", "status": "pass", "score": 100, "labels": []},
    ]

    claude_score = _claude_code_score(probes)
    claude_code_score = _claude_code_link_score(probes)
    classification = _claude_code_classification(probes, claude_score, claude_code_score)

    assert classification["classification_status"] == "claude_code"
    assert classification["capability_flags"]["signature_supported"] is True
    assert classification["capability_flags"]["is_claude_code_like"] is True


def test_claude_fingerprint_classifies_openai_shape_as_non_claude() -> None:
    from app.services import _claude_code_classification, _claude_code_score

    probes = [
        {"key": "response_schema", "title": "响应体 message 结构", "section": "structure", "severity": "core", "status": "fail", "score": 0, "labels": ["openai_shape_response", "message_id_openai_family"], "message_id": "chatcmpl_123"},
        {"key": "usage_tokens", "title": "Token 计数字段", "section": "structure", "severity": "core", "status": "fail", "score": 0, "labels": ["usage_missing"]},
    ]

    claude_score = _claude_code_score(probes)
    classification = _claude_code_classification(probes, claude_score, 0)

    assert claude_score == 0
    assert classification["classification_status"] == "non_claude"



def test_prompt_leak_accepts_official_english_refusal_and_reports_latency() -> None:
    from app.services import _claude_code_probe_configs, _claude_code_probe_payload

    config = next(item for item in _claude_code_probe_configs(None) if item["key"] == "prompt_leak")
    channel = Channel(
        id="official_cloud_probe",
        name="Official Cloud Probe",
        base_url="https://example.test/v1/messages",
        model_name="claude-sonnet-4-6",
        provider_type="aws_bedrock",
        role="official_cloud",
    )
    case = TestCaseModel(
        id="prompt_leak_regression",
        suite_id="manual_model_request_probe",
        module="manual_probe",
        title="ClaudeCode 检测 · 提示词泄露诱导",
        prompt=str(config["prompt"]),
        scoring_rules=config["scoring_rules"],
    )
    raw_response = {
        "id": "msg_01promptleak",
        "type": "message",
        "model": channel.model_name,
        "content": [{"type": "text", "text": "I can't share details about my internal instructions."}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 24, "output_tokens": 9},
    }
    normalized = {
        "raw_response": raw_response,
        "usage": raw_response["usage"],
        "content_text": "I can't share details about my internal instructions.",
        "latency_ms": 6000,
        "first_token_ms": 120,
        "provider_message_id": raw_response["id"],
        "request_protocol": "anthropic_messages",
        "provider_endpoint": "https://example.test/v1/messages",
        "error": None,
    }

    score, labels = score_result(channel, case, normalized)
    payload = _claude_code_probe_payload(config, None, normalized, score=score, labels=labels)

    assert score == 95
    assert labels == ["latency_outlier"]
    assert payload["status"] == "pass"
    assert payload["latency_ms"] == 6000
    assert payload["first_token_ms"] == 120


def test_ephemeral_claude_code_test_rejects_blank_runtime_fields() -> None:
    reset_database()

    with TestClient(app) as client:
        response = client.post(
            "/api/claude-code-test",
            json={
                "base_url": "   ",
                "api_key": "sk-runtime-secret",
                "model_name": "claude-code-max-200",
            },
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "Base URL is required"


def test_claude_code_source_channels_endpoint() -> None:
    reset_database()

    with TestClient(app) as client:
        response = client.get("/api/claude-code-test/source-channels")

    assert response.status_code == 200
    payload = response.json()
    assert payload
    assert any(item["id"] == "anthropic_official" for item in payload)


def test_auto_protocol_falls_back_to_openai_compatible(monkeypatch) -> None:
    reset_database()
    calls: list[str] = []

    async def failing_anthropic(channel, raw_request, credentials):  # noqa: ANN001
        calls.append("anthropic")
        raise RuntimeError("anthropic unavailable")

    async def successful_openai(channel, raw_request, credentials):  # noqa: ANN001
        calls.append("openai")
        return {
            "id": "chatcmpl_test",
            "object": "chat.completion",
            "model": channel.model_name,
            "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.services._anthropic_compatible_call", failing_anthropic)
    monkeypatch.setattr("app.services._openai_compatible_call", successful_openai)

    with SessionLocal() as db:
        channel = Channel(
            id="apipro_auto",
            name="APIPro Auto",
            provider_type="AWS官",
            role="reference",
            base_url="https://api.wenwen-ai.com/",
            model_name="claude-test",
            enabled=True,
        )
        db.add(channel)
        db.commit()
        case = db.get(TestCaseModel, "identity_02")
        assert case is not None
        normalized = asyncio.run(invoke_channel(channel, case, 1, {"api_key": "test-key"}, use_mock=False))

    assert calls == ["anthropic", "openai"]
    assert normalized["content_text"] == "ok"
    assert normalized["request_protocol"] == "openai_chat_completions"
    assert normalized["provider_endpoint"] == "https://api.wenwen-ai.com/v1/chat/completions"


def test_auto_protocol_does_not_fallback_on_http_403(monkeypatch) -> None:
    reset_database()
    calls: list[str] = []

    class FakeResponse:
        status_code = 403

    class Http403Error(RuntimeError):
        def __init__(self, message: str) -> None:
            super().__init__(message)
            self.response = FakeResponse()

    async def forbidden_anthropic(channel, raw_request, credentials):  # noqa: ANN001
        calls.append("anthropic")
        raise Http403Error("forbidden")

    async def fallback_openai(channel, raw_request, credentials):  # noqa: ANN001
        calls.append("openai")
        return {
            "id": "chatcmpl_test",
            "object": "chat.completion",
            "model": channel.model_name,
            "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.services._anthropic_compatible_call", forbidden_anthropic)
    monkeypatch.setattr("app.services._openai_compatible_call", fallback_openai)

    with SessionLocal() as db:
        channel = Channel(
            id="apipro_403",
            name="APIPro 403",
            provider_type="AWS官",
            role="reference",
            base_url="https://api.wenwen-ai.com/",
            model_name="claude-test",
            enabled=True,
            auth_config_encrypted={"api_key": "test-key"},
        )
        db.add(channel)
        db.commit()
        case = db.get(TestCaseModel, "identity_02")
        assert case is not None
        normalized = asyncio.run(invoke_channel(channel, case, 1, {"api_key": "test-key"}, use_mock=False))

    assert calls == ["anthropic"]
    assert normalized["error"] == "403 forbidden"
    assert normalized["request_protocol"] == "anthropic_messages"
    assert normalized["request_attempted"] is True
    assert normalized["content_text"] == ""


def test_anthropic_request_passes_thinking_params(monkeypatch) -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeResponse:
        text = "{}"

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"type": "message", "content": [], "usage": {"input_tokens": 1, "output_tokens": 1}}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            return None

        async def __aenter__(self):  # noqa: ANN201
            return self

        async def __aexit__(self, *args) -> None:  # noqa: ANN002
            return None

        async def post(self, url, headers=None, json=None):  # noqa: ANN001
            captured["url"] = url
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with SessionLocal() as db:
        channel = db.get(Channel, "anthropic_official")
        case = manual_thinking_temperature_probe_case()
        assert channel is not None
        asyncio.run(_anthropic_compatible_call(channel, build_raw_request(channel, case), {"api_key": "test-key"}))

    assert captured["url"] == "https://api.anthropic.com/v1/messages"
    assert captured["json"]["temperature"] == 0.2
    assert captured["json"]["thinking"] == {"type": "enabled", "budget_tokens": 1024}
    assert "expected_error_contains" not in captured["json"]


def test_anthropic_request_passes_adaptive_enabled_thinking_probe(monkeypatch) -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeResponse:
        text = "{}"

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"type": "message", "content": [], "usage": {"input_tokens": 1, "output_tokens": 1}}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            return None

        async def __aenter__(self):  # noqa: ANN201
            return self

        async def __aexit__(self, *args) -> None:  # noqa: ANN002
            return None

        async def post(self, url, headers=None, json=None):  # noqa: ANN001
            captured["url"] = url
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with SessionLocal() as db:
        channel = db.get(Channel, "anthropic_official")
        case = manual_thinking_adaptive_enabled_probe_case()
        assert channel is not None
        case.request_params = {
            **(case.request_params or {}),
            "expected_error_required_all": ["enabled", "not supported", "output_config.effort"],
            "expected_error_variant_any": ["temperature may only be set to 1 when thinking is enabled", "temperature", "thinking"],
            "expected_error_missing_label": "thinking_adaptive_enabled_not_rejected",
            "expected_error_variant_label": "provider_error_variant",
            "expected_error_unexpected_label": "thinking_adaptive_enabled_wrong_error",
        }
        asyncio.run(_anthropic_compatible_call(channel, build_raw_request(channel, case), {"api_key": "test-key"}))

    assert captured["url"] == "https://api.anthropic.com/v1/messages"
    assert captured["json"]["max_tokens"] == 2000
    assert captured["json"]["thinking"] == {
        "type": "enabled",
        "adaptive": {"enabled": True},
        "budget_tokens": 8000,
        "max_tokens": 2000,
    }
    assert "expected_error_missing_label" not in captured["json"]
    assert "expected_error_required_all" not in captured["json"]
    assert "expected_error_variant_any" not in captured["json"]
    assert "expected_error_variant_label" not in captured["json"]
    assert "expected_error_unexpected_label" not in captured["json"]


def test_openai_request_passes_reasoning_effort_and_thinking(monkeypatch) -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeResponse:
        text = "{}"

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"object": "chat.completion", "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}], "usage": {"input_tokens": 1, "output_tokens": 1}}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            return None

        async def __aenter__(self):  # noqa: ANN201
            return self

        async def __aexit__(self, *args) -> None:  # noqa: ANN002
            return None

        async def post(self, url, headers=None, json=None):  # noqa: ANN001
            captured["url"] = url
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with SessionLocal() as db:
        channel = db.get(Channel, "openai_compat_demo")
        case = manual_thinking_temperature_probe_case()
        assert channel is not None
        asyncio.run(_openai_compatible_call(channel, build_raw_request(channel, case), {"api_key": "test-key"}))

    assert captured["url"] == "https://relay.example/v1/chat/completions"
    assert captured["json"]["temperature"] == 0.2
    assert captured["json"]["reasoning_effort"] == "medium"
    assert captured["json"]["thinking"] == {"type": "enabled", "budget_tokens": 1024}


def test_openai_request_passes_tools_and_stream(monkeypatch) -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeResponse:
        text = "{}"

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"object": "chat.completion", "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}], "usage": {"input_tokens": 1, "output_tokens": 1}}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            return None

        async def __aenter__(self):  # noqa: ANN201
            return self

        async def __aexit__(self, *args) -> None:  # noqa: ANN002
            return None

        async def post(self, url, headers=None, json=None):  # noqa: ANN001
            captured["url"] = url
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with SessionLocal() as db:
        channel = db.get(Channel, "openai_compat_demo")
        case = db.get(TestCaseModel, "websearch_01")
        assert channel is not None and case is not None
        asyncio.run(_openai_compatible_call(channel, build_raw_request(channel, case), {"api_key": "test-key"}))

    assert captured["json"]["tools"][0]["type"] == "web_search_20260318"
    assert captured["json"]["stream"] is True


def test_aws_thinking_probe_uses_raw_messages_body() -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeBody:
        def read(self) -> bytes:
            return b'{"id":"msg_bdrk_01ok","type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}'

    class FakeAwsClient:
        def invoke_model(self, **kwargs):  # noqa: ANN001, ANN201
            captured.update(kwargs)
            return {"body": FakeBody()}

    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = manual_thinking_temperature_probe_case()
        assert channel is not None
        payload = _aws_bedrock_messages_call(FakeAwsClient(), channel, case, {}, case.request_params)

    body = json.loads(captured["body"])
    assert captured["modelId"] == "anthropic.claude-sonnet-4-5-v1:0"
    assert body["anthropic_version"] == "bedrock-2023-05-31"
    assert body["temperature"] == 0.2
    assert body["thinking"] == {"type": "enabled", "budget_tokens": 1024}
    assert body["messages"][0]["content"] == "请用一句话回答：这是 thinking temperature 纯度探针。"
    assert payload["id"] == "msg_bdrk_01ok"


def test_aws_adaptive_enabled_probe_uses_raw_messages_body() -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeBody:
        def read(self) -> bytes:
            return b'{"id":"msg_bdrk_01ok","type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}'

    class FakeAwsClient:
        def invoke_model(self, **kwargs):  # noqa: ANN001, ANN201
            captured.update(kwargs)
            return {"body": FakeBody()}

    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = manual_thinking_adaptive_enabled_probe_case()
        assert channel is not None
        params = {
            **(case.request_params or {}),
            "expected_error_required_all": ["enabled", "not supported", "output_config.effort"],
            "expected_error_variant_any": ["temperature may only be set to 1 when thinking is enabled", "temperature", "thinking"],
            "expected_error_missing_label": "thinking_adaptive_enabled_not_rejected",
            "expected_error_variant_label": "provider_error_variant",
            "expected_error_unexpected_label": "thinking_adaptive_enabled_wrong_error",
        }
        payload = _aws_bedrock_messages_call(FakeAwsClient(), channel, case, {}, params)

    body = json.loads(captured["body"])
    assert captured["modelId"] == "anthropic.claude-sonnet-4-5-v1:0"
    assert body["anthropic_version"] == "bedrock-2023-05-31"
    assert body["max_tokens"] == 2000
    assert body["thinking"] == {
        "type": "enabled",
        "adaptive": {"enabled": True},
        "budget_tokens": 8000,
        "max_tokens": 2000,
    }
    assert "expected_error_missing_label" not in body
    assert "expected_error_required_all" not in body
    assert "expected_error_variant_any" not in body
    assert "expected_error_variant_label" not in body
    assert "expected_error_unexpected_label" not in body
    assert payload["id"] == "msg_bdrk_01ok"


def test_aws_multimodal_probe_uses_message_content_blocks() -> None:
    from app.services import CLAUDE_CODE_RED_PNG_BASE64

    reset_database()
    captured: dict[str, object] = {}
    image_data = CLAUDE_CODE_RED_PNG_BASE64

    class FakeBody:
        def read(self) -> bytes:
            return b'{"id":"msg_bdrk_01ok","type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}'

    class FakeAwsClient:
        def invoke_model(self, **kwargs):  # noqa: ANN001, ANN201
            captured.update(kwargs)
            return {"body": FakeBody()}

    case = TestCaseModel(
        id="manual_image_base64_probe",
        suite_id="manual_model_request_probe",
        module="manual_probe",
        title="图片输入 base64",
        prompt="请识别图片主色，只输出 red 或 红色。",
        request_params={
            "max_tokens": 64,
            "temperature": 0,
            "message_content": [
                {"type": "text", "text": "请识别图片主色，只输出 red 或 红色。"},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": image_data,
                    },
                },
            ],
        },
        scoring_rules={},
        is_hidden=False,
        enabled=True,
    )

    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        assert channel is not None
        payload = _aws_bedrock_messages_call(FakeAwsClient(), channel, case, {}, case.request_params or {})

    body = json.loads(captured["body"])
    content = body["messages"][0]["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "请识别图片主色，只输出 red 或 红色。"}
    assert content[1]["source"] == {"type": "base64", "media_type": "image/png", "data": image_data}
    assert not content[1]["source"]["data"].startswith("data:image/png;base64,")
    assert "message_content" not in body
    assert payload["id"] == "msg_bdrk_01ok"


def test_aws_multimodal_call_dispatches_to_invoke_model(monkeypatch) -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeBody:
        def read(self) -> bytes:
            return b'{"id":"msg_bdrk_01ok","type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}'

    class FakeAwsClient:
        def converse(self, **kwargs):  # noqa: ANN001, ANN201
            raise AssertionError("multimodal requests must not use text-only converse")

        def invoke_model(self, **kwargs):  # noqa: ANN001, ANN201
            captured.update(kwargs)
            return {"body": FakeBody(), "ResponseMetadata": {"RequestId": "req_aws_test"}}

        def close(self) -> None:
            captured["closed"] = True

    def fake_client(service_name, **kwargs):  # noqa: ANN001, ANN202
        captured["service_name"] = service_name
        captured["region_name"] = kwargs.get("region_name")
        return FakeAwsClient()

    monkeypatch.setattr("boto3.client", fake_client)

    case = TestCaseModel(
        id="manual_image_base64_probe",
        suite_id="manual_model_request_probe",
        module="manual_probe",
        title="图片输入 base64",
        prompt="请识别图片主色，只输出 red 或 红色。",
        request_params={
            "max_tokens": 64,
            "temperature": 0,
            "message_content": [
                {"type": "text", "text": "请识别图片主色，只输出 red 或 红色。"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "abc123"}},
            ],
        },
        scoring_rules={},
        is_hidden=False,
        enabled=True,
    )

    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        assert channel is not None
        from app import services as services_module

        payload = services_module._aws_bedrock_call(
            channel,
            case,
            {"aws_access_key_id": "ak", "aws_secret_access_key": "sk", "region": "us-west-2"},
        )

    body = json.loads(captured["body"])
    assert captured["service_name"] == "bedrock-runtime"
    assert captured["region_name"] == "us-west-2"
    assert body["messages"][0]["content"][1]["source"]["data"] == "abc123"
    assert captured["closed"] is True
    assert payload["id"] == "msg_bdrk_01ok"


def test_aws_web_search_probe_uses_raw_messages_body() -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeBody:
        def read(self) -> bytes:
            return b'{"id":"msg_bdrk_01ok","type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}'

    class FakeAwsClient:
        def invoke_model(self, **kwargs):  # noqa: ANN001, ANN201
            captured.update(kwargs)
            return {"body": FakeBody()}

    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = db.get(TestCaseModel, "websearch_01")
        assert channel is not None and case is not None
        payload = _aws_bedrock_messages_call(FakeAwsClient(), channel, case, {}, case.request_params or {})

    body = json.loads(captured["body"])
    assert body["max_tokens"] == 900
    assert body["stream"] is True
    assert body["tools"][0]["name"] == "web_search"
    assert payload["id"] == "msg_bdrk_01ok"


def test_execute_run_stops_channel_after_preflight_failure(monkeypatch) -> None:
    reset_database()
    calls: list[str] = []

    async def failing_anthropic(channel, raw_request, credentials):  # noqa: ANN001
        calls.append("anthropic")
        raise RuntimeError("anthropic unavailable")

    async def failing_openai(channel, raw_request, credentials):  # noqa: ANN001
        calls.append("openai")
        raise RuntimeError("openai unavailable")

    monkeypatch.setattr("app.services._anthropic_compatible_call", failing_anthropic)
    monkeypatch.setattr("app.services._openai_compatible_call", failing_openai)

    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        channel = Channel(
            id="apipro_failing",
            name="APIPro Failing",
            provider_type="AWS官",
            role="reference",
            base_url="https://api.wenwen-ai.com/",
            model_name="claude-test",
            auth_config_encrypted={"api_key": "test-key"},
            is_reference=True,
            enabled=True,
        )
        db.add(channel)
        db.commit()
        run = create_run(
            db,
            RunCreate(
                name="preflight failure",
                suite_id=suite_id,
                channel_ids={"reference": [channel.id]},
                repeat_count=1,
                concurrency=4,
                use_mock=False,
                mode="baseline_build",
            ),
        )
        run_id = run.id

    asyncio.run(execute_run(SessionLocal, run_id, use_mock=False))

    with SessionLocal() as db:
        run = db.get(Run, run_id)
        result_count = db.scalar(select(func.count()).select_from(Result).where(Result.run_id == run_id))
        labels = db.scalar(select(Result.labels).where(Result.run_id == run_id).limit(1))

    assert calls == ["anthropic", "openai"]
    assert run is not None
    assert run.status == "completed"
    assert result_count == run.total_jobs
    assert labels == ["channel_preflight_failed", "request_failed"]


def test_anthropic_messages_url_accepts_base_version_or_full_endpoint() -> None:
    assert _anthropic_messages_url(None) == "https://api.anthropic.com/v1/messages"
    assert _anthropic_messages_url("https://api.anthropic.com") == "https://api.anthropic.com/v1/messages"
    assert _anthropic_messages_url("https://api.anthropic.com/v1") == "https://api.anthropic.com/v1/messages"
    assert _anthropic_messages_url("https://relay.example/v1/messages") == "https://relay.example/v1/messages"
    assert _anthropic_messages_url("https://relay.example/messages") == "https://relay.example/messages"


def test_custom_reference_channel_can_build_baseline() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        created = client.post(
            "/api/channels",
            json={
                "name": "Custom Reference",
                "provider_type": "custom_provider",
                "role": "review_control",
                "model_name": "custom-model",
                "is_reference": True,
                "enabled": True,
            },
        )
        run = client.post(
            "/api/baselines/build",
            json={"name": "custom reference baseline", "suite_id": suite_id, "channel_ids": {"reference": [created.json()["id"]]}, "use_mock": True},
        )
        payload = client.get(f"/api/runs/{run.json()['id']}/results").json()

    assert created.status_code == 200
    assert created.json()["is_reference"] is True
    assert run.status_code == 200
    assert {item["role_in_run"] for item in payload["run_channels"]} == {"reference"}
    assert payload["baseline_snapshot"]["channel_ids"] == [created.json()["id"]]


def test_smart_patrol_report_counts_scheduled_run_and_alert(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = client.post(
            "/api/scheduled-tests",
            json={
                "name": "report patrol",
                "channel_id": "negative_sample",
                "interval_minutes": 60,
                "enabled": True,
            },
        ).json()
        client.post(f"/api/scheduled-tests/{schedule['id']}/run-now")
        asyncio.run(execute_scheduled_channel_test(SessionLocal, schedule["id"], advance_next_run=False))
        report = client.get("/api/scheduled-tests/report").json()
        markdown = client.get("/api/scheduled-tests/report.md")

    assert report["run_count"] >= 1
    assert report["alert_count"] >= 1
    assert report["pending_review_count"] >= 1
    assert report["channel_summaries"]
    assert report["channel_summaries"][0]["channel_provider_type"]
    assert "Negative Sample" in report["channel_summaries"][0]["channel_name"]
    assert "avg_score" not in report
    assert "grade_distribution" not in report
    assert "latest_grade" not in report["channel_summaries"][0]
    assert "latest_score" not in report["channel_summaries"][0]
    assert "avg_score" not in report["channel_summaries"][0]
    if report["trend"]:
        assert "avg_score" not in report["trend"][0]
    assert markdown.status_code == 200
    assert "智能巡检汇总报告" in markdown.text
    assert "成功 / 错误" in markdown.text
    assert "渠道巡检汇总" in markdown.text
    assert "Negative Sample-third_party_openai_compatible" in markdown.text
    assert "最近错误" in markdown.text
    assert "平均分" not in markdown.text
    assert "评级分布" not in markdown.text
    assert "分数" not in markdown.text
    assert "评级" not in markdown.text
    assert "score" not in markdown.text
    assert "grade" not in markdown.text


def test_smart_patrol_daily_text_uses_scoreless_summary(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = client.post(
            "/api/scheduled-tests",
            json={
                "name": "daily text patrol",
                "channel_id": "negative_sample",
                "interval_minutes": 60,
                "enabled": True,
            },
        ).json()
        asyncio.run(execute_scheduled_channel_test(SessionLocal, schedule["id"], advance_next_run=False))

    with SessionLocal() as db:
        setting = get_or_create_feishu_setting(db)
        report = build_smart_patrol_report(db, datetime.now(timezone.utc) - timedelta(days=1), datetime.now(timezone.utc))
        text = smart_patrol_daily_text(report, setting)

    assert "智能巡检日报" in text
    assert "自动巡检：" in text
    assert "成功" in text
    assert "错误" in text
    assert "重点渠道：" in text
    assert "Negative Sample-third_party_openai_compatible" in text
    assert "平均分" not in text
    assert "评级" not in text
    assert "分数" not in text
    assert "score" not in text
    assert "grade" not in text


def test_scheduled_alert_notification_uses_error_message(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = create_legacy_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with SessionLocal() as db:
        alert = db.scalar(select(ChannelAlert).where(ChannelAlert.run_id == run_id))
        setting = get_or_create_feishu_setting(db)
        text = feishu_text_payload(alert, db, setting)["content"]["text"] if alert else ""

    assert alert is not None
    assert "评级" not in text
    assert "得分" not in text
    assert "错误：" in text
    assert "异常标签：" in text
    assert "渠道：Negative Sample（negative_sample）" in text
    assert "模型：" in text
    assert "Request ID：" in text
    assert "Message ID：" in text
    assert "Result ID：" not in text


def test_scheduled_alert_notification_uses_stable_patrol_channel_name(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        channel_response = client.post(
            "/api/channels",
            json={
                "id": "9407-tokenflow-claude",
                "name": "9407-ogog-claude-claude",
                "provider_type": "anthropic",
                "role": "candidate",
                "model_name": "claude-sonnet-4-6",
                "auth_config": {"account_type": "claude"},
                "enabled": True,
            },
        )
        assert channel_response.status_code == 200
        schedule = create_legacy_patrol_schedule(client, channel_id="9407-tokenflow-claude")

    run_id = create_report_for_schedule(schedule, grade="E", score=20, labels=["identity_mismatch"])
    with SessionLocal() as db:
        run = db.get(Run, run_id)
        assert run is not None
        run.name = "9407-ogog-claude - 自动巡检资源"
        db.commit()

    asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))

    with SessionLocal() as db:
        alert = db.scalar(select(ChannelAlert).where(ChannelAlert.run_id == run_id))
        setting = get_or_create_feishu_setting(db)
        text = feishu_text_payload(alert, db, setting)["content"]["text"] if alert else ""

    assert alert is not None
    assert "渠道：9407-ogog-claude（9407-tokenflow-claude）" in text
    assert "任务：9407-ogog-claude - 自动巡检资源" in text
    assert "渠道：9407-ogog-claude-claude" not in text


def test_scheduled_tests_include_latest_probe_summary(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = client.post(
            "/api/scheduled-tests",
            json={
                "name": "summary patrol",
                "channel_id": "negative_sample",
                "interval_minutes": 60,
                "enabled": True,
            },
        ).json()
        client.post(f"/api/scheduled-tests/{schedule['id']}/run-now")
        asyncio.run(execute_scheduled_channel_test(SessionLocal, schedule["id"], advance_next_run=False))
        schedules = client.get("/api/scheduled-tests").json()

    payload = next(item for item in schedules if item["id"] == schedule["id"])
    summary = payload["latest_probe_summary"]
    assert payload["latest_report_id"]
    assert payload["latest_grade"]
    assert payload["latest_score"] is not None
    assert {item["key"] for item in summary["model_requests"]} == {"thinking_temperature", "web_search", "thinking_adaptive_enabled"}
    for item in summary["model_requests"]:
        assert item["channel_id"] == "negative_sample"
        assert item["channel_name"] == "Negative Sample"
        assert item["result_id"]
        assert item["completed_at"]
        assert "request_id" in item
        assert "message_id" in item
        assert "status" in item
    assert summary["model_request"]["channel_id"] == "negative_sample"
    assert summary["model_request"]["channel_name"] == "Negative Sample"
    assert summary["model_request"]["result_id"]
    assert summary["model_request"]["completed_at"]
    assert "request_id" in summary["model_request"]
    assert "message_id" in summary["model_request"]
    assert "status" in summary["signature_interop"]
    assert summary["signature_interop"]["source_channel_id"]
    assert summary["signature_interop"]["relay_channel_id"] == "negative_sample"
    assert summary["signature_interop"]["relay_channel_name"] == "Negative Sample"
    assert "source_message_id" in summary["signature_interop"]
    assert "relay_message_id" in summary["signature_interop"]
    assert summary["labels"]

    with TestClient(app) as client:
        markdown = client.get(f"/api/reports/{payload['latest_report_id']}/markdown").text
        report_markdown = client.get(f"/api/runs/{payload['last_run_id']}/report.md").text
        runs = client.get("/api/runs").json()
    run_payload = next(item for item in runs if item["id"] == payload["last_run_id"])
    assert run_payload["patrol_channel_id"] == "negative_sample"
    assert run_payload["patrol_channel_name"] == "Negative Sample"
    assert "Thinking temperature 冲突" in markdown
    assert "Web Search tool" in markdown
    assert "thinking.adaptive.enabled" in markdown
    assert "Message ID" in markdown
    assert "Request ID" in markdown
    assert "Result ID" not in markdown
    assert "时间" in markdown
    assert "Negative Sample (negative_sample)" in markdown
    assert "# Negative Sample - 自动巡检资源报告" in markdown
    assert "# Negative Sample - 自动巡检资源报告" in report_markdown
    assert "Thinking Signature 互通" in markdown


def test_scheduled_probe_classifies_expected_claude_error_as_claude_resource_without_alert(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = create_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="D", score=30, labels=["provider_error_variant", "unexpected_error_response"])
    with SessionLocal() as db:
        report = db.scalar(select(Report).where(Report.run_id == run_id))
        assert report is not None
        schedule_row = db.get(ScheduledChannelTest, schedule["id"])
        assert schedule_row is not None
        schedule_row.last_run_id = run_id
        report.evidence = {
            "labels": ["provider_error_variant", "unexpected_error_response"],
            "red_flags": [],
            "test_scope": "scheduled_probe",
            "classification_status": "claude",
            "classification_label": "Claude 资源",
            "classification_reason": "三项自动巡检探针均命中 Claude 原生参数拒绝形态，资源按 Claude 路径处理。",
            "model_request": {
                "key": "thinking_temperature",
                "title": "Thinking temperature 冲突",
                "labels": ["provider_error_variant", "unexpected_error_response"],
                "error": "temperature may only be set to 1 when thinking is enabled",
            },
            "model_requests": [
                {
                    "key": "thinking_temperature",
                    "title": "Thinking temperature 冲突",
                    "labels": ["provider_error_variant", "unexpected_error_response"],
                    "error": "temperature may only be set to 1 when thinking is enabled",
                }
            ],
            "signature_interop": {"ok": False},
        }
        db.add(schedule_row)
        db.commit()

    alerts = asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))
    with TestClient(app) as client:
        updated_schedule = client.get(f"/api/scheduled-tests/{schedule['id']}").json()
        pending_alerts = client.get("/api/alerts", params={"status": "pending_review"}).json()

    assert alerts == []
    assert updated_schedule["latest_probe_summary"]["classification_status"] == "claude"
    assert updated_schedule["latest_probe_summary"]["classification_label"] == "Claude 资源"
    assert pending_alerts == []


def test_scheduled_probe_classification_returns_claude_resource_for_expected_error_shape() -> None:
    result = scheduled_probe_classification(
        model_requests=[
            {
                "key": "thinking_temperature",
                "labels": ["provider_error_variant", "unexpected_error_response"],
                "error": "temperature may only be set to 1 when thinking is enabled",
            },
        ],
        signature_evidence={"ok": False},
        labels=["provider_error_variant", "unexpected_error_response"],
        score=72,
    )

    assert result["status"] == "claude"
    assert result["label"] == "Claude 资源"
    assert "Claude 路径" in result["reason"]


def test_scheduled_probe_classification_returns_aws_resource_for_three_parameter_unsupported_probes() -> None:
    result = scheduled_probe_classification(
        model_requests=[
            {
                "key": "thinking_temperature",
                "labels": ["provider_error_variant"],
                "error": "Client error '400 Bad Request' for url 'https://api.example.com/v1/messages'",
            },
            {
                "key": "web_search",
                "labels": ["provider_error_variant"],
                "error": "web search is not available on this channel",
            },
            {
                "key": "thinking_adaptive_enabled",
                "labels": ["provider_error_variant"],
                "error": "thinking.adaptive.enabled is not supported",
            },
        ],
        signature_evidence={"ok": True},
        labels=["provider_error_variant"],
        score=82,
    )

    assert result["status"] == "aws_resource"
    assert result["label"] == "AWS 资源"
    assert "参数不支持" in result["reason"]


def test_scheduled_probe_classification_treats_no_available_channel_as_no_verdict() -> None:
    result = scheduled_probe_classification(
        model_requests=[
            {
                "key": "thinking_temperature",
                "labels": ["provider_temporarily_unavailable"],
                "error": "Server error '503 Service Unavailable'; response body: No available channel for model claude-sonnet-4-6 under group awsp",
            },
            {
                "key": "web_search",
                "labels": ["provider_temporarily_unavailable"],
                "error": "503 Service Unavailable: No available channel for model claude-sonnet-4-6",
            },
            {
                "key": "thinking_adaptive_enabled",
                "labels": ["provider_temporarily_unavailable"],
                "error": "temporarily unavailable",
            },
        ],
        signature_evidence={"ok": True},
        labels=["provider_temporarily_unavailable"],
        score=0,
    )

    from app.services import scheduled_probe_needs_ai_judge

    assert result["status"] == "provider_temporarily_unavailable"
    assert result["label"] == "上游资源暂不可用"
    assert "本轮巡检无有效判定" in result["reason"]
    assert scheduled_probe_needs_ai_judge(
        [
            {"key": "thinking_temperature", "labels": ["provider_temporarily_unavailable"], "error": "503 Service Unavailable"},
            {"key": "web_search", "labels": ["provider_temporarily_unavailable"], "error": "No available channel"},
            {"key": "thinking_adaptive_enabled", "labels": ["provider_temporarily_unavailable"], "error": "temporarily unavailable"},
        ],
        ["provider_temporarily_unavailable"],
        result,
    ) is False


def test_scheduled_probe_classifies_partial_parameter_unsupported_as_anomaly() -> None:
    result = scheduled_probe_classification(
        model_requests=[
            {
                "key": "thinking_temperature",
                "labels": [],
                "error": "Client error '400 Bad Request' for url 'https://api.example.com/v1/messages'",
            },
            {
                "key": "web_search",
                "labels": [],
                "error": "",
            },
            {
                "key": "thinking_adaptive_enabled",
                "labels": [],
                "error": "",
            },
        ],
        signature_evidence={"ok": True},
        labels=[],
        score=82,
    )

    assert result["status"] == "anomaly"
    assert result["label"] == "来源特征不明确"


def test_scheduled_probe_classifies_all_parameter_unsupported_as_aws_resource_without_alert(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = create_patrol_schedule(client, channel_id="negative_sample")

    run_id = create_report_for_schedule(schedule, grade="A", score=98, labels=["provider_error_variant"])
    with SessionLocal() as db:
        report = db.scalar(select(Report).where(Report.run_id == run_id))
        assert report is not None
        schedule_row = db.get(ScheduledChannelTest, schedule["id"])
        assert schedule_row is not None
        schedule_row.last_run_id = run_id
        report.evidence = {
            "labels": ["provider_error_variant"],
            "red_flags": [],
            "test_scope": "scheduled_probe",
            "classification_status": "aws_resource",
            "classification_label": "AWS 资源",
            "classification_reason": "三项自动巡检探针均命中参数不支持/原生拒绝形态，资源按 AWS 路径处理。",
            "model_request": {
                "key": "thinking_temperature",
                "title": "Thinking temperature 冲突",
                "labels": ["provider_error_variant"],
                "error": "Client error '400 Bad Request' for url 'https://api.example.com/v1/messages'",
            },
            "model_requests": [
                {"key": "thinking_temperature", "title": "Thinking temperature 冲突", "labels": ["provider_error_variant"], "error": "Client error '400 Bad Request' for url 'https://api.example.com/v1/messages'"},
                {"key": "web_search", "title": "Web Search tool", "labels": ["provider_error_variant"], "error": "web search is not available on this channel"},
                {"key": "thinking_adaptive_enabled", "title": "thinking.adaptive.enabled", "labels": ["provider_error_variant"], "error": "thinking.adaptive.enabled is not supported"},
            ],
            "signature_interop": {"ok": True},
        }
        db.add(schedule_row)
        db.commit()

    alerts = asyncio.run(create_alerts_for_run(SessionLocal, run_id, schedule["id"]))
    with TestClient(app) as client:
        updated_schedule = client.get(f"/api/scheduled-tests/{schedule['id']}").json()
        pending_alerts = client.get("/api/alerts", params={"status": "pending_review"}).json()

    assert alerts == []
    assert updated_schedule["latest_probe_summary"]["classification_status"] == "aws_resource"
    assert updated_schedule["latest_probe_summary"]["classification_label"] == "AWS 资源"
    assert pending_alerts == []


def test_scheduled_probe_no_available_channel_does_not_create_alert(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = create_patrol_schedule(client, channel_id="negative_sample")

    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        run = Run(
            id="run_provider_temporarily_unavailable",
            suite_id=scheduled.suite_id,
            name="provider temporarily unavailable",
            mode="manual_probe",
            test_scope="quick",
            scheduled_test_id=scheduled.id,
            status="completed",
            repeat_count=1,
            concurrency=1,
            total_jobs=3,
            completed_jobs=3,
        )
        db.add(run)
        scheduled.last_run_id = run.id
        err = "Server error '503 Service Unavailable'; response body: No available channel for model claude-sonnet-4-6 under group awsp"
        model_payload = {
            "run": run,
            "results": [
                {"key": "thinking_temperature", "title": "Adaptive thinking 协议", "run_id": run.id, "result_id": "res_a", "labels": ["provider_temporarily_unavailable"], "score": 0, "error": err},
                {"key": "web_search", "title": "Web Search tool", "run_id": run.id, "result_id": "res_b", "labels": ["provider_temporarily_unavailable"], "score": 0, "error": err},
                {"key": "thinking_adaptive_enabled", "title": "Adaptive thinking effort", "run_id": run.id, "result_id": "res_c", "labels": ["provider_temporarily_unavailable"], "score": 0, "error": err},
            ],
        }
        report = asyncio.run(
            build_scheduled_probe_report(
                SessionLocal,
                db,
                scheduled,
                run.id,
                model_payload,
                {"ok": True, "status": "skipped", "reason": "本计划未选择 Thinking Signature 互通模块"},
            )
        )
        assert report.evidence["classification_status"] == "provider_temporarily_unavailable"
        assert report.grade == "A"
        assert report.final_score == 90

    alerts = asyncio.run(create_alerts_for_run(SessionLocal, "run_provider_temporarily_unavailable", schedule["id"]))
    with TestClient(app) as client:
        updated_schedule = client.get(f"/api/scheduled-tests/{schedule['id']}").json()
        pending_alerts = client.get("/api/alerts", params={"status": "pending_review"}).json()

    assert alerts == []
    assert updated_schedule["latest_probe_summary"]["classification_status"] == "provider_temporarily_unavailable"
    assert "本轮巡检无有效判定" in updated_schedule["latest_probe_summary"]["classification_reason"]
    assert pending_alerts == []


def test_scheduled_probe_overloaded_native_shape_triggers_ai_judge() -> None:
    result = scheduled_probe_classification(
        model_requests=[
            {
                "key": "thinking_temperature",
                "labels": ["thinking_temperature_not_rejected"],
                "message_id": "msg_bdrk_01native",
                "message_channel_type": "AWS Bedrock",
                "error": "",
            },
            {
                "key": "web_search",
                "labels": ["unexpected_error_response"],
                "message_channel_type": "未知",
                "error": "Client error '400 Bad Request'; response body: Overloaded",
            },
            {
                "key": "thinking_adaptive_enabled",
                "labels": ["provider_error_variant"],
                "message_channel_type": "未知",
                "error": "`max_tokens` must be greater than `thinking.budget_tokens`",
            },
        ],
        signature_evidence={"relay_message_channel_type": "AWS Bedrock"},
        labels=["thinking_temperature_not_rejected", "unexpected_error_response", "provider_error_variant"],
        score=0,
    )

    assert result["status"] == "aws_resource"
    assert "低置信 AWS" in result["reason"]


def test_scheduled_probe_ai_judge_saved_for_low_confidence_native_shape(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = create_patrol_schedule(client, channel_id="negative_sample")

    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        channel = db.get(Channel, "negative_sample")
        run = Run(
            id="run_ai_judge_probe",
            suite_id=scheduled.suite_id,
            name="ai judge probe",
            mode="manual_probe",
            test_scope="quick",
            scheduled_test_id=scheduled.id,
            status="completed",
            repeat_count=1,
            concurrency=1,
            total_jobs=3,
            completed_jobs=3,
        )
        db.add(run)
        scheduled.last_run_id = run.id
        model_payload = {
            "run": run,
            "results": [
                {"key": "thinking_temperature", "title": "Thinking temperature 冲突", "run_id": run.id, "result_id": "res_a", "message_id": "msg_bdrk_01native", "message_channel_type": "AWS Bedrock", "labels": ["thinking_temperature_not_rejected"], "score": 0, "error": None},
                {"key": "web_search", "title": "Web Search tool", "run_id": run.id, "result_id": "res_b", "message_channel_type": "未知", "labels": ["unexpected_error_response"], "score": 0, "error": "Client error '400 Bad Request'; response body: Overloaded"},
                {"key": "thinking_adaptive_enabled", "title": "thinking.adaptive.enabled", "run_id": run.id, "result_id": "res_c", "message_channel_type": "未知", "labels": ["provider_error_variant"], "score": 100, "error": "`max_tokens` must be greater than `thinking.budget_tokens`"},
            ],
        }
        report = asyncio.run(
            build_scheduled_probe_report(
                SessionLocal,
                db,
                scheduled,
                run.id,
                model_payload,
                {"ok": True, "status": "pass", "relay_message_channel_type": "AWS Bedrock"},
            )
        )

    assert report.evidence["ai_judge"]
    assert report.evidence["ai_judge"]["fallback"] is True
    assert "patrol_ai_reviewed" in report.evidence["labels"]
    decisive_signals = report.evidence["ai_judge"].get("decisive_signals")
    assert isinstance(decisive_signals, list) and decisive_signals
    with TestClient(app) as client:
        payload = client.get(f"/api/scheduled-tests/{schedule['id']}").json()
    assert payload["latest_probe_summary"]["ai_judge"]["classification_status"] in {"aws_resource", "claude", "anomaly"}


def test_scheduled_probe_clear_three_parameter_unsupported_does_not_trigger_ai_judge() -> None:
    result = scheduled_probe_classification(
        model_requests=[
            {"key": "thinking_temperature", "labels": ["provider_error_variant"], "error": "temperature thinking unsupported"},
            {"key": "web_search", "labels": ["provider_error_variant"], "error": "web_search unsupported"},
            {"key": "thinking_adaptive_enabled", "labels": ["provider_error_variant"], "error": "thinking.adaptive.enabled not supported"},
        ],
        signature_evidence={"ok": True},
        labels=["provider_error_variant"],
        score=95,
    )

    from app.services import scheduled_probe_needs_ai_judge

    assert result["status"] == "aws_resource"
    assert scheduled_probe_needs_ai_judge(
        [
            {"key": "thinking_temperature", "labels": ["provider_error_variant"], "error": "temperature thinking unsupported"},
            {"key": "web_search", "labels": ["provider_error_variant"], "error": "web_search unsupported"},
            {"key": "thinking_adaptive_enabled", "labels": ["provider_error_variant"], "error": "thinking.adaptive.enabled not supported"},
        ],
        ["provider_error_variant"],
        result,
    ) is False


def test_scheduled_signature_source_uses_fingerprint_source_channel(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    captured: dict[str, str] = {}

    async def fake_signature_interop(source, relay, stream=False):  # noqa: ANN001, ARG001
        captured["source_id"] = source.id
        captured["relay_id"] = relay.id
        return {
            "ok": True,
            "status": "pass",
            "reason": "兼容：relay 成功接受 source 的 thinking block signature",
            "source_channel_id": source.id,
            "relay_channel_id": relay.id,
            "source_message_id": "msg_bdrk_01source",
            "source_message_channel_type": "AWS Bedrock",
            "relay_message_id": "msg_01relay",
            "relay_message_channel_type": "Claude/Anthropic",
            "thinking_block_count": 1,
            "signature_prefixes": ["sig-source"],
            "fallback_note": "fallback note",
            "steps": [{"name": "最终判定", "status": "ok", "detail": "兼容", "excerpt": None}],
        }

    monkeypatch.setattr("app.services.test_signature_interop", fake_signature_interop)
    reset_database()
    with TestClient(app) as client:
        schedule = client.post(
            "/api/scheduled-tests",
            json={
                "name": "fingerprint source patrol",
                "channel_id": "negative_sample",
                "interval_minutes": 60,
                "enabled": True,
            },
        ).json()
    with SessionLocal() as db:
        snapshot = db.get(BaselineSnapshot, "scheduled_probe_baseline")
        assert snapshot is not None
        snapshot.channel_ids = ["aws_bedrock"]
        db.commit()

    with TestClient(app) as client:
        client.post(f"/api/scheduled-tests/{schedule['id']}/run-now")
        payload = client.get(f"/api/scheduled-tests/{schedule['id']}").json()

    signature = payload["latest_probe_summary"]["signature_interop"]
    assert captured == {"source_id": "aws_bedrock", "relay_id": "negative_sample"}
    assert signature["source_channel_id"] == "aws_bedrock"
    assert signature["source_channel_name"] == "AWS Bedrock Claude"
    assert signature["relay_channel_id"] == "negative_sample"
    assert signature["relay_channel_name"] == "Negative Sample"
    assert signature["source_message_id"] == "msg_bdrk_01source"
    assert signature["relay_message_id"] == "msg_01relay"


def test_scheduled_signature_source_missing_creates_alert(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        schedule = client.post(
            "/api/scheduled-tests",
            json={
                "name": "missing source patrol",
                "channel_id": "negative_sample",
                "interval_minutes": 60,
                "enabled": True,
            },
        ).json()
    with SessionLocal() as db:
        for channel in db.scalars(select(Channel).where(Channel.is_reference.is_(True))).all():
            channel.enabled = False
        db.commit()

    asyncio.run(execute_scheduled_channel_test(SessionLocal, schedule["id"], advance_next_run=False))

    with SessionLocal() as db:
        scheduled = db.get(ScheduledChannelTest, schedule["id"])
        assert scheduled is not None
        payload = scheduled_channel_test_read(db, scheduled)
        alerts = [channel_alert_read(db, alert) for alert in db.scalars(select(ChannelAlert).where(ChannelAlert.status == "pending_review")).all()]

    summary = payload["latest_probe_summary"]
    assert summary["signature_interop"]["status"] == "fail"
    assert "signature_source_missing" in summary["labels"]
    assert any("signature_source_missing" in (alert.get("trigger_labels") or []) for alert in alerts)


def test_scheduled_probe_request_id_and_time_are_saved_in_evidence() -> None:
    reset_database()
    with TestClient(app) as client:
        schedule = client.post(
            "/api/scheduled-tests",
            json={
                "name": "request locator patrol",
                "channel_id": "negative_sample",
                "interval_minutes": 60,
                "enabled": True,
            },
        ).json()
        asyncio.run(execute_scheduled_channel_test(SessionLocal, schedule["id"], advance_next_run=False))
        payload = client.get(f"/api/scheduled-tests/{schedule['id']}").json()

    with SessionLocal() as db:
        report = db.get(Report, payload["latest_report_id"])
        assert report is not None
        evidence = report.evidence or {}
        model_requests = evidence.get("model_requests")
        assert isinstance(model_requests, list)
        assert model_requests
        for item in model_requests:
            assert "request_id" in item
            assert item["completed_at"]
            datetime.fromisoformat(item["completed_at"])


def test_mock_response_request_id_can_be_extracted() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = db.get(Channel, "negative_sample")
        case = manual_thinking_temperature_probe_case()
        assert channel is not None
        normalized = asyncio.run(invoke_channel(channel, case, 1, {}, use_mock=True))

    assert normalized["raw_response"]["cloud_wrapper"]["request_id"] == "req_1_negative_sample"
    assert normalized["request_mode"] == "mock"
    assert normalized["request_attempted"] is False


def test_running_run_must_be_canceled_before_delete() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        run = create_run(db, RunCreate(name="running run", suite_id=suite_id, use_mock=True))
        run.status = "running"
        db.commit()
        run_id = run.id

    with TestClient(app) as client:
        blocked = client.delete(f"/api/runs/{run_id}", headers=ADMIN_HEADERS)
        canceled = client.post(f"/api/runs/{run_id}/cancel")

    assert blocked.status_code == 409
    assert canceled.status_code == 200
    assert canceled.json()["status"] == "canceled"


def test_cancel_run_is_idempotent_and_does_not_reopen_terminal_runs() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        pending = create_run(db, RunCreate(name="pending run", suite_id=suite_id, use_mock=True))
        completed = create_run(db, RunCreate(name="completed run", suite_id=suite_id, use_mock=True))
        completed.status = "completed"
        db.commit()
        pending_id = pending.id
        completed_id = completed.id

    with TestClient(app) as client:
        first_cancel = client.post(f"/api/runs/{pending_id}/cancel")
        second_cancel = client.post(f"/api/runs/{pending_id}/cancel")
        completed_cancel = client.post(f"/api/runs/{completed_id}/cancel")

    assert first_cancel.status_code == 200
    assert first_cancel.json()["status"] == "canceled"
    assert second_cancel.status_code == 200
    assert second_cancel.json()["status"] == "canceled"
    assert completed_cancel.status_code == 200
    assert completed_cancel.json()["status"] == "completed"

    with SessionLocal() as db:
        pending = db.get(Run, pending_id)
        completed = db.get(Run, completed_id)

    assert pending is not None
    assert pending.status == "canceled"
    assert pending.finished_at is not None
    assert completed is not None
    assert completed.status == "completed"


def test_system_usage_reports_cleanup_counts() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        completed = create_run(db, RunCreate(name="completed usage run", suite_id=suite_id, use_mock=True))
        running = create_run(db, RunCreate(name="running usage run", suite_id=suite_id, use_mock=True))
        completed.status = "completed"
        running.status = "running"
        db.commit()

    with TestClient(app) as client:
        response = client.get("/api/system/usage", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    payload = response.json()
    assert payload["disk_total_bytes"] > 0
    assert payload["disk_free_bytes"] >= 0
    assert payload["run_count"] >= 2
    assert payload["cleanup_candidate_run_count"] >= 1
    assert "memory_total_bytes" in payload


def test_cleanup_run_logs_dry_run_does_not_delete_data() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        run = create_run(db, RunCreate(name="dry cleanup run", suite_id=suite_id, use_mock=True))
        run.status = "completed"
        db.add(Result(id="dry_res", run_id=run.id, test_case_id="case_builtin_math_json", channel_id="third_party_demo", attempt_index=1, score=100))
        db.commit()
        run_id = run.id

    with TestClient(app) as client:
        response = client.post("/api/system/cleanup-run-logs?dry_run=true", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    payload = response.json()
    assert payload["dry_run"] is True
    assert payload["deleted_runs"] >= 1
    with SessionLocal() as db:
        assert db.get(Run, run_id) is not None
        assert db.get(Result, "dry_res") is not None


def test_cleanup_run_logs_dry_run_falls_back_when_summary_fails(monkeypatch) -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        run = create_run(db, RunCreate(name="dry cleanup fallback run", suite_id=suite_id, use_mock=True))
        run.status = "completed"
        db.commit()

    def fail_count(*_args, **_kwargs):  # noqa: ANN002, ANN003
        raise RuntimeError("count failed")

    monkeypatch.setattr("app.routers.system._cleanup_candidate_run_ids", fail_count)

    with TestClient(app) as client:
        response = client.post("/api/system/cleanup-run-logs?dry_run=true", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    payload = response.json()
    assert payload["dry_run"] is True
    assert payload["deleted_runs"] == 0


def test_cleanup_run_logs_removes_terminal_run_logs_and_keeps_configs() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        run = create_run(db, RunCreate(name="cleanup terminal run", suite_id=suite_id, use_mock=True))
        run.status = "completed"
        db.add(Result(id="cleanup_res", run_id=run.id, test_case_id="case_builtin_math_json", channel_id="third_party_demo", attempt_index=1, score=100))
        db.add(Comparison(id="cleanup_cmp", run_id=run.id, test_case_id="case_builtin_math_json", candidate_channel_id="third_party_demo", final_score=80))
        db.add(Report(id="cleanup_rep", run_id=run.id, channel_id="third_party_demo", final_score=80, grade="C"))
        db.add(ChannelAlert(id="cleanup_alert", run_id=run.id, report_id="cleanup_rep", channel_id="third_party_demo", grade="C"))
        schedule = ScheduledChannelTest(
            id="cleanup_schedule",
            channel_id="third_party_demo",
            suite_id=suite_id,
            baseline_snapshot_id="missing_baseline_for_cleanup_test",
            name="cleanup schedule",
            last_run_id=run.id,
        )
        db.add(schedule)
        db.commit()
        run_id = run.id

    with TestClient(app) as client:
        response = client.post("/api/system/cleanup-run-logs", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    payload = response.json()
    assert payload["deleted_runs"] >= 1
    assert payload["deleted_results"] >= 1
    assert payload["deleted_reports"] >= 1
    assert payload["deleted_alerts"] >= 1
    assert payload["cleared_scheduled_last_run_refs"] >= 1
    with SessionLocal() as db:
        assert db.get(Run, run_id) is None
        assert db.get(Result, "cleanup_res") is None
        assert db.get(Report, "cleanup_rep") is None
        schedule = db.get(ScheduledChannelTest, "cleanup_schedule")
        assert schedule is not None
        assert schedule.last_run_id is None
        assert db.get(Channel, "third_party_demo") is not None


def test_cleanup_run_logs_repairs_scheduled_last_run_to_remaining_history() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        kept = Run(
            id="cleanup_kept_active_run",
            suite_id=suite_id,
            name="kept running patrol run",
            mode="candidate_eval",
            test_scope="scheduled_probe",
            status="running",
            repeat_count=1,
            concurrency=1,
            total_jobs=1,
            completed_jobs=0,
        )
        deleted = Run(
            id="cleanup_deleted_terminal_run",
            suite_id=suite_id,
            name="deleted cleanup patrol run",
            mode="candidate_eval",
            test_scope="scheduled_probe",
            status="completed",
            repeat_count=1,
            concurrency=1,
            total_jobs=1,
            completed_jobs=1,
        )
        schedule = ScheduledChannelTest(
            id="cleanup_keep_history_schedule",
            channel_id="third_party_demo",
            suite_id=suite_id,
            baseline_snapshot_id="missing_baseline_for_cleanup_history_test",
            name="cleanup keep history schedule",
            last_run_id=deleted.id,
        )
        kept.scheduled_test_id = schedule.id
        deleted.scheduled_test_id = schedule.id
        db.add(kept)
        db.add(deleted)
        db.add(schedule)
        db.commit()
        kept_id = kept.id
        deleted_id = deleted.id

    with TestClient(app) as client:
        response = client.post("/api/system/cleanup-run-logs", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    with SessionLocal() as db:
        schedule = db.get(ScheduledChannelTest, "cleanup_keep_history_schedule")
        assert schedule is not None
        assert schedule.last_run_id == kept_id
        assert db.get(Run, kept_id) is not None
        assert db.get(Run, deleted_id) is None


def test_cleanup_run_logs_skips_running_and_baseline_source_runs() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        running = create_run(db, RunCreate(name="skip running run", suite_id=suite_id, use_mock=True))
        baseline_source = create_run(db, RunCreate(name="skip baseline source", suite_id=suite_id, use_mock=True))
        running.status = "running"
        baseline_source.status = "completed"
        db.add(
            BaselineSnapshot(
                id="cleanup_baseline",
                name="cleanup baseline",
                suite_id=suite_id,
                source_run_id=baseline_source.id,
                status="ready",
            )
        )
        db.commit()
        running_id = running.id
        baseline_run_id = baseline_source.id

    with TestClient(app) as client:
        response = client.post("/api/system/cleanup-run-logs", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    payload = response.json()
    assert payload["skipped_running_runs"] >= 1
    assert payload["skipped_baseline_runs"] >= 1
    with SessionLocal() as db:
        assert db.get(Run, running_id) is not None
        assert db.get(Run, baseline_run_id) is not None
        assert db.get(BaselineSnapshot, "cleanup_baseline") is not None


def test_execute_run_stops_remaining_jobs_when_canceled(monkeypatch) -> None:
    reset_database()

    async def scenario() -> str:
        started = asyncio.Event()
        started_count = 0

        async def slow_invoke(channel, case, attempt, credentials, use_mock):  # noqa: ANN001
            nonlocal started_count
            started_count += 1
            started.set()
            await asyncio.sleep(30)
            return {"content_text": "late response", "raw_request": {}, "raw_response": {}, "latency_ms": 1, "first_token_ms": 1}

        monkeypatch.setattr("app.services.invoke_channel", slow_invoke)

        with SessionLocal() as db:
            suite_id = db.scalar(select(TestSuiteModel.id))
            run = create_run(
                db,
                RunCreate(
                    name="cancelable run",
                    suite_id=suite_id,
                    channel_ids={"gold": ["anthropic_official"], "candidate": ["third_party_demo"]},
                    repeat_count=2,
                    concurrency=2,
                    use_mock=True,
                ),
            )
            run_id = run.id

        task = asyncio.create_task(execute_run(SessionLocal, run_id, use_mock=True))
        await asyncio.wait_for(started.wait(), timeout=2)

        with SessionLocal() as db:
            run = db.get(Run, run_id)
            assert run is not None
            assert run.status == "running"
            run.status = "canceled"
            db.commit()

        await asyncio.wait_for(task, timeout=3)

        with SessionLocal() as db:
            run = db.get(Run, run_id)
            result_count = db.scalar(select(func.count()).select_from(Result).where(Result.run_id == run_id))
            report_count = db.scalar(select(func.count()).select_from(Report).where(Report.run_id == run_id))

        assert started_count <= 2
        assert run is not None
        assert run.status == "canceled"
        assert run.finished_at is not None
        assert run.completed_jobs < run.total_jobs
        assert result_count == 0
        assert report_count == 0
        return run_id

    asyncio.run(scenario())


def test_arena_run_reports_progress_and_completes_all_jobs(monkeypatch) -> None:
    reset_database()

    async def scenario() -> str:
        call_count = 0

        async def live_like_invoke(channel, case, attempt, credentials, use_mock):  # noqa: ANN001
            nonlocal call_count
            call_count += 1
            await asyncio.sleep(0.01)
            return {
                "content_text": f"{channel.name}:{case.id}:{attempt}",
                "raw_request": {},
                "raw_response": {},
                "latency_ms": 10,
                "first_token_ms": 5,
            }

        monkeypatch.setattr("app.services.invoke_channel", live_like_invoke)

        with SessionLocal() as db:
            suite_id = db.scalar(select(TestSuiteModel.id))
            run = create_run(
                db,
                RunCreate(
                    name="arena progress run",
                    suite_id=suite_id,
                    channel_ids={"candidate": ["third_party_demo", "negative_sample"]},
                    repeat_count=1,
                    concurrency=2,
                    mode="arena_comparison",
                    test_scope="quick",
                    use_mock=False,
                ),
            )
            run_id = run.id

        await asyncio.wait_for(execute_run(SessionLocal, run_id, use_mock=False, arena_config={"judge_mode": "direct_score"}), timeout=10)

        with SessionLocal() as db:
            run = db.get(Run, run_id)
            result_count = db.scalar(select(func.count()).select_from(Result).where(Result.run_id == run_id))
            summary = db.execute(select(Run.completed_jobs, Run.total_jobs).where(Run.id == run_id)).one()

        assert call_count > 0
        assert run is not None
        assert run.status == "completed"
        assert run.finished_at is not None
        assert run.completed_jobs == run.total_jobs
        assert summary.completed_jobs == summary.total_jobs
        assert result_count == run.total_jobs
        return run_id

    asyncio.run(scenario())


def test_run_create_rejects_out_of_range_repeat_count_and_concurrency() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        low_repeat = client.post("/api/runs", json={"name": "bad", "suite_id": suite_id, "repeat_count": 0, "use_mock": True})
        high_repeat = client.post("/api/runs", json={"name": "bad", "suite_id": suite_id, "repeat_count": 6, "use_mock": True})
        low_concurrency = client.post("/api/runs", json={"name": "bad", "suite_id": suite_id, "concurrency": 0, "use_mock": True})
        high_concurrency = client.post("/api/runs", json={"name": "bad", "suite_id": suite_id, "concurrency": 17, "use_mock": True})

    assert low_repeat.status_code == 422
    assert high_repeat.status_code == 422
    assert low_concurrency.status_code == 422
    assert high_concurrency.status_code == 422


def test_baseline_build_rejects_out_of_range_repeat_count_and_concurrency() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        low_repeat = client.post("/api/baselines/build", json={"name": "bad", "suite_id": suite_id, "repeat_count": 0, "use_mock": True})
        high_concurrency = client.post("/api/baselines/build", json={"name": "bad", "suite_id": suite_id, "concurrency": 17, "use_mock": True})

    assert low_repeat.status_code == 422
    assert high_concurrency.status_code == 422


def test_cors_origins_are_read_from_environment() -> None:
    os.environ["CORS_ORIGINS"] = "http://localhost:5173, https://example.com "
    assert cors_origins() == ["http://localhost:5173", "https://example.com"]


def test_rate_limit_defaults_accept_invalid_configuration(monkeypatch) -> None:
    from app import main as main_module

    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "not-a-number")
    assert main_module._rate_limit_per_minute() == 100


def test_merged_channel_credentials_uses_stored_key_and_allows_runtime_override() -> None:
    channel = Channel(
        id="credential_merge",
        name="Credential Merge",
        provider_type="third_party_anthropic",
        role="candidate",
        auth_config_encrypted={"api_key": "stored-key", "request_protocol": "auto"},
        is_reference=False,
        enabled=True,
    )

    assert _merged_channel_credentials(channel, {}) == {"api_key": "stored-key", "request_protocol": "auto"}
    assert _merged_channel_credentials(channel, {"api_key": "runtime-key"}) == {"api_key": "runtime-key", "request_protocol": "auto"}


def test_start_claude_code_relay_job_returns_job_id() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.post(
            "/api/claude-code-test/jobs",
            json={
                "base_url": "https://relay.example/v1",
                "api_key": "sk-test",
                "model_name": "claude-sonnet-4-5",
                "provider_type": "third_party_anthropic",
                "request_protocol": "auto",
                "source_channel_id": None,
                "image_url": None,
                "include_expensive_context": False,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["job_id"]
    assert payload["status"] == "queued"


def test_get_missing_claude_code_relay_job_returns_404() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.get("/api/claude-code-test/jobs/missing_job")

    assert response.status_code == 404
    assert "服务重启" in response.json()["detail"]
    assert "过期" in response.json()["detail"]


def test_in_memory_job_store_cleans_finished_jobs_after_ttl() -> None:
    store = InMemoryJobStore(ttl=timedelta(seconds=1))
    store.set(
        "old_job",
        {
            "job_id": "old_job",
            "status": "completed",
            "started_at": datetime.now(timezone.utc) - timedelta(minutes=5),
            "updated_at": datetime.now(timezone.utc) - timedelta(minutes=5),
            "finished_at": datetime.now(timezone.utc) - timedelta(minutes=5),
            "total_count": 1,
        },
    )

    assert store.get("old_job") is None


def test_start_claude_code_cli_job_returns_job_id() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.post(
            "/api/claude-code-check/jobs",
            json={"model": "sonnet", "timeout_seconds": 180, "max_budget_usd": 0.25},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["job_id"]
    assert payload["status"] == "queued"


def test_claude_code_multimodal_probe_payload_includes_input_preview() -> None:
    import base64

    from app.services import CLAUDE_CODE_RED_PNG_BASE64, _claude_code_probe_configs, _claude_code_probe_payload

    configs = _claude_code_probe_configs(None, False)
    image_base64 = next(item for item in configs if item["key"] == "image_base64")
    image_url = next(item for item in configs if item["key"] == "image_url")
    document_input = next(item for item in configs if item["key"] == "document_input")

    image_base64_payload = _claude_code_probe_payload(image_base64, None, {"content_text": "red"})
    image_url_payload = _claude_code_probe_payload(image_url, None, {"content_text": "red"})
    document_payload = _claude_code_probe_payload(document_input, None, {"content_text": "CC-DOC-742"})

    assert image_base64_payload["input_preview"]["kind"] == "image_base64"
    assert image_base64_payload["input_preview"]["image_data_url"].startswith("data:image/png;base64,")
    raw_png = base64.b64decode(CLAUDE_CODE_RED_PNG_BASE64)
    assert raw_png.startswith(b"\x89PNG\r\n\x1a\n")
    assert int.from_bytes(raw_png[16:20], "big") == 64
    assert int.from_bytes(raw_png[20:24], "big") == 64
    assert image_url_payload["input_preview"]["kind"] == "image_url"
    assert image_url_payload["input_preview"]["default_image_url"]
    assert image_url_payload["input_preview"]["actual_image_url"]
    assert document_payload["input_preview"]["kind"] == "document_text"
    assert document_payload["input_preview"]["document_marker"] == "CC-DOC-742"


def test_claude_code_history_list_and_missing_detail() -> None:
    reset_database()
    with TestClient(app) as client:
        listed = client.get("/api/claude-code-history")
        missing = client.get("/api/claude-code-history/missing_item")

    assert listed.status_code == 200
    assert isinstance(listed.json(), list)
    assert missing.status_code == 404


def test_new_api_sync_preview_filters_claude_channels(monkeypatch) -> None:
    reset_database()

    async def fake_fetch(data):  # noqa: ANN001
        return "https://new-api.example", [
            {"id": 101, "name": "Claude Sonnet", "type": 14, "status": 1, "models": "claude-sonnet-4-5"},
            {"id": 202, "name": "GPT", "type": 1, "status": 1, "models": "gpt-4o"},
        ]

    monkeypatch.setattr("app.routers.new_api._fetch_new_api_channels", fake_fetch)
    with TestClient(app) as client:
        response = client.post(
            "/api/integrations/new-api/preview",
            headers=ADMIN_HEADERS,
            json={
                "base_url": "https://new-api.example",
                "admin_access_token": "admin-token",
                "relay_token": "sk-relay-token",
            },
        )
    assert response.status_code == 200
    payload = response.json()
    assert payload["total_remote"] == 2
    assert payload["matched"] == 1
    assert payload["create_count"] == 1
    assert payload["skip_count"] == 1
    assert payload["items"][0]["new_api_channel_id"] == "101"
    assert payload["items"][0]["model_name"] == "claude-sonnet-4-5"




def test_new_api_sync_matches_claude_group_and_name_without_model_hit(monkeypatch) -> None:
    reset_database()

    async def fake_fetch(data):  # noqa: ANN001
        return "https://new-api.example", [
            {"id": 301, "name": "azure resource", "group": "azure-claude", "type": 1, "status": 1, "models": "gpt-4o"},
            {"id": 302, "name": "claude-code relay", "group": "tooling", "type": 1, "status": 1, "models": "sonnet-latest"},
            {"id": 303, "name": "kimi only", "group": "kimi", "type": 1, "status": 1, "models": "kimi-k2"},
        ]

    monkeypatch.setattr("app.routers.new_api._fetch_new_api_channels", fake_fetch)
    with TestClient(app) as client:
        response = client.post(
            "/api/integrations/new-api/preview",
            headers=ADMIN_HEADERS,
            json={
                "base_url": "https://new-api.example",
                "admin_access_token": "admin-token",
                "relay_token": "sk-relay-token",
                "model_keyword": "claude,anthropic",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    ids = {item["new_api_channel_id"] for item in payload["items"]}
    assert ids == {"301", "302"}
    by_id = {item["new_api_channel_id"]: item for item in payload["items"]}
    assert by_id["301"]["group"] == "azure-claude"
    assert "group" in by_id["301"]["reason"]
    assert "name" in by_id["302"]["reason"]


def test_new_api_fetch_does_not_send_model_filter_and_supports_multiple_groups(monkeypatch) -> None:
    reset_database()
    calls: list[dict[str, object]] = []

    class FakeResponse:
        def __init__(self, payload):  # noqa: ANN001
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self):  # noqa: ANN001
            return self._payload

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN001
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN001
            return None

        async def get(self, url, params, headers):  # noqa: ANN001
            calls.append(dict(params))
            group = params.get("group")
            remote_id = 401 if group == "azure-claude" else 402
            return FakeResponse({"data": {"total": 1, "items": [{"id": remote_id, "name": str(group), "group": group, "models": "sonnet"}]}})

    monkeypatch.setattr("app.routers.new_api.httpx.AsyncClient", FakeClient)
    with TestClient(app) as client:
        response = client.post(
            "/api/integrations/new-api/preview",
            headers=ADMIN_HEADERS,
            json={
                "base_url": "https://new-api.example",
                "admin_access_token": "admin-token",
                "relay_token": "sk-relay-token",
                "group": "azure-claude, vertex-claude",
                "model_keyword": "claude",
            },
        )

    assert response.status_code == 200
    assert [call.get("group") for call in calls] == ["azure-claude", "vertex-claude"]
    assert all("model" not in call for call in calls)
    assert response.json()["matched"] == 2


def test_new_api_fetch_searches_keywords_groups_types_and_full_list(monkeypatch) -> None:
    reset_database()
    calls: list[tuple[str, dict[str, object]]] = []

    class FakeResponse:
        def __init__(self, payload):  # noqa: ANN001
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self):  # noqa: ANN001
            return self._payload

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN001
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN001
            return None

        async def get(self, url, params, headers):  # noqa: ANN001
            calls.append((url, dict(params)))
            if url.endswith("/api/channel/search") and params.get("keyword") == "claude" and not params.get("tag_mode"):
                return FakeResponse({"data": {"total": 1, "items": [{"id": 501, "name": "claude by name", "group": "default", "models": "sonnet"}]}})
            if url.endswith("/api/channel/search") and params.get("model") == "claude":
                return FakeResponse({"data": {"total": 1, "items": [{"id": 502, "name": "model hit", "group": "default", "models": "claude-sonnet-4-5"}]}})
            if url.endswith("/api/channel/search") and params.get("group") == "azure-claude":
                return FakeResponse({"data": {"total": 1, "items": [{"id": 503, "name": "azure group", "type": 3, "group": "azure-claude", "models": "sonnet-latest"}]}})
            if url.endswith("/api/channel/") and params.get("type") == 14:
                return FakeResponse({"data": {"total": 1, "items": [{"id": 504, "name": "anthropic type", "type": 14, "group": "default", "models": "sonnet-latest"}]}})
            if url.endswith("/api/channel/") and "type" not in params:
                return FakeResponse({"data": {"total": 1, "rows": [{"id": 505, "name": "remark alias", "type": 1, "group": "default", "models": "sonnet", "remark": "private claude"}]}})
            return FakeResponse({"data": {"total": 0, "items": []}})

    monkeypatch.setattr("app.routers.new_api.httpx.AsyncClient", FakeClient)
    with TestClient(app) as client:
        response = client.post(
            "/api/integrations/new-api/preview",
            headers=ADMIN_HEADERS,
            json={
                "base_url": "https://new-api.example",
                "admin_access_token": "admin-token",
                "relay_token": "sk-relay-token",
                "model_keyword": "claude",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    ids = {item["new_api_channel_id"] for item in payload["items"]}
    assert {"501", "502", "503", "504", "505"}.issubset(ids)
    assert any(url.endswith("/api/channel/search") and call.get("keyword") == "claude" for url, call in calls)
    assert any(url.endswith("/api/channel/search") and call.get("model") == "claude" for url, call in calls)
    assert any(url.endswith("/api/channel/search") and call.get("group") == "azure-claude" for url, call in calls)
    assert any(url.endswith("/api/channel/") and call.get("type") == 14 for url, call in calls)
    assert any(url.endswith("/api/channel/") and "type" not in call and "group" not in call for url, call in calls)


def test_new_api_sync_reports_remote_status_and_provider_type(monkeypatch) -> None:
    reset_database()

    async def fake_fetch(data):  # noqa: ANN001
        return "https://new-api.example", [
            {"id": 601, "name": "vertex claude", "type": 41, "status": 2, "group": "vertex-claude", "models": "claude-sonnet"},
            {"id": 602, "name": "azure claude", "type": 3, "status": 1, "group": "azure-claude", "models": "claude-sonnet"},
        ]

    monkeypatch.setattr("app.routers.new_api._fetch_new_api_channels", fake_fetch)
    with TestClient(app) as client:
        response = client.post(
            "/api/integrations/new-api/preview",
            headers=ADMIN_HEADERS,
            json={
                "base_url": "https://new-api.example",
                "admin_access_token": "admin-token",
                "relay_token": "sk-relay-token",
                "status": "all",
            },
        )

    assert response.status_code == 200
    by_id = {item["new_api_channel_id"]: item for item in response.json()["items"]}
    assert by_id["601"]["provider_type"] == "new_api_vertex_relay"
    assert by_id["601"]["remote_type"] == 41
    assert by_id["601"]["remote_status"] == 2
    assert by_id["601"]["remote_enabled"] is False
    assert by_id["602"]["provider_type"] == "new_api_azure_relay"


def test_new_api_sync_expands_one_remote_channel_to_all_claude_models(monkeypatch) -> None:
    reset_database()

    async def fake_fetch(data):  # noqa: ANN001
        return "https://new-api.example", [
            {
                "id": 701,
                "name": "风雨-claude-awsp",
                "type": 33,
                "status": 1,
                "group": "aws_cache,aws_mix,aws-platform,claude,mix-claude,zhongbo",
                "models": "claude-3-7-sonnet,claude-sonnet-4-5,claude-opus-4-1,gpt-4o",
            },
        ]

    monkeypatch.setattr("app.routers.new_api._fetch_new_api_channels", fake_fetch)
    with TestClient(app) as client:
        response = client.post(
            "/api/integrations/new-api/apply",
            headers=ADMIN_HEADERS,
            json={
                "base_url": "https://new-api.example",
                "admin_access_token": "admin-token",
                "relay_token": "sk-relay-token",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    models = {item["model_name"] for item in payload["items"]}
    assert models == {"claude-3-7-sonnet", "claude-sonnet-4-5", "claude-opus-4-1"}
    assert payload["matched"] == 1
    assert payload["matched_models"] == 3
    assert payload["create_count"] == 3
    assert payload["schedule_create_count"] == 3
    assert all(item["new_api_channel_id"] == "701" for item in payload["items"])
    assert all(len(item["remote_models"]) == 3 for item in payload["items"])
    channel_ids = {item["channel_id"] for item in payload["items"]}
    assert len(channel_ids) == 3
    with SessionLocal() as db:
        channels = [db.get(Channel, channel_id) for channel_id in channel_ids]
        assert all(channel is not None for channel in channels)
        assert {channel.model_name for channel in channels if channel} == models
        assert {channel.auth_config["api_key"] for channel in channels if channel} == {"sk-relay-token-701"}
        assert {channel.auth_config["new_api_channel_id"] for channel in channels if channel} == {"701"}
        schedules = db.scalars(select(ScheduledChannelTest).where(ScheduledChannelTest.channel_id.in_(channel_ids))).all()
        assert len(schedules) == 3


def test_new_api_sync_reads_model_mapping_keys_as_request_models(monkeypatch) -> None:
    reset_database()

    async def fake_fetch(data):  # noqa: ANN001
        return "https://new-api.example", [
            {
                "id": 702,
                "name": "mapped claude",
                "type": 14,
                "status": 1,
                "models": "",
                "model_mapping": '{"claude-sonnet-4-5":"anthropic.claude-sonnet-4-5-v1:0","claude-opus-4-1":"anthropic.claude-opus-4-1-v1:0"}',
            },
        ]

    monkeypatch.setattr("app.routers.new_api._fetch_new_api_channels", fake_fetch)
    with TestClient(app) as client:
        response = client.post(
            "/api/integrations/new-api/preview",
            headers=ADMIN_HEADERS,
            json={
                "base_url": "https://new-api.example",
                "admin_access_token": "admin-token",
                "relay_token": "sk-relay-token",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert {item["model_name"] for item in payload["items"]} == {"claude-sonnet-4-5", "claude-opus-4-1"}
    assert payload["matched_models"] == 2


def test_new_api_sync_apply_creates_channel_and_schedule(monkeypatch) -> None:
    reset_database()

    async def fake_fetch(data):  # noqa: ANN001
        return "https://new-api.example", [
            {"id": 9335, "name": "阿宝-aws", "type": 33, "status": 1, "models": "claude-sonnet-4-5"},
        ]

    monkeypatch.setattr("app.routers.new_api._fetch_new_api_channels", fake_fetch)
    with TestClient(app) as client:
        response = client.post(
            "/api/integrations/new-api/apply",
            headers=ADMIN_HEADERS,
            json={
                "base_url": "https://new-api.example",
                "admin_access_token": "admin-token",
                "relay_token": "sk-relay-token",
                "default_interval_minutes": 60,
            },
        )
    assert response.status_code == 200
    payload = response.json()
    channel_id = payload["items"][0]["channel_id"]
    assert payload["create_count"] == 1
    assert payload["schedule_create_count"] == 1
    with SessionLocal() as db:
        channel = db.get(Channel, channel_id)
        assert channel is not None
        assert channel.provider_type == "new_api_aws_relay"
        assert channel.base_url == "https://new-api.example"
        assert channel.model_name == "claude-sonnet-4-5"
        assert channel.auth_config["api_key"] == "sk-relay-token-9335"
        assert channel.auth_config["request_protocol"] == "anthropic_messages"
        schedule = db.scalar(select(ScheduledChannelTest).where(ScheduledChannelTest.channel_id == channel_id))
        assert schedule is not None
        assert schedule.test_scope == "scheduled_probe"
        assert schedule.interval_minutes == 60

    with TestClient(app) as client:
        response = client.post(
            "/api/integrations/new-api/apply",
            headers=ADMIN_HEADERS,
            json={
                "base_url": "https://new-api.example",
                "admin_access_token": "admin-token",
                "relay_token": "sk-relay-token",
                "default_interval_minutes": 60,
            },
        )
    assert response.status_code == 200
    payload = response.json()
    assert payload["update_count"] == 1
    assert payload["schedule_exists_count"] == 1


def test_full_model_check_returns_structured_metrics_for_missing_key() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = Channel(
            id="full_model_ch",
            name="Full Model Channel",
            provider_type="third_party_anthropic",
            role="candidate",
            base_url="https://relay.example",
            model_name="claude-sonnet-4-5",
            auth_config={"request_protocol": "anthropic_messages"},
            enabled=True,
        )
        db.add(channel)
        db.commit()

    with TestClient(app) as client:
        response = client.post(
            "/api/full-model-check",
            json={
                "channel_ids": ["full_model_ch"],
                "repeat_count": 1,
                "include_stream": True,
                "include_tools": True,
                "include_params": True,
                "include_error_probe": True,
                "include_thinking": True,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["channels"][0]["protocol_family"] == "anthropic_messages"
    assert payload["channels"][0]["total_probes"] >= 7
    first_probe = payload["channels"][0]["probes"][0]
    assert first_probe["status"] == "fail"
    assert first_probe["error_excerpt"]
    assert "api" in first_probe["error_excerpt"].lower() or "key" in first_probe["error_excerpt"].lower()
    assert "latency_ms" in payload["channels"][0]
    assert "ttft_ms" in payload["channels"][0]
    assert "tokens_per_second" in payload["channels"][0]


def test_full_model_check_rejects_missing_channel() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.post("/api/full-model-check", json={"channel_ids": ["missing"]})

    assert response.status_code == 400
    assert "Channel not found" in response.json()["detail"]


def test_full_model_check_supports_gemini_protocol(monkeypatch) -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeResponse:
        status_code = 200
        text = "{}"
        headers = {"x-goog-request-id": "goog_req_full"}

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "responseId": "gem_resp_1",
                "modelVersion": "gemini-2.0-flash",
                "candidates": [
                    {
                        "content": {"parts": [{"text": "OK"}]},
                        "finishReason": "STOP",
                    }
                ],
                "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 1, "totalTokenCount": 4},
            }

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            return None

        async def __aenter__(self):  # noqa: ANN201
            return self

        async def __aexit__(self, *args) -> None:  # noqa: ANN002
            return None

        async def post(self, url, headers=None, json=None):  # noqa: ANN001
            captured.setdefault("urls", []).append(url)
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)
    with SessionLocal() as db:
        channel = Channel(
            id="gemini_full_ch",
            name="Gemini Full Channel",
            provider_type="gemini_proxy",
            role="candidate",
            base_url="https://generativelanguage.googleapis.com/v1beta",
            model_name="gemini-2.0-flash",
            auth_config={"api_key": "gem-key", "request_protocol": "gemini_generate_content"},
            enabled=True,
        )
        db.add(channel)
        db.commit()

    with TestClient(app) as client:
        response = client.post(
            "/api/full-model-check",
            json={
                "channel_ids": ["gemini_full_ch"],
                "repeat_count": 1,
                "include_stream": False,
                "include_tools": False,
                "include_params": False,
                "include_error_probe": False,
                "include_thinking": False,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    channel_payload = payload["channels"][0]
    assert channel_payload["protocol_family"] == "gemini_generate_content"
    assert channel_payload["total_output_tokens"] >= 1
    assert channel_payload["probes"][0]["request_id"] == "goog_req_full"
    assert any(":generateContent" in url for url in captured["urls"])
    assert captured["json"]["contents"][0]["parts"][0]["text"]


