import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, InputNumber, message } from 'antd';
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
  benchmark_channel_ids?: string[];
  benchmark_concurrency_steps?: string;
  benchmark_duration_seconds?: number;
  benchmark_warmup_requests?: number;
  benchmark_target_qps?: number;
  benchmark_sla_p95_ms?: number;
  benchmark_max_error_rate?: number;
  runtime_credentials?: Record<string, RuntimeCredentialValues>;
};

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
  const suites = useQuery<TestSuite[]>({ queryKey: ['suites'], queryFn: api.suites });
  const channels = useQuery<Channel[]>({ queryKey: ['channels'], queryFn: api.channels });
  const builtInSuite = useMemo(() => getDefaultSuite(suites.data), [suites.data]);
  const selectedSuiteId = watchedSuiteId ?? builtInSuite?.id;
  const enabledChannels = useMemo(() => (channels.data ?? []).filter((channel) => channel.enabled), [channels.data]);
  const credentialChannels = useMemo(
    () => selectedChannels(channels.data, watchedBenchmarkChannelIds),
    [channels.data, watchedBenchmarkChannelIds],
  );

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
        <Form
          form={form}
          layout="vertical"
          onFinish={submit}
          initialValues={{ benchmark_concurrency_steps: '1,4,8', benchmark_duration_seconds: 0, benchmark_warmup_requests: 0 }}
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
          <Form.Item label="诊断渠道" name="benchmark_channel_ids" rules={[atLeastOneChannelRule('请选择至少一个诊断渠道')]}>
            <ChannelMultiSelect
              loading={channels.isLoading}
              channels={channels.data ?? []}
              placeholder="选择诊断渠道"
              tag={{ color: 'orange', label: 'TTFT / TPOT' }}
              notFoundContent="暂无渠道，请先在渠道管理中新增渠道。"
            />
          </Form.Item>
          <RuntimeCredentialsFields channels={credentialChannels} />
          <Button type="primary" size="large" htmlType="submit" loading={loading} style={{ height: '44px', fontWeight: 600 }}>
            启动性能诊断
          </Button>
        </Form>
      </Card>
    </div>
  );
}
