import { useEffect, useMemo, useState, type Key } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Pagination, Popconfirm, Select, Space, Spin, Table, Tag, Tooltip, Typography, message } from 'antd';
import { Link } from 'react-router-dom';
import { CalendarClock, CircleStop, GitCompare, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { ALL_PATROL_CHANNELS, buildPatrolDeleteSummary, deletablePatrolRunIds, extractPatrolEvidence, extractSignatureAnomalyRunIds, formatPatrolChannel, isPatrolOperationalFailure, patrolEvidenceDisplayState, patrolProbeStatusColor, patrolProbeStatusText, patrolReportedLabels, resolvePatrolPage, type PatrolEvidence } from '../runsUtils';
import { formatDateTime } from '../time';
import type { Channel, PatrolAnomalyGroup, Run } from '../types';

function canCancel(status: Run['status']) {
  return status === 'pending' || status === 'running';
}

function isTerminalRun(status: Run['status']) {
  return status !== 'pending' && status !== 'running';
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

function PatrolIdText({ value }: { value?: string | null }) {
  const shortValue = compactId(value);
  const content = <Typography.Text className="patrol-log-id">{shortValue}</Typography.Text>;
  return value && shortValue !== value ? <Tooltip title={value}>{content}</Tooltip> : content;
}

function PatrolGlobalAnomalyAlert({
  title,
  group,
}: {
  title: string;
  group?: PatrolAnomalyGroup;
}) {
  if (!group?.count) return null;
  const remaining = Math.max(0, group.count - group.items.length);
  return (
    <Alert
      type="error"
      showIcon
      message={`${title}（${group.count}）`}
      description={(
        <Space wrap size={[12, 4]}>
          {group.items.map((item) => (
            <Link key={item.run_id} to={`/runs/${item.run_id}`}>
              {item.run_name}{item.channel_name ? ` · ${item.channel_name}` : ''}
            </Link>
          ))}
          {remaining ? <Typography.Text type="secondary">另有 {remaining} 条</Typography.Text> : null}
        </Space>
      )}
    />
  );
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

function patrolResultState(evidence: PatrolEvidence) {
  return patrolEvidenceDisplayState(evidence).displayState;
}

// Per-probe sub-status chips so a row shows at a glance which module failed.
type PatrolProbeChip = { key: string; label: string; state: 'ok' | 'error'; detail?: string };

function patrolIdentityJsonSummary(item: PatrolEvidence['modelRequests'][number]) {
  if (item.key !== 'identity_blind_json') return '-';
  const fields = item.identityJsonFields ?? {};
  const value = (key: 'vendor' | 'product' | 'model') => fields[key] === '' ? '空' : fields[key] ?? '-';
  return `${item.identityJsonStatus ?? '-'} / ${item.identityJsonFormat ?? '-'} · vendor=${value('vendor')} · product=${value('product')} · model=${value('model')}`;
}

function patrolProbeChips(evidence: PatrolEvidence): PatrolProbeChip[] {
  const chips: PatrolProbeChip[] = [];
  if (evidence.signature) {
    const failed = (evidence.signature.status === 'fail' || evidence.signature.status === 'error')
      && !isPatrolOperationalFailure(evidence.signature);
    chips.push({
      key: 'signature',
      label: 'Signature',
      state: failed ? 'error' : 'ok',
      detail: evidence.signature.reason ?? undefined,
    });
  }
  for (const item of evidence.modelRequests) {
    const failed = !isPatrolOperationalFailure(item) && (item.status === 'error' || item.status === 'fail' || Boolean(item.error)
      || item.labels.some((label) => label !== 'provider_error_variant'));
    chips.push({
      key: item.key ?? item.resultId ?? item.title ?? `probe-${chips.length}`,
      label: item.title ?? item.key ?? '真实请求',
      state: failed ? 'error' : 'ok',
      detail: item.error ?? (item.labels.length ? item.labels.join('、') : undefined),
    });
  }
  return chips;
}

// Concise human-readable reason for an abnormal patrol result.
function patrolFailureReason(evidence: PatrolEvidence): string {
  const reasons: string[] = [];
  if ((evidence.signature?.status === 'fail' || evidence.signature?.status === 'error') && !isPatrolOperationalFailure(evidence.signature)) {
    reasons.push(evidence.signature.reason ?? 'Signature 互通检测未通过');
  }
  for (const item of evidence.modelRequests) {
    const failed = !isPatrolOperationalFailure(item) && (item.status === 'error' || item.status === 'fail' || Boolean(item.error)
      || item.labels.some((label) => label !== 'provider_error_variant'));
    if (!failed) continue;
    const title = item.title ?? item.key ?? '真实请求探针';
    const detail = item.error ?? item.responseText ?? item.rawResponseText
      ?? (item.labels.length ? item.labels.filter((label) => label !== 'provider_error_variant').join('、') : '');
    reasons.push(detail ? `${title}：${detail}` : `${title} 异常`);
  }
  const blockingLabels = evidence.labels.filter((label) => {
    if (label === 'patrol_probe_passed' || label === 'provider_error_variant') return false;
    if (isPatrolOperationalFailure({ labels: [label] })) return false;
    if (label === 'identity_probe_failed' && patrolEvidenceDisplayState(evidence).isOperationalFailure) return false;
    return true;
  });
  for (const label of blockingLabels) {
    reasons.push(evidence.labelExplanations[label] ?? label);
  }
  return reasons.join('；') || '渠道自动巡检异常';
}

function patrolClassificationLabel(evidence: PatrolEvidence) {
  if (evidence.classificationStatus === 'claude') return evidence.classificationLabel || 'Claude 资源';
  if (evidence.classificationStatus === 'aws_resource') return evidence.classificationLabel || 'AWS 资源';
  return '';
}

function patrolChannelAndTask(run: Run) {
  const channelLabel = formatPatrolChannel(
    {
      id: run.patrol_channel_id,
      name: run.patrol_channel_name,
      accountType: run.patrol_channel_account_type,
      providerType: run.patrol_channel_provider_type,
    },
    run.patrol_channel_id,
  );
  const hasChannel = Boolean(channelLabel) && channelLabel !== '-';
  const display = hasChannel ? channelLabel : (run.patrol_channel_name || run.patrol_channel_id || '-');
  const taskName = hasChannel && run.name.startsWith(`${channelLabel} - `)
    ? run.name.slice(channelLabel.length + 3)
    : run.name;
  return { channelLabel: display, taskName };
}

function PatrolEvidenceCell({ run }: { run: Run }) {
  if (run.status === 'pending' || run.status === 'running') {
    return <Typography.Text type="secondary">等待巡检完成</Typography.Text>;
  }
  if (!run.has_evidence) {
    return <Typography.Text type="secondary">暂无巡检证据</Typography.Text>;
  }
  return <Tag color={run.display_state === 'error' ? 'red' : 'green'}>{run.display_state === 'error' ? '异常' : '正常'}</Tag>;
}

function PatrolReviewCell({ run }: { run: Run }) {
  if (run.status === 'pending' || run.status === 'running') {
    return <Tag color="default">-</Tag>;
  }
  return run.needs_review ? <Tag color="red">需要复审</Tag> : <Tag color="default">-</Tag>;
}

function PatrolEvidenceSummary({ evidence, compact = false, showProbeDetails = true }: { evidence: PatrolEvidence; compact?: boolean; showProbeDetails?: boolean }) {
  const signature = evidence.signature;
  const resultState = patrolResultState(evidence);
  const primaryRequest = evidence.modelRequests[0];
  if (compact) {
    const classification = patrolClassificationLabel(evidence);
    const primaryLabel = classification || (resultState === 'ok' ? '正确' : '异常');
    const chips = patrolProbeChips(evidence);
    const reason = resultState === 'error' ? patrolFailureReason(evidence) : '';
    return (
      <Tooltip title={reason || '点开展开行或查看巡检详情查看探针日志'}>
        <Space size={[4, 2]} wrap>
          <Tag color={resultState === 'ok' ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>{primaryLabel}</Tag>
          {chips.map((chip) => (
            <Tag
              key={chip.key}
              color={chip.state === 'ok' ? 'green' : 'red'}
              style={{ marginInlineEnd: 0 }}
            >
              {chip.label} {chip.state === 'ok' ? '✓' : '✗'}
            </Tag>
          ))}
        </Space>
      </Tooltip>
    );
  }
  const classification = patrolClassificationLabel(evidence);
  const reportedLabels = patrolReportedLabels(evidence);
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space wrap>
        <Tag color={resultState === 'ok' ? 'green' : 'red'}>{classification || (resultState === 'ok' ? '正确' : '异常')}</Tag>
        {signature ? <Tag color={isPatrolOperationalFailure(signature) ? 'green' : evidenceStatusColor(signature.status)}>Signature {isPatrolOperationalFailure(signature) ? '正常' : signature.status ?? '待确认'}</Tag> : null}
      </Space>
      {primaryRequest ? (
        <Typography.Text type="secondary">
          上游响应 ID（Message ID）：{primaryRequest.messageId ?? '-'} · Request ID：{primaryRequest.requestId ?? '-'}
        </Typography.Text>
      ) : null}
      {resultState === 'error' ? <Typography.Text type="danger">错误需要复审</Typography.Text> : null}
      {showProbeDetails ? (
        <>
          {evidence.detectedProviderHint ? <Typography.Text>{evidence.detectedProviderHint}</Typography.Text> : null}
          <div className="patrol-log-probe-grid">
            {evidence.modelRequests.map((item) => (
              <div className="patrol-log-probe" key={item.key ?? item.resultId ?? item.title ?? 'probe'}>
                <span>{item.title ?? item.key ?? '真实请求探针'}</span>
                <Tag color={patrolProbeStatusColor(item)}>{patrolProbeStatusText(item)}</Tag>
                <small>{formatPatrolChannel({ id: item.channelId, name: item.channelName, accountType: item.channelAccountType, providerType: item.channelProviderType }, item.channelId)}</small>
                <small>time {formatDateTime(item.completedAt ?? item.createdAt)}</small>
                <small>msg {compact ? compactId(item.messageId) : item.messageId ?? '-'}</small>
                <small>req {compact ? compactId(item.requestId) : item.requestId ?? '-'}</small>
              </div>
            ))}
          </div>
          <Typography.Text type="secondary">
            source: {formatPatrolChannel({ id: signature?.sourceChannelId, name: signature?.sourceChannelName, accountType: signature?.sourceChannelAccountType, providerType: signature?.sourceChannelProviderType }, signature?.sourceChannelId)} / msg {compact ? compactId(signature?.sourceMessageId) : signature?.sourceMessageId ?? '-'} / req {compact ? compactId(signature?.sourceRequestId) : signature?.sourceRequestId ?? '-'} · relay: {formatPatrolChannel({ id: signature?.relayChannelId, name: signature?.relayChannelName, accountType: signature?.relayChannelAccountType, providerType: signature?.relayChannelProviderType }, signature?.relayChannelId)} / msg {compact ? compactId(signature?.relayMessageId) : signature?.relayMessageId ?? '-'} / req {compact ? compactId(signature?.relayRequestId) : signature?.relayRequestId ?? '-'}
          </Typography.Text>
        </>
      ) : null}
      {reportedLabels.length ? (
        <Tooltip title={reportedLabels.map((label) => evidence.labelExplanations[label] ?? label).join('；')}>
          <Space wrap>
            {reportedLabels.map((label) => <Tag color="red" key={label}>{label}</Tag>)}
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
    <Space direction="vertical" size={8} style={{ width: '100%' }} className="patrol-evidence-detail">
      <PatrolEvidenceSummary evidence={evidence} showProbeDetails={false} />
      <Table
        className="patrol-evidence-detail-table"
        rowKey={(item) => item.key ?? item.title ?? item.resultId ?? item.messageId ?? 'model-request'}
        size="small"
        pagination={false}
        dataSource={evidence.modelRequests}
        scroll={{ x: 1450 }}
        columns={[
          { title: '真实请求探针', width: 160, render: (_, item) => item.title ?? item.key ?? '真实模型请求' },
          { title: '渠道', width: 180, render: (_, item) => formatPatrolChannel({ id: item.channelId, name: item.channelName, accountType: item.channelAccountType, providerType: item.channelProviderType }, item.channelId) },
          { title: '状态', width: 84, render: (_, item) => <Tag color={patrolProbeStatusColor(item)}>{patrolProbeStatusText(item)}</Tag> },
          { title: 'HTTP', dataIndex: 'httpStatus', width: 72, render: (value) => value ?? '-' },
          { title: 'JSON 解析', width: 300, render: (_, item) => <Typography.Text>{patrolIdentityJsonSummary(item)}</Typography.Text> },
          { title: '时间', width: 156, render: (_, item) => formatDateTime(item.completedAt ?? item.createdAt) },
          { title: 'Message ID', dataIndex: 'messageId', width: 126, render: (value) => <PatrolIdText value={value} /> },
          { title: 'Request ID', dataIndex: 'requestId', width: 126, render: (value) => <PatrolIdText value={value} /> },
          { title: '渠道类型', dataIndex: 'messageChannelType', width: 132, render: (value) => value ?? '-' },
          { title: '协议', dataIndex: 'requestProtocol', width: 104, render: (value) => value ?? '-' },
          {
            title: '响应/错误内容',
            width: 260,
            render: (_, item) => (
              <Tooltip title={item.responseText || item.rawResponseText || undefined}>
                <Typography.Text>{compactText(item.responseText ?? item.rawResponseText, 180)}</Typography.Text>
              </Tooltip>
            ),
          },
          {
            title: '标签',
            width: 170,
            render: (_, item) => item.labels.length ? <Space wrap size={[4, 2]}>{item.labels.map((label) => <Tag color="red" key={label}>{label}</Tag>)}</Space> : '-',
          },
          {
            title: '错误',
            dataIndex: 'error',
            width: 160,
            render: (value) => value ? (
              <Tooltip title={value}>
                <Typography.Text>{compactText(value, 120)}</Typography.Text>
              </Tooltip>
            ) : '-',
          },
        ]}
      />
      {evidence.signature ? (
        <Space direction="vertical" size={2} className="patrol-signature-summary">
          <Typography.Text strong>Thinking Signature 互通</Typography.Text>
          <Typography.Text type="secondary">
            time: {formatDateTime(evidence.signature.completedAt ?? evidence.signature.createdAt)}
          </Typography.Text>
          <Typography.Text type="secondary">
            source: {formatPatrolChannel({ id: evidence.signature.sourceChannelId, name: evidence.signature.sourceChannelName, accountType: evidence.signature.sourceChannelAccountType, providerType: evidence.signature.sourceChannelProviderType }, evidence.signature.sourceChannelId)} / msg <PatrolIdText value={evidence.signature.sourceMessageId} /> / req <PatrolIdText value={evidence.signature.sourceRequestId} /> / {evidence.signature.sourceMessageChannelType ?? '-'}
          </Typography.Text>
          <Typography.Text type="secondary">
            relay: {formatPatrolChannel({ id: evidence.signature.relayChannelId, name: evidence.signature.relayChannelName, accountType: evidence.signature.relayChannelAccountType, providerType: evidence.signature.relayChannelProviderType }, evidence.signature.relayChannelId)} / msg <PatrolIdText value={evidence.signature.relayMessageId} /> / req <PatrolIdText value={evidence.signature.relayRequestId} /> / {evidence.signature.relayMessageChannelType ?? '-'}
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
  const [selectedPatrolRowKeys, setSelectedPatrolRowKeys] = useState<Key[]>([]);
  const [selectedPatrolChannel, setSelectedPatrolChannel] = useState(ALL_PATROL_CHANNELS);
  const [onlyPatrolErrors, setOnlyPatrolErrors] = useState(false);
  const [patrolPage, setPatrolPage] = useState(1);
  const [patrolPageSize, setPatrolPageSize] = useState(10);
  const patrolQuery = useQuery({
    queryKey: ['patrolRuns', patrolPage, patrolPageSize, selectedPatrolChannel, onlyPatrolErrors],
    queryFn: () => api.patrolRuns({
      page: patrolPage,
      page_size: patrolPageSize,
      channel_id: selectedPatrolChannel === ALL_PATROL_CHANNELS ? undefined : selectedPatrolChannel,
      errors_only: onlyPatrolErrors,
    }),
    refetchInterval: (query) => (query.state.data?.items.some((run) => run.status === 'pending' || run.status === 'running') ? 2500 : false),
  });
  const patrolAnomaliesQuery = useQuery({
    queryKey: ['patrolAnomalies', selectedPatrolChannel],
    queryFn: () => api.patrolAnomalies({
      channel_id: selectedPatrolChannel === ALL_PATROL_CHANNELS ? undefined : selectedPatrolChannel,
    }),
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });
  const channelsQuery = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.channels(),
    staleTime: 5 * 60 * 1000,
  });

  const remove = useMutation({
    mutationFn: api.deleteRun,
    onSuccess: async (_, runId) => {
      message.success('任务已删除');
      setSelectedPatrolRowKeys((keys) => keys.filter((key) => key !== runId));
      await queryClient.invalidateQueries({ queryKey: ['patrolRuns'] });
      await queryClient.invalidateQueries({ queryKey: ['patrolAnomalies'] });
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
    onSettled: () => setDeletingId(null),
  });
  const deletePatrolRuns = useMutation({
    mutationFn: api.deleteRuns,
    onSuccess: (result, requestedIds) => {
      const failed = Object.keys(result.failed).length;
      message.success(failed ? `已删除 ${result.deleted} 条日志，${failed} 条删除失败` : `已删除 ${result.deleted} 条日志`);
      if (failed) {
        message.warning(`未删除原因：${Object.entries(result.failed).map(([id, reason]) => `${id}: ${reason}`).join('；')}`);
      }
      setSelectedPatrolRowKeys([]);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['patrolRuns'] }),
        queryClient.invalidateQueries({ queryKey: ['patrolAnomalies'] }),
        queryClient.invalidateQueries({ queryKey: ['reports'] }),
      ]);
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });
  const cancel = useMutation({
    mutationFn: api.cancelRun,
    onSuccess: async () => {
      message.success('任务已取消');
      await queryClient.invalidateQueries({ queryKey: ['patrolRuns'] });
      await queryClient.invalidateQueries({ queryKey: ['patrolAnomalies'] });
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

  const patrolRuns = patrolQuery.data?.items ?? [];
  const patrolAnomalySummary = patrolAnomaliesQuery.isError ? undefined : patrolAnomaliesQuery.data;
  const signatureAnomalyRunIds = useMemo(
    () => extractSignatureAnomalyRunIds(patrolAnomalySummary?.invalid_thinking_signature),
    [patrolAnomalySummary?.invalid_thinking_signature],
  );
  const patrolChannelOptions = useMemo(() => {
    const options = (channelsQuery.data ?? []).map((channel: Channel) => ({
      value: channel.id,
      label: formatPatrolChannel({ id: channel.id, name: channel.name, providerType: channel.provider_type, accountType: channel.auth_config?.account_type }, channel.id) || channel.name,
    }));
    return [{ value: ALL_PATROL_CHANNELS, label: '全部渠道' }, ...options.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))];
  }, [channelsQuery.data]);
  const filteredPatrolRuns = patrolRuns;
  const errorPatrolRunCount = patrolQuery.data?.error_count ?? 0;
  const visiblePatrolRuns = patrolRuns;
  const selectedPatrolRuns = useMemo(
    () => filteredPatrolRuns.filter((run) => selectedPatrolRowKeys.includes(run.id)),
    [filteredPatrolRuns, selectedPatrolRowKeys],
  );
  const deletableSelectedPatrolRuns = selectedPatrolRuns.filter((run) => isTerminalRun(run.status));
  const selectedPatrolChannelLabel = useMemo(
    () => patrolChannelOptions.find((option) => option.value === selectedPatrolChannel)?.label ?? '当前渠道',
    [patrolChannelOptions, selectedPatrolChannel],
  );
  const patrolDeleteSummary = useMemo(
    () => buildPatrolDeleteSummary({
      selectedRuns: selectedPatrolRuns,
      selectedRowCount: selectedPatrolRowKeys.length,
      filteredDeletableCount: patrolQuery.data?.deletable_count ?? 0,
      selectedChannel: selectedPatrolChannel,
      selectedChannelLabel: selectedPatrolChannelLabel,
      onlyErrors: onlyPatrolErrors,
    }),
    [onlyPatrolErrors, patrolQuery.data?.deletable_count, selectedPatrolChannel, selectedPatrolChannelLabel, selectedPatrolRowKeys.length, selectedPatrolRuns],
  );

  useEffect(() => {
    const patrolIds = new Set(filteredPatrolRuns.map((run) => run.id));
    setSelectedPatrolRowKeys((keys) => {
      const next = keys.filter((key) => patrolIds.has(String(key)));
      return next.length === keys.length ? keys : next;
    });
  }, [filteredPatrolRuns]);

  useEffect(() => {
    if (!patrolQuery.data) return;
    setPatrolPage((page) => resolvePatrolPage({
      requestedPage: page,
      responsePage: patrolQuery.data.page,
      total: patrolQuery.data.total,
      pageSize: patrolPageSize,
      isFetching: patrolQuery.isFetching,
    }));
  }, [patrolPageSize, patrolQuery.data, patrolQuery.isFetching]);

  function deleteSelectedPatrolRuns() {
    if (!selectedPatrolRowKeys.length) {
      message.warning('请先选择巡检日志');
      return;
    }
    if (!deletableSelectedPatrolRuns.length) {
      message.warning('未结束的巡检日志不能删除');
      return;
    }
    deletePatrolRuns.mutate(deletableSelectedPatrolRuns.map((run) => run.id));
  }

  async function deleteAllPatrolRuns() {
    const query = {
      page: 1,
      page_size: 100,
      channel_id: selectedPatrolChannel === ALL_PATROL_CHANNELS ? undefined : selectedPatrolChannel,
      errors_only: onlyPatrolErrors,
    };
    const firstPage = await api.patrolRuns(query);
    const allFilteredRuns = [...firstPage.items];
    for (let page = 2; allFilteredRuns.length < firstPage.total; page += 1) {
      const nextPage = await api.patrolRuns({ ...query, page });
      allFilteredRuns.push(...nextPage.items);
      if (!nextPage.items.length) break;
    }
    const deletable = deletablePatrolRunIds(allFilteredRuns);
    if (!deletable.length) {
      message.warning('暂无可删除的巡检日志');
      return;
    }
    deletePatrolRuns.mutate(deletable);
  }

  return (
    <div className="page-stack">
      <Space wrap style={{ justifyContent: 'flex-end', width: '100%' }}>
        <Link to="/new-run">
          <Button type="primary" size="large" icon={<GitCompare size={16} />} style={{ height: '40px', fontWeight: 600 }}>
            真实性对比
          </Button>
        </Link>
      </Space>

      <Card
        className="patrol-log-card"
        title={<span className="card-title-with-icon"><CalendarClock size={18} />自动巡检日志</span>}
        extra={(
          <div className="patrol-log-toolbar">
            <div className="patrol-log-toolbar-filters">
              <Select
                allowClear
                value={selectedPatrolChannel}
                onChange={(value) => {
                  setSelectedPatrolChannel(value ?? ALL_PATROL_CHANNELS);
                  setPatrolPage(1);
                }}
                placeholder="全部渠道"
                options={patrolChannelOptions}
                style={{ width: 190 }}
                aria-label="自动巡检日志渠道筛选"
              />
              <Button
                size="small"
                type={onlyPatrolErrors ? 'primary' : 'default'}
                danger={onlyPatrolErrors}
                onClick={() => {
                  setOnlyPatrolErrors((value) => !value);
                  setPatrolPage(1);
                }}
                aria-pressed={onlyPatrolErrors}
                aria-label="只看错误"
              >
                只看错误（{errorPatrolRunCount}）
              </Button>
            </div>
            <div className="patrol-log-toolbar-delete">
              <Tooltip title={patrolDeleteSummary.selectedDisabledReason}>
                <span
                  className="patrol-delete-button-help"
                  data-testid="patrol-delete-selected-help"
                  aria-label={patrolDeleteSummary.selectedDisabledReason ?? undefined}
                  tabIndex={patrolDeleteSummary.selectedDisabledReason ? 0 : -1}
                >
                  <Popconfirm
                    title="删除已选巡检日志"
                    description={`将删除 ${patrolDeleteSummary.selectedDeletableCount} 条已选已结束日志及其结果、报告和关联告警。未结束日志会跳过。确定删除吗？`}
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    disabled={!patrolDeleteSummary.selectedDeletableCount}
                    onConfirm={deleteSelectedPatrolRuns}
                  >
                    <Button
                      size="small"
                      danger
                      icon={<Trash2 size={14} />}
                      aria-label={`删除已选巡检日志（${patrolDeleteSummary.selectedDeletableCount}）`}
                      disabled={!patrolDeleteSummary.selectedDeletableCount}
                      loading={deletePatrolRuns.isPending}
                    >
                      删除已选（{patrolDeleteSummary.selectedDeletableCount}）
                    </Button>
                  </Popconfirm>
                </span>
              </Tooltip>
              <Popconfirm
                title={`删除${patrolDeleteSummary.deleteScopeLabel}中的已结束巡检日志`}
                description={`将删除${patrolDeleteSummary.deleteScopeLabel}中的 ${patrolDeleteSummary.filteredDeletableCount} 条已结束巡检日志及其结果、报告和关联告警。未结束日志会跳过。确定删除吗？`}
                okText="删除当前范围"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                disabled={!patrolDeleteSummary.filteredDeletableCount}
                onConfirm={deleteAllPatrolRuns}
              >
                <Button
                  size="small"
                  danger
                  icon={<Trash2 size={14} />}
                  aria-label={`删除当前范围（${patrolDeleteSummary.filteredDeletableCount}）`}
                  disabled={!patrolDeleteSummary.filteredDeletableCount}
                  loading={deletePatrolRuns.isPending}
                >
                  删除当前范围（{patrolDeleteSummary.filteredDeletableCount}）
                </Button>
              </Popconfirm>
            </div>
          </div>
        )}
        bordered={false}
      >
        <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 12 }}>
          <PatrolGlobalAnomalyAlert title="Kiro 身份泄漏" group={patrolAnomalySummary?.kiro_identity_leak} />
          <PatrolGlobalAnomalyAlert title="Thinking Signature 无效" group={patrolAnomalySummary?.invalid_thinking_signature} />
        </Space>
        <Table
          className="patrol-log-table"
          rowKey="id"
          rowClassName={(run) => signatureAnomalyRunIds.has(run.id) ? 'patrol-signature-anomaly-row' : ''}
          size="small"
          loading={patrolQuery.isLoading}
          dataSource={visiblePatrolRuns}
          rowSelection={{
            selectedRowKeys: selectedPatrolRowKeys,
            onChange: setSelectedPatrolRowKeys,
            getCheckboxProps: (run) => ({ disabled: !isTerminalRun(run.status) }),
            preserveSelectedRowKeys: true,
          }}
          locale={{
            emptyText: (
              <Empty
                description={selectedPatrolChannel === ALL_PATROL_CHANNELS ? '暂无自动巡检日志' : '当前筛选条件下无自动巡检日志'}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ),
          }}
          pagination={false}
          scroll={{ x: 1160 }}
          expandable={{
            expandedRowRender: (run) => <PatrolEvidenceDetail runId={run.id} />,
            rowExpandable: (run) => run.status === 'completed' || run.status === 'failed',
          }}
          columns={[
            {
              title: '渠道',
              dataIndex: 'name',
              width: 220,
              render: (_, run) => {
                const { channelLabel, taskName } = patrolChannelAndTask(run);
                return (
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>{channelLabel}</Typography.Text>
                    <Typography.Text type="secondary">{taskName}</Typography.Text>
                  </Space>
                );
              },
            },
            {
              title: '巡检结果',
              width: 220,
              render: (_, run) => <PatrolEvidenceCell run={run} />,
            },
            {
              title: '复审',
              width: 96,
              render: (_, run) => <PatrolReviewCell run={run} />,
            },
            {
              title: '计划',
              dataIndex: 'scheduled_test_id',
              width: 150,
              render: (value: string | null | undefined) => <PatrolIdText value={value} />,
            },
            { title: '创建时间', dataIndex: 'created_at', width: 156, render: formatDateTime },
            { title: '结束时间', dataIndex: 'finished_at', width: 156, render: formatDateTime },
            {
              title: '操作',
              width: 160,
              render: (_, run) => (
                <Space size={6}>
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
                        size="small"
                        icon={<CircleStop size={14} />}
                        loading={cancelingId === run.id}
                      >
                        取消
                      </Button>
                    </Popconfirm>
                  ) : null}
                  {(
                    <Popconfirm
                      title="删除检测任务"
                      description="会同时删除该任务的结果、对比和报告。确定删除吗？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      disabled={!isTerminalRun(run.status)}
                      onConfirm={() => deleteRun(run)}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<Trash2 size={14} />}
                        loading={deletingId === run.id}
                        disabled={!isTerminalRun(run.status)}
                      >
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              )
            },
          ]}
        />
        {patrolQuery.isError ? (
          <Alert
            type="error"
            showIcon
            message="自动巡检日志加载失败"
            description={getErrorMessage(patrolQuery.error)}
            action={<Button onClick={() => patrolQuery.refetch()}>重试</Button>}
            style={{ marginTop: 12 }}
          />
        ) : null}
        <Pagination
          className="patrol-log-pagination"
          current={patrolPage}
          pageSize={patrolPageSize}
          total={patrolQuery.data?.total ?? 0}
          showSizeChanger
          pageSizeOptions={[10, 20, 50, 100]}
          showTotal={(total) => `共 ${total} 条`}
          onChange={(page, pageSize) => {
            setPatrolPageSize(pageSize);
            setPatrolPage(pageSize !== patrolPageSize ? 1 : page);
          }}
        />
      </Card>
    </div>
  );
}
