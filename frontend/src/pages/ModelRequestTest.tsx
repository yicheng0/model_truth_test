import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Form, Input, InputNumber, Select, Space, Tag, Typography, message } from 'antd';
import { Link } from 'react-router-dom';
import { Bug, Send } from 'lucide-react';
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

type ComboProbeKey = 'thinking' | 'web_search';

type ComboProbeResult = {
  key: ComboProbeKey;
  title: string;
  payload: ModelRequestTestResult;
};

const AWS_THINKING_PROBE_PROMPT = '请用一句话回答：这是 thinking temperature 纯度探针。';
const AWS_THINKING_PROBE_EXTRA_PARAMS = {
  max_tokens: 2048,
  temperature: 0.2,
  thinking: { type: 'enabled', budget_tokens: 1024 },
  reasoning_effort: 'medium',
  expected_error_contains: 'temperature may only be set to 1 when thinking is enabled',
  expected_error_any: ['temperature', 'thinking'],
  expected_error_variant_any: ['temperature', 'thinking'],
};

const AWS_WEB_SEARCH_PROBE_PROMPT = '请查询今天 Anthropic 官方新闻或博客的最新更新，并给出标题、发布日期和来源链接。注意：如果当前环境没有真实联网或搜索工具，请明确说明无法实时查询，不要凭记忆编造。';
const AWS_WEB_SEARCH_PROBE_EXTRA_PARAMS = {
  max_tokens: 900,
  temperature: 0,
  stream: true,
  tools: [
    {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 5,
    },
  ],
  expected_error_contains: 'web search',
  expected_error_any: ['web_search', 'unsupported', 'not available', 'tool', 'bedrock'],
  expected_error_missing_label: 'web_search_not_rejected',
  expected_error_variant_label: 'provider_error_variant',
};

const THINKING_ADAPTIVE_ENABLED_PROBE_PROMPT = '回复OK';
const THINKING_ADAPTIVE_ENABLED_PROBE_EXTRA_PARAMS = {
  max_tokens: 2000,
  temperature: 0,
  thinking: {
    type: 'enabled',
    adaptive: { enabled: true },
    budget_tokens: 8000,
    max_tokens: 2000,
  },
  expected_error_required_all: ['enabled', 'not supported', 'output_config.effort'],
  expected_error_missing_label: 'thinking_adaptive_enabled_not_rejected',
  expected_error_unexpected_label: 'thinking_adaptive_enabled_wrong_error',
};

const COMBO_PROBES = [
  {
    key: 'thinking' as const,
    title: 'Thinking temperature',
    prompt: AWS_THINKING_PROBE_PROMPT,
    request_params: AWS_THINKING_PROBE_EXTRA_PARAMS,
    run_name: '组合纯度检测 · thinking',
  },
  {
    key: 'web_search' as const,
    title: 'Web Search tool',
    prompt: AWS_WEB_SEARCH_PROBE_PROMPT,
    request_params: AWS_WEB_SEARCH_PROBE_EXTRA_PARAMS,
    run_name: '组合纯度检测 · web_search',
  },
];

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

function resultErrorText(result: ModelRequestTestResult) {
  return String(result.result.normalized_response?.error ?? '');
}

function comboProbePassed(result: ModelRequestTestResult) {
  return result.result.score === 100 && Boolean(resultErrorText(result));
}

function comboProbeFailed(result: ModelRequestTestResult) {
  const labels = result.result.labels ?? [];
  return labels.includes('thinking_temperature_not_rejected') || labels.includes('web_search_not_rejected') || labels.includes('thinking_adaptive_enabled_not_rejected') || result.result.score < 100;
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
  const [comboResults, setComboResults] = useState<ComboProbeResult[]>([]);
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
      const isProbeFailure = labels.includes('web_search_not_rejected');
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

  const runComboProbe = useMutation({
    mutationFn: async (channelId: string) => {
      const results: ComboProbeResult[] = [];
      for (const probe of COMBO_PROBES) {
        const payload = await api.modelRequestTest(channelId, {
          prompt: probe.prompt,
          system_prompt: null,
          request_params: probe.request_params,
          run_name: probe.run_name,
        });
        results.push({ key: probe.key, title: probe.title, payload });
      }
      return results;
    },
    onSuccess: (payload) => {
      setRequestError(null);
      setResult(null);
      setComboResults(payload);
      if (payload.every((item) => comboProbePassed(item.payload))) {
        message.success('组合纯度检测通过');
      } else {
        message.warning('组合纯度检测发现可疑项');
      }
    },
    onError: (error) => {
      const detail = error instanceof Error ? error.message : '组合纯度检测失败';
      setRequestError(detail);
      message.error(detail);
    },
  });

  const runAdaptiveEnabledProbe = useMutation({
    mutationFn: (channelId: string) =>
      api.modelRequestTest(channelId, {
        prompt: THINKING_ADAPTIVE_ENABLED_PROBE_PROMPT,
        system_prompt: null,
        request_params: THINKING_ADAPTIVE_ENABLED_PROBE_EXTRA_PARAMS,
        run_name: 'thinking.adaptive.enabled 纯度检测',
      }),
    onSuccess: (payload) => {
      setRequestError(null);
      setComboResults([]);
      setResult(payload);
      const labels = payload.result.labels ?? [];
      if (payload.result.score === 100 && payload.result.normalized_response?.error) {
        message.success('命中 adaptive.enabled 原生拒绝');
      } else if (labels.includes('thinking_adaptive_enabled_not_rejected')) {
        message.warning('未拒绝 adaptive.enabled：渠道返回了正常内容');
      } else if (labels.includes('thinking_adaptive_enabled_wrong_error')) {
        message.warning('返回了错误，但不是 adaptive.enabled 目标错误');
      } else {
        message.warning('adaptive.enabled 探针返回非预期结果');
      }
    },
    onError: (error) => {
      const detail = error instanceof Error ? error.message : 'adaptive.enabled 探针失败';
      setRequestError(detail);
      message.error(detail);
    },
  });

  function submit(values: ModelRequestForm) {
    setResult(null);
    setComboResults([]);
    setRequestError(null);
    requestModel.mutate(values);
  }

  function submitComboProbe() {
    const channelId = form.getFieldValue('channel_id');
    if (!channelId) {
      message.warning('请选择请求渠道');
      return;
    }
    setResult(null);
    setComboResults([]);
    setRequestError(null);
    runComboProbe.mutate(channelId);
  }

  function submitAdaptiveEnabledProbe() {
    const channelId = form.getFieldValue('channel_id');
    if (!channelId) {
      message.warning('请选择请求渠道');
      return;
    }
    setResult(null);
    setComboResults([]);
    setRequestError(null);
    runAdaptiveEnabledProbe.mutate(channelId);
  }

  function applyAwsWebSearchProbe() {
    form.setFieldsValue({
      prompt: AWS_WEB_SEARCH_PROBE_PROMPT,
      max_tokens: 900,
      temperature: 0,
      extra_params: JSON.stringify(AWS_WEB_SEARCH_PROBE_EXTRA_PARAMS, null, 2),
    });
    setResult(null);
    setComboResults([]);
    setRequestError(null);
  }

  const resultLabels = result?.result.labels ?? [];
  const resultParams = result?.result.raw_request?.params;
  const isExpectedErrorProbe = Boolean(
    resultParams?.expected_error_contains ||
      resultParams?.expected_error_any ||
      resultParams?.expected_error_variant_any ||
      resultParams?.expected_error_required_all,
  );
  const expectedErrorPassed = isExpectedErrorProbe && result ? result.result.score === 100 && Boolean(normalizedValue(result, 'error')) : false;
  const expectedErrorFailed = isExpectedErrorProbe && !expectedErrorPassed;
  const outputText = String(normalizedValue(result, 'content_text') ?? '');
  const errorText = String(normalizedValue(result, 'error') ?? '');
  const evidenceText = expectedErrorPassed ? errorText : outputText || errorText || '无文本输出，请查看原始响应。';
  const hasBedrockSourceFeatures = result?.message_id?.startsWith('msg_bdrk_') || rawResponseHasThinkingSignature(result);
  const comboPassed = comboResults.length === COMBO_PROBES.length && comboResults.every((item) => comboProbePassed(item.payload));
  const comboSuspicious = comboResults.some((item) => comboProbeFailed(item.payload));

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
            message="Web Search 纯度探针"
            description="一键填入 Anthropic Web Search tool 请求。预期在原生 AWS/Bedrock 或不支持该工具的路径上直接报错；如果返回正常内容，说明中间层没有保持原生拒绝行为。"
            action={<Button size="small" onClick={applyAwsWebSearchProbe}>填入探针</Button>}
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
            <Space wrap>
              <Button type="primary" htmlType="submit" loading={requestModel.isPending} disabled={channels.isLoading || !availableChannels.length || runComboProbe.isPending} icon={<Send size={16} />}>
                {requestModel.isPending ? '发送中' : '发送真实请求'}
              </Button>
              <Button onClick={submitComboProbe} loading={runComboProbe.isPending} disabled={channels.isLoading || !availableChannels.length || requestModel.isPending}>
                {runComboProbe.isPending ? '检测中' : '组合纯度检测'}
              </Button>
              <Button onClick={submitAdaptiveEnabledProbe} loading={runAdaptiveEnabledProbe.isPending} disabled={channels.isLoading || !availableChannels.length || requestModel.isPending || runComboProbe.isPending} icon={<Bug size={16} />}>
                {runAdaptiveEnabledProbe.isPending ? '测试中' : '测试 adaptive.enabled'}
              </Button>
            </Space>
          </Form>

          {requestError ? (
            <Alert type="error" showIcon message="真实请求没有发出或接口返回失败" description={requestError} />
          ) : null}
        </Space>
      </Card>

      {comboResults.length ? (
        <Space direction="vertical" size={16} className="full-width">
          <Alert
            type={comboPassed ? 'success' : comboSuspicious ? 'warning' : 'info'}
            showIcon
            message={comboPassed ? '组合纯度检测通过' : comboSuspicious ? '组合纯度检测发现可疑项' : '组合纯度检测完成'}
            description={
              comboPassed
                ? '两个探针都命中预期上游错误，渠道保留了关键原生拒绝行为。'
                : '至少一个探针没有按预期直接报错，请查看对应标签和原始响应。'
            }
          />
          <div className="signature-sim-grid">
            {comboResults.map(({ key, title, payload }) => {
              const labels = payload.result.labels ?? [];
              const error = resultErrorText(payload);
              const passed = comboProbePassed(payload);
              return (
                <Card key={key} title={title} bordered={false}>
                  <Descriptions bordered size="small" column={1}>
                    <Descriptions.Item label="任务">
                      <Link to={`/runs/${payload.run.id}`}>{payload.run.id}</Link>
                    </Descriptions.Item>
                    <Descriptions.Item label="结果">
                      <Tag color={passed ? 'green' : 'orange'}>{passed ? '通过' : '可疑'}</Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="评分">{payload.result.score}</Descriptions.Item>
                    <Descriptions.Item label="标签">{labels.length ? labels.join(', ') : '-'}</Descriptions.Item>
                    <Descriptions.Item label="协议">{payload.request_protocol || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Endpoint">{payload.provider_endpoint || '-'}</Descriptions.Item>
                    <Descriptions.Item label="错误摘要">{error || '未返回错误'}</Descriptions.Item>
                  </Descriptions>
                </Card>
              );
            })}
          </div>
        </Space>
      ) : null}

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
                  ? `评分 ${result.result.score}，命中预期上游错误。`
                  : `评分 ${result.result.score}，标签：${resultLabels.length ? resultLabels.join(', ') : '无'}。该渠道返回了正常 message 或非预期错误，说明中间层可能丢弃、改写或未保留原生校验。`
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
