import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Drawer, Empty, Progress, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { CheckCircle2, Clock3, Eye, GitCompare, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { api, getErrorMessage } from '../api';
import { roleColor } from '../channelTaxonomy';
import type { BaselineResult, Channel, Comparison, Result, RunMode, RunResults, RunSummary, TestCase } from '../types';

type DisplayResult = Result | BaselineResult;

type CasePanelRow = {
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

type OutputDrawerState = {
  title: string;
  channelName: string;
  roleLabel: string;
  caseTitle: string;
  attemptIndex: number;
  score?: number;
  latency?: number;
  result?: DisplayResult;
};

type ArenaRankingRow = {
  key: string;
  rank: number;
  channelId: string;
  name: string;
  score: number;
  winRate: number;
  avgCaseScore: number;
  wins: number;
  pairCount: number;
  caseCount: number;
  labels: string[];
};

type ArenaEvidenceRow = {
  key: string;
  testCaseId: string;
  caseTitle: string;
  winnerChannelId: string;
  loserChannelId: string;
  winnerName: string;
  loserName: string;
  winnerScore: number;
  loserScore: number;
  margin: number;
  labels: string[];
};

function latestResult(results?: DisplayResult[]) {
  if (!results?.length) return undefined;
  return [...results].sort((a, b) => {
    if (b.attempt_index !== a.attempt_index) return b.attempt_index - a.attempt_index;
    return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
  })[0];
}

function responseText(result?: DisplayResult) {
  const normalized = result?.normalized_response;
  const text = normalized?.content_text;
  if (typeof text === 'string' && text.trim()) return text;
  const toolCalls = normalized?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length) return JSON.stringify(toolCalls, null, 2);
  const error = normalized?.error ?? normalized?.raw_response?.error;
  if (typeof error === 'string' && error.trim()) return `请求失败：${error}`;
  return '等待该渠道返回结果';
}

function responseSnippet(result?: DisplayResult) {
  const text = responseText(result).replace(/\s+/g, ' ').trim();
  if (!result) return '等待返回';
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function prettyJson(value: unknown) {
  if (value === undefined || value === null) return '-';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function metricValue(value?: number) {
  return value === undefined || Number.isNaN(value) ? '-' : value.toFixed(1);
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function riskTone(score?: number) {
  if (score === undefined) return { color: 'default', text: '等待对比' };
  if (score >= 85) return { color: 'green', text: '接近指纹' };
  if (score >= 70) return { color: 'gold', text: '轻微偏离' };
  return { color: 'red', text: '明显偏离' };
}

function rowStatus(row: CasePanelRow) {
  if (row.comparison) return { color: 'green', text: '已对比' };
  if (row.official && row.candidate) return { color: 'blue', text: '等待评分' };
  if (row.official || row.candidate) return { color: 'gold', text: '部分返回' };
  return { color: 'default', text: '排队中' };
}

function sampleRowStatus(row: CasePanelRow) {
  if (row.sample?.normalized_response?.error) return { color: 'red', text: '请求失败' };
  if (row.sample) return { color: 'green', text: '已返回' };
  return { color: 'default', text: '排队中' };
}

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

function formatDimension(value: unknown) {
  return typeof value === 'number' ? value.toFixed(1) : '-';
}

function labelDescription(label: string, report?: RunResults['reports'][number]) {
  const explanations = report?.evidence?.label_explanations;
  if (Array.isArray(explanations)) {
    const item = explanations.find((entry) => entry?.label === label);
    if (item?.description) return item.description;
  }
  return label;
}

function runModeLabel(mode?: RunMode | string) {
  if (mode === 'baseline_build') return '渠道指纹提取';
  if (mode === 'performance_benchmark') return '性能诊断';
  if (mode === 'arena_comparison') return 'Arena 排名';
  if (mode === 'manual_probe') return '模型请求探针';
  return '真实性对比';
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
  const casesQuery = useQuery({
    queryKey: ['cases', runResults.data?.run.suite_id],
    queryFn: () => api.cases(runResults.data?.run.suite_id),
    enabled: Boolean(runResults.data?.run.suite_id),
  });

  const data = runResults.data ?? null;
  const summary = runSummary.data ?? null;
  const channels = channelsQuery.data ?? [];
  const cases = casesQuery.data ?? [];
  const isSamplingRun = data?.run.mode === 'baseline_build';
  const isPerformanceRun = data?.run.mode === 'performance_benchmark';
  const isArenaRun = data?.run.mode === 'arena_comparison';
  const isAuthenticityRun = data?.run.mode === 'candidate_eval' || data?.run.mode === 'full_comparison';

  const channelById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const caseById = useMemo(() => new Map(cases.map((caseItem) => [caseItem.id, caseItem])), [cases]);
  const runChannelIds = useMemo(() => new Set((data?.run_channels ?? []).map((item) => item.channel_id)), [data?.run_channels]);
  const baselineChannelIds = useMemo(() => new Set((data?.baseline_results ?? []).map((item) => item.channel_id)), [data?.baseline_results]);
  const runRoleByChannel = useMemo(() => new Map((data?.run_channels ?? []).map((item) => [item.channel_id, item.role_in_run])), [data?.run_channels]);

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
  const returnedRows = isSamplingRun ? sampleReturnedRows : rows.filter((row) => row.official && row.candidate).length;
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
        <Descriptions column={{ xs: 1, sm: 2, md: 4 }} style={{ marginBottom: '18px' }}>
          <Descriptions.Item label="状态">
            <Tag color={data.run.status === 'completed' ? 'green' : data.run.status === 'failed' ? 'red' : 'gold'}>
              {data.run.status}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="实时进度">{data.run.completed_jobs} / {data.run.total_jobs}</Descriptions.Item>
          <Descriptions.Item label="运行模式">{runModeLabel(data.run.mode)}</Descriptions.Item>
          <Descriptions.Item label="检测范围">{data.run.test_scope === 'quick' ? '历史兼容检测' : '完整检测'}</Descriptions.Item>
          <Descriptions.Item label={isSamplingRun ? '渠道指纹' : '渠道指纹'}>
            {data.baseline_snapshot?.name ?? (isSamplingRun ? '指纹提取中' : '本次同步对比')}
          </Descriptions.Item>
          <Descriptions.Item label="已返回题目">{returnedRows} / {rows.length}</Descriptions.Item>
          {isSamplingRun ? (
            <Descriptions.Item label="指纹源渠道">{sampleChannels.length}</Descriptions.Item>
          ) : (
            <Descriptions.Item label="高风险题目">{riskyRows}</Descriptions.Item>
          )}
        </Descriptions>
        <Progress percent={percent} strokeColor={{ '0%': '#3b82f6', '100%': '#f97316' }} strokeWidth={12} />
      </Card>

      {summary ? (
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
                options={sampleChannels.map((channel) => ({ value: channel.id, label: channel.name }))}
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
                options={officialChannels.map((channel) => ({ value: channel.id, label: channel.name }))}
              />
            </div>
            <div className="channel-pair-card candidate">
              <span><GitCompare size={16} />待测渠道</span>
              <Select
                value={selectedCandidateId || undefined}
                placeholder="选择待测渠道"
                onChange={setSelectedCandidateId}
                options={candidateChannels.map((channel) => ({ value: channel.id, label: channel.name }))}
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
