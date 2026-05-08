import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from 'antd';
import { CheckCircle2, Edit3, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../api';
import { fixedReferenceChannelIds, fixedReferenceChannels } from '../channelPresets';
import { defaultProviderTypeLabels, defaultRoleLabels, providerOptions, providerTypeKeys, providerTypeLabel, roleColor, roleKeys, roleLabel, roleOptions } from '../channelTaxonomy';
import type { Channel, ChannelRole } from '../types';

type ChannelFormValues = {
  name: string;
  role: ChannelRole;
  provider_type: string;
  model_name?: string;
  base_url?: string;
  enabled?: boolean;
};

type TaxonomyFormValues = {
  role_labels: Record<ChannelRole, string>;
  provider_type_labels: Record<string, string>;
};

export default function Channels() {
  const queryClient = useQueryClient();
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const pendingAlerts = useQuery({ queryKey: ['alerts', 'pending_review'], queryFn: () => api.alerts('pending_review') });
  const taxonomy = useQuery({ queryKey: ['channelTaxonomy'], queryFn: api.channelTaxonomy });
  const [createForm] = Form.useForm<ChannelFormValues>();
  const [editForm] = Form.useForm<ChannelFormValues>();
  const [taxonomyForm] = Form.useForm<TaxonomyFormValues>();
  const [editing, setEditing] = useState<Channel | null>(null);
  const taxonomyData = taxonomy.data;

  useEffect(() => {
    if (!taxonomyData) return;
    taxonomyForm.setFieldsValue({
      role_labels: taxonomyData.role_labels,
      provider_type_labels: taxonomyData.provider_type_labels,
    });
  }, [taxonomyData, taxonomyForm]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
  };

  const create = useMutation({
    mutationFn: api.createChannel,
    onSuccess: async () => {
      message.success('渠道已创建');
      createForm.resetFields();
      await invalidate();
    },
  });

  const update = useMutation({
    mutationFn: ({ id, values }: { id: string; values: Partial<Channel> }) => api.updateChannel(id, values),
    onSuccess: async () => {
      message.success('渠道已更新');
      setEditing(null);
      editForm.resetFields();
      await invalidate();
    },
  });
  const updateTaxonomy = useMutation({
    mutationFn: api.updateChannelTaxonomy,
    onSuccess: async () => {
      message.success('显示名称已更新');
      await queryClient.invalidateQueries({ queryKey: ['channelTaxonomy'] });
    },
  });

  const remove = useMutation({
    mutationFn: api.deleteChannel,
    onSuccess: async () => {
      message.success('渠道已删除');
      await invalidate();
    },
  });

  const createFixedReferences = useMutation({
    mutationFn: async () => {
      const existingIds = new Set((channels.data ?? []).map((channel) => channel.id));
      const missing = fixedReferenceChannels.filter((channel) => !existingIds.has(channel.id));
      await Promise.all(missing.map((channel) => api.createChannel({ ...channel, enabled: true })));
      return missing.length;
    },
    onSuccess: async (createdCount) => {
      message.success(createdCount ? `已创建 ${createdCount} 个固定对照渠道` : '固定对照渠道已完整');
      await invalidate();
    },
  });

  const roleCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const channel of channels.data ?? []) {
      counts[channel.role] = (counts[channel.role] ?? 0) + 1;
    }
    return counts;
  }, [channels.data]);

  const existingChannelIds = useMemo(() => new Set((channels.data ?? []).map((channel) => channel.id)), [channels.data]);
  const missingFixedReferenceCount = fixedReferenceChannels.filter((channel) => !existingChannelIds.has(channel.id)).length;
  const pendingAlertCountByChannel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const alert of pendingAlerts.data ?? []) {
      counts.set(alert.channel_id, (counts.get(alert.channel_id) ?? 0) + 1);
    }
    return counts;
  }, [pendingAlerts.data]);

  function openEdit(channel: Channel) {
    setEditing(channel);
    editForm.setFieldsValue({
      name: channel.name,
      role: channel.role,
      provider_type: channel.provider_type,
      model_name: channel.model_name ?? '',
      base_url: channel.base_url ?? '',
      enabled: channel.enabled,
    });
  }

  function submitCreate(values: ChannelFormValues) {
    create.mutate({
      ...values,
      enabled: true,
      model_name: values.model_name || null,
      base_url: values.base_url || null,
    });
  }

  function submitEdit(values: ChannelFormValues) {
    if (!editing) return;
    update.mutate({
      id: editing.id,
      values: {
        ...values,
        model_name: values.model_name || null,
        base_url: values.base_url || null,
      },
    });
  }

  function toggleEnabled(channel: Channel, enabled: boolean) {
    update.mutate({ id: channel.id, values: { enabled } });
  }

  function submitTaxonomy(values: TaxonomyFormValues) {
    updateTaxonomy.mutate(values);
  }

  function resetTaxonomyDefaults() {
    const values = {
      role_labels: defaultRoleLabels,
      provider_type_labels: defaultProviderTypeLabels,
    };
    taxonomyForm.setFieldsValue(values);
    updateTaxonomy.mutate(values);
  }

  const channelRoleOptions = roleOptions(taxonomyData);
  const channelProviderOptions = providerOptions(taxonomyData);

  return (
    <Space direction="vertical" size={24} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">CHANNELS</Typography.Text>
          <Typography.Title level={2}>渠道管理</Typography.Title>
          <Typography.Paragraph>
            管理金标、官方云参考、待测第三方和负样本渠道。API Key 不在这里明文展示，真实检测时再按运行任务临时输入或接入加密保存。
          </Typography.Paragraph>
        </div>
        <Space wrap>
          <Tag color="gold">{roleLabel('gold', taxonomyData)} {roleCounts.gold ?? 0}</Tag>
          <Tag color="blue">{roleLabel('official_cloud', taxonomyData)} {roleCounts.official_cloud ?? 0}</Tag>
          <Tag color="purple">{roleLabel('candidate', taxonomyData)} {roleCounts.candidate ?? 0}</Tag>
          <Tag color="red">{roleLabel('negative', taxonomyData)} {roleCounts.negative ?? 0}</Tag>
        </Space>
      </div>

      <Card title="新增渠道" bordered={false}>
        <Form form={createForm} layout="vertical" onFinish={submitCreate}>
          <div className="form-grid">
            <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入渠道名称' }]}>
              <Input size="large" placeholder="输入渠道名称" />
            </Form.Item>
            <Form.Item name="role" label="角色" rules={[{ required: true }]} initialValue="candidate">
              <Select size="large" options={channelRoleOptions} />
            </Form.Item>
            <Form.Item name="provider_type" label="Provider Type" rules={[{ required: true }]} initialValue="third_party_anthropic">
              <Select size="large" options={channelProviderOptions} />
            </Form.Item>
            <Form.Item name="model_name" label="模型名">
              <Input size="large" placeholder="claude-sonnet-4-5" />
            </Form.Item>
            <Form.Item name="base_url" label="Base URL">
              <Input size="large" placeholder="https://api.example.com" />
            </Form.Item>
          </div>
          <Button type="primary" size="large" htmlType="submit" loading={create.isPending} icon={<Plus size={16} />}>
            保存渠道
          </Button>
        </Form>
      </Card>

      <Card
        title="固定对照渠道"
        bordered={false}
        extra={
          <Button
            type="primary"
            icon={<ShieldCheck size={16} />}
            loading={createFixedReferences.isPending}
            disabled={missingFixedReferenceCount === 0}
            onClick={() => createFixedReferences.mutate()}
          >
            {missingFixedReferenceCount ? '一键补齐' : '已完整'}
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          这些渠道会在创建检测任务时默认作为对照渠道，可直接勾选使用；你仍然可以停用或编辑它们的模型名、Base URL。
        </Typography.Paragraph>
        <div className="fixed-channel-grid">
          {fixedReferenceChannels.map((preset) => {
            const exists = existingChannelIds.has(preset.id);
            return (
              <div className="fixed-channel-card" key={preset.id}>
                <div>
                  <strong>{preset.name}</strong>
                  <Typography.Text type="secondary">{preset.model_name}</Typography.Text>
                </div>
                <Space wrap>
                  <Tag color={roleColor[preset.role]}>{roleLabel(preset.role, taxonomyData)}</Tag>
                  <Tag color={exists ? 'green' : 'default'} icon={exists ? <CheckCircle2 size={12} /> : undefined}>
                    {exists ? '已创建' : '待创建'}
                  </Tag>
                </Space>
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title="角色 / 类型显示名"
        bordered={false}
        extra={
          <Space>
            <Button onClick={resetTaxonomyDefaults} disabled={updateTaxonomy.isPending}>
              恢复默认
            </Button>
            <Button type="primary" loading={updateTaxonomy.isPending} onClick={() => taxonomyForm.submit()}>
              保存显示名
            </Button>
          </Space>
        }
      >
        <Form form={taxonomyForm} layout="vertical" onFinish={submitTaxonomy}>
          <Typography.Paragraph type="secondary">
            这里只修改页面显示名称，不改变底层角色和 Provider Type key，检测、基线和巡检逻辑仍按原 key 执行。
          </Typography.Paragraph>
          <div className="form-grid">
            {roleKeys.map((role) => (
              <Form.Item key={role} name={['role_labels', role]} label={`角色：${role}`}>
                <Input placeholder={defaultRoleLabels[role]} />
              </Form.Item>
            ))}
            {providerTypeKeys.map((providerType) => (
              <Form.Item key={providerType} name={['provider_type_labels', providerType]} label={`类型：${providerType}`}>
                <Input placeholder={defaultProviderTypeLabels[providerType]} />
              </Form.Item>
            ))}
          </div>
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
              width: 220,
              render: (name: string, channel) => (
                <Space direction="vertical" size={2}>
                  <Space size={6} wrap>
                    <strong>{name}</strong>
                    {fixedReferenceChannelIds.has(channel.id) ? <Tag color="green">固定对照</Tag> : null}
                  </Space>
                  <Typography.Text type="secondary">{channel.id}</Typography.Text>
                </Space>
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
            {
              title: '角色',
              dataIndex: 'role',
              width: 150,
              render: (role: ChannelRole) => <Tag color={roleColor[role] ?? 'default'}>{roleLabel(role, taxonomyData)}</Tag>,
            },
            {
              title: '复审',
              width: 120,
              render: (_, channel) => {
                const count = pendingAlertCountByChannel.get(channel.id) ?? 0;
                return count ? <Tag color="red">待复审 {count}</Tag> : <Tag color="green">正常</Tag>;
              },
            },
            { title: '类型', dataIndex: 'provider_type', width: 220, render: (providerType: string) => providerTypeLabel(providerType, taxonomyData) },
            { title: '模型', dataIndex: 'model_name', width: 220 },
            { title: 'Base URL', dataIndex: 'base_url', ellipsis: true },
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
            <Input placeholder="输入渠道名称" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select options={channelRoleOptions} />
          </Form.Item>
          <Form.Item name="provider_type" label="Provider Type" rules={[{ required: true }]}>
            <Select options={channelProviderOptions} />
          </Form.Item>
          <Form.Item name="model_name" label="模型名">
            <Input placeholder="claude-sonnet-4-5" />
          </Form.Item>
          <Form.Item name="base_url" label="Base URL">
            <Input placeholder="https://api.example.com" />
          </Form.Item>
          <Form.Item name="enabled" label="状态" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
