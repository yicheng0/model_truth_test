import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Collapse, Form, Input, InputNumber, Segmented, Tag, Typography, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { buildRuntimeCredentials } from '../channelCredentials';
import type { Channel, TestSuite } from '../types';
import {
  ChannelMultiSelect,
  RuntimeCredentialsFields,
  atLeastOneChannelRule,
  getDefaultSuite,
  parseConcurrencySteps,
  selectedChannels,
  type RuntimeCredentialValues,
} from './createRunShared';

type CreatePerformanceValues = {
  name: string;
  suite_id: string;
  benchmark_preset?: PerformancePresetKey;
  benchmark_channel_ids?: string[];
  benchmark_concurrency_steps?: string;
  benchmark_duration_seconds?: number;
  benchmark_warmup_requests?: number;
  benchmark_target_qps?: number;
  benchmark_sla_p95_ms?: number;
  benchmark_max_error_rate?: number;
  runtime_credentials?: Record<string, RuntimeCredentialValues>;
};

type PerformancePresetKey = 'smoke' | 'standard' | 'stability' | 'sla';

type PerformancePreset = {
  key: PerformancePresetKey;
  label: string;
  description: string;
  values: Pick<
    CreatePerformanceValues,
    | 'benchmark_concurrency_steps'
    | 'benchmark_duration_seconds'
    | 'benchmark_warmup_requests'
    | 'benchmark_target_qps'
    | 'benchmark_sla_p95_ms'
    | 'benchmark_max_error_rate'
  >;
};

const performancePresets: PerformancePreset[] = [
  {
    key: 'smoke',
    label: '快速冒烟',
    description: '先确认渠道能稳定返回，适合新增渠道后第一次验证。',
    values: {
      benchmark_concurrency_steps: '1',
      benchmark_duration_seconds: 0,
      benchmark_warmup_requests: 0,
      benchmark_target_qps: undefined,
      benchmark_sla_p95_ms: undefined,
      benchmark_max_error_rate: undefined,
    },
  },
  {
    key: 'standard',
    label: '标准诊断',
    description: '覆盖低中高并发，适合日常横向对比多个渠道。',
    values: {
      benchmark_concurrency_steps: '1,4,8',
      benchmark_duration_seconds: 0,
      benchmark_warmup_requests: 1,
      benchmark_target_qps: undefined,
      benchmark_sla_p95_ms: undefined,
      benchmark_max_error_rate: undefined,
    },
  },
  {
    key: 'stability',
    label: '稳定性观察',
    description: '拉长观察窗口，适合看延迟波动、限流和偶发失败。',
    values: {
      benchmark_concurrency_steps: '2,4,8',
      benchmark_duration_seconds: 120,
      benchmark_warmup_requests: 2,
      benchmark_target_qps: undefined,
      benchmark_sla_p95_ms: undefined,
      benchmark_max_error_rate: undefined,
    },
  },
  {
    key: 'sla',
    label: 'SLA 验收',
    description: '带上验收阈值，适合检查 P95 和错误率是否达标。',
    values: {
      benchmark_concurrency_steps: '4,8,16',
      benchmark_duration_seconds: 120,
      benchmark_warmup_requests: 2,
      benchmark_target_qps: undefined,
      benchmark_sla_p95_ms: 5000,
      benchmark_max_error_rate: 5,
    },
  },
];

const performancePresetByKey = new Map(performancePresets.map((preset) => [preset.key, preset]));

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试';
}

export default function CreatePerformanceRun() {
  const [form] = Form.useForm<CreatePerformanceValues>();
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const watchedSuiteId = Form.useWatch('suite_id', form);
  const watchedBenchmarkChannelIds = Form.useWatch('benchmark_channel_ids', form) ?? [];
  const watchedBenchmarkPreset = Form.useWatch('benchmark_preset', form) ?? 'standard';
  const watchedConcurrencySteps = Form.useWatch('benchmark_concurrency_steps', form) ?? performancePresetByKey.get('standard')?.values.benchmark_concurrency_steps;
  const watchedWarmupRequests = Form.useWatch('benchmark_warmup_requests', form) ?? 0;
  const watchedSlaP95 = Form.useWatch('benchmark_sla_p95_ms', form);
  const watchedMaxErrorRate = Form.useWatch('benchmark_max_error_rate', form);
  const suites = useQuery<TestSuite[]>({ queryKey: ['suites'], queryFn: api.suites });
  const channels = useQuery<Channel[]>({ queryKey: ['channels'], queryFn: api.channels });
  const builtInSuite = useMemo(() => getDefaultSuite(suites.data), [suites.data]);
  const selectedSuiteId = watchedSuiteId ?? builtInSuite?.id;
  const enabledChannels = useMemo(() => (channels.data ?? []).filter((channel) => channel.enabled), [channels.data]);
  const credentialChannels = useMemo(
    () => selectedChannels(channels.data, watchedBenchmarkChannelIds),
    [channels.data, watchedBenchmarkChannelIds],
  );
  const concurrencySteps = parseConcurrencySteps(watchedConcurrencySteps);
  const maxConcurrency = Math.max(...concurrencySteps);

  function applyPreset(presetKey: PerformancePresetKey) {
    const preset = performancePresetByKey.get(presetKey);
    if (!preset) return;
    form.setFieldsValue({
      benchmark_preset: presetKey,
      ...preset.values,
    });
  }

  useEffect(() => {
    if (!builtInSuite?.id) return;
    if (form.getFieldValue('suite_id') !== builtInSuite.id) {
      form.setFieldValue('suite_id', builtInSuite.id);
    }
  }, [builtInSuite?.id, form]);

  useEffect(() => {
    if (!channels.data) return;
    form.setFieldValue('benchmark_channel_ids', enabledChannels.map((channel) => channel.id));
  }, [channels.data, enabledChannels, form]);

  async function submit(values: CreatePerformanceValues) {
    setLoading(true);
    try {
      const suiteId = values.suite_id ?? selectedSuiteId;
      if (!suiteId) {
        message.error('内置题库加载失败，请刷新后重试');
        return;
      }
      const runtimeCredentials = buildRuntimeCredentials(credentialChannels, values.runtime_credentials);
      const run = await api.startRun({
        name: values.name,
        suite_id: suiteId,
        mode: 'performance_benchmark',
        channel_ids: {
          reference: [],
          candidate: values.benchmark_channel_ids ?? [],
        },
        repeat_count: 1,
        concurrency: 4,
        test_scope: 'quick',
        use_mock: false,
        runtime_credentials: runtimeCredentials,
        benchmark_config: {
          concurrency_steps: parseConcurrencySteps(values.benchmark_concurrency_steps),
          duration_seconds: values.benchmark_duration_seconds ?? 0,
          warmup_requests: values.benchmark_warmup_requests ?? 0,
          target_qps: values.benchmark_target_qps ?? null,
          sla_p95_ms: values.benchmark_sla_p95_ms ?? null,
          max_error_rate: values.benchmark_max_error_rate ?? null,
        },
      });
      message.success('性能诊断任务已创建');
      navigate(`/runs/${run.id}`);
    } catch (error) {
      message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <Card title={<span style={{ fontSize: '18px', fontWeight: 600 }}>新建性能诊断</span>} bordered={false}>
        {suites.isError || channels.isError ? (
          <Alert
            type="error"
            showIcon
            message="基础数据加载失败"
            description={getErrorMessage(suites.error ?? channels.error)}
            action={<Button onClick={() => Promise.all([suites.refetch(), channels.refetch()])}>重试</Button>}
            style={{ marginBottom: 16 }}
          />
        ) : null}
        <Alert
          type="info"
          showIcon
          message="对一个或多个渠道分别做性能诊断，只看延迟、TTFT、TPOT、吞吐和失败率。"
          style={{ marginBottom: 18 }}
        />
        <div className="performance-explain-grid">
          <section className="performance-explain-panel">
            <Typography.Text className="section-kicker">WHAT IT MEASURES</Typography.Text>
            <Typography.Title level={4}>它看渠道响应是否又快又稳</Typography.Title>
            <Typography.Paragraph>
              性能诊断会记录 P95 延迟、首 token 时间、生成速度和失败率，适合回答“哪个渠道更适合线上承载请求”。
            </Typography.Paragraph>
          </section>
          <section className="performance-explain-panel">
            <Typography.Text className="section-kicker">WHAT IT IS NOT</Typography.Text>
            <Typography.Title level={4}>它不判断模型真实性和输出质量排名</Typography.Title>
            <Typography.Paragraph>
              真实性请使用“真实性对比”，候选渠道质量排序请使用“Arena 排名”。这里的结论只围绕性能和可用性。
            </Typography.Paragraph>
          </section>
        </div>
        <div className="performance-metric-guide">
          <div><strong>P95 延迟</strong><span>95% 请求能在这个时间内完成，越低越稳。</span></div>
          <div><strong>TTFT</strong><span>首 token 等待时间，越低代表开口越快。</span></div>
          <div><strong>TPOT</strong><span>每个输出 token 的平均生成耗时，越低代表生成更快。</span></div>
          <div><strong>失败率</strong><span>请求失败、超时或异常的占比，越低越可靠。</span></div>
        </div>
        <Form
          form={form}
          layout="vertical"
          onFinish={submit}
          initialValues={{ benchmark_preset: 'standard', ...performancePresetByKey.get('standard')?.values }}
        >
          <Form.Item label="任务名" name="name" rules={[{ required: true }]}>
            <Input size="large" placeholder="Sonnet 4.5 渠道性能诊断" />
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
          {!channels.isLoading && enabledChannels.length === 0 ? (
            <Alert
              type="warning"
              showIcon
              message="还没有可用诊断渠道"
              description="请先到渠道管理中新增渠道，并确认渠道处于启用状态。"
              action={<Button onClick={() => navigate('/channels')}>去渠道管理</Button>}
              style={{ marginBottom: 16 }}
            />
          ) : null}
          <Form.Item label="诊断预设" name="benchmark_preset">
            <Segmented
              block
              className="performance-preset-segmented"
              options={performancePresets.map((preset) => ({ value: preset.key, label: preset.label }))}
              onChange={(value) => applyPreset(value as PerformancePresetKey)}
            />
          </Form.Item>
          <div className="performance-preset-grid">
            {performancePresets.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={`performance-preset-card ${watchedBenchmarkPreset === preset.key ? 'active' : ''}`}
                onClick={() => applyPreset(preset.key)}
              >
                <strong>{preset.label}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>
          <Form.Item label="诊断渠道" name="benchmark_channel_ids" rules={[atLeastOneChannelRule('请选择至少一个诊断渠道')]}>
            <ChannelMultiSelect
              loading={channels.isLoading}
              channels={channels.data ?? []}
              placeholder="选择诊断渠道"
              tag={{ color: 'orange', label: 'TTFT / TPOT' }}
              showCredentialStatus
              notFoundContent="暂无渠道，请先在渠道管理中新增渠道。"
            />
          </Form.Item>
          <div className="performance-estimate-strip">
            <div><span>已选渠道</span><strong>{credentialChannels.length}</strong></div>
            <div><span>最大并发</span><strong>{maxConcurrency}</strong></div>
            <div><span>预热请求</span><strong>{watchedWarmupRequests}</strong></div>
            <div><span>SLA 阈值</span><strong>{watchedSlaP95 ? `${watchedSlaP95}ms` : watchedMaxErrorRate !== undefined && watchedMaxErrorRate !== null ? `${watchedMaxErrorRate}%` : '未启用'}</strong></div>
          </div>
          <Collapse
            className="performance-advanced"
            items={[
              {
                key: 'benchmark',
                label: '高级诊断参数',
                children: (
                  <>
                    <Alert
                      type="info"
                      showIcon
                      message="只有需要固定验收阈值或拉长观察时间时，才需要调整这些参数。"
                      style={{ marginBottom: 16 }}
                    />
                    <div className="benchmark-config-grid">
                      <Form.Item label="并发阶梯" name="benchmark_concurrency_steps">
                        <Input placeholder="1,4,8" />
                      </Form.Item>
                      <Form.Item label="持续时间(秒)" name="benchmark_duration_seconds">
                        <InputNumber min={0} max={3600} className="full-width" />
                      </Form.Item>
                      <Form.Item label="预热请求" name="benchmark_warmup_requests">
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
                    <div className="performance-threshold-note">
                      <Tag color="orange">P95 SLA 用于标记慢响应</Tag>
                      <Tag color="red">最大错误率用于标记可用性风险</Tag>
                    </div>
                  </>
                ),
              },
            ]}
          />
          <RuntimeCredentialsFields
            channels={credentialChannels}
            onlyMissing
            configuredMessage="已选择渠道均会使用渠道管理中保存的 API Key，无需重复填写。"
          />
          <Button type="primary" size="large" htmlType="submit" loading={loading} style={{ height: '44px', fontWeight: 600 }}>
            启动性能诊断
          </Button>
        </Form>
      </Card>
    </div>
  );
}
