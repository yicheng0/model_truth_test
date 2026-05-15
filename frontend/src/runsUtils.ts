import type { Result, Run, RunResults } from './types';

export type PatrolModelRequestEvidence = {
  key?: string | null;
  title?: string | null;
  status: string;
  channelId?: string | null;
  channelName?: string | null;
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
  sourceChannelId?: string | null;
  sourceChannelName?: string | null;
  sourceMessageId?: string | null;
  sourceRequestId?: string | null;
  sourceMessageChannelType?: string | null;
  relayChannelId?: string | null;
  relayChannelName?: string | null;
  relayMessageId?: string | null;
  relayRequestId?: string | null;
  relayMessageChannelType?: string | null;
  signaturePrefixes: string[];
};

export type PatrolEvidence = {
  reportId: string;
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
  const resultById = new Map(results.results.map((item) => [item.id, item]));
  const hydratedModelRequests = modelRequests.map((item) => hydrateModelRequest(item, resultById.get(item.resultId ?? '')));

  return {
    reportId: report.id,
    summary: report.summary,
    labels: asStringArray(evidence.labels),
    labelExplanations: asLabelExplanationRecord(evidence.label_explanations),
    detectedProviderHint: asNullableString(evidence.detected_provider_hint),
    modelRequests: hydratedModelRequests,
    signature: normalizeSignature(asRecord(evidence.signature_interop)),
  };
}

function hydrateModelRequest(item: PatrolModelRequestEvidence, result?: Result): PatrolModelRequestEvidence {
  if (!result) return item;
  return {
    ...item,
    requestId: item.requestId ?? requestIdFromPayload(result.raw_response) ?? requestIdFromPayload(result.normalized_response),
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
    resultId: asNullableString(item.result_id),
    messageId: asNullableString(item.message_id),
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
    sourceChannelId: asNullableString(item.source_channel_id),
    sourceChannelName: asNullableString(item.source_channel_name),
    sourceMessageId: asNullableString(item.source_message_id),
    sourceRequestId: asNullableString(item.source_request_id),
    sourceMessageChannelType: asNullableString(item.source_message_channel_type),
    relayChannelId: asNullableString(item.relay_channel_id),
    relayChannelName: asNullableString(item.relay_channel_name),
    relayMessageId: asNullableString(item.relay_message_id),
    relayRequestId: asNullableString(item.relay_request_id),
    relayMessageChannelType: asNullableString(item.relay_message_channel_type),
    signaturePrefixes: asStringArray(item.signature_prefixes),
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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [];
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
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
