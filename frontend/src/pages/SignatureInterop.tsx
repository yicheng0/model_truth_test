import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Form, Popconfirm, Select, Space, Steps, Switch, Table, Tag, Typography, message } from 'antd';
import { Play, ShieldCheck, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { formatChannelDisplayName } from '../channelCredentials';
import { formatDateTime } from '../time';
import type { Channel, SignatureInteropResult } from '../types';

type DisplayStep = SignatureInteropResult['steps'][number];

const defaultSteps: DisplayStep[] = [
  { name: '步骤 A：请求 Source thinking', status: 'wait', detail: '等待开始检测', excerpt: null },
  { name: 'Signature 校验', status: 'wait', detail: '等待 source 返回 thinking block 后校验 signature', excerpt: null },
  { name: '步骤 B：发送 Relay 复用请求', status: 'wait', detail: '等待发送包含 source assistant content 的 relay 请求', excerpt: null },
  { name: '最终判定', status: 'wait', detail: '等待 relay 响应后判断是否互通', excerpt: null },
];

const builtinChannelIds = [
  {
    account_type: 'kiro.claudecode',
    provider_type: 'kiro_claudecode',
    message_id_shape: 'msg_01{随机后缀}',
    identification: 'Anthropic-compatible；不能仅靠前缀和 claude / azure 区分',
  },
  {
    account_type: 'aws',
    provider_type: 'aws_bedrock',
    message_id_shape: 'msg_bdrk_01{随机后缀}',
    identification: 'AWS Bedrock 专属前缀，后端分类为 AWS Bedrock',
  },
  {
    account_type: 'claude',
    provider_type: 'anthropic',
    message_id_shape: 'msg_01{随机后缀}',
    identification: 'Anthropic 官方前缀，后端分类为 Anthropic',
  },
  {
    account_type: 'vertex',
    provider_type: 'vertex_ai',
    message_id_shape: 'msg_vrtx_01{随机后缀}',
    identification: 'Vertex 专属前缀，后端分类为 Vertex',
  },
  {
    account_type: 'azure',
    provider_type: 'azure_foundry',
    message_id_shape: 'msg_01{随机后缀}',
    identification: 'Anthropic-compatible；不能仅靠前缀和 claude / kiro.claudecode 区分',
  },
];

function channelApiKey(channel: Channel) {
  const value = channel.auth_config?.api_key;
  return typeof value === 'string' ? value : '';
}

function stepStatus(status: string): 'finish' | 'process' | 'error' | 'wait' {
  if (status === 'ok') return 'finish';
  if (status === 'fail') return 'error';
  if (status === 'running') return 'process';
  return 'wait';
}

function resultTone(result: SignatureInteropResult) {
  return result.ok ? 'success' : 'error';
}

export default function SignatureInterop() {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<{ source_channel_id: string; relay_channel_id: string; stream?: boolean }>();
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const [result, setResult] = useState<SignatureInteropResult | null>(null);
  const [displaySteps, setDisplaySteps] = useState<DisplayStep[]>(defaultSteps);

  const availableChannels = useMemo(
    () => (channels.data ?? []).filter((channel) => channel.enabled && channel.base_url && channelApiKey(channel)),
    [channels.data],
  );

  const channelOptions = availableChannels.map((channel) => ({
    value: channel.id,
    label: `${formatChannelDisplayName(channel)} · ${channel.model_name || '未配置模型'}`,
  }));

  const signatureInterop = useMutation({
    mutationFn: api.signatureInteropTest,
    onSuccess: (payload) => {
      setResult(payload);
      setDisplaySteps(payload.steps);
      if (payload.ok) {
        message.success('Signature 互通检测通过');
      } else {
        message.warning('Signature 互通检测未通过');
      }
    },
    onError: (error) => {
      const detail = error instanceof Error ? error.message : '请检查渠道配置和后端日志。';
      setDisplaySteps([
        { ...defaultSteps[0], status: 'fail', detail: '检测请求未完成' },
        defaultSteps[1],
        defaultSteps[2],
        { ...defaultSteps[3], status: 'fail', detail },
      ]);
      message.error(error instanceof Error ? error.message : 'Signature 互通检测失败');
    },
  });
  const deleteRun = useMutation({
    mutationFn: api.deleteRun,
    onSuccess: async () => {
      message.success('检测日志已删除');
      setResult(null);
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  function submit(values: { source_channel_id: string; relay_channel_id: string; stream?: boolean }) {
    setResult(null);
    setDisplaySteps([
      { ...defaultSteps[0], status: 'running', detail: '正在向 source 渠道发起 Anthropic Messages thinking 请求' },
      defaultSteps[1],
      defaultSteps[2],
      defaultSteps[3],
    ]);
    signatureInterop.mutate({ ...values, stream: values.stream ?? false });
  }

  function fillDefaults() {
    form.setFieldsValue({
      source_channel_id: availableChannels.find((channel) => channel.is_reference)?.id ?? availableChannels[0]?.id,
      relay_channel_id: availableChannels.find((channel) => !channel.is_reference)?.id ?? availableChannels[1]?.id ?? availableChannels[0]?.id,
      stream: false,
    });
  }

  return (
    <Space direction="vertical" size={24} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">SIGNATURE INTEROP</Typography.Text>
          <Typography.Title level={2}>Thinking Signature 互通检测</Typography.Title>
          <Typography.Paragraph>
            用 source 渠道生成带 signature 的 thinking block，再发送给 relay 渠道验证跨渠道复用是否被接受。
          </Typography.Paragraph>
        </div>
        <Tag color="blue">可检测渠道 {availableChannels.length}</Tag>
      </div>

      <Card title={<span className="card-title-with-icon"><ShieldCheck size={18} />检测配置</span>} bordered={false}>
        <Space direction="vertical" size={16} className="full-width">
          {!availableChannels.length ? (
            <Alert type="warning" showIcon message="没有可检测渠道" description="请先到渠道管理页为启用渠道配置 Base URL 和 API Key。" />
          ) : null}
          <Form
            form={form}
            layout="vertical"
            onFinish={submit}
            onValuesChange={() => {
              setResult(null);
              setDisplaySteps(defaultSteps);
            }}
          >
            <div className="signature-config-grid">
              <Form.Item name="source_channel_id" label="Source 渠道" rules={[{ required: true, message: '请选择 source 渠道' }]}>
                <Select options={channelOptions} loading={channels.isLoading} placeholder="选择生成 signature 的渠道" />
              </Form.Item>
              <Form.Item name="relay_channel_id" label="Relay 渠道" rules={[{ required: true, message: '请选择 relay 渠道' }]}>
                <Select options={channelOptions} loading={channels.isLoading} placeholder="选择复用 signature 的渠道" />
              </Form.Item>
              <Form.Item name="stream" label="Streaming" valuePropName="checked" initialValue={false}>
                <Switch checkedChildren="启用" unCheckedChildren="关闭" />
              </Form.Item>
            </div>
            <Space wrap>
              <Button type="primary" htmlType="submit" loading={signatureInterop.isPending} disabled={!availableChannels.length} icon={<Play size={16} />}>
                开始检测
              </Button>
              <Button type="default" onClick={fillDefaults} disabled={!availableChannels.length}>
                填入推荐组合
              </Button>
            </Space>
          </Form>
        </Space>
      </Card>

      <Card title="内置渠道 ID 对照" bordered={false}>
        <Space direction="vertical" size={16} className="full-width">
          <Alert
            type="info"
            showIcon
            message="渠道 ID 与响应 ID 是两套标识"
            description="响应前缀目前只能稳定区分 AWS Bedrock、Vertex、Anthropic-compatible 三类；kiro.claudecode、claude、azure 都可能落在 msg_01 家族，不能只靠 message.id 前缀互相区分。"
          />
          <Table
            rowKey="account_type"
            dataSource={builtinChannelIds}
            pagination={false}
            size="small"
            columns={[
              { title: '内置账号类型', dataIndex: 'account_type', width: 180 },
              { title: 'provider_type', dataIndex: 'provider_type', width: 180 },
              { title: '响应 message.id 形态', dataIndex: 'message_id_shape', width: 220 },
              { title: '识别结论', dataIndex: 'identification', width: 360 },
            ]}
            scroll={{ x: 940 }}
          />
        </Space>
      </Card>

      {signatureInterop.isError ? (
        <Alert
          type="error"
          showIcon
          message="检测请求失败"
          description={signatureInterop.error instanceof Error ? signatureInterop.error.message : '请检查渠道配置和后端日志。'}
        />
        ) : null}

      <Card title="检测过程" bordered={false}>
        <Steps
          direction="vertical"
          items={displaySteps.map((step) => ({
            title: step.name,
            status: stepStatus(step.status),
            description: (
              <Space direction="vertical" size={8} className="full-width">
                <Typography.Text>{step.detail}</Typography.Text>
                {step.excerpt ? <pre className="signature-step-excerpt">{step.excerpt}</pre> : null}
              </Space>
            ),
          }))}
        />
      </Card>

      {result ? (
        <Space direction="vertical" size={18} className="full-width">
          <Alert
            type={resultTone(result)}
            showIcon
            message={result.ok ? '[PASS] Signature 互通' : '[FAIL] Signature 不互通'}
            description={result.reason}
          />

          <Card title="检测结果" bordered={false}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="任务">
                {result.run?.id ? <Typography.Text copyable>{result.run.id}</Typography.Text> : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="结果">
                {result.result?.id ? <Typography.Text copyable>{result.result.id}</Typography.Text> : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="创建时间">{formatDateTime(result.created_at ?? result.run?.created_at)}</Descriptions.Item>
              <Descriptions.Item label="完成时间">{formatDateTime(result.completed_at ?? result.run?.finished_at)}</Descriptions.Item>
              <Descriptions.Item label="模型">{result.model}</Descriptions.Item>
              <Descriptions.Item label="Thinking blocks">{result.thinking_block_count}</Descriptions.Item>
              <Descriptions.Item label="Source Message ID">
                {result.source_message_id || '-'} · {result.source_message_channel_type}
              </Descriptions.Item>
              <Descriptions.Item label="Source Request ID">
                {result.source_request_id || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Relay Message ID">
                {result.relay_message_id || '-'} · {result.relay_message_channel_type}
              </Descriptions.Item>
              <Descriptions.Item label="Relay Request ID">
                {result.relay_request_id || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Source endpoint" span={2}>{result.source_endpoint}</Descriptions.Item>
              <Descriptions.Item label="Relay endpoint" span={2}>{result.relay_endpoint}</Descriptions.Item>
              <Descriptions.Item label="Signature 前缀" span={2}>{result.signature_prefixes.join(', ')}</Descriptions.Item>
            </Descriptions>
            {result.run?.id ? (
              <Popconfirm
                title="删除本次检测日志"
                description="会删除本次 Signature 检测生成的任务、结果和日志。确定删除吗？"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => result.run?.id && deleteRun.mutate(result.run.id)}
              >
                <Button danger icon={<Trash2 size={15} />} loading={deleteRun.isPending} style={{ marginTop: 16 }}>
                  删除本次检测日志
                </Button>
              </Popconfirm>
            ) : null}
          </Card>

          <Card title="兜底渠道说明" bordered={false}>
            <pre className="signature-note">{result.fallback_note}</pre>
          </Card>

          <Card title="Relay 原始响应摘要" bordered={false}>
            <pre className="output-drawer-pre">{result.relay_raw_excerpt}</pre>
          </Card>
        </Space>
      ) : null}
    </Space>
  );
}
