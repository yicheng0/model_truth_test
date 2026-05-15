import type { Run, RunResults } from './types';

export type PatrolModelRequestEvidence = {
  key?: string | null;
  title?: string | null;
  status: string;
  resultId?: string | null;
  messageId?: string | null;
  messageChannelType?: string | null;
  requestProtocol?: string | null;
  providerEndpoint?: string | null;
  labels: string[];
  score?: number | null;
  error?: string | null;
};

export type PatrolSignatureEvidence = {
  status?: string | null;
  reason?: string | null;
  sourceChannelId?: string | null;
  sourceMessageId?: string | null;
  sourceMessageChannelType?: string | null;
  relayChannelId?: string | null;
  relayMessageId?: string | null;
  relayMessageChannelType?: string | null;
  signaturePrefixes: string[];
};

export type PatrolEvidence = {
  reportId: string;
  grade: string;
  score: number;
  summary?: string | null;
  labels: string[];
  labelExplanations: Record<string, string>;
  detectedProviderHint?: string | null;
  modelRequests: PatrolModelRequestEvidence[];
  signature?: PatrolSignatureEvidence | null;
};

export function splitRunsByPatrol(runs: Run[]) {
  return {
    normalRuns: runs.filter((run) => !run.scheduled_test_id),
    patrolRuns: runs.filter((run) => Boolean(run.scheduled_test_id)),
  };
}

export function extractPatrolEvidence(results: RunResults): PatrolEvidence | null {
  const report = results.reports.find((item) => {
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

  return {
    reportId: report.id,
    grade: report.grade,
    score: report.final_score,
    summary: report.summary,
    labels: asStringArray(evidence.labels),
    labelExplanations: asStringRecord(evidence.label_explanations),
    detectedProviderHint: asNullableString(evidence.detected_provider_hint),
    modelRequests,
    signature: normalizeSignature(asRecord(evidence.signature_interop)),
  };
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
    resultId: asNullableString(item.result_id),
    messageId: asNullableString(item.message_id),
    messageChannelType: asNullableString(item.message_channel_type),
    requestProtocol: asNullableString(item.request_protocol),
    providerEndpoint: asNullableString(item.provider_endpoint),
    labels,
    score: asNullableNumber(item.score),
    error,
  };
}

function normalizeSignature(item: Record<string, unknown> | null): PatrolSignatureEvidence | null {
  if (!item) return null;
  return {
    status: asNullableString(item.status),
    reason: asNullableString(item.reason),
    sourceChannelId: asNullableString(item.source_channel_id),
    sourceMessageId: asNullableString(item.source_message_id),
    sourceMessageChannelType: asNullableString(item.source_message_channel_type),
    relayChannelId: asNullableString(item.relay_channel_id),
    relayMessageId: asNullableString(item.relay_message_id),
    relayMessageChannelType: asNullableString(item.relay_message_channel_type),
    signaturePrefixes: asStringArray(item.signature_prefixes),
  };
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
