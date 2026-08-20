import type { Channel, PatrolAiJudgeEvidence, PatrolAnomalyGroup, PatrolAnomalySummary, ReportSummary, Result, Run, RunResults } from './types';
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
  httpStatus?: number | null;
  labels: string[];
  error?: string | null;
  responseText?: string | null;
  rawResponseText?: string | null;
  identityJsonStatus?: string | null;
  identityJsonFormat?: string | null;
  identityJsonFields?: Record<string, string> | null;
  jsonExtracted?: boolean | null;
  extraTextPresent?: boolean | null;
  promptBrandHits: string[];
  responseBrandHits: string[];
};

export type PatrolSignatureEvidence = {
  status?: string | null;
  signatureOk?: boolean | null;
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

export type PatrolTopErrorKind = 'kiro_identity_leak' | 'invalid_thinking_signature';

export type PatrolTopErrorItem = {
  runId: string;
  runName: string;
  channelId?: string | null;
  channelName?: string | null;
  createdAt?: string | null;
  kind: PatrolTopErrorKind;
  priority: number;
};

export type PatrolTopErrorSummary = {
  total: number;
  items: PatrolTopErrorItem[];
};

export function buildPatrolTopErrorSummary(
  anomalies?: PatrolAnomalySummary,
  limit = 10,
): PatrolTopErrorSummary {
  const seenRunIds = new Set<string>();
  const items = (anomalies?.strict_items ?? []).map<PatrolTopErrorItem>((item) => ({
    runId: item.run_id,
    runName: item.run_name,
    channelId: item.channel_id,
    channelName: item.channel_name,
    createdAt: item.created_at,
    kind: item.kind,
    priority: item.kind === 'kiro_identity_leak' ? 1 : 2,
  })).sort((left, right) => left.priority - right.priority).filter((item) => {
    if (seenRunIds.has(item.runId)) return false;
    seenRunIds.add(item.runId);
    return true;
  }).slice(0, Math.max(0, limit));

  return { total: anomalies?.strict_total ?? 0, items };
}

const OVERVIEW_ANOMALY_LABELS = ['kiro_identity_leak', 'signature_interop_failed'] as const;

export function extractOverviewAnomalyLabels(labels?: string[] | null): string[] {
  const labelSet = new Set(labels ?? []);
  return OVERVIEW_ANOMALY_LABELS.filter((label) => labelSet.has(label));
}

export function extractSignatureAnomalyRunIds(group?: PatrolAnomalyGroup | null): Set<string> {
  return new Set(
    (group?.items ?? [])
      .map((item) => typeof item.run_id === 'string' ? item.run_id.trim() : '')
      .filter(Boolean),
  );
}

const INVALID_THINKING_SIGNATURE_PATTERN = /invalid\s+[`'“”]?signature[`'“”]?\s+in\s+[`'“”]?thinking[`'”’']?\s+block/i;

const OPERATIONAL_FAILURE_LABELS = new Set([
  'provider_temporarily_unavailable',
  'provider_quota_or_balance_exhausted',
  'provider_request_failed',
]);
const OPERATIONAL_FAILURE_TEXT_PATTERN = /\b5\d\d\b|internal server error|service unavailable|bad gateway|gateway timeout|request timeout|timed out|connection (?:failed|error|reset)|network error|no available channel|no available accounts?|temporar(?:y|ily) unavailable|upstream unavailable|provider unavailable|access forbidden|not allowed for this account|not allowed for (?:this|the) (?:account|model)|permission denied|access denied|please contact administrator|额度不足|余额不足|暂无可用账号|quota(?:\s+or\s+balance)?\s+(?:is\s+)?(?:exhausted|insufficient|exceeded)|insufficient\s+(?:quota|balance|credit)/i;

const NON_REPORTABLE_PATROL_LABELS = new Set([
  ...OPERATIONAL_FAILURE_LABELS,
  'patrol_probe_passed',
  'patrol_probe_claude',
  'patrol_ai_reviewed',
  'provider_error_variant',
  'identity_probe_failed',
  'identity_uncertain',
]);

export type PatrolOperationalFailureInput = {
  status?: string | null;
  labels?: string[] | null;
  error?: string | null;
  reason?: string | null;
  rawError?: string | null;
  responseText?: string | null;
  rawResponseText?: string | null;
  httpStatus?: number | null;
  errorHttpStatus?: number | null;
};

export function isPatrolOperationalFailure(item?: PatrolOperationalFailureInput | null): boolean {
  if (!item) return false;
  const errorText = [item.error, item.reason, item.rawError, item.responseText, item.rawResponseText].filter(Boolean).join(' ');
  if (item.errorHttpStatus === 400 && INVALID_THINKING_SIGNATURE_PATTERN.test(errorText)) return false;
  const httpStatus = item.httpStatus ?? item.errorHttpStatus ?? null;
  if (httpStatus === 403 || (httpStatus !== null && httpStatus >= 500)) return true;
  if ((item.labels ?? []).some((label) => OPERATIONAL_FAILURE_LABELS.has(label))) return true;
  return OPERATIONAL_FAILURE_TEXT_PATTERN.test(errorText);
}

export function countedPatrolModelRequests(items: PatrolModelRequestEvidence[]): PatrolModelRequestEvidence[] {
  return items.filter((item) => !isPatrolOperationalFailure(item));
}

export type PatrolEvidenceDisplayState = {
  displayState: 'ok' | 'error';
  isOperationalFailure: boolean;
  hasRealAnomaly: boolean;
};

export type PatrolSignatureDisplayState = {
  state: 'passed' | 'rejected' | 'unknown';
  label: string;
  color: 'green' | 'red' | 'default';
  showFailureAlert: boolean;
  showAiJudge: boolean;
};

export type PatrolInlineError = {
  kind: 'operational' | 'signature' | 'probe';
  text: string;
  fullText: string;
  source: 'model_request' | 'signature' | 'classification' | 'summary' | 'label';
};

function normalizedPatrolErrorText(value?: string | null): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text || null;
}

function patrolErrorKind(item: PatrolOperationalFailureInput, text: string): PatrolInlineError['kind'] {
  if (isPatrolOperationalFailure(item)) return 'operational';
  if (INVALID_THINKING_SIGNATURE_PATTERN.test(text)) return 'signature';
  return 'probe';
}

export function patrolInlineError(evidence: PatrolEvidence): PatrolInlineError | null {
  for (const item of evidence.modelRequests) {
    if (item.status === 'ok' && !item.error && !item.labels.length) continue;
    const fullText = normalizedPatrolErrorText(item.error ?? item.responseText ?? item.rawResponseText);
    if (!fullText) continue;
    return {
      kind: patrolErrorKind(item, fullText),
      text: fullText,
      fullText,
      source: 'model_request',
    };
  }

  const signature = evidence.signature;
  if (signature && (signature.status === 'fail' || signature.status === 'error' || signature.rawError || signature.reason)) {
    const fullText = normalizedPatrolErrorText(signature.rawError ?? signature.reason);
    if (fullText) {
      return {
        kind: patrolErrorKind(signature, fullText),
        text: fullText,
        fullText,
        source: 'signature',
      };
    }
  }

  const classification = normalizedPatrolErrorText(evidence.classificationReason);
  if (classification && patrolEvidenceDisplayState(evidence).hasRealAnomaly) {
    return { kind: 'probe', text: classification, fullText: classification, source: 'classification' };
  }
  const summary = normalizedPatrolErrorText(evidence.summary);
  if (summary && patrolEvidenceDisplayState(evidence).hasRealAnomaly) {
    return { kind: 'probe', text: summary, fullText: summary, source: 'summary' };
  }
  for (const label of evidence.labels) {
    if (label === 'patrol_probe_passed') continue;
    const explanation = normalizedPatrolErrorText(evidence.labelExplanations[label]);
    if (!explanation) continue;
    return {
      kind: OPERATIONAL_FAILURE_LABELS.has(label) ? 'operational' : 'probe',
      text: explanation,
      fullText: explanation,
      source: 'label',
    };
  }
  return null;
}

export function patrolEvidenceDisplayState(evidence: PatrolEvidence): PatrolEvidenceDisplayState {
  const modelOperational = evidence.modelRequests.map((item) => isPatrolOperationalFailure(item));
  const signatureOperational = isPatrolOperationalFailure(evidence.signature);
  const hasOperationalEvidence = modelOperational.some(Boolean) || signatureOperational
    || evidence.classificationStatus === 'operational_issue'
    || evidence.labels.some((label) => OPERATIONAL_FAILURE_LABELS.has(label));
  const hasKiro = evidence.labels.includes('kiro_identity_leak')
    || evidence.modelRequests.some((item) => item.labels.includes('kiro_identity_leak'));
  const hasExplicitSignatureFailure = (!signatureOperational && evidence.labels.includes('signature_interop_failed'))
    || (evidence.signature?.status === 'fail' || evidence.signature?.status === 'error') && !signatureOperational;
  const hasOtherAnomalyLabel = evidence.labels.some((label) => !OPERATIONAL_FAILURE_LABELS.has(label) && !['patrol_probe_passed', 'provider_error_variant', 'identity_probe_failed', 'identity_uncertain'].includes(label));
  const hasOtherModelAnomaly = evidence.modelRequests.some((item, index) => {
    if (modelOperational[index]) return false;
    if (isPatrolNativeParameterRejection(item)) return false;
    return (item.status === 'error' || item.status === 'fail' || Boolean(item.error) || item.labels.some((label) => label !== 'provider_error_variant'));
  });
  const hasUnclassifiedIdentityFailure = evidence.labels.includes('identity_probe_failed')
    && !hasOperationalEvidence;
  const hasRealAnomaly = hasKiro || hasExplicitSignatureFailure || hasOtherAnomalyLabel || hasOtherModelAnomaly || hasUnclassifiedIdentityFailure;
  return {
    displayState: hasRealAnomaly ? 'error' : 'ok',
    isOperationalFailure: hasOperationalEvidence,
    hasRealAnomaly,
  };
}

export function patrolReportedLabels(evidence: PatrolEvidence): string[] {
  if (!patrolEvidenceDisplayState(evidence).hasRealAnomaly) return [];
  return evidence.labels.filter((label) => !NON_REPORTABLE_PATROL_LABELS.has(label));
}

export function patrolSignatureDisplayState(evidence: PatrolEvidence): PatrolSignatureDisplayState {
  const signature = evidence.signature;
  const signatureErrorText = [signature?.rawError, signature?.reason].filter(Boolean).join(' ');
  const signatureRejected = signature?.signatureOk !== null
    && signature?.signatureOk !== true
    && signature?.errorHttpStatus === 400
    && INVALID_THINKING_SIGNATURE_PATTERN.test(signatureErrorText);
  const signaturePassed = signature?.signatureOk === true;
  const displayState = patrolEvidenceDisplayState(evidence);
  return {
    state: signatureRejected ? 'rejected' : signaturePassed ? 'passed' : 'unknown',
    label: signatureRejected ? 'Signature 失败' : signaturePassed ? '验证通过' : '未完成验证',
    color: signatureRejected ? 'red' : signaturePassed ? 'green' : 'default',
    showFailureAlert: signatureRejected,
    showAiJudge: Boolean(evidence.aiJudge) && (!displayState.isOperationalFailure || displayState.hasRealAnomaly),
  };
}

export type InvalidThinkingSignatureSummary = {
  requestIds: string[];
  count: number;
};

export function extractInvalidThinkingSignatureErrors(results: Result[]): InvalidThinkingSignatureSummary | null {
  const requestIds: string[] = [];
  const seenRequestIds = new Set<string>();
  let count = 0;

  for (const result of results) {
    const normalized = asRecord(result.normalized_response);
    const raw = asRecord(result.raw_response);
    const metrics = asRecord(result.metrics);
    const statusCode = [normalized, raw, metrics]
      .map((payload) => asNullableNumber(payload?.status_code) ?? asNullableNumber(payload?.http_status))
      .find((value) => value !== null);
    if (statusCode !== 400) continue;

    const errorText = [normalized, raw]
      .flatMap((payload) => payload ? [payload.error, payload.detail, payload.message, payload.error_detail] : [])
      .map((value) => typeof value === 'string' ? value : stringifyJson(value) ?? '')
      .join(' ');
    if (!INVALID_THINKING_SIGNATURE_PATTERN.test(errorText)) continue;

    count += 1;
    const requestId = result.upstream_request_id ?? requestIdFromPayload(normalized) ?? requestIdFromPayload(raw);
    if (requestId && !seenRequestIds.has(requestId)) {
      seenRequestIds.add(requestId);
      requestIds.push(requestId);
    }
  }

  return count ? { requestIds, count } : null;
}

const KIRO_SELF_REPORT_PATTERNS = [
  /(?:^|[，。！？,.!?\s])我(?:叫|是)\s*kiro\b/i,
  /\bi\s+am\s+kiro\b/i,
  /\bi['’]m\s+kiro\b/i,
];
const KIRO_SELF_REPORT_NEGATIONS = [
  /我不(?:叫|是)\s*kiro\b/i,
  /\bi(?:\s+am|'m|’m)\s+not\s+kiro\b/i,
];

export type KiroIdentityLeakSummary = {
  requestIds: string[];
  count: number;
};

export function extractKiroIdentityLeaks(results: Result[]): KiroIdentityLeakSummary | null {
  const requestIds: string[] = [];
  const seenRequestIds = new Set<string>();
  let count = 0;

  for (const result of results) {
    const normalized = asRecord(result.normalized_response);
    const raw = asRecord(result.raw_response);
    const labeled = (result.labels ?? []).includes('kiro_identity_leak');
    const responseText = [responseContentText(normalized), responseContentText(raw)].filter(Boolean).join(' ');
    const explicitSelfReport = Boolean(responseText)
      && !KIRO_SELF_REPORT_NEGATIONS.some((pattern) => pattern.test(responseText))
      && KIRO_SELF_REPORT_PATTERNS.some((pattern) => pattern.test(responseText));
    if (!labeled && !explicitSelfReport) continue;

    count += 1;
    const requestId = result.upstream_request_id ?? requestIdFromPayload(normalized) ?? requestIdFromPayload(raw);
    if (requestId && !seenRequestIds.has(requestId)) {
      seenRequestIds.add(requestId);
      requestIds.push(requestId);
    }
  }

  return count ? { requestIds, count } : null;
}

function responseContentText(payload: Record<string, unknown> | null): string {
  if (!payload) return '';
  const direct = asNullableString(payload.content_text);
  if (direct) return direct;
  if (!Array.isArray(payload.content)) return '';
  return payload.content
    .map((block) => asNullableString(asRecord(block)?.text) ?? '')
    .filter(Boolean)
    .join(' ');
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

export function filterPatrolRunsByError(
  runs: Run[],
  onlyErrors: boolean,
  stateByRunId: ReadonlyMap<string, PatrolEvidenceDisplayState['displayState']>,
): Run[] {
  if (!onlyErrors) return [...runs];
  return runs.filter((run) => stateByRunId.get(run.id) === 'error');
}

export function clampPage(current: number, total: number, pageSize: number): number {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const maxPage = Math.max(1, Math.ceil(Math.max(0, total) / safePageSize));
  return Math.min(Math.max(1, Math.floor(current)), maxPage);
}

export function resolvePatrolPage({
  requestedPage,
  responsePage,
  total,
  pageSize,
  isFetching,
}: {
  requestedPage: number;
  responsePage?: number | null;
  total: number;
  pageSize: number;
  isFetching: boolean;
}): number {
  const requested = Math.max(1, Math.floor(requestedPage));
  if (isFetching || responsePage !== requested) return requested;
  return clampPage(requested, total, pageSize);
}

export function paginateRuns(runs: Run[], current: number, pageSize: number): Run[] {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const safeCurrent = clampPage(current, runs.length, safePageSize);
  const start = (safeCurrent - 1) * safePageSize;
  return runs.slice(start, start + safePageSize);
}

export function deletablePatrolRunIds(runs: Run[]): string[] {
  return runs
    .filter((run) => run.status !== 'pending' && run.status !== 'running')
    .map((run) => run.id);
}

export type PatrolDeleteSummary = {
  selectedDeletableCount: number;
  filteredDeletableCount: number;
  hasSelectedRows: boolean;
  selectedDisabledReason: string | null;
  deleteScopeLabel: string;
};

export function buildPatrolDeleteSummary({
  selectedRuns,
  selectedRowCount,
  filteredDeletableCount,
  selectedChannel,
  selectedChannelLabel,
  onlyErrors,
}: {
  selectedRuns: Run[];
  selectedRowCount: number;
  filteredDeletableCount: number;
  selectedChannel: string;
  selectedChannelLabel: string;
  onlyErrors: boolean;
}): PatrolDeleteSummary {
  const selectedDeletableCount = deletablePatrolRunIds(selectedRuns).length;
  const hasSelectedRows = selectedRowCount > 0;
  const selectedDisabledReason = selectedDeletableCount > 0
    ? null
    : hasSelectedRows
      ? '未结束的巡检日志不能删除'
      : '请先勾选已结束日志';
  const channelScope = selectedChannel === ALL_PATROL_CHANNELS
    ? '全部渠道'
    : `渠道「${selectedChannelLabel}」`;

  return {
    selectedDeletableCount,
    filteredDeletableCount: Math.max(0, Math.floor(filteredDeletableCount)),
    hasSelectedRows,
    selectedDisabledReason,
    deleteScopeLabel: onlyErrors ? `${channelScope}的错误日志` : channelScope,
  };
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
    httpStatus: asNullableNumber(item.http_status) ?? asNullableNumber(item.status_code) ?? asNullableNumber(item.error_http_status),
    labels,
    error,
    identityJsonStatus: asNullableString(item.identity_json_status),
    identityJsonFormat: asNullableString(item.identity_json_format),
    identityJsonFields: asStringRecord(item.identity_json_fields),
    jsonExtracted: typeof item.json_extracted === 'boolean' ? item.json_extracted : null,
    extraTextPresent: typeof item.extra_text_present === 'boolean' ? item.extra_text_present : null,
    promptBrandHits: asStringArray(item.prompt_brand_hits),
    responseBrandHits: asStringArray(item.response_brand_hits),
  };
}

function normalizeSignature(item: Record<string, unknown> | null): PatrolSignatureEvidence | null {
  if (!item) return null;
  const signatureOk = typeof item.signature_ok === 'boolean'
    ? item.signature_ok
    : Object.prototype.hasOwnProperty.call(item, 'signature_ok')
      ? null
      : undefined;
  return {
    status: asNullableString(item.status),
    signatureOk,
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

export function patrolProbeStatusText(item?: Pick<PatrolModelRequestEvidence, 'status' | 'labels' | 'error' | 'responseText' | 'rawResponseText' | 'httpStatus'> | null) {
  if (item?.status === 'ok') return '正确';
  if (isPatrolOperationalFailure(item)) return '正常';
  if (isPatrolNativeParameterRejection(item)) return '参数不支持';
  return '异常';
}

export function patrolProbeStatusColor(item?: Pick<PatrolModelRequestEvidence, 'status' | 'labels' | 'error' | 'responseText' | 'rawResponseText' | 'httpStatus'> | null) {
  if (item?.status === 'ok') return 'green';
  if (isPatrolOperationalFailure(item)) return 'green';
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
