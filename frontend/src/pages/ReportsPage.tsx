import { useMemo, useState } from 'react';
import type { Key } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Input, Select, Space, Table, Tag, Typography, message } from 'antd';
import { BarChart3, FileText, GitCompare, Search } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getErrorMessage } from '../api';
import { formatDateTime } from '../time';
import type { Report, ReportSummary, RunMode } from '../types';

const gradeColor: Record<Report['grade'], string> = {
  A: 'green',
  B: 'blue',
  C: 'gold',
  D: 'orange',
  E: 'red',
};

const scoreRanges = [
  { value: 'all', label: '全部分数' },
  { value: 'high', label: '>= 85' },
  { value: 'medium', label: '70 - 84' },
  { value: 'low', label: '< 70' },
];

const modeOptions: Array<{ value: RunMode | 'all'; label: string }> = [
  { value: 'all', label: '全部报告类型' },
  { value: 'candidate_eval', label: '真实性报告' },
  { value: 'full_comparison', label: '同步对比报告' },
  { value: 'performance_benchmark', label: '性能诊断报告' },
  { value: 'arena_comparison', label: 'Arena 排名报告' },
  { value: 'baseline_build', label: '渠道指纹报告' },
];

function modeLabel(mode: string) {
  return modeOptions.find((item) => item.value === mode)?.label ?? mode;
}

function numberText(value?: number | null, suffix = '') {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : '-';
}

function labelsOf(reports: ReportSummary[]) {
  return Array.from(new Set(reports.flatMap((report) => report.labels ?? []))).sort();
}

export default function ReportsPage() {
  const navigate = useNavigate();
  const reports = useQuery({ queryKey: ['reportSummaries'], queryFn: api.reportSummaries });
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [query, setQuery] = useState('');
  const [grade, setGrade] = useState('all');
  const [role, setRole] = useState('all');
  const [label, setLabel] = useState('all');
  const [scoreRange, setScoreRange] = useState('all');
  const [mode, setMode] = useState<RunMode | 'all'>('candidate_eval');

  const data = reports.data ?? [];
  const selectedReports = useMemo(() => data.filter((report) => selectedRowKeys.includes(report.report_id)), [data, selectedRowKeys]);
  const selectedModes = useMemo(() => Array.from(new Set(selectedReports.map((report) => report.mode))), [selectedReports]);
  const canCompare = selectedRowKeys.length >= 2 && selectedModes.length === 1;
  const roles = useMemo(() => Array.from(new Set(data.map((report) => report.channel_role))).sort(), [data]);
  const labels = useMemo(() => labelsOf(data), [data]);

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return data.filter((report) => {
      if (mode !== 'all' && report.mode !== mode) return false;
      if (grade !== 'all' && report.grade !== grade) return false;
      if (role !== 'all' && report.channel_role !== role) return false;
      if (label !== 'all' && !report.labels.includes(label)) return false;
      if (scoreRange === 'high' && report.final_score < 85) return false;
      if (scoreRange === 'medium' && (report.final_score < 70 || report.final_score >= 85)) return false;
      if (scoreRange === 'low' && report.final_score >= 70) return false;
      if (!text) return true;
      return [report.run_name, report.channel_name, report.summary, report.grade, ...report.labels]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(text);
    });
  }, [data, grade, label, mode, query, role, scoreRange]);

  function compareSelected() {
    if (selectedRowKeys.length < 2) {
      message.warning('请至少选择 2 份报告');
      return;
    }
    if (selectedModes.length > 1) {
      message.warning('只能对比同一类型的报告');
      return;
    }
    navigate(`/compare?report_ids=${selectedRowKeys.join(',')}`);
  }

  return (
    <Space direction="vertical" size={20} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">REPORT CENTER</Typography.Text>
          <Typography.Title level={2}>报告中心</Typography.Title>
          <Typography.Paragraph>
            汇总真实性、性能诊断和 Arena 排名报告。只有同一类型的 2-3 份报告可以进入横向分析。
          </Typography.Paragraph>
        </div>
        <Button type="primary" icon={<GitCompare size={16} />} disabled={!canCompare} onClick={compareSelected}>
          对比分析
        </Button>
      </div>

      {reports.isError ? (
        <Alert type="error" showIcon message="报告加载失败" description={getErrorMessage(reports.error)} action={<Button onClick={() => reports.refetch()}>重试</Button>} />
      ) : null}

      <section className="metric-strip">
        <div><span>报告数</span><strong>{data.length}</strong></div>
        <div><span>真实性报告</span><strong>{data.filter((item) => item.mode === 'candidate_eval' || item.mode === 'full_comparison').length}</strong></div>
        <div><span>性能诊断</span><strong>{data.filter((item) => item.mode === 'performance_benchmark').length}</strong></div>
        <div><span>Arena 排名</span><strong>{data.filter((item) => item.mode === 'arena_comparison').length}</strong></div>
      </section>

      {selectedRowKeys.length >= 2 && selectedModes.length > 1 ? (
        <Alert type="warning" showIcon message="已选择不同类型报告" description="真实性、性能诊断和 Arena 排名的指标含义不同，请只选择同一类型报告进行分析。" />
      ) : null}

      <section className="metric-strip">
        <div><span>高风险</span><strong>{data.filter((item) => item.grade === 'D' || item.grade === 'E').length}</strong></div>
        <div><span>平均分</span><strong>{numberText(data.reduce((sum, item) => sum + item.final_score, 0) / Math.max(1, data.length))}</strong></div>
        <div><span>异常标签</span><strong>{labels.length}</strong></div>
      </section>

      <Card bordered={false}>
        <div className="report-filter-grid">
          <Input allowClear prefix={<Search size={15} />} placeholder="搜索任务、渠道、结论或标签" value={query} onChange={(event) => setQuery(event.target.value)} />
          <Select value={mode} onChange={setMode} options={modeOptions} />
          <Select value={grade} onChange={setGrade} options={[{ value: 'all', label: '全部评级' }, ...(['A', 'B', 'C', 'D', 'E'] as const).map((item) => ({ value: item, label: item }))]} />
          <Select value={role} onChange={setRole} options={[{ value: 'all', label: '全部角色' }, ...roles.map((item) => ({ value: item, label: item }))]} />
          <Select value={label} onChange={setLabel} options={[{ value: 'all', label: '全部标签' }, ...labels.map((item) => ({ value: item, label: item }))]} />
          <Select value={scoreRange} onChange={setScoreRange} options={scoreRanges} />
        </div>
      </Card>

      <Card title={<span className="card-title-with-icon"><FileText size={18} />报告列表</span>} bordered={false}>
        <Table
          rowKey="report_id"
          loading={reports.isLoading}
          dataSource={filtered}
          locale={{ emptyText: <Empty description="暂无报告" /> }}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 份报告` }}
          scroll={{ x: 1280 }}
          rowSelection={{
            selectedRowKeys,
            onChange: (keys) => {
              if (keys.length > 3) {
                message.warning('最多选择 3 份报告');
                return;
              }
              setSelectedRowKeys(keys);
            },
          }}
          columns={[
            {
              title: '报告',
              width: 280,
              render: (_, report) => (
                <Space direction="vertical" size={2}>
                  <Link className="table-strong-link" to={`/reports/${report.report_id}`}>{report.channel_name}</Link>
                  <Typography.Text type="secondary">{report.run_name}</Typography.Text>
                </Space>
              ),
            },
            { title: '类型', dataIndex: 'mode', width: 150, render: (value: RunMode) => <Tag color={value === 'performance_benchmark' ? 'orange' : value === 'arena_comparison' ? 'purple' : 'blue'}>{modeLabel(value)}</Tag> },
            {
              title: '评级',
              dataIndex: 'grade',
              width: 90,
              render: (value: Report['grade']) => <Tag color={gradeColor[value]}>{value}</Tag>,
              sorter: (a, b) => a.grade.localeCompare(b.grade),
            },
            {
              title: '总分',
              dataIndex: 'final_score',
              width: 110,
              render: (value: number) => <strong>{value.toFixed(1)}</strong>,
              sorter: (a, b) => a.final_score - b.final_score,
            },
            { title: '角色', dataIndex: 'channel_role', width: 150, render: (value: string) => <Tag>{value}</Tag> },
            {
              title: '维度分',
              width: 260,
              render: (_, report) => (
                <Space wrap size={4}>
                  {Object.entries(report.dimension_scores ?? {}).map(([key, value]) => (
                    <Tag key={key}>{key} {numberText(value)}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: '性能',
              width: 210,
              render: (_, report) => (
                <Space direction="vertical" size={2}>
                  <span>P95 {numberText(report.performance.latency_p95_ms, ' ms')}</span>
                  <Typography.Text type="secondary">失败率 {numberText(report.performance.failure_rate, '%')}</Typography.Text>
                </Space>
              ),
            },
            {
              title: '异常标签',
              width: 260,
              render: (_, report) => (
                <Space wrap size={4}>
                  {(report.labels.length ? report.labels.slice(0, 4) : ['no_labels']).map((item) => <Tag key={item} color={item === 'no_labels' ? 'green' : 'orange'}>{item}</Tag>)}
                  {report.labels.length > 4 ? <Tag>+{report.labels.length - 4}</Tag> : null}
                </Space>
              ),
            },
            { title: '创建时间', dataIndex: 'created_at', width: 180, render: formatDateTime },
            {
              title: '操作',
              width: 130,
              fixed: 'right',
              render: (_, report) => (
                <Link to={`/reports/${report.report_id}`} className="table-action-link">
                  <BarChart3 size={15} /> 查看
                </Link>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
