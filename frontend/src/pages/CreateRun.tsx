import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, Select, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { isCandidateChannel, isReferenceChannel } from '../channelPresets';
import { buildRuntimeCredentials } from '../channelCredentials';
import { channelsForGroup, selectedOutsideGroupCount } from '../channelGroups';
import type { Channel, RunCreate, TestScope, TestSuite } from '../types';
import {
  ChannelMultiSelect,
  RuntimeCredentialsFields,
  atLeastOneChannelRule,
  getDefaultSuite,
  selectedChannels,
  type RuntimeCredentialValues,
} from './createRunShared';

type CreateRunValues = {
  name: string;
  suite_id: string;
  test_scope?: TestScope;
  repeat_count?: 3 | 5;
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
  const watchedSuiteId = Form.useWatch('suite_id', form);
  const watchedReferenceChannelIds = Form.useWatch('reference_channel_ids', form) ?? [];
  const watchedCandidateChannelIds = Form.useWatch('candidate_channel_ids', form) ?? [];
  const watchedTestScope = Form.useWatch('test_scope', form) ?? 'full';
  const suites = useQuery<TestSuite[]>({ queryKey: ['suites'], queryFn: api.suites });
  const channels = useQuery<Channel[]>({ queryKey: ['channels'], queryFn: api.channels });
  const channelGroups = useQuery({ queryKey: ['channelGroups'], queryFn: api.channelGroups });
  const builtInSuite = useMemo(() => getDefaultSuite(suites.data), [suites.data]);
  const selectedSuiteId = watchedSuiteId ?? builtInSuite?.id;
  const [channelGroupFilter, setChannelGroupFilter] = useState<string | undefined>();

  const referenceChannels = useMemo(() => (channels.data ?? []).filter(isReferenceChannel), [channels.data]);
  const candidateChannels = useMemo(() => (channels.data ?? []).filter(isCandidateChannel), [channels.data]);
  const visibleReferenceChannels = useMemo(() => channelsForGroup(referenceChannels, channelGroupFilter), [referenceChannels, channelGroupFilter]);
  const visibleCandidateChannels = useMemo(() => channelsForGroup(candidateChannels, channelGroupFilter), [candidateChannels, channelGroupFilter]);
  const selectedIds = useMemo(
    () => [...new Set([...watchedReferenceChannelIds, ...watchedCandidateChannelIds])],
    [watchedCandidateChannelIds, watchedReferenceChannelIds],
  );
  const selectedOutsideGroup = selectedOutsideGroupCount(channels.data ?? [], selectedIds, channelGroupFilter);
  const credentialChannels = useMemo(() => selectedChannels(channels.data, selectedIds), [channels.data, selectedIds]);

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

  async function submit(values: CreateRunValues) {
    setLoading(true);
    try {
      const suiteId = values.suite_id ?? selectedSuiteId;
      if (!suiteId) {
        message.error('内置题库加载失败，请刷新后重试');
        return;
      }
      const grouped: Record<string, string[]> = {
        reference: values.reference_channel_ids ?? [],
        candidate: values.candidate_channel_ids ?? [],
      };
      const runtimeCredentials = buildRuntimeCredentials(credentialChannels, values.runtime_credentials);
      const payload = {
        name: values.name,
        suite_id: suiteId,
        channel_ids: grouped,
        repeat_count: values.test_scope === 'detection_points' ? (values.repeat_count ?? 3) : 1,
        concurrency: 1,
        test_scope: (values.test_scope ?? 'full') as TestScope,
        use_mock: false,
        runtime_credentials: runtimeCredentials,
        mode: 'full_comparison',
      } satisfies RunCreate;
      const run = await api.startRun(payload);
      message.success('真实性对比任务已创建');
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
        <Form form={form} layout="vertical" onFinish={submit}>
          <Alert type="info" showIcon message="参考渠道与待测渠道会在同一次任务中执行，并生成协议、能力、相似度和风险证据链。检测点模式重点观察 Fable 5 行为、Kiro/Bedrock、Claude Code 入口和官方来源证据。" style={{ marginBottom: 18 }} />
          <Form.Item label="任务名" name="name" rules={[{ required: true }]}>
            <Input
              size="large"
              placeholder="Sonnet 渠道真实性对比"
            />
          </Form.Item>
          <Form.Item label="检测模式" name="test_scope" initialValue="full">
            <Select
              size="large"
              options={[
                { value: 'full', label: '完整检测（历史综合评分）' },
                { value: 'detection_points', label: '检测点模式（Fable 5 / Kiro / Claude Code / 官方来源）' },
              ]}
            />
          </Form.Item>
          {watchedTestScope === 'detection_points' ? (
            <Form.Item label="每题重复次数" name="repeat_count" initialValue={3} extra="检测点模式只允许 3 或 5 次；单轮干净不代表没有偶发换模。">
              <Select size="large" options={[{ value: 3, label: '3 次（快速筛查）' }, { value: 5, label: '5 次（更稳健）' }]} />
            </Form.Item>
          ) : null}
          {!suites.isLoading && !builtInSuite ? (
            <Alert
              type="error"
              showIcon
              message="内置题库不可用"
              description="没有加载到可用于检测的内置题库，请刷新后重试。"
              style={{ marginBottom: 16 }}
            />
          ) : null}
          {referenceChannels.length === 0 ? (
            <Alert
              type="warning"
              showIcon
              message="还没有可用参考渠道"
              description="请先到渠道管理中新增渠道，并将其设置为参考渠道。"
              action={<Button onClick={() => navigate('/channels')}>去渠道管理</Button>}
              style={{ marginBottom: 16 }}
            />
          ) : null}
          <Form.Item label="渠道分组筛选" extra={selectedOutsideGroup ? `已选渠道中有 ${selectedOutsideGroup} 个不在当前筛选内，提交时仍会保留。` : '只过滤候选项，不会清空已经选择的渠道。'}>
            <Select
              allowClear
              size="large"
              loading={channelGroups.isLoading}
              value={channelGroupFilter}
              onChange={setChannelGroupFilter}
              placeholder="全部分组"
              options={(channelGroups.data ?? []).filter((group) => group.enabled).map((group) => ({ value: group.id, label: `${group.name} (${group.channel_count})` }))}
            />
          </Form.Item>
          <Form.Item label="参考渠道" name="reference_channel_ids" rules={[atLeastOneChannelRule('请选择至少一个参考渠道')]}>
            <ChannelMultiSelect
              loading={channels.isLoading}
              channels={visibleReferenceChannels}
              placeholder="选择参考渠道"
              tag={{ color: 'blue', label: '参考' }}
              showCredentialStatus
            />
          </Form.Item>
          <Form.Item label="待测渠道" name="candidate_channel_ids" rules={[atLeastOneChannelRule('请选择至少一个待测渠道')]}>
            <ChannelMultiSelect
              loading={channels.isLoading}
              channels={visibleCandidateChannels}
              placeholder="选择待测渠道"
              showCredentialStatus
              notFoundContent="暂无待测渠道，请先在渠道管理中新增候选渠道。"
            />
          </Form.Item>
          <RuntimeCredentialsFields
            channels={credentialChannels}
            onlyMissing
            configuredMessage="已选择渠道均会使用渠道管理中保存的 API Key，无需重复填写。"
          />
          <Button type="primary" size="large" htmlType="submit" loading={loading} style={{ height: '44px', fontWeight: 600 }}>
            启动真实性对比
          </Button>
        </Form>
      </Card>
    </div>
  );
}
