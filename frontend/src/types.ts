export type Channel = {
  id: string;
  name: string;
  provider_type: string;
  role: ChannelRole;
  base_url?: string | null;
  model_name?: string | null;
  auth_config?: ChannelAuthConfig;
  is_reference: boolean;
  enabled: boolean;
};

export type ChannelRole = string;

export type ChannelDeleteResult = {
  deleted: boolean;
  deleted_runs?: number;
  deleted_run_channels?: number;
  deleted_results?: number;
  deleted_comparisons?: number;
  deleted_reports?: number;
  deleted_alerts?: number;
  deleted_schedules?: number;
  deleted_baselines?: number;
  deleted_patrol_jobs?: number;
};

export type ChannelHealthTrendPoint = {
  date: string;
  run_count: number;
  result_count: number;
  success_count: number;
  failure_count: number;
  avg_latency_ms?: number | null;
};

export type ChannelHealthRecentFailure = {
  result_id: string;
  run_id: string;
  run_name?: string | null;
  created_at?: string | null;
  http_status?: number | null;
  request_id?: string | null;
  message_id?: string | null;
  error_type?: string | null;
  error_excerpt?: string | null;
  labels: string[];
  latency_ms?: number | null;
};

export type ChannelHealthProbeSummary = {
  key: string;
  total: number;
  success_count: number;
  failure_count: number;
  success_rate?: number | null;
  avg_latency_ms?: number | null;
  p95_latency_ms?: number | null;
};

export type ChannelHealthProfile = {
  channel: Channel;
  days: number;
  status: 'ok' | 'degraded' | 'insufficient_data' | string;
  total_runs: number;
  total_results: number;
  success_count: number;
  failure_count: number;
  success_rate?: number | null;
  failure_rate?: number | null;
  avg_latency_ms?: number | null;
  p95_latency_ms?: number | null;
  latest_result_at?: string | null;
  label_distribution: Record<string, number>;
  error_type_distribution: Record<string, number>;
  probe_summaries: ChannelHealthProbeSummary[];
  signature_summary: {
    total: number;
    pass_count: number;
    fail_count: number;
    pass_rate?: number | null;
    latest_status?: string | null;
    latest_reason?: string | null;
    latest_created_at?: string | null;
  };
  patrol_summary: {
    schedule_count: number;
    enabled_schedule_count: number;
    latest_status?: string | null;
    latest_error?: string | null;
    latest_finished_at?: string | null;
    alert_count: number;
    pending_alert_count: number;
    job_status_counts: Record<string, number>;
    attempt_status_counts: Record<string, number>;
  };
  trend: ChannelHealthTrendPoint[];
  recent_failures: ChannelHealthRecentFailure[];
};

/** Legacy — prefer narrower interfaces below. */
export type JsonObject = Record<string, any>;

export interface ChannelAuthConfig {
  [key: string]: unknown;
  api_key?: string;
  secret_ref?: string;
  credential_ref?: string;
  account_type?: string;
  request_protocol?: string;
  region?: string;
}

export type ResponsePayload = JsonObject & {
  content?: Array<Record<string, unknown>>;
  content_text?: string;
  tool_calls?: Array<Record<string, unknown>>;
  error?: unknown;
  usage?: JsonObject;
  stream_events?: string[];
  provider_message_id?: string;
  provider_model?: string;
  stop_reason?: string;
  raw_response?: ResponsePayload;
  request_id?: string;
  requestId?: string;
  _response_metadata?: JsonObject;
  cloud_wrapper?: JsonObject;
  ResponseMetadata?: JsonObject;
};

export interface MetricsPayload {
  latency_ms?: number;
  ttft_ms?: number;
  tokens_per_second?: number;
}

export interface ArenaEvidence {
  rank?: number;
  win_rate?: number;
  avg_case_score?: number;
  pair_count?: number;
  case_count?: number;
}

export interface TopEvidenceItem {
  test_case_id?: string;
  winner_channel_id?: string;
  loser_channel_id?: string;
  winner_score?: number | null;
  loser_score?: number | null;
  margin?: number | null;
  labels?: string[];
}

export interface SignatureInteropEvidence {
  status?: 'pass' | 'fail' | 'skipped' | string;
  reason?: string | null;
  source_channel_id?: string | null;
  source_channel_name?: string | null;
  source_channel_account_type?: string | null;
  source_channel_provider_type?: string | null;
  relay_channel_id?: string | null;
  relay_channel_name?: string | null;
  relay_channel_account_type?: string | null;
  relay_channel_provider_type?: string | null;
  source_message_id?: string | null;
  source_request_id?: string | null;
  source_message_channel_type?: string | null;
  relay_message_id?: string | null;
  relay_request_id?: string | null;
  relay_message_channel_type?: string | null;
  signature_prefixes?: string[];
  created_at?: string | null;
  completed_at?: string | null;
}

export interface ReportEvidence {
  test_scope?: string;
  confidence?: number | string | null;
  labels?: string[];
  label_explanations?: Array<{ label: string; description: string }>;
  detected_provider_hint?: string | null;
  dimension_scores?: Record<string, number | null | undefined>;
  scoring_dimensions?: Record<string, number | null | undefined>;
  arena?: ArenaEvidence;
  arena_matrix?: Array<Record<string, unknown>>;
  judge_evidence?: Record<string, unknown>;
  top_evidence?: Array<TopEvidenceItem>;
  model_request?: Record<string, unknown>;
  model_requests?: Array<Record<string, unknown>>;
  signature_interop?: SignatureInteropEvidence;
}

export type ChannelTaxonomySetting = {
  id: string;
  role_labels: Record<ChannelRole, string>;
  provider_type_labels: Record<string, string>;
  model_options: string[];
  default_role_labels: Record<ChannelRole, string>;
  default_provider_type_labels: Record<string, string>;
  default_model_options: string[];
  created_at?: string | null;
  updated_at?: string | null;
};

export type ChannelTaxonomyUpdate = {
  role_labels?: Partial<Record<ChannelRole, string | null>>;
  provider_type_labels?: Record<string, string | null>;
  model_options?: Array<string | null>;
};

export type ChannelCreate = {
  id?: string | null;
  name: string;
  provider_type: string;
  role?: string | null;
  base_url?: string | null;
  model_name?: string | null;
  auth_config?: ChannelAuthConfig | null;
  is_reference?: boolean;
  enabled?: boolean;
};

export type NewApiSyncRequest = {
  base_url: string;
  admin_access_token: string;
  relay_token: string;
  page_size?: number;
  status?: string;
  group?: string | null;
  tag?: string | null;
  model_keyword?: string;
  default_interval_minutes?: number;
  enabled?: boolean;
};

export type NewApiSyncItem = {
  new_api_channel_id: string;
  channel_id: string;
  name: string;
  model_name?: string | null;
  provider_type: string;
  action: string;
  schedule_action: string;
  reason?: string | null;
};

export type NewApiSyncResult = {
  base_url: string;
  total_remote: number;
  matched: number;
  create_count: number;
  update_count: number;
  skip_count: number;
  schedule_create_count: number;
  schedule_exists_count: number;
  items: NewApiSyncItem[];
};

export type SignatureInteropResult = {
  ok: boolean;
  status: 'pass' | 'fail' | string;
  reason: string;
  run?: Run | null;
  result?: Result | null;
  created_at?: string | null;
  completed_at?: string | null;
  client_probe_id?: string | null;
  source_channel_id: string;
  relay_channel_id: string;
  source_endpoint: string;
  relay_endpoint: string;
  model: string;
  thinking_block_count: number;
  signature_prefixes: string[];
  source_message_id?: string | null;
  source_message_channel_type: string;
  source_request_id?: string | null;
  relay_message_id?: string | null;
  relay_message_channel_type: string;
  relay_request_id?: string | null;
  relay_raw_excerpt: string;
  source_protocol_profile?: string | null;
  relay_protocol_profile?: string | null;
  request_normalization_notes?: string[];
  fallback_note: string;
  steps: Array<{
    name: string;
    status: 'ok' | 'fail' | 'running' | string;
    detail: string;
    excerpt?: string | null;
    endpoint?: string | null;
    http_status?: number | null;
    request_id?: string | null;
    message_id?: string | null;
    latency_ms?: number | null;
    error?: string | null;
  }>;
};

export type ModelRequestTestResult = {
  run: Run;
  result: Result;
  message_id?: string | null;
  request_id?: string | null;
  message_channel_type: string;
  request_protocol?: string | null;
  provider_endpoint?: string | null;
};

export type FullModelCheckRequest = {
  channel_ids: string[];
  repeat_count?: number;
  include_stream?: boolean;
  include_tools?: boolean;
  include_params?: boolean;
  include_error_probe?: boolean;
  include_thinking?: boolean;
  include_vision?: boolean;
  timeout_seconds?: number;
};

export type FullModelMetricSummary = {
  count: number;
  avg?: number | null;
  p50?: number | null;
  p95?: number | null;
  min?: number | null;
  max?: number | null;
};

export type FullModelProbeResult = {
  key: string;
  base_key?: string | null;
  attempt_index?: number;
  title: string;
  category: string;
  protocol_family: string;
  status: 'pass' | 'warning' | 'fail' | string;
  score: number;
  labels: string[];
  conclusion?: string | null;
  reason?: string | null;
  detection_type?: string | null;
  probe_target?: string | null;
  expected?: string | null;
  observed?: string | null;
  endpoint?: string | null;
  http_status?: number | null;
  request_id?: string | null;
  message_id?: string | null;
  latency_ms?: number | null;
  ttft_ms?: number | null;
  tpot_ms?: number | null;
  tokens_per_second?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  stream_event_count: number;
  stream_events: string[];
  usage_present: boolean;
  response_hash?: string | null;
  content_types?: string[];
  error_type?: string | null;
  error_excerpt?: string | null;
  excerpt?: string | null;
  request_template?: string | null;
  structured_summary?: Record<string, unknown>;
  raw_evidence: Record<string, unknown>;
};

export type FullModelChannelResult = {
  channel: Channel;
  protocol_family: string;
  status: 'pass' | 'warning' | 'degraded' | 'failed' | string;
  score: number;
  summary: string;
  labels: string[];
  total_probes: number;
  passed_probes: number;
  failed_probes: number;
  warning_probes: number;
  latency_ms: FullModelMetricSummary;
  ttft_ms: FullModelMetricSummary;
  tpot_ms: FullModelMetricSummary;
  tokens_per_second: FullModelMetricSummary;
  total_input_tokens: number;
  total_output_tokens: number;
  probes: FullModelProbeResult[];
};

export type FullModelCheckResult = {
  id: string;
  created_at: string;
  completed_at: string;
  duration_ms: number;
  repeat_count: number;
  categories: string[];
  channels: FullModelChannelResult[];
};

export type OpenAIResourceCheckRequest = {
  base_url?: string | null;
  api_key: string;
  organization?: string | null;
  project?: string | null;
  model?: string | null;
  include_response_probe?: boolean;
};

export type OpenAIResourceEvidenceItem = {
  key: string;
  status: 'ok' | 'warning' | 'fail' | 'info' | string;
  detail: string;
  value?: unknown;
  group?: string | null;
};

export type OpenAIResourceCheckResult = {
  classification: 'official_openai_direct_likely' | 'openai_compatible_proxy' | 'suspicious_proxy_or_rewrite' | 'invalid_or_unverified' | string;
  confidence_score: number;
  directness?: 'official_direct' | 'relay_or_proxy' | string;
  upstream_assessment?: 'official_upstream_likely' | 'openai_compatible_unverified' | 'suspicious_rewrite' | 'invalid_or_unverified' | string;
  upstream_score?: number;
  summary: string;
  labels: string[];
  base_url: string;
  normalized_base_url: string;
  host?: string | null;
  models_endpoint: string;
  chat_endpoint?: string | null;
  response_endpoint?: string | null;
  selected_model?: string | null;
  request_id?: string | null;
  latency_ms?: number | null;
  evidence: OpenAIResourceEvidenceItem[];
  raw_evidence: Record<string, unknown>;
};

export type GeminiResourceCheckRequest = {
  base_url?: string | null;
  api_key: string;
  model?: string | null;
  include_stream_probe?: boolean;
  include_embedding_probe?: boolean;
};

export type GeminiResourceEvidenceItem = OpenAIResourceEvidenceItem;

export type GeminiResourceCheckResult = {
  classification: 'official_gemini_direct_likely' | 'gemini_compatible_proxy' | 'suspicious_proxy_or_rewrite' | 'invalid_or_unverified' | string;
  confidence_score: number;
  directness?: 'official_google_direct' | 'relay_or_proxy' | string;
  upstream_assessment?: 'official_upstream_likely' | 'gemini_compatible_unverified' | 'suspicious_rewrite' | 'invalid_or_unverified' | string;
  upstream_score?: number;
  summary: string;
  labels: string[];
  base_url: string;
  normalized_base_url: string;
  host?: string | null;
  models_endpoint: string;
  generate_endpoint?: string | null;
  stream_endpoint?: string | null;
  embedding_endpoint?: string | null;
  selected_model?: string | null;
  selected_embedding_model?: string | null;
  request_id?: string | null;
  latency_ms?: number | null;
  evidence: GeminiResourceEvidenceItem[];
  raw_evidence: Record<string, unknown>;
};

export type CacheHitRateAttempt = {
  attempt_index: number;
  result: Result;
  is_warmup: boolean;
  cache_hit: boolean;
  message_id?: string | null;
  request_id?: string | null;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_ephemeral_5m_input_tokens: number;
  cache_creation_ephemeral_1h_input_tokens: number;
  prompt_tokens: number;
  latency_ms?: number | null;
};

export type CacheHitRateTestResult = {
  run: Run;
  warmup?: CacheHitRateAttempt | null;
  attempts: CacheHitRateAttempt[];
  requested_cache_ttl: '5m' | '1h';
  cache_probe_id?: string | null;
  total: number;
  hits: number;
  request_hit_rate: number;
  total_prompt_tokens: number;
  total_cached_tokens: number;
  token_hit_rate: number;
  avg_cached_tokens: number;
  warmup_cache_creation_input_tokens: number;
  warmup_cache_creation_ephemeral_5m_input_tokens: number;
  warmup_cache_creation_ephemeral_1h_input_tokens: number;
  message_channel_type: string;
  request_protocol?: string | null;
  provider_endpoint?: string | null;
};

export type CacheHitRateJobCreate = {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | string;
};

export type CacheHitRateJobStatus = {
  job_id: string;
  kind: 'cache_hit_rate' | string;
  status: 'queued' | 'running' | 'completed' | 'failed' | string;
  started_at: string;
  updated_at?: string | null;
  finished_at?: string | null;
  current_title?: string | null;
  completed_count: number;
  total_count: number;
  percent: number;
  warmup?: CacheHitRateAttempt | null;
  attempts: CacheHitRateAttempt[];
  requested_cache_ttl: '5m' | '1h';
  cache_probe_id?: string | null;
  total: number;
  hits: number;
  request_hit_rate: number;
  total_prompt_tokens: number;
  total_cached_tokens: number;
  token_hit_rate: number;
  avg_cached_tokens: number;
  warmup_cache_creation_input_tokens: number;
  warmup_cache_creation_ephemeral_5m_input_tokens: number;
  warmup_cache_creation_ephemeral_1h_input_tokens: number;
  message_channel_type: string;
  request_protocol?: string | null;
  provider_endpoint?: string | null;
  result?: CacheHitRateTestResult | null;
  error?: string | null;
};

export type ClaudeCodeProbeResult = {
  key: string;
  title: string;
  category: string;
  section?: string | null;
  status: 'pass' | 'fail' | 'warning' | 'skipped' | string;
  severity: 'core' | 'supporting' | 'weak' | string;
  score: number;
  labels: string[];
  run_id?: string | null;
  result_id?: string | null;
  message_id?: string | null;
  request_id?: string | null;
  request_protocol?: string | null;
  provider_endpoint?: string | null;
  protocol_profile?: 'claude_legacy' | 'claude_adaptive_thinking' | 'unknown' | string | null;
  request_normalization_notes?: string[];
  latency_ms?: number | null;
  first_token_ms?: number | null;
  evidence_excerpt?: string | null;
  input_preview?: {
    kind: 'image_base64' | 'image_url' | 'document_text' | string;
    title: string;
    summary?: string | null;
    image_data_url?: string | null;
    default_image_url?: string | null;
    actual_image_url?: string | null;
    document_text?: string | null;
    document_marker?: string | null;
  } | null;
};

export type ClaudeCodeSection = {
  key: string;
  title: string;
  score: number;
  status: 'pass' | 'fail' | 'warning' | 'skipped' | string;
  probe_count: number;
  pass_count: number;
  fail_count: number;
  warning_count: number;
  skipped_count: number;
  probes: ClaudeCodeProbeResult[];
};

export type ClaudeCodeTestResult = {
  ok: boolean;
  score: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical' | string;
  summary: string;
  classification_status?: 'claude_code' | 'claude' | 'aws_resource' | 'non_claude' | 'anomaly' | 'unknown' | string | null;
  classification_label?: string | null;
  classification_reason?: string | null;
  capability_flags?: {
    is_claude_like?: boolean;
    is_claude_code_like?: boolean;
    signature_supported?: boolean;
    multimodal_supported?: boolean;
    [key: string]: unknown;
  } | null;
  claude_score?: number | null;
  claude_code_score?: number | null;
  protocol_profile?: 'claude_legacy' | 'claude_adaptive_thinking' | 'unknown' | string | null;
  request_normalization_notes?: string[];
  probes: ClaudeCodeProbeResult[];
  sections: ClaudeCodeSection[];
};

export type ClaudeCodeSourceChannel = {
  id: string;
  name: string;
  provider_type?: string | null;
  model_name?: string | null;
  account_type?: string | null;
};

export type ClaudeCodeRelayTestCreate = {
  channel_label?: string | null;
  base_url: string;
  api_key: string;
  model_name: string;
  provider_type?: string;
  request_protocol?: string;
  source_channel_id?: string | null;
  image_url?: string | null;
  include_expensive_context?: boolean;
};

export type ClaudeCodeCheckStatus = {
  installed: boolean;
  available: boolean;
  command: string;
  command_path?: string | null;
  version?: string | null;
  error?: string | null;
};

export type ClaudeCodeCheckItem = {
  key: string;
  title: string;
  status: 'pass' | 'fail' | string;
  score: number;
  detail: string;
};

export type ClaudeCodeCheckResult = {
  ok: boolean;
  status: 'passed' | 'failed' | string;
  score: number;
  grade: string;
  command: string;
  command_path?: string | null;
  version?: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  checks: ClaudeCodeCheckItem[];
  stdout_excerpt: string;
  stderr_excerpt: string;
};

export type ClaudeCodeJobCreate = {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | string;
};

export type ClaudeCodeJobProbe = {
  key: string;
  title: string;
  category?: string | null;
  section?: string | null;
  status: 'queued' | 'running' | 'pass' | 'fail' | 'warning' | 'skipped' | string;
  severity?: string | null;
  score: number;
  labels: string[];
  detail?: string | null;
  run_id?: string | null;
  result_id?: string | null;
  message_id?: string | null;
  request_id?: string | null;
  request_protocol?: string | null;
  provider_endpoint?: string | null;
  protocol_profile?: 'claude_legacy' | 'claude_adaptive_thinking' | 'unknown' | string | null;
  request_normalization_notes?: string[];
  latency_ms?: number | null;
  first_token_ms?: number | null;
  evidence_excerpt?: string | null;
  input_preview?: {
    kind: 'image_base64' | 'image_url' | 'document_text' | string;
    title: string;
    summary?: string | null;
    image_data_url?: string | null;
    default_image_url?: string | null;
    actual_image_url?: string | null;
    document_text?: string | null;
    document_marker?: string | null;
  } | null;
};

export type ClaudeCodeJobSection = {
  key: string;
  title: string;
  status: 'queued' | 'running' | 'pass' | 'fail' | 'warning' | 'skipped' | string;
  score: number;
  probe_count: number;
  pass_count: number;
  fail_count: number;
  warning_count: number;
  skipped_count: number;
  probes: ClaudeCodeJobProbe[];
};

export type ClaudeCodeJobStatus = {
  job_id: string;
  kind: 'relay' | 'cli' | string;
  status: 'queued' | 'running' | 'completed' | 'failed' | string;
  started_at: string;
  updated_at?: string | null;
  finished_at?: string | null;
  current_key?: string | null;
  current_title?: string | null;
  current_section?: string | null;
  completed_count: number;
  total_count: number;
  percent: number;
  sections: ClaudeCodeJobSection[];
  probes: ClaudeCodeJobProbe[];
  checks: ClaudeCodeJobProbe[];
  result?: ClaudeCodeTestResult | ClaudeCodeCheckResult | null;
  error?: string | null;
};

export type ClaudeCodeHistoryItem = {
  id: string;
  channel_label: string;
  base_url: string;
  model_name: string;
  provider_type: string;
  score: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical' | string;
  ok: boolean;
  summary?: string | null;
  probe_count: number;
  fail_count: number;
  warning_count: number;
  created_at?: string | null;
  result_payload?: ClaudeCodeTestResult | null;
};

export type ClaudeCodeHistoryDetail = {
  id: string;
  channel_label: string;
  base_url: string;
  model_name: string;
  provider_type: string;
  request_protocol?: string | null;
  source_channel_id?: string | null;
  image_url?: string | null;
  include_expensive_context: boolean;
  ok: boolean;
  score: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical' | string;
  summary?: string | null;
  result_payload: ClaudeCodeTestResult;
  created_at?: string | null;
};

export type TestSuite = {
  id: string;
  name: string;
  description?: string | null;
  version?: string | null;
  visibility?: string;
};

export type TestCase = {
  id: string;
  suite_id: string;
  module: string;
  sort_order: number;
  title: string;
  prompt: string;
  system_prompt?: string | null;
  request_params?: JsonObject | null;
  scoring_rules?: JsonObject | null;
  is_hidden?: boolean;
  enabled?: boolean;
};

export type TestCaseCreate = {
  id?: string | null;
  suite_id: string;
  module: string;
  sort_order?: number;
  title: string;
  prompt: string;
  system_prompt?: string | null;
  request_params?: JsonObject | null;
  scoring_rules?: JsonObject | null;
  is_hidden?: boolean;
  enabled?: boolean;
};

export type Run = {
  id: string;
  suite_id: string;
  name: string;
  mode: RunMode;
  test_scope: TestScope;
  baseline_snapshot_id?: string | null;
  scheduled_test_id?: string | null;
  patrol_channel_id?: string | null;
  patrol_channel_name?: string | null;
  patrol_channel_provider_type?: string | null;
  patrol_channel_account_type?: string | null;
  channels?: Array<{ channel_id?: string | null; channel_name?: string | null; role_in_run?: string | null }>;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'canceled';
  repeat_count: number;
  concurrency: number;
  total_jobs: number;
  completed_jobs: number;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string | null;
};

export type BenchmarkConfig = {
  concurrency_steps?: number[];
  duration_seconds?: number;
  warmup_requests?: number;
  target_qps?: number | null;
  sla_p95_ms?: number | null;
  max_error_rate?: number | null;
};

export type RunCreate = {
  name: string;
  suite_id: string;
  channel_ids?: Record<string, string[]>;
  repeat_count: number;
  concurrency: number;
  mode?: RunMode;
  test_scope?: TestScope;
  baseline_snapshot_id?: string;
  use_mock?: boolean;
  runtime_credentials?: Record<string, JsonObject>;
  benchmark_config?: BenchmarkConfig | null;
};

export type BaselineBuildCreate = {
  name: string;
  suite_id: string;
  channel_ids?: Record<string, string[]>;
  repeat_count: number;
  concurrency: number;
  use_mock?: boolean;
  test_scope?: TestScope;
  expires_in_days?: number;
  runtime_credentials?: Record<string, JsonObject>;
};

export type ScheduledChannelTestCreate = {
  name: string;
  channel_id: string;
  suite_id?: string | null;
  baseline_snapshot_id?: string | null;
  enabled?: boolean;
  interval_minutes?: number;
  run_window_start?: string | null;
  run_window_end?: string | null;
  test_scope?: TestScope;
  repeat_count?: number;
  concurrency?: number;
  use_mock?: boolean;
  alert_grade_threshold?: 'C' | 'D' | 'E';
  alert_score_threshold?: number | null;
  alert_red_flags_enabled?: boolean;
  quiet_minutes?: number;
  max_retries?: number;
  retry_interval_minutes?: number;
};

export type SystemUsage = {
  disk_path: string;
  disk_total_bytes: number;
  disk_used_bytes: number;
  disk_free_bytes: number;
  disk_used_percent: number;
  memory_total_bytes?: number | null;
  memory_available_bytes?: number | null;
  memory_used_bytes?: number | null;
  memory_used_percent?: number | null;
  database_path?: string | null;
  database_size_bytes?: number | null;
  run_count: number;
  result_count: number;
  comparison_count: number;
  report_count: number;
  alert_count: number;
  cleanup_candidate_run_count: number;
  cleanup_skipped_baseline_run_count: number;
};

export type RunLogCleanupResult = {
  dry_run: boolean;
  deleted_runs: number;
  deleted_run_channels: number;
  deleted_results: number;
  deleted_comparisons: number;
  deleted_reports: number;
  deleted_alerts: number;
  cleared_scheduled_last_run_refs: number;
  skipped_running_runs: number;
  skipped_baseline_runs: number;
};

export type RunMode = 'full_comparison' | 'baseline_build' | 'candidate_eval' | 'manual_probe' | 'performance_benchmark' | 'arena_comparison';
export type TestScope = 'quick' | 'full' | 'scheduled_probe';

export type ScheduledProbeModelRequest = {
  key?: string | null;
  title?: string | null;
  status?: 'ok' | 'error' | string;
  channel_id?: string | null;
  channel_name?: string | null;
  result_id?: string | null;
  message_id?: string | null;
  request_id?: string | null;
  message_channel_type?: string | null;
  request_protocol?: string | null;
  provider_endpoint?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  labels?: string[];
  score?: number | null;
  error?: string | null;
};

export type PatrolAiJudgeEvidence = {
  enabled?: boolean;
  attempted?: boolean;
  fallback?: boolean;
  judge_channel_id?: string | null;
  judge_channel_name?: string | null;
  classification_status?: 'claude' | 'aws_resource' | 'anomaly' | string | null;
  classification_label?: string | null;
  confidence?: number | null;
  reason?: string | null;
  evidence_refs?: string[];
  recommended_labels?: string[];
  error?: string | null;
};

export type RunChannel = {
  id: string;
  run_id: string;
  channel_id: string;
  role_in_run: string;
};

export type Result = {
  id: string;
  run_id: string;
  test_case_id: string;
  channel_id: string;
  attempt_index: number;
  normalized_response?: ResponsePayload | null;
  raw_request?: JsonObject | null;
  raw_response?: ResponsePayload | null;
  metrics?: MetricsPayload | null;
  score: number;
  labels?: string[] | null;
  created_at?: string | null;
};

export type BaselineSnapshot = {
  id: string;
  name: string;
  suite_id: string;
  source_run_id?: string | null;
  status: 'building' | 'ready' | 'expired' | 'invalid' | 'failed';
  suite_fingerprint?: string | null;
  request_fingerprint?: string | null;
  channel_fingerprint?: string | null;
  channel_ids?: string[] | null;
  expires_at?: string | null;
  ready_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type BaselineResult = {
  id: string;
  baseline_snapshot_id: string;
  test_case_id: string;
  channel_id: string;
  role_in_baseline: string;
  attempt_index: number;
  normalized_response?: ResponsePayload | null;
  raw_request?: JsonObject | null;
  raw_response?: ResponsePayload | null;
  metrics?: MetricsPayload | null;
  score: number;
  labels?: string[] | null;
  created_at?: string | null;
};

export type Comparison = {
  id: string;
  run_id: string;
  test_case_id: string;
  candidate_channel_id: string;
  gold_similarity: number;
  official_cloud_similarity: number;
  protocol_score: number;
  capability_score: number;
  final_score: number;
  labels?: string[] | null;
};

export type Report = {
  id: string;
  run_id: string;
  channel_id: string;
  final_score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E';
  summary?: string | null;
  evidence?: ReportEvidence | null;
  markdown?: string | null;
  created_at?: string | null;
};

export type TestSuiteBundle = {
  suite: Partial<TestSuite>;
  cases: Array<Partial<TestCase>>;
};

export type ReportComparePredictionCell = {
  result?: Result | null;
  comparison?: Comparison | null;
  labels: string[];
  score?: number | null;
  latency_ms?: number | null;
};

export type ReportComparePredictionRow = {
  test_case_id: string;
  title: string;
  module: string;
  sort_order: number;
  prompt: string;
  reports: Record<string, ReportComparePredictionCell | null>;
};

export type ReportCompareMatrixRow = Record<string, any> & {
  dimension?: string;
  report_id?: string;
  channel_id?: string;
  channel_name?: string;
  success_rate?: number | null;
  p95_latency_ms?: number | null;
  avg_ttft_ms?: number | null;
  avg_tpot_ms?: number | null;
  avg_tokens_per_second?: number | null;
  failure_rate?: number | null;
};

export type ReportCompareScoreRow = ReportCompareMatrixRow;
export type ReportComparePerformanceRow = ReportCompareMatrixRow;

export type TestSuiteDiff = {
  suite_id: string;
  against: string;
  added: string[];
  removed: string[];
  changed: Array<{ id: string; fields: string[] }>;
  unchanged: string[];
};

export type TestSuiteValidation = {
  suite_id: string;
  ok: boolean;
  issue_count: number;
  issues: Array<{
    severity: 'error' | 'warning' | 'info' | string;
    case_id?: string | null;
    field?: string | null;
    message: string;
  }>;
};

export type TestSuiteCoverage = {
  suite_id: string;
  case_count: number;
  enabled_count: number;
  quick_count: number;
  by_module: Record<string, number>;
  by_task_type: Record<string, number>;
  by_difficulty: Record<string, number>;
  by_risk_dimension: Record<string, number>;
  coverage_tags: Record<string, number>;
  missing_metadata: Record<string, number>;
};

export type SamplePlan = {
  suite_id: string;
  test_scope: TestScope;
  total_available: number;
  selected_count: number;
  filters: JsonObject;
  cases: TestCase[];
  group_counts: Record<string, number>;
};

export type PerformanceSummary = {
  request_count?: number;
  error_count?: number;
  success_rate?: number;
  avg_score?: number | null;
  avg_latency_ms?: number | null;
  p50_latency_ms?: number | null;
  p95_latency_ms?: number | null;
  p99_latency_ms?: number | null;
  avg_ttft_ms?: number | null;
  avg_tpot_ms?: number | null;
  avg_tokens_per_second?: number | null;
  latency_avg_ms?: number | null;
  latency_p50_ms?: number | null;
  latency_p95_ms?: number | null;
  latency_p99_ms?: number | null;
  first_token_avg_ms?: number | null;
  first_token_p95_ms?: number | null;
  success_count: number;
  failure_count: number;
  failure_rate: number;
  slow_case_ids: string[];
};

export type ReportSummary = {
  report_id: string;
  run_id: string;
  run_name: string;
  mode: RunMode;
  channel_id: string;
  channel_name: string;
  channel_role: string;
  suite_id: string;
  grade: Report['grade'];
  final_score: number;
  summary?: string | null;
  labels: string[];
  dimension_scores: Record<string, number | null | undefined>;
  performance: PerformanceSummary;
  created_at?: string | null;
};

export type ReportPredictionRow = {
  test_case_id: string;
  title: string;
  module: string;
  sort_order: number;
  prompt: string;
  system_prompt?: string | null;
  request_params?: Record<string, any> | null;
  scoring_rules?: Record<string, any> | null;
  result?: Result | null;
  baseline_results: BaselineResult[];
  comparison?: Comparison | null;
  labels: string[];
  score?: number | null;
  latency_ms?: number | null;
};

export type ReportDetail = {
  report: Report;
  run: Run;
  channel: Channel;
  suite?: TestSuite | null;
  cases: TestCase[];
  results: Result[];
  comparisons: Comparison[];
  baseline_results: BaselineResult[];
  prediction_rows: ReportPredictionRow[];
  performance_summary: PerformanceSummary;
};

export type ReportCompare = {
  mode: RunMode;
  reports: ReportSummary[];
  dimensions: string[];
  score_matrix: ReportCompareMatrixRow[];
  prediction_rows: ReportComparePredictionRow[];
  label_diff: Record<string, string[]>;
  performance_matrix: ReportCompareMatrixRow[];
};

export type RunResults = {
  run: Run;
  run_channels: RunChannel[];
  results: Result[];
  comparisons: Comparison[];
  reports: Report[];
  baseline_snapshot?: BaselineSnapshot | null;
  baseline_results: BaselineResult[];
};

export type RunSummary = {
  run: Run;
  channel_count: number;
  result_count: number;
  comparison_count: number;
  report_count: number;
  avg_score?: number | null;
  avg_latency_ms?: number | null;
  avg_ttft_ms?: number | null;
  avg_tpot_ms?: number | null;
  avg_tokens_per_second?: number | null;
  success_rate?: number | null;
  p95_latency_ms?: number | null;
  grade_distribution: Record<string, number>;
  label_distribution: Record<string, number>;
  performance_by_channel: ReportCompareMatrixRow[];
  arena_rankings: Array<JsonObject & {
    channel_id?: string;
    score?: number | null;
    win_rate?: number | null;
    avg_case_score?: number | null;
    wins?: number | null;
    pair_count?: number | null;
    case_count?: number | null;
    labels?: string[] | null;
  }>;
  top_evidence: Array<JsonObject & {
    test_case_id?: string;
    winner_channel_id?: string;
    loser_channel_id?: string;
    winner_score?: number | null;
    loser_score?: number | null;
    margin?: number | null;
    labels?: string[] | null;
  }>;
};

export type ScheduledChannelTest = {
  id: string;
  name: string;
  channel_id: string;
  suite_id?: string | null;
  baseline_snapshot_id?: string | null;
  enabled: boolean;
  interval_minutes: number;
  run_window_start?: string | null;
  run_window_end?: string | null;
  test_scope: TestScope;
  repeat_count: number;
  concurrency: number;
  use_mock: boolean;
  alert_grade_threshold: 'C' | 'D' | 'E';
  alert_score_threshold?: number | null;
  alert_red_flags_enabled: boolean;
  quiet_minutes: number;
  max_retries: number;
  retry_interval_minutes: number;
  locked_by?: string | null;
  locked_until?: string | null;
  last_queued_at?: string | null;
  last_started_at?: string | null;
  last_finished_at?: string | null;
  is_stale?: boolean;
  next_run_at?: string | null;
  last_run_id?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  latest_report_id?: string | null;
  latest_grade?: Report['grade'] | null;
  latest_score?: number | null;
  latest_probe_summary?: {
    model_requests?: ScheduledProbeModelRequest[];
    model_request?: ScheduledProbeModelRequest;
    signature_interop?: {
      status?: 'pass' | 'fail' | 'skipped' | string;
      reason?: string | null;
      source_channel_id?: string | null;
      source_channel_name?: string | null;
      relay_channel_id?: string | null;
      relay_channel_name?: string | null;
      source_message_id?: string | null;
      source_message_channel_type?: string | null;
      relay_message_id?: string | null;
      relay_message_channel_type?: string | null;
      signature_prefixes?: string[];
    };
    labels?: string[];
    label_explanations?: Array<{ label: string; description: string }>;
    detected_provider_hint?: string | null;
    classification_status?: 'claude' | 'aws_resource' | 'anomaly' | string | null;
    classification_label?: string | null;
    classification_reason?: string | null;
    ai_judge?: PatrolAiJudgeEvidence | null;
  } | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type ChannelAlertStatus = 'pending_review' | 'confirmed_issue' | 'false_positive' | 'resolved';

export type ChannelAlert = {
  id: string;
  scheduled_test_id?: string | null;
  run_id: string;
  report_id: string;
  channel_id: string;
  status: ChannelAlertStatus;
  severity: 'high' | 'critical' | string;
  grade: Report['grade'];
  final_score: number;
  trigger_labels?: string[] | null;
  message?: string | null;
  dedupe_key?: string | null;
  notification_status: 'pending' | 'sent' | 'failed' | 'skipped' | string;
  notification_error?: string | null;
  notification_attempt_count?: number;
  last_notification_attempt_at?: string | null;
  evidence_summary?: JsonObject | null;
  notified_at?: string | null;
  reviewer_name?: string | null;
  review_note?: string | null;
  reviewed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type ScheduledTestsHealth = {
  enabled: boolean;
  instance_id: string;
  last_tick_at?: string | null;
  stale_schedule_count: number;
  overdue_schedule_count?: number;
  overdue_job_count?: number;
  stale_attempt_count?: number;
  heartbeat_stale?: boolean;
  active_task_count?: number;
  max_concurrent_tasks?: number;
  last_recovery_count?: number;
  last_recovery_error?: string | null;
  queued_schedule_count: number;
  running_schedule_count: number;
  next_due_at?: string | null;
};

export type FeishuBroadcastSetting = {
  id: string;
  enabled: boolean;
  webhook_configured: boolean;
  webhook_preview?: string | null;
  secret_configured: boolean;
  app_base_url?: string | null;
  alert_broadcast_enabled: boolean;
  daily_report_enabled: boolean;
  daily_report_time: string;
  timezone: string;
  last_daily_report_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type FeishuBroadcastUpdate = {
  enabled?: boolean;
  webhook_url?: string | null;
  webhook_secret?: string | null;
  clear_webhook_secret?: boolean;
  app_base_url?: string | null;
  alert_broadcast_enabled?: boolean;
  daily_report_enabled?: boolean;
  daily_report_time?: string;
  timezone?: string;
};

export type SmartPatrolChannelSummary = {
  channel_id: string;
  channel_name: string;
  channel_provider_type?: string | null;
  channel_account_type?: string | null;
  channel_model_name?: string | null;
  run_count: number;
  alert_count: number;
  pending_review_count: number;
  last_run_at?: string | null;
};

export type SamplePlanCreate = {
  suite_id: string;
  test_scope?: string;
  modules?: string[];
  task_types?: string[];
  coverage_tags?: string[];
  difficulties?: string[];
  risk_dimensions?: string[];
  limit?: number | null;
  per_group_limit?: number | null;
  group_by?: string;
};

export type SmartPatrolTrendPoint = {
  date: string;
  run_count: number;
  alert_count: number;
};

export type SmartPatrolReport = {
  from_at: string;
  to_at: string;
  schedule_count: number;
  enabled_schedule_count: number;
  run_count: number;
  completed_run_count: number;
  failed_run_count: number;
  alert_count: number;
  pending_review_count: number;
  channel_summaries: SmartPatrolChannelSummary[];
  recent_alerts: ChannelAlert[];
  trend: SmartPatrolTrendPoint[];
};
