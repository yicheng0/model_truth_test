from __future__ import annotations

from datetime import datetime
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


TIME_OF_DAY_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


def validate_run_window(start: str | None, end: str | None) -> tuple[str | None, str | None]:
    if not start and not end:
        return None, None
    if not start or not end:
        raise ValueError("run_window_start and run_window_end must be provided together")
    if not TIME_OF_DAY_RE.fullmatch(start) or not TIME_OF_DAY_RE.fullmatch(end):
        raise ValueError("run window times must use HH:mm format")
    if start == end:
        raise ValueError("run window start and end must be different")
    return start, end


class ChannelBase(BaseModel):
    name: str
    provider_type: str = "custom_provider"
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
    run: "RunRead | None" = None
    result: "ResultRead | None" = None
    created_at: datetime | None = None
    completed_at: datetime | None = None
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


class EvalScopeJsonlImportCreate(BaseModel):
    suite: TestSuiteCreate
    jsonl: str
    default_module: str = "custom"
    default_task_type: str = "qa"


class TestSuiteValidationIssue(BaseModel):
    severity: str
    case_id: str | None = None
    field: str | None = None
    message: str


class TestSuiteValidationRead(BaseModel):
    suite_id: str
    ok: bool
    issue_count: int
    issues: list[TestSuiteValidationIssue] = Field(default_factory=list)


class TestSuiteCoverageRead(BaseModel):
    suite_id: str
    case_count: int
    enabled_count: int
    quick_count: int
    by_module: dict[str, int] = Field(default_factory=dict)
    by_task_type: dict[str, int] = Field(default_factory=dict)
    by_difficulty: dict[str, int] = Field(default_factory=dict)
    by_risk_dimension: dict[str, int] = Field(default_factory=dict)
    coverage_tags: dict[str, int] = Field(default_factory=dict)
    missing_metadata: dict[str, int] = Field(default_factory=dict)


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


class SamplePlanCreate(BaseModel):
    suite_id: str
    test_scope: str = "full"
    modules: list[str] = Field(default_factory=list)
    task_types: list[str] = Field(default_factory=list)
    coverage_tags: list[str] = Field(default_factory=list)
    difficulties: list[str] = Field(default_factory=list)
    risk_dimensions: list[str] = Field(default_factory=list)
    limit: int | None = Field(default=None, ge=1, le=500)
    per_group_limit: int | None = Field(default=None, ge=1, le=100)
    group_by: str = "module"


class SamplePlanRead(BaseModel):
    suite_id: str
    test_scope: str
    total_available: int
    selected_count: int
    filters: dict[str, Any]
    cases: list[TestCaseRead]
    group_counts: dict[str, int] = Field(default_factory=dict)


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
    patrol_channel_id: str | None = None
    patrol_channel_name: str | None = None
    channels: list[dict[str, str | None]] = Field(default_factory=list)
    status: str
    repeat_count: int
    concurrency: int
    total_jobs: int
    completed_jobs: int
    started_at: datetime | None = None
    finished_at: datetime | None = None
    created_at: datetime | None = None


class SystemUsageRead(BaseModel):
    disk_path: str
    disk_total_bytes: int
    disk_used_bytes: int
    disk_free_bytes: int
    disk_used_percent: float
    memory_total_bytes: int | None = None
    memory_available_bytes: int | None = None
    memory_used_bytes: int | None = None
    memory_used_percent: float | None = None
    database_path: str | None = None
    database_size_bytes: int | None = None
    run_count: int
    result_count: int
    comparison_count: int
    report_count: int
    alert_count: int
    cleanup_candidate_run_count: int
    cleanup_skipped_baseline_run_count: int


class RunLogCleanupRead(BaseModel):
    dry_run: bool = False
    deleted_runs: int = 0
    deleted_run_channels: int = 0
    deleted_results: int = 0
    deleted_comparisons: int = 0
    deleted_reports: int = 0
    deleted_alerts: int = 0
    cleared_scheduled_last_run_refs: int = 0
    skipped_running_runs: int = 0
    skipped_baseline_runs: int = 0


class ScheduledChannelTestBase(BaseModel):
    name: str
    channel_id: str
    suite_id: str | None = None
    baseline_snapshot_id: str | None = None
    enabled: bool = True
    interval_minutes: int = Field(default=1440, ge=5)
    run_window_start: str | None = None
    run_window_end: str | None = None
    test_scope: str = "scheduled_probe"
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

    @model_validator(mode="after")
    def validate_schedule_window(self) -> "ScheduledChannelTestBase":
        self.run_window_start, self.run_window_end = validate_run_window(self.run_window_start, self.run_window_end)
        return self


class ScheduledChannelTestCreate(ScheduledChannelTestBase):
    id: str | None = None


class ScheduledChannelTestUpdate(BaseModel):
    name: str | None = None
    channel_id: str | None = None
    suite_id: str | None = None
    baseline_snapshot_id: str | None = None
    enabled: bool | None = None
    interval_minutes: int | None = Field(default=None, ge=5)
    run_window_start: str | None = None
    run_window_end: str | None = None
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

    @model_validator(mode="after")
    def validate_schedule_window(self) -> "ScheduledChannelTestUpdate":
        if "run_window_start" not in self.model_fields_set and "run_window_end" not in self.model_fields_set:
            return self
        if {"run_window_start", "run_window_end"} - self.model_fields_set:
            raise ValueError("run_window_start and run_window_end must be provided together")
        self.run_window_start, self.run_window_end = validate_run_window(self.run_window_start, self.run_window_end)
        return self


class ScheduledChannelTestRead(ScheduledChannelTestBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    last_run_id: str | None = None
    last_status: str | None = None
    last_error: str | None = None
    latest_report_id: str | None = None
    latest_grade: str | None = None
    latest_score: float | None = None
    latest_probe_summary: dict[str, Any] | None = None
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
    evidence_summary: dict[str, Any] | None = None
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


class BulkDeleteRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)


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
