import type { Channel, Comparison, Report, Result, Run, RunResults, TestCase, TestSuite } from './types';

const API_BASE = '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
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
  runs: () => request<Run[]>('/api/eval-runs'),
  run: (runId: string) => request<Run>(`/api/eval-runs/${runId}`),
  runResults: (runId: string) => request<RunResults>(`/api/eval-runs/${runId}/results`),
  startRun: (payload: unknown) => request<Run>('/api/eval-runs', { method: 'POST', body: JSON.stringify(payload) }),
  createRun: (payload: { name: string; suite_id: string; channel_ids?: Record<string, string[]>; repeat_count: number; concurrency: number }) =>
    request<Run>('/api/runs', { method: 'POST', body: JSON.stringify(payload) }),
  deleteRun: (id: string) => request<{ deleted: boolean }>(`/api/runs/${id}`, { method: 'DELETE' }),
  runProgress: (id: string) => request<{ percent: number; status: string; completed_jobs: number; total_jobs: number }>(`/api/runs/${id}/progress`),
  results: (runId: string) => request<Result[]>(`/api/runs/${runId}/results`),
  comparisons: (runId: string) => request<Comparison[]>(`/api/runs/${runId}/comparisons`),
  reports: () => request<Report[]>('/api/reports'),
  finalize: (runId: string) => request<{ status: string }>(`/api/eval-runs/${runId}/finalize`, { method: 'POST' }),
  reportUrl: (runId: string) => `${API_BASE}/api/eval-runs/${runId}/report.md`,
};
