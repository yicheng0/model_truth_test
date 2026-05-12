import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Form, Select, Space, Steps, Switch, Tag, Typography, message } from 'antd';
import { Play, Send, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import type { Channel, SignatureInteropResult, SimulatedMessageResponse } from '../types';

type DisplayStep = SignatureInteropResult['steps'][number];

const defaultSteps: DisplayStep[] = [
  { name: '步骤 A：请求 Source thinking', status: 'wait', detail: '等待开始检测', excerpt: null },
  { name: 'Signature 校验', status: 'wait', detail: '等待 source 返回 thinking block 后校验 signature', excerpt: null },
  { name: '步骤 B：发送 Relay 复用请求', status: 'wait', detail: '等待发送包含 source assistant content 的 relay 请求', excerpt: null },
  { name: '最终判定', status: 'wait', detail: '等待 relay 响应后判断是否互通', excerpt: null },
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
  const [form] = Form.useForm<{ source_channel_id: string; relay_channel_id: string; stream?: boolean }>();
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const [result, setResult] = useState<SignatureInteropResult | null>(null);
  const [displaySteps, setDisplaySteps] = useState<DisplayStep[]>(defaultSteps);
  const [simulateProvider, setSimulateProvider] = useState('aws');
  const [simulatedResult, setSimulatedResult] = useState<SimulatedMessageResponse | null>(null);

  const availableChannels = useMemo(
    () => (channels.data ?? []).filter((channel) => channel.enabled && channel.base_url && channelApiKey(channel)),
    [channels.data],
  );

  const channelOptions = availableChannels.map((channel) => ({
    value: channel.id,
    label: `${channel.name} · ${channel.model_name || '未配置模型'}`,
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

  const simulateMessage = useMutation({
    mutationFn: api.simulateMessageResponse,
    onSuccess: (payload) => {
      setSimulatedResult(payload);
      message.success(`已生成 ${payload.message_channel_type} 模拟响应`);
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '模拟请求失败');
    },
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

  function runSimulation() {
    simulateMessage.mutate({ provider: simulateProvider });
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

      <Card title={<span className="card-title-with-icon"><Send size={18} />模拟请求</span>} bordered={false}>
        <Space direction="vertical" size={16} className="full-width">
          <Alert
            type="info"
            showIcon
            message="独立模拟 Claude Messages 响应"
            description="点击按钮后生成一份本地模拟响应，直接展示 AWS / Vertex / Anthropic 对应的 message id 前缀，不调用真实外部 API。"
          />
          <Space wrap>
            <Select
              value={simulateProvider}
              onChange={(value) => {
                setSimulateProvider(value);
                setSimulatedResult(null);
              }}
              style={{ width: 180 }}
              options={[
                { value: 'aws', label: 'AWS' },
                { value: 'vertex', label: 'Vertex' },
                { value: 'anthropic', label: 'Anthropic' },
              ]}
            />
            <Button type="primary" htmlType="button" loading={simulateMessage.isPending} onClick={runSimulation} icon={<Send size={16} />}>
              模拟请求
            </Button>
          </Space>
          {simulatedResult ? (
            <Space direction="vertical" size={16} className="full-width">
              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label="Message ID">{simulatedResult.message_id}</Descriptions.Item>
                <Descriptions.Item label="渠道特征">{simulatedResult.message_channel_type}</Descriptions.Item>
                <Descriptions.Item label="Provider">{simulatedResult.provider}</Descriptions.Item>
                <Descriptions.Item label="响应类型">{String(simulatedResult.raw_response.type ?? '-')}</Descriptions.Item>
              </Descriptions>
              <div className="signature-sim-grid">
                <Card title="模拟请求" bordered={false}>
                  <pre className="signature-step-excerpt">{JSON.stringify(simulatedResult.raw_request, null, 2)}</pre>
                </Card>
                <Card title="模拟响应" bordered={false}>
                  <pre className="signature-step-excerpt">{JSON.stringify(simulatedResult.raw_response, null, 2)}</pre>
                </Card>
              </div>
              <Card title="兜底渠道说明" bordered={false}>
                <pre className="signature-note">{simulatedResult.fallback_note}</pre>
              </Card>
            </Space>
          ) : null}
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
              <Descriptions.Item label="模型">{result.model}</Descriptions.Item>
              <Descriptions.Item label="Thinking blocks">{result.thinking_block_count}</Descriptions.Item>
              <Descriptions.Item label="Source ID">
                {result.source_message_id || '-'} · {result.source_message_channel_type}
              </Descriptions.Item>
              <Descriptions.Item label="Relay ID">
                {result.relay_message_id || '-'} · {result.relay_message_channel_type}
              </Descriptions.Item>
              <Descriptions.Item label="Source endpoint" span={2}>{result.source_endpoint}</Descriptions.Item>
              <Descriptions.Item label="Relay endpoint" span={2}>{result.relay_endpoint}</Descriptions.Item>
              <Descriptions.Item label="Signature 前缀" span={2}>{result.signature_prefixes.join(', ')}</Descriptions.Item>
            </Descriptions>
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
