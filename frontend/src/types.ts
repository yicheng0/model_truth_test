export type Channel = {
  id: string;
  name: string;
  provider_type: string;
  role: ChannelRole;
  base_url?: string | null;
  model_name?: string | null;
  auth_config?: Record<string, unknown>;
  is_reference: boolean;
  enabled: boolean;
};

export type ChannelRole = string;

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

export type SignatureInteropResult = {
  ok: boolean;
  status: 'pass' | 'fail' | string;
  reason: string;
  source_channel_id: string;
  relay_channel_id: string;
  source_endpoint: string;
  relay_endpoint: string;
  model: string;
  thinking_block_count: number;
  signature_prefixes: string[];
  source_message_id?: string | null;
  source_message_channel_type: string;
  relay_message_id?: string | null;
  relay_message_channel_type: string;
  relay_raw_excerpt: string;
  fallback_note: string;
  steps: Array<{
    name: string;
    status: 'ok' | 'fail' | 'running' | string;
    detail: string;
    excerpt?: string | null;
  }>;
};

export type SimulatedMessageResponse = {
  provider: 'aws' | 'vertex' | 'anthropic' | string;
  message_id: string;
  message_channel_type: string;
  raw_request: Record<string, unknown>;
  raw_response: Record<string, unknown>;
  fallback_note: string;
};

export type ModelRequestTestResult = {
  run: Run;
  result: Result;
  message_id?: string | null;
  message_channel_type: string;
  request_protocol?: string | null;
  provider_endpoint?: string | null;
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
  request_params?: Record<string, unknown> | null;
  scoring_rules?: Record<string, unknown> | null;
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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'canceled';
  repeat_count: number;
  concurrency: number;
  total_jobs: number;
  completed_jobs: number;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string | null;
};

export type RunMode = 'full_comparison' | 'baseline_build' | 'candidate_eval' | 'manual_probe' | 'performance_benchmark' | 'arena_comparison';
export type TestScope = 'quick' | 'full';

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
  normalized_response?: Record<string, any> | null;
  raw_request?: Record<string, any> | null;
  raw_response?: Record<string, any> | null;
  metrics?: Record<string, any> | null;
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
  normalized_response?: Record<string, any> | null;
  raw_request?: Record<string, any> | null;
  raw_response?: Record<string, any> | null;
  metrics?: Record<string, any> | null;
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
  evidence?: Record<string, any> | null;
  markdown?: string | null;
  created_at?: string | null;
};

export type TestSuiteBundle = {
  suite: Partial<TestSuite>;
  cases: Array<Partial<TestCase>>;
};

export type TestSuiteDiff = {
  suite_id: string;
  against: string;
  added: string[];
  removed: string[];
  changed: Array<{ id: string; fields: string[] }>;
  unchanged: string[];
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
  score_matrix: Array<Record<string, any>>;
  prediction_rows: Array<{
    test_case_id: string;
    title: string;
    module: string;
    sort_order: number;
    prompt: string;
    reports: Record<string, {
      result?: Result | null;
      comparison?: Comparison | null;
      labels: string[];
      score?: number | null;
      latency_ms?: number | null;
    } | null>;
  }>;
  label_diff: Record<string, string[]>;
  performance_matrix: Array<Record<string, any>>;
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
  performance_by_channel: Array<Record<string, any>>;
  arena_rankings: Array<Record<string, any>>;
  top_evidence: Array<Record<string, any>>;
};

export type ScheduledChannelTest = {
  id: string;
  name: string;
  channel_id: string;
  suite_id: string;
  baseline_snapshot_id: string;
  enabled: boolean;
  interval_minutes: number;
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
  next_run_at?: string | null;
  last_run_id?: string | null;
  last_status?: string | null;
  last_error?: string | null;
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
  notification_status: 'pending' | 'sent' | 'failed' | 'skipped' | string;
  notification_error?: string | null;
  notified_at?: string | null;
  reviewer_name?: string | null;
  review_note?: string | null;
  reviewed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
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
  run_count: number;
  alert_count: number;
  pending_review_count: number;
  latest_grade?: Report['grade'] | null;
  latest_score?: number | null;
  avg_score?: number | null;
  last_run_at?: string | null;
};

export type SmartPatrolTrendPoint = {
  date: string;
  run_count: number;
  alert_count: number;
  avg_score?: number | null;
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
  avg_score?: number | null;
  grade_distribution: Record<string, number>;
  channel_summaries: SmartPatrolChannelSummary[];
  recent_alerts: ChannelAlert[];
  trend: SmartPatrolTrendPoint[];
};
