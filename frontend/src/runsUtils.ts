import type { Channel, PatrolAiJudgeEvidence, ReportSummary, Result, Run, RunResults } from './types';
import { formatChannelDisplayName } from './channelCredentials';

export type PatrolModelRequestEvidence = {
  key?: string | null;
  title?: string | null;
  status: string;
  channelId?: string | null;
  channelName?: string | null;
  channelProviderType?: string | null;
  channelAccountType?: string | null;
  resultId?: string | null;
  messageId?: string | null;
  requestId?: string | null;
  messageChannelType?: string | null;
  requestProtocol?: string | null;
  providerEndpoint?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
  labels: string[];
  error?: string | null;
  responseText?: string | null;
  rawResponseText?: string | null;
};

export type PatrolSignatureEvidence = {
  status?: string | null;
  reason?: string | null;
  rawError?: string | null;
  errorHttpStatus?: number | null;
  errorStage?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
  sourceChannelId?: string | null;
  sourceChannelName?: string | null;
  sourceChannelProviderType?: string | null;
  sourceChannelAccountType?: string | null;
  sourceMessageId?: string | null;
  sourceRequestId?: string | null;
  sourceMessageChannelType?: string | null;
  relayChannelId?: string | null;
  relayChannelName?: string | null;
  relayChannelProviderType?: string | null;
  relayChannelAccountType?: string | null;
  relayMessageId?: string | null;
  relayRequestId?: string | null;
  relayMessageChannelType?: string | null;
  signaturePrefixes: string[];
  requestLogs: PatrolSignatureRequestLog[];
};

export type PatrolSignatureRequestLog = {
  stage?: string | null;
  name?: string | null;
  status?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  endpoint?: string | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
  messageId?: string | null;
  requestId?: string | null;
  gatewayRequestId?: string | null;
  upstreamRequestId?: string | null;
  responseHeaderRequestId?: string | null;
  error?: string | null;
  requestExcerpt?: string | null;
  responseExcerpt?: string | null;
};

export type PatrolEvidence = {
  reportId: string;
  summary?: string | null;
  labels: string[];
  labelExplanations: Record<string, string>;
  detectedProviderHint?: string | null;
  classificationStatus?: string | null;
  classificationLabel?: string | null;
  classificationReason?: string | null;
  aiJudge?: PatrolAiJudgeEvidence | null;
  modelRequests: PatrolModelRequestEvidence[];
  signature?: PatrolSignatureEvidence | null;
};

export type PatrolChannel = {
  id?: string | null;
  name?: string | null;
  provider_type?: string | null;
  providerType?: string | null;
  account_type?: string | null;
  accountType?: string | null;
};

export type ChannelResultOverview = {
  channelId: string;
  channelName: string;
  providerType: string;
  role: string;
  enabled: boolean;
  latestReport: ReportSummary | null;
  latestRun: Run | null;
};

export const ALL_PATROL_CHANNELS = '__all_patrol_channels__';
export const UNKNOWN_PATROL_CHANNEL = '__unknown_patrol_channel__';
const PATROL_CHANNEL_NAME_PREFIX = '__patrol_channel_name__:';
const ALL_PATROL_CHANNELS_LABEL = '全部渠道';
const UNKNOWN_PATROL_CHANNEL_LABEL = '未识别渠道';

export type PatrolChannelFilterOption = {
  value: string;
  label: string;
};

const OVERVIEW_ANOMALY_LABELS = ['kiro_identity_leak', 'signature_interop_failed'] as const;

export function extractOverviewAnomalyLabels(labels?: string[] | null): string[] {
  const labelSet = new Set(labels ?? []);
  return OVERVIEW_ANOMALY_LABELS.filter((label) => labelSet.has(label));
}

export function buildChannelResultOverview(channels: Channel[], reports: ReportSummary[], runs: Run[]): ChannelResultOverview[] {
  const latestReports = new Map<string, ReportSummary>();
  for (const report of reports) {
    const existing = latestReports.get(report.channel_id);
    if (!existing || new Date(report.created_at ?? 0).getTime() > new Date(existing.created_at ?? 0).getTime()) {
      latestReports.set(report.channel_id, report);
    }
  }

  const latestRuns = new Map<string, Run>();
  for (const run of runs) {
    for (const channel of run.channels ?? []) {
      if (!channel.channel_id) continue;
      const existing = latestRuns.get(channel.channel_id);
      if (!existing || new Date(run.created_at ?? 0).getTime() > new Date(existing.created_at ?? 0).getTime()) {
        latestRuns.set(channel.channel_id, run);
      }
    }
  }

  return channels
    .map((channel) => ({
      channelId: channel.id,
      channelName: channel.name,
      providerType: channel.provider_type,
      role: channel.role,
      enabled: channel.enabled,
      latestReport: latestReports.get(channel.id) ?? null,
      latestRun: latestRuns.get(channel.id) ?? null,
    }))
    .sort((left, right) => {
      const rightTime = new Date(right.latestReport?.created_at ?? right.latestRun?.created_at ?? 0).getTime();
      const leftTime = new Date(left.latestReport?.created_at ?? left.latestRun?.created_at ?? 0).getTime();
      return rightTime - leftTime || left.channelName.localeCompare(right.channelName, 'zh-CN');
    });
}

export function splitRunsByPatrol(runs: Run[]) {
  return {
    normalRuns: runs.filter((run) => !run.scheduled_test_id),
    patrolRuns: runs.filter((run) => Boolean(run.scheduled_test_id)),
  };
}

function patrolRunChannel(run: Run) {
  const id = run.patrol_channel_id?.trim() || null;
  const name = run.patrol_channel_name?.trim() || null;
  const label = formatPatrolChannel(
    {
      id,
      name,
      providerType: run.patrol_channel_provider_type,
      accountType: run.patrol_channel_account_type,
    },
    id,
  );
  return {
    value: id ?? (name ? `${PATROL_CHANNEL_NAME_PREFIX}${name}` : UNKNOWN_PATROL_CHANNEL),
    label: label && label !== '-' ? label : (name || id || UNKNOWN_PATROL_CHANNEL_LABEL),
    isUnknown: !id && !name,
  };
}

export function buildPatrolChannelFilterOptions(runs: Run[]): PatrolChannelFilterOption[] {
  const options = new Map<string, PatrolChannelFilterOption>();
  for (const run of runs) {
    const channel = patrolRunChannel(run);
    if (!options.has(channel.value)) {
      options.set(channel.value, {
        value: channel.value,
        label: channel.isUnknown ? UNKNOWN_PATROL_CHANNEL_LABEL : channel.label,
      });
    }
  }
  return [
    { value: ALL_PATROL_CHANNELS, label: ALL_PATROL_CHANNELS_LABEL },
    ...Array.from(options.values()).sort((left, right) => left.label.localeCompare(right.label, 'zh-CN')),
  ];
}

export function filterPatrolRunsByChannel(runs: Run[], selectedChannel: string): Run[] {
  if (!selectedChannel || selectedChannel === ALL_PATROL_CHANNELS) return [...runs];
  return runs.filter((run) => patrolRunChannel(run).value === selectedChannel);
}

export function selectableRunIds(runs: Run[]) {
  return runs.filter((run) => run.status !== 'pending' && run.status !== 'running').map((run) => run.id);
}

export function removeBulkDeletedRuns(
  runs: Run[] | undefined,
  requestedIds: string[],
  result: { missing: string[]; failed: Record<string, string> },
) {
  if (!runs) return runs;
  const retainedIds = new Set([...result.missing, ...Object.keys(result.failed)]);
  const deletedIds = new Set(requestedIds.filter((id) => !retainedIds.has(id)));
  return runs.filter((run) => !deletedIds.has(run.id));
}

export function extractPatrolEvidence(results: RunResults, preferredReportId?: string | null): PatrolEvidence | null {
  const preferredReport = preferredReportId ? results.reports.find((item) => item.id === preferredReportId) : undefined;
  const report = preferredReport ?? results.reports.find((item) => {
    const evidence = asRecord(item.evidence);
    return evidence?.test_scope === 'scheduled_probe' || Boolean(evidence?.model_request) || Boolean(evidence?.signature_interop);
  }) ?? results.reports[0];
  if (!report) return null;

  const evidence = asRecord(report.evidence);
  if (!evidence) return null;

  const modelRequest = asRecord(evidence.model_request);
  const modelRequests = Array.isArray(evidence.model_requests)
    ? evidence.model_requests.map(normalizeModelRequest).filter((item): item is PatrolModelRequestEvidence => Boolean(item))
    : [];
  if (!modelRequests.length && modelRequest) {
    const normalized = normalizeModelRequest(modelRequest);
    if (normalized) modelRequests.push(normalized);
  }
  const resultById = new Map(results.results.map((item) => [item.id, item]));
  const hydratedModelRequests = modelRequests.map((item) => hydrateModelRequest(item, resultById.get(item.resultId ?? '')));

  return {
    reportId: report.id,
    summary: report.summary,
    labels: asStringArray(evidence.labels),
    labelExplanations: asLabelExplanationRecord(evidence.label_explanations),
    detectedProviderHint: asNullableString(evidence.detected_provider_hint),
    classificationStatus: asNullableString(evidence.classification_status),
    classificationLabel: asNullableString(evidence.classification_label),
    classificationReason: asNullableString(evidence.classification_reason),
    aiJudge: normalizeAiJudge(asRecord(evidence.ai_judge)),
    modelRequests: hydratedModelRequests,
    signature: normalizeSignature(asRecord(evidence.signature_interop)),
  };
}

function normalizeAiJudge(value?: Record<string, unknown> | null): PatrolAiJudgeEvidence | null {
  if (!value) return null;
  return {
    enabled: Boolean(value.enabled),
    attempted: Boolean(value.attempted),
    fallback: Boolean(value.fallback),
    judge_channel_id: asNullableString(value.judge_channel_id),
    judge_channel_name: asNullableString(value.judge_channel_name),
    classification_status: asNullableString(value.classification_status),
    classification_label: asNullableString(value.classification_label),
    confidence: typeof value.confidence === 'number' ? value.confidence : null,
    reason: asNullableString(value.reason),
    evidence_refs: asStringArray(value.evidence_refs),
    recommended_labels: asStringArray(value.recommended_labels),
    error: asNullableString(value.error),
  };
}

function hydrateModelRequest(item: PatrolModelRequestEvidence, result?: Result): PatrolModelRequestEvidence {
  if (!result) return item;
  const normalized = asRecord(result.normalized_response);
  const rawResponse = asRecord(result.raw_response);
  return {
    ...item,
    messageId: item.messageId ?? result.upstream_response_id ?? asNullableString(rawResponse?.id) ?? asNullableString(normalized?.provider_message_id),
    requestId: item.requestId ?? result.upstream_request_id ?? requestIdFromPayload(result.raw_request) ?? requestIdFromPayload(result.raw_response) ?? requestIdFromPayload(result.normalized_response),
    createdAt: item.createdAt ?? result.created_at ?? null,
    completedAt: item.completedAt ?? result.created_at ?? null,
    responseText: modelResponseText(result) ?? item.error ?? null,
    rawResponseText: stringifyJson(result.raw_response),
  };
}

function modelResponseText(result: Result): string | null {
  const normalized = asRecord(result.normalized_response);
  const error = asNullableString(normalized?.error);
  if (error) return error;
  const contentText = asNullableString(normalized?.content_text);
  if (contentText) return contentText;
  const rawError = asNullableString(asRecord(result.raw_response)?.error);
  if (rawError) return rawError;
  return stringifyJson(result.raw_response);
}

function stringifyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeModelRequest(value: unknown): PatrolModelRequestEvidence | null {
  const item = asRecord(value);
  if (!item) return null;
  const labels = asStringArray(item.labels);
  const error = asNullableString(item.error);
  return {
    key: asNullableString(item.key),
    title: asNullableString(item.title),
    status: asNullableString(item.status) ?? (error ? 'error' : labels.length ? 'error' : 'ok'),
    channelId: asNullableString(item.channel_id),
    channelName: asNullableString(item.channel_name),
    channelProviderType: asNullableString(item.channel_provider_type),
    channelAccountType: asNullableString(item.channel_account_type),
    resultId: asNullableString(item.result_id),
    messageId: asNullableString(item.response_id) ?? asNullableString(item.message_id),
    requestId: asNullableString(item.request_id),
    messageChannelType: asNullableString(item.message_channel_type),
    requestProtocol: asNullableString(item.request_protocol),
    providerEndpoint: asNullableString(item.provider_endpoint),
    createdAt: asNullableString(item.created_at),
    completedAt: asNullableString(item.completed_at),
    labels,
    error,
  };
}

function normalizeSignature(item: Record<string, unknown> | null): PatrolSignatureEvidence | null {
  if (!item) return null;
  return {
    status: asNullableString(item.status),
    reason: asNullableString(item.reason),
    rawError: asNullableString(item.raw_error),
    errorHttpStatus: asNullableNumber(item.error_http_status),
    errorStage: asNullableString(item.error_stage),
    createdAt: asNullableString(item.created_at),
    completedAt: asNullableString(item.completed_at),
    sourceChannelId: asNullableString(item.source_channel_id),
    sourceChannelName: asNullableString(item.source_channel_name),
    sourceChannelProviderType: asNullableString(item.source_channel_provider_type),
    sourceChannelAccountType: asNullableString(item.source_channel_account_type),
    sourceMessageId: asNullableString(item.source_message_id),
    sourceRequestId: asNullableString(item.source_request_id),
    sourceMessageChannelType: asNullableString(item.source_message_channel_type),
    relayChannelId: asNullableString(item.relay_channel_id),
    relayChannelName: asNullableString(item.relay_channel_name),
    relayChannelProviderType: asNullableString(item.relay_channel_provider_type),
    relayChannelAccountType: asNullableString(item.relay_channel_account_type),
    relayMessageId: asNullableString(item.relay_message_id),
    relayRequestId: asNullableString(item.relay_request_id),
    relayMessageChannelType: asNullableString(item.relay_message_channel_type),
    signaturePrefixes: asStringArray(item.signature_prefixes),
    requestLogs: Array.isArray(item.request_logs)
      ? item.request_logs.map(normalizeSignatureRequestLog).filter((entry): entry is PatrolSignatureRequestLog => Boolean(entry))
      : [],
  };
}

function normalizeSignatureRequestLog(value: unknown): PatrolSignatureRequestLog | null {
  const item = asRecord(value);
  if (!item) return null;
  return {
    stage: asNullableString(item.stage),
    name: asNullableString(item.name),
    status: asNullableString(item.status),
    startedAt: asNullableString(item.started_at),
    completedAt: asNullableString(item.completed_at),
    endpoint: asNullableString(item.endpoint),
    httpStatus: asNullableNumber(item.http_status),
    latencyMs: asNullableNumber(item.latency_ms),
    messageId: asNullableString(item.message_id),
    requestId: asNullableString(item.request_id),
    gatewayRequestId: asNullableString(item.gateway_request_id),
    upstreamRequestId: asNullableString(item.upstream_request_id),
    responseHeaderRequestId: asNullableString(item.response_header_request_id),
    error: asNullableString(item.error),
    requestExcerpt: asNullableString(item.request_excerpt),
    responseExcerpt: asNullableString(item.response_excerpt),
  };
}

function requestIdFromPayload(value: unknown): string | null {
  const payload = asRecord(value);
  if (!payload) return null;
  const direct = asNullableString(payload.request_id) ?? asNullableString(payload.requestId);
  if (direct) return direct;
  const error = asRecord(payload.error);
  const errorRequestId = asNullableString(error?.request_id) ?? asNullableString(error?.requestId);
  if (errorRequestId) return errorRequestId;
  const metadata = asRecord(payload._response_metadata);
  const metadataRequestId = asNullableString(metadata?.request_id);
  if (metadataRequestId) return metadataRequestId;
  const cloudWrapper = asRecord(payload.cloud_wrapper);
  const wrapperRequestId = asNullableString(cloudWrapper?.request_id) ?? asNullableString(cloudWrapper?.requestId);
  if (wrapperRequestId) return wrapperRequestId;
  const responseMetadata = asRecord(payload.ResponseMetadata);
  return asNullableString(responseMetadata?.RequestId) ?? asNullableString(responseMetadata?.RequestID);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [];
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export function formatPatrolChannel(channel?: PatrolChannel | Channel | null, fallbackId?: string | null) {
  const record = channel && typeof channel === 'object' ? channel as Record<string, unknown> : {};
  return formatChannelDisplayName({
    id: typeof record.id === 'string' ? record.id : undefined,
    name: typeof record.name === 'string' ? record.name : undefined,
    provider_type: typeof record.provider_type === 'string' ? record.provider_type : undefined,
    providerType: typeof record.providerType === 'string' ? record.providerType : undefined,
    account_type: typeof record.account_type === 'string' ? record.account_type : undefined,
    accountType: typeof record.accountType === 'string' ? record.accountType : undefined,
    auth_config: record.auth_config && typeof record.auth_config === 'object' ? record.auth_config as Channel['auth_config'] : undefined,
  }, fallbackId);
}

export function isPatrolNativeParameterRejection(item?: Pick<PatrolModelRequestEvidence, 'labels' | 'error' | 'responseText' | 'rawResponseText'> | null) {
  if (!item) return false;
  if (item.labels?.includes('provider_error_variant')) return true;
  const text = [item.error, item.responseText, item.rawResponseText].filter(Boolean).join(' ').toLowerCase();
  return /400 bad request|invalid request|unsupported|not supported|temperature|thinking\.adaptive\.enabled|web_search|tool/.test(text);
}

export function patrolProbeStatusText(item?: Pick<PatrolModelRequestEvidence, 'status' | 'labels' | 'error' | 'responseText' | 'rawResponseText'> | null) {
  if (item?.status === 'ok') return '正确';
  if (isPatrolNativeParameterRejection(item)) return '参数不支持';
  return '异常';
}

export function patrolProbeStatusColor(item?: Pick<PatrolModelRequestEvidence, 'status' | 'labels' | 'error' | 'responseText' | 'rawResponseText'> | null) {
  if (item?.status === 'ok') return 'green';
  if (isPatrolNativeParameterRejection(item)) return 'gold';
  return 'red';
}

function asLabelExplanationRecord(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => [asNullableString(item.label), asNullableString(item.description)] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[0]) && Boolean(entry[1])),
    );
  }
  return asStringRecord(value);
}
