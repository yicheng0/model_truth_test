import type { ChannelAlert } from './types';

type AlertEvidence = Record<string, unknown>;

type AlertLogTextInput = {
  alertCreatedAt: string;
  probeCompletedAt: string;
  probeTitle: string;
  channel: string;
  channelId: string;
  channelModel: string;
  probeSource: string;
  resultId: string;
  messageId: string;
  requestId: string;
  error: string;
};

const successStatuses = new Set(['false_positive', 'resolved']);

function getEvidence(alert: ChannelAlert): AlertEvidence {
  return alert.evidence_summary ?? {};
}

function asText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return '';
}

function firstRequestIdFromList(value: unknown): string {
  const request = selectedModelRequest(value);
  return firstText(request?.request_id, request?.requestId);
}

function explanationsText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      return asText(record.description);
    })
    .filter(Boolean)
    .slice(0, 2)
    .join('；');
}

function scorelessAlertMessage(value?: string | null): string {
  const text = (value ?? '').trim();
  if (!text) return '渠道自动巡检异常';
  return text
    .replace(/：评级\s*[A-E]，得分\s*\d+(?:\.\d+)?/g, '：自动巡检异常')
    .replace(/评级\s*[A-E][，,]?\s*/g, '')
    .replace(/得分\s*\d+(?:\.\d+)?/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[ ，,]+$/g, '')
    || '渠道自动巡检异常';
}

function modelRequestHasBlockingLabel(record: Record<string, unknown>): boolean {
  const labels = Array.isArray(record.labels) ? record.labels : [];
  return labels.some((label) => typeof label === 'string' && label && label !== 'provider_error_variant' && label !== 'patrol_probe_passed');
}

function selectedModelRequest(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const records = value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  return (
    records.find((record) => firstText(record.error)) ??
    records.find((record) => modelRequestHasBlockingLabel(record)) ??
    records.find((record) => firstText(record.request_id, record.requestId)) ??
    records[0] ??
    null
  );
}

function directModelRequestEvidence(evidence: AlertEvidence): Record<string, unknown> | null {
  const direct: Record<string, unknown> = {};
  for (const [from, to] of [
    ['model_request_result_id', 'result_id'],
    ['model_request_message_id', 'message_id'],
    ['model_request_request_id', 'request_id'],
    ['model_request_channel_type', 'message_channel_type'],
  ] as const) {
    const value = evidence[from];
    if (value !== undefined && value !== null) direct[to] = value;
  }
  return Object.keys(direct).length ? direct : null;
}

export function alertChannelId(alert: ChannelAlert): string {
  const evidence = getEvidence(alert);
  return firstText(evidence.channel_id, alert.channel_id);
}

export function alertChannelModel(alert: ChannelAlert): string {
  const evidence = getEvidence(alert);
  return firstText(evidence.channel_model_name);
}

export function alertChannelDisplay(alert: ChannelAlert, channelName?: string | null) {
  return firstText(channelName, alert.channel_id);
}

export function alertProbeEvidence(alert: ChannelAlert): Record<string, unknown> | null {
  const evidence = getEvidence(alert);
  return selectedModelRequest(evidence.model_requests) ?? directModelRequestEvidence(evidence);
}

export function alertProbeTitle(alert: ChannelAlert): string {
  const evidence = getEvidence(alert);
  const request = alertProbeEvidence(alert);
  const signatureReason = asText(evidence.signature_reason);
  if (!request && signatureReason) return 'Thinking Signature 互通';
  return firstText(request?.title, request?.key, signatureReason ? 'Thinking Signature 互通' : '') || '自动巡检探针';
}

export function alertProbeCompletedAt(alert: ChannelAlert): string {
  const evidence = getEvidence(alert);
  const request = alertProbeEvidence(alert);
  return firstText(
    request?.completed_at,
    request?.completedAt,
    request?.created_at,
    request?.createdAt,
    evidence.signature_completed_at,
    evidence.signature_created_at,
  );
}

export function alertResponseId(alert: ChannelAlert): string {
  const evidence = getEvidence(alert);
  const request = alertProbeEvidence(alert);
  return firstText(
    request?.message_id,
    request?.messageId,
    evidence.model_request_message_id,
    evidence.signature_relay_message_id,
    evidence.signature_source_message_id,
  );
}

export function alertOutcomeLabel(status: ChannelAlert['status']) {
  return successStatuses.has(status) ? '成功' : '失败';
}

export function alertOutcomeColor(status: ChannelAlert['status']) {
  return successStatuses.has(status) ? 'green' : 'red';
}

export function alertRequestId(alert: ChannelAlert): string {
  const evidence = getEvidence(alert);
  const request = alertProbeEvidence(alert);
  return firstText(
    request?.request_id,
    request?.requestId,
    evidence.model_request_request_id,
    evidence.signature_relay_request_id,
    evidence.signature_source_request_id,
    firstRequestIdFromList(evidence.model_requests),
  );
}

export function alertResultId(alert: ChannelAlert): string {
  const evidence = getEvidence(alert);
  const request = alertProbeEvidence(alert);
  return firstText(request?.result_id, request?.resultId, evidence.model_request_result_id);
}

export function alertProbeSource(alert: ChannelAlert): string {
  const evidence = getEvidence(alert);
  const request = alertProbeEvidence(alert);
  const channelType = firstText(request?.message_channel_type, evidence.model_request_channel_type);
  const protocol = firstText(request?.request_protocol, evidence.request_protocol);
  const endpoint = firstText(request?.provider_endpoint, evidence.provider_endpoint);
  const signatureReason = firstText(evidence.signature_reason);
  return firstText(
    channelType && protocol ? `${channelType} / ${protocol}` : channelType || protocol,
    endpoint,
    signatureReason ? `signature: ${signatureReason}` : '',
  );
}

export function alertErrorText(alert: ChannelAlert): string {
  const evidence = getEvidence(alert);
  const errorMessage = asText(evidence.error_message);
  if (errorMessage) return errorMessage;

  const request = selectedModelRequest(evidence.model_requests);
  if (request) {
    const error = firstText(request.error);
    const title = firstText(request.title, request.key);
    if (error) return title ? `${title}：${error}` : error;
    if (modelRequestHasBlockingLabel(request)) return title ? `${title}：探针触发异常标签` : '探针触发异常标签';
  }

  const signatureReason = asText(evidence.signature_reason);
  if (signatureReason) return signatureReason;

  const labels = Array.isArray(evidence.label_explanations) ? evidence.label_explanations : [];
  const explanationText = explanationsText(labels);
  if (explanationText) return explanationText;

  return scorelessAlertMessage(alert.message);
}

export function alertLogText(input: AlertLogTextInput) {
  return [
    `告警创建时间：${input.alertCreatedAt || '-'}`,
    `探针完成时间：${input.probeCompletedAt || '-'}`,
    `异常探针：${input.probeTitle || '-'}`,
    `渠道：${input.channel || '-'}`,
    `渠道 ID：${input.channelId || '-'}`,
    `渠道模型：${input.channelModel || '-'}`,
    `探针来源：${input.probeSource || '-'}`,
    `Result ID：${input.resultId || '-'}`,
    `Message ID：${input.messageId || '-'}`,
    `Request ID：${input.requestId || '-'}`,
    `报错内容：${input.error || '-'}`,
  ].join('\n');
}
