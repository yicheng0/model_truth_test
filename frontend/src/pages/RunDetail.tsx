import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Drawer, Empty, Progress, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { CheckCircle2, Clock3, Eye, GitCompare, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { api, getErrorMessage } from '../api';
import { accountTypeLabel, formatChannelDisplayName } from '../channelCredentials';
import { providerTypeLabel, roleColor } from '../channelTaxonomy';
import { extractPatrolEvidence, formatPatrolChannel, type PatrolEvidence, type PatrolModelRequestEvidence } from '../runsUtils';
import { formatDateTime } from '../time';
import type { BaselineResult, Channel, ChannelTaxonomySetting, Comparison, Result, RunMode, RunResults, RunSummary, TestCase } from '../types';
import { isComboManualProbeRun, manualProbeSummaryRows } from './runDetailManualProbe';
import {
  type ArenaEvidenceRow,
  type ArenaRankingRow,
  type CasePanelRow,
  type DisplayResult,
  type ManualProbeRow,
  type OutputDrawerState,
  arrayValue,
  asRecord,
  channelLabel,
  compactPatrolText,
  compactText,
  evidenceStatusColor,
  formatDimension,
  labelDescription,
  latestResult,
  manualProbeChannelType,
  metricValue,
  numberValue,
  payloadRequestId,
  prettyJson,
  responseSnippet,
  responseText,
  riskTone,
  rowStatus,
  runModeLabel,
  sampleRowStatus,
  stringifyJson,
  toText,
} from './runDetailUtils';

function resultCell(
  channel: Channel | undefined,
  result: DisplayResult | undefined,
  attempts: number,
  baseline = false,
  baselineLabel = '渠道指纹',
  onOpen?: () => void,
) {
  return (
    <div className="result-cell">
      <div className="result-cell-title">
        <strong>{channel?.name ?? '未选择渠道'}</strong>
        {channel && baseline ? <Tag color={roleColor[channel.role]}>{baselineLabel}</Tag> : null}
      </div>
      <div className="result-cell-meta">
        <Tag>score {metricValue(result?.score)}</Tag>
        <Tag>{result?.metrics?.latency_ms ?? '-'} ms</Tag>
        <Tag>{attempts || 0} 次</Tag>
        <Tooltip title={result ? '查看输出' : '等待返回'}>
          <Button aria-label="查看输出" size="small" icon={<Eye size={14} />} disabled={!result} onClick={onOpen} />
        </Tooltip>
      </div>
      <span className="result-cell-snippet">{responseSnippet(result)}</span>
    </div>
  );
}

function comparisonCell(comparison?: Comparison) {
  const tone = riskTone(comparison?.final_score);
  return (
    <div className="result-cell">
      <div className="result-cell-title">
        <strong>{metricValue(comparison?.final_score)}</strong>
        <Tag color={tone.color}>{tone.text}</Tag>
      </div>
      <div className="result-cell-meta">
        <Tag>相似度 {metricValue(comparison?.gold_similarity)}%</Tag>
        <Tag>协议 {metricValue(comparison?.protocol_score)}</Tag>
        <Tag>能力 {metricValue(comparison?.capability_score)}</Tag>
      </div>
      <span className="result-cell-snippet">{comparison?.labels?.length ? comparison.labels.join(' / ') : '暂无异常标签'}</span>
    </div>
  );
}

function PatrolProbeDetail({ item }: { item: PatrolModelRequestEvidence }) {
  const responseText = item.responseText ?? item.rawResponseText ?? item.error ?? '-';
  return (
    <div className="patrol-probe-detail">
      <div className="patrol-probe-meta-grid">
        <div>
          <span>Result ID</span>
          <Typography.Text code copyable={item.resultId ? { text: item.resultId } : false}>{item.resultId || '-'}</Typography.Text>
        </div>
        <div>
          <span>Message ID</span>
          <Typography.Text code copyable={item.messageId ? { text: item.messageId } : false}>{item.messageId || '-'}</Typography.Text>
        </div>
        <div>
          <span>Request ID</span>
          <Typography.Text code copyable={item.requestId ? { text: item.requestId } : false}>{item.requestId || '-'}</Typography.Text>
        </div>
        <div>
          <span>Endpoint</span>
          <Typography.Text copyable={item.providerEndpoint ? { text: item.providerEndpoint } : false}>{item.providerEndpoint || '-'}</Typography.Text>
        </div>
      </div>
      <div className="patrol-probe-detail-row">
        <span>标签</span>
        <div>
          {item.labels.length ? (
            <Space wrap size={4}>{item.labels.map((label) => <Tag color="red" key={label}>{label}</Tag>)}</Space>
          ) : (
            <Typography.Text type="secondary">-</Typography.Text>
          )}
        </div>
      </div>
      <div className="patrol-probe-detail-row">
        <span>错误</span>
        <Typography.Text>{item.error || '-'}</Typography.Text>
      </div>
      <div className="patrol-probe-detail-row full">
        <span>完整响应 / 原始响应</span>
        <pre className="patrol-probe-response">{responseText}</pre>
      </div>
    </div>
  );
}

function PatrolDetailPanel({ evidence }: { evidence: PatrolEvidence | null }) {
  if (!evidence) {
    return <Empty description="暂无巡检证据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  const signature = evidence.signature;
  const classificationText = evidence.classificationLabel || (evidence.classificationStatus === 'aws_resource' ? 'AWS 资源' : evidence.classificationStatus === 'claude' ? 'Claude 渠道' : '');
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="channel-pair-grid">
        <div className="monitor-stat-card"><span>真实请求探针</span><strong>{evidence.modelRequests.length}</strong></div>
        <div className="monitor-stat-card"><span>Signature</span><strong><Tag color={evidenceStatusColor(signature?.status)}>{signature?.status ?? '待确认'}</Tag></strong></div>
      </div>
      {classificationText ? <Typography.Text type="secondary">判定：{classificationText}{evidence.classificationReason ? `，${evidence.classificationReason}` : ''}</Typography.Text> : null}
      {evidence.modelRequests[0] ? (
        <Typography.Text type="secondary">
          Message ID：{evidence.modelRequests[0].messageId ?? '-'} · Request ID：{evidence.modelRequests[0].requestId ?? '-'}
        </Typography.Text>
      ) : null}
      {evidence.detectedProviderHint ? <Typography.Paragraph className="report-summary-text">{evidence.detectedProviderHint}</Typography.Paragraph> : null}
      <Table
        className="patrol-probe-table"
        rowKey={(item) => item.key ?? item.title ?? item.resultId ?? item.messageId ?? 'model-request'}
        dataSource={evidence.modelRequests}
        pagination={false}
        scroll={{ x: 980 }}
        expandable={{
          expandedRowRender: (item) => <PatrolProbeDetail item={item} />,
          rowExpandable: () => true,
        }}
        columns={[
          { title: '参数探针', width: 220, render: (_, item) => <strong>{item.title ?? item.key ?? '真实模型请求'}</strong> },
          { title: '状态', width: 110, render: (_, item) => <Tag color={item.status === 'ok' ? 'green' : 'red'}>{item.status === 'ok' ? '正确' : '异常'}</Tag> },
          { title: '时间', width: 190, render: (_, item) => formatDateTime(item.completedAt ?? item.createdAt) },
          { title: '渠道类型', dataIndex: 'messageChannelType', width: 180, render: (value) => value ?? '-' },
          { title: '协议', dataIndex: 'requestProtocol', width: 150, render: (value) => value ?? '-' },
          {
            title: '响应摘要',
            width: 330,
            render: (_, item) => (
              <Tooltip title={item.responseText || item.rawResponseText || undefined}>
                <Typography.Text>{compactPatrolText(item.responseText ?? item.rawResponseText ?? item.error)}</Typography.Text>
              </Tooltip>
            ),
          },
        ]}
      />
      {signature ? (
        <div className="patrol-signature-panel">
          <div><span>Source</span><strong>{signature.sourceChannelId ?? '-'} / msg {signature.sourceMessageId ?? '-'} / req {signature.sourceRequestId ?? '-'}</strong></div>
          <div><span>Relay</span><strong>{signature.relayChannelId ?? '-'} / msg {signature.relayMessageId ?? '-'} / req {signature.relayRequestId ?? '-'}</strong></div>
          <div><span>Source 类型</span><strong>{signature.sourceMessageChannelType ?? '-'}</strong></div>
          <div><span>Relay 类型</span><strong>{signature.relayMessageChannelType ?? '-'}</strong></div>
        </div>
      ) : null}
      {signature?.signaturePrefixes.length ? (
        <Typography.Text type="secondary">Signature 前缀：{signature.signaturePrefixes.join(', ')}</Typography.Text>
      ) : null}
      {signature?.reason ? <Typography.Text>{signature.reason}</Typography.Text> : null}
      {evidence.labels.length ? (
        <Space wrap>{evidence.labels.map((label) => <Tag key={label} color={label === 'patrol_probe_passed' ? 'green' : 'red'}>{evidence.labelExplanations[label] ?? label}</Tag>)}</Space>
      ) : null}
    </Space>
  );
}

function manualProbeResponseText(result: DisplayResult) {
  const normalized = result.normalized_response;
  const contentText = toText(normalized?.content_text);
  if (contentText) return contentText;
  const errorText = toText(normalized?.error);
  if (errorText) return errorText;
  const rawError = asRecord(normalized?.raw_response)?.error;
  const rawErrorText = toText(rawError);
  if (rawErrorText) return rawErrorText;
  return stringifyJson(result.raw_response) ?? '等待该渠道返回结果';
}

function extractManualProbeRows(results: RunResults, cases: TestCase[], channels: Map<string, Channel>, taxonomy?: ChannelTaxonomySetting | null): ManualProbeRow[] {
  const caseById = new Map(cases.map((caseItem) => [caseItem.id, caseItem]));

  return [...results.results]
    .sort((left, right) => {
      if (left.test_case_id !== right.test_case_id) return left.test_case_id.localeCompare(right.test_case_id);
      if (right.attempt_index !== left.attempt_index) return right.attempt_index - left.attempt_index;
      return String(right.created_at ?? '').localeCompare(String(left.created_at ?? ''));
    })
    .map((result, index) => {
      const caseItem = caseById.get(result.test_case_id);
      const normalized = result.normalized_response ?? {};
      const rawResponse = asRecord(result.raw_response);
      const labels = Array.isArray(result.labels) ? result.labels.filter((label): label is string => typeof label === 'string') : [];
      const channelId = result.channel_id;
      const channel = channels.get(channelId);
      const channelName = channel?.name ?? result.channel_id;
      const status = result.score === 100 ? 'ok' : 'error';
      return {
        key: `${result.test_case_id}:${result.channel_id}:${result.attempt_index}:${index}`,
        title: caseItem?.title ?? result.test_case_id,
        status,
        channelName,
        channelId,
        channelType: manualProbeChannelType(channel, taxonomy),
        resultId: result.id,
        messageId: toText(rawResponse?.id) ?? toText(normalized.provider_message_id),
        requestId: payloadRequestId(result.raw_request) ?? payloadRequestId(normalized) ?? toText(rawResponse?.request_id) ?? toText(normalized.request_id),
        requestProtocol: toText(rawResponse?.request_protocol) ?? toText(normalized.request_protocol),
        providerEndpoint: toText(rawResponse?.provider_endpoint) ?? toText(normalized.provider_endpoint),
        completedAt: result.created_at ? String(result.created_at) : null,
        labels,
        error: toText(normalized.error) ?? toText(rawResponse?.error),
        responseText: manualProbeResponseText(result),
        rawResponseText: stringifyJson(result.raw_response),
        rawRequestText: stringifyJson(result.raw_request),
        score: result.score,
      };
    });
}

export default function RunDetail() {
  const { runId = '' } = useParams();
  const [selectedOfficialId, setSelectedOfficialId] = useState('');
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const [selectedSampleChannelId, setSelectedSampleChannelId] = useState('');
  const [outputDrawer, setOutputDrawer] = useState<OutputDrawerState | null>(null);

  const runResults = useQuery<RunResults>({
    queryKey: ['runResults', runId],
    queryFn: () => api.runResults(runId),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === 'pending' || status === 'running' ? 1800 : false;
    },
  });
  const runSummary = useQuery<RunSummary>({
    queryKey: ['runSummary', runId],
    queryFn: () => api.runSummary(runId),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === 'pending' || status === 'running' ? 1800 : false;
    },
  });
  const channelsQuery = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const taxonomyQuery = useQuery({ queryKey: ['channelTaxonomy'], queryFn: api.channelTaxonomy });
  const casesQuery = useQuery({
    queryKey: ['cases', runResults.data?.run.suite_id],
    queryFn: () => api.cases(runResults.data?.run.suite_id),
    enabled: Boolean(runResults.data?.run.suite_id),
  });

  const data = runResults.data ?? null;
  const summary = runSummary.data ?? null;
  const channels = channelsQuery.data ?? [];
  const taxonomy = taxonomyQuery.data ?? null;
  const cases = casesQuery.data ?? [];
  const isPatrolRun = Boolean(data?.run.scheduled_test_id) || data?.run.test_scope === 'scheduled_probe';
  const channelById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const patrolEvidence = useMemo(() => data ? extractPatrolEvidence(data) : null, [data]);
  const patrolChannelName = data?.run.patrol_channel_name ?? patrolEvidence?.modelRequests[0]?.channelName ?? patrolEvidence?.signature?.relayChannelName ?? null;
  const patrolChannelId = data?.run.patrol_channel_id ?? patrolEvidence?.modelRequests[0]?.channelId ?? patrolEvidence?.signature?.relayChannelId ?? null;
  const patrolChannel = patrolChannelId ? channelById.get(patrolChannelId) : undefined;
  const patrolTitle = patrolChannelName ? `${formatPatrolChannel(patrolChannel ?? { id: patrolChannelId, name: patrolChannelName, accountType: data?.run.patrol_channel_account_type }, patrolChannelId)} - 自动巡检资源日志` : '自动巡检资源日志';
  const isSamplingRun = !isPatrolRun && data?.run.mode === 'baseline_build';
  const isPerformanceRun = !isPatrolRun && data?.run.mode === 'performance_benchmark';
  const isArenaRun = !isPatrolRun && data?.run.mode === 'arena_comparison';
  const isAuthenticityRun = !isPatrolRun && (data?.run.mode === 'candidate_eval' || data?.run.mode === 'full_comparison');

  const caseById = useMemo(() => new Map(cases.map((caseItem) => [caseItem.id, caseItem])), [cases]);
  const runChannelIds = useMemo(() => new Set((data?.run_channels ?? []).map((item) => item.channel_id)), [data?.run_channels]);
  const baselineChannelIds = useMemo(() => new Set((data?.baseline_results ?? []).map((item) => item.channel_id)), [data?.baseline_results]);
  const runRoleByChannel = useMemo(() => new Map((data?.run_channels ?? []).map((item) => [item.channel_id, item.role_in_run])), [data?.run_channels]);
  const manualProbeRows = useMemo(
    () => data?.run.mode === 'manual_probe' ? extractManualProbeRows(data, cases, channelById, taxonomy) : [],
    [cases, channelById, data, taxonomy],
  );

  const sampleChannels = useMemo(
    () => channels.filter((channel) => runChannelIds.has(channel.id)),
    [channels, runChannelIds],
  );

  const officialChannels = useMemo(
    () =>
      channels.filter((channel) => {
        if (!runChannelIds.has(channel.id) && !baselineChannelIds.has(channel.id)) return false;
        const role = runRoleByChannel.get(channel.id) ?? channel.role;
        return role === 'reference' || role === 'gold' || role === 'official_cloud' || channel.is_reference;
      }),
    [baselineChannelIds, channels, runChannelIds, runRoleByChannel],
  );

  const candidateChannels = useMemo(
    () =>
      channels.filter((channel) => {
        if (!runChannelIds.has(channel.id)) return false;
        const role = runRoleByChannel.get(channel.id) ?? channel.role;
        return role === 'candidate' || role === 'negative' || !channel.is_reference;
      }),
    [channels, runChannelIds, runRoleByChannel],
  );

  useEffect(() => {
    if (officialChannels.length && !officialChannels.some((channel) => channel.id === selectedOfficialId)) {
      setSelectedOfficialId(officialChannels[0].id);
    }
  }, [officialChannels, selectedOfficialId]);

  useEffect(() => {
    if (candidateChannels.length && !candidateChannels.some((channel) => channel.id === selectedCandidateId)) {
      setSelectedCandidateId(candidateChannels[0].id);
    }
  }, [candidateChannels, selectedCandidateId]);

  useEffect(() => {
    if (sampleChannels.length && !sampleChannels.some((channel) => channel.id === selectedSampleChannelId)) {
      setSelectedSampleChannelId(sampleChannels[0].id);
    }
  }, [sampleChannels, selectedSampleChannelId]);

  const selectedOfficial = channelById.get(selectedOfficialId);
  const selectedCandidate = channelById.get(selectedCandidateId);
  const selectedSampleChannel = channelById.get(selectedSampleChannelId);

  const openOutputDrawer = (
    title: string,
    channel: Channel | undefined,
    result: DisplayResult | undefined,
    caseItem: TestCase,
    baseline = false,
    displayRoleLabel?: string,
  ) => {
    if (!channel || !result) return;
    setOutputDrawer({
      title,
      channelName: channel.name,
      roleLabel: displayRoleLabel ?? (baseline ? '渠道指纹' : channel.role),
      caseTitle: `${caseItem.title} · ${caseItem.id}`,
      attemptIndex: result.attempt_index,
      score: result.score,
      latency: result.metrics?.latency_ms,
      result,
    });
  };

  const resultByCaseChannel = useMemo(() => {
    const map = new Map<string, Result[]>();
    for (const result of data?.results ?? []) {
      const key = `${result.test_case_id}:${result.channel_id}`;
      map.set(key, [...(map.get(key) ?? []), result]);
    }
    return map;
  }, [data?.results]);

  const baselineResultByCaseChannel = useMemo(() => {
    const map = new Map<string, BaselineResult[]>();
    for (const result of data?.baseline_results ?? []) {
      const key = `${result.test_case_id}:${result.channel_id}`;
      map.set(key, [...(map.get(key) ?? []), result]);
    }
    return map;
  }, [data?.baseline_results]);

  const comparisonByCaseCandidate = useMemo(() => {
    const map = new Map<string, Comparison>();
    for (const comparison of data?.comparisons ?? []) {
      map.set(`${comparison.test_case_id}:${comparison.candidate_channel_id}`, comparison);
    }
    return map;
  }, [data?.comparisons]);

  const resultCaseIds = useMemo(() => new Set((data?.results ?? []).map((result) => result.test_case_id)), [data?.results]);
  const panelCases = useMemo(() => {
    const sortedCases = [...cases].sort((a, b) => (a.sort_order ?? 1000) - (b.sort_order ?? 1000));
    if (data?.run.status !== 'running' && resultCaseIds.size) {
      return sortedCases.filter((caseItem) => resultCaseIds.has(caseItem.id));
    }
    return sortedCases;
  }, [cases, data?.run.status, resultCaseIds]);

  const rows: CasePanelRow[] = useMemo(
    () =>
      panelCases.map((caseItem) => {
          const sampleResults = selectedSampleChannelId ? resultByCaseChannel.get(`${caseItem.id}:${selectedSampleChannelId}`) : undefined;
          const officialResults = selectedOfficialId ? resultByCaseChannel.get(`${caseItem.id}:${selectedOfficialId}`) : undefined;
          const baselineOfficialResults = selectedOfficialId ? baselineResultByCaseChannel.get(`${caseItem.id}:${selectedOfficialId}`) : undefined;
          const candidateResults = selectedCandidateId ? resultByCaseChannel.get(`${caseItem.id}:${selectedCandidateId}`) : undefined;
          return {
            key: caseItem.id,
            caseItem,
            sample: latestResult(sampleResults),
            sampleAttempts: sampleResults?.length ?? 0,
            official: latestResult(baselineOfficialResults ?? officialResults),
            officialAttempts: (baselineOfficialResults ?? officialResults)?.length ?? 0,
            candidate: latestResult(candidateResults),
            candidateAttempts: candidateResults?.length ?? 0,
            comparison: selectedCandidateId ? comparisonByCaseCandidate.get(`${caseItem.id}:${selectedCandidateId}`) : undefined,
          };
        }),
    [baselineResultByCaseChannel, comparisonByCaseCandidate, panelCases, resultByCaseChannel, selectedCandidateId, selectedOfficialId, selectedSampleChannelId],
  );

  const percent = data?.run.total_jobs ? Math.round((data.run.completed_jobs / data.run.total_jobs) * 100) : 0;
  const sampleReturnedRows = rows.filter((row) => row.sample).length;
  const arenaReturnedSamples = isArenaRun ? data?.run.completed_jobs ?? 0 : 0;
  const arenaExpectedSamples = isArenaRun ? data?.run.total_jobs ?? 0 : 0;
  const returnedRows = isSamplingRun ? sampleReturnedRows : isArenaRun ? arenaReturnedSamples : rows.filter((row) => row.official && row.candidate).length;
  const expectedRows = isArenaRun ? arenaExpectedSamples : rows.length;
  const arenaRankingIsLive = isArenaRun && (data?.run.status === 'pending' || data?.run.status === 'running');
  const comparedRows = rows.filter((row) => row.comparison).length;
  const riskyRows = rows.filter((row) => (row.comparison?.final_score ?? 100) < 70).length;
  const averageScore = rows.length
    ? rows.reduce((sum, row) => sum + (row.comparison?.final_score ?? 0), 0) / Math.max(1, comparedRows)
    : 0;
  const sampleScoreRows = rows.filter((row) => row.sample?.score !== undefined);
  const averageSampleScore = sampleScoreRows.length
    ? sampleScoreRows.reduce((sum, row) => sum + (row.sample?.score ?? 0), 0) / sampleScoreRows.length
    : 0;
  const selectedReport = data?.reports.find((report) => report.channel_id === selectedCandidateId);
  const dimensionScores = selectedReport?.evidence?.dimension_scores ?? {};
  const confidence = selectedReport?.evidence?.confidence ?? '-';
  const performanceChartData = (summary?.performance_by_channel ?? []).map((item) => ({
    name: String(item.channel_name ?? item.channel_id ?? '-'),
    p95: Number(item.p95_latency_ms ?? 0),
    ttft: Number(item.avg_ttft_ms ?? 0),
    tps: Number(item.avg_tokens_per_second ?? 0),
    success: Number(item.success_rate ?? 0),
  }));
  const arenaChartData: ArenaRankingRow[] = (summary?.arena_rankings ?? []).map((item, index) => {
    const channelId = String(item.channel_id ?? '');
    return {
      key: channelId || String(index),
      rank: index + 1,
      channelId,
      name: String(channelById.get(channelId)?.name ?? item.channel_id ?? '-'),
      score: numberValue(item.score),
      winRate: numberValue(item.win_rate),
      avgCaseScore: numberValue(item.avg_case_score),
      wins: numberValue(item.wins),
      pairCount: numberValue(item.pair_count),
      caseCount: numberValue(item.case_count),
      labels: arrayValue(item.labels).map(String),
    };
  });
  const arenaLeader = arenaChartData[0];
  const arenaRunnerUp = arenaChartData[1];
  const arenaLeadMargin = arenaLeader && arenaRunnerUp ? arenaLeader.score - arenaRunnerUp.score : null;
  const arenaMatrixSource = arrayValue(data?.reports.find((report) => Array.isArray(report.evidence?.arena_matrix))?.evidence?.arena_matrix) as Array<Record<string, unknown>>;
  const arenaMatrixChannelIds = arenaChartData.map((item) => item.channelId).filter(Boolean);
  const arenaMatrixRows = arenaMatrixSource.map((row) => {
    const channelId = String(row.channel_id ?? '');
    return {
      ...row,
      key: channelId,
      channelId,
      channelName: String(channelById.get(channelId)?.name ?? channelId),
    };
  });
  const arenaEvidenceRows: ArenaEvidenceRow[] = arrayValue(summary?.top_evidence).map((item, index) => {
    const row = item as Record<string, unknown>;
    const testCaseId = String(row.test_case_id ?? '');
    const winnerChannelId = String(row.winner_channel_id ?? '');
    const loserChannelId = String(row.loser_channel_id ?? '');
    return {
      key: `${testCaseId}:${loserChannelId}:${index}`,
      testCaseId,
      caseTitle: caseById.get(testCaseId)?.title ?? testCaseId,
      winnerChannelId,
      loserChannelId,
      winnerName: channelById.get(winnerChannelId)?.name ?? winnerChannelId,
      loserName: channelById.get(loserChannelId)?.name ?? loserChannelId,
      winnerScore: numberValue(row.winner_score),
      loserScore: numberValue(row.loser_score),
      margin: numberValue(row.margin),
      labels: arrayValue(row.labels).map(String),
    };
  });
  const labelRows = Object.entries(summary?.label_distribution ?? {}).map(([label, count]) => ({ label, count }));
  const manualProbeIsCombo = isComboManualProbeRun(data?.run.name, manualProbeRows.length);
  const manualProbeSummary = data?.run.mode === 'manual_probe'
    ? manualProbeSummaryRows(data.run.name, manualProbeRows, data.run.total_jobs)
    : [];

  if (runResults.isError || channelsQuery.isError || casesQuery.isError || runSummary.isError) {
    const error = runResults.error ?? channelsQuery.error ?? casesQuery.error ?? runSummary.error;
    return (
      <Card bordered={false}>
        <Alert
          type="error"
          showIcon
          message="任务详情加载失败"
          description={getErrorMessage(error)}
            action={<Button onClick={() => Promise.all([runResults.refetch(), runSummary.refetch(), channelsQuery.refetch(), casesQuery.refetch()])}>重试</Button>}
        />
      </Card>
    );
  }

  if (runResults.isLoading || runSummary.isLoading || channelsQuery.isLoading || casesQuery.isLoading || !data) {
    return <Card loading />;
  }

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }} className="page-stack">
      <Card
        title={<span style={{ fontSize: '20px', fontWeight: 700 }}>{data.run.name}</span>}
        extra={
          <Button
            size="large"
            href={data.reports.length ? api.reportUrl(data.run.id) : undefined}
            target="_blank"
            disabled={!data.reports.length}
            style={{ fontWeight: 600 }}
          >
            导出 Markdown
          </Button>
        }
        bordered={false}
      >
        {data.run.mode === 'manual_probe' ? (
          <Alert
            type={manualProbeIsCombo ? 'warning' : 'info'}
            showIcon
            message={manualProbeIsCombo ? '组合纯度检测日志' : '单项参数报错日志'}
            description="这里只展示参数纯度探针、原生报错、message/request id 和原始响应，不显示 Arena 或性能诊断内容。"
            style={{ marginBottom: 16 }}
          />
        ) : null}
        <Descriptions column={{ xs: 1, sm: 2, md: 4 }} style={{ marginBottom: '18px' }}>
          <Descriptions.Item label="状态">
            <Tag color={data.run.status === 'completed' ? 'green' : data.run.status === 'failed' ? 'red' : 'gold'}>
              {data.run.status}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="实时进度">{data.run.completed_jobs} / {data.run.total_jobs}</Descriptions.Item>
          <Descriptions.Item label="运行模式">{isPatrolRun ? '自动巡检' : runModeLabel(data.run.mode)}</Descriptions.Item>
          {data.run.mode === 'manual_probe' ? (
            manualProbeSummary.map((item) => (
              <Descriptions.Item key={item.label} label={item.label}>{item.value}</Descriptions.Item>
            ))
          ) : (
            <>
              <Descriptions.Item label="检测范围">{isPatrolRun ? '巡检探针' : data.run.test_scope === 'quick' ? '历史兼容检测' : '完整检测'}</Descriptions.Item>
              <Descriptions.Item label={isSamplingRun ? '渠道指纹' : '渠道指纹'}>
                {data.baseline_snapshot?.name ?? (isSamplingRun ? '指纹提取中' : '本次同步对比')}
              </Descriptions.Item>
              <Descriptions.Item label={isArenaRun ? '已返回样本' : '已返回题目'}>{returnedRows} / {expectedRows}</Descriptions.Item>
              {isPatrolRun ? (
                <Descriptions.Item label="巡检计划">{data.run.scheduled_test_id ?? '-'}</Descriptions.Item>
              ) : isSamplingRun ? (
                <Descriptions.Item label="指纹源渠道">{sampleChannels.length}</Descriptions.Item>
              ) : (
                <Descriptions.Item label="高风险题目">{riskyRows}</Descriptions.Item>
              )}
            </>
          )}
        </Descriptions>
        <Progress percent={percent} strokeColor={{ '0%': '#3b82f6', '100%': '#f97316' }} strokeWidth={12} />
      </Card>

      {isPatrolRun ? (
        <Card bordered={false} className="live-monitor-card">
          <div className="live-monitor-header">
            <div>
              <Typography.Text className="brand-kicker">SCHEDULED PATROL</Typography.Text>
              <Typography.Title level={2}>{patrolTitle}</Typography.Title>
              <Typography.Paragraph>
                这里只展示真实模型请求参数探针和 Thinking Signature 互通结果，不混入性能诊断或 Arena 排名视图。
              </Typography.Paragraph>
              <Typography.Text type="secondary">
                渠道：{formatPatrolChannel(patrolChannel ?? { id: patrolChannelId, name: patrolChannelName, accountType: data?.run.patrol_channel_account_type }, patrolChannelId)}
              </Typography.Text>
            </div>
            <Tag color={data.run.status === 'running' ? 'processing' : 'default'}>{data.run.status}</Tag>
          </div>
          <PatrolDetailPanel evidence={patrolEvidence} />
        </Card>
      ) : data.run.mode === 'manual_probe' ? (
        <Card bordered={false} className="live-monitor-card">
          <div className="live-monitor-header">
            <div>
              <Typography.Text className="brand-kicker">MANUAL PROBE LOG</Typography.Text>
              <Typography.Title level={2}>{data.run.name}</Typography.Title>
              <Typography.Paragraph>
                这里只展示手动参数探针的证据链。组合测试会并列展示三条探针日志，单项测试只展示一次请求。
              </Typography.Paragraph>
              <Typography.Text type="secondary">
                {manualProbeIsCombo ? '组合测试' : '单项测试'} · {manualProbeRows.length} 条日志
              </Typography.Text>
            </div>
            <Tag color={data.run.status === 'running' ? 'processing' : 'default'}>{data.run.status}</Tag>
          </div>
          <Table
            rowKey="key"
            size="small"
            pagination={false}
            dataSource={manualProbeRows}
            scroll={{ x: 2330 }}
            locale={{ emptyText: <Empty description="暂无参数探针日志" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            columns={[
              { title: '探针', dataIndex: 'title', width: 200 },
              { title: '状态', width: 110, render: (_, item) => <Tag color={item.status === 'ok' ? 'green' : 'red'}>{item.status === 'ok' ? '正确' : '异常'}</Tag> },
              { title: '渠道', width: 220, render: (_, item) => channelLabel(item.channelName, item.channelId) },
              { title: '渠道类型', dataIndex: 'channelType', width: 340, render: (value) => value ?? '-' },
              {
                title: 'Message ID',
                dataIndex: 'messageId',
                width: 210,
                render: (value) => value ? <Typography.Text code copyable>{value}</Typography.Text> : '-',
              },
              {
                title: 'Request ID',
                dataIndex: 'requestId',
                width: 210,
                render: (value) => value ? <Typography.Text code copyable>{value}</Typography.Text> : '-',
              },
              { title: '协议', dataIndex: 'requestProtocol', width: 150, render: (value) => value ?? '-' },
              { title: 'Endpoint', dataIndex: 'providerEndpoint', width: 260, render: (value) => value ?? '-' },
              { title: '完成时间', dataIndex: 'completedAt', width: 190, render: (value) => value ? formatDateTime(value) : '-' },
              { title: '评分', dataIndex: 'score', width: 100, render: (value) => metricValue(value) },
              { title: '标签', width: 240, render: (_, item) => item.labels.length ? <Space wrap size={4}>{item.labels.map((label) => <Tag key={label} color="volcano">{label}</Tag>)}</Space> : '-' },
              {
                title: '错误/输出',
                width: 360,
                render: (_, item) => (
                  <Tooltip title={item.rawResponseText || item.responseText || undefined}>
                    <Typography.Text>{compactText(item.error ?? item.responseText ?? item.rawResponseText)}</Typography.Text>
                  </Tooltip>
                ),
              },
            ]}
          />
          <div style={{ marginTop: 16 }} className="signature-sim-grid">
            {manualProbeRows.map((item) => (
              <Card key={item.key} title={item.title} bordered={false}>
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label="状态">{item.status === 'ok' ? '正确' : '异常'}</Descriptions.Item>
                  <Descriptions.Item label="渠道">{channelLabel(item.channelName, item.channelId)}</Descriptions.Item>
                  <Descriptions.Item label="渠道类型">{item.channelType}</Descriptions.Item>
                  <Descriptions.Item label="Message ID">{item.messageId ? <Typography.Text code copyable>{item.messageId}</Typography.Text> : '-'}</Descriptions.Item>
                  <Descriptions.Item label="Request ID">{item.requestId ? <Typography.Text code copyable>{item.requestId}</Typography.Text> : '-'}</Descriptions.Item>
                  <Descriptions.Item label="协议">{item.requestProtocol ?? '-'}</Descriptions.Item>
                  <Descriptions.Item label="Endpoint">{item.providerEndpoint ?? '-'}</Descriptions.Item>
                  <Descriptions.Item label="完成时间">{item.completedAt ? formatDateTime(item.completedAt) : '-'}</Descriptions.Item>
                  <Descriptions.Item label="评分">{metricValue(item.score)}</Descriptions.Item>
                  <Descriptions.Item label="标签">{item.labels.length ? item.labels.join(', ') : '-'}</Descriptions.Item>
                </Descriptions>
                <Card title="返回内容" bordered={false} style={{ marginTop: 12 }}>
                  <pre className="output-drawer-pre">{item.responseText ?? item.rawResponseText ?? item.error ?? '-'}</pre>
                </Card>
              </Card>
            ))}
          </div>
        </Card>
      ) : summary ? (
        <Card bordered={false}>
          <Tabs
            items={[
              {
                key: 'summary',
                label: '报告摘要',
                children: (
                  <Space direction="vertical" size={18} style={{ width: '100%' }}>
                    <div className="channel-pair-grid">
                      <div className="monitor-stat-card">
                        <span>成功率</span>
                        <strong>{summary.success_rate === null || summary.success_rate === undefined ? '-' : `${summary.success_rate.toFixed(1)}%`}</strong>
                      </div>
                      <div className="monitor-stat-card">
                        <span>P95 延迟</span>
                        <strong>{summary.p95_latency_ms === null || summary.p95_latency_ms === undefined ? '-' : `${summary.p95_latency_ms.toFixed(0)} ms`}</strong>
                      </div>
                      <div className="monitor-stat-card">
                        <span>平均 TTFT</span>
                        <strong>{summary.avg_ttft_ms === null || summary.avg_ttft_ms === undefined ? '-' : `${summary.avg_ttft_ms.toFixed(0)} ms`}</strong>
                      </div>
                      <div className="monitor-stat-card">
                        <span>平均吞吐</span>
                        <strong>{summary.avg_tokens_per_second === null || summary.avg_tokens_per_second === undefined ? '-' : `${summary.avg_tokens_per_second.toFixed(1)} t/s`}</strong>
                      </div>
                    </div>
                    <Table
                      size="small"
                      rowKey="label"
                      dataSource={labelRows.slice(0, 8)}
                      pagination={false}
                      columns={[
                        { title: '异常标签', dataIndex: 'label', render: (label: string) => <Tag color="volcano">{label}</Tag> },
                        { title: '次数', dataIndex: 'count', width: 100 },
                      ]}
                      locale={{ emptyText: '暂无异常标签' }}
                    />
                  </Space>
                ),
              },
              {
                key: 'performance',
                label: '性能视图',
                children: performanceChartData.length ? (
                  <div style={{ height: 320 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={performanceChartData} margin={{ top: 12, right: 16, left: 0, bottom: 48 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="name" angle={-20} textAnchor="end" interval={0} height={70} />
                        <YAxis />
                        <ChartTooltip />
                        <Bar dataKey="p95" name="P95 延迟(ms)" fill="#3B82F6" />
                        <Bar dataKey="ttft" name="平均 TTFT(ms)" fill="#F97316" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <Empty description="暂无性能指标" />
                ),
              },
              {
                key: 'arena',
                label: 'Arena 排名',
                children: arenaChartData.length ? (
                  <Space direction="vertical" size={16} style={{ width: '100%' }}>
                    <div className="arena-formula-panel">
                      <strong>Arena 总分 = 胜率 * 55% + 平均题目分 * 45%</strong>
                      <span>胜率来自同题两两比较；平均题目分来自每个渠道自身的答案质量、规则匹配和性能惩罚。</span>
                    </div>
                    <div style={{ height: 300 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={arenaChartData} margin={{ top: 12, right: 16, left: 0, bottom: 48 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="name" angle={-20} textAnchor="end" interval={0} height={70} />
                          <YAxis />
                          <ChartTooltip />
                          <Bar dataKey="score" name="Arena 总分" fill="#2563EB" />
                          <Bar dataKey="winRate" name="胜率(%)" fill="#16A34A" />
                          <Bar dataKey="avgCaseScore" name="平均题目分" fill="#F97316" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <Table
                      size="small"
                      rowKey="name"
                      dataSource={arenaChartData}
                      pagination={false}
                      columns={[
                        { title: '排名', dataIndex: 'rank', width: 80, render: (rank: number) => <Tag color={rank === 1 ? 'purple' : 'default'}>#{rank}</Tag> },
                        { title: '渠道', dataIndex: 'name' },
                        { title: 'Arena 总分', dataIndex: 'score', width: 120, render: (value: number) => value.toFixed(1) },
                        { title: '胜率', dataIndex: 'winRate', width: 110, render: (value: number) => `${value.toFixed(1)}%` },
                        { title: '平均题目分', dataIndex: 'avgCaseScore', width: 130, render: (value: number) => value.toFixed(1) },
                        { title: '胜场/对战', width: 130, render: (_, row) => `${row.wins.toFixed(1)} / ${row.pairCount}` },
                      ]}
                    />
                  </Space>
                ) : (
                  <Empty description="当前任务不是 Arena 模式，或暂无排名数据" />
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      {isPerformanceRun && summary ? (
        <Card bordered={false} className="live-monitor-card">
          <div className="live-monitor-header">
            <div>
              <Typography.Text className="brand-kicker">PERFORMANCE DIAGNOSTICS</Typography.Text>
              <Typography.Title level={2}>性能诊断面板</Typography.Title>
              <Typography.Paragraph>
                这里展示单个或多个渠道各自的延迟、首 token、吞吐和失败率，不代表渠道是否接近官方 Claude 指纹。
              </Typography.Paragraph>
            </div>
            <Tag color={data.run.status === 'running' ? 'processing' : 'default'}>{data.run.status === 'running' ? '实时刷新中' : '当前为静态快照'}</Tag>
          </div>
          <div className="channel-pair-grid">
            <div className="monitor-stat-card"><span>成功率</span><strong>{summary.success_rate === null || summary.success_rate === undefined ? '-' : `${summary.success_rate.toFixed(1)}%`}</strong></div>
            <div className="monitor-stat-card"><span>P95 延迟</span><strong>{summary.p95_latency_ms === null || summary.p95_latency_ms === undefined ? '-' : `${summary.p95_latency_ms.toFixed(0)} ms`}</strong></div>
            <div className="monitor-stat-card"><span>平均 TTFT</span><strong>{summary.avg_ttft_ms === null || summary.avg_ttft_ms === undefined ? '-' : `${summary.avg_ttft_ms.toFixed(0)} ms`}</strong></div>
            <div className="monitor-stat-card"><span>平均吞吐</span><strong>{summary.avg_tokens_per_second === null || summary.avg_tokens_per_second === undefined ? '-' : `${summary.avg_tokens_per_second.toFixed(1)} t/s`}</strong></div>
          </div>
          {performanceChartData.length ? (
            <div style={{ height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={performanceChartData} margin={{ top: 12, right: 16, left: 0, bottom: 48 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" angle={-20} textAnchor="end" interval={0} height={70} />
                  <YAxis />
                  <ChartTooltip />
                  <Bar dataKey="p95" name="P95 延迟(ms)" fill="#F97316" />
                  <Bar dataKey="ttft" name="平均 TTFT(ms)" fill="#2563EB" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <Empty description="暂无性能指标" />}
          <Table
            rowKey="channel_id"
            dataSource={summary.performance_by_channel}
            pagination={false}
            scroll={{ x: 900 }}
            columns={[
              { title: '渠道', dataIndex: 'channel_name', width: 220 },
              { title: '成功率', dataIndex: 'success_rate', width: 120, render: (value: number) => value === undefined ? '-' : `${value.toFixed(1)}%` },
              { title: 'P95 延迟', dataIndex: 'p95_latency_ms', width: 130, render: (value: number) => value === undefined || value === null ? '-' : `${value.toFixed(0)} ms` },
              { title: 'TTFT', dataIndex: 'avg_ttft_ms', width: 120, render: (value: number) => value === undefined || value === null ? '-' : `${value.toFixed(0)} ms` },
              { title: 'TPOT', dataIndex: 'avg_tpot_ms', width: 120, render: (value: number) => value === undefined || value === null ? '-' : `${value.toFixed(1)} ms` },
              { title: '吞吐', dataIndex: 'avg_tokens_per_second', width: 130, render: (value: number) => value === undefined || value === null ? '-' : `${value.toFixed(1)} t/s` },
            ]}
          />
        </Card>
      ) : null}

      {isArenaRun && summary ? (
        <Card bordered={false} className="live-monitor-card">
          <div className="live-monitor-header">
            <div>
              <Typography.Text className="brand-kicker">ARENA RANKING</Typography.Text>
              <Typography.Title level={2}>Arena 排名面板</Typography.Title>
              <Typography.Paragraph>
                Arena 用于候选渠道之间的横向排名和样本分歧分析，不引用官方基线，因此不作为真实性结论。
              </Typography.Paragraph>
            </div>
            <Tag color="purple">排名视图</Tag>
          </div>
          {arenaChartData.length ? (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              {arenaRankingIsLive ? (
                <Alert
                  type="info"
                  showIcon
                  message="运行中临时排名"
                  description={`当前排名只基于已返回的 ${arenaReturnedSamples} / ${arenaExpectedSamples} 个 Arena 样本，最终结果以任务完成后为准。`}
                />
              ) : null}
              <div className="arena-explain-grid">
                <section className="arena-explain-panel">
                  <Typography.Text className="section-kicker">LEADER</Typography.Text>
                  <Typography.Title level={4}>{arenaLeader?.name ?? '-'}</Typography.Title>
                  <Typography.Paragraph>
                    当前第一名 Arena 总分 {arenaLeader ? arenaLeader.score.toFixed(1) : '-'}，胜率 {arenaLeader ? arenaLeader.winRate.toFixed(1) : '-'}%。
                    {arenaLeadMargin !== null ? ` 领先第二名 ${arenaLeadMargin.toFixed(1)} 分。` : ''}
                  </Typography.Paragraph>
                </section>
                <section className="arena-explain-panel">
                  <Typography.Text className="section-kicker">HOW TO READ</Typography.Text>
                  <Typography.Title level={4}>先看总分，再看分歧样本</Typography.Title>
                  <Typography.Paragraph>
                    总分说明整体排名；胜率说明同题对战赢面；关键分歧样本解释低排名渠道主要输在哪些题上。
                  </Typography.Paragraph>
                </section>
              </div>
              <div className="arena-formula-panel">
                <strong>Arena 总分 = 胜率 * 55% + 平均题目分 * 45%</strong>
                <span>胜率来自候选渠道之间的同题两两比较，不代表接近官方渠道；平均题目分会受到答案质量、标签和延迟惩罚影响。</span>
              </div>
              <div className="arena-basis-panel">
                <Typography.Text className="section-kicker">SCORING BASIS</Typography.Text>
                <Typography.Title level={4}>样本分怎么算</Typography.Title>
                <Typography.Paragraph>
                  每个候选渠道先回答同一批题。系统用每题基础结果分作为主要依据，乘以 0.85；如果有有效文本会加少量补偿；延迟超过 5000ms 会扣分；最后乘题目权重并限制在 0-100。Arena 再用这些样本分做同题两两比较，得到胜场、胜率和总分。
                </Typography.Paragraph>
              </div>
              <div style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={arenaChartData} margin={{ top: 12, right: 16, left: 0, bottom: 48 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" angle={-20} textAnchor="end" interval={0} height={70} />
                    <YAxis />
                    <ChartTooltip />
                    <Bar dataKey="score" name="Arena 总分" fill="#2563EB" />
                    <Bar dataKey="winRate" name="胜率(%)" fill="#16A34A" />
                    <Bar dataKey="avgCaseScore" name="平均题目分" fill="#F97316" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Table
                rowKey="key"
                dataSource={arenaChartData}
                pagination={false}
                scroll={{ x: 980 }}
                columns={[
                  { title: '排名', dataIndex: 'rank', width: 80, render: (rank: number) => <Tag color={rank === 1 ? 'purple' : 'default'}>#{rank}</Tag> },
                  { title: '渠道', dataIndex: 'name', width: 220 },
                  { title: 'Arena 总分', dataIndex: 'score', width: 120, render: (value: number) => value.toFixed(1) },
                  { title: '胜率', dataIndex: 'winRate', width: 110, render: (value: number) => `${value.toFixed(1)}%` },
                  { title: '平均题目分', dataIndex: 'avgCaseScore', width: 130, render: (value: number) => value.toFixed(1) },
                  { title: '胜场/对战', width: 130, render: (_, row) => `${row.wins.toFixed(1)} / ${row.pairCount}` },
                  { title: '样本数', dataIndex: 'caseCount', width: 100 },
                  {
                    title: '主要标签',
                    width: 240,
                    render: (_, row) => (
                      <Space wrap size={4}>
                        {(row.labels.length ? row.labels : ['无明显异常']).slice(0, 3).map((label) => (
                          <Tag key={label} color={label === '无明显异常' ? 'green' : 'orange'}>{label}</Tag>
                        ))}
                      </Space>
                    ),
                  },
                ]}
              />
              {arenaMatrixRows.length ? (
                <Card bordered={false} title="胜负矩阵">
                  <Typography.Paragraph type="secondary">
                    单元格表示“行渠道 Arena 总分 - 列渠道 Arena 总分”。正数表示行渠道领先，负数表示行渠道落后；这是总分差，不是人工投票数。
                  </Typography.Paragraph>
                  <Table
                    rowKey="key"
                    size="small"
                    dataSource={arenaMatrixRows}
                    pagination={false}
                    scroll={{ x: Math.max(720, arenaMatrixChannelIds.length * 150) }}
                    columns={[
                      { title: '渠道', dataIndex: 'channelName', fixed: 'left', width: 220 },
                      ...arenaMatrixChannelIds.map((channelId) => ({
                        title: channelById.get(channelId)?.name ?? channelId,
                        dataIndex: channelId,
                        width: 150,
                        render: (value: number | null | undefined) =>
                          value === null || value === undefined ? '-' : <Tag color={value >= 0 ? 'green' : 'red'}>{value > 0 ? '+' : ''}{Number(value).toFixed(1)}</Tag>,
                      })),
                    ]}
                  />
                </Card>
              ) : null}
              <Card bordered={false} title="关键分歧样本">
                <Typography.Paragraph type="secondary">
                  这些样本来自同题两两比较中的较大分差。分差越大，越能说明败方渠道在该题上的输出质量、错误标签或性能表现拖累了排名。
                </Typography.Paragraph>
                <Table
                  rowKey="key"
                  dataSource={arenaEvidenceRows}
                  pagination={{ pageSize: 5, hideOnSinglePage: true }}
                  locale={{ emptyText: <Empty description="暂无关键分歧样本" /> }}
                  scroll={{ x: 960 }}
                  columns={[
                    {
                      title: '题目',
                      dataIndex: 'caseTitle',
                      width: 260,
                      render: (value: string, row) => (
                        <Space direction="vertical" size={2}>
                          <strong>{value}</strong>
                          <Typography.Text type="secondary">{row.testCaseId}</Typography.Text>
                        </Space>
                      ),
                    },
                    { title: '胜方', dataIndex: 'winnerName', width: 180, render: (value: string) => <Tag color="green">{value}</Tag> },
                    { title: '败方', dataIndex: 'loserName', width: 180, render: (value: string) => <Tag color="red">{value}</Tag> },
                    { title: '分差', dataIndex: 'margin', width: 100, render: (value: number) => value.toFixed(1) },
                    { title: '样本分', width: 150, render: (_, row) => `${row.winnerScore.toFixed(1)} / ${row.loserScore.toFixed(1)}` },
                    {
                      title: '标签',
                      width: 220,
                      render: (_, row) => (
                        <Space wrap size={4}>
                          {(row.labels.length ? row.labels : ['无标签']).map((label) => <Tag key={label}>{label}</Tag>)}
                        </Space>
                      ),
                    },
                  ]}
                />
              </Card>
            </Space>
          ) : <Empty description="暂无 Arena 排名数据" />}
        </Card>
      ) : null}

      {isAuthenticityRun && selectedReport ? (
        <Card bordered={false}>
          <div className="channel-pair-grid">
            <div className="monitor-stat-card">
              <span>真实性风险分</span>
              <strong>{formatDimension(dimensionScores.authenticity)}</strong>
            </div>
            <div className="monitor-stat-card">
              <span>质量风险分</span>
              <strong>{formatDimension(dimensionScores.quality)}</strong>
            </div>
            <div className="monitor-stat-card">
              <span>稳定性风险分</span>
              <strong>{formatDimension(dimensionScores.stability)}</strong>
            </div>
            <div className="monitor-stat-card">
              <span>报告置信度</span>
              <strong>{confidence}</strong>
            </div>
          </div>
        </Card>
      ) : null}

      {isAuthenticityRun || isSamplingRun ? (
      <Card bordered={false} className="live-monitor-card">
        <div className="live-monitor-header">
          <div>
            <Typography.Text className="brand-kicker">REAL-TIME TEST PANEL</Typography.Text>
            <Typography.Title level={2}>实时测试数据面板</Typography.Title>
            <Typography.Paragraph>
              {isSamplingRun
                ? '每道题按执行顺序展示指纹源渠道的返回、评分和延迟。运行中每 1.8 秒自动刷新。'
                : '每道题按执行顺序展示渠道指纹与待测渠道的返回、评分、延迟和相似度。运行中每 1.8 秒自动刷新。'}
            </Typography.Paragraph>
          </div>
          <Tag color={data.run.status === 'running' ? 'processing' : 'default'} icon={data.run.status === 'running' ? <Clock3 size={14} /> : undefined}>
            {data.run.status === 'running' ? '实时刷新中' : '当前为静态快照'}
          </Tag>
        </div>

        {isSamplingRun ? (
          <div className="channel-pair-grid">
            <div className="channel-pair-card official">
              <span><ShieldCheck size={16} />指纹源渠道</span>
              <Select
                value={selectedSampleChannelId || undefined}
                placeholder="选择指纹源渠道"
                onChange={setSelectedSampleChannelId}
                options={sampleChannels.map((channel) => ({ value: channel.id, label: formatChannelDisplayName(channel) }))}
              />
            </div>
            <div className="monitor-stat-card">
              <span>已返回题目</span>
              <strong>{sampleReturnedRows} / {rows.length}</strong>
            </div>
            <div className="monitor-stat-card">
              <span>平均指纹分</span>
              <strong>{sampleScoreRows.length ? metricValue(averageSampleScore) : '-'}</strong>
            </div>
          </div>
        ) : (
          <div className="channel-pair-grid">
            <div className="channel-pair-card official">
              <span><ShieldCheck size={16} />{data.baseline_snapshot ? '渠道指纹' : '指纹源渠道'}</span>
              <Select
                value={selectedOfficialId || undefined}
                placeholder={data.baseline_snapshot ? '选择渠道指纹来源' : '选择指纹源渠道'}
                onChange={setSelectedOfficialId}
                options={officialChannels.map((channel) => ({ value: channel.id, label: formatChannelDisplayName(channel) }))}
              />
            </div>
            <div className="channel-pair-card candidate">
              <span><GitCompare size={16} />待测渠道</span>
              <Select
                value={selectedCandidateId || undefined}
                placeholder="选择待测渠道"
                onChange={setSelectedCandidateId}
                options={candidateChannels.map((channel) => ({ value: channel.id, label: formatChannelDisplayName(channel) }))}
              />
            </div>
            <div className="monitor-stat-card">
              <span>已形成对比</span>
              <strong>{comparedRows} / {rows.length}</strong>
            </div>
            <div className="monitor-stat-card">
              <span>平均真实性分</span>
              <strong>{comparedRows ? metricValue(averageScore) : '-'}</strong>
            </div>
          </div>
        )}

        {isSamplingRun && !selectedSampleChannel ? (
          <Empty description="请先在提取渠道指纹时选择可用指纹源渠道" />
        ) : !isSamplingRun && (!selectedOfficial || !selectedCandidate) ? (
          <Empty description="请先选择可用渠道指纹，并至少选择一个待测渠道" />
        ) : (
          <Table
            className="live-monitor-table"
            rowKey="key"
            size="middle"
            dataSource={rows}
            pagination={false}
            scroll={{ x: isSamplingRun ? 980 : 1420, y: 620 }}
            expandable={{
              expandedRowRender: (row) => {
                const tone = riskTone(row.comparison?.final_score);
                if (isSamplingRun && selectedSampleChannel) {
                  return (
                    <div className="expanded-live-row">
                      <div className="prompt-panel">
                        <strong>测试题目</strong>
                        <pre>{row.caseItem.prompt}</pre>
                      </div>
                      <div className="ab-compare-grid">
                        <section className="response-panel official">
                          <div className="response-panel-head">
                            <span><ShieldCheck size={16} />指纹源渠道</span>
                            <Tag color={roleColor[selectedSampleChannel.role]}>{selectedSampleChannel.name}</Tag>
                          </div>
                          <div className="response-meta">
                            <span>score {metricValue(row.sample?.score)}</span>
                            <span>{row.sample?.metrics?.latency_ms ?? '-'} ms</span>
                            <span>{row.sampleAttempts} 次返回</span>
                          </div>
                          <pre>{responseText(row.sample)}</pre>
                        </section>
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="expanded-live-row">
                    <div className="prompt-panel">
                      <strong>测试题目</strong>
                      <pre>{row.caseItem.prompt}</pre>
                    </div>
                    <div className="ab-compare-grid">
                      <section className="response-panel official">
                        <div className="response-panel-head">
                          <span><ShieldCheck size={16} />{data.baseline_snapshot ? '渠道指纹' : '指纹源渠道'}</span>
                          <Tag color="gold">{selectedOfficial?.name ?? '未选择渠道'}</Tag>
                        </div>
                        <div className="response-meta">
                          <span>score {metricValue(row.official?.score)}</span>
                          <span>{row.official?.metrics?.latency_ms ?? '-'} ms</span>
                          <span>{row.officialAttempts} 次返回</span>
                        </div>
                        <pre>{responseText(row.official)}</pre>
                      </section>

                      <section className="response-panel candidate">
                        <div className="response-panel-head">
                          <span><GitCompare size={16} />待测渠道</span>
                          <Tag color={selectedCandidate ? roleColor[selectedCandidate.role] : 'default'}>{selectedCandidate?.name ?? '未选择渠道'}</Tag>
                        </div>
                        <div className="response-meta">
                          <span>score {metricValue(row.candidate?.score)}</span>
                          <span>{row.candidate?.metrics?.latency_ms ?? '-'} ms</span>
                          <span>{row.candidateAttempts} 次返回</span>
                        </div>
                        <pre>{responseText(row.candidate)}</pre>
                      </section>

                      <aside className="diff-panel">
                        <div className="diff-status">
                          {row.comparison ? <TriangleAlert size={18} /> : <Spin size="small" />}
                          <Tag color={tone.color}>{tone.text}</Tag>
                        </div>
                        <div className="diff-metrics">
                          <div><span>最终分</span><strong>{metricValue(row.comparison?.final_score)}</strong></div>
                          <div><span>指纹相似度</span><strong>{metricValue(row.comparison?.gold_similarity)}%</strong></div>
                          <div><span>协议分</span><strong>{metricValue(row.comparison?.protocol_score)}</strong></div>
                          <div><span>能力分</span><strong>{metricValue(row.comparison?.capability_score)}</strong></div>
                        </div>
                        <Space wrap>
                          {row.comparison?.labels?.length ? (
                            row.comparison.labels.map((label) => <Tag color="volcano" key={label}>{labelDescription(label, selectedReport)}</Tag>)
                          ) : row.candidate ? (
                            <Tag color="green" icon={<CheckCircle2 size={13} />}>暂无异常标签</Tag>
                          ) : (
                            <Tag>等待待测渠道结果</Tag>
                          )}
                        </Space>
                      </aside>
                    </div>
                  </div>
                );
              },
            }}
            columns={isSamplingRun ? [
              {
                title: '题目',
                width: 260,
                fixed: 'left',
                render: (_, row) => (
                  <Space direction="vertical" size={4}>
                    <div className="case-summary-line">
                      <Tag color={row.caseItem.sort_order === 1 ? 'red' : 'default'}>#{row.caseItem.sort_order}</Tag>
                      <strong>{row.caseItem.title}</strong>
                    </div>
                    <Typography.Text type="secondary">{row.caseItem.id}</Typography.Text>
                    <Tag>{row.caseItem.module}</Tag>
                  </Space>
                ),
              },
              {
                title: '指纹源渠道数据',
                width: 430,
                render: (_, row) =>
                  resultCell(selectedSampleChannel, row.sample, row.sampleAttempts, true, '指纹提取', () =>
                    openOutputDrawer('指纹源输出', selectedSampleChannel, row.sample, row.caseItem, true, '指纹源'),
                  ),
              },
              {
                title: '状态',
                width: 120,
                fixed: 'right',
                render: (_, row) => {
                  const status = sampleRowStatus(row);
                  return <Tag color={status.color}>{status.text}</Tag>;
                },
              },
            ] : [
              {
                title: '题目',
                width: 260,
                fixed: 'left',
                render: (_, row) => (
                  <Space direction="vertical" size={4}>
                    <div className="case-summary-line">
                      <Tag color={row.caseItem.sort_order === 1 ? 'red' : 'default'}>#{row.caseItem.sort_order}</Tag>
                      <strong>{row.caseItem.title}</strong>
                    </div>
                    <Typography.Text type="secondary">{row.caseItem.id}</Typography.Text>
                    <Tag>{row.caseItem.module}</Tag>
                  </Space>
                ),
              },
              {
                title: '渠道指纹数据',
                width: 330,
                render: (_, row) =>
                  resultCell(selectedOfficial, row.official, row.officialAttempts, Boolean(data.baseline_snapshot), '渠道指纹', () =>
                    openOutputDrawer(
                      data.baseline_snapshot ? '渠道指纹输出' : '指纹源输出',
                      selectedOfficial,
                      row.official,
                      row.caseItem,
                      Boolean(data.baseline_snapshot),
                    ),
                  ),
              },
              {
                title: '待测渠道数据',
                width: 330,
                render: (_, row) =>
                  resultCell(selectedCandidate, row.candidate, row.candidateAttempts, false, '渠道指纹', () =>
                    openOutputDrawer('待测输出', selectedCandidate, row.candidate, row.caseItem, false, '待测渠道'),
                  ),
              },
              {
                title: '实时对比结果',
                width: 300,
                render: (_, row) => comparisonCell(row.comparison),
              },
              {
                title: '状态',
                width: 120,
                fixed: 'right',
                render: (_, row) => {
                  const status = rowStatus(row);
                  return <Tag color={status.color}>{status.text}</Tag>;
                },
              },
            ]}
          />
        )}
      </Card>
      ) : null}

      <Drawer
        title={outputDrawer ? `${outputDrawer.title} · ${outputDrawer.caseTitle}` : '输出详情'}
        open={Boolean(outputDrawer)}
        onClose={() => setOutputDrawer(null)}
        width={760}
        destroyOnClose
      >
        {outputDrawer ? (
          <div className="output-drawer">
            <div className="output-drawer-summary">
              <div>
                <span>渠道</span>
                <strong>{outputDrawer.channelName}</strong>
              </div>
              <div>
                <span>角色</span>
                <strong>{outputDrawer.roleLabel}</strong>
              </div>
              <div>
                <span>Attempt</span>
                <strong>{outputDrawer.attemptIndex}</strong>
              </div>
              <div>
                <span>Score / 延迟</span>
                <strong>
                  {metricValue(outputDrawer.score)} / {outputDrawer.latency ?? '-'} ms
                </strong>
              </div>
            </div>

            <div className="output-drawer-section">
              <Typography.Title level={5}>完整输出</Typography.Title>
              <pre className="output-drawer-pre">{responseText(outputDrawer.result)}</pre>
            </div>

            <div className="output-drawer-section">
              <Typography.Title level={5}>原始请求</Typography.Title>
              <pre className="output-drawer-pre">{prettyJson(outputDrawer.result?.raw_request)}</pre>
            </div>
          </div>
        ) : null}
      </Drawer>
    </Space>
  );
}
