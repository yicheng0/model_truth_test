import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Form, Input, InputNumber, Radio, Select, Space, Tag, Typography, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { fixedReferenceChannelIds, isCandidateChannel, isReferenceChannel } from '../channelPresets';
import { roleColor, roleLabel } from '../channelTaxonomy';
import type { BaselineSnapshot, Channel, RunMode, TestScope, TestSuite } from '../types';

type CreateRunValues = {
  name: string;
  suite_id: string;
  mode: RunMode;
  test_scope: TestScope;
  baseline_snapshot_id?: string;
  reference_channel_ids?: string[];
  candidate_channel_ids?: string[];
  repeat_count: number;
  concurrency: number;
  use_mock?: boolean;
};

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试';
}

export default function CreateRun() {
  const [form] = Form.useForm<CreateRunValues>();
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const selectedSuiteId = Form.useWatch('suite_id', form);
  const selectedMode = Form.useWatch('mode', form) ?? 'candidate_eval';
  const suites = useQuery<TestSuite[]>({ queryKey: ['suites'], queryFn: api.suites });
  const channels = useQuery<Channel[]>({ queryKey: ['channels'], queryFn: api.channels });
  const taxonomy = useQuery({ queryKey: ['channelTaxonomy'], queryFn: api.channelTaxonomy });
  const baselines = useQuery<BaselineSnapshot[]>({
    queryKey: ['baselines', selectedSuiteId],
    queryFn: () => api.baselines(selectedSuiteId),
    enabled: Boolean(selectedSuiteId),
  });

  const referenceChannels = useMemo(() => (channels.data ?? []).filter(isReferenceChannel), [channels.data]);
  const candidateChannels = useMemo(() => (channels.data ?? []).filter(isCandidateChannel), [channels.data]);
  const readyBaselines = useMemo(() => (baselines.data ?? []).filter((baseline) => baseline.status === 'ready'), [baselines.data]);

  useEffect(() => {
    if (!channels.data) return;
    const enabledChannels = channels.data.filter((channel) => channel.enabled);
    const fixedReferences = enabledChannels.filter((channel) => fixedReferenceChannelIds.has(channel.id));
    const fallbackReferences = enabledChannels.filter(isReferenceChannel);
    form.setFieldsValue({
      reference_channel_ids: (fixedReferences.length ? fixedReferences : fallbackReferences).map((channel) => channel.id),
      candidate_channel_ids: enabledChannels.filter(isCandidateChannel).map((channel) => channel.id),
    });
  }, [channels.data, form]);

  useEffect(() => {
    if (selectedMode !== 'candidate_eval') return;
    const current = form.getFieldValue('baseline_snapshot_id');
    if (readyBaselines.length && !readyBaselines.some((baseline) => baseline.id === current)) {
      form.setFieldValue('baseline_snapshot_id', readyBaselines[0].id);
    }
  }, [form, readyBaselines, selectedMode]);

  async function submit(values: CreateRunValues) {
    setLoading(true);
    try {
      const grouped: Record<string, string[]> = {};
      const selectedIds = new Set([
        ...(values.mode === 'candidate_eval' ? [] : values.reference_channel_ids ?? []),
        ...(values.mode === 'baseline_build' ? [] : values.candidate_channel_ids ?? []),
      ]);
      for (const channel of channels.data ?? []) {
        if (selectedIds.has(channel.id)) {
          grouped[channel.role] = [...(grouped[channel.role] ?? []), channel.id];
        }
      }
      const payload = {
        name: values.name,
        suite_id: values.suite_id,
        channel_ids: grouped,
        repeat_count: values.repeat_count,
        concurrency: values.concurrency,
        test_scope: values.test_scope,
        use_mock: values.use_mock ?? true,
      };
      const run =
        values.mode === 'baseline_build'
          ? await api.buildBaseline(payload)
          : await api.startRun({
              ...payload,
              mode: values.mode,
              baseline_snapshot_id: values.mode === 'candidate_eval' ? values.baseline_snapshot_id : undefined,
            });
      message.success(values.mode === 'baseline_build' ? '官方基线构建任务已创建' : '检测任务已创建');
      navigate(`/runs/${run.id}`);
    } catch (error) {
      message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <Card title={<span style={{ fontSize: '18px', fontWeight: 600 }}>创建检测任务</span>} bordered={false}>
        {suites.isError || channels.isError || baselines.isError ? (
          <Alert
            type="error"
            showIcon
            message="基础数据加载失败"
            description={getErrorMessage(suites.error ?? channels.error ?? baselines.error)}
            action={<Button onClick={() => Promise.all([suites.refetch(), channels.refetch(), baselines.refetch()])}>重试</Button>}
            style={{ marginBottom: 16 }}
          />
        ) : null}
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ mode: 'candidate_eval', test_scope: 'quick', repeat_count: 1, concurrency: 4, use_mock: true }}>
          <Form.Item label="任务名" name="name" rules={[{ required: true }]}>
            <Input size="large" placeholder="Sonnet 4.5 渠道真实性测试" />
          </Form.Item>
          <Form.Item label="运行模式" name="mode" rules={[{ required: true }]}>
            <Radio.Group size="large">
              <Radio.Button value="candidate_eval">复用官方基线</Radio.Button>
              <Radio.Button value="full_comparison">四路完整检测</Radio.Button>
              <Radio.Button value="baseline_build">生成官方基线</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item label="测试集" name="suite_id" rules={[{ required: true }]}>
            <Select
              size="large"
              loading={suites.isLoading}
              placeholder="选择测试集"
              options={(suites.data ?? []).map((suite) => ({ value: suite.id, label: `${suite.name} (${suite.version ?? '未标版'})` }))}
            />
          </Form.Item>
          <Form.Item label="检测范围" name="test_scope" rules={[{ required: true }]}>
            <Radio.Group size="large">
              <Radio.Button value="quick">快速检测</Radio.Button>
              <Radio.Button value="full">完整检测</Radio.Button>
            </Radio.Group>
          </Form.Item>
          {selectedMode === 'candidate_eval' ? (
            <Form.Item
              label="官方基线快照"
              name="baseline_snapshot_id"
              rules={[{ validator: (_, value) => (value ? Promise.resolve() : Promise.reject(new Error('请选择一个可用官方基线'))) }]}
            >
              <Select
                size="large"
                loading={baselines.isLoading}
                placeholder={selectedSuiteId ? '选择可复用官方基线' : '请先选择测试集'}
                options={readyBaselines.map((baseline) => ({
                  value: baseline.id,
                  label: `${baseline.name} · ${baseline.ready_at ? new Date(baseline.ready_at).toLocaleString() : '未记录生成时间'}`,
                }))}
                notFoundContent={selectedSuiteId ? '当前测试集暂无 ready 状态基线，请先生成官方基线' : '请先选择测试集'}
              />
            </Form.Item>
          ) : null}
          {selectedMode !== 'candidate_eval' && referenceChannels.length === 0 ? (
            <Alert
              type="warning"
              showIcon
              message="还没有可用对照渠道"
              description="请先到渠道管理中补齐 Anthropic Official、AWS Bedrock、Azure AI Foundry 等固定对照渠道。"
              action={<Button onClick={() => navigate('/channels')}>去渠道管理</Button>}
              style={{ marginBottom: 16 }}
            />
          ) : null}
          {selectedMode !== 'candidate_eval' ? (
            <Form.Item
              label="对照渠道"
              name="reference_channel_ids"
              rules={[{ validator: (_, value: string[] = []) => (value.length ? Promise.resolve() : Promise.reject(new Error('请选择至少一个对照渠道'))) }]}
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
                        {fixedReferenceChannelIds.has(channel.id) ? <Tag color="green">固定对照</Tag> : null}
                      <Tag color={roleColor[channel.role]}>{roleLabel(channel.role, taxonomy.data)}</Tag>
                      </Space>
                    </label>
                  ))}
                </div>
              </Checkbox.Group>
            </Form.Item>
          ) : null}
          {selectedMode !== 'baseline_build' ? (
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
                  <Tag color={roleColor[channel.role]}>{roleLabel(channel.role, taxonomy.data)}</Tag>
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
          <Space size="large" wrap style={{ marginBottom: '16px' }}>
            <Form.Item label="重复次数" name="repeat_count" style={{ marginBottom: 0 }}>
              <InputNumber size="large" min={1} max={5} style={{ width: '120px' }} />
            </Form.Item>
            <Form.Item label="并发度" name="concurrency" style={{ marginBottom: 0 }}>
              <InputNumber size="large" min={1} max={16} style={{ width: '120px' }} />
            </Form.Item>
            <Form.Item label="模拟执行" name="use_mock" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox style={{ marginTop: '32px' }}>使用内置 mock client</Checkbox>
            </Form.Item>
          </Space>
          <Typography.Paragraph type="secondary" style={{ marginBottom: '24px', fontSize: '14px' }}>
            快速检测只运行高区分度题，适合日常巡检；完整检测运行全部启用题，适合新渠道验收和正式报告。
          </Typography.Paragraph>
          <Button type="primary" size="large" htmlType="submit" loading={loading} style={{ height: '44px', fontWeight: 600 }}>
            启动检测
          </Button>
        </Form>
      </Card>
    </div>
  );
}
