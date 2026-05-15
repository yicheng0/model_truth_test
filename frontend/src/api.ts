import type {
  BaselineResult,
  BaselineSnapshot,
  Channel,
  ChannelAlert,
  ChannelTaxonomySetting,
  ChannelTaxonomyUpdate,
  Comparison,
  FeishuBroadcastSetting,
  FeishuBroadcastUpdate,
  ModelRequestTestResult,
  Report,
  ReportCompare,
  ReportDetail,
  ReportSummary,
  Result,
  Run,
  RunMode,
  RunResults,
  RunSummary,
  ScheduledChannelTest,
  SignatureInteropResult,
  SmartPatrolReport,
  SamplePlan,
  TestCase,
  TestScope,
  TestSuite,
  TestSuiteBundle,
  TestSuiteCoverage,
  TestSuiteDiff,
  TestSuiteValidation,
} from './types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

type RunCreatePayload = {
  name: string;
  suite_id: string;
  channel_ids?: Record<string, string[]>;
  repeat_count: number;
  concurrency: number;
  mode?: RunMode;
  test_scope?: TestScope;
  baseline_snapshot_id?: string;
  use_mock?: boolean;
  runtime_credentials?: Record<string, Record<string, unknown>>;
  benchmark_config?: {
    concurrency_steps?: number[];
    duration_seconds?: number;
    warmup_requests?: number;
    target_qps?: number | null;
    sla_p95_ms?: number | null;
    max_error_rate?: number | null;
  } | null;
};

type ArenaRunCreatePayload = {
  name: string;
  suite_id: string;
  candidate_channel_ids: string[];
  judge_channel_id?: string | null;
  repeat_count: number;
  concurrency: number;
  use_mock?: boolean;
  test_scope?: TestScope;
  runtime_credentials?: Record<string, Record<string, unknown>>;
  judge_mode?: string;
  judge_rubric?: string | null;
};

type ChannelWritePayload = Partial<Omit<Channel, 'auth_config'>> & { auth_config?: Record<string, unknown> | null };

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text || response.statusText;
    try {
      const payload = JSON.parse(text) as { detail?: unknown; message?: unknown };
      const detail = payload.detail ?? payload.message;
      message = typeof detail === 'string' ? detail : JSON.stringify(detail);
    } catch {
      // Keep the raw response text when the API does not return JSON.
    }
    throw new ApiError(message || response.statusText, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string }>('/api/health'),
  channels: () => request<Channel[]>('/api/channels'),
  createChannel: (payload: ChannelWritePayload) => request<Channel>('/api/channels', { method: 'POST', body: JSON.stringify(payload) }),
  updateChannel: (id: string, payload: ChannelWritePayload) =>
    request<Channel>(`/api/channels/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteChannel: (id: string) => request<{ deleted: boolean }>(`/api/channels/${id}`, { method: 'DELETE' }),
  healthCheck: (id: string) => request<Record<string, unknown>>(`/api/channels/${id}/health-check`, { method: 'POST' }),
  signatureInteropTest: (payload: { source_channel_id: string; relay_channel_id: string; stream?: boolean }) =>
    request<SignatureInteropResult>('/api/channels/signature-interop-test', { method: 'POST', body: JSON.stringify(payload) }),
  modelRequestTest: (channelId: string, payload: { prompt: string; system_prompt?: string | null; request_params?: Record<string, unknown>; run_name?: string | null }) =>
    request<ModelRequestTestResult>(`/api/channels/${channelId}/model-request-test`, { method: 'POST', body: JSON.stringify(payload) }),
  channelModels: (id: string) => request<string[]>(`/api/channels/${id}/models`),
  suites: () => request<TestSuite[]>('/api/suites'),
  createSuite: (payload: Partial<TestSuite>) => request<TestSuite>('/api/test-suites', { method: 'POST', body: JSON.stringify(payload) }),
  importSuite: (payload: TestSuiteBundle) => request<{ suite: TestSuite; created_suite: boolean; created_cases: number; updated_cases: number; case_count: number }>('/api/test-suites/import', { method: 'POST', body: JSON.stringify(payload) }),
  importEvalScopeJsonl: (payload: { suite: Partial<TestSuite>; jsonl: string; default_module?: string; default_task_type?: string }) =>
    request<{ suite: TestSuite; created_suite: boolean; created_cases: number; updated_cases: number; case_count: number }>('/api/test-suites/import-evalscope-jsonl', { method: 'POST', body: JSON.stringify(payload) }),
  exportSuite: (suiteId: string) => request<TestSuiteBundle>(`/api/test-suites/${suiteId}/export`),
  diffSuite: (suiteId: string, against: string) => request<TestSuiteDiff>(`/api/test-suites/${suiteId}/diff?against=${encodeURIComponent(against)}`),
  validateSuite: (suiteId: string) => request<TestSuiteValidation>(`/api/test-suites/${suiteId}/validate`, { method: 'POST' }),
  suiteCoverage: (suiteId: string) => request<TestSuiteCoverage>(`/api/test-suites/${suiteId}/coverage`),
  cases: (suiteId?: string) => request<TestCase[]>(suiteId ? `/api/suites/${suiteId}/cases` : '/api/test-cases'),
  createCase: (payload: Partial<TestCase>) => request<TestCase>('/api/test-cases', { method: 'POST', body: JSON.stringify(payload) }),
  updateCase: (id: string, payload: Partial<TestCase>) => request<TestCase>(`/api/test-cases/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteCase: (id: string) => request<{ deleted: boolean }>(`/api/test-cases/${id}`, { method: 'DELETE' }),
  runs: () => request<Run[]>('/api/runs'),
  run: (runId: string) => request<Run>(`/api/runs/${runId}`),
  runResults: (runId: string) => request<RunResults>(`/api/runs/${runId}/results`),
  runSummary: (runId: string) => request<RunSummary>(`/api/runs/${runId}/summary`),
  startRun: (payload: unknown) => request<Run>('/api/runs', { method: 'POST', body: JSON.stringify(payload) }),
  samplePlan: (payload: unknown) => request<SamplePlan>('/api/runs/sample-plan', { method: 'POST', body: JSON.stringify(payload) }),
  startArenaRun: (payload: ArenaRunCreatePayload) => request<Run>('/api/runs/arena', { method: 'POST', body: JSON.stringify(payload) }),
  baselines: (suiteId?: string) => request<BaselineSnapshot[]>(suiteId ? `/api/baselines?suite_id=${encodeURIComponent(suiteId)}` : '/api/baselines'),
  baseline: (id: string) => request<BaselineSnapshot>(`/api/baselines/${id}`),
  baselineResults: (id: string) => request<BaselineResult[]>(`/api/baselines/${id}/results`),
  buildBaseline: (payload: unknown) => request<Run>('/api/baselines/build', { method: 'POST', body: JSON.stringify(payload) }),
  validateBaseline: (id: string) => request<BaselineSnapshot>(`/api/baselines/${id}/validate`, { method: 'POST' }),
  updateBaseline: (id: string, payload: { name: string }) => request<BaselineSnapshot>(`/api/baselines/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteBaseline: (id: string) => request<{ deleted: boolean }>(`/api/baselines/${id}`, { method: 'DELETE' }),
  scheduledTests: () => request<ScheduledChannelTest[]>('/api/scheduled-tests'),
  createScheduledTest: (payload: Partial<ScheduledChannelTest>) => request<ScheduledChannelTest>('/api/scheduled-tests', { method: 'POST', body: JSON.stringify(payload) }),
  updateScheduledTest: (id: string, payload: Partial<ScheduledChannelTest>) =>
    request<ScheduledChannelTest>(`/api/scheduled-tests/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteScheduledTest: (id: string) => request<{ deleted: boolean }>(`/api/scheduled-tests/${id}`, { method: 'DELETE' }),
  runScheduledTestNow: (id: string) => request<ScheduledChannelTest>(`/api/scheduled-tests/${id}/run-now`, { method: 'POST' }),
  alerts: (status?: string) => request<ChannelAlert[]>(status ? `/api/alerts?status=${encodeURIComponent(status)}` : '/api/alerts'),
  reviewAlert: (id: string, payload: { status: string; reviewer_name: string; review_note?: string }) =>
    request<ChannelAlert>(`/api/alerts/${id}/review`, { method: 'PATCH', body: JSON.stringify(payload) }),
  resendAlertNotification: (id: string) => request<ChannelAlert>(`/api/alerts/${id}/resend-notification`, { method: 'POST' }),
  feishuBroadcastSetting: () => request<FeishuBroadcastSetting>('/api/settings/feishu-broadcast'),
  updateFeishuBroadcastSetting: (payload: FeishuBroadcastUpdate) =>
    request<FeishuBroadcastSetting>('/api/settings/feishu-broadcast', { method: 'PATCH', body: JSON.stringify(payload) }),
  testFeishuBroadcast: () => request<{ ok: boolean; status: string; message: string }>('/api/settings/feishu-broadcast/test', { method: 'POST' }),
  channelTaxonomy: () => request<ChannelTaxonomySetting>('/api/settings/channel-taxonomy'),
  updateChannelTaxonomy: (payload: ChannelTaxonomyUpdate) =>
    request<ChannelTaxonomySetting>('/api/settings/channel-taxonomy', { method: 'PATCH', body: JSON.stringify(payload) }),
  smartPatrolReport: (from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const query = params.toString();
    return request<SmartPatrolReport>(`/api/scheduled-tests/report${query ? `?${query}` : ''}`);
  },
  sendSmartPatrolDailyReport: () => request<{ ok: boolean; status: string; message: string }>('/api/scheduled-tests/report/send-daily', { method: 'POST' }),
  smartPatrolReportUrl: (from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const query = params.toString();
    return `${API_BASE}/api/scheduled-tests/report.md${query ? `?${query}` : ''}`;
  },
  createRun: (payload: RunCreatePayload) =>
    request<Run>('/api/runs', { method: 'POST', body: JSON.stringify(payload) }),
  cancelRun: (id: string) => request<{ status: string }>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  deleteRun: (id: string) => request<{ deleted: boolean }>(`/api/runs/${id}`, { method: 'DELETE' }),
  runProgress: (id: string) => request<{ percent: number; status: string; completed_jobs: number; total_jobs: number }>(`/api/runs/${id}/progress`),
  results: (runId: string) => request<Result[]>(`/api/runs/${runId}/raw-results`),
  comparisons: (runId: string) => request<Comparison[]>(`/api/runs/${runId}/comparisons`),
  reports: () => request<Report[]>('/api/reports'),
  reportSummaries: () => request<ReportSummary[]>('/api/reports/summary'),
  reportDetail: (id: string) => request<ReportDetail>(`/api/reports/${id}/detail`),
  compareReports: (ids: string[]) => request<ReportCompare>(`/api/reports/compare?ids=${encodeURIComponent(ids.join(','))}`),
  finalize: (runId: string) => request<{ status: string }>(`/api/runs/${runId}/finalize`, { method: 'POST' }),
  reportUrl: (runId: string) => `${API_BASE}/api/runs/${runId}/report.md`,
};
