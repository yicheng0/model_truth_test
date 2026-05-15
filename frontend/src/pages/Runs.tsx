import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Popconfirm, Progress, Space, Table, Tag, message } from 'antd';
import { Link } from 'react-router-dom';
import { BarChart3, CircleStop, Fingerprint, GitCompare, Trash2, Trophy } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { formatDateTime } from '../time';
import type { Run } from '../types';

function statusColor(status: Run['status']) {
  if (status === 'completed') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'canceled') return 'default';
  return 'gold';
}

function canCancel(status: Run['status']) {
  return status === 'pending' || status === 'running';
}

export default function Runs() {
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: api.runs,
    refetchInterval: (query) => (query.state.data?.some((run) => run.status === 'pending' || run.status === 'running') ? 2500 : false),
  });

  const remove = useMutation({
    mutationFn: api.deleteRun,
    onSuccess: async () => {
      message.success('任务已删除');
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
    onSettled: () => setDeletingId(null),
  });
  const cancel = useMutation({
    mutationFn: api.cancelRun,
    onSuccess: async () => {
      message.success('任务已取消');
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
    onSettled: () => setCancelingId(null),
  });

  async function deleteRun(run: Run) {
    setDeletingId(run.id);
    remove.mutate(run.id);
  }

  async function cancelRun(run: Run) {
    setCancelingId(run.id);
    cancel.mutate(run.id);
  }

  return (
    <div className="page-stack">
      <Card
        title={<span style={{ fontSize: '18px', fontWeight: 600 }}>检测任务列表</span>}
        extra={
          <Space wrap>
            <Link to="/new-run?mode=baseline">
              <Button size="large" icon={<Fingerprint size={16} />} style={{ height: '40px', fontWeight: 600 }}>
                提取渠道指纹
              </Button>
            </Link>
            <Link to="/new-run?mode=compare">
              <Button type="primary" size="large" icon={<GitCompare size={16} />} style={{ height: '40px', fontWeight: 600 }}>
                真实性对比
              </Button>
            </Link>
            <Link to="/new-performance">
              <Button size="large" icon={<BarChart3 size={16} />} style={{ height: '40px', fontWeight: 600 }}>
                性能诊断
              </Button>
            </Link>
            <Link to="/new-arena">
              <Button size="large" icon={<Trophy size={16} />} style={{ height: '40px', fontWeight: 600 }}>
                Arena 排名
              </Button>
            </Link>
          </Space>
        }
        bordered={false}
      >
        {runs.isError ? (
          <Alert
            type="error"
            showIcon
            message="任务列表加载失败"
            description={getErrorMessage(runs.error)}
            action={<Button onClick={() => runs.refetch()}>重试</Button>}
            style={{ marginBottom: 16 }}
          />
        ) : null}
        <Table
          rowKey="id"
          loading={runs.isLoading}
          dataSource={runs.data ?? []}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
          scroll={{ x: 1160 }}
          columns={[
            { title: '任务', dataIndex: 'name', width: 220 },
            {
              title: '状态',
              dataIndex: 'status',
              width: 120,
              render: (status: Run['status']) => (
                <Tag
                  color={statusColor(status)}
                  style={{ borderRadius: '6px', padding: '4px 12px', fontWeight: 500 }}
                >
                  {status}
                </Tag>
              )
            },
            {
              title: '进度',
              width: 220,
              render: (_, run) => (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Progress
                    percent={run.total_jobs ? Math.round((run.completed_jobs / run.total_jobs) * 100) : 0}
                    size="small"
                    strokeColor={{ '0%': '#667eea', '100%': '#764ba2' }}
                  />
                  <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                    {run.completed_jobs} / {run.total_jobs}
                  </span>
                </Space>
              ),
            },
            { title: '创建时间', dataIndex: 'created_at', width: 190, render: formatDateTime },
            { title: '结束时间', dataIndex: 'finished_at', width: 190, render: formatDateTime },
            { title: '重复', dataIndex: 'repeat_count', width: 90 },
            { title: '并发', dataIndex: 'concurrency', width: 90 },
            {
              title: '操作',
              width: 290,
              render: (_, run) => (
                <Space>
                  <Link to={`/runs/${run.id}`} style={{ fontWeight: 600 }}>查看详情</Link>
                  {canCancel(run.status) ? (
                    <Popconfirm
                      title="取消检测任务"
                      description="会停止剩余检测，已产生结果会保留。确定取消吗？"
                      okText="取消任务"
                      cancelText="返回"
                      onConfirm={() => cancelRun(run)}
                    >
                      <Button
                        icon={<CircleStop size={15} />}
                        loading={cancelingId === run.id}
                      >
                        取消
                      </Button>
                    </Popconfirm>
                  ) : null}
                  <Popconfirm
                    title="删除检测任务"
                    description="会同时删除该任务的结果、对比和报告。确定删除吗？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    disabled={run.status === 'running'}
                    onConfirm={() => deleteRun(run)}
                  >
                    <Button
                      danger
                      icon={<Trash2 size={15} />}
                      loading={deletingId === run.id}
                      disabled={run.status === 'running'}
                    >
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              )
            },
          ]}
        />
      </Card>
    </div>
  );
}
