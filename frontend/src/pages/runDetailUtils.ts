import type { BaselineResult, Channel, ChannelTaxonomySetting, Comparison, Result, RunMode, RunResults, TestCase } from '../types';
import { accountTypeLabel, formatChannelDisplayName } from '../channelCredentials';
import { providerTypeLabel } from '../channelTaxonomy';
import { formatPatrolChannel } from '../runsUtils';

export type DisplayResult = Result | BaselineResult;

export type CasePanelRow = {
  key: string;
  caseItem: TestCase;
  sample?: DisplayResult;
  sampleAttempts: number;
  official?: DisplayResult;
  officialAttempts: number;
  candidate?: DisplayResult;
  candidateAttempts: number;
  comparison?: Comparison;
};

export type OutputDrawerState = {
  title: string;
  channelName: string;
  roleLabel: string;
  caseTitle: string;
  attemptIndex: number;
  score?: number;
  latency?: number;
  result?: DisplayResult;
};

export type ManualProbeRow = {
  key: string;
  title: string;
  status: string;
  channelName: string;
  channelDisplayName?: string | null;
  channelId: string;
  channelType: string;
  resultId?: string | null;
  messageId?: string | null;
  requestId?: string | null;
  requestProtocol?: string | null;
  providerEndpoint?: string | null;
  completedAt?: string | null;
  labels: string[];
  error?: string | null;
  responseText?: string | null;
  rawResponseText?: string | null;
  rawRequestText?: string | null;
  score?: number;
};

export type PatrolProbeStatusItem = Pick<ManualProbeRow, 'status' | 'labels' | 'error' | 'responseText' | 'rawResponseText'>;

export function latestResult(results?: DisplayResult[]) {
  if (!results?.length) return undefined;
  return [...results].sort((a, b) => {
    if (b.attempt_index !== a.attempt_index) return b.attempt_index - a.attempt_index;
    return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
  })[0];
}

export function responseText(result?: DisplayResult) {
  const normalized = result?.normalized_response;
  const text = normalized?.content_text;
  if (typeof text === 'string' && text.trim()) return text;
  const toolCalls = normalized?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length) return JSON.stringify(toolCalls, null, 2);
  const error = normalized?.error ?? normalized?.raw_response?.error;
  if (typeof error === 'string' && error.trim()) return `请求失败：${error}`;
  return '等待该渠道返回结果';
}

export function compactPatrolText(value?: string | null, limit = 140) {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return '-';
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function responseSnippet(result?: DisplayResult) {
  const text = responseText(result).replace(/\s+/g, ' ').trim();
  if (!result) return '等待返回';
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

export function prettyJson(value: unknown) {
  if (value === undefined || value === null) return '-';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function metricValue(value?: number) {
  return value === undefined || Number.isNaN(value) ? '-' : value.toFixed(1);
}

export function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function riskTone(score?: number) {
  if (score === undefined) return { color: 'default' as const, text: '等待对比' };
  if (score >= 85) return { color: 'green' as const, text: '接近指纹' };
  if (score >= 70) return { color: 'gold' as const, text: '轻微偏离' };
  return { color: 'red' as const, text: '明显偏离' };
}

export function rowStatus(row: CasePanelRow) {
  if (row.comparison) return { color: 'green' as const, text: '已对比' };
  if (row.official && row.candidate) return { color: 'blue' as const, text: '等待评分' };
  if (row.official || row.candidate) return { color: 'gold' as const, text: '部分返回' };
  return { color: 'default' as const, text: '排队中' };
}

export function sampleRowStatus(row: CasePanelRow) {
  if (row.sample?.normalized_response?.error) return { color: 'red' as const, text: '请求失败' };
  if (row.sample) return { color: 'green' as const, text: '已返回' };
  return { color: 'default' as const, text: '排队中' };
}

export function formatDimension(value: unknown) {
  return typeof value === 'number' ? value.toFixed(1) : '-';
}

export function labelDescription(label: string, report?: RunResults['reports'][number]) {
  const explanations = report?.evidence?.label_explanations;
  if (Array.isArray(explanations)) {
    const item = explanations.find((entry: Record<string, unknown>) => entry?.label === label);
    if (item?.description) return item.description as string;
  }
  return label;
}

export function runModeLabel(mode?: RunMode | string) {
  if (mode === 'baseline_build') return '渠道指纹提取';
  if (mode === 'manual_probe') return '模型请求探针';
  return '真实性对比';
}

export function shouldShowRunSummaryModule(input: { hasSummary: boolean; isPatrolRun: boolean; mode?: RunMode | string }) {
  return input.hasSummary && !input.isPatrolRun && input.mode !== 'manual_probe';
}

export function evidenceStatusColor(status?: string | null) {
  if (status === 'ok' || status === 'pass') return 'green';
  if (status === 'error' || status === 'fail') return 'red';
  if (status === 'skipped') return 'default';
  return 'gold';
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function toText(value: unknown) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

export function stringifyJson(value: unknown) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

export function compactText(value?: string | null, limit = 180) {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return '-';
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function channelLabel(name?: string | null, id?: string | null) {
  if (name) return name;
  return id || '-';
}

export function patrolProbeStatusText(item?: PatrolProbeStatusItem | null) {
  if (item?.status === 'ok') return '正确';
  const labels = item?.labels ?? [];
  const errorText = [item?.error, item?.responseText, item?.rawResponseText]
    .filter((value): value is string => typeof value === 'string' && Boolean(value))
    .join(' ')
    .toLowerCase();
  const isNativeRejection = labels.includes('provider_error_variant') || /400 bad request|invalid request|unsupported|not supported|temperature|thinking\.adaptive\.enabled|web_search|tool/.test(errorText);
  return isNativeRejection ? '参数不支持' : '异常';
}

export function patrolProbeStatusColor(item?: PatrolProbeStatusItem | null) {
  if (item?.status === 'ok') return 'green';
  const labels = item?.labels ?? [];
  const errorText = [item?.error, item?.responseText, item?.rawResponseText]
    .filter((value): value is string => typeof value === 'string' && Boolean(value))
    .join(' ')
    .toLowerCase();
  const isNativeRejection = labels.includes('provider_error_variant') || /400 bad request|invalid request|unsupported|not supported|temperature|thinking\.adaptive\.enabled|web_search|tool/.test(errorText);
  return isNativeRejection ? 'gold' : 'red';
}

export function manualProbeChannelType(channel?: Channel, taxonomy?: ChannelTaxonomySetting | null) {
  if (!channel) return '-';
  return [
    formatChannelDisplayName({ id: channel.id, name: channel.name, accountType: channel.auth_config?.account_type, providerType: channel.provider_type }),
    providerTypeLabel(channel.provider_type, taxonomy ?? undefined),
    accountTypeLabel(channel.auth_config?.account_type),
  ].filter(Boolean).join(' · ');
}

export function payloadRequestId(value: unknown) {
  const payload = asRecord(value);
  if (!payload) return null;
  const direct = toText(payload.request_id) ?? toText(payload.requestId);
  if (direct) return direct;
  const error = asRecord(payload.error);
  const errorRequestId = toText(error?.request_id) ?? toText(error?.requestId);
  if (errorRequestId) return errorRequestId;
  const metadata = asRecord(payload._response_metadata);
  const metadataRequestId = toText(metadata?.request_id);
  if (metadataRequestId) return metadataRequestId;
  const cloudWrapper = asRecord(payload.cloud_wrapper);
  const wrapperRequestId = toText(cloudWrapper?.request_id) ?? toText(cloudWrapper?.requestId);
  if (wrapperRequestId) return wrapperRequestId;
  const responseMetadata = asRecord(payload.ResponseMetadata);
  return toText(responseMetadata?.RequestId) ?? toText(responseMetadata?.RequestID);
}
