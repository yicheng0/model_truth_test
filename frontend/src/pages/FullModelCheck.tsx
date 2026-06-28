import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Collapse, Descriptions, Form, InputNumber, Select, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Activity, Gauge, Play, ShieldCheck } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { formatChannelDisplayName } from '../channelCredentials';
import type { Channel, FullModelCheckRequest, FullModelCheckResult, FullModelProbeResult } from '../types';

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

function num(value?: number | null, suffix = '') {
  return value == null ? '-' : `${Number(value).toFixed(2)}${suffix}`;
}

function statusTag(status: string) {
  const color = status === 'pass' ? 'green' : status === 'warning' ? 'orange' : status === 'degraded' ? 'orange' : status === 'fail' || status === 'failed' ? 'red' : 'blue';
  return <Tag color={color}>{status}</Tag>;
}

function protocolLabel(channel: Channel) {
  const protocol = String(channel.auth_config?.request_protocol || channel.provider_type || 'auto');
  return `${formatChannelDisplayName(channel)} · ${channel.model_name || '未配置模型'} · ${protocol}`;
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? null, null, 2);
}

const probeColumns: ColumnsType<FullModelProbeResult> = [
  { title: '探针', dataIndex: 'title', width: 190, fixed: 'left' },
  { title: '分类', dataIndex: 'category', width: 105, render: (v: string) => <Tag>{v}</Tag> },
  { title: '状态', dataIndex: 'status', width: 95, render: statusTag },
  { title: '分数', dataIndex: 'score', width: 80 },
  { title: 'HTTP', dataIndex: 'http_status', width: 80, render: (v: number | null) => v ?? '-' },
  { title: 'TTFT', dataIndex: 'ttft_ms', width: 100, render: ms },
  { title: '总延迟', dataIndex: 'latency_ms', width: 110, render: ms },
  { title: 'TPOT', dataIndex: 'tpot_ms', width: 100, render: ms },
  { title: '吞吐', dataIndex: 'tokens_per_second', width: 110, render: (v: number | null) => num(v, ' tok/s') },
  { title: '输入/输出', width: 110, render: (_, row) => `${row.input_tokens ?? '-'} / ${row.output_tokens ?? '-'}` },
  { title: 'Req ID', dataIndex: 'request_id', width: 150, render: (v: string | null) => v ? <Typography.Text copyable ellipsis={{ tooltip: v }}>{v}</Typography.Text> : '-' },
  { title: 'Msg ID', dataIndex: 'message_id', width: 150, render: (v: string | null) => v ? <Typography.Text copyable ellipsis={{ tooltip: v }}>{v}</Typography.Text> : '-' },
  { title: '事件', width: 170, render: (_, row) => row.stream_events?.length ? <Typography.Text ellipsis={{ tooltip: row.stream_events.join(', ') }}>{row.stream_events.join(', ')}</Typography.Text> : '-' },
  { title: '标签/错误', width: 260, render: (_, row) => (
    <Space direction="vertical" size={2}>
      <Space wrap size={4}>{row.labels.map((label) => <Tag key={label} color="orange">{label}</Tag>)}</Space>
      {row.error_excerpt ? <Typography.Text type="danger" ellipsis={{ tooltip: row.error_excerpt }}>{row.error_excerpt}</Typography.Text> : null}
    </Space>
  ) },
  { title: '摘要', dataIndex: 'excerpt', width: 260, render: (v: string | null) => v ? <Typography.Text ellipsis={{ tooltip: v }}>{v}</Typography.Text> : '-' },
];

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

      <Alert showIcon type="info" message="运行说明" description="本检测只使用渠道管理里已配置的运行时凭据，不在结果里输出 API Key/Authorization。流式 TTFT 依赖上游真实流式响应；若中转把流式转成非流式，会被标记为协议/事件异常。" />

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

          {result.channels.map((item) => (
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
                <Descriptions size="small" bordered column={4}>
                  <Descriptions.Item label="Latency avg/p50/p95">{ms(item.latency_ms.avg)} / {ms(item.latency_ms.p50)} / {ms(item.latency_ms.p95)}</Descriptions.Item>
                  <Descriptions.Item label="TTFT avg/p50/p95">{ms(item.ttft_ms.avg)} / {ms(item.ttft_ms.p50)} / {ms(item.ttft_ms.p95)}</Descriptions.Item>
                  <Descriptions.Item label="TPOT avg/p95">{ms(item.tpot_ms.avg)} / {ms(item.tpot_ms.p95)}</Descriptions.Item>
                  <Descriptions.Item label="Token 输入/输出">{item.total_input_tokens} / {item.total_output_tokens}</Descriptions.Item>
                </Descriptions>
                <Table
                  size="small"
                  rowKey="key"
                  columns={probeColumns}
                  dataSource={item.probes}
                  scroll={{ x: 1900 }}
                  pagination={false}
                  expandable={{
                    expandedRowRender: (row) => (
                      <Space direction="vertical" className="full-width">
                        <Typography.Text type="secondary">Endpoint：{row.endpoint || '-'}</Typography.Text>
                        <pre className="json-block">{prettyJson(row.raw_evidence)}</pre>
                      </Space>
                    ),
                  }}
                />
                <Collapse
                  ghost
                  items={[
                    {
                      key: 'raw',
                      label: '按分类查看探针',
                      children: ['protocol', 'stream', 'parameters', 'tools', 'thinking', 'vision', 'error'].map((category) => {
                        const rows = item.probes.filter((probe) => probe.category === category);
                        if (!rows.length) return null;
                        return <Card key={category} size="small" title={`${category}（${rows.length}）`}><Table size="small" rowKey="key" pagination={false} dataSource={rows} columns={probeColumns.slice(0, 10)} /></Card>;
                      }),
                    },
                  ]}
                />
              </Space>
            </Card>
          ))}
        </Space>
      ) : null}
    </Space>
  );
}
