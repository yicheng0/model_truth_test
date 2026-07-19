import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Checkbox, Collapse, DatePicker, Descriptions, Drawer, Empty, Form, Input, Popconfirm, Progress, Select, Space, Statistic, Table, Tag, Tooltip, Typography, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { History, Play, ShieldCheck, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { labelText, labelTooltip, topRiskLabels } from '../claudeCodeDiagnostics';
import { groupClaudeFingerprintHistory, localDayRangeIso, probeDiagnosticText } from '../claudeFingerprintHistory';
import { CLAUDE_ACCESS_PATHS, CLAUDE_CHANNEL_DIFFERENCES, CLAUDE_EVIDENCE_TIERS, UPSTREAM_INTEGRITY_META, type UpstreamIntegrityClassification } from '../claudeFingerprintSpec';
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
  probe_depth?: 'standard' | 'deep';
  repeat_count?: 3 | 5;
};

const SECTION_DESCRIPTIONS: Record<string, string> = {
  fingerprint: 'ClaudeCode 兼容参数、拒绝形态和链路指纹；不作为普通 Claude 资源失败条件。',
  structure: 'Claude 基础响应结构、message 形态、usage、截断和协议行为。',
  behavior: '上下文、提示词防泄露以及运行时行为稳定性。',
  signature: 'ClaudeCode / Thinking Signature 专项能力；普通 Claude 资源不强制要求支持。',
  multimodal: '能力参考：图片 base64 优先；URL 图片和 document block 取决于渠道是否支持，不作为 Claude 真伪核心判断。',
  web_capability: '能力参考：使用 web_search_20260318；不支持时跳过，不作为 Claude 真伪判断。',
};

function FingerprintMethodologyPanel() {
  return (
    <Collapse
      className="claude-fingerprint-methodology"
      items={[
        {
          key: 'methodology',
          label: '判别 Spec：官方直连、官方云、Gateway / 逆向和换模怎么区分',
          children: (
            <Space direction="vertical" size={16} className="full-width">
              <Alert
                type="info"
                showIcon
                message="先判来源，再判协议和行为"
                description="msg_、toolu_、SSE、错误文案和模型自报都能被中转仿造。第三方 URL 检测通过，只能说明 Claude-compatible 或官转高一致性；官方直连必须结合域名、账号、云资源和审计记录。"
              />
              <div className="claude-spec-tier-grid">
                {CLAUDE_EVIDENCE_TIERS.map((item) => (
                  <Card key={item.key} size="small" title={<Space><span>{item.title}</span><Tag>{item.weight}</Tag></Space>}>
                    <Typography.Paragraph className="claude-spec-copy"><strong>看什么：</strong>{item.signals}</Typography.Paragraph>
                    <Typography.Paragraph type="secondary" className="claude-spec-copy"><strong>边界：</strong>{item.caveat}</Typography.Paragraph>
                  </Card>
                ))}
              </div>
              <Table
                rowKey="key"
                size="small"
                pagination={false}
                scroll={{ x: 1120 }}
                dataSource={CLAUDE_CHANNEL_DIFFERENCES}
                columns={[
                  { title: '渠道类型', dataIndex: 'title', width: 190 },
                  { title: '正常差异 / 预期', dataIndex: 'expected', width: 330 },
                  { title: '重点红旗', dataIndex: 'redFlags', width: 330 },
                  { title: '允许结论', dataIndex: 'conclusion', width: 270 },
                ]}
              />
              <Table
                rowKey="key"
                size="small"
                pagination={false}
                dataSource={CLAUDE_ACCESS_PATHS}
                columns={[
                  { title: '访问路径', dataIndex: 'title', width: 220 },
                  { title: '判定边界', dataIndex: 'description', width: 500 },
                  { title: '主要证据', dataIndex: 'evidence' },
                ]}
              />
              <Typography.Text type="secondary">
                当前页面的 Claude 得分衡量基础协议与行为一致性；ClaudeCode 得分衡量 Thinking Signature、兼容参数和链路能力；访问路径判定单独描述直连、网关或翻译痕迹。透明转发仍可能无法区分。
              </Typography.Text>
            </Space>
          ),
        },
      ]}
    />
  );
}

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
  if (status === 'not_applicable') return '不适用';
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
  if (['claude', 'aws_resource', 'claude_code'].includes(String(result.classification_status ?? ''))) return 'success';
  if (result.classification_status === 'anomaly') return 'warning';
  if (result.risk_level === 'low' || result.risk_level === 'medium') return 'success';
  if (result.risk_level === 'high') return 'warning';
  return 'error';
}

function classificationColor(status?: string | null) {
  if (status === 'claude_code') return 'purple';
  if (status === 'claude' || status === 'aws_resource') return 'green';
  if (status === 'anomaly' || status === 'unknown') return 'orange';
  if (status === 'non_claude') return 'red';
  return 'default';
}

function accessPathColor(status?: string | null) {
  if (status === 'anthropic_endpoint_configured' || status === 'anthropic_api_direct') return 'green';
  if (status === 'claude_code_gateway_like') return 'purple';
  if (status === 'translated_gateway') return 'red';
  if (status === 'transparent_unresolved') return 'orange';
  return 'default';
}

function UpstreamIntegrityPanel({ result }: { result: ClaudeCodeTestResult }) {
  const integrity = result.upstream_integrity;
  if (!integrity?.classification) return null;
  const gateway = integrity.gateway_fingerprint;
  const gatewayContract = integrity.gateway_contract;
  const meta = UPSTREAM_INTEGRITY_META[integrity.classification as UpstreamIntegrityClassification] ?? {
    label: integrity.classification,
    color: 'default',
    description: integrity.reason ?? '本轮没有可显示的上游完整性说明。',
  };
  const rows = integrity.probe_matrix ?? [];
  return (
    <Card bordered={false} title="上游完整性（独立于兼容得分与访问路径）">
      <Space direction="vertical" size={12} className="full-width">
        <Alert
          type={integrity.classification === 'signature_chain_verified' ? 'success' : integrity.classification === 'insufficient_evidence' ? 'info' : 'warning'}
          showIcon
          message={<Space wrap><span>{meta.label}</span><Tag color={meta.color}>置信度 {integrity.confidence}</Tag><Tag>官方来源未确认</Tag></Space>}
          description={integrity.reason || meta.description}
        />
        <Descriptions size="small" bordered column={{ xs: 1, md: 3 }}>
          <Descriptions.Item label="官方来源确认">{integrity.official_origin_confirmed ? '已确认' : '未确认'}</Descriptions.Item>
          <Descriptions.Item label="重复次数">{integrity.repeat_count ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="官方基线">{integrity.source_channel_id ?? '未配置或未执行'}</Descriptions.Item>
        </Descriptions>
        {gateway ? (
          <Alert
            type="info"
            showIcon
            message="网关/控制面指纹（不作为官方来源证据）"
            description={(
              <Space direction="vertical" size={4}>
                <Typography.Text>{gateway.interpretation || '仅记录响应头族与边缘痕迹，不提升官方来源等级。'}</Typography.Text>
                <Typography.Text type="secondary">
                  控制面：{gateway.control_plane_families?.join('、') || '未发现'}；边缘/代理：{gateway.edge_or_proxy_families?.join('、') || '未发现'}；云封装：{gateway.cloud_provider_families?.join('、') || '未发现'}
                </Typography.Text>
              </Space>
            )}
          />
        ) : null}
        {gatewayContract ? (
          <Alert
            type={gatewayContract.status === 'warning' ? 'warning' : gatewayContract.status === 'pass' ? 'success' : 'info'}
            showIcon
            message="Claude Code 网关契约（不作为官方来源证据）"
            description={(
              <Space direction="vertical" size={4}>
                <Typography.Text>{gatewayContract.interpretation || '评估请求字段、原生错误和 SSE 实时转发是否保持 Claude Code 契约。'}</Typography.Text>
                <Typography.Text type="secondary">
                  Attribution：{gatewayContract.attribution_observation === 'sent_unverified' ? '客户端已发送，上游保持情况未验证' : '未观察到'}；Usage 粒度：{gatewayContract.usage_scope || 'single_request'}
                </Typography.Text>
                {gatewayContract.labels?.length ? <ProbeLabelTags labels={gatewayContract.labels} /> : null}
              </Space>
            )}
          />
        ) : null}
        <Table<Record<string, unknown>>
          rowKey={(item) => String(item.key)}
          size="small"
          pagination={false}
          scroll={{ x: 980 }}
          dataSource={rows}
          columns={[
            { title: '挑战', dataIndex: 'title', width: 250, render: (value: unknown, item) => <ProbeNameCell title={String(value || item.key)} probeKey={String(item.key)} /> },
            { title: '状态', dataIndex: 'status', width: 110, render: (value: unknown) => <Tag color={statusColor(String(value))}>{statusLabel(String(value))}</Tag> },
            { title: '重复', dataIndex: 'repeat_count', width: 75, render: (value: unknown) => value == null ? '-' : String(value) },
            { title: '正向通过', dataIndex: 'positive_pass_count', width: 95, render: (value: unknown) => value == null ? '-' : String(value) },
            { title: '篡改拒绝', dataIndex: 'tamper_rejected_count', width: 95, render: (value: unknown) => value == null ? '-' : String(value) },
            { title: '协议偏离', dataIndex: 'protocol_mismatch_count', width: 95, render: (value: unknown) => value == null ? '-' : String(value) },
            { title: '运营失败', dataIndex: 'operational_failure_count', width: 95, render: (value: unknown) => value == null ? '-' : String(value) },
            { title: '证据引用', dataIndex: 'evidence_refs', render: (value: unknown) => Array.isArray(value) ? value.join('、') : '-' },
          ]}
        />
        {(integrity.limitations ?? []).map((item) => <Typography.Text key={item} type="secondary">• {item}</Typography.Text>)}
      </Space>
    </Card>
  );
}

function claudeCodeLinkLabel(result: ClaudeCodeTestResult) {
  if (result.capability_flags?.is_claude_code_like) return '通过';
  if (result.capability_flags?.signature_supported) return '部分支持';
  return '未支持';
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

function ProbeLabelTags({ labels }: { labels?: string[] | null }) {
  if (!labels?.length) return <EmptyProbeValue />;
  return (
    <Space size={[4, 4]} wrap className="claude-probe-tags">
      {labels.map((label) => (
        <Tooltip key={label} title={labelTooltip(label)}>
          <Tag color={label === 'web_search_supported' ? 'green' : 'orange'} className="claude-probe-tag">
            {labelText(label)}
          </Tag>
        </Tooltip>
      ))}
    </Space>
  );
}

type ProbeDisplay = ClaudeCodeProbeResult | ClaudeCodeJobProbe;

function ProbeEvidenceText({ probe }: { probe: ProbeDisplay }) {
  const display = probeDiagnosticText(probe);
  return display ? <Typography.Text className="claude-probe-evidence" ellipsis={{ tooltip: display }}>{display}</Typography.Text> : <EmptyProbeValue />;
}

function probeJson(value?: Record<string, unknown> | null) {
  if (!value || !Object.keys(value).length) return '-';
  return JSON.stringify(value, null, 2);
}

function hasProbeDetail(probe: ProbeDisplay) {
  return Boolean(
    probe.reason
    || probe.error_detail
    || probe.response_excerpt
    || probe.evidence_excerpt
    || probe.label_explanations?.length
    || Object.keys(probe.request_snapshot ?? {}).length
    || Object.keys(probe.raw_evidence ?? {}).length,
  );
}

function ProbeDetailPanel({ probe }: { probe: ProbeDisplay }) {
  const alertType = probe.status === 'fail' ? 'error' : probe.status === 'warning' ? 'warning' : 'info';
  const collapseItems = [
    probe.error_detail ? { key: 'error', label: '完整上游错误', children: <pre className="claude-probe-detail-pre">{probe.error_detail}</pre> } : null,
    Object.keys(probe.request_snapshot ?? {}).length
      ? { key: 'request', label: '脱敏请求快照', children: <pre className="claude-probe-detail-pre">{probeJson(probe.request_snapshot)}</pre> }
      : null,
    Object.keys(probe.raw_evidence ?? {}).length
      ? { key: 'evidence', label: '结构化原始证据', children: <pre className="claude-probe-detail-pre">{probeJson(probe.raw_evidence)}</pre> }
      : null,
    probe.response_excerpt || probe.evidence_excerpt
      ? { key: 'response', label: '响应与证据摘要', children: <pre className="claude-probe-detail-pre">{probe.response_excerpt || probe.evidence_excerpt}</pre> }
      : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));
  return (
    <div className="claude-probe-detail">
      <Alert type={alertType} showIcon message="判定原因" description={probeDiagnosticText(probe)} />
      {probe.label_explanations?.length ? (
        <div className="claude-probe-detail-labels">
          {probe.label_explanations.map((item) => (
            <div key={item.label}><Tag>{labelText(item.label)}</Tag><Typography.Text type="secondary">{item.description}</Typography.Text></div>
          ))}
        </div>
      ) : null}
      <Descriptions size="small" column={2} className="claude-probe-detail-meta">
        <Descriptions.Item label="HTTP 状态">{probe.http_status ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="错误类型">{probe.error_type ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="请求协议">{probe.request_protocol ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="Endpoint">{probe.provider_endpoint ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="Run ID">{probe.run_id ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="Result ID">{probe.result_id ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="Message ID">{probe.message_id ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="Request ID">{probe.request_id ?? '-'}</Descriptions.Item>
      </Descriptions>
      {collapseItems.length ? <Collapse size="small" items={collapseItems} /> : null}
    </div>
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
      expandable={{ expandedRowRender: (item) => <ProbeDetailPanel probe={item} />, rowExpandable: hasProbeDetail }}
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
          render: (_, item) => <ProbeLabelTags labels={item.labels} />,
        },
        {
          title: '证据摘要',
          width: 300,
          render: (_, item) => <ProbeEvidenceText probe={item} />,
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
      expandable={{ expandedRowRender: (item) => <ProbeDetailPanel probe={item} />, rowExpandable: hasProbeDetail }}
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
          render: (_, item) => <ProbeEvidenceText probe={item} />,
        },
      ]}
    />
  );
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
      expandable={{ expandedRowRender: (item) => <ProbeDetailPanel probe={item} />, rowExpandable: hasProbeDetail }}
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
          render: (_, item) => <ProbeLabelTags labels={item.labels} />,
        },
        {
          title: '证据摘要',
          width: 320,
          render: (_, item) => <ProbeEvidenceText probe={item} />,
        },
      ]}
    />
  );
}

function ClaudeCodeResultView({ result, meta }: { result: ClaudeCodeTestResult; meta?: ClaudeCodeHistoryDetail | null }) {
  const allCounts = probeCounts(result.probes ?? []);
  const riskLabels = topRiskLabels(result.probes ?? []);
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
            <Tag color={classificationColor(result.classification_status)}>
              Claude 判断 {result.classification_label ?? result.classification_status ?? '未分类'}
            </Tag>
            {result.access_path_assessment ? (
              <Tag color={accessPathColor(result.access_path_assessment)}>
                访问路径 {result.access_path_label ?? result.access_path_assessment}
              </Tag>
            ) : null}
            <Tag color={result.capability_flags?.is_claude_code_like ? 'purple' : 'default'}>
              ClaudeCode 链路 {claudeCodeLinkLabel(result)}
            </Tag>
            <Tag color={riskColor(result.risk_level)}>风险 {result.risk_level}</Tag>
            <Tag color={result.ok ? 'green' : 'red'}>Claude 得分 {result.claude_score ?? result.score}</Tag>
            {typeof result.claude_code_score === 'number' ? <Tag>ClaudeCode 得分 {result.claude_code_score}</Tag> : null}
            {result.protocol_profile ? <Tag color="blue">协议 {result.protocol_profile}</Tag> : null}
          </Space>
        )}
        description={result.classification_reason ? `${result.summary} · ${result.classification_reason}` : result.summary}
      />
      {result.access_path_assessment ? (
        <Card bordered={false} title="访问路径判定（独立于 Claude 得分）">
          <Space direction="vertical" size={12} className="full-width">
            <Alert
              type={result.access_path_assessment === 'translated_gateway' ? 'warning' : 'info'}
              showIcon
              message={result.access_path_label ?? result.access_path_assessment}
              description={`${result.access_path_reason ?? ''}${result.access_path_caveat ? ` · ${result.access_path_caveat}` : ''}`}
            />
            <Descriptions size="small" bordered column={{ xs: 1, md: 3 }}>
              <Descriptions.Item label="Claude 得分">模型与 Messages API 兼容性</Descriptions.Item>
              <Descriptions.Item label="ClaudeCode 得分">Thinking / 工具 / 客户端能力</Descriptions.Item>
              <Descriptions.Item label="访问路径">直连、网关、协议翻译或透明未决</Descriptions.Item>
            </Descriptions>
            <Table
              rowKey={(item) => String(item.key)}
              size="small"
              pagination={false}
              dataSource={result.access_path_evidence ?? []}
              columns={[
                { title: '证据', dataIndex: 'key', width: 210 },
                { title: '状态', dataIndex: 'status', width: 90, render: (value: string) => <Tag color={statusColor(value)}>{statusLabel(value)}</Tag> },
                { title: 'HTTP', dataIndex: 'http_status', width: 85, render: (value: number | null) => value ?? '-' },
                { title: '结论', dataIndex: 'reason' },
              ]}
            />
          </Space>
        </Card>
      ) : null}
      <UpstreamIntegrityPanel result={result} />
      {result.request_normalization_notes?.length ? (
        <Alert
          type="info"
          showIcon
          message="Opus 4.7/4.8+ 请求字段已归一化"
          description={result.request_normalization_notes.join('；')}
        />
      ) : null}
      {riskLabels.length ? (
        <div className="claude-risk-row">
          <Typography.Text strong>关键风险</Typography.Text>
          <ProbeLabelTags labels={riskLabels} />
        </div>
      ) : null}
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
          {item.result_payload?.classification_status ? (
            <Tag color={classificationColor(item.result_payload.classification_status)}>
              {item.result_payload.classification_label ?? item.result_payload.classification_status}
            </Tag>
          ) : null}
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
            title="删除 Claude 资源指纹历史"
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
  const [historyDateRange, setHistoryDateRange] = useState<[Dayjs, Dayjs] | null>([
    dayjs().subtract(6, 'day').startOf('day'),
    dayjs().endOf('day'),
  ]);
  const watchedChannelLabel = Form.useWatch('channel_label', relayForm);
  const watchedBaseUrl = Form.useWatch('base_url', relayForm);
  const historyFilters = useMemo(() => localDayRangeIso(historyDateRange), [historyDateRange]);

  const sources = useQuery<ClaudeCodeSourceChannel[]>({ queryKey: ['claudeCodeSourceChannels'], queryFn: api.claudeCodeSourceChannels });
  const history = useQuery<ClaudeCodeHistoryItem[]>({
    queryKey: ['claudeCodeHistory', historyFilters.from, historyFilters.to],
    queryFn: () => api.claudeCodeHistory(historyFilters),
  });
  const historyDetail = useQuery<ClaudeCodeHistoryDetail>({
    queryKey: ['claudeCodeHistoryDetail', selectedHistoryId],
    queryFn: () => api.claudeCodeHistoryDetail(selectedHistoryId!),
    enabled: Boolean(selectedHistoryId),
  });
  const relayJob = useQuery<ClaudeCodeJobStatus>({
    queryKey: ['claudeCodeRelayJob', relayJobId],
    queryFn: () => api.claudeCodeRelayTestJob(relayJobId!),
    enabled: Boolean(relayJobId),
    retry: (failureCount, error) => {
      if (error && typeof error === 'object' && 'status' in error && error.status === 404) return false;
      return failureCount < 2;
    },
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
  const historyGroups = useMemo(() => groupClaudeFingerprintHistory(filteredHistory), [filteredHistory]);

  useEffect(() => {
    const payload = relayJob.data;
    if (!payload) return;
    if (payload.status === 'completed' && payload.result) {
      setRelayResult(payload.result as ClaudeCodeTestResult);
      setSelectedHistoryId(null);
      void history.refetch();
      message.success('Claude 资源指纹检测完成，证据已保存');
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
        probe_depth: values.probe_depth || 'standard',
        repeat_count: values.repeat_count || 3,
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
      <DatePicker.RangePicker
        value={historyDateRange}
        allowClear
        style={{ width: '100%' }}
        onChange={(range) => setHistoryDateRange(range?.[0] && range[1] ? [range[0], range[1]] : null)}
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
      {!history.isLoading && !(history.data?.length) ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={historyDateRange ? '所选日期没有 Claude 指纹检测记录' : '暂无 Claude 资源指纹证据历史'} />
      ) : null}
      {!history.isLoading && Boolean(history.data?.length) && !filteredHistory.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选条件没有匹配记录" /> : null}
      {historyGroups.map((group) => (
        <div key={group.date} className="claude-history-day">
          <div className="claude-history-day-head">
            <Typography.Text strong>{group.date === 'unknown' ? '时间未知' : dayjs(group.date).format('YYYY年M月D日')}</Typography.Text>
            <Space wrap size={[4, 4]}>
              <Tag>{group.runCount} 次</Tag>
              <Tag color="green">通过 {group.passCount}</Tag>
              <Tag color="red">失败 {group.failCount}</Tag>
              <Tag color="orange">警告 {group.warningCount}</Tag>
              <Tag>跳过 {group.skippedCount}</Tag>
            </Space>
          </div>
          {group.items.map((item) => (
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
        </div>
      ))}
    </Space>
  );

  return (
    <Space direction="vertical" size={24} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">CLAUDE RESOURCE FINGERPRINT</Typography.Text>
          <Typography.Title level={2}>Claude 资源指纹检测</Typography.Title>
          <Typography.Paragraph>
            输入 Claude 或第三方中转的 URL、API Key 和模型名，先判断是否 Claude-compatible；Opus 4.7/4.8+ 会自动归一化 adaptive thinking，并清洗旧 enabled / budget_tokens / temperature / top_p / top_k 字段，避免协议 400。
          </Typography.Paragraph>
        </div>
        <Space wrap className="claude-heading-actions">
          <Tag color="blue">临时凭据不落库</Tag>
          <Badge count={historyCount} overflowCount={99} size="small">
            <Button
              icon={<History size={16} />}
              onClick={() => setHistoryDrawerOpen(true)}
              aria-label="打开历史记录"
            >
              历史记录
            </Button>
          </Badge>
        </Space>
      </div>

      <div className="claude-page-layout">
        <main className="claude-main-pane">
          <Space direction="vertical" size={18} className="full-width">
            <FingerprintMethodologyPanel />
            <Card title={<span className="card-title-with-icon"><ShieldCheck size={18} />接口配置</span>} bordered={false}>
              <Form
                form={relayForm}
                layout="vertical"
                initialValues={{ provider_type: 'third_party_anthropic', request_protocol: 'auto', include_expensive_context: false, probe_depth: 'standard', repeat_count: 3 }}
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
                  <Form.Item name="probe_depth" label="上游完整性探针">
                    <Select options={[{ value: 'standard', label: '标准：兼容性与访问路径' }, { value: 'deep', label: '深度：双向验签与差分矩阵（高请求量）' }]} />
                  </Form.Item>
                  <Form.Item name="repeat_count" label="深度探针重复次数" dependencies={['probe_depth']}>
                    <Select options={[{ value: 3, label: '3 次（默认）' }, { value: 5, label: '5 次（更强混路由采样）' }]} />
                  </Form.Item>
                </div>
                <Space wrap>
                  <Form.Item name="include_expensive_context" valuePropName="checked" style={{ marginBottom: 0 }}>
                    <Checkbox>启用扩展上下文阶梯</Checkbox>
                  </Form.Item>
                  <Button type="primary" htmlType="submit" icon={<Play size={16} />} loading={runRelayTest.isPending}>
                    开始 Claude 资源指纹检测
                  </Button>
                  <Typography.Text type="secondary">API Key 只随本次请求发送，后端不写入渠道配置。</Typography.Text>
                  <Typography.Text type="secondary">检测完成后会自动保存为右侧历史证据。</Typography.Text>
                  <Typography.Text type="secondary">深度模式为串行高请求量检测，需要 Signature Source；没有可比基线时会返回“证据不足”，不会误判失败。</Typography.Text>
                </Space>
              </Form>
            </Card>

            {relayRunning && relayJob.data ? (
              <Card bordered={false}>
                <Space direction="vertical" size={12} className="full-width">
                  <Typography.Text strong>正在运行 Claude 资源指纹检测</Typography.Text>
                  <Progress percent={relayJob.data.percent} status="active" />
                  <Typography.Text type="secondary">
                    当前测试：{relayJob.data.current_title || '准备中'}，已完成 {relayJob.data.completed_count} / {relayJob.data.total_count}
                  </Typography.Text>
                </Space>
              </Card>
            ) : null}
            {relayJob.isError ? (
              <Alert
                type="warning"
                showIcon
                message="实时任务状态不可用"
                description={`${getErrorMessage(relayJob.error)} 这通常表示后端服务重启或任务状态已过期；请重新发起检测。`}
              />
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
