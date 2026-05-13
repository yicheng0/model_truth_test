import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Form, Input, InputNumber, Select, Space, Tag, Typography, message } from 'antd';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import { api } from '../api';
import type { Channel, ModelRequestTestResult } from '../types';

type ModelRequestForm = {
  channel_id: string;
  prompt: string;
  system_prompt?: string;
  max_tokens?: number;
  temperature?: number;
  extra_params?: string;
};

const AWS_THINKING_PROBE_PROMPT = '请用一句话回答：这是 thinking temperature 纯度探针。';
const AWS_THINKING_PROBE_EXTRA_PARAMS = {
  thinking: { type: 'enabled', budget_tokens: 1024 },
  reasoning_effort: 'medium',
  expected_error_contains: 'temperature may only be set to 1 when thinking is enabled',
  expected_error_any: ['temperature', 'thinking'],
  expected_error_variant_any: ['temperature', 'thinking'],
};

function channelApiKey(channel: Channel) {
  const value = channel.auth_config?.api_key;
  return typeof value === 'string' ? value : '';
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? null, null, 2);
}

function normalizedValue(result: ModelRequestTestResult | null, key: string) {
  const normalized = result?.result.normalized_response;
  return normalized && typeof normalized === 'object' ? normalized[key] : undefined;
}

function rawResponseHasThinkingSignature(result: ModelRequestTestResult | null) {
  const content = result?.result.raw_response?.content;
  return Array.isArray(content) && content.some((block) => block && typeof block === 'object' && block.type === 'thinking' && block.signature);
}

function parseExtraParams(value?: string) {
  if (!value?.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Extra params 必须是 JSON object');
  }
  return parsed as Record<string, unknown>;
}

export default function ModelRequestTest() {
  const [form] = Form.useForm<ModelRequestForm>();
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const [result, setResult] = useState<ModelRequestTestResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const availableChannels = useMemo(
    () => (channels.data ?? []).filter((channel) => channel.enabled && channel.base_url && channelApiKey(channel)),
    [channels.data],
  );

  const channelOptions = availableChannels.map((channel) => ({
    value: channel.id,
    label: `${channel.name} · ${channel.model_name || '未配置模型'}`,
  }));

  useEffect(() => {
    if (!availableChannels.length || form.getFieldValue('channel_id')) return;
    form.setFieldsValue({ channel_id: availableChannels[0].id });
  }, [availableChannels, form]);

  const requestModel = useMutation({
    mutationFn: (values: ModelRequestForm) => {
      const extraParams = parseExtraParams(values.extra_params);
      return api.modelRequestTest(values.channel_id, {
        prompt: values.prompt,
        system_prompt: values.system_prompt?.trim() || null,
        request_params: {
          max_tokens: values.max_tokens ?? 256,
          temperature: values.temperature ?? 0,
          ...extraParams,
        },
      });
    },
    onSuccess: (payload) => {
      setRequestError(null);
      setResult(payload);
      const labels = payload.result.labels ?? [];
      const isProbeFailure = labels.includes('thinking_temperature_not_rejected');
      if (isProbeFailure) {
        message.warning('探针失败：渠道应报错但返回了正常内容');
      } else if (payload.result.normalized_response?.error) {
        message.warning('真实请求已保存，但渠道返回失败');
      } else {
        message.success('真实请求已完成并保存');
      }
    },
    onError: (error) => {
      const detail = error instanceof Error ? error.message : '真实请求失败';
      setRequestError(detail);
      message.error(detail);
    },
  });

  function submit(values: ModelRequestForm) {
    setResult(null);
    setRequestError(null);
    requestModel.mutate(values);
  }

  function applyAwsThinkingProbe() {
    form.setFieldsValue({
      prompt: AWS_THINKING_PROBE_PROMPT,
      max_tokens: 2048,
      temperature: 0.2,
      extra_params: JSON.stringify(AWS_THINKING_PROBE_EXTRA_PARAMS, null, 2),
    });
    setResult(null);
    setRequestError(null);
  }

  const resultLabels = result?.result.labels ?? [];
  const isExpectedErrorProbe = Boolean(result?.result.raw_request?.params?.expected_error_contains);
  const expectedErrorPassed = isExpectedErrorProbe && result ? result.result.score === 100 && Boolean(normalizedValue(result, 'error')) : false;
  const expectedErrorFailed = isExpectedErrorProbe && !expectedErrorPassed;
  const outputText = String(normalizedValue(result, 'content_text') ?? '');
  const errorText = String(normalizedValue(result, 'error') ?? '');
  const evidenceText = expectedErrorPassed ? errorText : outputText || errorText || '无文本输出，请查看原始响应。';
  const hasBedrockSourceFeatures = result?.message_id?.startsWith('msg_bdrk_') || rawResponseHasThinkingSignature(result);

  return (
    <Space direction="vertical" size={24} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">MODEL REQUEST</Typography.Text>
          <Typography.Title level={2}>真实模型请求</Typography.Title>
          <Typography.Paragraph>
            单独向某个渠道发送真实请求，查看渠道返回的 message id、协议、endpoint 和原始响应。
          </Typography.Paragraph>
        </div>
        <Tag color="blue">可请求渠道 {availableChannels.length}</Tag>
      </div>

      <Card title={<span className="card-title-with-icon"><Send size={18} />请求配置</span>} bordered={false}>
        <Space direction="vertical" size={16} className="full-width">
          {!availableChannels.length ? (
            <Alert type="warning" showIcon message="没有可请求渠道" description="请先到渠道管理页为启用渠道配置 Base URL 和 API Key。" />
          ) : null}
          <Alert
            type="info"
            showIcon
            message="会向所选渠道发起真实请求"
            description="请求和响应会保存为一条手动模型请求任务。API Key 只读取渠道配置，不写入原始请求。"
          />
          <Alert
            type="warning"
            showIcon
            message="AWS 纯度探针"
            description="一键填入 thinking.enabled，并单独设置 temperature: 0.2。纯 AWS/Claude 路径预期应报错；测 relay 时，如果返回正常内容，就代表 relay 没有保持原生参数校验。要测 AWS 直连，请在渠道管理中选择 AWS Bedrock 请求协议并配置 AWS 凭据。"
            action={<Button size="small" onClick={applyAwsThinkingProbe}>填入探针</Button>}
          />
          <Form
            form={form}
            layout="vertical"
            initialValues={{ max_tokens: 256, temperature: 0, extra_params: '' }}
            onFinish={submit}
            onValuesChange={() => {
              setResult(null);
              setRequestError(null);
            }}
          >
            <div className="signature-config-grid">
              <Form.Item name="channel_id" label="请求渠道" rules={[{ required: true, message: '请选择请求渠道' }]}>
                <Select options={channelOptions} loading={channels.isLoading} placeholder="选择已配置密钥的渠道" />
              </Form.Item>
              <Form.Item name="max_tokens" label="Max tokens" rules={[{ required: true, message: '请输入 max_tokens' }]}>
                <InputNumber min={1} max={4096} precision={0} className="full-width" />
              </Form.Item>
              <Form.Item name="temperature" label="Temperature" rules={[{ required: true, message: '请输入 temperature' }]}>
                <InputNumber min={0} max={1} step={0.1} className="full-width" />
              </Form.Item>
            </div>
            <Form.Item name="system_prompt" label="System prompt">
              <Input.TextArea rows={2} placeholder="可选" />
            </Form.Item>
            <Form.Item name="prompt" label="Prompt" rules={[{ required: true, message: '请输入真实测试内容' }]}>
              <Input.TextArea rows={5} placeholder="例如：请用一句话说明你返回的 message id 能体现什么渠道特征。" />
            </Form.Item>
            <Form.Item
              name="extra_params"
              label="Extra params JSON"
              rules={[
                {
                  validator: async (_, value) => {
                    try {
                      parseExtraParams(value);
                    } catch (error) {
                      throw new Error(error instanceof Error ? error.message : 'JSON 格式不正确');
                    }
                  },
                },
              ]}
            >
              <Input.TextArea rows={6} placeholder='{"thinking":{"type":"enabled","budget_tokens":1024},"reasoning_effort":"medium"}' />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={requestModel.isPending} disabled={channels.isLoading || !availableChannels.length} icon={<Send size={16} />}>
              {requestModel.isPending ? '发送中' : '发送真实请求'}
            </Button>
          </Form>

          {requestError ? (
            <Alert type="error" showIcon message="真实请求没有发出或接口返回失败" description={requestError} />
          ) : null}
        </Space>
      </Card>

      {result ? (
        <Space direction="vertical" size={16} className="full-width">
          <Card title="请求结果" bordered={false}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="任务">
                <Link to={`/runs/${result.run.id}`}>{result.run.id}</Link>
              </Descriptions.Item>
              <Descriptions.Item label="状态">{result.run.status}</Descriptions.Item>
              <Descriptions.Item label="Message ID">{result.message_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="渠道特征">{result.message_channel_type}</Descriptions.Item>
              <Descriptions.Item label="协议">{result.request_protocol || '-'}</Descriptions.Item>
              <Descriptions.Item label="Endpoint">{result.provider_endpoint || '-'}</Descriptions.Item>
              <Descriptions.Item label="模型">{String(normalizedValue(result, 'provider_model') ?? '-')}</Descriptions.Item>
              <Descriptions.Item label="延迟">{String(normalizedValue(result, 'latency_ms') ?? '-')} ms</Descriptions.Item>
            </Descriptions>
          </Card>

          {result.result.normalized_response?.error ? (
            <Alert type="error" showIcon message="渠道请求失败" description={String(result.result.normalized_response.error)} />
          ) : null}

          {isExpectedErrorProbe ? (
            <Alert
              type={expectedErrorPassed ? 'success' : 'warning'}
              showIcon
              message={expectedErrorPassed ? '预期错误已命中' : '应报错但未报错'}
              description={
                expectedErrorPassed
                  ? `评分 ${result.result.score}，命中 AWS/Claude 原生 thinking temperature 校验。`
                  : `评分 ${result.result.score}，标签：${resultLabels.length ? resultLabels.join(', ') : '无'}。该渠道返回了正常 message，说明 temperature 可能被 relay 丢弃、改写，或未走 AWS 原生校验。`
              }
            />
          ) : null}

          {expectedErrorFailed && hasBedrockSourceFeatures ? (
            <Alert
              type="info"
              showIcon
              message="模型源特征存在，但参数纯度失败"
              description="返回里出现 msg_bdrk_ 或 thinking signature，说明后端可能仍是 Bedrock/Claude；但本探针要求原生校验直接拒绝，正常输出不能算通过。"
            />
          ) : null}

          <Card title={isExpectedErrorProbe ? '探针结果 / 异常证据' : '模型输出'} bordered={false}>
            <pre className="output-drawer-pre">{evidenceText}</pre>
          </Card>

          <div className="signature-sim-grid">
            <Card title="原始请求" bordered={false}>
              <pre className="signature-step-excerpt">{prettyJson(result.result.raw_request)}</pre>
            </Card>
            <Card title="原始响应" bordered={false}>
              <pre className="signature-step-excerpt">{prettyJson(result.result.raw_response)}</pre>
            </Card>
          </div>
        </Space>
      ) : null}
    </Space>
  );
}
