import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, Select, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { isCandidateChannel, isReferenceChannel } from '../channelPresets';
import { buildRuntimeCredentials } from '../channelCredentials';
import type { Channel, TestSuite } from '../types';
import {
  ChannelMultiSelect,
  RuntimeCredentialsFields,
  atLeastTwoChannelsRule,
  getDefaultSuite,
  selectedChannels,
  type RuntimeCredentialValues,
} from './createRunShared';

type CreateArenaValues = {
  name: string;
  suite_id: string;
  arena_channel_ids?: string[];
  judge_channel_id?: string;
  judge_mode?: string;
  judge_rubric?: string;
  runtime_credentials?: Record<string, RuntimeCredentialValues>;
};

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试';
}

export default function CreateArenaRun() {
  const [form] = Form.useForm<CreateArenaValues>();
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const watchedSuiteId = Form.useWatch('suite_id', form);
  const watchedArenaChannelIds = Form.useWatch('arena_channel_ids', form) ?? [];
  const suites = useQuery<TestSuite[]>({ queryKey: ['suites'], queryFn: api.suites });
  const channels = useQuery<Channel[]>({ queryKey: ['channels'], queryFn: api.channels });
  const builtInSuite = useMemo(() => getDefaultSuite(suites.data), [suites.data]);
  const selectedSuiteId = watchedSuiteId ?? builtInSuite?.id;
  const referenceChannels = useMemo(() => (channels.data ?? []).filter(isReferenceChannel), [channels.data]);
  const candidateChannels = useMemo(() => (channels.data ?? []).filter(isCandidateChannel), [channels.data]);
  const credentialChannels = useMemo(() => selectedChannels(channels.data, watchedArenaChannelIds), [channels.data, watchedArenaChannelIds]);

  useEffect(() => {
    if (!builtInSuite?.id) return;
    if (form.getFieldValue('suite_id') !== builtInSuite.id) {
      form.setFieldValue('suite_id', builtInSuite.id);
    }
  }, [builtInSuite?.id, form]);

  useEffect(() => {
    if (!channels.data) return;
    const enabledCandidates = channels.data.filter((channel) => channel.enabled && isCandidateChannel(channel));
    form.setFieldValue('arena_channel_ids', enabledCandidates.map((channel) => channel.id));
  }, [channels.data, form]);

  async function submit(values: CreateArenaValues) {
    setLoading(true);
    try {
      const suiteId = values.suite_id ?? selectedSuiteId;
      if (!suiteId) {
        message.error('内置题库加载失败，请刷新后重试');
        return;
      }
      const runtimeCredentials = buildRuntimeCredentials(credentialChannels, values.runtime_credentials);
      const run = await api.startArenaRun({
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
      });
      message.success('Arena 排名任务已创建');
      navigate(`/runs/${run.id}`);
    } catch (error) {
      message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <Card title={<span style={{ fontSize: '18px', fontWeight: 600 }}>新建 Arena 排名</span>} bordered={false}>
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
          message="候选渠道之间做横向排名和样本分歧分析，不作为官方真实性判断。"
          style={{ marginBottom: 18 }}
        />
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ judge_mode: 'direct_score' }}>
          <Form.Item label="任务名" name="name" rules={[{ required: true }]}>
            <Input size="large" placeholder="Sonnet 4.5 候选渠道 Arena 排名" />
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
          {!channels.isLoading && candidateChannels.length < 2 ? (
            <Alert
              type="warning"
              showIcon
              message="Arena 排名至少需要两个候选渠道"
              description="请先到渠道管理中新增候选渠道，并确认渠道处于启用状态。"
              action={<Button onClick={() => navigate('/channels')}>去渠道管理</Button>}
              style={{ marginBottom: 16 }}
            />
          ) : null}
          <div className="benchmark-config-grid">
            <Form.Item label="Judge 渠道" name="judge_channel_id">
              <Select
                allowClear
                showSearch
                placeholder="可选，默认使用本地确定性评分"
                optionFilterProp="label"
                options={referenceChannels.map((channel) => ({ value: channel.id, label: channel.name, disabled: !channel.enabled }))}
              />
            </Form.Item>
            <Form.Item label="Judge 模式" name="judge_mode">
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
          <Form.Item label="Arena 候选渠道" name="arena_channel_ids" rules={[atLeastTwoChannelsRule('请选择至少两个候选渠道')]}>
            <ChannelMultiSelect
              loading={channels.isLoading}
              channels={candidateChannels}
              placeholder="选择 Arena 候选渠道"
              tag={{ color: 'purple', label: 'Arena' }}
              notFoundContent="Arena 排名至少需要两个候选渠道。"
            />
          </Form.Item>
          <RuntimeCredentialsFields channels={credentialChannels} />
          <Button type="primary" size="large" htmlType="submit" loading={loading} style={{ height: '44px', fontWeight: 600 }}>
            启动 Arena 排名
          </Button>
        </Form>
      </Card>
    </div>
  );
}
