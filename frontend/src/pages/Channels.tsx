import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Collapse, Empty, Form, Input, Modal, Popconfirm, Radio, Row, Select, Space, Statistic, Switch, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { Activity, Edit3, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import {
  accountTypeLabel,
  accountTypeOptions,
  buildChannelAuthConfig,
  canonicalChannelName,
  formatChannelDisplayName,
  defaultAccountType,
  inferChannelAccountType,
  providerTypeForAccountType,
} from '../channelCredentials';
import { defaultModelOptions } from '../channelTaxonomy';
import { formatDateTime } from '../time';
import type { Channel, ChannelCreate, ChannelDeleteResult, ChannelHealthProfile, ChannelHealthRecentFailure } from '../types';

type ChannelFormValues = {
  name: string;
  model_name?: string | string[];
  base_url?: string;
  api_key?: string;
  account_type?: string;
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

function channelAccountType(channel: Channel) {
  const value = channel.auth_config?.account_type;
  if (typeof value === 'string' && value.trim()) return value;
  return inferChannelAccountType(channel) || defaultAccountType;
}

function channelApiKeyMode(channel: Channel) {
  return channelApiKey(channel) ? '已配置' : '未配置';
}

function preferredFetchedModel(models: string[]) {
  return models.find((model) => model.includes('sonnet-4-6')) ?? models.find((model) => model.includes('sonnet')) ?? models[0];
}

function percentText(value?: number | null) {
  return value == null ? '-' : `${value.toFixed(1)}%`;
}

function msText(value?: number | null) {
  return value == null ? '-' : `${Math.round(value)} ms`;
}

function healthStatusTag(status?: string | null) {
  if (status === 'ok') return <Tag color="green">健康</Tag>;
  if (status === 'degraded') return <Tag color="red">需关注</Tag>;
  if (status === 'insufficient_data') return <Tag color="default">样本不足</Tag>;
  return <Tag>{status || '-'}</Tag>;
}

function topEntries(value: Record<string, number>, limit = 8) {
  return Object.entries(value ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

const failureColumns: ColumnsType<ChannelHealthRecentFailure> = [
  { title: '时间', dataIndex: 'created_at', width: 170, render: (value: string | null) => formatDateTime(value) },
  { title: 'Run', dataIndex: 'run_id', width: 210, render: (value: string, row) => <Typography.Link href={`/runs/${value}`}>{row.run_name || value}</Typography.Link> },
  { title: 'HTTP', dataIndex: 'http_status', width: 80, render: (value: number | null) => value ?? '-' },
  { title: 'Request ID', dataIndex: 'request_id', width: 170, render: (value: string | null) => value ? <Typography.Text copyable ellipsis={{ tooltip: value }}>{value}</Typography.Text> : '-' },
  { title: 'Message ID', dataIndex: 'message_id', width: 170, render: (value: string | null) => value ? <Typography.Text copyable ellipsis={{ tooltip: value }}>{value}</Typography.Text> : '-' },
  { title: '错误类型', dataIndex: 'error_type', width: 150, render: (value: string | null) => value || '-' },
  { title: '错误摘要', dataIndex: 'error_excerpt', ellipsis: true, render: (value: string | null) => value || '-' },
  { title: '标签', dataIndex: 'labels', width: 220, render: (labels: string[]) => <Space size={4} wrap>{(labels ?? []).slice(0, 4).map((label) => <Tag key={label} color="orange">{label}</Tag>)}</Space> },
];

function ChannelHealthProfilePanel({ profile }: { profile: ChannelHealthProfile }) {
  const labelData = topEntries(profile.label_distribution).map(([label, count]) => ({ label, count }));
  return (
    <Space direction="vertical" size={16} className="full-width">
      {profile.status === 'insufficient_data' ? (
        <Alert showIcon type="info" message="样本不足" description="当前时间窗内没有足够历史结果；健康画像不会输出风险结论。可以扩大到 30 天或先运行巡检/手动检测。" />
      ) : null}
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}><Card size="small"><Statistic title="健康状态" valueRender={() => healthStatusTag(profile.status)} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="成功率" value={percentText(profile.success_rate)} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="P95 延迟" value={msText(profile.p95_latency_ms)} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="最近失败" value={profile.recent_failures[0]?.error_type || '-'} /></Card></Col>
      </Row>
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={14}>
          <Card size="small" title="最近趋势">
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={profile.trend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis yAxisId="left" allowDecimals={false} />
                  <YAxis yAxisId="right" orientation="right" />
                  <ChartTooltip />
                  <Line yAxisId="left" type="monotone" dataKey="result_count" name="结果数" stroke="#2563eb" />
                  <Line yAxisId="left" type="monotone" dataKey="failure_count" name="失败数" stroke="#dc2626" />
                  <Line yAxisId="right" type="monotone" dataKey="avg_latency_ms" name="平均延迟 ms" stroke="#16a34a" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card size="small" title="异常标签 Top">
            {labelData.length ? (
              <div style={{ height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={labelData} layout="vertical" margin={{ left: 80 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" allowDecimals={false} />
                    <YAxis type="category" dataKey="label" width={120} />
                    <ChartTooltip />
                    <Bar dataKey="count" name="次数" fill="#f97316" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无异常标签" />}
          </Card>
        </Col>
      </Row>
      <Row gutter={[12, 12]}>
        <Col xs={24} md={8}><Card size="small" title="Signature 互认"><Space direction="vertical"><span>通过率：{percentText(profile.signature_summary.pass_rate)}</span><span>最新状态：{profile.signature_summary.latest_status || '-'}</span><Typography.Text type="secondary">{profile.signature_summary.latest_reason || '-'}</Typography.Text></Space></Card></Col>
        <Col xs={24} md={8}><Card size="small" title="自动巡检"><Space direction="vertical"><span>启用计划：{profile.patrol_summary.enabled_schedule_count}/{profile.patrol_summary.schedule_count}</span><span>最新状态：{profile.patrol_summary.latest_status || '-'}</span><span>待复审告警：{profile.patrol_summary.pending_alert_count}</span></Space></Card></Col>
        <Col xs={24} md={8}><Card size="small" title="错误类型"><Space wrap>{topEntries(profile.error_type_distribution, 6).map(([key, count]) => <Tag key={key} color="red">{key} {count}</Tag>)}{!topEntries(profile.error_type_distribution).length ? '-' : null}</Space></Card></Col>
      </Row>
      <Card size="small" title="最近失败样本">
        <Table size="small" rowKey="result_id" pagination={{ pageSize: 5 }} dataSource={profile.recent_failures} columns={failureColumns} />
      </Card>
    </Space>
  );
}

const requestProtocolOptions = [
  { value: 'auto', label: '自动探测' },
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
  { value: 'openai_chat_completions', label: 'OpenAI Chat Completions' },
  { value: 'gemini_generate_content', label: 'Gemini GenerateContent' },
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
  const [healthChannel, setHealthChannel] = useState<Channel | null>(null);
  const [healthDays, setHealthDays] = useState<1 | 7 | 30>(7);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const healthProfile = useQuery({
    queryKey: ['channelHealthProfile', healthChannel?.id, healthDays],
    queryFn: () => api.channelHealthProfile(healthChannel!.id, healthDays),
    enabled: Boolean(healthChannel),
  });
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
    mutationFn: async (values: ChannelCreate) => {
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
    mutationFn: async ({ id, values }: { id: string; values: Partial<ChannelCreate> }) => {
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

  function deleteSummary(payload: ChannelDeleteResult) {
    const related = [
      payload.deleted_runs ? `${payload.deleted_runs} 个任务` : '',
      payload.deleted_results ? `${payload.deleted_results} 条结果` : '',
      payload.deleted_reports ? `${payload.deleted_reports} 份报告` : '',
      payload.deleted_alerts ? `${payload.deleted_alerts} 条告警` : '',
      payload.deleted_schedules ? `${payload.deleted_schedules} 个巡检计划` : '',
      payload.deleted_baselines ? `${payload.deleted_baselines} 条指纹` : '',
    ].filter(Boolean);
    return related.length ? `渠道已删除，并清理 ${related.join('、')}` : '渠道已删除';
  }

  const remove = useMutation({
    mutationFn: api.deleteChannel,
    onSuccess: async (payload) => {
      message.success(deleteSummary(payload));
      await invalidate();
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '删除渠道失败');
    },
  });
  const [deletingChannelId, setDeletingChannelId] = useState<string | null>(null);

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
      name: formatChannelDisplayName(channel, channel.id) || channel.name,
      model_name: channel.model_name ? [channel.model_name] : [],
      base_url: channel.base_url ?? '',
      api_key: '',
      account_type: channelAccountType(channel),
      request_protocol: channelRequestProtocol(channel),
      is_reference: channel.is_reference,
      enabled: channel.enabled,
    });
  }

  function channelPayload(values: ChannelFormValues, existing?: Channel | null): ChannelCreate {
    const modelName = firstSelectValue(values.model_name);
    const accountType = values.account_type || defaultAccountType;
    const name = canonicalChannelName({
      id: existing?.id,
      name: values.name,
      account_type: accountType,
      auth_config: existing?.auth_config,
    }, existing?.id) || values.name.trim();
    return {
      name,
      provider_type: providerTypeForAccountType(accountType),
      is_reference: values.is_reference ?? false,
      enabled: values.enabled,
      model_name: modelName || null,
      base_url: values.base_url?.trim() || null,
      auth_config: buildChannelAuthConfig(values, existing?.auth_config),
    };
  }

  function submitCreate(values: ChannelFormValues) {
    create.mutate({ ...channelPayload(values), enabled: true } satisfies ChannelCreate);
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
            主流程只需要配置渠道名称和账号类型；这里的渠道名称会直接用于自动巡检、告警和日志定位，Base URL 与 API Key 请在高级配置中手动填写。
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
            <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: '请输入渠道名称' }]} extra="用于自动巡检、复审告警和日志定位，建议填容易识别的名字。">
              <Input size="large" placeholder="例如：APIPro 生产中转" />
            </Form.Item>
            <Form.Item name="account_type" label="账号类型" initialValue={defaultAccountType}>
              <Select size="large" options={accountTypeOptions} />
            </Form.Item>
          </div>
          <Collapse
            className="channel-advanced"
            items={[
              {
                key: 'advanced',
                label: '高级配置',
                children: (
                  <div className="form-grid">
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
                      <Input size="large" autoComplete="off" placeholder="手动输入 API Key" />
                    </Form.Item>
                    <Form.Item name="is_reference" label="指纹源渠道" valuePropName="checked" initialValue={false}>
                      <Switch checkedChildren="指纹源" unCheckedChildren="待测" />
                    </Form.Item>
                  </div>
                ),
              },
            ]}
          />
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
              render: (_name: string, channel) => (
                <Space size={6} wrap>
                  <strong>{formatChannelDisplayName(channel)}</strong>
                  {channel.is_reference ? <Tag color="blue">指纹源</Tag> : <Tag color="purple">待测</Tag>}
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
            {
              title: '账号类型',
              width: 130,
              render: (_, channel) => accountTypeLabel(channel.auth_config?.account_type),
            },
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
              render: (_: unknown, channel) => {
                const mode = channelApiKeyMode(channel);
                return <Tag color={mode === '已配置' ? 'green' : undefined}>{mode}</Tag>;
              },
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
              width: 260,
              fixed: 'right',
              render: (_, channel) => (
                <Space>
                  <Button icon={<Activity size={15} />} onClick={() => setHealthChannel(channel)}>
                    健康
                  </Button>
                  <Button icon={<Edit3 size={15} />} onClick={() => openEdit(channel)}>
                    编辑
                  </Button>
                  {(
                    <Popconfirm
                      title="删除渠道"
                      description="会同步删除该渠道关联的巡检计划、日志、结果、报告、告警和指纹。确定删除吗？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true, loading: deletingChannelId === channel.id }}
                      onConfirm={async () => {
                        setDeletingChannelId(channel.id);
                        try {
                          await remove.mutateAsync(channel.id);
                        } finally {
                          setDeletingChannelId((current) => (current === channel.id ? null : current));
                        }
                      }}
                    >
                      <Button danger icon={<Trash2 size={15} />} loading={deletingChannelId === channel.id} disabled={Boolean(deletingChannelId)}>
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
          scroll={{ x: 1200 }}
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
          <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: '请输入渠道名称' }]} extra="修改后会同步影响自动巡检、复审告警和日志里的展示名称。">
            <Input placeholder="例如：APIPro 生产中转" />
          </Form.Item>
          <Form.Item name="account_type" label="账号类型" initialValue={defaultAccountType}>
            <Select options={accountTypeOptions} />
          </Form.Item>
          <Collapse
            className="channel-advanced"
            items={[
              {
                key: 'advanced',
                label: '高级配置',
                children: (
                  <>
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
                      <Input autoComplete="off" placeholder="留空则保留已有 API Key" />
                    </Form.Item>
                    <Form.Item name="enabled" label="状态" valuePropName="checked">
                      <Switch checkedChildren="启用" unCheckedChildren="停用" />
                    </Form.Item>
                    <Form.Item name="is_reference" label="指纹源渠道" valuePropName="checked">
                      <Switch checkedChildren="指纹源" unCheckedChildren="待测" />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />
        </Form>
      </Modal>

      <Modal
        title={healthChannel ? `健康画像：${formatChannelDisplayName(healthChannel)}` : '健康画像'}
        open={Boolean(healthChannel)}
        onCancel={() => setHealthChannel(null)}
        footer={null}
        width={1120}
        destroyOnClose
      >
        <Space direction="vertical" size={16} className="full-width">
          <Radio.Group
            value={healthDays}
            onChange={(event) => setHealthDays(event.target.value)}
            options={[
              { label: '1 天', value: 1 },
              { label: '7 天', value: 7 },
              { label: '30 天', value: 30 },
            ]}
            optionType="button"
            buttonStyle="solid"
          />
          {healthProfile.isLoading ? (
            <Card loading />
          ) : healthProfile.isError ? (
            <Alert type="error" showIcon message="健康画像加载失败" description={healthProfile.error instanceof Error ? healthProfile.error.message : '请检查后端日志'} />
          ) : healthProfile.data ? (
            <ChannelHealthProfilePanel profile={healthProfile.data} />
          ) : (
            <Empty description="暂无健康画像" />
          )}
        </Space>
      </Modal>
    </Space>
  );
}
