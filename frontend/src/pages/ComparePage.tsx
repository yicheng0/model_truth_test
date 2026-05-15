import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { GitCompare, Radar as RadarIcon } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, getErrorMessage } from '../api';
import type { Report, RunMode } from '../types';

const gradeColor: Record<Report['grade'], string> = {
  A: 'green',
  B: 'blue',
  C: 'gold',
  D: 'orange',
  E: 'red',
};

function fmt(value?: number | null, suffix = '') {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : '-';
}

function responseText(value: any) {
  const normalized = value?.result?.normalized_response;
  if (typeof normalized?.content_text === 'string' && normalized.content_text.trim()) return normalized.content_text;
  if (Array.isArray(normalized?.tool_calls) && normalized.tool_calls.length) return JSON.stringify(normalized.tool_calls);
  if (normalized?.error) return String(normalized.error);
  return '暂无输出';
}

function modeLabel(mode: RunMode | string) {
  if (mode === 'performance_benchmark') return '性能诊断分析';
  if (mode === 'arena_comparison') return 'Arena 排名分析';
  if (mode === 'baseline_build') return '渠道指纹分析';
  return '真实性报告对比';
}

function pageDescription(mode: RunMode | string) {
  if (mode === 'performance_benchmark') return '比较多个渠道的独立性能诊断结果，包括延迟、TTFT、吞吐和失败率，不作为真实性判断。';
  if (mode === 'arena_comparison') return '比较候选渠道之间的 Arena 排名、胜率和样本级分歧，不等同于官方基线真实性对比。';
  return '横向比较 2-3 个真实性报告的维度分、样本输出、协议证据和异常标签。';
}

export default function ComparePage() {
  const [params] = useSearchParams();
  const reportIds = useMemo(() => (params.get('report_ids') ?? '').split(',').map((item) => item.trim()).filter(Boolean), [params]);
  const compare = useQuery({ queryKey: ['compareReports', reportIds], queryFn: () => api.compareReports(reportIds), enabled: reportIds.length >= 2 });
  const [moduleFilter, setModuleFilter] = useState('all');
  const [focusFilter, setFocusFilter] = useState('all');

  if (reportIds.length < 2) {
    return (
      <Card bordered={false}>
        <Empty description="请先在报告中心选择 2-3 份报告进行对比">
          <Link to="/reports"><Button type="primary">进入报告中心</Button></Link>
        </Empty>
      </Card>
    );
  }

  if (compare.isError) {
    return <Alert type="error" showIcon message="对比数据加载失败" description={getErrorMessage(compare.error)} action={<Button onClick={() => compare.refetch()}>重试</Button>} />;
  }

  if (compare.isLoading || !compare.data) {
    return <Card loading bordered={false} />;
  }

  const data = compare.data;
  const mode = data.mode;
  const isPerformance = mode === 'performance_benchmark';
  const isArena = mode === 'arena_comparison';
  const reportKeys = data.reports.map((report) => report.report_id);
  const modules = Array.from(new Set(data.prediction_rows.map((row) => row.module))).sort();
  const chartRows = data.dimensions.map((dimension) => ({
    dimension,
    ...Object.fromEntries(data.reports.map((report) => [report.channel_name, report.dimension_scores[dimension] ?? 0])),
  }));
  const filteredRows = data.prediction_rows.filter((row) => {
    if (moduleFilter !== 'all' && row.module !== moduleFilter) return false;
    const scores = reportKeys.map((id) => row.reports[id]?.score).filter((score): score is number => typeof score === 'number');
    const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;
    const labels = reportKeys.flatMap((id) => row.reports[id]?.labels ?? []);
    if (focusFilter === 'large_gap' && spread < 15) return false;
    if (focusFilter === 'protocol' && !labels.some((label) => label.includes('protocol') || label.includes('message_id') || label.includes('usage'))) return false;
    if (focusFilter === 'performance' && !labels.some((label) => label.includes('latency'))) return false;
    return true;
  });

  return (
    <Space direction="vertical" size={20} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">COMPARE</Typography.Text>
          <Typography.Title level={2}>{modeLabel(mode)}</Typography.Title>
          <Typography.Paragraph>{pageDescription(mode)}</Typography.Paragraph>
        </div>
        <Link to="/reports"><Button>返回报告中心</Button></Link>
      </div>

      <section className="metric-strip">
        {data.reports.map((report) => (
          <div key={report.report_id}>
            <span>{report.channel_name}</span>
            <strong><Tag color={gradeColor[report.grade]}>{report.grade}</Tag> {fmt(report.final_score)}</strong>
          </div>
        ))}
      </section>

      <Tabs
        items={[
          {
            key: 'scores',
            label: isPerformance ? '性能矩阵' : isArena ? '排名对比' : '得分对比',
            children: (
              <Space direction="vertical" size={16} className="full-width">
                <Card bordered={false} title={<span className="card-title-with-icon"><RadarIcon size={18} />{isPerformance ? '性能指标' : isArena ? 'Arena 分数' : '维度雷达'}</span>}>
                  <div className="chart-grid">
                    {!isPerformance ? (
                      <div className="report-chart">
                        <ResponsiveContainer width="100%" height={340}>
                          <RadarChart data={chartRows}>
                            <PolarGrid />
                            <PolarAngleAxis dataKey="dimension" />
                            <PolarRadiusAxis angle={30} domain={[0, 100]} />
                            {data.reports.map((report, index) => (
                              <Radar key={report.report_id} name={report.channel_name} dataKey={report.channel_name} stroke={['#2563eb', '#f97316', '#16a34a'][index]} fill={['#2563eb', '#f97316', '#16a34a'][index]} fillOpacity={0.16} />
                            ))}
                            <Legend />
                            <Tooltip />
                          </RadarChart>
                        </ResponsiveContainer>
                      </div>
                    ) : null}
                    <div className="report-chart">
                      <ResponsiveContainer width="100%" height={340}>
                        <BarChart data={data.performance_matrix}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="channel_name" />
                          <YAxis />
                          <Tooltip />
                          <Legend />
                          <Bar dataKey="p95_latency_ms" name="P95 ms" fill="#f97316" />
                          <Bar dataKey="avg_ttft_ms" name="TTFT ms" fill="#2563eb" />
                          <Bar dataKey="failure_rate" name="失败率 %" fill="#dc2626" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </Card>
                <Card bordered={false} title={isPerformance ? '性能指标矩阵' : isArena ? 'Arena 报告矩阵' : '维度得分矩阵'}>
                  <Table
                    rowKey={isPerformance ? 'report_id' : 'dimension'}
                    dataSource={isPerformance ? data.performance_matrix : data.score_matrix}
                    pagination={false}
                    scroll={{ x: 720 }}
                    columns={isPerformance ? [
                      { title: '渠道', dataIndex: 'channel_name', width: 180 },
                      { title: '成功率', dataIndex: 'success_rate', render: (value: number | null) => <strong>{fmt(value, '%')}</strong> },
                      { title: 'P95 延迟', dataIndex: 'p95_latency_ms', render: (value: number | null) => <strong>{fmt(value, ' ms')}</strong> },
                      { title: 'TTFT', dataIndex: 'avg_ttft_ms', render: (value: number | null) => <strong>{fmt(value, ' ms')}</strong> },
                      { title: 'TPOT', dataIndex: 'avg_tpot_ms', render: (value: number | null) => <strong>{fmt(value, ' ms')}</strong> },
                      { title: '吞吐', dataIndex: 'avg_tokens_per_second', render: (value: number | null) => <strong>{fmt(value, ' t/s')}</strong> },
                    ] : [
                      { title: '维度', dataIndex: 'dimension', width: 180 },
                      ...data.reports.map((report) => ({
                        title: report.channel_name,
                        dataIndex: report.report_id,
                        render: (value: number | null) => <strong>{fmt(value)}</strong>,
                      })),
                    ]}
                  />
                </Card>
              </Space>
            ),
          },
          {
            key: 'predictions',
            label: isPerformance ? '慢样本' : isArena ? '样本分歧' : '预测对比',
            children: (
              <Card bordered={false} title={<span className="card-title-with-icon"><GitCompare size={18} />{isPerformance ? '性能样本明细' : isArena ? 'Arena 样本分歧' : '同题输出对比'}</span>}>
                <div className="report-filter-grid">
                  <Select value={moduleFilter} onChange={setModuleFilter} options={[{ value: 'all', label: '全部模块' }, ...modules.map((item) => ({ value: item, label: item }))]} />
                  <Select
                    value={focusFilter}
                    onChange={setFocusFilter}
                    options={[
                      { value: 'all', label: '全部题目' },
                      { value: 'large_gap', label: '分歧 >= 15' },
                      { value: 'protocol', label: '协议异常' },
                      { value: 'performance', label: '性能异常' },
                    ]}
                  />
                </div>
                <Table
                  rowKey="test_case_id"
                  dataSource={filteredRows}
                  pagination={{ pageSize: 6, showTotal: (total) => `共 ${total} 道题` }}
                  scroll={{ x: 760 + data.reports.length * 360 }}
                  locale={{ emptyText: <Empty description="没有匹配题目" /> }}
                  columns={[
                    {
                      title: '题目',
                      width: 280,
                      fixed: 'left',
                      render: (_, row) => (
                        <Space direction="vertical" size={2}>
                          <strong>{row.title}</strong>
                          <Tag>{row.module}</Tag>
                        </Space>
                      ),
                    },
                    ...data.reports.map((report) => ({
                      title: report.channel_name,
                      width: 360,
                      render: (_: unknown, row: typeof data.prediction_rows[number]) => {
                        const item = row.reports[report.report_id];
                        return (
                          <div className="compare-output-cell">
                            <div>
                              <Tag color={(item?.score ?? 100) < 70 ? 'red' : 'green'}>{fmt(item?.score)}</Tag>
                              <Tag>{fmt(item?.latency_ms, ' ms')}</Tag>
                            </div>
                            <p>{responseText(item).replace(/\s+/g, ' ').slice(0, 260)}</p>
                            <Space wrap size={4}>
                              {(item?.labels?.length ? item.labels : ['no_labels']).slice(0, 3).map((label) => <Tag key={label} color={label === 'no_labels' ? 'green' : 'orange'}>{label}</Tag>)}
                            </Space>
                          </div>
                        );
                      },
                    })),
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'labels',
            label: isPerformance ? '性能异常' : isArena ? '排名差异' : '异常差异',
            children: (
              <Card bordered={false} title="标签差异">
                <div className="label-diff-grid">
                  <div>
                    <h3>共同异常</h3>
                    <Space wrap>{(data.label_diff.common ?? []).map((item) => <Tag key={item} color="red">{item}</Tag>)}</Space>
                  </div>
                  {data.reports.map((report) => (
                    <div key={report.report_id}>
                      <h3>{report.channel_name} 独有</h3>
                      <Space wrap>{(data.label_diff[report.report_id] ?? []).map((item) => <Tag key={item} color="orange">{item}</Tag>)}</Space>
                    </div>
                  ))}
                </div>
              </Card>
            ),
          },
        ]}
      />
    </Space>
  );
}
