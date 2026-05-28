import type {
  BaselineResult,
  BaselineBuildCreate,
  BaselineSnapshot,
  Channel,
  ChannelCreate,
  ChannelAlert,
  CacheHitRateJobCreate,
  CacheHitRateJobStatus,
  CacheHitRateTestResult,
  ChannelTaxonomySetting,
  ChannelTaxonomyUpdate,
  ClaudeCodeCheckResult,
  ClaudeCodeHistoryDetail,
  ClaudeCodeHistoryItem,
  ClaudeCodeJobCreate,
  ClaudeCodeJobStatus,
  ClaudeCodeCheckStatus,
  ClaudeCodeRelayTestCreate,
  ClaudeCodeSourceChannel,
  ClaudeCodeTestResult,
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
  RunCreate,
  RunLogCleanupResult,
  RunMode,
  RunResults,
  RunSummary,
  SamplePlanCreate,
  ScheduledChannelTest,
  ScheduledChannelTestCreate,
  ScheduledTestsHealth,
  SignatureInteropResult,
  SmartPatrolReport,
  SystemUsage,
  SamplePlan,
  TestCaseCreate,
  TestCase,
  TestScope,
  TestSuite,
  TestSuiteBundle,
  TestSuiteCoverage,
  TestSuiteDiff,
  TestSuiteValidation,
} from './types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const ADMIN_KEY_STORAGE_KEY = 'apipro.adminApiKey';

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

type AlertFilters = {
  status?: string;
  channel_id?: string;
  id_query?: string;
  created_from?: string;
  created_to?: string;
};

function queryString(params: Record<string, string | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const trimmed = value?.trim();
    if (trimmed) search.set(key, trimmed);
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

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
    const contentType = response.headers.get('content-type') ?? '';
    let message = response.status >= 500 ? '请求失败，请稍后重试' : response.statusText || '请求失败，请稍后重试';
    if (contentType.includes('application/json')) {
      try {
        const payload = (await response.json()) as { detail?: unknown; message?: unknown };
        const detail = payload.detail ?? payload.message;
        if (typeof detail === 'string' && detail.trim()) {
          message = detail;
        } else if (detail !== undefined) {
          message = JSON.stringify(detail);
        }
      } catch {
        // Keep the fallback message when the API does not return valid JSON.
      }
    }
    throw new ApiError(message || response.statusText, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function getAdminApiKey() {
  try {
    return localStorage.getItem(ADMIN_KEY_STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function setAdminApiKey(value: string) {
  try {
    const key = value.trim();
    if (key) localStorage.setItem(ADMIN_KEY_STORAGE_KEY, key);
    else localStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
  } catch {
    // Ignore storage failures; the API will reject destructive calls without the header.
  }
}

export function hasAdminApiKey() {
  return Boolean(getAdminApiKey());
}

function adminHeaders(): HeadersInit {
  const key = getAdminApiKey();
  return key ? { 'X-Admin-Key': key } : {};
}

export const api = {
  health: () => request<{ status: string }>('/api/health'),
  systemUsage: () => request<SystemUsage>('/api/system/usage'),
  cleanupRunLogs: (dryRun = false) => request<RunLogCleanupResult>(`/api/system/cleanup-run-logs${dryRun ? '?dry_run=true' : ''}`, { method: 'POST', headers: adminHeaders() }),
  channels: () => request<Channel[]>('/api/channels'),
  createChannel: (payload: ChannelCreate) => request<Channel>('/api/channels', { method: 'POST', body: JSON.stringify(payload) }),
  updateChannel: (id: string, payload: Partial<ChannelCreate>) =>
    request<Channel>(`/api/channels/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteChannel: (id: string) => request<{ deleted: boolean }>(`/api/channels/${id}`, { method: 'DELETE', headers: adminHeaders() }),
  healthCheck: (id: string) => request<Record<string, unknown>>(`/api/channels/${id}/health-check`, { method: 'POST' }),
  signatureInteropTest: (payload: { source_channel_id: string; relay_channel_id: string; stream?: boolean }) =>
    request<SignatureInteropResult>('/api/channels/signature-interop-test', { method: 'POST', body: JSON.stringify(payload) }),
  modelRequestTest: (channelId: string, payload: { prompt: string; system_prompt?: string | null; request_params?: Record<string, unknown>; run_name?: string | null }) =>
    request<ModelRequestTestResult>(`/api/channels/${channelId}/model-request-test`, { method: 'POST', body: JSON.stringify(payload) }),
  cacheHitRateTest: (channelId: string, payload: { test_count?: number; interval_seconds?: number; warmup_wait_seconds?: number; run_name?: string | null }) =>
    request<CacheHitRateTestResult>(`/api/channels/${channelId}/cache-hit-rate-test`, { method: 'POST', body: JSON.stringify(payload) }),
  startCacheHitRateTestJob: (channelId: string, payload: { test_count?: number; interval_seconds?: number; warmup_wait_seconds?: number; run_name?: string | null }) =>
    request<CacheHitRateJobCreate>(`/api/channels/${channelId}/cache-hit-rate-test/jobs`, { method: 'POST', body: JSON.stringify(payload) }),
  cacheHitRateJob: (jobId: string) => request<CacheHitRateJobStatus>(`/api/cache-hit-rate-test/jobs/${jobId}`),
  claudeCodeTest: (channelId: string, payload: { source_channel_id?: string | null; image_url?: string | null; include_expensive_context?: boolean }) =>
    request<ClaudeCodeTestResult>(`/api/channels/${channelId}/claude-code-test`, { method: 'POST', body: JSON.stringify(payload) }),
  runClaudeCodeRelayTest: (payload: ClaudeCodeRelayTestCreate) =>
    request<ClaudeCodeTestResult>('/api/claude-code-test', { method: 'POST', body: JSON.stringify(payload) }),
  startClaudeCodeRelayTestJob: (payload: ClaudeCodeRelayTestCreate) =>
    request<ClaudeCodeJobCreate>('/api/claude-code-test/jobs', { method: 'POST', body: JSON.stringify(payload) }),
  claudeCodeRelayTestJob: (jobId: string) => request<ClaudeCodeJobStatus>(`/api/claude-code-test/jobs/${jobId}`),
  claudeCodeSourceChannels: () => request<ClaudeCodeSourceChannel[]>('/api/claude-code-test/source-channels'),
  claudeCodeHistory: () => request<ClaudeCodeHistoryItem[]>('/api/claude-code-history'),
  claudeCodeHistoryDetail: (id: string) => request<ClaudeCodeHistoryDetail>(`/api/claude-code-history/${id}`),
  deleteClaudeCodeHistory: (id: string) => request<{ deleted: boolean }>(`/api/claude-code-history/${id}`, { method: 'DELETE', headers: adminHeaders() }),
  claudeCodeCheckStatus: () => request<ClaudeCodeCheckStatus>('/api/claude-code-check/status'),
  runClaudeCodeCheck: (payload: { model?: string | null; timeout_seconds: number; max_budget_usd: number }) =>
    request<ClaudeCodeCheckResult>('/api/claude-code-check/run', { method: 'POST', body: JSON.stringify(payload) }),
  startClaudeCodeCheckJob: (payload: { model?: string | null; timeout_seconds: number; max_budget_usd: number }) =>
    request<ClaudeCodeJobCreate>('/api/claude-code-check/jobs', { method: 'POST', body: JSON.stringify(payload) }),
  claudeCodeCheckJob: (jobId: string) => request<ClaudeCodeJobStatus>(`/api/claude-code-check/jobs/${jobId}`),
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
  createCase: (payload: TestCaseCreate) => request<TestCase>('/api/test-cases', { method: 'POST', body: JSON.stringify(payload) }),
  updateCase: (id: string, payload: Partial<TestCaseCreate>) => request<TestCase>(`/api/test-cases/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteCase: (id: string) => request<{ deleted: boolean }>(`/api/test-cases/${id}`, { method: 'DELETE', headers: adminHeaders() }),
  runs: () => request<Run[]>('/api/runs'),
  run: (runId: string) => request<Run>(`/api/runs/${runId}`),
  runResults: (runId: string) => request<RunResults>(`/api/runs/${runId}/results`),
  runSummary: (runId: string) => request<RunSummary>(`/api/runs/${runId}/summary`),
  startRun: (payload: RunCreate) => request<Run>('/api/runs', { method: 'POST', body: JSON.stringify(payload) }),
  samplePlan: (payload: SamplePlanCreate) => request<SamplePlan>('/api/runs/sample-plan', { method: 'POST', body: JSON.stringify(payload) }),
  startArenaRun: (payload: ArenaRunCreatePayload) => request<Run>('/api/runs/arena', { method: 'POST', body: JSON.stringify(payload) }),
  baselines: (suiteId?: string) => request<BaselineSnapshot[]>(suiteId ? `/api/baselines?suite_id=${encodeURIComponent(suiteId)}` : '/api/baselines'),
  baseline: (id: string) => request<BaselineSnapshot>(`/api/baselines/${id}`),
  baselineResults: (id: string) => request<BaselineResult[]>(`/api/baselines/${id}/results`),
  buildBaseline: (payload: BaselineBuildCreate) => request<Run>('/api/baselines/build', { method: 'POST', body: JSON.stringify(payload) }),
  validateBaseline: (id: string) => request<BaselineSnapshot>(`/api/baselines/${id}/validate`, { method: 'POST' }),
  updateBaseline: (id: string, payload: { name: string }) => request<BaselineSnapshot>(`/api/baselines/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteBaseline: (id: string) => request<{ deleted: boolean }>(`/api/baselines/${id}`, { method: 'DELETE', headers: adminHeaders() }),
  scheduledTests: () => request<ScheduledChannelTest[]>('/api/scheduled-tests'),
  scheduledTestsHealth: async () => {
    try {
      return await request<ScheduledTestsHealth>('/api/scheduled-tests/health');
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status >= 500)) return null;
      throw error;
    }
  },
  createScheduledTest: (payload: ScheduledChannelTestCreate) => request<ScheduledChannelTest>('/api/scheduled-tests', { method: 'POST', body: JSON.stringify(payload) }),
  updateScheduledTest: (id: string, payload: Partial<ScheduledChannelTestCreate>) =>
    request<ScheduledChannelTest>(`/api/scheduled-tests/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteScheduledTest: (id: string) => request<{ deleted: boolean }>(`/api/scheduled-tests/${id}`, { method: 'DELETE', headers: adminHeaders() }),
  runScheduledTestNow: (id: string) => request<ScheduledChannelTest>(`/api/scheduled-tests/${id}/run-now`, { method: 'POST' }),
  alerts: (filters?: string | AlertFilters) => {
    if (typeof filters === 'string') {
      return request<ChannelAlert[]>(`/api/alerts${queryString({ status: filters })}`);
    }
    return request<ChannelAlert[]>(`/api/alerts${queryString(filters ?? {})}`);
  },
  reviewAlert: (id: string, payload: { status: string; reviewer_name: string; review_note?: string }) =>
    request<ChannelAlert>(`/api/alerts/${id}/review`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteAlert: (id: string) => request<{ deleted: boolean }>(`/api/alerts/${id}`, { method: 'DELETE', headers: adminHeaders() }),
  deleteAlerts: (ids: string[]) => request<{ deleted: number; missing: string[] }>('/api/alerts/bulk-delete', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ ids }) }),
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
  createRun: (payload: RunCreate) =>
    request<Run>('/api/runs', { method: 'POST', body: JSON.stringify(payload) }),
  cancelRun: (id: string) => request<{ status: string }>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  deleteRun: (id: string) => request<{ deleted: boolean }>(`/api/runs/${id}`, { method: 'DELETE', headers: adminHeaders() }),
  deleteRuns: (ids: string[]) => request<{ deleted: number; missing: string[]; failed: Record<string, string> }>('/api/runs/bulk-delete', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ ids }) }),
  runProgress: (id: string) => request<{ percent: number; status: string; completed_jobs: number; total_jobs: number }>(`/api/runs/${id}/progress`),
  results: (runId: string) => request<Result[]>(`/api/runs/${runId}/raw-results`),
  comparisons: (runId: string) => request<Comparison[]>(`/api/runs/${runId}/comparisons`),
  reports: () => request<Report[]>('/api/reports'),
  reportSummaries: () => request<ReportSummary[]>('/api/reports/summary'),
  reportDetail: (id: string) => request<ReportDetail>(`/api/reports/${id}/detail`),
  deleteReport: (id: string) => request<{ deleted: boolean }>(`/api/reports/${id}`, { method: 'DELETE', headers: adminHeaders() }),
  deleteReports: (ids: string[]) => request<{ deleted: number; missing: string[] }>('/api/reports/bulk-delete', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ ids }) }),
  compareReports: (ids: string[]) => request<ReportCompare>(`/api/reports/compare?ids=${encodeURIComponent(ids.join(','))}`),
  finalize: (runId: string) => request<{ status: string }>(`/api/runs/${runId}/finalize`, { method: 'POST' }),
  reportUrl: (runId: string) => `${API_BASE}/api/runs/${runId}/report.md`,
};
