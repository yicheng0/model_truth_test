import type {
  BaselineResult,
  BaselineSnapshot,
  Channel,
  ChannelAlert,
  Comparison,
  FeishuBroadcastSetting,
  FeishuBroadcastUpdate,
  Report,
  Result,
  Run,
  RunResults,
  ScheduledChannelTest,
  SmartPatrolReport,
  TestCase,
  TestSuite,
} from './types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

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
  createChannel: (payload: Partial<Channel> & { auth_config?: Record<string, unknown> }) => request<Channel>('/api/channels', { method: 'POST', body: JSON.stringify(payload) }),
  updateChannel: (id: string, payload: Partial<Channel> & { auth_config?: Record<string, unknown> }) =>
    request<Channel>(`/api/channels/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteChannel: (id: string) => request<{ deleted: boolean }>(`/api/channels/${id}`, { method: 'DELETE' }),
  healthCheck: (id: string) => request<Record<string, unknown>>(`/api/channels/${id}/health-check`, { method: 'POST' }),
  suites: () => request<TestSuite[]>('/api/suites'),
  createSuite: (payload: Partial<TestSuite>) => request<TestSuite>('/api/test-suites', { method: 'POST', body: JSON.stringify(payload) }),
  cases: (suiteId?: string) => request<TestCase[]>(suiteId ? `/api/suites/${suiteId}/cases` : '/api/test-cases'),
  createCase: (payload: Partial<TestCase>) => request<TestCase>('/api/test-cases', { method: 'POST', body: JSON.stringify(payload) }),
  updateCase: (id: string, payload: Partial<TestCase>) => request<TestCase>(`/api/test-cases/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteCase: (id: string) => request<{ deleted: boolean }>(`/api/test-cases/${id}`, { method: 'DELETE' }),
  runs: () => request<Run[]>('/api/runs'),
  run: (runId: string) => request<Run>(`/api/runs/${runId}`),
  runResults: (runId: string) => request<RunResults>(`/api/runs/${runId}/results`),
  startRun: (payload: unknown) => request<Run>('/api/runs', { method: 'POST', body: JSON.stringify(payload) }),
  baselines: (suiteId?: string) => request<BaselineSnapshot[]>(suiteId ? `/api/baselines?suite_id=${encodeURIComponent(suiteId)}` : '/api/baselines'),
  baseline: (id: string) => request<BaselineSnapshot>(`/api/baselines/${id}`),
  baselineResults: (id: string) => request<BaselineResult[]>(`/api/baselines/${id}/results`),
  buildBaseline: (payload: unknown) => request<Run>('/api/baselines/build', { method: 'POST', body: JSON.stringify(payload) }),
  validateBaseline: (id: string) => request<BaselineSnapshot>(`/api/baselines/${id}/validate`, { method: 'POST' }),
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
  createRun: (payload: { name: string; suite_id: string; channel_ids?: Record<string, string[]>; repeat_count: number; concurrency: number }) =>
    request<Run>('/api/runs', { method: 'POST', body: JSON.stringify(payload) }),
  deleteRun: (id: string) => request<{ deleted: boolean }>(`/api/runs/${id}`, { method: 'DELETE' }),
  runProgress: (id: string) => request<{ percent: number; status: string; completed_jobs: number; total_jobs: number }>(`/api/runs/${id}/progress`),
  results: (runId: string) => request<Result[]>(`/api/runs/${runId}/raw-results`),
  comparisons: (runId: string) => request<Comparison[]>(`/api/runs/${runId}/comparisons`),
  reports: () => request<Report[]>('/api/reports'),
  finalize: (runId: string) => request<{ status: string }>(`/api/runs/${runId}/finalize`, { method: 'POST' }),
  reportUrl: (runId: string) => `${API_BASE}/api/runs/${runId}/report.md`,
};
