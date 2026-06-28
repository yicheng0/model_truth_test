import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Descriptions, Form, Input, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ShieldCheck } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import type { GeminiResourceCheckRequest, GeminiResourceCheckResult, GeminiResourceEvidenceItem } from '../types';

type FormValues = {
  base_url?: string;
  api_key: string;
  model?: string;
  include_stream_probe?: boolean;
  include_embedding_probe?: boolean;
};

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? null, null, 2);
}

function classificationTag(classification: string) {
  const map: Record<string, { color: string; text: string }> = {
    official_gemini_direct_likely: { color: 'green', text: '官方直连高一致' },
    gemini_compatible_proxy: { color: 'orange', text: 'Gemini-compatible 中转' },
    suspicious_proxy_or_rewrite: { color: 'red', text: '疑似代理改写' },
    invalid_or_unverified: { color: 'default', text: '未验证' },
  };
  const item = map[classification] ?? { color: 'default', text: classification };
  return <Tag color={item.color}>{item.text}</Tag>;
}

function directnessTag(value?: string | null) {
  if (value === 'official_google_direct') return <Tag color="green">Google 官方直连</Tag>;
  if (value === 'relay_or_proxy') return <Tag color="blue">中转 / 代理</Tag>;
  return <Tag>{value || '-'}</Tag>;
}

function upstreamTag(value?: string | null) {
  const map: Record<string, { color: string; text: string }> = {
    official_upstream_likely: { color: 'green', text: '疑似官方 Gemini 上游' },
    gemini_compatible_unverified: { color: 'orange', text: '仅兼容协议，待确认' },
    suspicious_rewrite: { color: 'red', text: '可疑改写' },
    invalid_or_unverified: { color: 'default', text: '未验证' },
  };
  const item = value ? map[value] : undefined;
  return <Tag color={item?.color ?? 'default'}>{item?.text ?? value ?? '-'}</Tag>;
}

function evidenceStatusTag(status: string) {
  const color = status === 'ok' ? 'green' : status === 'warning' ? 'orange' : status === 'fail' ? 'red' : 'blue';
  return <Tag color={color}>{status}</Tag>;
}

const evidenceColumns: ColumnsType<GeminiResourceEvidenceItem> = [
  { title: '分组', dataIndex: 'group', width: 150, render: (value: string | null) => value || '-' },
  { title: '证据项', dataIndex: 'key', width: 190 },
  { title: '状态', dataIndex: 'status', width: 110, render: (value: string) => evidenceStatusTag(value) },
  { title: '说明', dataIndex: 'detail' },
  {
    title: '值',
    dataIndex: 'value',
    width: 300,
    render: (value: unknown) => (
      <Typography.Text copyable={typeof value === 'string' && value ? { text: value } : false} ellipsis={{ tooltip: typeof value === 'string' ? value : prettyJson(value) }}>
        {value == null ? '-' : typeof value === 'string' ? value : prettyJson(value)}
      </Typography.Text>
    ),
  },
];

export default function GeminiResourceCheck() {
  const [form] = Form.useForm<FormValues>();
  const [result, setResult] = useState<GeminiResourceCheckResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const groupedEvidence = useMemo(() => result?.evidence ?? [], [result]);

  const runCheck = useMutation({
    mutationFn: (values: FormValues) => {
      const payload: GeminiResourceCheckRequest = {
        base_url: values.base_url?.trim() || 'https://generativelanguage.googleapis.com/v1beta',
        api_key: values.api_key.trim(),
        model: values.model?.trim() || null,
        include_stream_probe: Boolean(values.include_stream_probe),
        include_embedding_probe: Boolean(values.include_embedding_probe),
      };
      return api.geminiResourceCheck(payload);
    },
    onSuccess: (payload) => {
      setResult(payload);
      setRequestError(null);
      form.setFieldValue('api_key', '');
      message.success('Gemini 资源检测完成，API Key 输入框已清空');
    },
    onError: (error) => {
      const detail = getErrorMessage(error);
      setRequestError(detail);
      form.setFieldValue('api_key', '');
      message.error(detail);
    },
  });

  return (
    <Space direction="vertical" size={18} className="full-width">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Gemini 官转/中转检测</Typography.Title>
          <Typography.Paragraph type="secondary">
            区分连接形态和上游一致性：非官方 host 会被标记为中转/代理，但会继续通过 Models、GenerateContent、流式/Embedding 与校验错误探针判断是否高度像官方 Gemini 上游。
          </Typography.Paragraph>
        </div>
      </div>

      <Alert
        showIcon
        type="warning"
        message="截图安全提醒"
        description="不要截图或传播 API Key；如果密钥已经出现在截图、聊天或日志中，请立即在对应平台撤销并轮换。检测完成或失败后本页面会自动清空 API Key 输入框。"
      />

      <Card title={<span className="card-title-with-icon"><ShieldCheck size={18} />联网验证</span>} bordered={false}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ base_url: 'https://generativelanguage.googleapis.com/v1beta', include_stream_probe: true, include_embedding_probe: true, model: 'gemini-2.0-flash' }}
          onFinish={(values) => runCheck.mutate(values)}
        >
          <Form.Item name="base_url" label="Base URL">
            <Input placeholder="https://generativelanguage.googleapis.com/v1beta 或中转 https://example.com/v1beta" />
          </Form.Item>
          <Form.Item name="api_key" label="Gemini / 中转 API Key（运行时，不保存）" rules={[{ required: true, message: '请输入 API Key' }]}>
            <Input.Password autoComplete="off" placeholder="AIza..." visibilityToggle />
          </Form.Item>
          <Space size={16} wrap className="full-width">
            <Form.Item name="model" label="探针模型（可选）">
              <Input placeholder="优先用填写模型；否则从 /models 自动选择" />
            </Form.Item>
          </Space>
          <Form.Item name="include_stream_probe" valuePropName="checked">
            <Checkbox>执行 streamGenerateContent 流式形态探针</Checkbox>
          </Form.Item>
          <Form.Item name="include_embedding_probe" valuePropName="checked">
            <Checkbox>执行 embedContent 向量响应探针</Checkbox>
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={runCheck.isPending}>
            开始检测
          </Button>
        </Form>
      </Card>

      {requestError ? <Alert type="error" showIcon message="请求失败" description={requestError} /> : null}

      {result ? (
        <Card title="检测结果" bordered={false}>
          <Space direction="vertical" size={16} className="full-width">
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="综合分类">{classificationTag(result.classification)}</Descriptions.Item>
              <Descriptions.Item label="综合置信分">{result.confidence_score}</Descriptions.Item>
              <Descriptions.Item label="连接形态">{directnessTag(result.directness)}</Descriptions.Item>
              <Descriptions.Item label="上游一致性">{upstreamTag(result.upstream_assessment)}</Descriptions.Item>
              <Descriptions.Item label="上游分">{result.upstream_score ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="Request ID">{result.request_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="Host">{result.host || '-'}</Descriptions.Item>
              <Descriptions.Item label="选用生成模型">{result.selected_model || '-'}</Descriptions.Item>
              <Descriptions.Item label="选用 Embedding 模型">{result.selected_embedding_model || '-'}</Descriptions.Item>
              <Descriptions.Item label="Base URL">{result.normalized_base_url}</Descriptions.Item>
              <Descriptions.Item label="延迟">{result.latency_ms == null ? '-' : `${result.latency_ms} ms`}</Descriptions.Item>
              <Descriptions.Item label="Models Endpoint" span={2}>{result.models_endpoint}</Descriptions.Item>
              <Descriptions.Item label="Generate Endpoint" span={2}>{result.generate_endpoint || '-'}</Descriptions.Item>
              <Descriptions.Item label="Stream Endpoint" span={2}>{result.stream_endpoint || '-'}</Descriptions.Item>
              <Descriptions.Item label="Embedding Endpoint" span={2}>{result.embedding_endpoint || '-'}</Descriptions.Item>
            </Descriptions>
            <Alert type={result.upstream_assessment === 'official_upstream_likely' ? 'success' : 'warning'} showIcon message={result.summary} />
            <Space wrap>
              {(result.labels.length ? result.labels : ['no_blocking_labels']).map((label) => (
                <Tag key={label} color={label === 'no_blocking_labels' ? 'green' : label === 'middleware_wrapper_trace' ? 'blue' : 'orange'}>{label}</Tag>
              ))}
            </Space>
            <Table size="small" rowKey={(row) => `${row.group || 'group'}:${row.key}`} pagination={false} dataSource={groupedEvidence} columns={evidenceColumns} />
            <Typography.Title level={4}>脱敏原始证据</Typography.Title>
            <pre className="json-block">{prettyJson(result.raw_evidence)}</pre>
          </Space>
        </Card>
      ) : null}
    </Space>
  );
}
