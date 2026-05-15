import { useMemo, useState, type Key } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Empty, Modal, Popconfirm, Progress, Space, Statistic, Table, Tag, Tooltip, Typography, message } from 'antd';
import { Link } from 'react-router-dom';
import { BarChart3, CalendarClock, CircleStop, DatabaseZap, Fingerprint, GitCompare, Trash2, Trophy } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { extractPatrolEvidence, splitRunsByPatrol, type PatrolEvidence } from '../runsUtils';
import { formatDateTime } from '../time';
import type { Run, RunLogCleanupResult } from '../types';

type RunChannelGroup = {
  key: string;
  channelId?: string | null;
  channelName: string;
  runs: Run[];
  latestRun: Run;
};

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

function compactText(value?: string | null, limit = 360) {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return '-';
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function formatBytes(value?: number | null) {
  if (value === null || value === undefined) return '-';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

function channelLabel(name?: string | null, id?: string | null) {
  if (name && id) return `${name} (${id})`;
  return name || id || '-';
}

function primaryRunChannel(run: Run) {
  const channels = run.channels ?? [];
  const candidate = channels.find((item) => item.role_in_run === 'candidate') ?? channels[0];
  if (!candidate) {
    return { key: 'unknown', channelId: null, channelName: '未识别渠道' };
  }
  if (channels.length > 1 && run.mode !== 'manual_probe') {
    const names = channels.map((item) => item.channel_name ?? item.channel_id).filter(Boolean);
    return { key: `multi:${run.id}`, channelId: null, channelName: names.length ? `多渠道任务：${names.join(' / ')}` : '多渠道任务' };
  }
  return {
    key: candidate.channel_id ?? candidate.channel_name ?? 'unknown',
    channelId: candidate.channel_id,
    channelName: candidate.channel_name ?? candidate.channel_id ?? '未识别渠道',
  };
}

function groupRunsByChannel(runs: Run[]): RunChannelGroup[] {
  const groups = new Map<string, RunChannelGroup>();
  for (const run of runs) {
    const channel = primaryRunChannel(run);
    const existing = groups.get(channel.key);
    if (existing) {
      existing.runs.push(run);
      if (new Date(run.created_at ?? 0).getTime() > new Date(existing.latestRun.created_at ?? 0).getTime()) {
        existing.latestRun = run;
      }
      continue;
    }
    groups.set(channel.key, {
      key: channel.key,
      channelId: channel.channelId,
      channelName: channel.channelName,
      runs: [run],
      latestRun: run,
    });
  }
  return Array.from(groups.values()).sort((left, right) => new Date(right.latestRun.created_at ?? 0).getTime() - new Date(left.latestRun.created_at ?? 0).getTime());
}

function patrolResultState(evidence: PatrolEvidence) {
  const blockingLabels = evidence.labels.filter((label) => label !== 'patrol_probe_passed' && label !== 'provider_error_variant');
  const hasModelError = evidence.modelRequests.some((item) => item.status === 'error' || item.status === 'fail' || Boolean(item.error) || item.labels.some((label) => label !== 'provider_error_variant'));
  const hasSignatureError = evidence.signature?.status === 'fail' || evidence.signature?.status === 'error';
  return blockingLabels.length || hasModelError || hasSignatureError ? 'error' : 'ok';
}

function patrolRunTitle(run: Run) {
  const channel = run.patrol_channel_name ?? run.patrol_channel_id;
  if (!channel) return run.name;
  return run.name.startsWith(`${channel} - `) ? run.name : `${channel} - ${run.name}`;
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

function PatrolReviewCell({ run }: { run: Run }) {
  const runResults = useQuery({
    queryKey: ['runResults', run.id],
    queryFn: () => api.runResults(run.id),
    enabled: run.status === 'completed' || run.status === 'failed',
  });
  const evidence = useMemo(() => runResults.data ? extractPatrolEvidence(runResults.data) : null, [runResults.data]);

  if (run.status === 'pending' || run.status === 'running') {
    return <Tag color="default">-</Tag>;
  }
  if (runResults.isLoading) {
    return <Typography.Text type="secondary">判断中</Typography.Text>;
  }
  if (runResults.isError || !evidence) {
    return run.status === 'failed' ? <Tag color="red">需要复审</Tag> : <Tag color="default">-</Tag>;
  }
  return patrolResultState(evidence) === 'error' ? <Tag color="red">需要复审</Tag> : <Tag color="default">-</Tag>;
}

function PatrolEvidenceSummary({ evidence, compact = false, showProbeDetails = true }: { evidence: PatrolEvidence; compact?: boolean; showProbeDetails?: boolean }) {
  const signature = evidence.signature;
  const resultState = patrolResultState(evidence);
  if (compact) {
    return (
      <Tooltip title="点开展开行或查看巡检详情查看探针日志">
        <Tag color={resultState === 'ok' ? 'green' : 'red'}>{resultState === 'ok' ? '正确' : '异常'}</Tag>
      </Tooltip>
    );
  }
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space wrap>
        <Tag color={resultState === 'ok' ? 'green' : 'red'}>{resultState === 'ok' ? '正确' : '异常'}</Tag>
        {signature ? <Tag color={evidenceStatusColor(signature.status)}>Signature {signature.status ?? '待确认'}</Tag> : null}
      </Space>
      {resultState === 'error' ? <Typography.Text type="danger">错误需要复审</Typography.Text> : null}
      {showProbeDetails ? (
        <>
          {evidence.detectedProviderHint ? <Typography.Text>{evidence.detectedProviderHint}</Typography.Text> : null}
          <div className="patrol-log-probe-grid">
            {evidence.modelRequests.map((item) => (
              <div className="patrol-log-probe" key={item.key ?? item.resultId ?? item.title ?? 'probe'}>
                <span>{item.title ?? item.key ?? '真实请求探针'}</span>
                <Tag color={item.status === 'ok' ? 'green' : 'red'}>{item.status === 'ok' ? '正确' : '异常'}</Tag>
                <small>{channelLabel(item.channelName, item.channelId)}</small>
                <small>time {formatDateTime(item.completedAt ?? item.createdAt)}</small>
                <small>result {compact ? compactId(item.resultId) : item.resultId ?? '-'}</small>
                <small>msg {compact ? compactId(item.messageId) : item.messageId ?? '-'}</small>
                <small>req {compact ? compactId(item.requestId) : item.requestId ?? '-'}</small>
              </div>
            ))}
          </div>
          <Typography.Text type="secondary">
            source: {channelLabel(signature?.sourceChannelName, signature?.sourceChannelId)} / msg {compact ? compactId(signature?.sourceMessageId) : signature?.sourceMessageId ?? '-'} / req {compact ? compactId(signature?.sourceRequestId) : signature?.sourceRequestId ?? '-'} · relay: {channelLabel(signature?.relayChannelName, signature?.relayChannelId)} / msg {compact ? compactId(signature?.relayMessageId) : signature?.relayMessageId ?? '-'} / req {compact ? compactId(signature?.relayRequestId) : signature?.relayRequestId ?? '-'}
          </Typography.Text>
        </>
      ) : null}
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
      <PatrolEvidenceSummary evidence={evidence} showProbeDetails={false} />
      <Table
        rowKey={(item) => item.key ?? item.title ?? item.resultId ?? item.messageId ?? 'model-request'}
        size="small"
        pagination={false}
        dataSource={evidence.modelRequests}
        scroll={{ x: 1600 }}
        columns={[
          { title: '真实请求探针', width: 190, render: (_, item) => item.title ?? item.key ?? '真实模型请求' },
          { title: '渠道', width: 220, render: (_, item) => channelLabel(item.channelName, item.channelId) },
          { title: '状态', width: 110, render: (_, item) => <Tag color={item.status === 'ok' ? 'green' : 'red'}>{item.status === 'ok' ? '正确' : '异常'}</Tag> },
          { title: '时间', width: 190, render: (_, item) => formatDateTime(item.completedAt ?? item.createdAt) },
          { title: 'Result ID', dataIndex: 'resultId', width: 190, render: (value) => value ?? '-' },
          { title: 'Message ID', dataIndex: 'messageId', width: 190, render: (value) => value ?? '-' },
          { title: 'Request ID', dataIndex: 'requestId', width: 190, render: (value) => value ?? '-' },
          { title: '渠道类型', dataIndex: 'messageChannelType', width: 180, render: (value) => value ?? '-' },
          { title: '协议', dataIndex: 'requestProtocol', width: 160, render: (value) => value ?? '-' },
          {
            title: '响应/错误内容',
            width: 360,
            render: (_, item) => (
              <Tooltip title={item.responseText || item.rawResponseText || undefined}>
                <Typography.Text>{compactText(item.responseText ?? item.rawResponseText)}</Typography.Text>
              </Tooltip>
            ),
          },
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
            time: {formatDateTime(evidence.signature.completedAt ?? evidence.signature.createdAt)}
          </Typography.Text>
          <Typography.Text type="secondary">
            source: {channelLabel(evidence.signature.sourceChannelName, evidence.signature.sourceChannelId)} / msg {evidence.signature.sourceMessageId ?? '-'} / req {evidence.signature.sourceRequestId ?? '-'} / {evidence.signature.sourceMessageChannelType ?? '-'}
          </Typography.Text>
          <Typography.Text type="secondary">
            relay: {channelLabel(evidence.signature.relayChannelName, evidence.signature.relayChannelId)} / msg {evidence.signature.relayMessageId ?? '-'} / req {evidence.signature.relayRequestId ?? '-'} / {evidence.signature.relayMessageChannelType ?? '-'}
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

function cleanupSummary(result?: RunLogCleanupResult | null) {
  if (!result) return '暂无预估数据';
  return `可清理 ${result.deleted_runs} 个任务，${result.deleted_results} 条结果，${result.deleted_reports} 份报告，${result.deleted_alerts} 条告警`;
}

function SystemMaintenanceModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const usage = useQuery({
    queryKey: ['systemUsage'],
    queryFn: api.systemUsage,
    enabled: open,
  });
  const preview = useQuery({
    queryKey: ['cleanupRunLogsPreview'],
    queryFn: () => api.cleanupRunLogs(true),
    enabled: open,
  });
  const cleanup = useMutation({
    mutationFn: () => api.cleanupRunLogs(false),
    onSuccess: async (result) => {
      message.success(`已清理 ${result.deleted_runs} 个任务日志`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['runs'] }),
        queryClient.invalidateQueries({ queryKey: ['reports'] }),
        queryClient.invalidateQueries({ queryKey: ['alerts'] }),
        queryClient.invalidateQueries({ queryKey: ['systemUsage'] }),
        queryClient.invalidateQueries({ queryKey: ['cleanupRunLogsPreview'] }),
      ]);
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const data = usage.data;
  const cleanupDisabled = cleanup.isPending || !preview.data?.deleted_runs;

  return (
    <Modal
      title="资源与日志清理"
      open={open}
      onCancel={onClose}
      width={760}
      footer={[
        <Button key="close" onClick={onClose}>关闭</Button>,
        <Popconfirm
          key="cleanup"
          title="清理已结束日志"
          description="会删除已完成、失败、取消和中断的任务日志；运行中任务和渠道指纹引用任务会保留。"
          okText="确认清理"
          cancelText="返回"
          onConfirm={() => cleanup.mutate()}
          disabled={cleanupDisabled}
        >
          <Button danger type="primary" loading={cleanup.isPending} disabled={cleanupDisabled}>
            清理已结束日志
          </Button>
        </Popconfirm>,
      ]}
    >
      {usage.isError ? (
        <Alert
          type="error"
          showIcon
          message="资源占用加载失败"
          description={getErrorMessage(usage.error)}
          action={<Button onClick={() => usage.refetch()}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {preview.isError ? (
        <Alert
          type="error"
          showIcon
          message="清理预估加载失败"
          description={getErrorMessage(preview.error)}
          action={<Button onClick={() => preview.refetch()}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap size={12}>
          <Card size="small" style={{ width: 170 }}>
            <Statistic title="磁盘已用" value={data?.disk_used_percent ?? 0} precision={1} suffix="%" loading={usage.isLoading} />
          </Card>
          <Card size="small" style={{ width: 170 }}>
            <Statistic title="磁盘可用" value={formatBytes(data?.disk_free_bytes)} loading={usage.isLoading} />
          </Card>
          <Card size="small" style={{ width: 170 }}>
            <Statistic title="内存已用" value={data?.memory_used_percent ?? '-'} precision={1} suffix={data?.memory_used_percent === null || data?.memory_used_percent === undefined ? '' : '%'} loading={usage.isLoading} />
          </Card>
          <Card size="small" style={{ width: 170 }}>
            <Statistic title="数据库大小" value={formatBytes(data?.database_size_bytes)} loading={usage.isLoading} />
          </Card>
        </Space>
        <Progress
          percent={Math.round(data?.disk_used_percent ?? 0)}
          status={(data?.disk_used_percent ?? 0) >= 90 ? 'exception' : 'normal'}
        />
        <Descriptions size="small" column={2} bordered>
          <Descriptions.Item label="监控路径">{data?.disk_path ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="数据库">{data?.database_path ?? '非 SQLite 或不可定位'}</Descriptions.Item>
          <Descriptions.Item label="任务数">{data?.run_count ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="结果数">{data?.result_count ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="报告数">{data?.report_count ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="告警数">{data?.alert_count ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="清理预估" span={2}>{preview.isLoading ? '正在计算...' : cleanupSummary(preview.data)}</Descriptions.Item>
          <Descriptions.Item label="保留任务" span={2}>
            运行中/待执行 {preview.data?.skipped_running_runs ?? data?.cleanup_skipped_baseline_run_count ?? 0} 个，指纹引用 {preview.data?.skipped_baseline_runs ?? 0} 个
          </Descriptions.Item>
        </Descriptions>
        <Alert
          type="warning"
          showIcon
          message="清理只删除已结束任务的日志数据"
          description="渠道、测试集、自动巡检配置和渠道指纹会保留。被渠道指纹引用的任务不会被清理。"
        />
      </Space>
    </Modal>
  );
}

export default function Runs() {
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [selectedPatrolRowKeys, setSelectedPatrolRowKeys] = useState<Key[]>([]);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: api.runs,
    refetchInterval: (query) => (query.state.data?.some((run) => run.status === 'pending' || run.status === 'running') ? 2500 : false),
  });

  const remove = useMutation({
    mutationFn: api.deleteRun,
    onSuccess: async () => {
      message.success('任务已删除');
      setSelectedPatrolRowKeys((keys) => keys.filter((key) => key !== deletingId));
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
    onSettled: () => setDeletingId(null),
  });
  const deletePatrolRuns = useMutation({
    mutationFn: async (ids: string[]) => {
      const settled = await Promise.allSettled(ids.map((id) => api.deleteRun(id)));
      const failed = settled.filter((item) => item.status === 'rejected').length;
      return { deleted: ids.length - failed, failed };
    },
    onSuccess: async (result) => {
      message.success(result.failed ? `已删除 ${result.deleted} 条日志，${result.failed} 条删除失败` : `已删除 ${result.deleted} 条日志`);
      setSelectedPatrolRowKeys([]);
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
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
  const normalRunGroups = useMemo(() => groupRunsByChannel(normalRuns), [normalRuns]);
  const selectedPatrolRuns = useMemo(
    () => patrolRuns.filter((run) => selectedPatrolRowKeys.includes(run.id)),
    [patrolRuns, selectedPatrolRowKeys],
  );
  const deletableSelectedPatrolRuns = selectedPatrolRuns.filter((run) => run.status !== 'running');

  function deleteSelectedPatrolRuns() {
    if (!selectedPatrolRowKeys.length) {
      message.warning('请先选择巡检日志');
      return;
    }
    if (!deletableSelectedPatrolRuns.length) {
      message.warning('运行中的巡检日志不能删除');
      return;
    }
    deletePatrolRuns.mutate(deletableSelectedPatrolRuns.map((run) => run.id));
  }

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
            <Button size="large" icon={<DatabaseZap size={16} />} style={{ height: '40px', fontWeight: 600 }} onClick={() => setMaintenanceOpen(true)}>
              资源与日志清理
            </Button>
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
          rowKey="key"
          loading={runs.isLoading}
          dataSource={normalRunGroups}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
          locale={{ emptyText: <Empty description="暂无检测任务" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          scroll={{ x: 980 }}
          expandable={{
            expandedRowRender: (group) => (
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={group.runs}
                scroll={{ x: 1160 }}
                columns={[
                  { title: '任务', dataIndex: 'name', width: 240 },
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
            ),
          }}
          columns={[
            {
              title: '渠道',
              width: 300,
              render: (_, group) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>{group.channelName}</Typography.Text>
                  <Typography.Text type="secondary">{group.channelId ?? '多渠道 / 未识别'}</Typography.Text>
                </Space>
              ),
            },
            {
              title: '任务数',
              width: 100,
              render: (_, group) => <Tag color="blue">{group.runs.length}</Tag>,
            },
            {
              title: '最近状态',
              width: 120,
              render: (_, group) => statusTag(group.latestRun.status),
            },
            {
              title: '最近进度',
              width: 220,
              render: (_, group) => progressCell(group.latestRun),
            },
            {
              title: '最近任务',
              width: 260,
              render: (_, group) => group.latestRun.name,
            },
            { title: '最近创建时间', width: 190, render: (_, group) => formatDateTime(group.latestRun.created_at) },
          ]}
        />
      </Card>
      <SystemMaintenanceModal open={maintenanceOpen} onClose={() => setMaintenanceOpen(false)} />

      <Card
        title={<span className="card-title-with-icon"><CalendarClock size={18} />自动巡检日志</span>}
        extra={
          <Popconfirm
            title="删除已选巡检日志"
            description={`将删除 ${deletableSelectedPatrolRuns.length} 条已选日志及其结果、报告和关联告警。运行中日志会跳过。确定删除吗？`}
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            disabled={!deletableSelectedPatrolRuns.length}
            onConfirm={deleteSelectedPatrolRuns}
          >
            <Button danger icon={<Trash2 size={15} />} disabled={!deletableSelectedPatrolRuns.length} loading={deletePatrolRuns.isPending}>
              删除已选
            </Button>
          </Popconfirm>
        }
        bordered={false}
      >
        <Table
          rowKey="id"
          loading={runs.isLoading}
          dataSource={patrolRuns}
          rowSelection={{
            selectedRowKeys: selectedPatrolRowKeys,
            onChange: setSelectedPatrolRowKeys,
            getCheckboxProps: (run) => ({ disabled: run.status === 'running' }),
            preserveSelectedRowKeys: true,
          }}
          locale={{ emptyText: <Empty description="暂无自动巡检日志" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
          scroll={{ x: 1280 }}
          expandable={{
            expandedRowRender: (run) => <PatrolEvidenceDetail runId={run.id} />,
            rowExpandable: (run) => run.status === 'completed' || run.status === 'failed',
          }}
          columns={[
            {
              title: '渠道',
              dataIndex: 'name',
              width: 260,
              render: (_, run) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>{channelLabel(run.patrol_channel_name, run.patrol_channel_id)}</Typography.Text>
                  <Typography.Text type="secondary">{patrolRunTitle(run)}</Typography.Text>
                </Space>
              ),
            },
            {
              title: '巡检结果',
              width: 140,
              render: (_, run) => <PatrolEvidenceCell run={run} />,
            },
            {
              title: '复审',
              width: 130,
              render: (_, run) => <PatrolReviewCell run={run} />,
            },
            {
              title: '计划',
              dataIndex: 'scheduled_test_id',
              width: 220,
              render: (value: string | null | undefined) => value ?? '-',
            },
            { title: '创建时间', dataIndex: 'created_at', width: 190, render: formatDateTime },
            { title: '结束时间', dataIndex: 'finished_at', width: 190, render: formatDateTime },
            {
              title: '操作',
              width: 250,
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
