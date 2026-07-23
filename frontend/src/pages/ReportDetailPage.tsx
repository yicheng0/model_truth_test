import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Drawer, Empty, Input, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { TabsProps } from 'antd';
import { Copy, Download, Eye, FileJson, Gauge, ListFilter } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api, getErrorMessage } from '../api';
import { formatChannelDisplayName } from '../channelCredentials';
import { formatDateTime } from '../time';
import type { Report, ReportPredictionRow, Result, RunMode } from '../types';
import { formatPatrolChannel } from '../runsUtils';

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

function jsonText(value: unknown) {
  if (value === undefined || value === null) return '-';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function responseText(result?: Result | null) {
  const normalized = result?.normalized_response;
  if (typeof normalized?.content_text === 'string' && normalized.content_text.trim()) return normalized.content_text;
  if (Array.isArray(normalized?.tool_calls) && normalized.tool_calls.length) return JSON.stringify(normalized.tool_calls, null, 2);
  if (normalized?.error) return String(normalized.error);
  return '暂无输出';
}

function copyText(text: string) {
  void navigator.clipboard?.writeText(text);
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : '-';
}

function compactId(value: unknown) {
  const text = stringValue(value);
  if (text === '-' || text.length <= 22) return text;
  return `${text.slice(0, 11)}...${text.slice(-7)}`;
}

function modeLabel(mode: RunMode) {
  if (mode === 'baseline_build') return '渠道指纹报告';
  if (mode === 'manual_probe') return '单次探测报告';
  return '真实性对比报告';
}

function modeDescription(mode: RunMode) {
  if (mode === 'baseline_build') return '官方或参考渠道的指纹采集结果，用于后续真实性对比。';
  return '基于渠道指纹、协议字段、输出相似度和样本证据形成的真实性判断。';
}

export default function ReportDetailPage() {
  const { reportId = '' } = useParams();
  const detail = useQuery({ queryKey: ['reportDetail', reportId], queryFn: () => api.reportDetail(reportId), enabled: Boolean(reportId) });
  const [moduleFilter, setModuleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [openRow, setOpenRow] = useState<ReportPredictionRow | null>(null);

  const data = detail.data;
  const rows = data?.prediction_rows ?? [];
  const modules = useMemo(() => Array.from(new Set(rows.map((row) => row.module))).sort(), [rows]);
  const filteredRows = useMemo(() => {
    const text = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (moduleFilter !== 'all' && row.module !== moduleFilter) return false;
      if (statusFilter === 'low' && (row.score ?? 100) >= 70) return false;
      if (statusFilter === 'labeled' && !row.labels.length) return false;
      if (statusFilter === 'error' && !row.result?.normalized_response?.error) return false;
      if (!text) return true;
      return [row.title, row.prompt, responseText(row.result), ...row.labels].join(' ').toLowerCase().includes(text);
    });
  }, [moduleFilter, rows, search, statusFilter]);

  if (detail.isError) {
    return (
      <Card bordered={false}>
        <Alert type="error" showIcon message="报告详情加载失败" description={getErrorMessage(detail.error)} action={<Button onClick={() => detail.refetch()}>重试</Button>} />
      </Card>
    );
  }

  if (detail.isLoading || !data) {
    return <Card loading bordered={false} />;
  }

  const report = data.report;
  const mode = data.run.mode;
  const evidence = report.evidence ?? {};
  const dimensions = evidence.dimension_scores ?? {};
  const labels = Array.isArray(evidence.labels) ? evidence.labels : [];
  const performance = data.performance_summary;
  const isScheduledProbeReport = evidence.test_scope === 'scheduled_probe';
  const legacyModelRequest = evidence.model_request && typeof evidence.model_request === 'object' ? evidence.model_request as Record<string, unknown> : null;
  const modelRequests = (arrayValue(evidence.model_requests) as Array<Record<string, unknown>>).length
    ? arrayValue(evidence.model_requests) as Array<Record<string, unknown>>
    : legacyModelRequest ? [legacyModelRequest] : [];
  const signatureInterop = evidence.signature_interop && typeof evidence.signature_interop === 'object' ? evidence.signature_interop as Record<string, unknown> : {};
  const dimensionEntries = Object.entries(dimensions);
  const sampleLabel = '预测样本';
  const lowSampleLabel = '低分样本';
  const overviewTitle = '维度分与关键证据';

  const metricStrip = (
    <section className="metric-strip">
      <div><span>评级</span><strong><Tag color={gradeColor[report.grade]}>{report.grade}</Tag></strong></div>
      <div><span>真实性分</span><strong>{fmt(report.final_score)}</strong></div>
      <div><span>置信度</span><strong>{String(evidence.confidence ?? '-')}</strong></div>
      <div><span>异常标签</span><strong>{labels.length}</strong></div>
    </section>
  );

  const reportTabs: NonNullable<TabsProps['items']> = [
    {
      key: 'overview',
      label: '概览',
      children: (
        <Space direction="vertical" size={16} className="full-width">
          <Card bordered={false}>
            <Descriptions column={{ xs: 1, md: 2, xl: 3 }} bordered size="small">
              <Descriptions.Item label="报告类型">{modeLabel(mode)}</Descriptions.Item>
              <Descriptions.Item label="渠道">{formatChannelDisplayName(data.channel)}</Descriptions.Item>
              <Descriptions.Item label="模型">{data.channel.model_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="角色">{data.channel.role}</Descriptions.Item>
              <Descriptions.Item label="任务状态">{data.run.status}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{formatDateTime(report.created_at)}</Descriptions.Item>
              <Descriptions.Item label="测试范围">{data.run.test_scope}</Descriptions.Item>
            </Descriptions>
          </Card>
          <Card title={overviewTitle} bordered={false}>
            {dimensionEntries.length ? (
              <div className="dimension-grid">
                {dimensionEntries.map(([key, value]) => (
                  <div key={key} className="dimension-tile">
                    <span>{key}</span>
                    <strong>{fmt(value as number | null)}</strong>
                  </div>
                ))}
              </div>
            ) : null}
            <Typography.Paragraph className="report-summary-text">{report.summary}</Typography.Paragraph>
            {isScheduledProbeReport ? (
              <div className="patrol-report-matrix">
                <div className="patrol-report-matrix-head">
                  <Typography.Text className="section-kicker">PATROL PROBES</Typography.Text>
                  <Typography.Title level={4}>自动巡检探针结果</Typography.Title>
                </div>
                {modelRequests[0] ? (
                  <Typography.Text type="secondary">
                    上游响应 ID（Message ID）：{String(modelRequests[0].response_id ?? modelRequests[0].message_id ?? '-')} · Request ID：{String(modelRequests[0].request_id ?? '-')}
                  </Typography.Text>
                ) : null}
                <Table
                  rowKey={(row, index) => String(row.key ?? row.result_id ?? index)}
                  dataSource={modelRequests}
                  pagination={false}
                  size="small"
                  scroll={{ x: 790 }}
                  columns={[
                    { title: '参数探针', width: 210, render: (_, row) => <strong>{stringValue(row.title ?? row.key)}</strong> },
                    { title: '渠道', width: 220, render: (_, row) => formatPatrolChannel({ id: stringValue(row.channel_id), name: stringValue(row.channel_name), providerType: stringValue((row as Record<string, unknown>).channel_provider_type), accountType: stringValue((row as Record<string, unknown>).channel_account_type) }, stringValue(row.channel_id)) },
                    {
                      title: '状态',
                      width: 100,
                      render: (_, row) => {
                        const hasError = Boolean(row.error) || arrayValue(row.labels).length > 0;
                        return <Tag color={hasError ? 'red' : 'green'}>{hasError ? '异常' : '正常'}</Tag>;
                      },
                    },
                    { title: '上游响应 ID（Message ID）', width: 220, render: (_, row) => compactId(row.response_id ?? row.message_id) },
                    { title: 'Request ID', width: 190, render: (_, row) => compactId(row.request_id) },
                    { title: '协议', width: 130, render: (_, row) => stringValue(row.request_protocol) },
                    { title: 'Endpoint', width: 230, render: (_, row) => compactId(row.provider_endpoint) },
                    {
                      title: '标签/错误',
                      width: 240,
                      render: (_, row) => arrayValue(row.labels).length ? (
                        <Space wrap size={4}>{arrayValue(row.labels).map((label) => <Tag key={String(label)} color="orange">{String(label)}</Tag>)}</Space>
                      ) : stringValue(row.error),
                    },
                  ]}
                />
                <div className="patrol-signature-panel">
                  <div>
                    <span>Signature 状态</span>
                    <strong><Tag color={signatureInterop.status === 'pass' ? 'green' : signatureInterop.status === 'fail' ? 'red' : 'default'}>{stringValue(signatureInterop.status)}</Tag></strong>
                  </div>
                  <div><span>Source 渠道</span><strong>{formatPatrolChannel({ id: stringValue(signatureInterop.source_channel_id), name: stringValue(signatureInterop.source_channel_name), providerType: stringValue((signatureInterop as Record<string, unknown>).source_channel_provider_type), accountType: stringValue((signatureInterop as Record<string, unknown>).source_channel_account_type) }, stringValue(signatureInterop.source_channel_id))}</strong></div>
                  <div><span>Source 上游响应 ID（Message ID）</span><strong>{compactId(signatureInterop.source_message_id)}</strong></div>
                  <div><span>Source Request ID</span><strong>{compactId(signatureInterop.source_request_id)}</strong></div>
                  <div><span>Relay 渠道</span><strong>{formatPatrolChannel({ id: stringValue(signatureInterop.relay_channel_id), name: stringValue(signatureInterop.relay_channel_name), providerType: stringValue((signatureInterop as Record<string, unknown>).relay_channel_provider_type), accountType: stringValue((signatureInterop as Record<string, unknown>).relay_channel_account_type) }, stringValue(signatureInterop.relay_channel_id))}</strong></div>
                  <div><span>Relay 上游响应 ID（Message ID）</span><strong>{compactId(signatureInterop.relay_message_id)}</strong></div>
                  <div><span>Relay Request ID</span><strong>{compactId(signatureInterop.relay_request_id)}</strong></div>
                  <div><span>Signature 前缀</span><strong>{arrayValue(signatureInterop.signature_prefixes).join(', ') || '-'}</strong></div>
                  <div><span>失败阶段</span><strong>{stringValue(signatureInterop.error_stage)}</strong></div>
                  <div><span>HTTP 状态</span><strong>{String(signatureInterop.error_http_status ?? '-')}</strong></div>
                </div>
                {signatureInterop.reason ? <Typography.Text type="secondary">{String(signatureInterop.reason)}</Typography.Text> : null}
                {signatureInterop.raw_error ? <Alert type="error" showIcon message="原始错误" description={String(signatureInterop.raw_error)} /> : null}
                {arrayValue(signatureInterop.request_logs).length ? (
                  <Table
                    rowKey={(row, index) => String(row.stage ?? row.started_at ?? index)}
                    dataSource={arrayValue(signatureInterop.request_logs) as Array<Record<string, unknown>>}
                    pagination={false}
                    size="small"
                    expandable={{
                      expandedRowRender: (row) => (
                        <div className="patrol-probe-detail">
                          <div className="patrol-probe-detail-row full"><span>脱敏请求体</span><pre className="patrol-probe-response">{stringValue(row.request_excerpt)}</pre></div>
                          <div className="patrol-probe-detail-row full"><span>脱敏原始响应</span><pre className="patrol-probe-response">{stringValue(row.response_excerpt)}</pre></div>
                        </div>
                      ),
                    }}
                    columns={[
                      { title: '阶段', width: 100, render: (_, row) => stringValue(row.stage) },
                      { title: '状态', width: 90, render: (_, row) => <Tag color={row.status === 'ok' ? 'green' : 'red'}>{row.status === 'ok' ? '成功' : '失败'}</Tag> },
                      { title: '时间', width: 180, render: (_, row) => formatDateTime(String(row.completed_at ?? row.started_at ?? '')) },
                      { title: 'HTTP', width: 90, render: (_, row) => String(row.http_status ?? '-') },
                      { title: '上游响应 ID（Message ID）', width: 220, render: (_, row) => compactId(row.response_id ?? row.message_id) },
                      { title: '请求 ID', width: 190, render: (_, row) => compactId(row.gateway_request_id) },
                      { title: '上游请求 ID', width: 190, render: (_, row) => compactId(row.upstream_request_id ?? row.response_header_request_id ?? row.request_id) },
                      { title: '错误', render: (_, row) => stringValue(row.error) },
                    ]}
                    scroll={{ x: 1140 }}
                  />
                ) : null}
              </div>
            ) : null}
            <Space wrap>
              {(labels.length ? labels : ['no_labels']).map((item: string) => (
                <Tag key={item} color={item === 'no_labels' ? 'green' : 'orange'}>{item}</Tag>
              ))}
            </Space>
          </Card>
        </Space>
      ),
    },
    {
      key: 'predictions',
      label: sampleLabel,
      children: (
        <Card
          bordered={false}
          title={<span className="card-title-with-icon"><ListFilter size={18} />样本浏览</span>}
        >
          <div className="report-filter-grid">
            <Input allowClear placeholder="搜索题目、输出或标签" value={search} onChange={(event) => setSearch(event.target.value)} />
            <Select value={moduleFilter} onChange={setModuleFilter} options={[{ value: 'all', label: '全部模块' }, ...modules.map((item) => ({ value: item, label: item }))]} />
            <Select
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'all', label: '全部样本' },
                { value: 'low', label: lowSampleLabel },
                { value: 'labeled', label: '有异常标签' },
                { value: 'error', label: '请求错误' },
              ]}
            />
          </div>
          <Table
            rowKey="test_case_id"
            dataSource={filteredRows}
            pagination={{ pageSize: 8, showTotal: (total) => `共 ${total} 道题` }}
            scroll={{ x: 1180 }}
            locale={{ emptyText: <Empty description="没有匹配样本" /> }}
            rowClassName={(row) => (row.labels.length || (row.score ?? 100) < 70 ? 'highlight-table-row' : '')}
            columns={[
              {
                title: '题目',
                width: 300,
                render: (_, row) => (
                  <Space direction="vertical" size={2}>
                    <strong>{row.title}</strong>
                    <Typography.Text type="secondary">{row.test_case_id}</Typography.Text>
                  </Space>
                ),
              },
              { title: '模块', dataIndex: 'module', width: 130, render: (value: string) => <Tag>{value}</Tag> },
              { title: '分数', dataIndex: 'score', width: 100, render: (value: number | null) => <strong>{fmt(value)}</strong>, sorter: (a, b) => (a.score ?? 0) - (b.score ?? 0) },
              { title: '延迟', dataIndex: 'latency_ms', width: 100, render: (value: number | null) => fmt(value, ' ms') },
              {
                title: '输出摘要',
                width: 360,
                render: (_, row) => <span className="response-snippet">{responseText(row.result).replace(/\s+/g, ' ').slice(0, 150)}</span>,
              },
              {
                title: '标签',
                width: 260,
                render: (_, row) => (
                  <Space wrap size={4}>
                    {(row.labels.length ? row.labels : ['no_labels']).slice(0, 4).map((item) => <Tag key={item} color={item === 'no_labels' ? 'green' : 'orange'}>{item}</Tag>)}
                  </Space>
                ),
              },
              {
                title: '操作',
                width: 110,
                fixed: 'right',
                render: (_, row) => <Button size="small" icon={<Eye size={14} />} onClick={() => setOpenRow(row)}>查看</Button>,
              },
            ]}
          />
        </Card>
      ),
    },
    {
      key: 'protocol',
      label: '协议证据',
      children: (
        <Card bordered={false} title={<span className="card-title-with-icon"><FileJson size={18} />协议字段</span>}>
          <Table
            rowKey="id"
            dataSource={data.results}
            pagination={{ pageSize: 8 }}
            scroll={{ x: 980 }}
            columns={[
              { title: '题目', dataIndex: 'test_case_id', width: 220 },
              { title: '上游响应 ID（Message ID）', width: 220, render: (_, result) => result.upstream_response_id ?? result.normalized_response?.provider_message_id ?? '-' },
              { title: 'Request ID', width: 200, render: (_, result) => result.upstream_request_id ?? '-' },
              { title: 'model', width: 180, render: (_, result) => result.normalized_response?.provider_model ?? '-' },
              { title: 'stop_reason', width: 140, render: (_, result) => result.normalized_response?.stop_reason ?? '-' },
              { title: 'usage', width: 180, render: (_, result) => jsonText(result.normalized_response?.usage ?? result.raw_response?.usage) },
              { title: 'stream', width: 180, render: (_, result) => (result.normalized_response?.stream_events ?? []).join(' / ') || '-' },
            ]}
          />
        </Card>
      ),
    },
    {
      key: 'raw',
      label: '原始结果',
      children: (
        <Card bordered={false} title={<span className="card-title-with-icon"><FileJson size={18} />运行字段</span>}>
          <Table
            rowKey="id"
            dataSource={data.results}
            pagination={{ pageSize: 8 }}
            scroll={{ x: 1040 }}
            columns={[
              { title: '题目', dataIndex: 'test_case_id', width: 220 },
              { title: 'score', dataIndex: 'score', width: 100, render: (value: number | null) => fmt(value) },
              { title: 'latency', width: 120, render: (_, result) => fmt((result.metrics as Record<string, number | undefined> | undefined)?.latency_ms, ' ms') },
              { title: 'ttft', width: 120, render: (_, result) => fmt((result.metrics as Record<string, number | undefined> | undefined)?.ttft_ms, ' ms') },
              { title: 'throughput', width: 130, render: (_, result) => fmt((result.metrics as Record<string, number | undefined> | undefined)?.tokens_per_second, ' tok/s') },
              { title: 'error', width: 220, render: (_, result) => result.normalized_response?.error ?? '-' },
            ]}
          />
        </Card>
      ),
    },
    {
      key: 'performance',
      label: '运行性能',
      children: (
        <Card bordered={false} title={<span className="card-title-with-icon"><Gauge size={18} />性能摘要</span>}>
          <div className="dimension-grid">
            <div className="dimension-tile"><span>平均延迟</span><strong>{fmt(performance.avg_latency_ms ?? performance.latency_avg_ms, ' ms')}</strong></div>
            <div className="dimension-tile"><span>P95</span><strong>{fmt(performance.p95_latency_ms ?? performance.latency_p95_ms, ' ms')}</strong></div>
            <div className="dimension-tile"><span>P99</span><strong>{fmt(performance.p99_latency_ms ?? performance.latency_p99_ms, ' ms')}</strong></div>
            <div className="dimension-tile"><span>失败率</span><strong>{fmt(performance.failure_rate, '%')}</strong></div>
          </div>
          <Table
            rowKey="test_case_id"
            dataSource={[...rows].sort((a, b) => (b.latency_ms ?? 0) - (a.latency_ms ?? 0)).slice(0, 10)}
            pagination={false}
            columns={[
              { title: '高延迟题目', dataIndex: 'title' },
              { title: '模块', dataIndex: 'module', width: 140, render: (value: string) => <Tag>{value}</Tag> },
              { title: '延迟', dataIndex: 'latency_ms', width: 140, render: (value: number | null) => fmt(value, ' ms') },
            ]}
          />
        </Card>
      ),
    },
    {
      key: 'markdown',
      label: 'Markdown',
      children: <pre className="markdown-preview">{report.markdown ?? '暂无 Markdown 报告'}</pre>,
    },
  ];

  return (
    <Space direction="vertical" size={20} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">{modeLabel(mode)}</Typography.Text>
          <Typography.Title level={2}>{formatChannelDisplayName(data.channel)}</Typography.Title>
          <Typography.Paragraph>{data.run.name} · {data.suite?.name ?? data.run.suite_id}</Typography.Paragraph>
          <Typography.Paragraph type="secondary">{modeDescription(mode)}</Typography.Paragraph>
        </div>
        <Space wrap>
          <Button href={api.reportUrl(report.run_id)} target="_blank" icon={<Download size={16} />}>导出 Markdown</Button>
          <Link to="/reports"><Button>返回报告页</Button></Link>
        </Space>
      </div>

      {metricStrip}

      <Tabs className="report-tabs" items={reportTabs} />

      <Drawer
        title={openRow?.title}
        width={760}
        open={Boolean(openRow)}
        onClose={() => setOpenRow(null)}
        extra={<Button icon={<Copy size={15} />} onClick={() => copyText(jsonText(openRow))}>复制 JSON</Button>}
      >
        {openRow ? (
          <Tabs
            items={[
              { key: 'answer', label: 'Answer', children: <pre className="response-pre">{responseText(openRow.result)}</pre> },
              { key: 'normalized', label: 'Normalized', children: <pre className="json-block">{jsonText(openRow.result?.normalized_response)}</pre> },
              { key: 'raw', label: 'Raw', children: <pre className="json-block">{jsonText({ request: openRow.result?.raw_request, response: openRow.result?.raw_response })}</pre> },
              { key: 'scoring', label: 'Scoring', children: <pre className="json-block">{jsonText({ score: openRow.score, labels: openRow.labels, comparison: openRow.comparison, scoring_rules: openRow.scoring_rules })}</pre> },
            ]}
          />
        ) : null}
      </Drawer>
    </Space>
  );
}
