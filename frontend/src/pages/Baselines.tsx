import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Space, Table, Tag, message } from 'antd';
import { Link } from 'react-router-dom';
import { RefreshCcw } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import type { BaselineSnapshot, Channel, TestSuite } from '../types';

const statusColor: Record<BaselineSnapshot['status'], string> = {
  building: 'processing',
  ready: 'green',
  expired: 'gold',
  invalid: 'red',
  failed: 'red',
};

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '-';
}

export default function Baselines() {
  const queryClient = useQueryClient();
  const baselines = useQuery({ queryKey: ['baselines'], queryFn: () => api.baselines() });
  const suites = useQuery<TestSuite[]>({ queryKey: ['suites'], queryFn: api.suites });
  const channels = useQuery<Channel[]>({ queryKey: ['channels'], queryFn: api.channels });

  const validate = useMutation({
    mutationFn: api.validateBaseline,
    onSuccess: async () => {
      message.success('基线状态已刷新');
      await queryClient.invalidateQueries({ queryKey: ['baselines'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const suiteById = new Map((suites.data ?? []).map((suite) => [suite.id, suite]));
  const channelById = new Map((channels.data ?? []).map((channel) => [channel.id, channel]));

  return (
    <div className="page-stack">
      <Card
        title={<span style={{ fontSize: '18px', fontWeight: 600 }}>官方基线管理</span>}
        extra={<Link to="/new-run?mode=baseline"><Button type="primary" size="large">创建对照样本</Button></Link>}
        bordered={false}
      >
        {baselines.isError || suites.isError || channels.isError ? (
          <Alert
            type="error"
            showIcon
            message="基线数据加载失败"
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
                <Descriptions.Item label="基线 ID">{baseline.id}</Descriptions.Item>
                <Descriptions.Item label="来源任务">
                  {baseline.source_run_id ? <Link to={`/runs/${baseline.source_run_id}`}>{baseline.source_run_id}</Link> : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="题库指纹">{baseline.suite_fingerprint ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="请求指纹">{baseline.request_fingerprint ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="渠道指纹">{baseline.channel_fingerprint ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="官方渠道">
                  <Space wrap>
                    {(baseline.channel_ids ?? []).map((id) => <Tag key={id}>{channelById.get(id)?.name ?? id}</Tag>)}
                  </Space>
                </Descriptions.Item>
              </Descriptions>
            ),
          }}
          columns={[
            { title: '基线名称', dataIndex: 'name', width: '22%' },
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
            { title: '生成时间', dataIndex: 'ready_at', width: '18%', render: formatDate },
            { title: '过期时间', dataIndex: 'expires_at', width: '18%', render: formatDate },
            {
              title: '操作',
              width: 150,
              render: (_, baseline) => (
                <Button
                  icon={<RefreshCcw size={15} />}
                  loading={validate.isPending && validate.variables === baseline.id}
                  onClick={() => validate.mutate(baseline.id)}
                >
                  刷新状态
                </Button>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
