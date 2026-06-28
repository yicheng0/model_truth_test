import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Descriptions, Form, InputNumber, Select, Space, Statistic, Table, Tabs, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Gauge, Play, ShieldCheck } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { formatChannelDisplayName } from '../channelCredentials';
import type { Channel, FullModelChannelResult, FullModelCheckRequest, FullModelCheckResult, FullModelProbeResult } from '../types';

type FormValues = {
  channel_ids: string[];
  repeat_count: number;
  include_stream: boolean;
  include_tools: boolean;
  include_params: boolean;
  include_error_probe: boolean;
  include_thinking: boolean;
  include_vision: boolean;
  timeout_seconds: number;
};

function ms(value?: number | null) {
  return value == null ? '-' : `${value.toFixed(0)} ms`;
}

function seconds(value?: number | null) {
  return value == null ? '-' : `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} s`;
}

function num(value?: number | null, suffix = '') {
  return value == null ? '-' : `${Number(value).toFixed(2)}${suffix}`;
}

function shortHash(value?: string | null) {
  if (!value) return '-';
  return value.length > 28 ? `${value.slice(0, 18)}…${value.slice(-8)}` : value;
}

function statusTag(status: string) {
  const color = status === 'pass' ? 'green' : status === 'warning' ? 'orange' : status === 'degraded' ? 'orange' : status === 'fail' || status === 'failed' ? 'red' : 'blue';
  const text: Record<string, string> = { pass: '通过', warning: '警告', degraded: '降级', fail: '失败', failed: '失败' };
  return <Tag color={color}>{text[status] ?? status}</Tag>;
}

function statusClass(status: string) {
  if (status === 'pass') return 'pass';
  if (status === 'warning' || status === 'degraded') return 'warning';
  if (status === 'fail' || status === 'failed') return 'fail';
  return 'info';
}

function protocolLabel(channel: Channel) {
  const protocol = String(channel.auth_config?.request_protocol || channel.provider_type || 'auto');
  return `${formatChannelDisplayName(channel)} · ${channel.model_name || '未配置模型'} · ${protocol}`;
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? null, null, 2);
}

function metricLine(probe: FullModelProbeResult) {
  return `${probe.category} · HTTP ${probe.http_status ?? '-'} · ${seconds(probe.latency_ms)}`;
}

function primaryEvidence(probe?: FullModelProbeResult | null) {
  if (!probe) return '-';
  return probe.conclusion || probe.observed || probe.error_excerpt || probe.excerpt || '-';
}

function groupAttempts(probes: FullModelProbeResult[]) {
  const grouped = new Map<string, FullModelProbeResult[]>();
  for (const probe of probes) {
    const key = probe.base_key || probe.key.split('#', 1)[0];
    grouped.set(key, [...(grouped.get(key) ?? []), probe]);
  }
  return [...grouped.values()].map((items) => items.sort((a, b) => (a.attempt_index ?? 1) - (b.attempt_index ?? 1)));
}

function FieldTile({ label, children, success = false }: { label: string; children: React.ReactNode; success?: boolean }) {
  return (
    <div className={`full-model-field-tile ${success ? 'success' : ''}`}>
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

function ProbeList({ probes, selectedKey, onSelect }: { probes: FullModelProbeResult[]; selectedKey?: string; onSelect: (key: string) => void }) {
  return (
    <div className="full-model-probe-list" role="list" aria-label="完整检测探针列表">
      {groupAttempts(probes).map((items) => {
        const first = items[0];
        const representative = items.find((item) => item.status !== 'pass') ?? first;
        const active = items.some((item) => item.key === selectedKey);
        return (
          <button
            type="button"
            key={first.base_key || first.key}
            className={`full-model-probe-item ${statusClass(representative.status)} ${active ? 'active' : ''}`}
            onClick={() => onSelect(representative.key)}
          >
            <div>
              <strong>{first.title.replace(/（第 \d+ 次）$/, '')}</strong>
              <small>{first.category} · HTTP {representative.http_status ?? '-'} · {seconds(representative.latency_ms)}</small>
            </div>
            {statusTag(representative.status)}
          </button>
        );
      })}
    </div>
  );
}

const attemptColumns: ColumnsType<FullModelProbeResult> = [
  { title: '运行', width: 80, render: (_, row) => `#${row.attempt_index ?? 1}` },
  { title: '状态', dataIndex: 'status', width: 90, render: statusTag },
  { title: 'HTTP', dataIndex: 'http_status', width: 80, render: (v: number | null) => v ?? '-' },
  { title: '耗时', dataIndex: 'latency_ms', width: 95, render: seconds },
  { title: 'TTFT', dataIndex: 'ttft_ms', width: 95, render: ms },
  { title: 'TPOT', dataIndex: 'tpot_ms', width: 95, render: ms },
  { title: '吞吐', dataIndex: 'tokens_per_second', width: 120, render: (v: number | null) => num(v, ' tok/s') },
  { title: '响应 ID', dataIndex: 'message_id', width: 180, render: (v: string | null) => v ? <Typography.Text copyable ellipsis={{ tooltip: v }}>{v}</Typography.Text> : '-' },
  { title: 'Request ID', dataIndex: 'request_id', width: 180, render: (v: string | null) => v ? <Typography.Text copyable ellipsis={{ tooltip: v }}>{v}</Typography.Text> : '-' },
  { title: '本次结论', dataIndex: 'conclusion', render: (v: string | null, row) => <Typography.Text ellipsis={{ tooltip: v || row.reason || row.error_excerpt || '' }}>{v || row.reason || row.error_excerpt || '-'}</Typography.Text> },
];

function ProbeDetail({ channel, probe }: { channel: FullModelChannelResult; probe: FullModelProbeResult }) {
  const attempts = channel.probes.filter((item) => (item.base_key || item.key.split('#', 1)[0]) === (probe.base_key || probe.key.split('#', 1)[0]));
  const usage = probe.structured_summary?.usage as Record<string, unknown> | undefined;
  return (
    <div className="full-model-detail-panel">
      <div className="full-model-detail-head">
        <div>
          <Typography.Title level={4}>{probe.title.replace(/（第 \d+ 次）$/, '')}</Typography.Title>
          <Typography.Text type="secondary">{metricLine(probe)}</Typography.Text>
        </div>
        {statusTag(probe.status)}
      </div>

      <div className="full-model-detail-grid">
        <FieldTile label="关键结论" success={probe.status === 'pass'}>{primaryEvidence(probe)}</FieldTile>
        <FieldTile label="原因">{probe.reason || probe.observed || '-'}</FieldTile>
        <FieldTile label="检测类型">{probe.detection_type || probe.category}</FieldTile>
        <FieldTile label="观测证据">{probe.status === 'pass' ? `${probe.protocol_family} 兼容` : (probe.observed || '-')}</FieldTile>
      </div>

      <div className="full-model-detail-grid wide-left">
        <FieldTile label="这根探针在验证">{probe.probe_target || '-'}</FieldTile>
        <FieldTile label="本次读数" success={probe.status === 'pass'}>{probe.conclusion || probe.observed || '-'}</FieldTile>
      </div>

      <div className="full-model-mini-grid">
        <FieldTile label="内容块">{probe.content_types?.join(', ') || '-'}</FieldTile>
        <FieldTile label="流式事件">{probe.stream_events?.join(', ') || '-'}</FieldTile>
        <FieldTile label="Usage">{usage ? Object.entries(usage).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => `${key}=${String(value)}`).join(' · ') : (probe.usage_present ? '已返回' : '缺失')}</FieldTile>
        <FieldTile label="耗时">{seconds(probe.latency_ms)} / TTFT {ms(probe.ttft_ms)}</FieldTile>
        <FieldTile label="响应 Hash">{probe.response_hash ? <Typography.Text copyable={{ text: probe.response_hash }}>{shortHash(probe.response_hash)}</Typography.Text> : '-'}</FieldTile>
        <FieldTile label="Endpoint">{probe.endpoint ? <Typography.Text copyable ellipsis={{ tooltip: probe.endpoint }}>{probe.endpoint}</Typography.Text> : '-'}</FieldTile>
      </div>

      <Space wrap>
        {(probe.labels.length ? probe.labels : ['no_blocking_labels']).map((label) => (
          <Tag key={label} color={label === 'no_blocking_labels' ? 'green' : 'orange'}>{label}</Tag>
        ))}
      </Space>

      <Card size="small" title="探针相关输出" extra={<Typography.Text type="secondary">结构化摘要</Typography.Text>}>
        <div className="full-model-output-grid">
          <FieldTile label="响应模型">{String(probe.structured_summary?.response_model || '-')}</FieldTile>
          <FieldTile label="响应 ID">{probe.message_id ? <Typography.Text copyable={{ text: probe.message_id }}>{probe.message_id}</Typography.Text> : '-'}</FieldTile>
          <FieldTile label="停止原因">{String(probe.structured_summary?.stop_reason || '-')}</FieldTile>
          <FieldTile label="Request ID">{probe.request_id ? <Typography.Text copyable={{ text: probe.request_id }}>{probe.request_id}</Typography.Text> : '-'}</FieldTile>
          <FieldTile label="输出摘要">{probe.excerpt || probe.error_excerpt || '-'}</FieldTile>
          <FieldTile label="响应 Hash">{probe.response_hash ? <Typography.Text copyable={{ text: probe.response_hash }}>{probe.response_hash}</Typography.Text> : '-'}</FieldTile>
        </div>
      </Card>

      <Card size="small" title="查看每次运行详情" extra={`${attempts.length} 次记录`}>
        <Table
          size="small"
          rowKey="key"
          columns={attemptColumns}
          dataSource={attempts}
          pagination={false}
          scroll={{ x: 1200 }}
          expandable={{
            expandedRowRender: (row) => (
              <Space direction="vertical" className="full-width">
                <Descriptions size="small" bordered column={3}>
                  <Descriptions.Item label="请求模板">{row.request_template || row.base_key || row.key}</Descriptions.Item>
                  <Descriptions.Item label="输入/输出 token">{row.input_tokens ?? '-'} / {row.output_tokens ?? '-'}</Descriptions.Item>
                  <Descriptions.Item label="错误类型">{row.error_type || '-'}</Descriptions.Item>
                </Descriptions>
                <pre className="json-block">{prettyJson({ structured_summary: row.structured_summary, raw_evidence: row.raw_evidence })}</pre>
              </Space>
            ),
          }}
        />
      </Card>
    </div>
  );
}

function ChannelResultPanel({ item }: { item: FullModelChannelResult }) {
  const [selectedKey, setSelectedKey] = useState<string | undefined>(() => item.probes[0]?.key);
  useEffect(() => {
    setSelectedKey(item.probes[0]?.key);
  }, [item.channel.id, item.probes]);
  const selected = item.probes.find((probe) => probe.key === selectedKey) ?? item.probes[0];
  return (
    <Card key={item.channel.id} bordered={false} title={`${formatChannelDisplayName(item.channel)} · ${item.channel.model_name || '未配置模型'}`} extra={statusTag(item.status)}>
      <Space direction="vertical" size={14} className="full-width">
        <Alert type={item.status === 'pass' ? 'success' : item.status === 'failed' ? 'error' : 'warning'} showIcon message={item.summary} />
        <Space wrap>
          <Tag color="blue">{item.protocol_family}</Tag>
          {item.labels.map((label) => <Tag key={label} color="orange">{label}</Tag>)}
        </Space>
        <div className="monitor-stat-grid">
          <Card size="small"><Statistic title="总分" value={item.score} suffix="/100" /></Card>
          <Card size="small"><Statistic title="通过/警告/失败" value={`${item.passed_probes}/${item.warning_probes}/${item.failed_probes}`} /></Card>
          <Card size="small"><Statistic title="P95 延迟" value={ms(item.latency_ms.p95)} /></Card>
          <Card size="small"><Statistic title="P95 TTFT" value={ms(item.ttft_ms.p95)} /></Card>
          <Card size="small"><Statistic title="平均 TPOT" value={ms(item.tpot_ms.avg)} /></Card>
          <Card size="small"><Statistic title="平均吞吐" value={num(item.tokens_per_second.avg, ' tok/s')} /></Card>
        </div>
        <div className="full-model-inspector">
          <aside>
            <Typography.Text strong>查看单条探针关键详情</Typography.Text>
            <ProbeList probes={item.probes} selectedKey={selected?.key} onSelect={setSelectedKey} />
          </aside>
          <main>{selected ? <ProbeDetail channel={item} probe={selected} /> : <Alert type="info" showIcon message="暂无探针结果" />}</main>
        </div>
      </Space>
    </Card>
  );
}

export default function FullModelCheck() {
  const [form] = Form.useForm<FormValues>();
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const [result, setResult] = useState<FullModelCheckResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const availableChannels = useMemo(() => (channels.data ?? []).filter((channel) => channel.enabled && channel.base_url), [channels.data]);
  const channelOptions = availableChannels.map((channel) => ({ value: channel.id, label: protocolLabel(channel) }));

  const runCheck = useMutation({
    mutationFn: (values: FormValues) => {
      const payload: FullModelCheckRequest = {
        channel_ids: values.channel_ids,
        repeat_count: values.repeat_count ?? 1,
        include_stream: values.include_stream,
        include_tools: values.include_tools,
        include_params: values.include_params,
        include_error_probe: values.include_error_probe,
        include_thinking: values.include_thinking,
        include_vision: values.include_vision,
        timeout_seconds: values.timeout_seconds ?? 120,
      };
      return api.fullModelCheck(payload);
    },
    onSuccess: (payload) => {
      setResult(payload);
      setRequestError(null);
      message.success('完整模型检测完成');
    },
    onError: (error) => {
      const detail = getErrorMessage(error);
      setRequestError(detail);
      message.error(detail);
    },
  });

  return (
    <Space direction="vertical" size={18} className="full-width">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>完整模型检测</Typography.Title>
          <Typography.Paragraph type="secondary">
            面向 Claude / OpenAI-compatible / Gemini-compatible 三类资源做细粒度模型探针：协议形态、流式 TTFT、Usage、参数兼容、工具、Thinking、错误包裹与吞吐指标都会拆开展示。
          </Typography.Paragraph>
        </div>
      </div>

      <Alert showIcon type="info" message="运行说明" description="本检测只使用渠道管理里已配置的运行时凭据，不在结果里输出 API Key/Authorization。检测完成后可在每个探针详情里看到关键结论、原因、命中证据、Usage、响应 ID、Hash 和每次运行详情。" />

      <Card title={<span className="card-title-with-icon"><ShieldCheck size={18} />检测配置</span>} bordered={false}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ repeat_count: 1, include_stream: true, include_tools: true, include_params: true, include_error_probe: true, include_thinking: true, include_vision: false, timeout_seconds: 120 }}
          onFinish={(values) => runCheck.mutate(values)}
        >
          <Form.Item name="channel_ids" label="待测渠道 / 模型" rules={[{ required: true, message: '请选择至少一个渠道' }]}> 
            <Select mode="multiple" options={channelOptions} loading={channels.isLoading} placeholder="选择一个或多个渠道" maxTagCount="responsive" />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item name="repeat_count" label="重复次数">
              <InputNumber min={1} max={5} />
            </Form.Item>
            <Form.Item name="timeout_seconds" label="单探针超时秒数">
              <InputNumber min={30} max={240} />
            </Form.Item>
          </Space>
          <Space size={18} wrap>
            <Form.Item name="include_stream" valuePropName="checked"><Checkbox>流式 / TTFT</Checkbox></Form.Item>
            <Form.Item name="include_params" valuePropName="checked"><Checkbox>参数兼容</Checkbox></Form.Item>
            <Form.Item name="include_tools" valuePropName="checked"><Checkbox>工具调用</Checkbox></Form.Item>
            <Form.Item name="include_thinking" valuePropName="checked"><Checkbox>Claude Thinking</Checkbox></Form.Item>
            <Form.Item name="include_error_probe" valuePropName="checked"><Checkbox>错误包裹</Checkbox></Form.Item>
            <Form.Item name="include_vision" valuePropName="checked"><Checkbox>图片输入烟测</Checkbox></Form.Item>
          </Space>
          <Button type="primary" htmlType="submit" loading={runCheck.isPending} icon={<Play size={16} />} disabled={!availableChannels.length}>开始完整检测</Button>
        </Form>
      </Card>

      {requestError ? <Alert type="error" showIcon message="检测失败" description={requestError} /> : null}

      {result ? (
        <Space direction="vertical" size={16} className="full-width">
          <Card bordered={false} title={<span className="card-title-with-icon"><Gauge size={18} />总览</span>}>
            <Descriptions size="small" bordered column={3}>
              <Descriptions.Item label="检测 ID">{result.id}</Descriptions.Item>
              <Descriptions.Item label="耗时">{ms(result.duration_ms)}</Descriptions.Item>
              <Descriptions.Item label="重复次数">{result.repeat_count}</Descriptions.Item>
              <Descriptions.Item label="渠道数">{result.channels.length}</Descriptions.Item>
              <Descriptions.Item label="覆盖分类" span={2}>{result.categories.map((item) => <Tag key={item}>{item}</Tag>)}</Descriptions.Item>
            </Descriptions>
          </Card>

          <Tabs
            items={result.channels.map((item) => ({
              key: item.channel.id,
              label: <span>{formatChannelDisplayName(item.channel)} {statusTag(item.status)}</span>,
              children: <ChannelResultPanel item={item} />,
            }))}
          />
        </Space>
      ) : null}
    </Space>
  );
}
