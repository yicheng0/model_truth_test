import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Popconfirm, Progress, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { Link } from 'react-router-dom';
import { BarChart3, CalendarClock, CircleStop, Fingerprint, GitCompare, Trash2, Trophy } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { extractPatrolEvidence, splitRunsByPatrol, type PatrolEvidence } from '../runsUtils';
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

function progressCell(run: Run) {
  return (
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
  );
}

function statusTag(status: Run['status']) {
  return (
    <Tag
      color={statusColor(status)}
      style={{ borderRadius: '6px', padding: '4px 12px', fontWeight: 500 }}
    >
      {status}
    </Tag>
  );
}

function evidenceStatusColor(status?: string | null) {
  if (status === 'ok' || status === 'pass') return 'green';
  if (status === 'error' || status === 'fail') return 'red';
  if (status === 'skipped') return 'default';
  return 'gold';
}

function compactId(value?: string | null) {
  if (!value) return '-';
  if (value.length <= 18) return value;
  return `${value.slice(0, 9)}...${value.slice(-6)}`;
}

function PatrolEvidenceCell({ run }: { run: Run }) {
  const runResults = useQuery({
    queryKey: ['runResults', run.id],
    queryFn: () => api.runResults(run.id),
    enabled: run.status === 'completed' || run.status === 'failed',
  });
  const evidence = useMemo(() => runResults.data ? extractPatrolEvidence(runResults.data) : null, [runResults.data]);

  if (run.status === 'pending' || run.status === 'running') {
    return <Typography.Text type="secondary">等待巡检完成</Typography.Text>;
  }
  if (runResults.isLoading) {
    return <Typography.Text type="secondary">正在加载巡检日志...</Typography.Text>;
  }
  if (runResults.isError) {
    return <Tag color="red">巡检日志加载失败</Tag>;
  }
  if (!evidence) {
    return <Typography.Text type="secondary">暂无巡检证据</Typography.Text>;
  }

  return <PatrolEvidenceSummary evidence={evidence} compact />;
}

function PatrolEvidenceSummary({ evidence, compact = false }: { evidence: PatrolEvidence; compact?: boolean }) {
  const primaryModel = evidence.modelRequests[0];
  const signature = evidence.signature;
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space wrap>
        <Tag color={evidence.grade === 'E' ? 'red' : evidence.grade === 'D' ? 'orange' : 'green'}>
          {evidence.grade} {evidence.score.toFixed(1)}
        </Tag>
        {primaryModel ? <Tag color={evidenceStatusColor(primaryModel.status)}>真实请求 {primaryModel.status}</Tag> : null}
        {signature ? <Tag color={evidenceStatusColor(signature.status)}>Signature {signature.status ?? '待确认'}</Tag> : null}
      </Space>
      {evidence.detectedProviderHint ? <Typography.Text>{evidence.detectedProviderHint}</Typography.Text> : null}
      <div className="patrol-log-probe-grid">
        {evidence.modelRequests.map((item) => (
          <div className="patrol-log-probe" key={item.key ?? item.resultId ?? item.title ?? 'probe'}>
            <span>{item.title ?? item.key ?? '真实请求探针'}</span>
            <Tag color={evidenceStatusColor(item.status)}>{item.status}</Tag>
            <small>result {compact ? compactId(item.resultId) : item.resultId ?? '-'}</small>
            <small>msg {compact ? compactId(item.messageId) : item.messageId ?? '-'}</small>
          </div>
        ))}
      </div>
      <Typography.Text type="secondary">
        source: {compact ? compactId(signature?.sourceMessageId) : signature?.sourceMessageId ?? '-'} · relay: {compact ? compactId(signature?.relayMessageId) : signature?.relayMessageId ?? '-'}
      </Typography.Text>
      {evidence.labels.length ? (
        <Tooltip title={evidence.labels.map((label) => evidence.labelExplanations[label] ?? label).join('；')}>
          <Space wrap>
            {evidence.labels.map((label) => <Tag color={label === 'patrol_probe_passed' ? 'green' : 'red'} key={label}>{label}</Tag>)}
          </Space>
        </Tooltip>
      ) : null}
    </Space>
  );
}

function PatrolEvidenceDetail({ runId }: { runId: string }) {
  const runResults = useQuery({
    queryKey: ['runResults', runId],
    queryFn: () => api.runResults(runId),
  });
  const evidence = useMemo(() => runResults.data ? extractPatrolEvidence(runResults.data) : null, [runResults.data]);

  if (runResults.isLoading) {
    return <Typography.Text type="secondary">正在加载巡检证据...</Typography.Text>;
  }
  if (runResults.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message="巡检证据加载失败"
        description={getErrorMessage(runResults.error)}
        action={<Button onClick={() => runResults.refetch()}>重试</Button>}
      />
    );
  }
  if (!evidence) {
    return <Empty description="暂无巡检证据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <PatrolEvidenceSummary evidence={evidence} />
      <Table
        rowKey={(item) => item.key ?? item.title ?? item.resultId ?? item.messageId ?? 'model-request'}
        size="small"
        pagination={false}
        dataSource={evidence.modelRequests}
        scroll={{ x: 960 }}
        columns={[
          { title: '真实请求探针', width: 190, render: (_, item) => item.title ?? item.key ?? '真实模型请求' },
          { title: '状态', width: 110, render: (_, item) => <Tag color={evidenceStatusColor(item.status)}>{item.status}</Tag> },
          { title: 'Result ID', dataIndex: 'resultId', width: 190, render: (value) => value ?? '-' },
          { title: 'Message ID', dataIndex: 'messageId', width: 190, render: (value) => value ?? '-' },
          { title: '渠道类型', dataIndex: 'messageChannelType', width: 180, render: (value) => value ?? '-' },
          { title: '协议', dataIndex: 'requestProtocol', width: 160, render: (value) => value ?? '-' },
          {
            title: '标签',
            width: 220,
            render: (_, item) => item.labels.length ? <Space wrap>{item.labels.map((label) => <Tag color="red" key={label}>{label}</Tag>)}</Space> : '-',
          },
          { title: '错误', dataIndex: 'error', width: 220, render: (value) => value ?? '-' },
        ]}
      />
      {evidence.signature ? (
        <Space direction="vertical" size={4}>
          <Typography.Text strong>Thinking Signature 互通</Typography.Text>
          <Typography.Text type="secondary">
            source: {evidence.signature.sourceChannelId ?? '-'} / {evidence.signature.sourceMessageId ?? '-'} / {evidence.signature.sourceMessageChannelType ?? '-'}
          </Typography.Text>
          <Typography.Text type="secondary">
            relay: {evidence.signature.relayChannelId ?? '-'} / {evidence.signature.relayMessageId ?? '-'} / {evidence.signature.relayMessageChannelType ?? '-'}
          </Typography.Text>
          <Typography.Text type="secondary">
            signature: {evidence.signature.signaturePrefixes.join(', ') || '-'}
          </Typography.Text>
          {evidence.signature.reason ? <Typography.Text>{evidence.signature.reason}</Typography.Text> : null}
        </Space>
      ) : null}
    </Space>
  );
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

  const { normalRuns, patrolRuns } = useMemo(() => splitRunsByPatrol(runs.data ?? []), [runs.data]);
  const actionColumn = {
    title: '操作',
    width: 290,
    render: (_: unknown, run: Run) => (
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
    ),
  };

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
          dataSource={normalRuns}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
          scroll={{ x: 1160 }}
          columns={[
            { title: '任务', dataIndex: 'name', width: 220 },
            {
              title: '状态',
              dataIndex: 'status',
              width: 120,
              render: statusTag,
            },
            {
              title: '进度',
              width: 220,
              render: (_, run) => progressCell(run),
            },
            { title: '创建时间', dataIndex: 'created_at', width: 190, render: formatDateTime },
            { title: '结束时间', dataIndex: 'finished_at', width: 190, render: formatDateTime },
            { title: '重复', dataIndex: 'repeat_count', width: 90 },
            { title: '并发', dataIndex: 'concurrency', width: 90 },
            actionColumn,
          ]}
        />
      </Card>

      <Card
        title={<span className="card-title-with-icon"><CalendarClock size={18} />自动巡检日志</span>}
        bordered={false}
      >
        <Table
          rowKey="id"
          loading={runs.isLoading}
          dataSource={patrolRuns}
          locale={{ emptyText: <Empty description="暂无自动巡检日志" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
          scroll={{ x: 1280 }}
          expandable={{
            expandedRowRender: (run) => <PatrolEvidenceDetail runId={run.id} />,
            rowExpandable: (run) => run.status === 'completed' || run.status === 'failed',
          }}
          columns={[
            { title: '巡检任务', dataIndex: 'name', width: 240 },
            {
              title: '状态',
              dataIndex: 'status',
              width: 120,
              render: statusTag,
            },
            {
              title: '进度',
              width: 190,
              render: (_, run) => progressCell(run),
            },
            {
              title: '巡检结果',
              width: 520,
              render: (_, run) => <PatrolEvidenceCell run={run} />,
            },
            {
              title: '巡检计划',
              dataIndex: 'scheduled_test_id',
              width: 240,
              render: (value: string | null | undefined) => value ?? '-',
            },
            { title: '创建时间', dataIndex: 'created_at', width: 190, render: formatDateTime },
            { title: '结束时间', dataIndex: 'finished_at', width: 190, render: formatDateTime },
            {
              title: '操作',
              width: 260,
              render: (_, run) => (
                <Space>
                  <Link to={`/runs/${run.id}`} style={{ fontWeight: 600 }}>查看巡检详情</Link>
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
