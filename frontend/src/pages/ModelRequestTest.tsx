import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Form, Input, InputNumber, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link, useNavigate } from 'react-router-dom';
import { BrainCircuit, Bug, DatabaseZap, Search, Send, ShieldCheck, Shuffle, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { formatChannelDisplayName } from '../channelCredentials';
import { formatDateTime } from '../time';
import type { CacheHitRateAttempt, CacheHitRateTestResult, Channel, ModelRequestTestResult } from '../types';

type ModelRequestForm = {
  channel_id: string;
  prompt: string;
  system_prompt?: string;
  max_tokens?: number;
  temperature?: number;
  extra_params?: string;
};

type ProbeKey = 'thinking_temperature' | 'web_search' | 'thinking_adaptive_enabled';

type ProbeConfig = {
  key: ProbeKey;
  title: string;
  buttonLabel: string;
  fillLabel: string;
  description: string;
  prompt: string;
  request_params: Record<string, unknown>;
  run_name: string;
  missingLabel: string;
  unexpectedLabel?: string;
};

type ComboProbeResult = {
  key: ProbeKey;
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
  expected_error_missing_label: 'thinking_temperature_not_rejected',
  expected_error_variant_label: 'provider_error_variant',
  expected_error_unexpected_label: 'unexpected_error_response',
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
  expected_error_variant_any: ['temperature may only be set to 1 when thinking is enabled', 'temperature', 'thinking'],
  expected_error_missing_label: 'thinking_adaptive_enabled_not_rejected',
  expected_error_variant_label: 'provider_error_variant',
  expected_error_unexpected_label: 'thinking_adaptive_enabled_wrong_error',
};

const PROBES: ProbeConfig[] = [
  {
    key: 'thinking_temperature',
    title: 'Thinking temperature 冲突',
    buttonLabel: '测试 Thinking 温度冲突',
    fillLabel: '填入 Thinking 温度冲突',
    description: '构造 thinking + 非 1 temperature，预期上游直接拒绝。',
    prompt: AWS_THINKING_PROBE_PROMPT,
    request_params: AWS_THINKING_PROBE_EXTRA_PARAMS,
    run_name: '纯度检测 · thinking_temperature',
    missingLabel: 'thinking_temperature_not_rejected',
    unexpectedLabel: 'unexpected_error_response',
  },
  {
    key: 'web_search',
    title: 'Web Search tool',
    buttonLabel: '测试 Web Search 工具',
    fillLabel: '填入 Web Search 工具',
    description: '构造 Anthropic Web Search tool，预期 AWS/Bedrock 或不支持路径直接拒绝。',
    prompt: AWS_WEB_SEARCH_PROBE_PROMPT,
    request_params: AWS_WEB_SEARCH_PROBE_EXTRA_PARAMS,
    run_name: '纯度检测 · web_search',
    missingLabel: 'web_search_not_rejected',
    unexpectedLabel: 'unexpected_error_response',
  },
  {
    key: 'thinking_adaptive_enabled',
    title: 'thinking.adaptive.enabled',
    buttonLabel: '测试 adaptive.enabled',
    fillLabel: '填入 adaptive.enabled',
    description: '构造 AWS 不支持的 thinking.adaptive.enabled，预期上游直接拒绝。',
    prompt: THINKING_ADAPTIVE_ENABLED_PROBE_PROMPT,
    request_params: THINKING_ADAPTIVE_ENABLED_PROBE_EXTRA_PARAMS,
    run_name: '纯度检测 · thinking_adaptive_enabled',
    missingLabel: 'thinking_adaptive_enabled_not_rejected',
    unexpectedLabel: 'thinking_adaptive_enabled_wrong_error',
  },
];

const COMBO_PROBES = PROBES.map((probe) => ({
  ...probe,
  run_name: `组合纯度检测 · ${probe.key}`,
}));

function channelApiKey(channel: Channel) {
  const value = channel.auth_config?.api_key;
  return typeof value === 'string' ? value : '';
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? null, null, 2);
}

function formatPercent(value: number) {
  return `${Number.isFinite(value) ? value.toFixed(2) : '0.00'}%`;
}

function normalizedValue(result: ModelRequestTestResult | null, key: string) {
  const normalized = result?.result.normalized_response;
  return normalized && typeof normalized === 'object' ? normalized[key] : undefined;
}

function rawResponseHasThinkingSignature(result: ModelRequestTestResult | null) {
  const content = result?.result.raw_response?.content;
  return Array.isArray(content) && content.some((block) => block && typeof block === 'object' && 'type' in block && (block as Record<string, unknown>).type === 'thinking' && 'signature' in block);
}

function resultErrorText(result: ModelRequestTestResult) {
  return String(result.result.normalized_response?.error ?? '');
}

function comboProbePassed(result: ModelRequestTestResult) {
  return result.result.score === 100 && Boolean(resultErrorText(result));
}

function probeFailed(result: ModelRequestTestResult, probe?: ProbeConfig) {
  const labels = result.result.labels ?? [];
  return Boolean(probe?.missingLabel && labels.includes(probe.missingLabel)) || result.result.score < 100;
}

function probeByKey(key: ProbeKey) {
  return PROBES.find((probe) => probe.key === key);
}

function classifyProbeResult(result: ModelRequestTestResult, probe?: ProbeConfig) {
  const labels = result.result.labels ?? [];
  const error = resultErrorText(result);
  if (result.result.score === 100 && error) {
    return { color: 'green', text: labels.includes('provider_error_variant') ? '通过·等价错误' : '通过', summary: '命中预期上游拒绝' };
  }
  if (probe?.missingLabel && labels.includes(probe.missingLabel)) {
    return { color: 'red', text: '未原生拒绝', summary: '渠道返回正常内容，可能吞参、改写或不是原生拒绝路径' };
  }
  if (probe?.unexpectedLabel && labels.includes(probe.unexpectedLabel)) {
    return { color: 'orange', text: '非预期错误', summary: '有错误返回，但不是该探针目标错误' };
  }
  if (error) {
    return { color: 'orange', text: '请求失败', summary: '请求失败或错误内容未命中该探针预期' };
  }
  return { color: 'orange', text: '可疑', summary: '未命中该探针预期结果' };
}

function probeRequestFields(probe: ProbeConfig) {
  const { max_tokens, temperature, ...extraParams } = probe.request_params;
  return {
    max_tokens: typeof max_tokens === 'number' ? max_tokens : undefined,
    temperature: typeof temperature === 'number' ? temperature : undefined,
    extra_params: extraParams,
  };
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ModelRequestForm>();
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const [result, setResult] = useState<ModelRequestTestResult | null>(null);
  const [comboResults, setComboResults] = useState<ComboProbeResult[]>([]);
  const [cacheResult, setCacheResult] = useState<CacheHitRateTestResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const availableChannels = useMemo(
    () => (channels.data ?? []).filter((channel) => channel.enabled && channel.base_url && channelApiKey(channel)),
    [channels.data],
  );

  const channelOptions = availableChannels.map((channel) => ({
    value: channel.id,
    label: `${formatChannelDisplayName(channel)} · ${channel.model_name || '未配置模型'}`,
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
        message.success('三项组合测试通过');
      } else {
        message.warning('三项组合测试发现可定位问题');
      }
    },
    onError: (error) => {
      const detail = error instanceof Error ? error.message : '组合纯度检测失败';
      setRequestError(detail);
      message.error(detail);
    },
  });

  const runSingleProbe = useMutation({
    mutationFn: ({ channelId, probe }: { channelId: string; probe: ProbeConfig }) =>
      api.modelRequestTest(channelId, {
        prompt: probe.prompt,
        system_prompt: null,
        request_params: probe.request_params,
        run_name: probe.run_name,
      }),
    onSuccess: (payload) => {
      setRequestError(null);
      setComboResults([]);
      setResult(payload);
      if (payload.result.score === 100 && payload.result.normalized_response?.error) {
        message.success('命中预期上游拒绝');
      } else if (payload.result.normalized_response?.error) {
        message.warning('返回了错误，但不是该探针的目标错误');
      } else {
        message.warning('未命中预期拒绝：渠道返回了正常内容');
      }
    },
    onError: (error) => {
      const detail = error instanceof Error ? error.message : '探针测试失败';
      setRequestError(detail);
      message.error(detail);
    },
  });
  const deleteProbeRun = useMutation({
    mutationFn: api.deleteRun,
    onSuccess: async (_, runId) => {
      message.success('请求日志已删除');
      setResult((current) => current?.run.id === runId ? null : current);
      setComboResults((items) => items.filter((item) => item.payload.run.id !== runId));
      setCacheResult((current) => current?.run.id === runId ? null : current);
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });
  const deleteComboRuns = useMutation({
    mutationFn: async (ids: string[]) => {
      const settled = await Promise.allSettled(ids.map((id) => api.deleteRun(id)));
      const failed = settled.filter((item) => item.status === 'rejected').length;
      return { deleted: ids.length - failed, failed };
    },
    onSuccess: async (payload) => {
      message.success(payload.failed ? `已删除 ${payload.deleted} 条日志，${payload.failed} 条删除失败` : `已删除 ${payload.deleted} 条日志`);
      setComboResults([]);
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const runCacheProbe = useMutation({
    mutationFn: (channelId: string) =>
      api.cacheHitRateTest(channelId, {
        test_count: 10,
        interval_seconds: 3,
        warmup_wait_seconds: 5,
        run_name: '缓存命中率测试',
      }),
    onSuccess: (payload) => {
      setRequestError(null);
      setResult(null);
      setComboResults([]);
      setCacheResult(payload);
      if (payload.hits > 0) {
        message.success(`缓存测试完成：命中率 ${formatPercent(payload.request_hit_rate)}`);
      } else {
        message.warning('缓存测试完成：未观察到缓存命中');
      }
    },
    onError: (error) => {
      const detail = error instanceof Error ? error.message : '缓存命中率测试失败';
      setRequestError(detail);
      message.error(detail);
    },
  });

  function submit(values: ModelRequestForm) {
    setResult(null);
    setComboResults([]);
    setCacheResult(null);
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
    setCacheResult(null);
    setRequestError(null);
    runComboProbe.mutate(channelId);
  }

  function submitSingleProbe(probe: ProbeConfig) {
    const channelId = form.getFieldValue('channel_id');
    if (!channelId) {
      message.warning('请选择请求渠道');
      return;
    }
    setResult(null);
    setComboResults([]);
    setCacheResult(null);
    setRequestError(null);
    runSingleProbe.mutate({ channelId, probe });
  }

  function submitCacheProbe() {
    const channelId = form.getFieldValue('channel_id');
    if (!channelId) {
      message.warning('请选择请求渠道');
      return;
    }
    setResult(null);
    setComboResults([]);
    setCacheResult(null);
    setRequestError(null);
    runCacheProbe.mutate(channelId);
  }

  function applyProbe(probe: ProbeConfig) {
    const fields = probeRequestFields(probe);
    form.setFieldsValue({
      prompt: probe.prompt,
      max_tokens: fields.max_tokens,
      temperature: fields.temperature,
      extra_params: JSON.stringify(fields.extra_params, null, 2),
    });
    setResult(null);
    setComboResults([]);
    setCacheResult(null);
    setRequestError(null);
  }

  function deleteSingleResult(payload: ModelRequestTestResult) {
    deleteProbeRun.mutate(payload.run.id);
  }

  function deleteComboResult() {
    const ids = comboResults.map((item) => item.payload.run.id);
    if (!ids.length) {
      message.warning('没有可删除的组合日志');
      return;
    }
    deleteComboRuns.mutate(ids);
  }

  const cacheAttemptColumns: ColumnsType<CacheHitRateAttempt> = [
    {
      title: '请求',
      dataIndex: 'attempt_index',
      key: 'attempt_index',
      render: (value: number) => `#${value - 1}`,
    },
    {
      title: '命中',
      dataIndex: 'cache_hit',
      key: 'cache_hit',
      render: (value: boolean) => <Tag color={value ? 'green' : 'red'}>{value ? '命中' : '未命中'}</Tag>,
    },
    {
      title: '缓存 tokens',
      dataIndex: 'cache_read_input_tokens',
      key: 'cache_read_input_tokens',
    },
    {
      title: '写入 tokens',
      dataIndex: 'cache_creation_input_tokens',
      key: 'cache_creation_input_tokens',
    },
    {
      title: '输入 tokens',
      dataIndex: 'input_tokens',
      key: 'input_tokens',
    },
    {
      title: 'Prompt tokens',
      dataIndex: 'prompt_tokens',
      key: 'prompt_tokens',
    },
    {
      title: '延迟',
      dataIndex: 'latency_ms',
      key: 'latency_ms',
      render: (value: number | null) => (value == null ? '-' : `${value} ms`),
    },
    {
      title: 'Message ID',
      dataIndex: 'message_id',
      key: 'message_id',
      render: (value: string | null) => value || '-',
    },
    {
      title: 'Request ID',
      dataIndex: 'request_id',
      key: 'request_id',
      render: (value: string | null) => value || '-',
    },
  ];

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
  const comboSuspicious = comboResults.some((item) => probeFailed(item.payload, probeByKey(item.key)));
  const comboUnsupported = comboResults
    .filter((item) => {
      const probe = probeByKey(item.key);
      const labels = item.payload.result.labels ?? [];
      return Boolean(probe?.missingLabel && labels.includes(probe.missingLabel));
    })
    .map((item) => item.title);
  const comboUnexpected = comboResults
    .filter((item) => {
      const probe = probeByKey(item.key);
      const labels = item.payload.result.labels ?? [];
      return Boolean(probe?.unexpectedLabel && labels.includes(probe.unexpectedLabel));
    })
    .map((item) => item.title);

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
          <div className="signature-sim-grid">
            {PROBES.map((probe) => (
              <Alert
                key={probe.key}
                type="warning"
                showIcon
                message={probe.title}
                description={probe.description}
                action={<Button size="small" onClick={() => applyProbe(probe)}>{probe.fillLabel}</Button>}
              />
            ))}
          </div>
          <Form
            form={form}
            layout="vertical"
            initialValues={{ max_tokens: 256, temperature: 0, extra_params: '' }}
            onFinish={submit}
            onValuesChange={() => {
              setResult(null);
              setComboResults([]);
              setCacheResult(null);
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
              <Button type="primary" htmlType="submit" loading={requestModel.isPending} disabled={channels.isLoading || !availableChannels.length || runComboProbe.isPending || runSingleProbe.isPending || runCacheProbe.isPending} icon={<Send size={16} />}>
                {requestModel.isPending ? '发送中' : '发送真实请求'}
              </Button>
              <Button onClick={() => submitSingleProbe(PROBES[0])} loading={runSingleProbe.isPending} disabled={channels.isLoading || !availableChannels.length || requestModel.isPending || runComboProbe.isPending || runCacheProbe.isPending} icon={<BrainCircuit size={16} />}>
                {runSingleProbe.isPending ? '测试中' : PROBES[0].buttonLabel}
              </Button>
              <Button onClick={() => submitSingleProbe(PROBES[1])} loading={runSingleProbe.isPending} disabled={channels.isLoading || !availableChannels.length || requestModel.isPending || runComboProbe.isPending || runCacheProbe.isPending} icon={<Search size={16} />}>
                {runSingleProbe.isPending ? '测试中' : PROBES[1].buttonLabel}
              </Button>
              <Button onClick={() => submitSingleProbe(PROBES[2])} loading={runSingleProbe.isPending} disabled={channels.isLoading || !availableChannels.length || requestModel.isPending || runComboProbe.isPending || runCacheProbe.isPending} icon={<Bug size={16} />}>
                {runSingleProbe.isPending ? '测试中' : PROBES[2].buttonLabel}
              </Button>
              <Button onClick={submitComboProbe} loading={runComboProbe.isPending} disabled={channels.isLoading || !availableChannels.length || requestModel.isPending || runSingleProbe.isPending || runCacheProbe.isPending} icon={<Shuffle size={16} />}>
                {runComboProbe.isPending ? '检测中' : '三项组合测试'}
              </Button>
              <Button onClick={submitCacheProbe} loading={runCacheProbe.isPending} disabled={channels.isLoading || !availableChannels.length || requestModel.isPending || runSingleProbe.isPending || runComboProbe.isPending} icon={<DatabaseZap size={16} />}>
                {runCacheProbe.isPending ? '测试中' : '测试缓存命中率'}
              </Button>
              <Button onClick={() => navigate('/claude-code-check')} disabled={channels.isLoading || requestModel.isPending || runSingleProbe.isPending || runComboProbe.isPending || runCacheProbe.isPending} icon={<ShieldCheck size={16} />}>
                打开 ClaudeCode 专页
              </Button>
            </Space>
          </Form>

          {requestError ? (
            <Alert type="error" showIcon message="真实请求没有发出或接口返回失败" description={requestError} />
          ) : null}
        </Space>
      </Card>

      {cacheResult ? (
        <Space direction="vertical" size={16} className="full-width">
          <Alert
            type={cacheResult.hits > 0 ? 'success' : 'warning'}
            showIcon
            message={cacheResult.hits > 0 ? '缓存命中率测试完成' : '未观察到缓存命中'}
            description={`请求命中率 ${formatPercent(cacheResult.request_hit_rate)}，Token 命中率 ${formatPercent(cacheResult.token_hit_rate)}。`}
          />
          <Card title="缓存命中率结果" bordered={false}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="任务">
                <Link to={`/runs/${cacheResult.run.id}`}>{cacheResult.run.id}</Link>
              </Descriptions.Item>
              <Descriptions.Item label="状态">{cacheResult.run.status}</Descriptions.Item>
              <Descriptions.Item label="请求命中">{cacheResult.hits}/{cacheResult.total}</Descriptions.Item>
              <Descriptions.Item label="请求命中率">{formatPercent(cacheResult.request_hit_rate)}</Descriptions.Item>
              <Descriptions.Item label="Token 命中率">{formatPercent(cacheResult.token_hit_rate)}</Descriptions.Item>
              <Descriptions.Item label="总缓存 tokens">{cacheResult.total_cached_tokens}</Descriptions.Item>
              <Descriptions.Item label="总 prompt tokens">{cacheResult.total_prompt_tokens}</Descriptions.Item>
              <Descriptions.Item label="平均缓存 tokens">{cacheResult.avg_cached_tokens}</Descriptions.Item>
              <Descriptions.Item label="预热写入 tokens">{cacheResult.warmup_cache_creation_input_tokens}</Descriptions.Item>
              <Descriptions.Item label="渠道特征">{cacheResult.message_channel_type}</Descriptions.Item>
              <Descriptions.Item label="协议">{cacheResult.request_protocol || '-'}</Descriptions.Item>
              <Descriptions.Item label="Endpoint">{cacheResult.provider_endpoint || '-'}</Descriptions.Item>
            </Descriptions>
            <Popconfirm
              title="删除本次缓存测试日志"
              description="会删除本次缓存测试生成的任务和所有请求结果。确定删除吗？"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => deleteProbeRun.mutate(cacheResult.run.id)}
            >
              <Button danger icon={<Trash2 size={15} />} loading={deleteProbeRun.isPending && deleteProbeRun.variables === cacheResult.run.id} style={{ marginTop: 16 }}>
                删除本次缓存测试日志
              </Button>
            </Popconfirm>
          </Card>
          {cacheResult.warmup ? (
            <Card title="预热请求" bordered={false}>
              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label="Message ID">{cacheResult.warmup.message_id || '-'}</Descriptions.Item>
                <Descriptions.Item label="Request ID">{cacheResult.warmup.request_id || '-'}</Descriptions.Item>
                <Descriptions.Item label="写入 tokens">{cacheResult.warmup.cache_creation_input_tokens}</Descriptions.Item>
                <Descriptions.Item label="输入 tokens">{cacheResult.warmup.input_tokens}</Descriptions.Item>
              </Descriptions>
            </Card>
          ) : null}
          <Card title="测量请求明细" bordered={false}>
            <Table<CacheHitRateAttempt>
              rowKey={(row) => row.result.id}
              dataSource={cacheResult.attempts}
              columns={cacheAttemptColumns}
              pagination={false}
              size="small"
              scroll={{ x: 1100 }}
            />
          </Card>
        </Space>
      ) : null}

      {comboResults.length ? (
        <Space direction="vertical" size={16} className="full-width">
          <Alert
            type={comboPassed ? 'success' : comboSuspicious ? 'warning' : 'info'}
            showIcon
            message={comboPassed ? '三项组合测试通过' : comboSuspicious ? '三项组合测试发现可定位问题' : '三项组合测试完成'}
            description={
              comboPassed
                ? '三个探针都命中预期上游错误，渠道保留了关键原生拒绝行为。'
                : [
                    comboUnsupported.length ? `未原生拒绝：${comboUnsupported.join('、')}` : null,
                    comboUnexpected.length ? `非预期错误：${comboUnexpected.join('、')}` : null,
                    '请查看下方每个类型的标签和原始响应。',
                  ].filter(Boolean).join('；')
            }
          />
          {(
            <Popconfirm
              title="删除本次组合日志"
              description={`会删除本次组合测试产生的 ${comboResults.length} 条任务日志。确定删除吗？`}
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={deleteComboResult}
            >
              <Button danger icon={<Trash2 size={15} />} loading={deleteComboRuns.isPending}>
                删除本次组合日志
              </Button>
            </Popconfirm>
          )}
          <div className="signature-sim-grid">
            {comboResults.map(({ key, title, payload }) => {
              const labels = payload.result.labels ?? [];
              const error = resultErrorText(payload);
              const probe = probeByKey(key);
              const classification = classifyProbeResult(payload, probe);
              return (
                <Card key={key} title={title} bordered={false}>
                  <Descriptions bordered size="small" column={1}>
                    <Descriptions.Item label="任务">
                      <Link to={`/runs/${payload.run.id}`}>{payload.run.id}</Link>
                    </Descriptions.Item>
                    <Descriptions.Item label="Message ID">{payload.message_id || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Request ID">{payload.request_id || '-'}</Descriptions.Item>
                    <Descriptions.Item label="创建时间">{formatDateTime(payload.run.created_at)}</Descriptions.Item>
                    <Descriptions.Item label="完成时间">{formatDateTime(payload.run.finished_at)}</Descriptions.Item>
                    <Descriptions.Item label="结果">
                      <Tag color={classification.color}>{classification.text}</Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="判断">{classification.summary}</Descriptions.Item>
                    <Descriptions.Item label="评分">{payload.result.score}</Descriptions.Item>
                    <Descriptions.Item label="标签">{labels.length ? labels.join(', ') : '-'}</Descriptions.Item>
                    <Descriptions.Item label="协议">{payload.request_protocol || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Endpoint">{payload.provider_endpoint || '-'}</Descriptions.Item>
                    <Descriptions.Item label="错误摘要">{error || '未返回错误'}</Descriptions.Item>
                  </Descriptions>
                  {(
                    <Popconfirm
                      title="删除该探针日志"
                      description="会删除该探针产生的任务和结果。确定删除吗？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => deleteSingleResult(payload)}
                    >
                      <Button danger icon={<Trash2 size={15} />} loading={deleteProbeRun.isPending && deleteProbeRun.variables === payload.run.id} style={{ marginTop: 12 }}>
                        删除该日志
                      </Button>
                    </Popconfirm>
                  )}
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
              <Descriptions.Item label="创建时间">{formatDateTime(result.run.created_at)}</Descriptions.Item>
              <Descriptions.Item label="完成时间">{formatDateTime(result.run.finished_at)}</Descriptions.Item>
              <Descriptions.Item label="状态">{result.run.status}</Descriptions.Item>
              <Descriptions.Item label="Message ID">{result.message_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="Request ID">{result.request_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="渠道特征">{result.message_channel_type}</Descriptions.Item>
              <Descriptions.Item label="协议">{result.request_protocol || '-'}</Descriptions.Item>
              <Descriptions.Item label="Endpoint">{result.provider_endpoint || '-'}</Descriptions.Item>
              <Descriptions.Item label="模型">{String(normalizedValue(result, 'provider_model') ?? '-')}</Descriptions.Item>
              <Descriptions.Item label="延迟">{String(normalizedValue(result, 'latency_ms') ?? '-')} ms</Descriptions.Item>
            </Descriptions>
            {(
              <Popconfirm
                title="删除本次请求日志"
                description="会删除本次真实请求生成的任务、结果和日志。确定删除吗？"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => deleteSingleResult(result)}
              >
                <Button danger icon={<Trash2 size={15} />} loading={deleteProbeRun.isPending && deleteProbeRun.variables === result.run.id} style={{ marginTop: 16 }}>
                  删除本次请求日志
                </Button>
              </Popconfirm>
            )}
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
