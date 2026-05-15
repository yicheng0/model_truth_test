import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Form, Input, InputNumber, Select, Space, Tag, Typography, message } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { isCandidateChannel, isReferenceChannel } from '../channelPresets';
import { buildRuntimeCredentials, hasStoredApiKey } from '../channelCredentials';
import { formatDateTime } from '../time';
import type { BaselineSnapshot, Channel, TestSuite } from '../types';

type CreateMode = 'baseline_build' | 'candidate_eval' | 'performance_benchmark' | 'arena_comparison';
const DEFAULT_SUITE_ID = 'claude_full_35';
const modeHelp: Record<CreateMode, string> = {
  baseline_build: '采集官方或参考渠道输出，生成后续真实性对比可复用的渠道指纹。',
  candidate_eval: '候选渠道对比渠道指纹，输出协议、能力、相似度和风险证据链。',
  performance_benchmark: '对一个或多个渠道分别做性能诊断，只看延迟、TTFT、TPOT、吞吐和失败率。',
  arena_comparison: '候选渠道之间做横向排名和样本分歧分析，不作为官方真实性判断。',
};

type CreateRunValues = {
  name: string;
  suite_id: string;
  mode: CreateMode;
  baseline_snapshot_id?: string;
  reference_channel_ids?: string[];
  candidate_channel_ids?: string[];
  benchmark_channel_ids?: string[];
  arena_channel_ids?: string[];
  benchmark_concurrency_steps?: string;
  benchmark_duration_seconds?: number;
  benchmark_warmup_requests?: number;
  benchmark_target_qps?: number;
  benchmark_sla_p95_ms?: number;
  benchmark_max_error_rate?: number;
  judge_channel_id?: string;
  judge_mode?: string;
  judge_rubric?: string;
  runtime_credentials?: Record<string, RuntimeCredentialValues>;
};

type RuntimeCredentialValues = {
  api_key?: string;
};

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试';
}

function parseConcurrencySteps(value?: string) {
  const steps = (value || '1,4,8')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
  return steps.length ? Array.from(new Set(steps)) : [1];
}

export default function CreateRun() {
  const [form] = Form.useForm<CreateRunValues>();
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryMode = searchParams.get('mode');
  const initialMode: CreateMode =
    queryMode === 'baseline'
      ? 'baseline_build'
      : queryMode === 'performance'
        ? 'performance_benchmark'
        : queryMode === 'arena'
          ? 'arena_comparison'
          : 'candidate_eval';
  const selectedMode = Form.useWatch('mode', form) ?? initialMode;
  const watchedSuiteId = Form.useWatch('suite_id', form);
  const watchedReferenceChannelIds = Form.useWatch('reference_channel_ids', form) ?? [];
  const watchedCandidateChannelIds = Form.useWatch('candidate_channel_ids', form) ?? [];
  const watchedBenchmarkChannelIds = Form.useWatch('benchmark_channel_ids', form) ?? [];
  const watchedArenaChannelIds = Form.useWatch('arena_channel_ids', form) ?? [];
  const suites = useQuery<TestSuite[]>({ queryKey: ['suites'], queryFn: api.suites });
  const channels = useQuery<Channel[]>({ queryKey: ['channels'], queryFn: api.channels });
  const builtInSuite = useMemo(
    () => (suites.data ?? []).find((suite) => suite.id === DEFAULT_SUITE_ID) ?? suites.data?.[0],
    [suites.data],
  );
  const selectedSuiteId = watchedSuiteId ?? builtInSuite?.id;
  const baselines = useQuery<BaselineSnapshot[]>({
    queryKey: ['baselines', selectedSuiteId],
    queryFn: () => api.baselines(selectedSuiteId),
    enabled: selectedMode === 'candidate_eval' && Boolean(selectedSuiteId),
  });

  const referenceChannels = useMemo(() => (channels.data ?? []).filter(isReferenceChannel), [channels.data]);
  const candidateChannels = useMemo(() => (channels.data ?? []).filter(isCandidateChannel), [channels.data]);
  const readyBaselines = useMemo(() => (baselines.data ?? []).filter((baseline) => baseline.status === 'ready'), [baselines.data]);
  const credentialChannels = useMemo(() => {
    const selectedIds =
      selectedMode === 'baseline_build'
        ? watchedReferenceChannelIds
        : selectedMode === 'performance_benchmark'
          ? watchedBenchmarkChannelIds
          : selectedMode === 'arena_comparison'
            ? watchedArenaChannelIds
            : watchedCandidateChannelIds;
    const channelById = new Map((channels.data ?? []).map((channel) => [channel.id, channel]));
    return selectedIds.map((id) => channelById.get(id)).filter((channel): channel is Channel => Boolean(channel));
  }, [channels.data, selectedMode, watchedArenaChannelIds, watchedBenchmarkChannelIds, watchedCandidateChannelIds, watchedReferenceChannelIds]);

  useEffect(() => {
    form.setFieldValue('mode', initialMode);
  }, [form, initialMode]);

  function selectMode(mode: CreateMode) {
    form.setFieldValue('mode', mode);
    const modeParam = mode === 'baseline_build' ? 'baseline' : mode === 'performance_benchmark' ? 'performance' : mode === 'arena_comparison' ? 'arena' : 'compare';
    setSearchParams({ mode: modeParam });
  }

  useEffect(() => {
    if (!builtInSuite?.id) return;
    if (form.getFieldValue('suite_id') !== builtInSuite.id) {
      form.setFieldValue('suite_id', builtInSuite.id);
    }
  }, [builtInSuite?.id, form]);

  useEffect(() => {
    if (!channels.data) return;
    const enabledChannels = channels.data.filter((channel) => channel.enabled);
    const fallbackReferences = enabledChannels.filter(isReferenceChannel);
    form.setFieldsValue({
      reference_channel_ids: fallbackReferences.map((channel) => channel.id),
      candidate_channel_ids: enabledChannels.filter(isCandidateChannel).map((channel) => channel.id),
      benchmark_channel_ids: enabledChannels.map((channel) => channel.id),
      arena_channel_ids: enabledChannels.filter(isCandidateChannel).map((channel) => channel.id),
    });
  }, [channels.data, form]);

  useEffect(() => {
    if (selectedMode !== 'candidate_eval') return;
    const current = form.getFieldValue('baseline_snapshot_id');
    if (!readyBaselines.length && current) {
      form.setFieldValue('baseline_snapshot_id', undefined);
      return;
    }
    if (readyBaselines.length && !readyBaselines.some((baseline) => baseline.id === current)) {
      form.setFieldValue('baseline_snapshot_id', readyBaselines[0].id);
    }
  }, [form, readyBaselines, selectedMode]);

  async function submit(values: CreateRunValues) {
    setLoading(true);
    try {
      const suiteId = values.suite_id ?? selectedSuiteId;
      if (!suiteId) {
        message.error('内置题库加载失败，请刷新后重试');
        return;
      }
      const mode = values.mode;
      const grouped: Record<string, string[]> = {
        reference: mode === 'baseline_build' ? values.reference_channel_ids ?? [] : [],
        candidate:
          mode === 'candidate_eval'
            ? values.candidate_channel_ids ?? []
            : mode === 'performance_benchmark'
              ? values.benchmark_channel_ids ?? []
              : mode === 'arena_comparison'
                ? values.arena_channel_ids ?? []
                : [],
      };
      const runtimeCredentials = buildRuntimeCredentials(credentialChannels, values.runtime_credentials);
      const payload = {
        name: values.name,
        suite_id: suiteId,
        channel_ids: grouped,
        repeat_count: 1,
        concurrency: mode === 'performance_benchmark' ? 4 : 1,
        test_scope: mode === 'performance_benchmark' || mode === 'arena_comparison' ? 'quick' : 'full',
        use_mock: false,
        runtime_credentials: runtimeCredentials,
        benchmark_config:
          mode === 'performance_benchmark'
            ? {
                concurrency_steps: parseConcurrencySteps(values.benchmark_concurrency_steps),
                duration_seconds: values.benchmark_duration_seconds ?? 0,
                warmup_requests: values.benchmark_warmup_requests ?? 0,
                target_qps: values.benchmark_target_qps ?? null,
                sla_p95_ms: values.benchmark_sla_p95_ms ?? null,
                max_error_rate: values.benchmark_max_error_rate ?? null,
              }
            : undefined,
      };
      const run =
        mode === 'baseline_build'
          ? await api.buildBaseline(payload)
          : mode === 'arena_comparison'
            ? await api.startArenaRun({
                name: values.name,
                suite_id: suiteId,
                candidate_channel_ids: values.arena_channel_ids ?? [],
                judge_channel_id: values.judge_channel_id || null,
                judge_mode: values.judge_mode || 'direct_score',
                judge_rubric: values.judge_rubric || null,
                repeat_count: 1,
                concurrency: 1,
                test_scope: 'quick',
                use_mock: false,
                runtime_credentials: runtimeCredentials,
              })
          : await api.startRun({
              ...payload,
              mode,
              baseline_snapshot_id: values.baseline_snapshot_id,
            });
      message.success(mode === 'baseline_build' ? '渠道指纹提取任务已创建' : mode === 'performance_benchmark' ? '性能诊断任务已创建' : mode === 'arena_comparison' ? 'Arena 排名任务已创建' : '真实性对比任务已创建');
      navigate(`/runs/${run.id}`);
    } catch (error) {
      message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <Card title={<span style={{ fontSize: '18px', fontWeight: 600 }}>新建任务</span>} bordered={false}>
        {suites.isError || channels.isError || (selectedMode === 'candidate_eval' && baselines.isError) ? (
          <Alert
            type="error"
            showIcon
            message="基础数据加载失败"
            description={getErrorMessage(suites.error ?? channels.error ?? baselines.error)}
            action={<Button onClick={() => Promise.all([suites.refetch(), channels.refetch(), baselines.refetch()])}>重试</Button>}
            style={{ marginBottom: 16 }}
          />
        ) : null}
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ mode: initialMode }}>
          <Form.Item name="mode" hidden>
            <Input />
          </Form.Item>
          <div className="task-mode-actions" aria-label="任务类型">
            <Button
              htmlType="button"
              size="large"
              type={selectedMode === 'baseline_build' ? 'primary' : 'default'}
              onClick={() => selectMode('baseline_build')}
            >
              提取渠道指纹
            </Button>
            <Button
              htmlType="button"
              size="large"
              type={selectedMode === 'candidate_eval' ? 'primary' : 'default'}
              onClick={() => selectMode('candidate_eval')}
            >
              真实性对比
            </Button>
            <Button
              htmlType="button"
              size="large"
              type={selectedMode === 'performance_benchmark' ? 'primary' : 'default'}
              onClick={() => selectMode('performance_benchmark')}
            >
              性能诊断
            </Button>
            <Button
              htmlType="button"
              size="large"
              type={selectedMode === 'arena_comparison' ? 'primary' : 'default'}
              onClick={() => selectMode('arena_comparison')}
            >
              Arena 排名
            </Button>
          </div>
          <Alert type="info" showIcon message={modeHelp[selectedMode]} style={{ marginBottom: 18 }} />
          <Form.Item label="任务名" name="name" rules={[{ required: true }]}>
            <Input
              size="large"
              placeholder={
                selectedMode === 'baseline_build'
                  ? 'Sonnet 4.5 渠道指纹提取'
                  : selectedMode === 'performance_benchmark'
                    ? 'Sonnet 4.5 渠道性能诊断'
                    : selectedMode === 'arena_comparison'
                      ? 'Sonnet 4.5 候选渠道 Arena 排名'
                      : 'Sonnet 4.5 渠道真实性对比'
              }
            />
          </Form.Item>
          {!suites.isLoading && !builtInSuite ? (
            <Alert
              type="error"
              showIcon
              message="内置题库不可用"
              description="没有加载到可用于检测的内置题库，请刷新后重试。"
              style={{ marginBottom: 16 }}
            />
          ) : null}
          {selectedMode === 'candidate_eval' ? (
            <Form.Item
              label="渠道指纹"
              name="baseline_snapshot_id"
              rules={[{ validator: (_, value) => (value ? Promise.resolve() : Promise.reject(new Error('请选择一个可用渠道指纹'))) }]}
            >
              <Select
                size="large"
                loading={baselines.isLoading}
                placeholder={selectedSuiteId ? '选择可用渠道指纹' : '请先选择测试集'}
                options={readyBaselines.map((baseline) => ({
                  value: baseline.id,
                  label: `${baseline.name} · ${baseline.ready_at ? formatDateTime(baseline.ready_at) : '未记录生成时间'}`,
                }))}
                notFoundContent={selectedSuiteId ? '当前测试集暂无可用渠道指纹，请先提取渠道指纹' : '请先选择测试集'}
              />
            </Form.Item>
          ) : null}
          {selectedMode === 'baseline_build' && referenceChannels.length === 0 ? (
            <Alert
              type="warning"
              showIcon
              message="还没有可用指纹源渠道"
              description="请先到渠道管理中新增渠道，并打开该渠道的“指纹源”开关。"
              action={<Button onClick={() => navigate('/channels')}>去渠道管理</Button>}
              style={{ marginBottom: 16 }}
            />
          ) : null}
          {selectedMode === 'baseline_build' ? (
            <Form.Item
              label="指纹源渠道"
              name="reference_channel_ids"
              rules={[{ validator: (_, value: string[] = []) => (value.length ? Promise.resolve() : Promise.reject(new Error('请选择至少一个指纹源渠道'))) }]}
            >
              <Checkbox.Group className="full-width">
                <div className="run-channel-picker">
                  {referenceChannels.map((channel) => (
                    <label key={channel.id} className={`run-channel-option ${channel.enabled ? '' : 'disabled'}`}>
                      <Checkbox value={channel.id} disabled={!channel.enabled} />
                      <span>
                        <strong>{channel.name}</strong>
                        <small>{channel.model_name || '未配置模型'}</small>
                      </span>
                      <Space wrap>
                        <Tag color="blue">提取指纹</Tag>
                      </Space>
                    </label>
                  ))}
                </div>
              </Checkbox.Group>
            </Form.Item>
          ) : null}
          {selectedMode === 'candidate_eval' ? (
            <Form.Item
              label="待测渠道"
              name="candidate_channel_ids"
              rules={[{ validator: (_, value: string[] = []) => (value.length ? Promise.resolve() : Promise.reject(new Error('请选择至少一个待测渠道'))) }]}
            >
            <Checkbox.Group className="full-width">
              <div className="run-channel-picker">
                {candidateChannels.map((channel) => (
                  <label key={channel.id} className={`run-channel-option ${channel.enabled ? '' : 'disabled'}`}>
                    <Checkbox value={channel.id} disabled={!channel.enabled} />
                    <span>
                      <strong>{channel.name}</strong>
                      <small>{channel.model_name || '未配置模型'}</small>
                    </span>
                  </label>
                ))}
                {candidateChannels.length === 0 ? (
                  <div className="run-channel-empty">
                    <Typography.Text type="secondary">暂无待测渠道，请先在渠道管理中新增候选渠道。</Typography.Text>
                  </div>
                ) : null}
              </div>
            </Checkbox.Group>
            </Form.Item>
          ) : null}
          {selectedMode === 'performance_benchmark' ? (
            <>
              <div className="benchmark-config-grid">
                <Form.Item label="并发阶梯" name="benchmark_concurrency_steps" initialValue="1,4,8">
                  <Input placeholder="1,4,8" />
                </Form.Item>
                <Form.Item label="持续时间(秒)" name="benchmark_duration_seconds" initialValue={0}>
                  <InputNumber min={0} max={3600} className="full-width" />
                </Form.Item>
                <Form.Item label="预热请求" name="benchmark_warmup_requests" initialValue={0}>
                  <InputNumber min={0} max={1000} className="full-width" />
                </Form.Item>
                <Form.Item label="目标 QPS" name="benchmark_target_qps">
                  <InputNumber min={0.1} className="full-width" />
                </Form.Item>
                <Form.Item label="P95 SLA(ms)" name="benchmark_sla_p95_ms">
                  <InputNumber min={1} className="full-width" />
                </Form.Item>
                <Form.Item label="最大错误率(%)" name="benchmark_max_error_rate">
                  <InputNumber min={0} max={100} className="full-width" />
                </Form.Item>
              </div>
              <Form.Item
                label="诊断渠道"
                name="benchmark_channel_ids"
                rules={[{ validator: (_, value: string[] = []) => (value.length ? Promise.resolve() : Promise.reject(new Error('请选择至少一个诊断渠道'))) }]}
              >
                <Checkbox.Group className="full-width">
                  <div className="run-channel-picker">
                    {(channels.data ?? []).map((channel) => (
                      <label key={channel.id} className={`run-channel-option ${channel.enabled ? '' : 'disabled'}`}>
                        <Checkbox value={channel.id} disabled={!channel.enabled} />
                        <span>
                          <strong>{channel.name}</strong>
                          <small>{channel.model_name || '未配置模型'}</small>
                        </span>
                        <Tag color="orange">TTFT / TPOT</Tag>
                      </label>
                    ))}
                  </div>
                </Checkbox.Group>
              </Form.Item>
            </>
          ) : null}
          {selectedMode === 'arena_comparison' ? (
            <>
              <div className="benchmark-config-grid">
                <Form.Item label="Judge 渠道" name="judge_channel_id">
                  <Select
                    allowClear
                    placeholder="可选，默认使用本地确定性评分"
                    options={referenceChannels.map((channel) => ({ value: channel.id, label: channel.name }))}
                  />
                </Form.Item>
                <Form.Item label="Judge 模式" name="judge_mode" initialValue="direct_score">
                  <Select
                    options={[
                      { value: 'direct_score', label: '直接评分' },
                      { value: 'reference_match', label: '参考答案一致性' },
                    ]}
                  />
                </Form.Item>
                <Form.Item label="Judge Rubric" name="judge_rubric">
                  <Input placeholder="可选，描述评分标准" />
                </Form.Item>
              </div>
              <Form.Item
                label="Arena 候选渠道"
                name="arena_channel_ids"
                rules={[{ validator: (_, value: string[] = []) => (value.length >= 2 ? Promise.resolve() : Promise.reject(new Error('请选择至少两个候选渠道'))) }]}
              >
                <Checkbox.Group className="full-width">
                  <div className="run-channel-picker">
                    {candidateChannels.map((channel) => (
                      <label key={channel.id} className={`run-channel-option ${channel.enabled ? '' : 'disabled'}`}>
                        <Checkbox value={channel.id} disabled={!channel.enabled} />
                        <span>
                          <strong>{channel.name}</strong>
                          <small>{channel.model_name || '未配置模型'}</small>
                        </span>
                        <Tag color="purple">Arena</Tag>
                      </label>
                    ))}
                    {candidateChannels.length < 2 ? (
                      <div className="run-channel-empty">
                        <Typography.Text type="secondary">Arena 排名至少需要两个候选渠道。</Typography.Text>
                      </div>
                    ) : null}
                  </div>
                </Checkbox.Group>
              </Form.Item>
            </>
          ) : null}
          {credentialChannels.length ? (
            <div className="runtime-credentials">
              <div className="credential-heading">
                <Typography.Text strong>运行时凭据</Typography.Text>
                <Typography.Text type="secondary">已配置渠道会自动使用渠道管理中的 API Key；未配置渠道需为本次任务补充。</Typography.Text>
              </div>
              {credentialChannels.map((channel) => (
                <div className="credential-row" key={channel.id}>
                  <div className="credential-channel">
                    <strong>{channel.name}</strong>
                    <small>{channel.model_name || '未配置模型'}</small>
                  </div>
                  {hasStoredApiKey(channel) ? (
                    <div className="credential-status">
                      <Tag color="green">已配置</Tag>
                      <Typography.Text type="secondary">使用渠道管理中的 API Key</Typography.Text>
                    </div>
                  ) : (
                    <Form.Item
                      label="API Key"
                      name={['runtime_credentials', channel.id, 'api_key']}
                      rules={[
                        {
                          validator: (_, value: string | undefined) =>
                            value?.trim() ? Promise.resolve() : Promise.reject(new Error('请输入该渠道的 API Key')),
                        },
                      ]}
                    >
                      <Input autoComplete="off" placeholder="sk-ant-..." />
                    </Form.Item>
                  )}
                </div>
              ))}
            </div>
          ) : null}
          <Button type="primary" size="large" htmlType="submit" loading={loading} style={{ height: '44px', fontWeight: 600 }}>
            {selectedMode === 'baseline_build' ? '提取渠道指纹' : selectedMode === 'performance_benchmark' ? '启动性能诊断' : selectedMode === 'arena_comparison' ? '启动 Arena 排名' : '启动真实性对比'}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
