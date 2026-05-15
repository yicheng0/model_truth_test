from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Enum, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Channel(Base):
    __tablename__ = "channels"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    provider_type: Mapped[str] = mapped_column(String(50), nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False)
    base_url: Mapped[str | None] = mapped_column(String(500))
    model_name: Mapped[str | None] = mapped_column(String(200))
    auth_config_encrypted: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    is_reference: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    @property
    def auth_config(self) -> dict:
        return self.auth_config_encrypted or {}

    @auth_config.setter
    def auth_config(self, value: dict | None) -> None:
        self.auth_config_encrypted = value or None


class TestSuite(Base):
    __tablename__ = "test_suites"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    version: Mapped[str | None] = mapped_column(String(50))
    visibility: Mapped[str] = mapped_column(String(20), default="public")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class TestCase(Base):
    __tablename__ = "test_cases"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    suite_id: Mapped[str] = mapped_column(ForeignKey("test_suites.id"), nullable=False, index=True)
    module: Mapped[str] = mapped_column(String(50), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=1000, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    system_prompt: Mapped[str | None] = mapped_column(Text)
    request_params: Mapped[dict | None] = mapped_column(JSON)
    scoring_rules: Mapped[dict | None] = mapped_column(JSON)
    is_hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    suite_id: Mapped[str] = mapped_column(ForeignKey("test_suites.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    mode: Mapped[str] = mapped_column(String(30), nullable=False, default="full_comparison")
    test_scope: Mapped[str] = mapped_column(String(30), nullable=False, default="full")
    baseline_snapshot_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    scheduled_test_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending")
    repeat_count: Mapped[int] = mapped_column(Integer, default=1)
    concurrency: Mapped[int] = mapped_column(Integer, default=1)
    total_jobs: Mapped[int] = mapped_column(Integer, default=0)
    completed_jobs: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ScheduledChannelTest(Base):
    __tablename__ = "scheduled_channel_tests"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id"), nullable=False, index=True)
    suite_id: Mapped[str] = mapped_column(ForeignKey("test_suites.id"), nullable=False, index=True)
    baseline_snapshot_id: Mapped[str] = mapped_column(ForeignKey("baseline_snapshots.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    interval_minutes: Mapped[int] = mapped_column(Integer, default=1440, nullable=False)
    test_scope: Mapped[str] = mapped_column(String(30), default="full", nullable=False)
    repeat_count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    concurrency: Mapped[int] = mapped_column(Integer, default=4, nullable=False)
    use_mock: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    alert_grade_threshold: Mapped[str] = mapped_column(String(2), default="D", nullable=False)
    alert_score_threshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    alert_red_flags_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    quiet_minutes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_retries: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    retry_interval_minutes: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_run_id: Mapped[str | None] = mapped_column(ForeignKey("runs.id"), nullable=True, index=True)
    last_status: Mapped[str | None] = mapped_column(String(30), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ChannelAlert(Base):
    __tablename__ = "channel_alerts"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    scheduled_test_id: Mapped[str | None] = mapped_column(ForeignKey("scheduled_channel_tests.id"), nullable=True, index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), nullable=False, index=True)
    report_id: Mapped[str] = mapped_column(ForeignKey("reports.id"), nullable=False, index=True)
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id"), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending_review", index=True)
    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="high")
    grade: Mapped[str] = mapped_column(String(2), nullable=False)
    final_score: Mapped[float] = mapped_column(Float, default=0.0)
    trigger_labels: Mapped[list[str] | None] = mapped_column(JSON)
    message: Mapped[str | None] = mapped_column(Text)
    notification_status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending")
    notification_error: Mapped[str | None] = mapped_column(Text)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewer_name: Mapped[str | None] = mapped_column(String(100))
    review_note: Mapped[str | None] = mapped_column(Text)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class FeishuBroadcastSetting(Base):
    __tablename__ = "feishu_broadcast_settings"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    webhook_url: Mapped[str | None] = mapped_column(Text)
    webhook_secret: Mapped[str | None] = mapped_column(Text)
    app_base_url: Mapped[str | None] = mapped_column(String(500))
    alert_broadcast_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    daily_report_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    daily_report_time: Mapped[str] = mapped_column(String(5), default="09:00", nullable=False)
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Shanghai", nullable=False)
    last_daily_report_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ChannelTaxonomySetting(Base):
    __tablename__ = "channel_taxonomy_settings"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    role_labels: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    provider_type_labels: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    model_options: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class RunChannel(Base):
    __tablename__ = "run_channels"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), nullable=False, index=True)
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id"), nullable=False, index=True)
    role_in_run: Mapped[str] = mapped_column(String(50), nullable=False)


class Result(Base):
    __tablename__ = "results"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), nullable=False, index=True)
    test_case_id: Mapped[str] = mapped_column(ForeignKey("test_cases.id"), nullable=False, index=True)
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id"), nullable=False, index=True)
    attempt_index: Mapped[int] = mapped_column(Integer, default=1)
    normalized_response: Mapped[dict | None] = mapped_column(JSON)
    raw_request: Mapped[dict | None] = mapped_column(JSON)
    raw_response: Mapped[dict | None] = mapped_column(JSON)
    metrics: Mapped[dict | None] = mapped_column(JSON)
    score: Mapped[float] = mapped_column(Float, default=0.0)
    labels: Mapped[list[str] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class BaselineSnapshot(Base):
    __tablename__ = "baseline_snapshots"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    suite_id: Mapped[str] = mapped_column(ForeignKey("test_suites.id"), nullable=False, index=True)
    source_run_id: Mapped[str | None] = mapped_column(ForeignKey("runs.id"), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="building")
    suite_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    request_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    channel_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    channel_ids: Mapped[list[str] | None] = mapped_column(JSON)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class BaselineResult(Base):
    __tablename__ = "baseline_results"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    baseline_snapshot_id: Mapped[str] = mapped_column(ForeignKey("baseline_snapshots.id"), nullable=False, index=True)
    test_case_id: Mapped[str] = mapped_column(ForeignKey("test_cases.id"), nullable=False, index=True)
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id"), nullable=False, index=True)
    role_in_baseline: Mapped[str] = mapped_column(String(50), nullable=False)
    attempt_index: Mapped[int] = mapped_column(Integer, default=1)
    normalized_response: Mapped[dict | None] = mapped_column(JSON)
    raw_request: Mapped[dict | None] = mapped_column(JSON)
    raw_response: Mapped[dict | None] = mapped_column(JSON)
    metrics: Mapped[dict | None] = mapped_column(JSON)
    score: Mapped[float] = mapped_column(Float, default=0.0)
    labels: Mapped[list[str] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Comparison(Base):
    __tablename__ = "comparisons"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), nullable=False, index=True)
    test_case_id: Mapped[str] = mapped_column(ForeignKey("test_cases.id"), nullable=False, index=True)
    candidate_channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id"), nullable=False, index=True)
    gold_similarity: Mapped[float] = mapped_column(Float, default=0.0)
    official_cloud_similarity: Mapped[float] = mapped_column(Float, default=0.0)
    protocol_score: Mapped[float] = mapped_column(Float, default=0.0)
    capability_score: Mapped[float] = mapped_column(Float, default=0.0)
    final_score: Mapped[float] = mapped_column(Float, default=0.0)
    labels: Mapped[list[str] | None] = mapped_column(JSON)


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), nullable=False, index=True)
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id"), nullable=False, index=True)
    final_score: Mapped[float] = mapped_column(Float, default=0.0)
    grade: Mapped[str] = mapped_column(String(2), default="E")
    summary: Mapped[str | None] = mapped_column(Text)
    evidence: Mapped[dict | None] = mapped_column(JSON)
    markdown: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
