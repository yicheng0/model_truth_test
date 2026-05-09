import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Form, Input, Radio, Select, Space, Tag, Typography, message } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { isCandidateChannel, isReferenceChannel } from '../channelPresets';
import { roleColor, roleLabel } from '../channelTaxonomy';
import type { BaselineSnapshot, Channel, TestSuite } from '../types';

type CreateMode = 'baseline_build' | 'candidate_eval';
const DEFAULT_SUITE_ID = 'claude_full_35';

type CreateRunValues = {
  name: string;
  suite_id: string;
  mode: CreateMode;
  baseline_snapshot_id?: string;
  reference_channel_ids?: string[];
  candidate_channel_ids?: string[];
};

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试';
}

export default function CreateRun() {
  const [form] = Form.useForm<CreateRunValues>();
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialMode: CreateMode = searchParams.get('mode') === 'baseline' ? 'baseline_build' : 'candidate_eval';
  const selectedMode = Form.useWatch('mode', form) ?? initialMode;
  const watchedSuiteId = Form.useWatch('suite_id', form);
  const suites = useQuery<TestSuite[]>({ queryKey: ['suites'], queryFn: api.suites });
  const channels = useQuery<Channel[]>({ queryKey: ['channels'], queryFn: api.channels });
  const taxonomy = useQuery({ queryKey: ['channelTaxonomy'], queryFn: api.channelTaxonomy });
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

  useEffect(() => {
    form.setFieldValue('mode', initialMode);
  }, [form, initialMode]);

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
        candidate: mode === 'candidate_eval' ? values.candidate_channel_ids ?? [] : [],
      };
      const payload = {
        name: values.name,
        suite_id: suiteId,
        channel_ids: grouped,
        repeat_count: 1,
        concurrency: 1,
        test_scope: 'quick',
        use_mock: false,
      };
      const run =
        mode === 'baseline_build'
          ? await api.buildBaseline(payload)
          : await api.startRun({
              ...payload,
              mode,
              baseline_snapshot_id: values.baseline_snapshot_id,
            });
      message.success(mode === 'baseline_build' ? '对照样本采样任务已创建' : '对比测试任务已创建');
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
          <Form.Item label="任务名" name="name" rules={[{ required: true }]}>
            <Input size="large" placeholder={selectedMode === 'baseline_build' ? 'Sonnet 4.5 对照样本采样' : 'Sonnet 4.5 渠道对比测试'} />
          </Form.Item>
          <Form.Item label="运行模式" name="mode" rules={[{ required: true }]}>
            <Radio.Group size="large">
              <Radio.Button value="baseline_build">创建对照样本</Radio.Button>
              <Radio.Button value="candidate_eval">对比测试</Radio.Button>
            </Radio.Group>
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
              label="对照样本"
              name="baseline_snapshot_id"
              rules={[{ validator: (_, value) => (value ? Promise.resolve() : Promise.reject(new Error('请选择一个可用对照样本'))) }]}
            >
              <Select
                size="large"
                loading={baselines.isLoading}
                placeholder={selectedSuiteId ? '选择可用对照样本' : '请先选择测试集'}
                options={readyBaselines.map((baseline) => ({
                  value: baseline.id,
                  label: `${baseline.name} · ${baseline.ready_at ? new Date(baseline.ready_at).toLocaleString() : '未记录生成时间'}`,
                }))}
                notFoundContent={selectedSuiteId ? '当前测试集暂无可用对照样本' : '请先选择测试集'}
              />
            </Form.Item>
          ) : null}
          {selectedMode === 'baseline_build' && referenceChannels.length === 0 ? (
            <Alert
              type="warning"
              showIcon
              message="还没有可用对照渠道"
              description="请先到渠道管理中新增渠道，并打开该渠道的“对照渠道”开关。"
              action={<Button onClick={() => navigate('/channels')}>去渠道管理</Button>}
              style={{ marginBottom: 16 }}
            />
          ) : null}
          {selectedMode === 'baseline_build' ? (
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
                        <Tag color="blue">对照</Tag>
                        <Tag color={roleColor[channel.role]}>{roleLabel(channel.role, taxonomy.data)}</Tag>
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
          <Button type="primary" size="large" htmlType="submit" loading={loading} style={{ height: '44px', fontWeight: 600 }}>
            {selectedMode === 'baseline_build' ? '创建对照样本' : '启动对比测试'}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
