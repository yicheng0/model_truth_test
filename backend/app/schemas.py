from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ChannelBase(BaseModel):
    name: str
    provider_type: str
    role: str | None = None
    base_url: str | None = None
    model_name: str | None = None
    auth_config: dict[str, Any] = Field(default_factory=dict)
    is_reference: bool = False
    enabled: bool = True


class ChannelCreate(ChannelBase):
    id: str | None = None


class ChannelUpdate(BaseModel):
    name: str | None = None
    provider_type: str | None = None
    role: str | None = None
    base_url: str | None = None
    model_name: str | None = None
    auth_config: dict[str, Any] | None = None
    is_reference: bool | None = None
    enabled: bool | None = None


class ChannelRead(ChannelBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SignatureInteropTestCreate(BaseModel):
    source_channel_id: str
    relay_channel_id: str
    stream: bool = False


class SignatureInteropStepRead(BaseModel):
    name: str
    status: str
    detail: str
    excerpt: str | None = None


class SignatureInteropTestRead(BaseModel):
    ok: bool
    status: str
    reason: str
    source_channel_id: str
    relay_channel_id: str
    source_endpoint: str
    relay_endpoint: str
    model: str
    thinking_block_count: int
    signature_prefixes: list[str]
    source_message_id: str | None = None
    source_message_channel_type: str
    relay_message_id: str | None = None
    relay_message_channel_type: str
    relay_raw_excerpt: str
    fallback_note: str
    steps: list[SignatureInteropStepRead]


class SimulatedMessageResponseCreate(BaseModel):
    provider: str = "aws"


class SimulatedMessageResponseRead(BaseModel):
    provider: str
    message_id: str
    message_channel_type: str
    raw_request: dict[str, Any]
    raw_response: dict[str, Any]
    fallback_note: str


class ModelRequestTestCreate(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)
    system_prompt: str | None = Field(default=None, max_length=8000)
    request_params: dict[str, Any] = Field(default_factory=dict)
    run_name: str | None = Field(default=None, max_length=200)


class TestSuiteBase(BaseModel):
    name: str
    description: str | None = None
    version: str | None = None
    visibility: str = "public"


class TestSuiteCreate(TestSuiteBase):
    id: str | None = None


class TestSuiteUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    version: str | None = None
    visibility: str | None = None


class TestSuiteRead(TestSuiteBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_at: datetime | None = None
    updated_at: datetime | None = None


class TestCaseBase(BaseModel):
    suite_id: str
    module: str
    sort_order: int = 1000
    title: str
    prompt: str
    system_prompt: str | None = None
    request_params: dict[str, Any] | None = None
    scoring_rules: dict[str, Any] | None = None
    is_hidden: bool = False
    enabled: bool = True


class TestCaseCreate(TestCaseBase):
    id: str | None = None


class TestCaseUpdate(BaseModel):
    suite_id: str | None = None
    module: str | None = None
    sort_order: int | None = None
    title: str | None = None
    prompt: str | None = None
    system_prompt: str | None = None
    request_params: dict[str, Any] | None = None
    scoring_rules: dict[str, Any] | None = None
    is_hidden: bool | None = None
    enabled: bool | None = None


class TestCaseRead(TestCaseBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_at: datetime | None = None


class BenchmarkConfig(BaseModel):
    concurrency_steps: list[int] = Field(default_factory=lambda: [1], min_length=1)
    duration_seconds: int = Field(default=0, ge=0, le=3600)
    warmup_requests: int = Field(default=0, ge=0, le=1000)
    target_qps: float | None = Field(default=None, gt=0, le=10000)
    sla_p95_ms: int | None = Field(default=None, gt=0)
    max_error_rate: float | None = Field(default=None, ge=0, le=100)


class ArenaJudgeConfig(BaseModel):
    judge_mode: str = "direct_score"
    judge_rubric: str | None = None


class TestSuiteBundle(BaseModel):
    suite: TestSuiteCreate
    cases: list[TestCaseCreate] = Field(default_factory=list)


class TestSuiteDiffRead(BaseModel):
    suite_id: str
    against: str
    added: list[str] = Field(default_factory=list)
    removed: list[str] = Field(default_factory=list)
    changed: list[dict[str, Any]] = Field(default_factory=list)
    unchanged: list[str] = Field(default_factory=list)


class RunCreate(BaseModel):
    name: str
    suite_id: str
    channel_ids: dict[str, list[str]] = Field(default_factory=dict)
    repeat_count: int = Field(default=1, ge=1, le=5)
    concurrency: int = Field(default=1, ge=1, le=16)
    use_mock: bool = True
    mode: str = "full_comparison"
    test_scope: str = "full"
    baseline_snapshot_id: str | None = None
    runtime_credentials: dict[str, dict[str, Any]] = Field(default_factory=dict)
    benchmark_config: BenchmarkConfig | None = None


class ArenaRunCreate(BaseModel):
    name: str
    suite_id: str
    candidate_channel_ids: list[str] = Field(min_length=2)
    judge_channel_id: str | None = None
    repeat_count: int = Field(default=1, ge=1, le=5)
    concurrency: int = Field(default=1, ge=1, le=16)
    use_mock: bool = True
    test_scope: str = "quick"
    runtime_credentials: dict[str, dict[str, Any]] = Field(default_factory=dict)
    judge_mode: str = "direct_score"
    judge_rubric: str | None = None


class RunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    suite_id: str
    name: str
    mode: str = "full_comparison"
    test_scope: str = "full"
    baseline_snapshot_id: str | None = None
    scheduled_test_id: str | None = None
    status: str
    repeat_count: int
    concurrency: int
    total_jobs: int
    completed_jobs: int
    started_at: datetime | None = None
    finished_at: datetime | None = None
    created_at: datetime | None = None


class ScheduledChannelTestBase(BaseModel):
    name: str
    channel_id: str
    suite_id: str
    baseline_snapshot_id: str
    enabled: bool = True
    interval_minutes: int = Field(default=1440, ge=5)
    test_scope: str = "full"
    repeat_count: int = Field(default=1, ge=1, le=5)
    concurrency: int = Field(default=4, ge=1, le=16)
    use_mock: bool = False
    alert_grade_threshold: str = Field(default="D", pattern=r"^[CDE]$")
    alert_score_threshold: float | None = Field(default=None, ge=0, le=100)
    alert_red_flags_enabled: bool = True
    quiet_minutes: int = Field(default=0, ge=0, le=10080)
    max_retries: int = Field(default=0, ge=0, le=3)
    retry_interval_minutes: int = Field(default=5, ge=1, le=60)
    next_run_at: datetime | None = None


class ScheduledChannelTestCreate(ScheduledChannelTestBase):
    id: str | None = None


class ScheduledChannelTestUpdate(BaseModel):
    name: str | None = None
    channel_id: str | None = None
    suite_id: str | None = None
    baseline_snapshot_id: str | None = None
    enabled: bool | None = None
    interval_minutes: int | None = Field(default=None, ge=5)
    test_scope: str | None = None
    repeat_count: int | None = Field(default=None, ge=1, le=5)
    concurrency: int | None = Field(default=None, ge=1, le=16)
    use_mock: bool | None = None
    alert_grade_threshold: str | None = Field(default=None, pattern=r"^[CDE]$")
    alert_score_threshold: float | None = Field(default=None, ge=0, le=100)
    alert_red_flags_enabled: bool | None = None
    quiet_minutes: int | None = Field(default=None, ge=0, le=10080)
    max_retries: int | None = Field(default=None, ge=0, le=3)
    retry_interval_minutes: int | None = Field(default=None, ge=1, le=60)
    next_run_at: datetime | None = None


class ScheduledChannelTestRead(ScheduledChannelTestBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    last_run_id: str | None = None
    last_status: str | None = None
    last_error: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ChannelAlertRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    scheduled_test_id: str | None = None
    run_id: str
    report_id: str
    channel_id: str
    status: str
    severity: str
    grade: str
    final_score: float
    trigger_labels: list[str] | None = None
    message: str | None = None
    notification_status: str
    notification_error: str | None = None
    notified_at: datetime | None = None
    reviewer_name: str | None = None
    review_note: str | None = None
    reviewed_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ChannelAlertReviewUpdate(BaseModel):
    status: str
    reviewer_name: str
    review_note: str | None = None


class FeishuBroadcastSettingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    enabled: bool
    webhook_configured: bool
    webhook_preview: str | None = None
    secret_configured: bool
    app_base_url: str | None = None
    alert_broadcast_enabled: bool
    daily_report_enabled: bool
    daily_report_time: str
    timezone: str
    last_daily_report_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class FeishuBroadcastSettingUpdate(BaseModel):
    enabled: bool | None = None
    webhook_url: str | None = None
    webhook_secret: str | None = None
    clear_webhook_secret: bool = False
    app_base_url: str | None = None
    alert_broadcast_enabled: bool | None = None
    daily_report_enabled: bool | None = None
    daily_report_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    timezone: str | None = None


class FeishuTestMessageRead(BaseModel):
    ok: bool
    status: str
    message: str


class ChannelTaxonomySettingRead(BaseModel):
    id: str
    role_labels: dict[str, str]
    provider_type_labels: dict[str, str]
    model_options: list[str]
    default_role_labels: dict[str, str]
    default_provider_type_labels: dict[str, str]
    default_model_options: list[str]
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ChannelTaxonomySettingUpdate(BaseModel):
    role_labels: dict[str, str | None] | None = None
    provider_type_labels: dict[str, str | None] | None = None
    model_options: list[str | None] | None = None


class SmartPatrolChannelSummary(BaseModel):
    channel_id: str
    channel_name: str
    run_count: int
    alert_count: int
    pending_review_count: int
    latest_grade: str | None = None
    latest_score: float | None = None
    avg_score: float | None = None
    last_run_at: datetime | None = None


class SmartPatrolTrendPoint(BaseModel):
    date: str
    run_count: int
    alert_count: int
    avg_score: float | None = None


class SmartPatrolReportRead(BaseModel):
    from_at: datetime
    to_at: datetime
    schedule_count: int
    enabled_schedule_count: int
    run_count: int
    completed_run_count: int
    failed_run_count: int
    alert_count: int
    pending_review_count: int
    avg_score: float | None = None
    grade_distribution: dict[str, int]
    channel_summaries: list[SmartPatrolChannelSummary]
    recent_alerts: list[ChannelAlertRead]
    trend: list[SmartPatrolTrendPoint]


class RunChannelRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    run_id: str
    channel_id: str
    role_in_run: str


class ResultRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    run_id: str
    test_case_id: str
    channel_id: str
    attempt_index: int
    normalized_response: dict[str, Any] | None = None
    raw_request: dict[str, Any] | None = None
    raw_response: dict[str, Any] | None = None
    metrics: dict[str, Any] | None = None
    score: float
    labels: list[str] | None = None
    created_at: datetime | None = None


class BaselineSnapshotRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    suite_id: str
    source_run_id: str | None = None
    status: str
    suite_fingerprint: str | None = None
    request_fingerprint: str | None = None
    channel_fingerprint: str | None = None
    channel_ids: list[str] | None = None
    expires_at: datetime | None = None
    ready_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class BaselineSnapshotUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)


class BaselineResultRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    baseline_snapshot_id: str
    test_case_id: str
    channel_id: str
    role_in_baseline: str
    attempt_index: int
    normalized_response: dict[str, Any] | None = None
    raw_request: dict[str, Any] | None = None
    raw_response: dict[str, Any] | None = None
    metrics: dict[str, Any] | None = None
    score: float
    labels: list[str] | None = None
    created_at: datetime | None = None


class BaselineBuildCreate(BaseModel):
    name: str
    suite_id: str
    channel_ids: dict[str, list[str]] = Field(default_factory=dict)
    repeat_count: int = Field(default=1, ge=1, le=5)
    concurrency: int = Field(default=1, ge=1, le=16)
    use_mock: bool = True
    test_scope: str = "full"
    expires_in_days: int = 30
    runtime_credentials: dict[str, dict[str, Any]] = Field(default_factory=dict)


class ComparisonRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    run_id: str
    test_case_id: str
    candidate_channel_id: str
    gold_similarity: float
    official_cloud_similarity: float
    protocol_score: float
    capability_score: float
    final_score: float
    labels: list[str] | None = None


class ReportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    run_id: str
    channel_id: str
    final_score: float
    grade: str
    summary: str | None = None
    evidence: dict[str, Any] | None = None
    markdown: str | None = None
    created_at: datetime | None = None


class PerformanceSummary(BaseModel):
    request_count: int = 0
    error_count: int = 0
    success_rate: float = 0.0
    avg_score: float | None = None
    avg_latency_ms: float | None = None
    p50_latency_ms: float | None = None
    p95_latency_ms: float | None = None
    p99_latency_ms: float | None = None
    avg_ttft_ms: float | None = None
    avg_tpot_ms: float | None = None
    avg_tokens_per_second: float | None = None
    latency_avg_ms: float | None = None
    latency_p50_ms: float | None = None
    latency_p95_ms: float | None = None
    latency_p99_ms: float | None = None
    first_token_avg_ms: float | None = None
    first_token_p95_ms: float | None = None
    success_count: int = 0
    failure_count: int = 0
    failure_rate: float = 0.0
    slow_case_ids: list[str] = Field(default_factory=list)


class ReportSummaryRead(BaseModel):
    report_id: str
    run_id: str
    run_name: str
    mode: str
    channel_id: str
    channel_name: str
    channel_role: str
    suite_id: str
    grade: str
    final_score: float
    summary: str | None = None
    labels: list[str] = Field(default_factory=list)
    dimension_scores: dict[str, float | None] = Field(default_factory=dict)
    performance: PerformanceSummary
    created_at: datetime | None = None


class ReportPredictionRowRead(BaseModel):
    test_case_id: str
    title: str
    module: str
    sort_order: int
    prompt: str
    system_prompt: str | None = None
    request_params: dict[str, Any] | None = None
    scoring_rules: dict[str, Any] | None = None
    result: ResultRead | None = None
    baseline_results: list[BaselineResultRead] = Field(default_factory=list)
    comparison: ComparisonRead | None = None
    labels: list[str] = Field(default_factory=list)
    score: float | None = None
    latency_ms: float | None = None


class ReportDetailRead(BaseModel):
    report: ReportRead
    run: RunRead
    channel: ChannelRead
    suite: TestSuiteRead | None = None
    cases: list[TestCaseRead]
    results: list[ResultRead]
    comparisons: list[ComparisonRead]
    baseline_results: list[BaselineResultRead]
    prediction_rows: list[ReportPredictionRowRead]
    performance_summary: PerformanceSummary


class ReportCompareRead(BaseModel):
    mode: str
    reports: list[ReportSummaryRead]
    dimensions: list[str]
    score_matrix: list[dict[str, Any]]
    prediction_rows: list[dict[str, Any]]
    label_diff: dict[str, list[str]]
    performance_matrix: list[dict[str, Any]]


class RunResultsRead(BaseModel):
    run: RunRead
    run_channels: list[RunChannelRead]
    results: list[ResultRead]
    comparisons: list[ComparisonRead]
    reports: list[ReportRead]
    baseline_snapshot: BaselineSnapshotRead | None = None
    baseline_results: list[BaselineResultRead] = Field(default_factory=list)


class RunSummaryRead(BaseModel):
    run: RunRead
    channel_count: int
    result_count: int
    comparison_count: int
    report_count: int
    avg_score: float | None = None
    avg_latency_ms: float | None = None
    avg_ttft_ms: float | None = None
    avg_tpot_ms: float | None = None
    avg_tokens_per_second: float | None = None
    success_rate: float | None = None
    p95_latency_ms: float | None = None
    grade_distribution: dict[str, int] = Field(default_factory=dict)
    label_distribution: dict[str, int] = Field(default_factory=dict)
    performance_by_channel: list[dict[str, Any]] = Field(default_factory=list)
    arena_rankings: list[dict[str, Any]] = Field(default_factory=list)
    top_evidence: list[dict[str, Any]] = Field(default_factory=list)


class ModelRequestTestRead(BaseModel):
    run: RunRead
    result: ResultRead
    message_id: str | None = None
    message_channel_type: str
    request_protocol: str | None = None
    provider_endpoint: str | None = None


class ManualScoreUpdate(BaseModel):
    final_score: float
    labels: list[str] | None = None
