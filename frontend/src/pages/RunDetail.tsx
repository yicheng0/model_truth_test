import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Empty, Progress, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { CheckCircle2, Clock3, GitCompare, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { api, getErrorMessage } from '../api';
import type { BaselineResult, Channel, ChannelRole, Comparison, Result, RunResults, TestCase } from '../types';

type DisplayResult = Result | BaselineResult;

type CasePanelRow = {
  key: string;
  caseItem: TestCase;
  official?: DisplayResult;
  officialAttempts: number;
  candidate?: DisplayResult;
  candidateAttempts: number;
  comparison?: Comparison;
};

const roleLabel: Record<string, string> = {
  gold: '官方基准',
  official_cloud: '官方云参考',
  candidate: '第三方待测',
  negative: '负样本',
};

const roleColor: Record<ChannelRole, string> = {
  gold: 'gold',
  official_cloud: 'blue',
  candidate: 'purple',
  negative: 'red',
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
  return '等待该渠道返回结果';
}

function responseSnippet(result?: DisplayResult) {
  const text = responseText(result).replace(/\s+/g, ' ').trim();
  if (!result) return '等待返回';
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function metricValue(value?: number) {
  return value === undefined || Number.isNaN(value) ? '-' : value.toFixed(1);
}

function riskTone(score?: number) {
  if (score === undefined) return { color: 'default', text: '等待对比' };
  if (score >= 85) return { color: 'green', text: '接近官方' };
  if (score >= 70) return { color: 'gold', text: '轻微偏离' };
  return { color: 'red', text: '明显偏离' };
}

function rowStatus(row: CasePanelRow) {
  if (row.comparison) return { color: 'green', text: '已对比' };
  if (row.official && row.candidate) return { color: 'blue', text: '等待评分' };
  if (row.official || row.candidate) return { color: 'gold', text: '部分返回' };
  return { color: 'default', text: '排队中' };
}

function resultCell(channel: Channel | undefined, result: DisplayResult | undefined, attempts: number, baseline = false) {
  return (
    <div className="result-cell">
      <div className="result-cell-title">
        <strong>{channel?.name ?? '未选择渠道'}</strong>
        {channel ? <Tag color={roleColor[channel.role]}>{baseline ? '官方基线' : roleLabel[channel.role]}</Tag> : null}
      </div>
      <div className="result-cell-meta">
        <Tag>score {metricValue(result?.score)}</Tag>
        <Tag>{result?.metrics?.latency_ms ?? '-'} ms</Tag>
        <Tag>{attempts || 0} 次</Tag>
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

export default function RunDetail() {
  const { runId = '' } = useParams();
  const [selectedOfficialId, setSelectedOfficialId] = useState('');
  const [selectedCandidateId, setSelectedCandidateId] = useState('');

  const runResults = useQuery<RunResults>({
    queryKey: ['runResults', runId],
    queryFn: () => api.runResults(runId),
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
  const channels = channelsQuery.data ?? [];
  const cases = casesQuery.data ?? [];

  const channelById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const runChannelIds = useMemo(() => new Set((data?.run_channels ?? []).map((item) => item.channel_id)), [data?.run_channels]);
  const baselineChannelIds = useMemo(() => new Set((data?.baseline_results ?? []).map((item) => item.channel_id)), [data?.baseline_results]);
  const runRoleByChannel = useMemo(() => new Map((data?.run_channels ?? []).map((item) => [item.channel_id, item.role_in_run])), [data?.run_channels]);

  const officialChannels = useMemo(
    () =>
      channels.filter((channel) => {
        if (!runChannelIds.has(channel.id) && !baselineChannelIds.has(channel.id)) return false;
        const role = runRoleByChannel.get(channel.id) ?? channel.role;
        return role === 'gold' || role === 'official_cloud';
      }),
    [baselineChannelIds, channels, runChannelIds, runRoleByChannel],
  );

  const candidateChannels = useMemo(
    () =>
      channels.filter((channel) => {
        if (!runChannelIds.has(channel.id)) return false;
        const role = runRoleByChannel.get(channel.id) ?? channel.role;
        return role === 'candidate' || role === 'negative';
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

  const selectedOfficial = channelById.get(selectedOfficialId);
  const selectedCandidate = channelById.get(selectedCandidateId);

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
          const officialResults = selectedOfficialId ? resultByCaseChannel.get(`${caseItem.id}:${selectedOfficialId}`) : undefined;
          const baselineOfficialResults = selectedOfficialId ? baselineResultByCaseChannel.get(`${caseItem.id}:${selectedOfficialId}`) : undefined;
          const candidateResults = selectedCandidateId ? resultByCaseChannel.get(`${caseItem.id}:${selectedCandidateId}`) : undefined;
          return {
            key: caseItem.id,
            caseItem,
            official: latestResult(baselineOfficialResults ?? officialResults),
            officialAttempts: (baselineOfficialResults ?? officialResults)?.length ?? 0,
            candidate: latestResult(candidateResults),
            candidateAttempts: candidateResults?.length ?? 0,
            comparison: selectedCandidateId ? comparisonByCaseCandidate.get(`${caseItem.id}:${selectedCandidateId}`) : undefined,
          };
        }),
    [baselineResultByCaseChannel, comparisonByCaseCandidate, panelCases, resultByCaseChannel, selectedCandidateId, selectedOfficialId],
  );

  const percent = data?.run.total_jobs ? Math.round((data.run.completed_jobs / data.run.total_jobs) * 100) : 0;
  const returnedRows = rows.filter((row) => row.official && row.candidate).length;
  const comparedRows = rows.filter((row) => row.comparison).length;
  const riskyRows = rows.filter((row) => (row.comparison?.final_score ?? 100) < 70).length;
  const averageScore = rows.length
    ? rows.reduce((sum, row) => sum + (row.comparison?.final_score ?? 0), 0) / Math.max(1, comparedRows)
    : 0;

  if (runResults.isError || channelsQuery.isError || casesQuery.isError) {
    const error = runResults.error ?? channelsQuery.error ?? casesQuery.error;
    return (
      <Card bordered={false}>
        <Alert
          type="error"
          showIcon
          message="任务详情加载失败"
          description={getErrorMessage(error)}
          action={<Button onClick={() => Promise.all([runResults.refetch(), channelsQuery.refetch(), casesQuery.refetch()])}>重试</Button>}
        />
      </Card>
    );
  }

  if (runResults.isLoading || channelsQuery.isLoading || casesQuery.isLoading || !data) {
    return <Card loading />;
  }

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }} className="page-stack">
      <Card
        title={<span style={{ fontSize: '20px', fontWeight: 700 }}>{data.run.name}</span>}
        extra={<Button size="large" href={api.reportUrl(data.run.id)} target="_blank" style={{ fontWeight: 600 }}>导出 Markdown</Button>}
        bordered={false}
      >
        <Descriptions column={{ xs: 1, sm: 2, md: 4 }} style={{ marginBottom: '18px' }}>
          <Descriptions.Item label="状态">
            <Tag color={data.run.status === 'completed' ? 'green' : data.run.status === 'failed' ? 'red' : 'gold'}>
              {data.run.status}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="实时进度">{data.run.completed_jobs} / {data.run.total_jobs}</Descriptions.Item>
          <Descriptions.Item label="运行模式">{data.run.mode}</Descriptions.Item>
          <Descriptions.Item label="官方基线">{data.baseline_snapshot?.name ?? '本次同步对比'}</Descriptions.Item>
          <Descriptions.Item label="已返回题目">{returnedRows} / {rows.length}</Descriptions.Item>
          <Descriptions.Item label="高风险题目">{riskyRows}</Descriptions.Item>
        </Descriptions>
        <Progress percent={percent} strokeColor={{ '0%': '#3b82f6', '100%': '#f97316' }} strokeWidth={12} />
      </Card>

      <Card bordered={false} className="live-monitor-card">
        <div className="live-monitor-header">
          <div>
            <Typography.Text className="brand-kicker">REAL-TIME TEST PANEL</Typography.Text>
            <Typography.Title level={2}>实时测试数据面板</Typography.Title>
            <Typography.Paragraph>
              每道题按执行顺序展示官方基线或官方渠道与第三方渠道的返回、评分、延迟和相似度。运行中每 1.8 秒自动刷新。
            </Typography.Paragraph>
          </div>
          <Tag color={data.run.status === 'running' ? 'processing' : 'default'} icon={data.run.status === 'running' ? <Clock3 size={14} /> : undefined}>
            {data.run.status === 'running' ? '实时刷新中' : '当前为静态快照'}
          </Tag>
        </div>

        <div className="channel-pair-grid">
          <div className="channel-pair-card official">
            <span><ShieldCheck size={16} />{data.baseline_snapshot ? '官方基线' : '官方渠道'}</span>
            <Select
              value={selectedOfficialId || undefined}
              placeholder="选择官方渠道"
              onChange={setSelectedOfficialId}
              options={officialChannels.map((channel) => ({ value: channel.id, label: `${channel.name} (${roleLabel[channel.role]})` }))}
            />
          </div>
          <div className="channel-pair-card candidate">
            <span><GitCompare size={16} />第三方渠道</span>
            <Select
              value={selectedCandidateId || undefined}
              placeholder="选择第三方渠道"
              onChange={setSelectedCandidateId}
              options={candidateChannels.map((channel) => ({ value: channel.id, label: `${channel.name} (${roleLabel[channel.role]})` }))}
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

        {!selectedOfficial || !selectedCandidate ? (
          <Empty description="请先在创建检测时选择可用官方基线或官方渠道，并至少选择一个第三方渠道" />
        ) : (
          <Table
            className="live-monitor-table"
            rowKey="key"
            size="middle"
            dataSource={rows}
            pagination={false}
            scroll={{ x: 1420, y: 620 }}
            expandable={{
              expandedRowRender: (row) => {
                const tone = riskTone(row.comparison?.final_score);
                return (
                  <div className="expanded-live-row">
                    <div className="prompt-panel">
                      <strong>测试题目</strong>
                      <pre>{row.caseItem.prompt}</pre>
                    </div>
                    <div className="ab-compare-grid">
                      <section className="response-panel official">
                        <div className="response-panel-head">
                          <span><ShieldCheck size={16} />{data.baseline_snapshot ? '官方基线' : '官方渠道'}</span>
                          <Tag color="gold">{selectedOfficial.name}</Tag>
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
                          <span><GitCompare size={16} />第三方渠道</span>
                          <Tag color={roleColor[selectedCandidate.role]}>{selectedCandidate.name}</Tag>
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
                          <div><span>官方相似度</span><strong>{metricValue(row.comparison?.gold_similarity)}%</strong></div>
                          <div><span>协议分</span><strong>{metricValue(row.comparison?.protocol_score)}</strong></div>
                          <div><span>能力分</span><strong>{metricValue(row.comparison?.capability_score)}</strong></div>
                        </div>
                        <Space wrap>
                          {row.comparison?.labels?.length ? (
                            row.comparison.labels.map((label) => <Tag color="volcano" key={label}>{label}</Tag>)
                          ) : row.candidate ? (
                            <Tag color="green" icon={<CheckCircle2 size={13} />}>暂无异常标签</Tag>
                          ) : (
                            <Tag>等待第三方渠道结果</Tag>
                          )}
                        </Space>
                      </aside>
                    </div>
                  </div>
                );
              },
            }}
            columns={[
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
                title: '官方渠道数据',
                width: 330,
                render: (_, row) => resultCell(selectedOfficial, row.official, row.officialAttempts, Boolean(data.baseline_snapshot)),
              },
              {
                title: '第三方渠道数据',
                width: 330,
                render: (_, row) => resultCell(selectedCandidate, row.candidate, row.candidateAttempts),
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
    </Space>
  );
}
