import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Checkbox, Drawer, Empty, Form, Input, Popconfirm, Progress, Select, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import { History, Play, ShieldCheck, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { formatChannelDisplayName } from '../channelCredentials';
import { formatDateTime } from '../time';
import type { ClaudeCodeHistoryDetail, ClaudeCodeHistoryItem, ClaudeCodeJobProbe, ClaudeCodeJobStatus, ClaudeCodeProbeResult, ClaudeCodeRelayTestCreate, ClaudeCodeSection, ClaudeCodeSourceChannel, ClaudeCodeTestResult } from '../types';

type RelayFormValues = {
  channel_label?: string;
  base_url: string;
  api_key: string;
  model_name: string;
  provider_type: string;
  request_protocol: string;
  source_channel_id?: string;
  image_url?: string;
  include_expensive_context?: boolean;
};

const SECTION_DESCRIPTIONS: Record<string, string> = {
  fingerprint: '中转扩展字段、拒绝形态和非原生兼容行为，用于识别链路指纹。',
  structure: '响应结构、message 形态、usage、截断和基础协议行为。',
  behavior: '上下文、提示词防泄露以及运行时行为稳定性。',
  signature: 'Thinking signature 以及跨渠道 signature 互通。',
  multimodal: '图片 base64、图片 URL 和文档输入能力。',
  web_capability: 'Anthropic server-side Web Search 支持情况，仅作参考，不参与风险评分。',
};

function statusColor(status: string) {
  if (status === 'pass' || status === 'passed') return 'green';
  if (status === 'fail' || status === 'failed') return 'red';
  if (status === 'warning') return 'orange';
  if (status === 'skipped') return 'default';
  if (status === 'running') return 'processing';
  if (status === 'queued') return 'default';
  return 'blue';
}

function statusLabel(status: string) {
  if (status === 'pass') return '通过';
  if (status === 'fail') return '失败';
  if (status === 'warning') return '警告';
  if (status === 'skipped') return '跳过';
  if (status === 'running') return '运行中';
  if (status === 'queued') return '等待中';
  return status;
}

function riskColor(value?: string) {
  if (value === 'low') return 'green';
  if (value === 'medium') return 'blue';
  if (value === 'high') return 'orange';
  if (value === 'critical') return 'red';
  return 'default';
}

function relayAlertType(result: ClaudeCodeTestResult): 'success' | 'warning' | 'error' {
  if (result.risk_level === 'low' || result.risk_level === 'medium') return 'success';
  if (result.risk_level === 'high') return 'warning';
  return 'error';
}

function probeCounts(probes: ClaudeCodeProbeResult[]) {
  return {
    pass: probes.filter((item) => item.status === 'pass').length,
    fail: probes.filter((item) => item.status === 'fail').length,
    warning: probes.filter((item) => item.status === 'warning').length,
    skipped: probes.filter((item) => item.status === 'skipped').length,
  };
}

function sectionPercent(section: ClaudeCodeSection) {
  if (!section.probe_count) return 0;
  return Math.round((section.pass_count / section.probe_count) * 100);
}

function EmptyProbeValue() {
  return <Typography.Text type="secondary" className="claude-probe-empty">-</Typography.Text>;
}

function ProbeNameCell({ title, probeKey }: { title: string; probeKey: string }) {
  return (
    <div className="claude-probe-name">
      <Typography.Text strong className="claude-probe-title" ellipsis={{ tooltip: title }}>{title}</Typography.Text>
      <Typography.Text type="secondary" className="claude-probe-key" ellipsis={{ tooltip: probeKey }}>{probeKey}</Typography.Text>
    </div>
  );
}

function LatencyCell({ value }: { value?: number | null }) {
  if (typeof value !== 'number') return <EmptyProbeValue />;
  return (
    <Typography.Text className="claude-probe-latency" type={value > 5000 ? 'warning' : undefined}>
      <span>{value}</span>
      <span>ms</span>
    </Typography.Text>
  );
}

function ProbeTable({ probes }: { probes: ClaudeCodeProbeResult[] }) {
  return (
    <Table<ClaudeCodeProbeResult>
      className="claude-probe-table"
      rowKey="key"
      dataSource={probes}
      pagination={false}
      size="small"
      scroll={{ x: 980 }}
      columns={[
        {
          title: '测试项',
          width: 260,
          render: (_, item) => <ProbeNameCell title={item.title} probeKey={item.key} />,
        },
        { title: '结果', dataIndex: 'status', width: 82, render: (value: string) => <Tag color={statusColor(value)}>{statusLabel(value)}</Tag> },
        { title: '权重', dataIndex: 'severity', width: 74, render: (value: string) => <Tag>{value}</Tag> },
        { title: '分数', dataIndex: 'score', width: 64 },
        {
          title: '延迟',
          width: 112,
          render: (_, item) => <LatencyCell value={item.latency_ms} />,
        },
        {
          title: 'Message / Request',
          width: 150,
          render: (_, item) => {
            const rows = [
              item.message_id ? (
                <Typography.Text key="message" className="claude-probe-id" copyable={{ text: item.message_id }} ellipsis={{ tooltip: item.message_id }}>
                  {item.message_id}
                </Typography.Text>
              ) : null,
              item.request_id ? (
                <Typography.Text key="request" type="secondary" className="claude-probe-id" copyable={{ text: item.request_id }} ellipsis={{ tooltip: item.request_id }}>
                  {item.request_id}
                </Typography.Text>
              ) : null,
            ].filter(Boolean);
            return rows.length ? <Space direction="vertical" size={0} className="claude-probe-id-stack">{rows}</Space> : <EmptyProbeValue />;
          },
        },
        {
          title: '标签',
          width: 140,
          render: (_, item) => item.labels.length ? (
            <Space size={[4, 4]} wrap className="claude-probe-tags">
              {item.labels.map((label) => <Tag key={label} color="orange" className="claude-probe-tag" title={label}>{label}</Tag>)}
            </Space>
          ) : <EmptyProbeValue />,
        },
        {
          title: '证据摘要',
          dataIndex: 'evidence_excerpt',
          width: 300,
          render: (value: string | null | undefined) => value ? <Typography.Text className="claude-probe-evidence" ellipsis={{ tooltip: value }}>{value}</Typography.Text> : <EmptyProbeValue />,
        },
      ]}
    />
  );
}

function JobProbeTable({ probes, currentKey }: { probes: ClaudeCodeJobProbe[]; currentKey?: string | null }) {
  return (
    <Table<ClaudeCodeJobProbe>
      rowKey="key"
      dataSource={probes}
      pagination={false}
      size="small"
      rowClassName={(item) => item.key === currentKey ? 'claude-job-row-active' : ''}
      columns={[
        {
          title: '测试项',
          width: 260,
          render: (_, item) => <ProbeNameCell title={item.title} probeKey={item.key} />,
        },
        { title: '状态', dataIndex: 'status', width: 110, render: (value: string) => <Tag color={statusColor(value)}>{statusLabel(value)}</Tag> },
        { title: '分数', dataIndex: 'score', width: 90 },
        {
          title: '延迟',
          width: 112,
          render: (_, item) => <LatencyCell value={item.latency_ms} />,
        },
        {
          title: '摘要',
          width: 420,
          render: (_, item) => <Typography.Text ellipsis={{ tooltip: item.evidence_excerpt || item.detail || undefined }}>{item.evidence_excerpt || item.detail || '-'}</Typography.Text>,
        },
      ]}
    />
  );
}

function probeDiagnosis(item: { status: string; labels?: string[]; evidence_excerpt?: string | null }) {
  if (item.status === 'pass') return '测试通过，模型正确处理了该类输入。';
  if (item.labels?.includes('request_failed')) return '请求被上游直接拒绝，优先检查该通道是否接受此类多模态请求体。';
  if (item.labels?.includes('regex_keypoint_missing')) return '模型没有真正读到图片内容，更像把这次请求当成普通文本对话处理。';
  if (item.labels?.some((label) => label.startsWith('missing:'))) return '模型返回了文字说明，但没有命中文档 marker，说明文档输入未按预期生效。';
  return item.evidence_excerpt || '需要结合原始返回继续判断该通道的多模态兼容性。';
}

type MultimodalProbe = ClaudeCodeProbeResult | ClaudeCodeJobProbe;

function MultimodalInputCell({ probe }: { probe: MultimodalProbe }) {
  const preview = probe.input_preview;
  if (!preview) return <EmptyProbeValue />;
  const imageSrc = preview.image_data_url || preview.default_image_url || null;
  const url = preview.actual_image_url || preview.default_image_url || null;
  const documentExcerpt = preview.document_text ? preview.document_text.replace(/\s+/g, ' ').trim() : null;
  const kindLabel = preview.kind === 'image_base64'
    ? 'base64 图片'
    : preview.kind === 'image_url'
      ? 'URL 图片'
      : preview.kind === 'document_text'
        ? '文档输入'
        : preview.kind;
  return (
    <div className="claude-multimodal-input-cell">
      {imageSrc ? <img className="claude-multimodal-thumb" src={imageSrc} alt={preview.title} /> : null}
      <div className="claude-multimodal-input-copy">
        <Typography.Text strong ellipsis={{ tooltip: preview.title }}>{preview.title}</Typography.Text>
        <Typography.Text type="secondary" className="claude-multimodal-kind">{kindLabel}</Typography.Text>
        {preview.summary ? <Typography.Text type="secondary" ellipsis={{ tooltip: preview.summary }}>{preview.summary}</Typography.Text> : null}
        {url ? <Typography.Text className="claude-multimodal-url" copyable={{ text: url }} ellipsis={{ tooltip: url }}>{url}</Typography.Text> : null}
        {preview.document_marker ? <Tag color="blue" className="claude-multimodal-marker">{preview.document_marker}</Tag> : null}
        {documentExcerpt ? (
          <Typography.Text className="claude-multimodal-doc-snippet" ellipsis={{ tooltip: preview.document_text || documentExcerpt }}>
            {documentExcerpt}
          </Typography.Text>
        ) : null}
      </div>
    </div>
  );
}

function MultimodalProbeTable({ probes, currentKey }: { probes: MultimodalProbe[]; currentKey?: string | null }) {
  return (
    <Table<MultimodalProbe>
      className="claude-probe-table claude-multimodal-table"
      rowKey="key"
      dataSource={probes}
      pagination={false}
      size="small"
      tableLayout="fixed"
      rowClassName={(item) => item.key === currentKey ? 'claude-job-row-active' : ''}
      scroll={{ x: 1484 }}
      columns={[
        {
          title: '测试项',
          width: 220,
          render: (_, item) => <ProbeNameCell title={item.title} probeKey={item.key} />,
        },
        { title: '结果', dataIndex: 'status', width: 86, render: (value: string) => <Tag color={statusColor(value)}>{statusLabel(value)}</Tag> },
        {
          title: '权重',
          width: 74,
          render: (_, item) => item.severity ? <Tag>{item.severity}</Tag> : <EmptyProbeValue />,
        },
        { title: '分数', dataIndex: 'score', width: 64 },
        {
          title: '延迟',
          width: 112,
          render: (_, item) => <LatencyCell value={item.latency_ms} />,
        },
        {
          title: '输入内容',
          width: 340,
          render: (_, item) => <MultimodalInputCell probe={item} />,
        },
        {
          title: 'Message / Request',
          width: 150,
          render: (_, item) => {
            const rows = [
              item.message_id ? (
                <Typography.Text key="message" className="claude-probe-id" copyable={{ text: item.message_id }} ellipsis={{ tooltip: item.message_id }}>
                  {item.message_id}
                </Typography.Text>
              ) : null,
              item.request_id ? (
                <Typography.Text key="request" type="secondary" className="claude-probe-id" copyable={{ text: item.request_id }} ellipsis={{ tooltip: item.request_id }}>
                  {item.request_id}
                </Typography.Text>
              ) : null,
            ].filter(Boolean);
            return rows.length ? <Space direction="vertical" size={0} className="claude-probe-id-stack">{rows}</Space> : <EmptyProbeValue />;
          },
        },
        {
          title: '标签',
          width: 140,
          render: (_, item) => item.labels.length ? (
            <Space size={[4, 4]} wrap className="claude-probe-tags">
              {item.labels.map((label) => <Tag key={label} color="orange" className="claude-probe-tag" title={label}>{label}</Tag>)}
            </Space>
          ) : <EmptyProbeValue />,
        },
        {
          title: '证据摘要',
          width: 320,
          render: (_, item) => {
            const detail = item.evidence_excerpt || ('detail' in item ? item.detail : null) || probeDiagnosis(item);
            return detail ? <Typography.Text className="claude-probe-evidence" ellipsis={{ tooltip: detail }}>{detail}</Typography.Text> : <EmptyProbeValue />;
          },
        },
      ]}
    />
  );
}

function ClaudeCodeResultView({ result, meta }: { result: ClaudeCodeTestResult; meta?: ClaudeCodeHistoryDetail | null }) {
  const allCounts = probeCounts(result.probes ?? []);
  return (
    <Space direction="vertical" size={18} className="full-width">
      {meta ? (
        <Alert
          type="info"
          showIcon
          message={`历史证据 · ${meta.channel_label}`}
          description={`保存于 ${meta.created_at ? formatDateTime(meta.created_at) : '-'}，Base URL ${meta.base_url}`}
        />
      ) : null}
      <Alert
        type={relayAlertType(result)}
        showIcon
        message={(
          <Space wrap>
            <span>{meta ? '历史检测结果' : '检测完成'}</span>
            <Tag color={riskColor(result.risk_level)}>风险 {result.risk_level}</Tag>
            <Tag color={result.ok ? 'green' : 'red'}>得分 {result.score}</Tag>
          </Space>
        )}
        description={result.summary}
      />
      <div className="signature-sim-grid">
        <Card bordered={false}><Statistic title="通过" value={allCounts.pass} valueStyle={{ color: '#15803d' }} /></Card>
        <Card bordered={false}><Statistic title="失败" value={allCounts.fail} valueStyle={{ color: '#b91c1c' }} /></Card>
        <Card bordered={false}><Statistic title="警告" value={allCounts.warning} valueStyle={{ color: '#c2410c' }} /></Card>
        <Card bordered={false}><Statistic title="跳过" value={allCounts.skipped} /></Card>
      </div>
      <div className="claude-section-grid">
        {(result.sections ?? []).map((section: ClaudeCodeSection) => (
          <Card key={section.key} bordered={false} className="claude-section-card">
            <Space direction="vertical" size={10} className="full-width">
              <Space wrap className="claude-section-card-head">
                <Typography.Text strong>{section.title}</Typography.Text>
                <Tag color={statusColor(section.status)}>{statusLabel(section.status)}</Tag>
                <Tag>得分 {section.score}</Tag>
              </Space>
              <Typography.Text type="secondary">{SECTION_DESCRIPTIONS[section.key] ?? '检测板块'}</Typography.Text>
              <Progress percent={sectionPercent(section)} size="small" showInfo={false} status={section.status === 'fail' ? 'exception' : 'normal'} />
              <Space wrap size={[6, 6]}>
                <Tag color="green">通过 {section.pass_count}</Tag>
                <Tag color="red">失败 {section.fail_count}</Tag>
                <Tag color="orange">警告 {section.warning_count}</Tag>
                <Tag>跳过 {section.skipped_count}</Tag>
              </Space>
            </Space>
          </Card>
        ))}
      </div>
      {(result.sections ?? []).map((section: ClaudeCodeSection) => {
        const probes = section.probes ?? [];
        return (
          <Card
            key={section.key}
            title={(
              <Space wrap>
                <span>{section.title}</span>
                <Tag color={statusColor(section.status)}>{statusLabel(section.status)}</Tag>
                <Tag color="green">通过 {section.pass_count}</Tag>
                <Tag color="red">失败 {section.fail_count}</Tag>
                <Tag color="orange">警告 {section.warning_count}</Tag>
                <Tag>得分 {section.score}</Tag>
              </Space>
            )}
            bordered={false}
          >
            <Typography.Paragraph type="secondary">{SECTION_DESCRIPTIONS[section.key] ?? '检测板块'}</Typography.Paragraph>
            {section.key === 'multimodal' ? <MultimodalProbeTable probes={probes} /> : <ProbeTable probes={probes} />}
          </Card>
        );
      })}
    </Space>
  );
}

function HistoryCard({
  item,
  selected,
  deleting,
  onSelect,
  onDelete,
}: {
  item: ClaudeCodeHistoryItem;
  selected: boolean;
  deleting: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <Card bordered size="small" className={selected ? 'claude-history-card claude-history-card-active' : 'claude-history-card'}>
      <Space direction="vertical" size={10} className="full-width">
        <Space wrap>
          <Typography.Text strong>{item.model_name}</Typography.Text>
          <Tag color={riskColor(item.risk_level)}>{item.risk_level}</Tag>
          <Tag color={item.ok ? 'green' : 'red'}>{item.score}</Tag>
        </Space>
        <Typography.Text type="secondary">{item.channel_label}</Typography.Text>
        <Typography.Text ellipsis={{ tooltip: item.base_url }}>{item.base_url}</Typography.Text>
        <Typography.Text type="secondary">{item.created_at ? formatDateTime(item.created_at) : '-'}</Typography.Text>
        <Space wrap>
          <Tag color="red">失败 {item.fail_count}</Tag>
          <Tag color="orange">警告 {item.warning_count}</Tag>
          <Tag>总项 {item.probe_count}</Tag>
        </Space>
        <Typography.Paragraph type="secondary" ellipsis={{ rows: 2, tooltip: item.summary || undefined }} style={{ marginBottom: 0 }}>
          {item.summary || '无摘要'}
        </Typography.Paragraph>
        <Space wrap>
          <Button size="small" onClick={onSelect}>查看证据</Button>
          <Popconfirm
            title="删除 ClaudeCode 历史"
            description="只会删除这条证据快照，不影响渠道或其它报告。确定删除吗？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={onDelete}
          >
            <Button size="small" danger icon={<Trash2 size={14} />} loading={deleting}>删除</Button>
          </Popconfirm>
        </Space>
      </Space>
    </Card>
  );
}

export default function ClaudeCodeCheck() {
  const [relayForm] = Form.useForm<RelayFormValues>();
  const [relayResult, setRelayResult] = useState<ClaudeCodeTestResult | null>(null);
  const [relayJobId, setRelayJobId] = useState<string | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [deletingHistoryId, setDeletingHistoryId] = useState<string | null>(null);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyRiskFilter, setHistoryRiskFilter] = useState('all');
  const [historyMatchCurrent, setHistoryMatchCurrent] = useState(false);
  const watchedChannelLabel = Form.useWatch('channel_label', relayForm);
  const watchedBaseUrl = Form.useWatch('base_url', relayForm);

  const sources = useQuery<ClaudeCodeSourceChannel[]>({ queryKey: ['claudeCodeSourceChannels'], queryFn: api.claudeCodeSourceChannels });
  const history = useQuery<ClaudeCodeHistoryItem[]>({ queryKey: ['claudeCodeHistory'], queryFn: api.claudeCodeHistory });
  const historyDetail = useQuery<ClaudeCodeHistoryDetail>({
    queryKey: ['claudeCodeHistoryDetail', selectedHistoryId],
    queryFn: () => api.claudeCodeHistoryDetail(selectedHistoryId!),
    enabled: Boolean(selectedHistoryId),
  });
  const relayJob = useQuery<ClaudeCodeJobStatus>({
    queryKey: ['claudeCodeRelayJob', relayJobId],
    queryFn: () => api.claudeCodeRelayTestJob(relayJobId!),
    enabled: Boolean(relayJobId),
    refetchInterval: (query) => {
      const payload = query.state.data;
      return payload && (payload.status === 'completed' || payload.status === 'failed') ? false : 1000;
    },
  });

  const referenceOptions = useMemo(
    () => (sources.data ?? []).map((channel) => ({
      value: channel.id,
      label: `${formatChannelDisplayName({ id: channel.id, name: channel.name, provider_type: channel.provider_type ?? undefined, auth_config: { account_type: channel.account_type ?? undefined } })} · ${channel.model_name || '未配置模型'}`,
    })),
    [sources.data],
  );
  const filteredHistory = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    const currentLabel = String(watchedChannelLabel || '').trim().toLowerCase();
    const currentBaseUrl = String(watchedBaseUrl || '').trim().toLowerCase();
    return (history.data ?? []).filter((item) => {
      const haystack = [item.channel_label, item.base_url, item.model_name, item.provider_type, item.summary].join(' ').toLowerCase();
      if (query && !haystack.includes(query)) return false;
      if (historyRiskFilter !== 'all' && item.risk_level !== historyRiskFilter) return false;
      if (historyMatchCurrent) {
        if (!currentLabel && !currentBaseUrl) return false;
        const sameLabel = currentLabel ? item.channel_label.toLowerCase() === currentLabel : false;
        const sameBaseUrl = currentBaseUrl ? item.base_url.toLowerCase() === currentBaseUrl : false;
        if (!sameLabel && !sameBaseUrl) return false;
      }
      return true;
    });
  }, [history.data, historyMatchCurrent, historyQuery, historyRiskFilter, watchedBaseUrl, watchedChannelLabel]);

  useEffect(() => {
    const payload = relayJob.data;
    if (!payload) return;
    if (payload.status === 'completed' && payload.result) {
      setRelayResult(payload.result as ClaudeCodeTestResult);
      setSelectedHistoryId(null);
      void history.refetch();
      message.success('ClaudeCode 中转检测完成，证据已保存');
    } else if (payload.status === 'failed' && payload.error) {
      message.error(payload.error);
    }
  }, [relayJob.data, history]);

  const runRelayTest = useMutation({
    mutationFn: (values: RelayFormValues) => {
      const payload: ClaudeCodeRelayTestCreate = {
        channel_label: values.channel_label?.trim() || null,
        base_url: values.base_url.trim(),
        api_key: values.api_key.trim(),
        model_name: values.model_name.trim(),
        provider_type: values.provider_type || 'third_party_anthropic',
        request_protocol: values.request_protocol || 'auto',
        source_channel_id: values.source_channel_id || null,
        image_url: values.image_url?.trim() || null,
        include_expensive_context: Boolean(values.include_expensive_context),
      };
      return api.startClaudeCodeRelayTestJob(payload);
    },
    onSuccess: (payload) => setRelayJobId(payload.job_id),
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const deleteHistory = useMutation({
    mutationFn: api.deleteClaudeCodeHistory,
    onSuccess: async (_, id) => {
      message.success('历史记录已删除');
      if (selectedHistoryId === id) setSelectedHistoryId(null);
      await history.refetch();
    },
    onError: (error) => message.error(getErrorMessage(error)),
    onSettled: () => setDeletingHistoryId(null),
  });

  function submitRelay(values: RelayFormValues) {
    setRelayResult(null);
    setRelayJobId(null);
    setSelectedHistoryId(null);
    runRelayTest.mutate(values);
  }

  const relayRunning = runRelayTest.isPending || relayJob.data?.status === 'queued' || relayJob.data?.status === 'running';
  const activeResult = selectedHistoryId ? historyDetail.data?.result_payload ?? null : relayResult;
  const historyCount = history.data?.length ?? 0;
  const historyPanelContent = (
    <Space direction="vertical" size={12} className="full-width">
      <Input.Search
        allowClear
        placeholder="搜索渠道名 / URL / 模型"
        value={historyQuery}
        onChange={(event) => setHistoryQuery(event.target.value)}
      />
      <Space wrap>
        <Select
          value={historyRiskFilter}
          onChange={setHistoryRiskFilter}
          style={{ minWidth: 120 }}
          options={[
            { value: 'all', label: '全部风险' },
            { value: 'low', label: 'low' },
            { value: 'medium', label: 'medium' },
            { value: 'high', label: 'high' },
            { value: 'critical', label: 'critical' },
          ]}
        />
        <Checkbox checked={historyMatchCurrent} onChange={(event) => setHistoryMatchCurrent(event.target.checked)}>
          当前渠道
        </Checkbox>
      </Space>
      {history.isError ? <Alert type="error" showIcon message="历史记录加载失败" description={getErrorMessage(history.error)} /> : null}
      {history.isLoading ? <Typography.Text type="secondary">正在加载历史记录...</Typography.Text> : null}
      {!history.isLoading && !(history.data?.length) ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 ClaudeCode 证据历史" /> : null}
      {!history.isLoading && Boolean(history.data?.length) && !filteredHistory.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的历史记录" /> : null}
      {filteredHistory.map((item) => (
        <HistoryCard
          key={item.id}
          item={item}
          selected={selectedHistoryId === item.id}
          deleting={deletingHistoryId === item.id}
          onSelect={() => {
            setSelectedHistoryId(item.id);
            setHistoryDrawerOpen(false);
          }}
          onDelete={() => {
            setDeletingHistoryId(item.id);
            deleteHistory.mutate(item.id);
          }}
        />
      ))}
    </Space>
  );

  return (
    <Space direction="vertical" size={24} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">CLAUDE CODE RELAY</Typography.Text>
          <Typography.Title level={2}>ClaudeCode 检测</Typography.Title>
          <Typography.Paragraph>
            输入第三方中转的 URL、API Key 和模型名，按协议、多模态、Signature、上下文和兼容性分组查看检测结果。
          </Typography.Paragraph>
        </div>
        <Tag color="blue">临时凭据不落库</Tag>
      </div>

      <div className="claude-page-layout">
        <main className="claude-main-pane">
          <Space direction="vertical" size={18} className="full-width">
            <Card title={<span className="card-title-with-icon"><ShieldCheck size={18} />接口配置</span>} bordered={false}>
              <Form
                form={relayForm}
                layout="vertical"
                initialValues={{ provider_type: 'third_party_anthropic', request_protocol: 'auto', include_expensive_context: false }}
                onFinish={submitRelay}
              >
                <div className="signature-config-grid">
                  <Form.Item name="channel_label" label="渠道名字">
                    <Input placeholder="例如 APIPro-aws官" maxLength={200} showCount />
                  </Form.Item>
                  <Form.Item name="base_url" label="Base URL" rules={[{ required: true, message: '请输入 Base URL' }]}>
                    <Input placeholder="https://relay.example/v1 或 https://relay.example/v1/messages" />
                  </Form.Item>
                  <Form.Item name="api_key" label="API Key" rules={[{ required: true, message: '请输入 API Key' }]}>
                    <Input.Password placeholder="仅本次检测使用，不保存" autoComplete="off" />
                  </Form.Item>
                  <Form.Item name="model_name" label="模型名" rules={[{ required: true, message: '请输入模型名' }]}>
                    <Input placeholder="claude-sonnet-4-5" />
                  </Form.Item>
                  <Form.Item name="request_protocol" label="请求协议">
                    <Select
                      options={[
                        { value: 'auto', label: '自动探测' },
                        { value: 'anthropic_messages', label: 'Anthropic Messages' },
                        { value: 'openai_chat_completions', label: 'OpenAI Chat Completions' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="provider_type" label="接口类型">
                    <Select
                      options={[
                        { value: 'third_party_anthropic', label: 'Anthropic 兼容中转' },
                        { value: 'third_party_openai_compatible', label: 'OpenAI 兼容中转' },
                        { value: 'anthropic', label: 'Anthropic 官方' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="source_channel_id" label="Signature Source 渠道">
                    <Select allowClear loading={sources.isLoading} placeholder="可选；不选则自动找参考渠道" options={referenceOptions} />
                  </Form.Item>
                  <Form.Item name="image_url" label="图片 URL">
                    <Input placeholder="可选；留空使用默认红色测试图" />
                  </Form.Item>
                </div>
                <Space wrap>
                  <Form.Item name="include_expensive_context" valuePropName="checked" style={{ marginBottom: 0 }}>
                    <Checkbox>启用扩展上下文阶梯</Checkbox>
                  </Form.Item>
                  <Button type="primary" htmlType="submit" icon={<Play size={16} />} loading={runRelayTest.isPending}>
                    开始 ClaudeCode 检测
                  </Button>
                  <Typography.Text type="secondary">API Key 只随本次请求发送，后端不写入渠道配置。</Typography.Text>
                  <Typography.Text type="secondary">检测完成后会自动保存为右侧历史证据。</Typography.Text>
                </Space>
              </Form>
            </Card>

            {relayRunning && relayJob.data ? (
              <Card bordered={false}>
                <Space direction="vertical" size={12} className="full-width">
                  <Typography.Text strong>正在运行中转接口组合检测</Typography.Text>
                  <Progress percent={relayJob.data.percent} status="active" />
                  <Typography.Text type="secondary">
                    当前测试：{relayJob.data.current_title || '准备中'}，已完成 {relayJob.data.completed_count} / {relayJob.data.total_count}
                  </Typography.Text>
                </Space>
              </Card>
            ) : null}

            {relayJob.data ? (
              <Space direction="vertical" size={18} className="full-width">
                <div className="claude-section-grid">
                  {(relayJob.data.sections ?? []).map((section) => (
                    <Card key={section.key} bordered={false} className="claude-section-card">
                      <Space direction="vertical" size={10} className="full-width">
                        <Space wrap className="claude-section-card-head">
                          <Typography.Text strong>{section.title}</Typography.Text>
                          <Tag color={statusColor(section.status)}>{statusLabel(section.status)}</Tag>
                          <Tag>得分 {section.score}</Tag>
                        </Space>
                        <Typography.Text type="secondary">{SECTION_DESCRIPTIONS[section.key] ?? '检测板块'}</Typography.Text>
                        <Progress percent={section.probe_count ? Math.round((section.pass_count / section.probe_count) * 100) : 0} size="small" showInfo={false} status={section.status === 'fail' ? 'exception' : section.status === 'running' ? 'active' : 'normal'} />
                        <Space wrap size={[6, 6]}>
                          <Tag color="green">通过 {section.pass_count}</Tag>
                          <Tag color="red">失败 {section.fail_count}</Tag>
                          <Tag color="orange">警告 {section.warning_count}</Tag>
                          <Tag>跳过 {section.skipped_count}</Tag>
                        </Space>
                      </Space>
                    </Card>
                  ))}
                </div>
                {(relayJob.data.sections ?? []).map((section) => (
                  <Card
                    key={section.key}
                    title={(
                      <Space wrap>
                        <span>{section.title}</span>
                        <Tag color={statusColor(section.status)}>{statusLabel(section.status)}</Tag>
                      </Space>
                    )}
                    bordered={false}
                  >
                    <Typography.Paragraph type="secondary">{SECTION_DESCRIPTIONS[section.key] ?? '检测板块'}</Typography.Paragraph>
                    {section.key === 'multimodal'
                      ? <MultimodalProbeTable probes={section.probes} currentKey={relayJob.data?.current_key} />
                      : <JobProbeTable probes={section.probes} currentKey={relayJob.data?.current_key} />}
                  </Card>
                ))}
              </Space>
            ) : null}

            {historyDetail.isLoading && selectedHistoryId ? (
              <Card bordered={false}><Typography.Text type="secondary">正在加载历史证据...</Typography.Text></Card>
            ) : null}
            {activeResult ? <ClaudeCodeResultView result={activeResult} meta={selectedHistoryId ? historyDetail.data : null} /> : null}
          </Space>
        </main>
      </div>
      <div className="claude-history-drawer-trigger">
        <Badge count={historyCount} overflowCount={99} size="small">
          <Button
            type="primary"
            shape="round"
            icon={<History size={16} />}
            onClick={() => setHistoryDrawerOpen(true)}
            aria-label="打开历史记录"
          >
            历史记录
          </Button>
        </Badge>
      </div>
      <Drawer
        title={<span className="card-title-with-icon"><History size={18} />历史记录</span>}
        placement="right"
        width={420}
        open={historyDrawerOpen}
        onClose={() => setHistoryDrawerOpen(false)}
        className="claude-history-drawer"
        rootClassName="claude-history-drawer-root"
        destroyOnClose={false}
      >
        {historyPanelContent}
      </Drawer>
    </Space>
  );
}
