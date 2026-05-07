import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Form, Input, InputNumber, Select, Space, Tag, Typography, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { fixedReferenceChannelIds, isCandidateChannel, isReferenceChannel } from '../channelPresets';
import type { Channel, ChannelRole, TestSuite } from '../types';

type CreateRunValues = {
  name: string;
  suite_id: string;
  reference_channel_ids?: string[];
  candidate_channel_ids?: string[];
  repeat_count: number;
  concurrency: number;
  use_mock?: boolean;
};

const roleLabel: Record<ChannelRole, string> = {
  gold: '金标',
  official_cloud: '官方云参考',
  candidate: '待测',
  negative: '负样本',
};

const roleColor: Record<ChannelRole, string> = {
  gold: 'gold',
  official_cloud: 'blue',
  candidate: 'purple',
  negative: 'red',
};

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试';
}

export default function CreateRun() {
  const [form] = Form.useForm<CreateRunValues>();
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const suites = useQuery<TestSuite[]>({ queryKey: ['suites'], queryFn: api.suites });
  const channels = useQuery<Channel[]>({ queryKey: ['channels'], queryFn: api.channels });

  const referenceChannels = useMemo(() => (channels.data ?? []).filter(isReferenceChannel), [channels.data]);
  const candidateChannels = useMemo(() => (channels.data ?? []).filter(isCandidateChannel), [channels.data]);

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

  async function submit(values: CreateRunValues) {
    setLoading(true);
    try {
      const grouped: Record<string, string[]> = {};
      const selectedIds = new Set([...(values.reference_channel_ids ?? []), ...(values.candidate_channel_ids ?? [])]);
      for (const channel of channels.data ?? []) {
        if (selectedIds.has(channel.id)) {
          grouped[channel.role] = [...(grouped[channel.role] ?? []), channel.id];
        }
      }
      const run = await api.startRun({
        name: values.name,
        suite_id: values.suite_id,
        channel_ids: grouped,
        repeat_count: values.repeat_count,
        concurrency: values.concurrency,
        use_mock: values.use_mock ?? true,
      });
      message.success('检测任务已创建');
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
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ repeat_count: 1, concurrency: 4, use_mock: true }}>
          <Form.Item label="任务名" name="name" rules={[{ required: true }]}>
            <Input size="large" placeholder="Sonnet 4.5 渠道真实性测试" />
          </Form.Item>
          <Form.Item label="测试集" name="suite_id" rules={[{ required: true }]}>
            <Select
              size="large"
              loading={suites.isLoading}
              placeholder="选择测试集"
              options={(suites.data ?? []).map((suite) => ({ value: suite.id, label: `${suite.name} (${suite.version ?? '未标版'})` }))}
            />
          </Form.Item>
          {referenceChannels.length === 0 ? (
            <Alert
              type="warning"
              showIcon
              message="还没有可用对照渠道"
              description="请先到渠道管理中补齐 Anthropic Official、AWS Bedrock、Azure AI Foundry 等固定对照渠道。"
              action={<Button onClick={() => navigate('/channels')}>去渠道管理</Button>}
              style={{ marginBottom: 16 }}
            />
          ) : null}
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
                      <Tag color={roleColor[channel.role]}>{roleLabel[channel.role]}</Tag>
                    </Space>
                  </label>
                ))}
              </div>
            </Checkbox.Group>
          </Form.Item>
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
                    <Tag color={roleColor[channel.role]}>{roleLabel[channel.role]}</Tag>
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
            第一版默认使用 mock client 完成全流程验证；接入真实密钥后可切换实时调用。
          </Typography.Paragraph>
          <Button type="primary" size="large" htmlType="submit" loading={loading} style={{ height: '44px', fontWeight: 600 }}>
            启动检测
          </Button>
        </Form>
      </Card>
    </div>
  );
}
