from __future__ import annotations

from datetime import datetime
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_serializer, model_validator

from .redaction import redact_channel_auth_config, redact_secrets, redact_signatures


TIME_OF_DAY_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

PATROL_MODULES = {"signature_interop", "model_request_probes"}
DEFAULT_PATROL_MODULES = ["signature_interop", "model_request_probes"]

# Sub-probe keys inside the model_request_probes module. Kept in sync with
# services.SCHEDULED_MODEL_REQUEST_PROBE_KEYS (schemas must not import services).
MODEL_REQUEST_PROBE_KEYS = ["thinking_temperature", "web_search", "thinking_adaptive_enabled"]


def normalize_patrol_modules(value: list[str] | None) -> list[str]:
    source = DEFAULT_PATROL_MODULES if value is None else value
    modules = [str(item).strip() for item in source if str(item).strip()]
    deduped = list(dict.fromkeys(modules))
    invalid = [item for item in deduped if item not in PATROL_MODULES]
    if invalid:
        raise ValueError(f"unsupported patrol modules: {', '.join(invalid)}")
    if not deduped:
        raise ValueError("at least one patrol module must be selected")
    return deduped


def normalize_model_request_probe_keys(value: list[str] | None) -> list[str] | None:
    """None means 'all sub-probes' (default). An explicit list is validated and
    returned in registry order; an empty explicit list is rejected."""
    if value is None:
        return None
    keys = [str(item).strip() for item in value if str(item).strip()]
    deduped = list(dict.fromkeys(keys))
    invalid = [key for key in deduped if key not in MODEL_REQUEST_PROBE_KEYS]
    if invalid:
        raise ValueError(f"unsupported model request probe keys: {', '.join(invalid)}")
    if not deduped:
        raise ValueError("at least one model request probe must be selected")
    return [key for key in MODEL_REQUEST_PROBE_KEYS if key in deduped]


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

    @field_serializer("auth_config")
    def serialize_auth_config(self, value: dict[str, Any]) -> dict[str, Any]:
        return redact_channel_auth_config(value)


class ChannelHealthTrendPointRead(BaseModel):
    date: str
    run_count: int = 0
    result_count: int = 0
    success_count: int = 0
    failure_count: int = 0
    avg_latency_ms: float | None = None


class ChannelHealthRecentFailureRead(BaseModel):
    result_id: str
    run_id: str
    run_name: str | None = None
    created_at: datetime | None = None
    http_status: int | None = None
    request_id: str | None = None
    message_id: str | None = None
    error_type: str | None = None
    error_excerpt: str | None = None
    labels: list[str] = Field(default_factory=list)
    latency_ms: float | None = None


class ChannelHealthProbeSummaryRead(BaseModel):
    key: str
    total: int = 0
    success_count: int = 0
    failure_count: int = 0
    success_rate: float | None = None
    avg_latency_ms: float | None = None
    p95_latency_ms: float | None = None


class ChannelHealthSignatureSummaryRead(BaseModel):
    total: int = 0
    pass_count: int = 0
    fail_count: int = 0
    pass_rate: float | None = None
    latest_status: str | None = None
    latest_reason: str | None = None
    latest_created_at: datetime | None = None


class ChannelHealthPatrolSummaryRead(BaseModel):
    schedule_count: int = 0
    enabled_schedule_count: int = 0
    latest_status: str | None = None
    latest_error: str | None = None
    latest_finished_at: datetime | None = None
    alert_count: int = 0
    pending_alert_count: int = 0
    job_status_counts: dict[str, int] = Field(default_factory=dict)
    attempt_status_counts: dict[str, int] = Field(default_factory=dict)


class ChannelHealthProfileRead(BaseModel):
    channel: ChannelRead
    days: int
    status: Literal["ok", "degraded", "insufficient_data"]
    total_runs: int = 0
    total_results: int = 0
    success_count: int = 0
    failure_count: int = 0
    success_rate: float | None = None
    failure_rate: float | None = None
    avg_latency_ms: float | None = None
    p95_latency_ms: float | None = None
    latest_result_at: datetime | None = None
    label_distribution: dict[str, int] = Field(default_factory=dict)
    error_type_distribution: dict[str, int] = Field(default_factory=dict)
    probe_summaries: list[ChannelHealthProbeSummaryRead] = Field(default_factory=list)
    signature_summary: ChannelHealthSignatureSummaryRead = Field(default_factory=ChannelHealthSignatureSummaryRead)
    patrol_summary: ChannelHealthPatrolSummaryRead = Field(default_factory=ChannelHealthPatrolSummaryRead)
    trend: list[ChannelHealthTrendPointRead] = Field(default_factory=list)
    recent_failures: list[ChannelHealthRecentFailureRead] = Field(default_factory=list)

    @field_serializer("channel", "label_distribution", "error_type_distribution", "probe_summaries", "signature_summary", "patrol_summary", "trend", "recent_failures")
    def serialize_health_payload(self, value: Any) -> Any:
        return redact_secrets(value)


class SignatureInteropTestCreate(BaseModel):
    source_channel_id: str
    relay_channel_id: str
    stream: bool = False
    client_probe_id: str | None = Field(default=None, max_length=120)


class SignatureInteropStepRead(BaseModel):
    name: str
    status: str
    detail: str
    excerpt: str | None = None
    endpoint: str | None = None
    http_status: int | None = None
    request_id: str | None = None
    message_id: str | None = None
    latency_ms: int | None = None
    error: str | None = None


class SignatureInteropTestRead(BaseModel):
    ok: bool
    status: str
    reason: str
    run: "RunRead | None" = None
    result: "ResultRead | None" = None
    created_at: datetime | None = None
    completed_at: datetime | None = None
    client_probe_id: str | None = None
    source_channel_id: str
    relay_channel_id: str
    source_endpoint: str
    relay_endpoint: str
    model: str
    thinking_block_count: int
    signature_prefixes: list[str]
    source_message_id: str | None = None
    source_message_channel_type: str
    source_request_id: str | None = None
    relay_message_id: str | None = None
    relay_message_channel_type: str
    relay_request_id: str | None = None
    relay_raw_excerpt: str
    source_protocol_profile: str | None = None
    relay_protocol_profile: str | None = None
    request_normalization_notes: list[str] = Field(default_factory=list)
    fallback_note: str
    steps: list[SignatureInteropStepRead]


class ModelRequestTestCreate(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)
    system_prompt: str | None = Field(default=None, max_length=8000)
    request_params: dict[str, Any] = Field(default_factory=dict)
    run_name: str | None = Field(default=None, max_length=200)


class FullModelCheckCreate(BaseModel):
    channel_ids: list[str] = Field(min_length=1, max_length=12)
    repeat_count: int = Field(default=1, ge=1, le=5)
    include_stream: bool = True
    include_tools: bool = True
    include_params: bool = True
    include_error_probe: bool = True
    include_thinking: bool = True
    include_vision: bool = False
    timeout_seconds: int = Field(default=120, ge=30, le=240)


class FullModelCheckPlanCreate(BaseModel):
    """运行前的探针清单预览：channel_ids 可空（空则按 Anthropic 默认预览）。"""
    channel_ids: list[str] = Field(default_factory=list, max_length=12)
    repeat_count: int = Field(default=1, ge=1, le=5)
    include_stream: bool = True
    include_tools: bool = True
    include_params: bool = True
    include_error_probe: bool = True
    include_thinking: bool = True
    include_vision: bool = False
    timeout_seconds: int = Field(default=120, ge=30, le=240)


class FullModelCheckMetricSummary(BaseModel):
    count: int = 0
    avg: float | None = None
    p50: float | None = None
    p95: float | None = None
    min: float | None = None
    max: float | None = None


class FullModelCheckProbeRead(BaseModel):
    key: str
    base_key: str | None = None
    attempt_index: int = 1
    title: str
    category: str
    group: str | None = None
    protocol_family: str
    status: str
    score: float
    labels: list[str] = Field(default_factory=list)
    conclusion: str | None = None
    reason: str | None = None
    detection_type: str | None = None
    probe_target: str | None = None
    expected: str | None = None
    observed: str | None = None
    endpoint: str | None = None
    http_status: int | None = None
    request_id: str | None = None
    message_id: str | None = None
    latency_ms: float | None = None
    ttft_ms: float | None = None
    tpot_ms: float | None = None
    tokens_per_second: float | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    stream_event_count: int = 0
    stream_events: list[str] = Field(default_factory=list)
    usage_present: bool = False
    response_hash: str | None = None
    content_types: list[str] = Field(default_factory=list)
    error_type: str | None = None
    error_excerpt: str | None = None
    excerpt: str | None = None
    request_template: str | None = None
    structured_summary: dict[str, Any] = Field(default_factory=dict)
    raw_evidence: dict[str, Any] = Field(default_factory=dict)


class FullModelCheckChannelRead(BaseModel):
    channel: ChannelRead
    protocol_family: str
    status: str
    score: float
    summary: str
    labels: list[str] = Field(default_factory=list)
    total_probes: int = 0
    passed_probes: int = 0
    failed_probes: int = 0
    warning_probes: int = 0
    latency_ms: FullModelCheckMetricSummary = Field(default_factory=FullModelCheckMetricSummary)
    ttft_ms: FullModelCheckMetricSummary = Field(default_factory=FullModelCheckMetricSummary)
    tpot_ms: FullModelCheckMetricSummary = Field(default_factory=FullModelCheckMetricSummary)
    tokens_per_second: FullModelCheckMetricSummary = Field(default_factory=FullModelCheckMetricSummary)
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    probes: list[FullModelCheckProbeRead] = Field(default_factory=list)


class FullModelCheckRead(BaseModel):
    id: str
    created_at: datetime
    completed_at: datetime
    duration_ms: int
    repeat_count: int
    categories: list[str]
    channels: list[FullModelCheckChannelRead] = Field(default_factory=list)

    @field_serializer("channels")
    def serialize_full_model_channels(self, value: Any) -> Any:
        return redact_secrets(value)


class OpenAIResourceCheckCreate(BaseModel):
    base_url: str | None = Field(default="https://api.openai.com/v1", max_length=500)
    api_key: str = Field(min_length=1, max_length=4096)
    organization: str | None = Field(default=None, max_length=200)
    project: str | None = Field(default=None, max_length=200)
    model: str | None = Field(default=None, max_length=200)
    include_response_probe: bool = False
    detection_mode: Literal["auto", "openai_api", "codex_relay"] = "auto"
    probe_depth: Literal["quick", "deep"] = "quick"


class GeminiResourceCheckCreate(BaseModel):
    base_url: str | None = Field(default="https://generativelanguage.googleapis.com/v1beta", max_length=500)
    api_key: str = Field(min_length=1, max_length=4096)
    model: str | None = Field(default=None, max_length=200)
    include_stream_probe: bool = True
    include_embedding_probe: bool = True


class CacheHitRateTestCreate(BaseModel):
    test_count: int = Field(default=10, ge=1, le=30)
    interval_seconds: float = Field(default=3, ge=0, le=30)
    warmup_wait_seconds: float = Field(default=5, ge=0, le=30)
    cache_ttl: Literal["5m", "1h"] = "5m"
    run_name: str | None = Field(default=None, max_length=200)


class ClaudeCodeCheckCreate(BaseModel):
    model: str | None = Field(default=None, max_length=200)
    timeout_seconds: int = Field(default=180, ge=30, le=300)
    max_budget_usd: float = Field(default=0.25, ge=0.01, le=1.0)


class ClaudeCodeCheckStatusRead(BaseModel):
    installed: bool
    available: bool
    command: str
    command_path: str | None = None
    version: str | None = None
    error: str | None = None
    auth_evidence: dict[str, Any] = Field(default_factory=dict)


class ClaudeCodeCheckItemRead(BaseModel):
    key: str
    title: str
    status: str
    score: int
    detail: str


class ClaudeCodeCheckRead(BaseModel):
    ok: bool
    status: str
    score: int
    grade: str
    command: str
    command_path: str | None = None
    version: str | None = None
    started_at: datetime
    finished_at: datetime
    duration_ms: int
    checks: list[ClaudeCodeCheckItemRead]
    stdout_excerpt: str
    stderr_excerpt: str
    auth_evidence: dict[str, Any] = Field(default_factory=dict)
    execution_auth_context: dict[str, Any] = Field(default_factory=dict)

    @field_serializer("auth_evidence", "execution_auth_context")
    def serialize_cli_auth_evidence(self, value: Any) -> Any:
        return redact_secrets(value)


class ClaudeCodeJobCreateRead(BaseModel):
    job_id: str
    status: str


class ClaudeCodeJobProbeRead(BaseModel):
    key: str
    title: str
    category: str | None = None
    section: str | None = None
    status: str
    severity: str | None = None
    score: float | int = 0
    labels: list[str] = Field(default_factory=list)
    reason: str | None = None
    label_explanations: list[dict[str, str]] = Field(default_factory=list)
    detail: str | None = None
    run_id: str | None = None
    result_id: str | None = None
    message_id: str | None = None
    request_id: str | None = None
    request_protocol: str | None = None
    provider_endpoint: str | None = None
    protocol_profile: str | None = None
    request_normalization_notes: list[str] = Field(default_factory=list)
    latency_ms: int | float | None = None
    first_token_ms: int | float | None = None
    http_status: int | None = None
    error_type: str | None = None
    error_detail: str | None = None
    response_excerpt: str | None = None
    request_snapshot: dict[str, Any] = Field(default_factory=dict)
    raw_evidence: dict[str, Any] = Field(default_factory=dict)
    evidence_excerpt: str | None = None
    input_preview: dict[str, Any] | None = None

    @field_serializer("reason", "label_explanations", "error_detail", "response_excerpt", "request_snapshot", "raw_evidence", "evidence_excerpt", "input_preview")
    def serialize_probe_diagnostics(self, value: Any) -> Any:
        return redact_secrets(value)


class ClaudeCodeJobSectionRead(BaseModel):
    key: str
    title: str
    status: str
    score: float
    probe_count: int
    pass_count: int
    fail_count: int
    warning_count: int
    skipped_count: int
    probes: list[ClaudeCodeJobProbeRead] = Field(default_factory=list)


class ClaudeCodeJobStatusRead(BaseModel):
    job_id: str
    kind: str
    status: str
    started_at: datetime
    updated_at: datetime | None = None
    finished_at: datetime | None = None
    current_key: str | None = None
    current_title: str | None = None
    current_section: str | None = None
    completed_count: int
    total_count: int
    percent: float
    sections: list[ClaudeCodeJobSectionRead] = Field(default_factory=list)
    probes: list[ClaudeCodeJobProbeRead] = Field(default_factory=list)
    checks: list[ClaudeCodeJobProbeRead] = Field(default_factory=list)
    result: ClaudeCodeTestRead | ClaudeCodeCheckRead | None = None
    error: str | None = None


class ClaudeCodeTestCreate(BaseModel):
    source_channel_id: str | None = None
    image_url: str | None = Field(default=None, max_length=1000)
    include_expensive_context: bool = False
    probe_depth: Literal["standard", "deep"] = "standard"
    repeat_count: Literal[3, 5] = 3


class ClaudeCodeEphemeralTestCreate(ClaudeCodeTestCreate):
    channel_label: str | None = Field(default=None, max_length=200)
    base_url: str = Field(min_length=1, max_length=1000)
    api_key: str = Field(min_length=1, max_length=2000)
    model_name: str = Field(min_length=1, max_length=200)
    provider_type: str = "third_party_anthropic"
    request_protocol: str = "auto"


class ClaudeCodeProbeResultRead(BaseModel):
    key: str
    title: str
    category: str
    section: str | None = None
    status: str
    severity: str
    score: float
    labels: list[str] = Field(default_factory=list)
    reason: str | None = None
    label_explanations: list[dict[str, str]] = Field(default_factory=list)
    run_id: str | None = None
    result_id: str | None = None
    message_id: str | None = None
    request_id: str | None = None
    request_protocol: str | None = None
    provider_endpoint: str | None = None
    protocol_profile: str | None = None
    request_normalization_notes: list[str] = Field(default_factory=list)
    latency_ms: int | float | None = None
    first_token_ms: int | float | None = None
    http_status: int | None = None
    error_type: str | None = None
    error_detail: str | None = None
    response_excerpt: str | None = None
    request_snapshot: dict[str, Any] = Field(default_factory=dict)
    raw_evidence: dict[str, Any] = Field(default_factory=dict)
    evidence_excerpt: str | None = None
    input_preview: dict[str, Any] | None = None

    @field_serializer("reason", "label_explanations", "error_detail", "response_excerpt", "request_snapshot", "raw_evidence", "evidence_excerpt", "input_preview")
    def serialize_probe_diagnostics(self, value: Any) -> Any:
        return redact_secrets(value)


class ClaudeCodeSectionRead(BaseModel):
    key: str
    title: str
    score: float
    status: str
    probe_count: int
    pass_count: int
    fail_count: int
    warning_count: int
    skipped_count: int
    probes: list[ClaudeCodeProbeResultRead] = Field(default_factory=list)


class ClaudeCodeSourceChannelRead(BaseModel):
    id: str
    name: str
    provider_type: str | None = None
    model_name: str | None = None
    account_type: str | None = None


class ClaudeCodeTestRead(BaseModel):
    ok: bool
    score: float
    risk_level: str
    summary: str
    classification_status: str | None = None
    classification_label: str | None = None
    classification_reason: str | None = None
    access_path_assessment: str | None = None
    access_path_label: str | None = None
    access_path_reason: str | None = None
    access_path_caveat: str | None = None
    access_path_evidence: list[dict[str, Any]] = Field(default_factory=list)
    resource_identity: dict[str, Any] = Field(default_factory=dict)
    upstream_integrity: dict[str, Any] = Field(default_factory=dict)
    capability_flags: dict[str, Any] = Field(default_factory=dict)
    claude_score: float | None = None
    claude_code_score: float | None = None
    protocol_profile: str | None = None
    request_normalization_notes: list[str] = Field(default_factory=list)
    probes: list[ClaudeCodeProbeResultRead] = Field(default_factory=list)
    sections: list[ClaudeCodeSectionRead] = Field(default_factory=list)

    @field_serializer("resource_identity", "upstream_integrity")
    def serialize_identity_evidence(self, value: Any) -> Any:
        return redact_signatures(redact_secrets(value))


class ClaudeCodeEvidenceRead(BaseModel):
    id: str
    channel_label: str
    base_url: str
    model_name: str
    provider_type: str
    request_protocol: str | None = None
    source_channel_id: str | None = None
    image_url: str | None = None
    include_expensive_context: bool = False
    ok: bool
    score: float
    risk_level: str
    summary: str | None = None
    result_payload: ClaudeCodeTestRead
    created_at: datetime | None = None


class ClaudeCodeEvidenceListItemRead(BaseModel):
    id: str
    channel_label: str
    base_url: str
    model_name: str
    provider_type: str
    score: float
    risk_level: str
    ok: bool
    summary: str | None = None
    probe_count: int = 0
    fail_count: int = 0
    warning_count: int = 0
    created_at: datetime | None = None
    result_payload: ClaudeCodeTestRead | None = None


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
    patrol_channel_provider_type: str | None = None
    patrol_channel_account_type: str | None = None
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
    deleted_patrol_jobs: int = 0
    deleted_patrol_job_attempts: int = 0
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
    patrol_modules: list[str] = Field(default_factory=lambda: list(DEFAULT_PATROL_MODULES))
    model_request_probe_keys: list[str] | None = None
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
        self.patrol_modules = normalize_patrol_modules(self.patrol_modules)
        self.model_request_probe_keys = normalize_model_request_probe_keys(self.model_request_probe_keys)
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
    patrol_modules: list[str] | None = None
    model_request_probe_keys: list[str] | None = None
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
        if "patrol_modules" in self.model_fields_set:
            self.patrol_modules = normalize_patrol_modules(self.patrol_modules)
        if "model_request_probe_keys" in self.model_fields_set:
            self.model_request_probe_keys = normalize_model_request_probe_keys(self.model_request_probe_keys)
        if "run_window_start" not in self.model_fields_set and "run_window_end" not in self.model_fields_set:
            return self
        if {"run_window_start", "run_window_end"} - self.model_fields_set:
            raise ValueError("run_window_start and run_window_end must be provided together")
        self.run_window_start, self.run_window_end = validate_run_window(self.run_window_start, self.run_window_end)
        return self


class ScheduledChannelTestRead(ScheduledChannelTestBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    locked_by: str | None = None
    locked_until: datetime | None = None
    last_queued_at: datetime | None = None
    last_started_at: datetime | None = None
    last_finished_at: datetime | None = None
    is_stale: bool = False
    last_run_id: str | None = None
    last_status: str | None = None
    last_error: str | None = None
    latest_report_id: str | None = None
    latest_grade: str | None = None
    latest_score: float | None = None
    latest_probe_summary: dict[str, Any] | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class NewApiSyncRequest(BaseModel):
    base_url: str = Field(min_length=1, max_length=1000)
    admin_access_token: str = Field(min_length=1, max_length=2000)
    relay_token: str = Field(min_length=1, max_length=2000)
    page_size: int = Field(default=200, ge=1, le=500)
    status: str = "enabled"
    group: str | None = Field(default=None, max_length=200)
    tag: str | None = Field(default=None, max_length=200)
    model_keyword: str = Field(default="claude", max_length=200)
    default_interval_minutes: int = Field(default=1440, ge=5, le=43200)
    enabled: bool = True


class NewApiSyncItemRead(BaseModel):
    new_api_channel_id: str
    channel_id: str
    name: str
    model_name: str | None = None
    remote_models: list[str] = Field(default_factory=list)
    provider_type: str
    group: str | None = None
    tag: str | None = None
    remote_type: int | None = None
    remote_status: int | str | None = None
    remote_enabled: bool | None = None
    action: str
    schedule_action: str
    reason: str | None = None


class NewApiSyncRead(BaseModel):
    base_url: str
    total_remote: int
    matched: int
    matched_models: int = 0
    create_count: int
    update_count: int
    skip_count: int
    schedule_create_count: int
    schedule_exists_count: int
    items: list[NewApiSyncItemRead]


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
    dedupe_key: str | None = None
    notification_status: str
    notification_error: str | None = None
    notification_attempt_count: int = 0
    last_notification_attempt_at: datetime | None = None
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


class AuditLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    actor_id: str | None = None
    actor_name: str | None = None
    action: str
    target_type: str
    target_id: str
    request_id: str | None = None
    before_summary: dict[str, Any] | None = None
    after_summary: dict[str, Any] | None = None
    audit_metadata: dict[str, Any] | None = None
    created_at: datetime | None = None


class ScheduledTestHealthRead(BaseModel):
    enabled: bool
    auto_scheduler_enabled_value: str | None = None
    instance_id: str
    last_tick_at: datetime | None = None
    stale_schedule_count: int
    overdue_schedule_count: int = 0
    overdue_job_count: int = 0
    stale_attempt_count: int = 0
    heartbeat_stale: bool = False
    active_task_count: int = 0
    max_concurrent_tasks: int = 0
    last_recovery_count: int = 0
    last_recovery_error: str | None = None
    queued_schedule_count: int
    running_schedule_count: int
    next_due_at: datetime | None = None


class AutoSchedulerToggleRequest(BaseModel):
    enabled: bool


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
    channel_provider_type: str | None = None
    channel_account_type: str | None = None
    channel_model_name: str | None = None
    run_count: int
    alert_count: int
    pending_review_count: int
    last_run_at: datetime | None = None


class SmartPatrolTrendPoint(BaseModel):
    date: str
    run_count: int
    alert_count: int


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

    @field_serializer("normalized_response", "raw_request", "raw_response")
    def serialize_evidence(self, value: dict[str, Any] | None) -> dict[str, Any] | None:
        return redact_secrets(value)


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

    @field_serializer("normalized_response", "raw_request", "raw_response")
    def serialize_evidence(self, value: dict[str, Any] | None) -> dict[str, Any] | None:
        return redact_secrets(value)


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

    @field_serializer("evidence", "markdown")
    def serialize_report_evidence(self, value: Any) -> Any:
        return redact_secrets(value)


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
    request_id: str | None = None
    message_channel_type: str
    request_protocol: str | None = None
    provider_endpoint: str | None = None


class OpenAIResourceEvidenceItem(BaseModel):
    key: str
    status: Literal["ok", "warning", "fail", "info"]
    detail: str
    value: Any | None = None
    group: str | None = None


class OpenAIProbeAnalysisItem(BaseModel):
    key: str
    title: str
    group: str
    goal: str
    difference_level: Literal["strong", "moderate", "supporting"]
    execution_status: Literal["passed", "warning", "failed", "unsupported", "not_run"]
    openai_expected: str
    codex_expected: str
    observed: str
    conclusion: str


class OpenAIResourceCheckRead(BaseModel):
    classification: Literal[
        "official_openai_direct_likely",
        "openai_compatible_proxy",
        "codex_compatible_relay_likely",
        "hybrid_or_translated_gateway",
        "suspicious_proxy_or_rewrite",
        "invalid_or_unverified",
    ]
    confidence_score: float
    connection_type: Literal["official_openai_host", "relay_or_proxy"]
    resource_family: Literal[
        "official_openai_api_likely",
        "openai_api_relay_likely",
        "codex_compatible_relay_likely",
        "hybrid_or_translated_gateway",
        "openai_compatible_unverified",
        "suspicious_rewrite",
        "invalid_or_unverified",
    ]
    openai_api_score: float
    codex_compatibility_score: float
    source_confidence: float
    probe_depth: Literal["quick", "deep"]
    capabilities: dict[str, bool | None] = Field(default_factory=dict)
    directness: Literal["official_direct", "relay_or_proxy"]
    upstream_assessment: Literal[
        "official_upstream_likely",
        "openai_compatible_unverified",
        "suspicious_rewrite",
        "invalid_or_unverified",
    ]
    upstream_score: float
    summary: str
    labels: list[str] = Field(default_factory=list)
    base_url: str
    normalized_base_url: str
    host: str | None = None
    models_endpoint: str
    chat_endpoint: str | None = None
    response_endpoint: str | None = None
    selected_model: str | None = None
    request_id: str | None = None
    latency_ms: int | None = None
    evidence: list[OpenAIResourceEvidenceItem] = Field(default_factory=list)
    probe_analysis: list[OpenAIProbeAnalysisItem] = Field(default_factory=list)
    raw_evidence: dict[str, Any] = Field(default_factory=dict)


class GeminiResourceCheckRead(BaseModel):
    classification: Literal[
        "official_gemini_direct_likely",
        "gemini_compatible_proxy",
        "suspicious_proxy_or_rewrite",
        "invalid_or_unverified",
    ]
    confidence_score: float
    directness: Literal["official_google_direct", "relay_or_proxy"]
    upstream_assessment: Literal[
        "official_upstream_likely",
        "gemini_compatible_unverified",
        "suspicious_rewrite",
        "invalid_or_unverified",
    ]
    upstream_score: float
    summary: str
    labels: list[str] = Field(default_factory=list)
    base_url: str
    normalized_base_url: str
    host: str | None = None
    models_endpoint: str
    generate_endpoint: str | None = None
    stream_endpoint: str | None = None
    embedding_endpoint: str | None = None
    selected_model: str | None = None
    selected_embedding_model: str | None = None
    request_id: str | None = None
    latency_ms: int | None = None
    evidence: list[OpenAIResourceEvidenceItem] = Field(default_factory=list)
    raw_evidence: dict[str, Any] = Field(default_factory=dict)


class CacheHitRateAttemptRead(BaseModel):
    attempt_index: int
    result: ResultRead
    is_warmup: bool = False
    cache_hit: bool = False
    message_id: str | None = None
    request_id: str | None = None
    input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_ephemeral_5m_input_tokens: int = 0
    cache_creation_ephemeral_1h_input_tokens: int = 0
    prompt_tokens: int = 0
    latency_ms: int | None = None


class CacheHitRateTestRead(BaseModel):
    run: RunRead
    warmup: CacheHitRateAttemptRead | None = None
    attempts: list[CacheHitRateAttemptRead]
    requested_cache_ttl: Literal["5m", "1h"] = "5m"
    cache_probe_id: str | None = None
    total: int
    hits: int
    request_hit_rate: float
    total_prompt_tokens: int
    total_cached_tokens: int
    token_hit_rate: float
    avg_cached_tokens: float
    warmup_cache_creation_input_tokens: int = 0
    warmup_cache_creation_ephemeral_5m_input_tokens: int = 0
    warmup_cache_creation_ephemeral_1h_input_tokens: int = 0
    message_channel_type: str
    request_protocol: str | None = None
    provider_endpoint: str | None = None


class CacheHitRateJobCreateRead(BaseModel):
    job_id: str
    status: str


class CacheHitRateJobStatusRead(BaseModel):
    job_id: str
    kind: str = "cache_hit_rate"
    status: str
    started_at: datetime
    updated_at: datetime | None = None
    finished_at: datetime | None = None
    current_title: str | None = None
    completed_count: int
    total_count: int
    percent: float
    warmup: CacheHitRateAttemptRead | None = None
    attempts: list[CacheHitRateAttemptRead] = Field(default_factory=list)
    requested_cache_ttl: Literal["5m", "1h"] = "5m"
    cache_probe_id: str | None = None
    total: int = 0
    hits: int = 0
    request_hit_rate: float = 0
    total_prompt_tokens: int = 0
    total_cached_tokens: int = 0
    token_hit_rate: float = 0
    avg_cached_tokens: float = 0
    warmup_cache_creation_input_tokens: int = 0
    warmup_cache_creation_ephemeral_5m_input_tokens: int = 0
    warmup_cache_creation_ephemeral_1h_input_tokens: int = 0
    message_channel_type: str = "未知"
    request_protocol: str | None = None
    provider_endpoint: str | None = None
    result: CacheHitRateTestRead | None = None
    error: str | None = None


class ManualScoreUpdate(BaseModel):
    final_score: float
    labels: list[str] | None = None
