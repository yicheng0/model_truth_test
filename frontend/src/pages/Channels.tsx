import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from 'antd';
import { Edit3, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { buildChannelAuthConfig } from '../channelCredentials';
import { defaultModelOptions } from '../channelTaxonomy';
import type { Channel } from '../types';

type ChannelFormValues = {
  name: string;
  provider_type: string;
  model_name?: string | string[];
  base_url?: string;
  api_key?: string;
  request_protocol?: string;
  is_reference?: boolean;
  enabled?: boolean;
};

function firstSelectValue(value?: string | string[]) {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function channelApiKey(channel: Channel) {
  const value = channel.auth_config?.api_key;
  return typeof value === 'string' ? value : '';
}

function channelRequestProtocol(channel: Channel) {
  const value = channel.auth_config?.request_protocol;
  return typeof value === 'string' && value.trim() ? value : 'auto';
}

function preferredFetchedModel(models: string[]) {
  return models.find((model) => model.includes('sonnet-4-6')) ?? models.find((model) => model.includes('sonnet')) ?? models[0];
}

const requestProtocolOptions = [
  { value: 'auto', label: '自动探测' },
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
  { value: 'openai_chat_completions', label: 'OpenAI Chat Completions' },
  { value: 'aws_bedrock', label: 'AWS Bedrock' },
];

export default function Channels() {
  const queryClient = useQueryClient();
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const pendingAlerts = useQuery({ queryKey: ['alerts', 'pending_review'], queryFn: () => api.alerts('pending_review') });
  const taxonomy = useQuery({ queryKey: ['channelTaxonomy'], queryFn: api.channelTaxonomy });
  const [createForm] = Form.useForm<ChannelFormValues>();
  const [editForm] = Form.useForm<ChannelFormValues>();
  const [editing, setEditing] = useState<Channel | null>(null);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['channels'] }),
      queryClient.invalidateQueries({ queryKey: ['channelTaxonomy'] }),
    ]);
  };

  async function persistModelOption(modelName?: string | null) {
    const model = modelName?.trim();
    if (!model) return;
    const modelOptions = [...(taxonomy.data?.model_options ?? defaultModelOptions)];
    if (!modelOptions.includes(model)) modelOptions.push(model);
    await api.updateChannelTaxonomy({ model_options: modelOptions });
  }

  const create = useMutation({
    mutationFn: async (values: Partial<Channel>) => {
      await persistModelOption(values.model_name);
      return api.createChannel(values);
    },
    onSuccess: async () => {
      message.success('渠道已创建');
      createForm.resetFields();
      await invalidate();
    },
  });

  const update = useMutation({
    mutationFn: async ({ id, values }: { id: string; values: Partial<Channel> }) => {
      await persistModelOption(values.model_name);
      return api.updateChannel(id, values);
    },
    onSuccess: async () => {
      message.success('渠道已更新');
      setEditing(null);
      editForm.resetFields();
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: api.deleteChannel,
    onSuccess: async () => {
      message.success('渠道已删除');
      await invalidate();
    },
  });

  const loadModels = useMutation({
    mutationFn: async (channel: Channel) => api.channelModels(channel.id),
    onSuccess: async (models) => {
      setFetchedModels(models);
      const existing = editForm.getFieldValue('model_name');
      const currentModel = firstSelectValue(existing);
      const preferredModel = preferredFetchedModel(models);
      if (preferredModel && (!currentModel || !models.includes(currentModel))) {
        editForm.setFieldValue('model_name', [preferredModel]);
      }
      const currentOptions = [...(taxonomy.data?.model_options ?? defaultModelOptions)];
      const merged = Array.from(new Set([...currentOptions, ...models]));
      if (models.length && merged.length !== currentOptions.length) {
        await api.updateChannelTaxonomy({ model_options: merged });
        await queryClient.invalidateQueries({ queryKey: ['channelTaxonomy'] });
      }
      message.success(models.length ? `已拉取 ${models.length} 个模型` : '没有拉取到模型');
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '模型拉取失败');
    },
  });

  const pendingAlertCountByChannel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const alert of pendingAlerts.data ?? []) {
      counts.set(alert.channel_id, (counts.get(alert.channel_id) ?? 0) + 1);
    }
    return counts;
  }, [pendingAlerts.data]);

  const channelModelOptions = Array.from(new Set([...(taxonomy.data?.model_options ?? defaultModelOptions), ...fetchedModels])).map((model) => ({ value: model, label: model }));

  function openEdit(channel: Channel) {
    setEditing(channel);
    setFetchedModels([]);
    editForm.setFieldsValue({
      name: channel.name,
      provider_type: channel.provider_type,
      model_name: channel.model_name ? [channel.model_name] : [],
      base_url: channel.base_url ?? '',
      api_key: channelApiKey(channel),
      request_protocol: channelRequestProtocol(channel),
      is_reference: channel.is_reference,
      enabled: channel.enabled,
    });
  }

  function channelPayload(values: ChannelFormValues, existing?: Channel | null): Partial<Channel> {
    const modelName = firstSelectValue(values.model_name);
    return {
      name: values.name.trim(),
      provider_type: values.provider_type.trim(),
      is_reference: values.is_reference ?? false,
      enabled: values.enabled,
      model_name: modelName || null,
      base_url: values.base_url?.trim() || null,
      auth_config: buildChannelAuthConfig(values, existing?.auth_config),
    };
  }

  function submitCreate(values: ChannelFormValues) {
    create.mutate({ ...channelPayload(values), enabled: true });
  }

  function submitEdit(values: ChannelFormValues) {
    if (!editing) return;
    update.mutate({ id: editing.id, values: channelPayload(values, editing) });
  }

  function toggleEnabled(channel: Channel, enabled: boolean) {
    update.mutate({ id: channel.id, values: { enabled } });
  }

  function toggleReference(channel: Channel, is_reference: boolean) {
    update.mutate({ id: channel.id, values: { is_reference } });
  }

  return (
    <Space direction="vertical" size={24} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">CHANNELS</Typography.Text>
          <Typography.Title level={2}>渠道管理</Typography.Title>
          <Typography.Paragraph>
            内部渠道配置只保留必要信息。Provider Type 可填写你们内部类型名，请用请求协议决定真实检测时的上游接口格式。
          </Typography.Paragraph>
        </div>
        <Space wrap>
          <Tag color="blue">指纹源渠道 {(channels.data ?? []).filter((channel) => channel.is_reference).length}</Tag>
          <Tag color="purple">待测渠道 {(channels.data ?? []).filter((channel) => !channel.is_reference).length}</Tag>
          <Tag color="green">启用 {(channels.data ?? []).filter((channel) => channel.enabled).length}</Tag>
        </Space>
      </div>

      <Card title="新增渠道" bordered={false}>
        <Form form={createForm} layout="vertical" onFinish={submitCreate}>
          <div className="form-grid">
            <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入渠道名称' }]}>
              <Input size="large" placeholder="例如：APIPro 生产中转" />
            </Form.Item>
            <Form.Item name="provider_type" label="Provider Type" rules={[{ required: true, message: '请输入 Provider Type' }]}>
              <Input size="large" placeholder="例如：apipro-relay、official-api、customer-proxy" />
            </Form.Item>
            <Form.Item name="model_name" label="模型名">
              <Select size="large" mode="tags" maxCount={1} options={channelModelOptions} placeholder="输入模型名，保存后下次可直接选择" />
            </Form.Item>
            <Form.Item name="request_protocol" label="请求协议" initialValue="auto">
              <Select size="large" options={requestProtocolOptions} />
            </Form.Item>
            <Form.Item name="base_url" label="Base URL" help="自动探测会先试 Anthropic Messages，再试 OpenAI Chat Completions；也可以显式选择协议。">
              <Input size="large" placeholder="https://api.example.com 或 https://api.example.com/v1" />
            </Form.Item>
            <Form.Item name="api_key" label="API Key">
              <Input size="large" autoComplete="off" placeholder="sk-ant-..." />
            </Form.Item>
            <Form.Item name="is_reference" label="指纹源渠道" valuePropName="checked" initialValue={false}>
              <Switch checkedChildren="指纹源" unCheckedChildren="待测" />
            </Form.Item>
          </div>
          <Button type="primary" size="large" htmlType="submit" loading={create.isPending} icon={<Plus size={16} />}>
            保存渠道
          </Button>
        </Form>
      </Card>

      <Card title="渠道列表" bordered={false}>
        <Table
          rowKey="id"
          loading={channels.isLoading}
          dataSource={channels.data ?? []}
          pagination={{ pageSize: 8 }}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              width: 240,
              render: (name: string, channel) => (
                <Space direction="vertical" size={2}>
                  <Space size={6} wrap>
                    <strong>{name}</strong>
                    {channel.is_reference ? <Tag color="blue">指纹源</Tag> : <Tag color="purple">待测</Tag>}
                  </Space>
                  <Typography.Text type="secondary">{channel.id}</Typography.Text>
                </Space>
              ),
            },
            {
              title: '指纹源',
              dataIndex: 'is_reference',
              width: 130,
              render: (isReference: boolean, channel) => (
                <Switch
                  checked={isReference}
                  checkedChildren="指纹源"
                  unCheckedChildren="待测"
                  loading={update.isPending}
                  onChange={(checked) => toggleReference(channel, checked)}
                />
              ),
            },
            {
              title: '状态',
              dataIndex: 'enabled',
              width: 110,
              render: (enabled: boolean, channel) => (
                <Switch
                  checked={enabled}
                  checkedChildren="启用"
                  unCheckedChildren="停用"
                  loading={update.isPending}
                  onChange={(checked) => toggleEnabled(channel, checked)}
                />
              ),
            },
            { title: 'Provider Type', dataIndex: 'provider_type', width: 220 },
            {
              title: '请求协议',
              width: 180,
              render: (_, channel) => requestProtocolOptions.find((option) => option.value === channelRequestProtocol(channel))?.label ?? channelRequestProtocol(channel),
            },
            { title: '模型', dataIndex: 'model_name', width: 220 },
            { title: 'Base URL', dataIndex: 'base_url', ellipsis: true },
            {
              title: 'API Key',
              dataIndex: 'auth_config',
              width: 120,
              render: (_: unknown, channel) => (channelApiKey(channel) ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>),
            },
            {
              title: '复审',
              width: 120,
              render: (_, channel) => {
                const count = pendingAlertCountByChannel.get(channel.id) ?? 0;
                return count ? <Tag color="red">待复审 {count}</Tag> : <Tag color="green">正常</Tag>;
              },
            },
            {
              title: '操作',
              width: 180,
              fixed: 'right',
              render: (_, channel) => (
                <Space>
                  <Button icon={<Edit3 size={15} />} onClick={() => openEdit(channel)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除渠道"
                    description="删除后不会再出现在新测评任务中。确定删除吗？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => remove.mutate(channel.id)}
                  >
                    <Button danger icon={<Trash2 size={15} />} loading={remove.isPending}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          scroll={{ x: 1120 }}
        />
      </Card>

      <Modal
        title="编辑渠道"
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        okText="保存修改"
        cancelText="取消"
        confirmLoading={update.isPending}
        onOk={() => editForm.submit()}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" onFinish={submitEdit}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入渠道名称' }]}>
            <Input placeholder="例如：APIPro 生产中转" />
          </Form.Item>
          <Form.Item name="provider_type" label="Provider Type" rules={[{ required: true, message: '请输入 Provider Type' }]}>
            <Input placeholder="例如：apipro-relay、official-api、customer-proxy" />
          </Form.Item>
          <Form.Item name="model_name" label="模型名">
            <Select mode="tags" maxCount={1} options={channelModelOptions} placeholder="输入模型名，保存后下次可直接选择" />
          </Form.Item>
          <Button
            type="default"
            loading={loadModels.isPending}
            disabled={!editing}
            onClick={() => editing && loadModels.mutate(editing)}
            style={{ marginTop: -12, marginBottom: 12 }}
          >
            拉取模型
          </Button>
          <Form.Item name="request_protocol" label="请求协议" initialValue="auto">
            <Select options={requestProtocolOptions} />
          </Form.Item>
          <Form.Item name="base_url" label="Base URL" help="自动探测会先试 Anthropic Messages，再试 OpenAI Chat Completions；也可以显式选择协议。">
            <Input placeholder="https://api.example.com 或 https://api.example.com/v1" />
          </Form.Item>
          <Form.Item name="api_key" label="API Key">
            <Input autoComplete="off" placeholder="sk-ant-..." />
          </Form.Item>
          <Form.Item name="enabled" label="状态" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
          <Form.Item name="is_reference" label="指纹源渠道" valuePropName="checked">
            <Switch checkedChildren="指纹源" unCheckedChildren="待测" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
