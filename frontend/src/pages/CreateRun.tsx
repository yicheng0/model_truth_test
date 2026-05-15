import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, Select, message } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { isCandidateChannel, isReferenceChannel } from '../channelPresets';
import { buildRuntimeCredentials } from '../channelCredentials';
import { formatDateTime } from '../time';
import type { BaselineSnapshot, Channel, TestSuite } from '../types';
import {
  ChannelMultiSelect,
  RuntimeCredentialsFields,
  atLeastOneChannelRule,
  getDefaultSuite,
  selectedChannels,
  type RuntimeCredentialValues,
} from './createRunShared';

type CreateMode = 'baseline_build' | 'candidate_eval';

const modeHelp: Record<CreateMode, string> = {
  baseline_build: '采集官方或参考渠道输出，生成后续真实性对比可复用的渠道指纹。',
  candidate_eval: '候选渠道对比渠道指纹，输出协议、能力、相似度和风险证据链。',
};

type CreateRunValues = {
  name: string;
  suite_id: string;
  mode: CreateMode;
  baseline_snapshot_id?: string;
  reference_channel_ids?: string[];
  candidate_channel_ids?: string[];
  runtime_credentials?: Record<string, RuntimeCredentialValues>;
};

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试';
}

export default function CreateRun() {
  const [form] = Form.useForm<CreateRunValues>();
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryMode = searchParams.get('mode');
  const initialMode: CreateMode = queryMode === 'baseline' ? 'baseline_build' : 'candidate_eval';
  const selectedMode = Form.useWatch('mode', form) ?? initialMode;
  const watchedSuiteId = Form.useWatch('suite_id', form);
  const watchedReferenceChannelIds = Form.useWatch('reference_channel_ids', form) ?? [];
  const watchedCandidateChannelIds = Form.useWatch('candidate_channel_ids', form) ?? [];
  const suites = useQuery<TestSuite[]>({ queryKey: ['suites'], queryFn: api.suites });
  const channels = useQuery<Channel[]>({ queryKey: ['channels'], queryFn: api.channels });
  const builtInSuite = useMemo(() => getDefaultSuite(suites.data), [suites.data]);
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
    const selectedIds = selectedMode === 'baseline_build' ? watchedReferenceChannelIds : watchedCandidateChannelIds;
    return selectedChannels(channels.data, selectedIds);
  }, [channels.data, selectedMode, watchedCandidateChannelIds, watchedReferenceChannelIds]);

  useEffect(() => {
    form.setFieldValue('mode', initialMode);
  }, [form, initialMode]);

  function selectMode(mode: CreateMode) {
    form.setFieldValue('mode', mode);
    setSearchParams({ mode: mode === 'baseline_build' ? 'baseline' : 'compare' });
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
      const runtimeCredentials = buildRuntimeCredentials(credentialChannels, values.runtime_credentials);
      const payload = {
        name: values.name,
        suite_id: suiteId,
        channel_ids: grouped,
        repeat_count: 1,
        concurrency: 1,
        test_scope: 'full',
        use_mock: false,
        runtime_credentials: runtimeCredentials,
      };
      const run =
        mode === 'baseline_build'
          ? await api.buildBaseline(payload)
          : await api.startRun({
              ...payload,
              mode,
              baseline_snapshot_id: values.baseline_snapshot_id,
            });
      message.success(mode === 'baseline_build' ? '渠道指纹提取任务已创建' : '真实性对比任务已创建');
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
          </div>
          <Alert type="info" showIcon message={modeHelp[selectedMode]} style={{ marginBottom: 18 }} />
          <Form.Item label="任务名" name="name" rules={[{ required: true }]}>
            <Input
              size="large"
              placeholder={selectedMode === 'baseline_build' ? 'Sonnet 4.5 渠道指纹提取' : 'Sonnet 4.5 渠道真实性对比'}
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
            <Form.Item label="指纹源渠道" name="reference_channel_ids" rules={[atLeastOneChannelRule('请选择至少一个指纹源渠道')]}>
              <ChannelMultiSelect
                loading={channels.isLoading}
                channels={referenceChannels}
                placeholder="选择指纹源渠道"
                tag={{ color: 'blue', label: '提取指纹' }}
              />
            </Form.Item>
          ) : null}
          {selectedMode === 'candidate_eval' ? (
            <Form.Item label="待测渠道" name="candidate_channel_ids" rules={[atLeastOneChannelRule('请选择至少一个待测渠道')]}>
              <ChannelMultiSelect
                loading={channels.isLoading}
                channels={candidateChannels}
                placeholder="选择待测渠道"
                notFoundContent="暂无待测渠道，请先在渠道管理中新增候选渠道。"
              />
            </Form.Item>
          ) : null}
          <RuntimeCredentialsFields channels={credentialChannels} />
          <Button type="primary" size="large" htmlType="submit" loading={loading} style={{ height: '44px', fontWeight: 600 }}>
            {selectedMode === 'baseline_build' ? '提取渠道指纹' : '启动真实性对比'}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
