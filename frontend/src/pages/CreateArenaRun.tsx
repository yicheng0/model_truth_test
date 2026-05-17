import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, Tag, Typography, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { isCandidateChannel } from '../channelPresets';
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
  runtime_credentials?: Record<string, RuntimeCredentialValues>;
};

const defaultArenaRubric = 'Score answer quality, instruction following, safety, protocol stability, and useful completeness.';

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
  const cases = useQuery({ queryKey: ['cases', selectedSuiteId], queryFn: () => api.cases(selectedSuiteId), enabled: Boolean(selectedSuiteId) });
  const candidateChannels = useMemo(() => (channels.data ?? []).filter(isCandidateChannel), [channels.data]);
  const credentialChannels = useMemo(() => selectedChannels(channels.data, watchedArenaChannelIds), [channels.data, watchedArenaChannelIds]);
  const selectedArenaChannels = useMemo(
    () => selectedChannels(channels.data, watchedArenaChannelIds),
    [channels.data, watchedArenaChannelIds],
  );
  const estimatedPairCount = selectedArenaChannels.length > 1 ? (selectedArenaChannels.length * (selectedArenaChannels.length - 1)) / 2 : 0;
  const estimatedCasePairs = estimatedPairCount * (cases.data?.length ?? 0);

  useEffect(() => {
    if (!builtInSuite?.id) return;
    if (form.getFieldValue('suite_id') !== builtInSuite.id) {
      form.setFieldValue('suite_id', builtInSuite.id);
    }
  }, [builtInSuite?.id, form]);

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
        judge_channel_id: null,
        judge_mode: 'direct_score',
        judge_rubric: defaultArenaRubric,
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
        <div className="arena-explain-grid">
          <section className="arena-explain-panel">
            <Typography.Text className="section-kicker">WHAT IT DOES</Typography.Text>
            <Typography.Title level={4}>它是在候选渠道之间排相对名次</Typography.Title>
            <Typography.Paragraph>
              Arena 会让每个候选渠道回答同一批题，然后按样本分做两两比较，输出胜率、平均题目分和关键分歧样本。它适合回答“这些候选渠道谁的输出质量更稳”。
            </Typography.Paragraph>
          </section>
          <section className="arena-explain-panel">
            <Typography.Text className="section-kicker">WHAT IT IS NOT</Typography.Text>
            <Typography.Title level={4}>它不是官方真实性判断</Typography.Title>
            <Typography.Paragraph>
              Arena 不引用渠道指纹，也不证明某个渠道等同官方模型。需要判断“像不像官方 Claude”时，仍使用“真实性对比”任务。
            </Typography.Paragraph>
          </section>
        </div>
        <div className="arena-formula-panel">
          <strong>Arena 总分 = 胜率 * 55% + 平均题目分 * 45%</strong>
          <span>胜率表示该渠道在同题两两比较中赢过其他候选渠道的比例；平均题目分表示该渠道自身答案质量、规则匹配和性能惩罚后的平均分。</span>
        </div>
        <div className="arena-basis-panel">
          <Typography.Text className="section-kicker">BASIS</Typography.Text>
          <Typography.Title level={4}>这个排名依据什么</Typography.Title>
          <div className="arena-basis-grid">
            <div><strong>同一套题库</strong><span>所有候选渠道回答同一批测试题，避免题目不同造成排名偏差。</span></div>
            <div><strong>真实响应结果</strong><span>使用每个渠道实际返回的内容、错误标签和延迟指标。</span></div>
            <div><strong>样本分</strong><span>基础结果分 * 0.85，加有效文本补偿，慢响应会扣分，再乘题目权重。</span></div>
            <div><strong>同题两两比较</strong><span>每道题里候选渠道互相比样本分，赢得胜场，最终形成胜率。</span></div>
          </div>
        </div>
        <Form form={form} layout="vertical" onFinish={submit}>
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
          <Form.Item label="Arena 候选渠道" name="arena_channel_ids" rules={[atLeastTwoChannelsRule('请选择至少两个候选渠道')]}>
            <ChannelMultiSelect
              loading={channels.isLoading}
              channels={candidateChannels}
              placeholder="选择 Arena 候选渠道"
              tag={{ color: 'purple', label: 'Arena' }}
              showCredentialStatus
              notFoundContent="Arena 排名至少需要两个候选渠道。"
            />
          </Form.Item>
          <div className="arena-estimate-strip">
            <div><span>候选渠道</span><strong>{selectedArenaChannels.length}</strong></div>
            <div><span>题目数</span><strong>{cases.data?.length ?? '-'}</strong></div>
            <div><span>两两组合</span><strong>{estimatedPairCount}</strong></div>
            <div><span>预计样本对比</span><strong>{cases.isLoading ? '-' : estimatedCasePairs}</strong></div>
          </div>
          <Alert
            type="info"
            showIcon
            message="评分方式已自动设置"
            description="本次 Arena 会使用系统本地自动评分，不需要额外选择评审渠道或评分模式。结果页会展示排名、胜负矩阵和关键分歧样本。"
            style={{ marginTop: 16, marginBottom: 16 }}
          />
          <div className="arena-next-steps">
            <Tag color="purple">结果页会展示排名、胜负矩阵和关键分歧样本</Tag>
            <Tag color="blue">单渠道报告会解释该渠道为什么赢或输</Tag>
          </div>
          <RuntimeCredentialsFields
            channels={credentialChannels}
            onlyMissing
            configuredMessage="已使用渠道管理中的 API Key，当前任务无需额外填写渠道凭据。"
          />
          <Button type="primary" size="large" htmlType="submit" loading={loading} style={{ height: '44px', fontWeight: 600 }}>
            启动 Arena 排名
          </Button>
        </Form>
      </Card>
    </div>
  );
}
