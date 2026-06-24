import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Descriptions, Form, Input, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ShieldCheck } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import type { OpenAIResourceCheckRequest, OpenAIResourceCheckResult, OpenAIResourceEvidenceItem } from '../types';

type FormValues = {
  base_url?: string;
  api_key: string;
  organization?: string;
  project?: string;
  model?: string;
  include_response_probe?: boolean;
};

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? null, null, 2);
}

function classificationTag(classification: string) {
  const map: Record<string, { color: string; text: string }> = {
    official_openai_direct_likely: { color: 'green', text: '高度一致·官方直连' },
    openai_compatible_proxy: { color: 'orange', text: 'OpenAI-compatible 代理' },
    suspicious_proxy_or_rewrite: { color: 'red', text: '疑似代理改写' },
    invalid_or_unverified: { color: 'default', text: '未验证' },
  };
  const item = map[classification] ?? { color: 'default', text: classification };
  return <Tag color={item.color}>{item.text}</Tag>;
}

function evidenceStatusTag(status: string) {
  const color = status === 'ok' ? 'green' : status === 'warning' ? 'orange' : status === 'fail' ? 'red' : 'blue';
  return <Tag color={color}>{status}</Tag>;
}

const evidenceColumns: ColumnsType<OpenAIResourceEvidenceItem> = [
  { title: '证据项', dataIndex: 'key', width: 190 },
  { title: '状态', dataIndex: 'status', width: 110, render: (value: string) => evidenceStatusTag(value) },
  { title: '说明', dataIndex: 'detail' },
  {
    title: '值',
    dataIndex: 'value',
    width: 260,
    render: (value: unknown) => (
      <Typography.Text copyable={typeof value === 'string' && value ? { text: value } : false} ellipsis={{ tooltip: typeof value === 'string' ? value : prettyJson(value) }}>
        {value == null ? '-' : typeof value === 'string' ? value : prettyJson(value)}
      </Typography.Text>
    ),
  },
];

export default function OpenAIResourceCheck() {
  const [form] = Form.useForm<FormValues>();
  const [result, setResult] = useState<OpenAIResourceCheckResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const runCheck = useMutation({
    mutationFn: (values: FormValues) => {
      const payload: OpenAIResourceCheckRequest = {
        base_url: values.base_url?.trim() || 'https://api.openai.com/v1',
        api_key: values.api_key.trim(),
        organization: values.organization?.trim() || null,
        project: values.project?.trim() || null,
        model: values.model?.trim() || null,
        include_response_probe: Boolean(values.include_response_probe),
      };
      return api.openAIResourceCheck(payload);
    },
    onSuccess: (payload) => {
      setResult(payload);
      setRequestError(null);
      message.success('OpenAI 资源检测完成');
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
          <Typography.Title level={2}>OpenAI 官方直连资源检测</Typography.Title>
          <Typography.Paragraph type="secondary">
            通过官方 endpoint、模型列表 shape、request id 响应头和可选 Responses API 探针，判断资源是否高度符合 OpenAI 官方 API 直连特征。
          </Typography.Paragraph>
        </div>
      </div>

      <Alert
        showIcon
        type="info"
        message="检测结论是证据化风险评级，不是 100% 真伪断言。API Key 仅用于本次请求，不会落库或展示。"
      />

      <Card title={<span className="card-title-with-icon"><ShieldCheck size={18} />联网验证</span>} bordered={false}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ base_url: 'https://api.openai.com/v1', include_response_probe: false, model: 'gpt-4.1-mini' }}
          onFinish={(values) => runCheck.mutate(values)}
        >
          <Form.Item name="base_url" label="Base URL">
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item name="api_key" label="OpenAI API Key（运行时，不保存）" rules={[{ required: true, message: '请输入 API Key' }]}>
            <Input.Password autoComplete="off" placeholder="sk-..." />
          </Form.Item>
          <Space size={16} wrap className="full-width">
            <Form.Item name="organization" label="Organization（可选）">
              <Input placeholder="org_..." />
            </Form.Item>
            <Form.Item name="project" label="Project（可选）">
              <Input placeholder="proj_..." />
            </Form.Item>
            <Form.Item name="model" label="Responses 探针模型">
              <Input placeholder="gpt-4.1-mini" />
            </Form.Item>
          </Space>
          <Form.Item name="include_response_probe" valuePropName="checked">
            <Checkbox>额外执行低成本 POST /responses 探针</Checkbox>
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
              <Descriptions.Item label="分类">{classificationTag(result.classification)}</Descriptions.Item>
              <Descriptions.Item label="置信分">{result.confidence_score}</Descriptions.Item>
              <Descriptions.Item label="Host">{result.host || '-'}</Descriptions.Item>
              <Descriptions.Item label="Request ID">{result.request_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="Base URL">{result.normalized_base_url}</Descriptions.Item>
              <Descriptions.Item label="延迟">{result.latency_ms == null ? '-' : `${result.latency_ms} ms`}</Descriptions.Item>
              <Descriptions.Item label="Models Endpoint" span={2}>{result.models_endpoint}</Descriptions.Item>
              <Descriptions.Item label="Responses Endpoint" span={2}>{result.response_endpoint || '-'}</Descriptions.Item>
            </Descriptions>
            <Alert type={result.classification === 'official_openai_direct_likely' ? 'success' : 'warning'} showIcon message={result.summary} />
            <Space wrap>
              {(result.labels.length ? result.labels : ['no_blocking_labels']).map((label) => (
                <Tag key={label} color={label === 'no_blocking_labels' ? 'green' : 'orange'}>{label}</Tag>
              ))}
            </Space>
            <Table size="small" rowKey={(row) => row.key} pagination={false} dataSource={result.evidence} columns={evidenceColumns} />
            <Typography.Title level={4}>脱敏原始证据</Typography.Title>
            <pre className="json-block">{prettyJson(result.raw_evidence)}</pre>
          </Space>
        </Card>
      ) : null}
    </Space>
  );
}
