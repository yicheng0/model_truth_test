import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { Key } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Input, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd';
import { BarChart3, FileText, GitCompare, Search, Trash2 } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, getErrorMessage } from '../api';
import { useAdminAccess } from '../adminAccess';
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

const gradeOptions = ['A', 'B', 'C', 'D', 'E'] as const;

function paramValue(params: URLSearchParams, key: string, fallback: string, allowed: readonly string[]) {
  const value = params.get(key);
  return value && allowed.includes(value) ? value : fallback;
}

function setSearchParamValue(params: URLSearchParams, key: string, value?: string | null) {
  const trimmed = value?.trim();
  if (trimmed) params.set(key, trimmed);
  else params.delete(key);
}

function bulkDeleteMessage(entity: string, result: { deleted: number; missing: string[] }) {
  const missing = result.missing ?? [];
  if (result.deleted > 0 && missing.length === 0) {
    message.success(`已删除 ${result.deleted} ${entity}`);
    return;
  }
  if (result.deleted > 0) {
    message.warning(`已删除 ${result.deleted} ${entity}，${missing.length} 个未命中：${missing.join('、')}`);
    return;
  }
  message.warning(`未删除任何${entity}，${missing.length ? `未命中：${missing.join('、')}` : '所选项不存在或已被删除'}`);
}

function modeLabel(mode: string) {
  return modeOptions.find((item) => item.value === mode)?.label ?? mode;
}

function numberText(value?: number | null, suffix = '') {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : '-';
}

function labelsOf(reports: ReportSummary[]) {
  return Array.from(new Set(reports.flatMap((report) => report.labels ?? []))).sort();
}

function normalizedLabels(report: ReportSummary) {
  return report.labels ?? [];
}

export default function ReportsPage() {
  const navigate = useNavigate();
  const { isAdminMode } = useAdminAccess();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const reports = useQuery({ queryKey: ['reportSummaries'], queryFn: api.reportSummaries });
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [deletingReportId, setDeletingReportId] = useState<string | null>(null);
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '');
  const [grade, setGrade] = useState(() => paramValue(searchParams, 'grade', 'all', ['all', ...gradeOptions]));
  const [role, setRole] = useState(() => searchParams.get('role') ?? 'all');
  const [label, setLabel] = useState(() => searchParams.get('label') ?? 'all');
  const [scoreRange, setScoreRange] = useState(() => paramValue(searchParams, 'score', 'all', scoreRanges.map((item) => item.value)));
  const [mode, setMode] = useState<RunMode | 'all'>(() => paramValue(searchParams, 'mode', 'candidate_eval', modeOptions.map((item) => item.value)) as RunMode | 'all');
  const deferredQuery = useDeferredValue(query);

  const data = reports.data ?? [];
  const selectedReports = useMemo(() => data.filter((report) => selectedRowKeys.includes(report.report_id)), [data, selectedRowKeys]);
  const selectedModes = useMemo(() => Array.from(new Set(selectedReports.map((report) => report.mode))), [selectedReports]);
  const canCompare = selectedRowKeys.length >= 2 && selectedRowKeys.length <= 3 && selectedModes.length === 1;
  const roles = useMemo(() => Array.from(new Set(data.map((report) => report.channel_role))).sort(), [data]);
  const labels = useMemo(() => labelsOf(data), [data]);
  const hasActiveFilters = mode !== 'all' || grade !== 'all' || role !== 'all' || label !== 'all' || scoreRange !== 'all' || Boolean(query.trim());

  useEffect(() => {
    setQuery(searchParams.get('q') ?? '');
    setGrade(paramValue(searchParams, 'grade', 'all', ['all', ...gradeOptions]));
    setRole(searchParams.get('role') ?? 'all');
    setLabel(searchParams.get('label') ?? 'all');
    setScoreRange(paramValue(searchParams, 'score', 'all', scoreRanges.map((item) => item.value)));
    setMode(paramValue(searchParams, 'mode', 'candidate_eval', modeOptions.map((item) => item.value)) as RunMode | 'all');
  }, [searchParams]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    setSearchParamValue(next, 'q', query);
    mode === 'candidate_eval' ? next.delete('mode') : next.set('mode', mode);
    grade === 'all' ? next.delete('grade') : next.set('grade', grade);
    role === 'all' ? next.delete('role') : next.set('role', role);
    label === 'all' ? next.delete('label') : next.set('label', label);
    scoreRange === 'all' ? next.delete('score') : next.set('score', scoreRange);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [grade, label, mode, query, role, scoreRange, searchParams, setSearchParams]);

  const filtered = useMemo(() => {
    const text = deferredQuery.trim().toLowerCase();
    return data.filter((report) => {
      if (mode !== 'all' && report.mode !== mode) return false;
      if (grade !== 'all' && report.grade !== grade) return false;
      if (role !== 'all' && report.channel_role !== role) return false;
      const reportLabels = normalizedLabels(report);
      if (label !== 'all' && !reportLabels.includes(label)) return false;
      if (scoreRange === 'high' && report.final_score < 85) return false;
      if (scoreRange === 'medium' && (report.final_score < 70 || report.final_score >= 85)) return false;
      if (scoreRange === 'low' && report.final_score >= 70) return false;
      if (!text) return true;
      return [report.run_name, report.channel_name, report.summary, report.grade, ...reportLabels]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(text);
    });
  }, [data, deferredQuery, grade, label, mode, role, scoreRange]);

  const deleteOne = useMutation({
    mutationFn: api.deleteReport,
    onSuccess: async (_, id) => {
      message.success('报告已删除');
      setSelectedRowKeys((keys) => keys.filter((key) => key !== id));
      await queryClient.invalidateQueries({ queryKey: ['reportSummaries'] });
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
      await queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
    onSettled: () => setDeletingReportId(null),
  });

  const deleteMany = useMutation({
    mutationFn: api.deleteReports,
    onSuccess: async (result) => {
      bulkDeleteMessage('份报告', result);
      setSelectedRowKeys([]);
      await queryClient.invalidateQueries({ queryKey: ['reportSummaries'] });
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
      await queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  function compareSelected() {
    if (selectedRowKeys.length < 2) {
      message.warning('请至少选择 2 份报告');
      return;
    }
    if (selectedModes.length > 1) {
      message.warning('只能对比同一类型的报告');
      return;
    }
    if (selectedRowKeys.length > 3) {
      message.warning('最多选择 3 份报告进行对比');
      return;
    }
    navigate(`/compare?report_ids=${selectedRowKeys.join(',')}`);
  }

  function deleteSelected() {
    const ids = selectedRowKeys.map(String);
    if (!ids.length) {
      message.warning('请先选择报告');
      return;
    }
    deleteMany.mutate(ids);
  }

  function clearFilters() {
    setQuery('');
    setMode('candidate_eval');
    setGrade('all');
    setRole('all');
    setLabel('all');
    setScoreRange('all');
  }

  return (
    <Space direction="vertical" size={20} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">REPORT CENTER</Typography.Text>
          <Typography.Title level={2}>报告页</Typography.Title>
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
          <Button onClick={clearFilters}>清空</Button>
        </div>
      </Card>

      <Card title={<span className="card-title-with-icon"><FileText size={18} />报告列表</span>} bordered={false}>
        <Space wrap style={{ width: '100%', marginBottom: 16 }}>
          <Button icon={<GitCompare size={16} />} disabled={!canCompare} onClick={compareSelected}>
            对比已选
          </Button>
          {isAdminMode ? (
            <Popconfirm
              title="删除已选报告"
              description={`将删除 ${selectedRowKeys.length} 份报告及其关联告警；检测任务和原始结果会保留。确定删除吗？`}
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              disabled={!selectedRowKeys.length}
              onConfirm={deleteSelected}
            >
              <Button danger icon={<Trash2 size={15} />} disabled={!selectedRowKeys.length} loading={deleteMany.isPending}>
                删除已选
              </Button>
            </Popconfirm>
          ) : null}
          <Typography.Text type="secondary">已选 {selectedRowKeys.length} / 当前筛选 {filtered.length}</Typography.Text>
        </Space>
        <Table
          rowKey="report_id"
          loading={reports.isLoading}
          dataSource={filtered}
          locale={{ emptyText: reports.isLoading ? '正在加载报告' : hasActiveFilters ? <Empty description="当前筛选条件下无报告" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : <Empty description="暂无报告" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 份报告` }}
          scroll={{ x: 1280 }}
          rowSelection={{
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys),
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
                  {(normalizedLabels(report).length ? normalizedLabels(report).slice(0, 4) : ['no_labels']).map((item) => <Tag key={item} color={item === 'no_labels' ? 'green' : 'orange'}>{item}</Tag>)}
                  {normalizedLabels(report).length > 4 ? <Tag>+{normalizedLabels(report).length - 4}</Tag> : null}
                </Space>
              ),
            },
            { title: '创建时间', dataIndex: 'created_at', width: 180, render: formatDateTime },
            {
              title: '操作',
              width: 200,
              fixed: 'right',
              render: (_, report) => (
                <Space wrap>
                  <Link to={`/reports/${report.report_id}`} className="table-action-link">
                    <BarChart3 size={15} /> 查看
                  </Link>
                  {isAdminMode ? (
                    <Popconfirm
                      title="删除报告"
                      description="将删除这份报告及其关联告警；检测任务和原始结果会保留。确定删除吗？"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => {
                        setDeletingReportId(report.report_id);
                        deleteOne.mutate(report.report_id);
                      }}
                    >
                      <Button danger icon={<Trash2 size={15} />} loading={deletingReportId === report.report_id}>
                        删除
                      </Button>
                    </Popconfirm>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
