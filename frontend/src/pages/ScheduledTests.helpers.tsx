import dayjs from 'dayjs';
import { Space, Tag, Tooltip, Typography, message } from 'antd';
import type { Dayjs } from 'dayjs';
import type { Key } from 'react';
import { formatProviderChannelDisplayName } from '../channelCredentials';
import type { Channel, ChannelAlert, ScheduledChannelTest } from '../types';
import {
  alertOutcomeColor,
  alertOutcomeLabel,
  alertProbeTitle,
} from '../scheduledAlertLog';

export type TableRowKey = Key;
export type AlertTimeRange = [Dayjs | null, Dayjs | null] | null;
export type AlertResultFilter = 'all' | 'success' | 'failure';
export type ScheduledTab = 'plans' | 'alerts' | 'report' | 'feishu';

export const alertStatusLabel: Record<string, string> = {
  pending_review: '待复审',
  confirmed_issue: '确认问题',
  false_positive: '误报',
  resolved: '已处理',
};

export const alertStatusColor: Record<string, string> = {
  pending_review: 'gold',
  confirmed_issue: 'red',
  false_positive: 'blue',
  resolved: 'green',
};

export const scheduleStatusColor: Record<string, string> = {
  idle: 'default',
  queued: 'processing',
  running: 'processing',
  completed: 'green',
  failed: 'red',
  canceled: 'default',
};

export const patrolGuideSteps = [
  { title: '准备渠道', description: '先在渠道管理里建好候选渠道，确认模型、Base URL 和 Key 能正常请求。' },
  { title: '新建巡检计划', description: '只选择待测渠道和执行间隔，系统固定跑 Signature 互通和真实模型请求。' },
  { title: '查看判断依据', description: '告警会返回 run、report、message id、request id 和 source/relay 响应 ID。' },
  { title: '复审处理', description: '根据疑似 AWS、逆向、adaptive thinking 改写或 Signature 链路不可验证等标签确认问题，必要时重发飞书通知。' },
];

export const patrolParameterFaq = [
  {
    key: 'interval',
    label: '执行间隔怎么填？',
    children: '填两次自动巡检之间的分钟数。日常建议 1440 分钟；刚接入或排查问题时用 60 分钟；最小 5 分钟。',
  },
  {
    key: 'signature',
    label: 'Signature 互通检测看什么？',
    children: 'source 渠道按模型协议生成带 signature 的 thinking block，再让待测渠道复用；失败会标记 signature_interop_failed，但只代表 ClaudeCode/原生 thinking 链路不可验证。',
  },
  {
    key: 'model_request',
    label: '真实模型请求看什么？',
    children: '系统发送 adaptive thinking 协议、web search、adaptive thinking effort 三个探针，记录 message id、request id、协议和 endpoint，用于判断参数不支持、AWS/Bedrock、Claude/Anthropic 或中间层改写。',
  },
  {
    key: 'alert_ids',
    label: '告警里的 ID 有什么用？',
    children: 'run_id 和 report_id 用来查看完整报告；message id、request id 和 source/relay id 用来判断响应来源特征。',
  },
];

export function runWindowText(schedule: Pick<ScheduledChannelTest, 'run_window_start' | 'run_window_end'>) {
  if (!schedule.run_window_start || !schedule.run_window_end) return '全天';
  if (schedule.run_window_start > schedule.run_window_end) {
    return `${schedule.run_window_start}-次日 ${schedule.run_window_end} 北京时间`;
  }
  return `${schedule.run_window_start}-${schedule.run_window_end} 北京时间`;
}

export function alertChannelText(alert: ChannelAlert, channel?: Channel | null) {
  const evidence = alert.evidence_summary ?? {};
  const name = channel?.name ?? (typeof evidence.channel_name === 'string' ? evidence.channel_name : alert.channel_id);
  const displayId = formatProviderChannelDisplayName(
    {
      id: channel?.id ?? alert.channel_id,
      name,
      provider_type: channel?.provider_type,
      auth_config: channel?.auth_config,
      providerType: typeof evidence.channel_provider_type === 'string' ? evidence.channel_provider_type : undefined,
      accountType: typeof evidence.channel_account_type === 'string' ? evidence.channel_account_type : undefined,
    },
    alert.channel_id,
  );
  const model = evidence.channel_model_name ? String(evidence.channel_model_name) : '';
  return {
    name,
    displayId,
    model,
  };
}

export function probeClassificationColor(status?: string | null, label?: string | null) {
  if (status === 'operational_issue') {
    if (label === '额度不足') return 'gold';
    if (label === '检测失败') return 'default';
    return 'orange';
  }
  if (status === 'anomaly') return 'red';
  if (status === 'aws_resource') return 'green';
  return 'blue';
}

export function probeSummary(schedule: ScheduledChannelTest) {
  const summary = schedule.latest_probe_summary;
  if (!summary) {
    return <Tag color="default">未巡检</Tag>;
  }
  const classificationStatus = summary.classification_status;
  const classificationLabel = summary.classification_label;
  const modelRequests = summary.model_requests?.length ? summary.model_requests : summary.model_request ? [summary.model_request] : [];
  const signature = summary.signature_interop ?? {};
  const labels = summary.labels ?? [];
  const blockingLabels = labels.filter((label) => label !== 'patrol_probe_passed' && label !== 'provider_error_variant');
  const hasModelError = modelRequests.some((item) => item.status === 'error' || Boolean(item.error) || (item.labels ?? []).some((label) => label !== 'provider_error_variant'));
  const hasSignatureError = signature.status === 'fail';
  const isFailed = classificationStatus === 'anomaly' || schedule.last_status === 'failed' || hasModelError || hasSignatureError || blockingLabels.length > 0;
  if (classificationStatus === 'operational_issue') {
    return <Tag color={probeClassificationColor(classificationStatus, classificationLabel)}>{classificationLabel || '本轮无法判定'}</Tag>;
  }
  if (classificationStatus === 'claude' || classificationStatus === 'aws_resource') {
    return <Tag color={classificationStatus === 'aws_resource' ? 'green' : 'blue'}>{classificationLabel || (classificationStatus === 'aws_resource' ? 'AWS 资源' : 'Claude 资源')}</Tag>;
  }
  const tooltip = schedule.last_run_id ? '点开自动巡检日志查看探针详情' : undefined;
  return (
    <Tooltip title={tooltip || undefined}>
      <Tag color={isFailed ? 'red' : 'green'}>{isFailed ? '异常' : '正确'}</Tag>
    </Tooltip>
  );
}

export function reportRangeToDates(range: string) {
  const to = new Date();
  const from = new Date(to);
  const days = range === '24h' ? 1 : range === '30d' ? 30 : 7;
  from.setDate(from.getDate() - days);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function alertRangeToParams(range: AlertTimeRange) {
  return {
    created_from: range?.[0]?.toISOString(),
    created_to: range?.[1]?.toISOString(),
  };
}

export function paramValue(params: URLSearchParams, key: string, fallback: string, allowed: readonly string[]) {
  const value = params.get(key);
  return value && allowed.includes(value) ? value : fallback;
}

export function rangeFromParams(params: URLSearchParams): AlertTimeRange {
  const from = params.get('alert_from');
  const to = params.get('alert_to');
  if (!from && !to) return null;
  const start = from ? formatDateTimeToDayjs(from) : null;
  const end = to ? formatDateTimeToDayjs(to) : null;
  return [start?.isValid() ? start : null, end?.isValid() ? end : null];
}

function formatDateTimeToDayjs(value: string): Dayjs {
  return dayjs(value);
}

export function setSearchParamValue(params: URLSearchParams, key: string, value?: string | null) {
  const trimmed = value?.trim();
  if (trimmed) params.set(key, trimmed);
  else params.delete(key);
}

export function toggleTableRowKey(keys: TableRowKey[], id: string) {
  return keys.some((key) => String(key) === id)
    ? keys.filter((key) => String(key) !== id)
    : [...keys, id];
}

export function bulkDeleteMessage(entity: string, result: { deleted: number; missing: string[] }) {
  const missing = result.missing ?? [];
  if (result.deleted > 0 && missing.length === 0) {
    message.success(`已删除 ${result.deleted} ${entity}`);
    return;
  }
  if (result.deleted > 0) {
    message.warning(`已删除 ${result.deleted} ${entity}，${missing.length} 个未命中：${missing.join('、')}`);
    return;
  }
  message.warning(`未删除任何${entity}，${missing.length ? `未命中：${missing.join('、')}` : '所选项不存在或已被删除'}`);
}

export function matchesAlertResultFilter(alert: ChannelAlert, filter: AlertResultFilter) {
  if (filter === 'all') return true;
  const successStatuses = new Set(['false_positive', 'resolved']);
  return filter === 'success' ? successStatuses.has(alert.status) : !successStatuses.has(alert.status);
}

export function alertSummaryCell(alert: ChannelAlert, channelRecord?: Channel | null) {
  const channel = alertChannelText(alert, channelRecord);
  return (
    <Space size={[8, 4]} wrap align="center" style={{ width: '100%' }}>
      <Typography.Text strong>{channel.name}</Typography.Text>
      <Tag color={alertOutcomeColor(alert.status)}>{alertOutcomeLabel(alert.status)}</Tag>
      <Tag color={alertStatusColor[alert.status] ?? 'default'}>{alertStatusLabel[alert.status] ?? alert.status}</Tag>
      <Tooltip title={alert.notification_error || undefined}>
        <Tag color={alert.notification_status === 'sent' ? 'green' : alert.notification_status === 'failed' ? 'red' : 'default'}>
          飞书：{alert.notification_status}
        </Tag>
      </Tooltip>
      <Typography.Text type="secondary" ellipsis style={{ maxWidth: 220 }}>
        {alertProbeTitle(alert)}
      </Typography.Text>
    </Space>
  );
}
