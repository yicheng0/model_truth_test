import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, AutoComplete, Button, Card, Col, Descriptions, Form, Input, Progress, Radio, Row, Select, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ShieldCheck } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import type { OpenAIResourceCheckRequest, OpenAIResourceCheckResult, OpenAIResourceEvidenceItem } from '../types';
import { capabilityState, OPENAI_COMMON_MODEL_OPTIONS, openAIResourcePayload, resourceFamilyMeta, type OpenAIResourceFormValues } from '../openAIResourceCheckUtils';

type FormValues = OpenAIResourceFormValues;

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? null, null, 2);
}

function classificationTag(classification: string) {
  const map: Record<string, { color: string; text: string }> = {
    official_openai_direct_likely: { color: 'green', text: '官方直连高一致' },
    openai_compatible_proxy: { color: 'orange', text: 'OpenAI-compatible 中转' },
    codex_compatible_relay_likely: { color: 'purple', text: '疑似 Codex-compatible 中转' },
    hybrid_or_translated_gateway: { color: 'geekblue', text: '混合 / 协议转换网关' },
    suspicious_proxy_or_rewrite: { color: 'red', text: '疑似代理改写' },
    invalid_or_unverified: { color: 'default', text: '未验证' },
  };
  const item = map[classification] ?? { color: 'default', text: classification };
  return <Tag color={item.color}>{item.text}</Tag>;
}

function directnessTag(value?: string | null) {
  if (value === 'official_direct' || value === 'official_openai_host') return <Tag color="green">官方 OpenAI host</Tag>;
  if (value === 'relay_or_proxy') return <Tag color="blue">中转 / 代理</Tag>;
  return <Tag>{value || '-'}</Tag>;
}

function upstreamTag(value?: string | null) {
  const map: Record<string, { color: string; text: string }> = {
    official_upstream_likely: { color: 'green', text: '疑似官方 OpenAI 上游' },
    openai_compatible_unverified: { color: 'orange', text: '仅兼容协议，待确认' },
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

const evidenceColumns: ColumnsType<OpenAIResourceEvidenceItem> = [
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

const capabilityLabels: Record<string, string> = {
  models: 'Models',
  chat_completions: 'Chat Completions',
  responses: 'Responses',
  responses_stream: 'Responses SSE',
  codex_metadata: 'Codex 元数据',
  tools: '工具调用',
  reasoning_controls: 'Reasoning 参数',
  multi_turn: '连续会话',
  codex_client_payload: 'Codex Agent 请求',
  compact: 'Responses Compact',
};

export default function OpenAIResourceCheck() {
  const [form] = Form.useForm<FormValues>();
  const [result, setResult] = useState<OpenAIResourceCheckResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const groupedEvidence = useMemo(() => result?.evidence ?? [], [result]);

  const runCheck = useMutation({
    mutationFn: (values: FormValues) => {
      const payload: OpenAIResourceCheckRequest = openAIResourcePayload(values);
      return api.openAIResourceCheck(payload);
    },
    onSuccess: (payload) => {
      setResult(payload);
      setRequestError(null);
      form.setFieldValue('api_key', '');
      message.success('资源检测完成，API Key 输入框已清空');
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
          <Typography.Title level={2}>OpenAI API / Codex 资源检测</Typography.Title>
          <Typography.Paragraph type="secondary">
            从连接形态、OpenAI API 一致性和 Codex 客户端兼容性三个维度进行黑盒检测。结果是特征推断，不代表确认某个 OAuth 账户或官方订阅来源。
          </Typography.Paragraph>
        </div>
      </div>

      <Alert
        showIcon
        type="warning"
        message="截图安全提醒"
        description="只填写目标网关提供的 API Key。不要提交 ChatGPT OAuth token、refresh token 或 auth.json，也不要截图传播密钥；检测结束后输入框会自动清空。"
      />

      <Card title={<span className="card-title-with-icon"><ShieldCheck size={18} />联网验证</span>} bordered={false}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ base_url: 'https://api.openai.com/v1', detection_mode: 'auto', probe_depth: 'quick' }}
          onFinish={(values) => runCheck.mutate(values)}
        >
          <Form.Item name="base_url" label="Base URL">
            <Input placeholder="https://api.openai.com/v1 或中转 https://example.com/v1" />
          </Form.Item>
          <Form.Item name="api_key" label="OpenAI / 中转 API Key（运行时，不保存）" rules={[{ required: true, message: '请输入 API Key' }]}>
            <Input.Password autoComplete="off" placeholder="sk-..." visibilityToggle />
          </Form.Item>
          <Space size={16} wrap className="full-width">
            <Form.Item name="organization" label="Organization（可选）">
              <Input placeholder="org_..." />
            </Form.Item>
            <Form.Item name="project" label="Project（可选）">
              <Input placeholder="proj_..." />
            </Form.Item>
            <Form.Item name="model" label="探针模型（可选）">
              <AutoComplete
                allowClear
                options={OPENAI_COMMON_MODEL_OPTIONS}
                placeholder="留空自动选择，或选择/输入模型"
                style={{ minWidth: 280 }}
              />
            </Form.Item>
          </Space>
          <Space size={24} wrap align="start">
            <Form.Item name="detection_mode" label="检测模式">
              <Select style={{ width: 220 }} options={[
                { value: 'auto', label: '自动识别' },
                { value: 'openai_api', label: 'OpenAI API' },
                { value: 'codex_relay', label: 'Codex 逆向 / 中转' },
              ]} />
            </Form.Item>
            <Form.Item name="probe_depth" label="检测深度">
              <Radio.Group optionType="button" buttonStyle="solid" options={[
                { value: 'quick', label: '快速检测' },
                { value: 'deep', label: '深度检测' },
              ]} />
            </Form.Item>
          </Space>
          <Alert type="info" showIcon message="快速检测通常 30–60 秒；深度检测增加工具调用、Reasoning、连续会话和 Compact 探针，可能消耗更多 token。" className="form-inline-alert" />
          <Button type="primary" htmlType="submit" loading={runCheck.isPending}>
            开始检测
          </Button>
        </Form>
      </Card>

      {requestError ? <Alert type="error" showIcon message="请求失败" description={requestError} /> : null}

      {result ? (
        <Card title="检测结果" bordered={false}>
          <Space direction="vertical" size={16} className="full-width">
            <Row gutter={[12, 12]}>
              <Col xs={24} md={8}><Card size="small"><Statistic title="连接形态" valueRender={() => directnessTag(result.connection_type || result.directness)} /></Card></Col>
              <Col xs={24} md={8}><Card size="small"><Statistic title="资源类型" valueRender={() => { const meta = resourceFamilyMeta(result.resource_family); return <Tag color={meta.color}>{meta.text}</Tag>; }} /></Card></Col>
              <Col xs={24} md={8}><Card size="small"><Statistic title="来源置信度" value={result.source_confidence ?? result.confidence_score} suffix="/ 100" /></Card></Col>
            </Row>
            <Row gutter={[12, 12]}>
              <Col xs={24} md={12}><Card size="small" title="OpenAI API 一致分"><Progress percent={Math.round(result.openai_api_score ?? result.upstream_score ?? 0)} /></Card></Col>
              <Col xs={24} md={12}><Card size="small" title="Codex 兼容分"><Progress percent={Math.round(result.codex_compatibility_score ?? 0)} strokeColor="#722ed1" /></Card></Col>
            </Row>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="综合分类">{classificationTag(result.classification)}</Descriptions.Item>
              <Descriptions.Item label="综合置信分">{result.confidence_score}</Descriptions.Item>
              <Descriptions.Item label="检测深度">{result.probe_depth === 'deep' ? '深度检测' : '快速检测'}</Descriptions.Item>
              <Descriptions.Item label="连接形态">{directnessTag(result.directness)}</Descriptions.Item>
              <Descriptions.Item label="上游一致性">{upstreamTag(result.upstream_assessment)}</Descriptions.Item>
              <Descriptions.Item label="上游分">{result.upstream_score ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="Request ID">{result.request_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="Host">{result.host || '-'}</Descriptions.Item>
              <Descriptions.Item label="选用模型">{result.selected_model || '-'}</Descriptions.Item>
              <Descriptions.Item label="Base URL">{result.normalized_base_url}</Descriptions.Item>
              <Descriptions.Item label="延迟">{result.latency_ms == null ? '-' : `${result.latency_ms} ms`}</Descriptions.Item>
              <Descriptions.Item label="Models Endpoint" span={2}>{result.models_endpoint}</Descriptions.Item>
              <Descriptions.Item label="Chat Endpoint" span={2}>{result.chat_endpoint || '-'}</Descriptions.Item>
              <Descriptions.Item label="Responses Endpoint" span={2}>{result.response_endpoint || '-'}</Descriptions.Item>
            </Descriptions>
            <Card size="small" title="能力矩阵">
              <Space wrap size={[8, 8]}>
                {Object.entries(result.capabilities ?? {}).map(([key, value]) => {
                  const state = capabilityState(value);
                  return <Tag key={key} color={state.color}>{capabilityLabels[key] || key}: {state.text}</Tag>;
                })}
              </Space>
            </Card>
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
