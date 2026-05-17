import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Form, Input, Modal, Popconfirm, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { Link } from 'react-router-dom';
import { Edit3, Eye, RefreshCcw, Trash2 } from 'lucide-react';
import { ApiError, api, getErrorMessage } from '../api';
import { useAdminAccess } from '../adminAccess';
import { formatDateTime } from '../time';
import type { BaselineResult, BaselineSnapshot, Channel, TestSuite } from '../types';

const statusColor: Record<BaselineSnapshot['status'], string> = {
  building: 'processing',
  ready: 'green',
  expired: 'gold',
  invalid: 'red',
  failed: 'red',
};

function responseSnippet(result: BaselineResult) {
  const text = result.normalized_response?.content_text;
  if (typeof text !== 'string' || !text.trim()) return '无文本返回';
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized;
}

export default function Baselines() {
  const { isAdminMode } = useAdminAccess();
  const queryClient = useQueryClient();
  const [editingBaseline, setEditingBaseline] = useState<BaselineSnapshot | null>(null);
  const [viewingBaseline, setViewingBaseline] = useState<BaselineSnapshot | null>(null);
  const [editForm] = Form.useForm<{ name: string }>();
  const baselines = useQuery({ queryKey: ['baselines'], queryFn: () => api.baselines() });
  const suites = useQuery<TestSuite[]>({ queryKey: ['suites'], queryFn: api.suites });
  const channels = useQuery<Channel[]>({ queryKey: ['channels'], queryFn: api.channels });
  const baselineResults = useQuery({
    queryKey: ['baselineResults', viewingBaseline?.id],
    queryFn: () => api.baselineResults(viewingBaseline?.id ?? ''),
    enabled: Boolean(viewingBaseline?.id),
  });

  const validate = useMutation({
    mutationFn: api.validateBaseline,
    onSuccess: async () => {
      message.success('渠道指纹状态已刷新');
      await queryClient.invalidateQueries({ queryKey: ['baselines'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });
  const updateBaseline = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateBaseline(id, { name }),
    onSuccess: async () => {
      message.success('渠道指纹名称已更新');
      setEditingBaseline(null);
      await queryClient.invalidateQueries({ queryKey: ['baselines'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });
  const deleteBaseline = useMutation({
    mutationFn: api.deleteBaseline,
    onSuccess: async () => {
      message.success('渠道指纹已删除');
      await queryClient.invalidateQueries({ queryKey: ['baselines'] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        message.warning('该渠道指纹已被对比任务或自动巡检引用，不能删除');
        return;
      }
      message.error(getErrorMessage(error));
    },
  });

  const suiteById = new Map((suites.data ?? []).map((suite) => [suite.id, suite]));
  const channelById = new Map((channels.data ?? []).map((channel) => [channel.id, channel]));

  function openEdit(baseline: BaselineSnapshot) {
    setEditingBaseline(baseline);
    editForm.setFieldsValue({ name: baseline.name });
  }

  function submitEdit(values: { name: string }) {
    if (!editingBaseline) return;
    updateBaseline.mutate({ id: editingBaseline.id, name: values.name.trim() });
  }

  return (
    <div className="page-stack">
      <Card
        title={<span style={{ fontSize: '18px', fontWeight: 600 }}>渠道指纹管理</span>}
        extra={<Link to="/new-run?mode=baseline"><Button type="primary" size="large">提取渠道指纹</Button></Link>}
        bordered={false}
      >
        {baselines.isError || suites.isError || channels.isError ? (
          <Alert
            type="error"
            showIcon
            message="渠道指纹数据加载失败"
            description={getErrorMessage(baselines.error ?? suites.error ?? channels.error)}
            action={<Button onClick={() => Promise.all([baselines.refetch(), suites.refetch(), channels.refetch()])}>重试</Button>}
            style={{ marginBottom: 16 }}
          />
        ) : null}
        <Table
          rowKey="id"
          loading={baselines.isLoading || suites.isLoading || channels.isLoading}
          dataSource={baselines.data ?? []}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
          expandable={{
            expandedRowRender: (baseline) => (
              <Descriptions column={{ xs: 1, md: 2 }} size="small">
                <Descriptions.Item label="指纹 ID">{baseline.id}</Descriptions.Item>
                <Descriptions.Item label="来源任务">
                  {baseline.source_run_id ? <Link to={`/runs/${baseline.source_run_id}`}>{baseline.source_run_id}</Link> : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="题库指纹">{baseline.suite_fingerprint ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="请求指纹">{baseline.request_fingerprint ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="渠道指纹">{baseline.channel_fingerprint ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="指纹源渠道">
                  <Space wrap>
                    {(baseline.channel_ids ?? []).map((id) => <Tag key={id}>{channelById.get(id)?.name ?? id}</Tag>)}
                  </Space>
                </Descriptions.Item>
              </Descriptions>
            ),
          }}
          columns={[
            { title: '指纹名称', dataIndex: 'name', width: '22%' },
            {
              title: '测试集',
              dataIndex: 'suite_id',
              width: '18%',
              render: (suiteId: string) => suiteById.get(suiteId)?.name ?? suiteId,
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: '12%',
              render: (status: BaselineSnapshot['status']) => <Tag color={statusColor[status]}>{status}</Tag>,
            },
            { title: '生成时间', dataIndex: 'ready_at', width: '18%', render: formatDateTime },
            { title: '过期时间', dataIndex: 'expires_at', width: '18%', render: formatDateTime },
            {
              title: '操作',
              width: 176,
              render: (_, baseline) => (
                <div className="baseline-action-row">
                  <Tooltip title="查看指纹">
                    <Button
                      aria-label="查看指纹"
                      icon={<Eye size={15} />}
                      size="small"
                      onClick={() => setViewingBaseline(baseline)}
                    />
                  </Tooltip>
                  <Tooltip title="改名">
                    <Button
                      aria-label="改名"
                      icon={<Edit3 size={15} />}
                      size="small"
                      onClick={() => openEdit(baseline)}
                    />
                  </Tooltip>
                  <Tooltip title="刷新状态">
                    <Button
                      aria-label="刷新状态"
                      icon={<RefreshCcw size={15} />}
                      loading={validate.isPending && validate.variables === baseline.id}
                      size="small"
                      onClick={() => validate.mutate(baseline.id)}
                    />
                  </Tooltip>
                  {isAdminMode ? (
                    <Popconfirm
                      title="删除渠道指纹"
                      description="只允许删除未被对比任务或自动巡检引用的渠道指纹。确定删除吗？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => deleteBaseline.mutate(baseline.id)}
                    >
                      <Tooltip title="删除">
                        <Button
                          aria-label="删除"
                          danger
                          icon={<Trash2 size={15} />}
                          loading={deleteBaseline.isPending && deleteBaseline.variables === baseline.id}
                          size="small"
                        />
                      </Tooltip>
                    </Popconfirm>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title="修改渠道指纹名称"
        open={Boolean(editingBaseline)}
        onCancel={() => setEditingBaseline(null)}
        onOk={() => editForm.submit()}
        okText="保存"
        confirmLoading={updateBaseline.isPending}
        destroyOnClose
        forceRender
      >
        <Form form={editForm} layout="vertical" onFinish={submitEdit}>
          <Form.Item label="指纹名称" name="name" rules={[{ required: true, message: '请输入指纹名称' }]}>
            <Input maxLength={200} placeholder="输入渠道指纹名称" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={viewingBaseline ? `指纹明细：${viewingBaseline.name}` : '指纹明细'}
        open={Boolean(viewingBaseline)}
        onCancel={() => setViewingBaseline(null)}
        footer={<Button onClick={() => setViewingBaseline(null)}>关闭</Button>}
        width={980}
        destroyOnClose
      >
        <Table
          rowKey="id"
          size="small"
          loading={baselineResults.isLoading}
          dataSource={baselineResults.data ?? []}
          pagination={{ pageSize: 8, showSizeChanger: true }}
          scroll={{ x: 900, y: 480 }}
          columns={[
            { title: '题目 ID', dataIndex: 'test_case_id', width: 170 },
            {
              title: '渠道',
              dataIndex: 'channel_id',
              width: 180,
              render: (channelId: string) => channelById.get(channelId)?.name ?? channelId,
            },
            { title: '分数', dataIndex: 'score', width: 90, render: (score: number) => score.toFixed(1) },
            { title: '延迟', width: 100, render: (_, result) => `${result.metrics?.latency_ms ?? '-'} ms` },
            { title: '返回摘要', width: 360, render: (_, result) => <Typography.Text>{responseSnippet(result)}</Typography.Text> },
          ]}
        />
      </Modal>
    </div>
  );
}
