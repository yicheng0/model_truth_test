import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Popconfirm, Progress, Space, Table, Tag, message } from 'antd';
import { Link } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import type { Run } from '../types';

export default function Runs() {
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<string | null>(null);
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

  async function deleteRun(run: Run) {
    setDeletingId(run.id);
    remove.mutate(run.id);
  }

  return (
    <div className="page-stack">
      <Card
        title={<span style={{ fontSize: '18px', fontWeight: 600 }}>检测任务列表</span>}
        extra={<Link to="/new-run"><Button type="primary" size="large" style={{ height: '40px', fontWeight: 600 }}>创建检测</Button></Link>}
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
          scroll={{ x: 760 }}
          columns={[
            { title: '任务', dataIndex: 'name', width: '25%' },
            {
              title: '状态',
              dataIndex: 'status',
              width: '12%',
              render: (status: string) => (
                <Tag
                  color={status === 'completed' ? 'green' : status === 'failed' ? 'red' : 'gold'}
                  style={{ borderRadius: '6px', padding: '4px 12px', fontWeight: 500 }}
                >
                  {status}
                </Tag>
              )
            },
            {
              title: '进度',
              width: '25%',
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
            { title: '重复', dataIndex: 'repeat_count', width: '10%' },
            { title: '并发', dataIndex: 'concurrency', width: '10%' },
            {
              title: '操作',
              width: 210,
              render: (_, run) => (
                <Space>
                  <Link to={`/runs/${run.id}`} style={{ fontWeight: 600 }}>查看详情</Link>
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
