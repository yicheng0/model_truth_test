import { useDeferredValue, useEffect, useMemo, useState, type Key } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Col, Collapse, DatePicker, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Statistic, Switch, Table, Tabs, Tag, TimePicker, Tooltip, Typography, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { BarChart3, Bell, CalendarClock, Edit3, Eye, Play, RefreshCw, Send, Settings, Trash2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, getErrorMessage } from '../api';
import { formatChannelDisplayName, formatProviderChannelDisplayName } from '../channelCredentials';
import { isCandidateChannel, roleLabel } from '../channelTaxonomy';
import { formatDateTime } from '../time';
import type { Channel, ChannelAlert, ChannelAlertStatus, ScheduledChannelTest, ScheduledChannelTestCreate } from '../types';
import { buildScheduleBasePayload, intervalText, type ScheduleFormValues } from '../scheduledTestsUtils';
import { buildFeishuBroadcastUpdate, type FeishuBroadcastFormValues } from './feishuBroadcast';
import {
  alertChannelModel,
  alertOutcomeColor,
  alertOutcomeLabel,
  alertErrorText,
  alertProbeCompletedAt,
  alertProbeSource,
  alertProbeTitle,
  alertRequestId,
  alertResponseId,
} from '../scheduledAlertLog';
import AlertLogDrawer from '../components/AlertLogDrawer';

type ReviewFormValues = {
  status: Exclude<ChannelAlertStatus, 'pending_review'>;
  reviewer_name: string;
  review_note?: string;
};

type FeishuFormValues = FeishuBroadcastFormValues & {
  enabled: boolean;
  alert_broadcast_enabled: boolean;
  daily_report_enabled: boolean;
  daily_report_time: Dayjs | null;
  timezone: string;
};

type AlertTimeRange = [Dayjs | null, Dayjs | null] | null;
type AlertResultFilter = 'all' | 'success' | 'failure';
type ScheduledTab = 'plans' | 'alerts' | 'report' | 'feishu';
const alertStatusLabel: Record<string, string> = {
  pending_review: '待复审',
  confirmed_issue: '确认问题',
  false_positive: '误报',
  resolved: '已处理',
};

const alertStatusColor: Record<string, string> = {
  pending_review: 'gold',
  confirmed_issue: 'red',
  false_positive: 'blue',
  resolved: 'green',
};

const scheduleStatusColor: Record<string, string> = {
  idle: 'default',
  queued: 'processing',
  running: 'processing',
  completed: 'green',
  failed: 'red',
  canceled: 'default',
};

const patrolGuideSteps = [
  { title: '准备渠道', description: '先在渠道管理里建好候选渠道，确认模型、Base URL 和 Key 能正常请求。' },
  { title: '新建巡检计划', description: '只选择待测渠道和执行间隔，系统固定跑 Signature 互通和真实模型请求。' },
  { title: '查看判断依据', description: '告警会返回 run、report、message id、request id 和 source/relay 响应 ID。' },
  { title: '复审处理', description: '根据疑似 AWS、逆向或 Signature 不互通等标签确认问题，必要时重发飞书通知。' },
];

const patrolParameterFaq = [
  {
    key: 'interval',
    label: '执行间隔怎么填？',
    children: '填两次自动巡检之间的分钟数。日常建议 1440 分钟；刚接入或排查问题时用 60 分钟；最小 5 分钟。',
  },
  {
    key: 'signature',
    label: 'Signature 互通检测看什么？',
    children: 'source 渠道先生成带 signature 的 thinking block，再让待测渠道复用。失败会标记 signature_interop_failed。',
  },
  {
    key: 'model_request',
    label: '真实模型请求看什么？',
    children: '系统发送 thinking temperature、web search、thinking.adaptive.enabled 三个探针，记录 message id、request id、协议和 endpoint，用于判断参数不支持、AWS/Bedrock、Claude/Anthropic 或中间层改写。',
  },
  {
    key: 'alert_ids',
    label: '告警里的 ID 有什么用？',
    children: 'run_id 和 report_id 用来查看完整报告；message id、request id 和 source/relay id 用来判断响应来源特征。',
  },
];

function runWindowText(schedule: Pick<ScheduledChannelTest, 'run_window_start' | 'run_window_end'>) {
  if (!schedule.run_window_start || !schedule.run_window_end) return '全天';
  if (schedule.run_window_start > schedule.run_window_end) {
    return `${schedule.run_window_start}-次日 ${schedule.run_window_end} 北京时间`;
  }
  return `${schedule.run_window_start}-${schedule.run_window_end} 北京时间`;
}

function alertChannelText(alert: ChannelAlert, channel?: Channel | null) {
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

function probeSummary(schedule: ScheduledChannelTest) {
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

function reportRangeToDates(range: string) {
  const to = new Date();
  const from = new Date(to);
  const days = range === '24h' ? 1 : range === '30d' ? 30 : 7;
  from.setDate(from.getDate() - days);
  return { from: from.toISOString(), to: to.toISOString() };
}

function alertRangeToParams(range: AlertTimeRange) {
  return {
    created_from: range?.[0]?.toISOString(),
    created_to: range?.[1]?.toISOString(),
  };
}

function paramValue(params: URLSearchParams, key: string, fallback: string, allowed: readonly string[]) {
  const value = params.get(key);
  return value && allowed.includes(value) ? value : fallback;
}

function rangeFromParams(params: URLSearchParams): AlertTimeRange {
  const from = params.get('alert_from');
  const to = params.get('alert_to');
  if (!from && !to) return null;
  const start = from ? dayjs(from) : null;
  const end = to ? dayjs(to) : null;
  return [start?.isValid() ? start : null, end?.isValid() ? end : null];
}

function setSearchParamValue(params: URLSearchParams, key: string, value?: string | null) {
  const trimmed = value?.trim();
  if (trimmed) params.set(key, trimmed);
  else params.delete(key);
}

function bulkDeleteMessage(entity: string, result: { deleted: number; missing: string[] }) {
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

function matchesAlertResultFilter(alert: ChannelAlert, filter: AlertResultFilter) {
  if (filter === 'all') return true;
  const successStatuses = new Set(['false_positive', 'resolved']);
  return filter === 'success' ? successStatuses.has(alert.status) : !successStatuses.has(alert.status);
}

function alertSummaryCell(alert: ChannelAlert, channelRecord?: Channel | null) {
  const channel = alertChannelText(alert, channelRecord);
  const completedAt = alertProbeCompletedAt(alert);
  const messageId = alertResponseId(alert);
  const requestId = alertRequestId(alert);
  const source = alertProbeSource(alert);
  const channelModel = alertChannelModel(alert);
  return (
    <Space direction="vertical" size={2}>
      <Typography.Text strong>{channel.name}</Typography.Text>
      {channel.model || channelModel ? <Typography.Text type="secondary">{channel.model || channelModel}</Typography.Text> : null}
      <Typography.Text>{alertProbeTitle(alert)}</Typography.Text>
      <Typography.Text type="secondary">{formatDateTime(completedAt) || formatDateTime(alert.created_at) || '-'}</Typography.Text>
      <Typography.Text type="secondary">
        {channel.displayId || '-'} · {source || '-'}
      </Typography.Text>
      <Typography.Text type="secondary">
        Message ID：{messageId || '-'} · Request ID：{requestId || '-'}
      </Typography.Text>
    </Space>
  );
}

export default function ScheduledTests() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedAlertId = searchParams.get('alert');
  const queryTab = paramValue(searchParams, 'tab', selectedAlertId ? 'alerts' : 'plans', ['plans', 'alerts', 'report', 'feishu']) as ScheduledTab;
  const [scheduleForm] = Form.useForm<ScheduleFormValues>();
  const [reviewForm] = Form.useForm<ReviewFormValues>();
  const [feishuForm] = Form.useForm<FeishuFormValues>();
  const [editingSchedule, setEditingSchedule] = useState<ScheduledChannelTest | null>(null);
  const [reviewingAlert, setReviewingAlert] = useState<ChannelAlert | null>(null);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [alertStatus, setAlertStatus] = useState<string>(() => paramValue(searchParams, 'alert_status', 'pending_review', ['pending_review', 'confirmed_issue', 'false_positive', 'resolved', 'all']));
  const [alertResultFilter, setAlertResultFilter] = useState<AlertResultFilter>(() => paramValue(searchParams, 'alert_result', 'failure', ['failure', 'success', 'all']) as AlertResultFilter);
  const [alertIdQuery, setAlertIdQuery] = useState(() => searchParams.get('alert_query') ?? '');
  const [alertTimeRange, setAlertTimeRange] = useState<AlertTimeRange>(() => rangeFromParams(searchParams));
  const [selectedAlertRowKeys, setSelectedAlertRowKeys] = useState<Key[]>([]);
  const [selectedRecentAlertRowKeys, setSelectedRecentAlertRowKeys] = useState<Key[]>([]);
  const [deletingAlertId, setDeletingAlertId] = useState<string | null>(null);
  const [resendingAlertIds, setResendingAlertIds] = useState<Set<string>>(() => new Set());
  const [openAlertLog, setOpenAlertLog] = useState<ChannelAlert | null>(null);
  const [activeTab, setActiveTab] = useState<ScheduledTab>(queryTab);
  const [reportRange, setReportRange] = useState('7d');
  const [runningScheduleId, setRunningScheduleId] = useState<string | null>(null);
  const [deletingScheduleId, setDeletingScheduleId] = useState<string | null>(null);
  const runWindowEnabled = Form.useWatch('run_window_enabled', scheduleForm);
  const deferredAlertIdQuery = useDeferredValue(alertIdQuery);
  const reportDates = useMemo(() => reportRangeToDates(reportRange), [reportRange]);
  const alertDateFilters = useMemo(() => alertRangeToParams(alertTimeRange), [alertTimeRange]);
  const trimmedAlertIdQuery = deferredAlertIdQuery.trim();
  const needsPlanData = activeTab === 'plans';
  const needsAlertData = activeTab === 'alerts';

  useEffect(() => {
    const nextTab = paramValue(searchParams, 'tab', selectedAlertId ? 'alerts' : 'plans', ['plans', 'alerts', 'report', 'feishu']) as ScheduledTab;
    setActiveTab(nextTab);
    setAlertStatus(paramValue(searchParams, 'alert_status', 'pending_review', ['pending_review', 'confirmed_issue', 'false_positive', 'resolved', 'all']));
    setAlertResultFilter(paramValue(searchParams, 'alert_result', 'failure', ['failure', 'success', 'all']) as AlertResultFilter);
    setAlertIdQuery(searchParams.get('alert_query') ?? '');
    setAlertTimeRange(rangeFromParams(searchParams));
  }, [searchParams, selectedAlertId]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    activeTab === 'plans' ? next.delete('tab') : next.set('tab', activeTab);
    alertStatus === 'pending_review' ? next.delete('alert_status') : next.set('alert_status', alertStatus);
    alertResultFilter === 'failure' ? next.delete('alert_result') : next.set('alert_result', alertResultFilter);
    setSearchParamValue(next, 'alert_query', alertIdQuery);
    setSearchParamValue(next, 'alert_from', alertTimeRange?.[0]?.toISOString());
    setSearchParamValue(next, 'alert_to', alertTimeRange?.[1]?.toISOString());
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [activeTab, alertIdQuery, alertResultFilter, alertStatus, alertTimeRange, searchParams, setSearchParams]);

  const schedules = useQuery({
    queryKey: ['scheduledTests'],
    queryFn: api.scheduledTests,
    enabled: needsPlanData,
    refetchInterval: activeTab === 'plans' ? 5000 : false,
  });
  const schedulerHealth = useQuery({
    queryKey: ['scheduledTestsHealth'],
    queryFn: api.scheduledTestsHealth,
    enabled: needsPlanData,
    retry: false,
    refetchInterval: (query) => (activeTab === 'plans' && query.state.data !== null ? 5000 : false),
  });
  const alerts = useQuery({
    queryKey: ['alerts', alertStatus, trimmedAlertIdQuery, alertDateFilters.created_from, alertDateFilters.created_to],
    queryFn: () => api.alerts({
      status: alertStatus === 'all' ? undefined : alertStatus,
      id_query: trimmedAlertIdQuery || undefined,
      created_from: alertDateFilters.created_from,
      created_to: alertDateFilters.created_to,
    }),
    enabled: needsAlertData,
    refetchInterval: activeTab === 'alerts' && alertStatus === 'pending_review' && !trimmedAlertIdQuery && !alertTimeRange ? 5000 : false,
  });
  const channels = useQuery<Channel[]>({ queryKey: ['channels'], queryFn: api.channels, enabled: needsPlanData || needsAlertData });
  const taxonomy = useQuery({ queryKey: ['channelTaxonomy'], queryFn: api.channelTaxonomy, enabled: needsPlanData });
  const smartReport = useQuery({
    queryKey: ['smartPatrolReport', reportRange],
    queryFn: () => api.smartPatrolReport(reportDates.from, reportDates.to),
    enabled: activeTab === 'report',
  });
  const feishuSetting = useQuery({
    queryKey: ['feishuBroadcastSetting'],
    queryFn: api.feishuBroadcastSetting,
    enabled: activeTab === 'feishu',
  });

  const channelById = useMemo(() => new Map((channels.data ?? []).map((channel) => [channel.id, channel])), [channels.data]);
  const candidateChannels = useMemo(() => (channels.data ?? []).filter(isCandidateChannel), [channels.data]);
  const openAlertLogChannel = openAlertLog ? alertChannelText(openAlertLog, channelById.get(openAlertLog.channel_id)) : null;

  useEffect(() => {
    if (!feishuSetting.data) return;
    feishuForm.setFieldsValue({
      enabled: feishuSetting.data.enabled,
      webhook_url: '',
      webhook_secret: '',
      clear_webhook_secret: false,
      app_base_url: feishuSetting.data.app_base_url ?? '',
      alert_broadcast_enabled: feishuSetting.data.alert_broadcast_enabled,
      daily_report_enabled: feishuSetting.data.daily_report_enabled,
      daily_report_time: dayjs(`2000-01-01T${feishuSetting.data.daily_report_time}:00`),
      timezone: feishuSetting.data.timezone,
    });
  }, [feishuForm, feishuSetting.data]);

  const createSchedule = useMutation({
    mutationFn: api.createScheduledTest,
    onSuccess: async () => {
      message.success('自动巡检计划已创建');
      setScheduleModalOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['scheduledTests'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const updateSchedule = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<ScheduledChannelTestCreate> }) => api.updateScheduledTest(id, payload),
    onSuccess: async () => {
      message.success('自动巡检计划已更新');
      setScheduleModalOpen(false);
      setEditingSchedule(null);
      await queryClient.invalidateQueries({ queryKey: ['scheduledTests'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const deleteSchedule = useMutation({
    mutationFn: api.deleteScheduledTest,
    onSuccess: async () => {
      message.success('自动巡检计划已删除');
      await queryClient.invalidateQueries({ queryKey: ['scheduledTests'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
    onSettled: () => setDeletingScheduleId(null),
  });

  const runNow = useMutation({
    mutationFn: api.runScheduledTestNow,
    onSuccess: async () => {
      message.success('已触发立即巡检');
      await queryClient.invalidateQueries({ queryKey: ['scheduledTests'] });
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
    onSettled: () => setRunningScheduleId(null),
  });

  const reviewAlert = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ReviewFormValues }) => api.reviewAlert(id, payload),
    onSuccess: async () => {
      message.success('复审结果已保存');
      setReviewingAlert(null);
      await queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const deleteAlert = useMutation({
    mutationFn: api.deleteAlert,
    onSuccess: async (_, id) => {
      message.success('告警已删除');
      setSelectedAlertRowKeys((keys) => keys.filter((key) => key !== id));
      setSelectedRecentAlertRowKeys((keys) => keys.filter((key) => key !== id));
      setOpenAlertLog((alert) => (alert?.id === id ? null : alert));
      await queryClient.invalidateQueries({ queryKey: ['alerts'] });
      await queryClient.invalidateQueries({ queryKey: ['smartPatrolReport'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
    onSettled: () => setDeletingAlertId(null),
  });

  const deleteAlerts = useMutation({
    mutationFn: api.deleteAlerts,
    onSuccess: async (result, ids) => {
      const deletedIds = new Set(ids.filter((id) => !result.missing.includes(id)));
      bulkDeleteMessage('条告警', result);
      setSelectedAlertRowKeys([]);
      setSelectedRecentAlertRowKeys([]);
      setOpenAlertLog((alert) => (alert && deletedIds.has(alert.id) ? null : alert));
      await queryClient.invalidateQueries({ queryKey: ['alerts'] });
      await queryClient.invalidateQueries({ queryKey: ['smartPatrolReport'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const resend = useMutation({
    mutationFn: api.resendAlertNotification,
    onMutate: (id) => {
      setResendingAlertIds((ids) => new Set(ids).add(id));
    },
    onSuccess: async () => {
      message.success('已重新发送通知');
      await queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
    onSettled: (_data, _error, id) => {
      setResendingAlertIds((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    },
  });

  const saveFeishu = useMutation({
    mutationFn: api.updateFeishuBroadcastSetting,
    onSuccess: async (result) => {
      if (result.enabled && !result.webhook_configured) {
        message.error('Webhook 未保存，请重新填写后保存');
        return;
      }
      message.success('飞书播报设置已保存');
      feishuForm.setFieldsValue({
        webhook_url: '',
        webhook_secret: '',
        clear_webhook_secret: false,
      });
      await queryClient.invalidateQueries({ queryKey: ['feishuBroadcastSetting'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const testFeishu = useMutation({
    mutationFn: api.testFeishuBroadcast,
    onSuccess: (result) => {
      if (result.ok) message.success(result.message);
      else message.warning(result.message);
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const sendDaily = useMutation({
    mutationFn: api.sendSmartPatrolDailyReport,
    onSuccess: (result) => {
      if (result.ok) message.success(result.message);
      else message.warning(result.message);
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  function openCreateSchedule() {
    setEditingSchedule(null);
    scheduleForm.resetFields();
    scheduleForm.setFieldsValue({
      enabled: true,
      interval_minutes: 1440,
      run_window_enabled: false,
      run_window_start: '09:00',
      run_window_end: '18:00',
    });
    setScheduleModalOpen(true);
  }

  function openEditSchedule(schedule: ScheduledChannelTest) {
    setEditingSchedule(schedule);
    scheduleForm.setFieldsValue({
      name: schedule.name,
      channel_id: schedule.channel_id,
      interval_minutes: schedule.interval_minutes,
      run_window_enabled: Boolean(schedule.run_window_start && schedule.run_window_end),
      run_window_start: schedule.run_window_start ?? '09:00',
      run_window_end: schedule.run_window_end ?? '18:00',
      enabled: schedule.enabled,
    });
    setScheduleModalOpen(true);
  }

  async function submitSchedule(values: ScheduleFormValues) {
    let basePayload;
    try {
      basePayload = buildScheduleBasePayload(values);
    } catch (error) {
      message.error(getErrorMessage(error));
      return;
    }
    if (editingSchedule) {
      updateSchedule.mutate({ id: editingSchedule.id, payload: basePayload });
      return;
    }
    createSchedule.mutate({
      ...basePayload,
      repeat_count: 1,
      concurrency: 1,
      use_mock: false,
      alert_grade_threshold: 'D',
      alert_score_threshold: null,
      alert_red_flags_enabled: true,
      quiet_minutes: 0,
      max_retries: 0,
      retry_interval_minutes: 5,
    });
  }

  function openReview(alert: ChannelAlert) {
    setReviewingAlert(alert);
    reviewForm.resetFields();
    reviewForm.setFieldsValue({
      status: 'confirmed_issue',
      reviewer_name: alert.reviewer_name ?? '',
      review_note: alert.review_note ?? '',
    });
  }

  function submitReview(values: ReviewFormValues) {
    if (!reviewingAlert) return;
    reviewAlert.mutate({ id: reviewingAlert.id, payload: values });
  }

  function deleteOneAlert(alert: ChannelAlert) {
    setDeletingAlertId(alert.id);
    deleteAlert.mutate(alert.id);
  }

  function deleteSelectedAlerts() {
    const ids = selectedAlertRowKeys.map(String);
    if (!ids.length) {
      message.warning('请先选择告警');
      return;
    }
    deleteAlerts.mutate(ids);
  }

  function deleteSelectedRecentAlerts() {
    const ids = selectedRecentAlertRowKeys.map(String);
    if (!ids.length) {
      message.warning('请先选择最近异常');
      return;
    }
    deleteAlerts.mutate(ids);
  }

  function submitFeishu(values: FeishuBroadcastFormValues) {
    const { payload, missingWebhook } = buildFeishuBroadcastUpdate(values, Boolean(feishuSetting.data?.webhook_configured));
    if (missingWebhook) {
      message.error('请先填写飞书机器人 Webhook');
      return;
    }
    saveFeishu.mutate(payload);
  }

  function clearAlertFilters() {
    setAlertStatus('pending_review');
    setAlertIdQuery('');
    setAlertTimeRange(null);
    setAlertResultFilter('failure');
  }

  function openAlertLogDrawer(alert: ChannelAlert) {
    setOpenAlertLog(alert);
  }

  function closeAlertLogDrawer() {
    setOpenAlertLog(null);
  }

  function refetchActiveTabData() {
    if (activeTab === 'plans') {
      return Promise.all([schedules.refetch(), channels.refetch(), taxonomy.refetch(), schedulerHealth.refetch()]);
    }
    if (activeTab === 'alerts') {
      return Promise.all([alerts.refetch(), channels.refetch()]);
    }
    if (activeTab === 'report') {
      return Promise.all([smartReport.refetch(), channels.refetch()]);
    }
    return Promise.all([feishuSetting.refetch()]);
  }

  const planError = needsPlanData ? schedules.error ?? channels.error : null;
  const alertError = needsAlertData ? alerts.error ?? channels.error : null;
  const reportError = activeTab === 'report' ? smartReport.error : null;
  const feishuError = activeTab === 'feishu' ? feishuSetting.error : null;
  const schedulerHealthError = needsPlanData ? schedulerHealth.error : null;
  const pageError = planError ?? alertError ?? reportError ?? feishuError;
  const channelSummaries = smartReport.data?.channel_summaries ?? [];
  const filteredAlerts = useMemo(() => {
    return (alerts.data ?? []).filter((alert) => matchesAlertResultFilter(alert, alertResultFilter));
  }, [alertResultFilter, alerts.data]);
  const hasAlertFilters = Boolean(trimmedAlertIdQuery) || alertStatus !== 'all' || Boolean(alertTimeRange) || alertResultFilter !== 'all';
  const recentAlerts = useMemo(() => {
    return (smartReport.data?.recent_alerts ?? []).filter((alert) => matchesAlertResultFilter(alert, alertResultFilter));
  }, [alertResultFilter, smartReport.data?.recent_alerts]);

  useEffect(() => {
    const visibleIds = new Set(recentAlerts.map((alert) => alert.id));
    setSelectedRecentAlertRowKeys((keys) => keys.filter((key) => visibleIds.has(String(key))));
  }, [recentAlerts]);
  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }} className="page-stack">
      {pageError ? (
        <Alert
          type="error"
          showIcon
          message="自动巡检数据加载失败"
          description={getErrorMessage(pageError)}
          action={<Button onClick={refetchActiveTabData}>重试</Button>}
        />
      ) : null}

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as ScheduledTab)}
        items={[
          {
            key: 'plans',
            label: '巡检计划',
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <section className="patrol-guide-panel">
                  <div className="patrol-guide-header">
                    <div>
                      <Typography.Title level={4}>自动巡检配置教程</Typography.Title>
                      <Typography.Paragraph type="secondary">
                        自动巡检会执行 Thinking Signature 互通检测和多项真实模型请求探针，用响应 ID 判断渠道来源特征。
                      </Typography.Paragraph>
                    </div>
                    <Button type="primary" size="large" onClick={() => openCreateSchedule()}>新增计划</Button>
                  </div>
                  <div className="patrol-guide-steps">
                    {patrolGuideSteps.map((step, index) => (
                      <div className="patrol-guide-step" key={step.title}>
                        <span>{index + 1}</span>
                        <strong>{step.title}</strong>
                        <p>{step.description}</p>
                      </div>
                    ))}
                  </div>
                  <div className="patrol-guide-presets">
                    <div className="patrol-preset-preview">
                      <strong>SIGNATURE INTEROP</strong>
                      <small>Thinking Signature 互通检测：source 生成 signature，待测渠道复用。</small>
                    </div>
                    <div className="patrol-preset-preview">
                      <strong>MODEL REQUEST</strong>
                      <small>真实模型请求：记录 message id、request id、协议和 endpoint。</small>
                    </div>
                    <div className="patrol-preset-preview">
                      <strong>告警证据</strong>
                      <small>返回 run/report/message/request/source/relay 等定位 ID。</small>
                    </div>
                  </div>
                  <Collapse
                    size="small"
                    ghost
                    items={patrolParameterFaq}
                  />
                </section>
                <Card
                  title={<span className="card-title-with-icon"><CalendarClock size={18} />按渠道自动巡检</span>}
                  extra={<Button type="primary" size="large" onClick={() => openCreateSchedule()}>新增计划</Button>}
                  bordered={false}
                >
                  {schedulerHealthError ? (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="调度器健康检查暂不可用"
                      description={getErrorMessage(schedulerHealthError)}
                    />
                  ) : null}
                  <Row gutter={[12, 12]} className="scheduler-health-row">
                    <Col xs={24} sm={12} lg={6}>
                      <Card bordered={false}>
                        <Statistic
                          title="调度器"
                          value={schedulerHealth.data ? (schedulerHealth.data.enabled ? '启用' : '停用') : '未知'}
                          valueStyle={{ color: schedulerHealth.data ? (schedulerHealth.data.enabled ? '#067647' : '#667085') : '#667085' }}
                        />
                      </Card>
                    </Col>
                    <Col xs={24} sm={12} lg={6}>
                      <Card bordered={false}>
                        <Statistic
                          title="运行中 / 排队"
                          value={schedulerHealth.data ? `${schedulerHealth.data.running_schedule_count} / ${schedulerHealth.data.queued_schedule_count}` : '-'}
                        />
                      </Card>
                    </Col>
                    <Col xs={24} sm={12} lg={6}>
                      <Card bordered={false}>
                        <Statistic
                          title="疑似卡住"
                          value={schedulerHealth.data ? schedulerHealth.data.stale_schedule_count : '-'}
                          valueStyle={{ color: schedulerHealth.data?.stale_schedule_count ? '#b42318' : '#067647' }}
                        />
                      </Card>
                    </Col>
                    <Col xs={24} sm={12} lg={6}>
                      <Card bordered={false}>
                        <Statistic title="最近心跳" value={schedulerHealth.data ? formatDateTime(schedulerHealth.data.last_tick_at) || '-' : '-'} />
                      </Card>
                    </Col>
                  </Row>
                  <Table
                    rowKey="id"
                    loading={schedules.isLoading || channels.isLoading}
                    dataSource={schedules.data ?? []}
                    pagination={{ pageSize: 8, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
                    scroll={{ x: 1380 }}
                    locale={{ emptyText: schedules.isLoading || channels.isLoading ? ' ' : <Empty description="暂无自动巡检计划" image={Empty.PRESENTED_IMAGE_SIMPLE}><Button type="primary" onClick={openCreateSchedule}>立即创建</Button></Empty> }}
                    columns={[
                      {
                        title: '计划',
                        width: 230,
                        render: (_, schedule) => (
                          <Space direction="vertical" size={2}>
                            <strong>{schedule.name}</strong>
                            <Typography.Text type="secondary">{schedule.id}</Typography.Text>
                          </Space>
                        ),
                      },
                      {
                        title: '渠道',
                        width: 220,
                        render: (_, schedule) => {
                          const channel = channelById.get(schedule.channel_id);
                          if (!channel) return <Typography.Text>{schedule.channel_id}</Typography.Text>;
                          return (
                            <Space direction="vertical" size={2}>
                              <Typography.Text strong>{channel.name}</Typography.Text>
                              <Typography.Text type="secondary">{channel.model_name ?? '未配置模型'}</Typography.Text>
                            </Space>
                          );
                        },
                      },
                      {
                        title: '巡检结果',
                        width: 100,
                        render: (_, schedule) => probeSummary(schedule),
                      },
                      {
                        title: '频率',
                        width: 110,
                        render: (_, schedule) => intervalText(schedule.interval_minutes),
                      },
                      {
                        title: '执行窗口',
                        width: 190,
                        render: (_, schedule) => runWindowText(schedule),
                      },
                      {
                        title: '上次运行',
                        width: 260,
                        render: (_, schedule) => (
                          schedule.last_run_id ? <Link to={`/runs/${schedule.last_run_id}`}>{schedule.last_run_id}</Link> : '-'
                        ),
                      },
                      {
                        title: '下次执行',
                        width: 180,
                        render: (_, schedule) => {
                          if (!schedule.next_run_at) return '-';
                          const next = dayjs(schedule.next_run_at);
                          const diffMin = next.diff(dayjs(), 'minute');
                          const relative = diffMin <= 0 ? '即将执行' : diffMin < 60 ? `${diffMin} 分钟后` : diffMin < 1440 ? `${Math.floor(diffMin / 60)} 小时后` : `${Math.floor(diffMin / 1440)} 天后`;
                          return (
                            <Space direction="vertical" size={2}>
                              <Typography.Text>{formatDateTime(schedule.next_run_at)}</Typography.Text>
                              {schedule.enabled ? <Typography.Text type="secondary">{relative}</Typography.Text> : null}
                            </Space>
                          );
                        },
                      },
                      {
                        title: '状态',
                        width: 210,
                        render: (_, schedule) => (
                          <Space direction="vertical" size={4}>
                            <Tag color={schedule.enabled ? 'green' : 'default'}>{schedule.enabled ? '启用' : '停用'}</Tag>
                            <Tag color={schedule.is_stale ? 'red' : scheduleStatusColor[schedule.last_status ?? 'idle'] ?? 'default'}>{schedule.is_stale ? 'stale' : schedule.last_status ?? 'idle'}</Tag>
                            {schedule.locked_until ? <Typography.Text type={schedule.is_stale ? 'danger' : 'secondary'}>锁至 {formatDateTime(schedule.locked_until)}</Typography.Text> : null}
                            {schedule.last_started_at ? <Typography.Text type="secondary">开始 {formatDateTime(schedule.last_started_at)}</Typography.Text> : null}
                            {schedule.last_finished_at ? <Typography.Text type="secondary">完成 {formatDateTime(schedule.last_finished_at)}</Typography.Text> : null}
                          </Space>
                        ),
                      },
                      {
                        title: '操作',
                        width: 250,
                        fixed: 'right',
                        render: (_, schedule) => (
                          <Space wrap>
                            <Tooltip title="立即执行一次">
                              <Button
                                icon={<Play size={15} />}
                                loading={runningScheduleId === schedule.id}
                                onClick={() => {
                                  setRunningScheduleId(schedule.id);
                                  runNow.mutate(schedule.id);
                                }}
                              >
                                执行
                              </Button>
                            </Tooltip>
                            <Button icon={<Edit3 size={15} />} onClick={() => openEditSchedule(schedule)}>编辑</Button>
                            {(
                              <Popconfirm
                                title="删除自动巡检计划"
                                description="删除后该计划不再自动执行；历史告警、巡检日志和原始证据会保留。确定删除吗？"
                                okText="删除"
                                okButtonProps={{ danger: true }}
                                cancelText="取消"
                                onConfirm={() => {
                                  setDeletingScheduleId(schedule.id);
                                  deleteSchedule.mutate(schedule.id);
                                }}
                              >
                                <Button danger icon={<Trash2 size={15} />} loading={deletingScheduleId === schedule.id}>删除</Button>
                              </Popconfirm>
                            )}
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Card>
              </Space>
            ),
          },
          {
            key: 'alerts',
            label: '复审告警',
            children: (
      <Card
        title={<span className="card-title-with-icon"><Bell size={18} />复审告警</span>}
        extra={
          <Select
            value={alertStatus}
            onChange={setAlertStatus}
            style={{ width: 150 }}
            options={[
              { value: 'pending_review', label: '待复审' },
              { value: 'confirmed_issue', label: '确认问题' },
              { value: 'false_positive', label: '误报' },
              { value: 'resolved', label: '已处理' },
              { value: 'all', label: '全部' },
            ]}
          />
        }
        bordered={false}
      >
        <Space wrap style={{ width: '100%', marginBottom: 16 }}>
          <Input.Search
            allowClear
            value={alertIdQuery}
            onChange={(event) => setAlertIdQuery(event.target.value)}
            onSearch={(value) => setAlertIdQuery(value)}
            placeholder="输入 request_id / message_id / run_id / report_id"
            style={{ width: 420, maxWidth: '100%' }}
          />
          <DatePicker.RangePicker
            showTime
            value={alertTimeRange}
            onChange={(range) => setAlertTimeRange(range)}
            allowClear
            style={{ width: 380, maxWidth: '100%' }}
          />
          <Select
            value={alertResultFilter}
            onChange={setAlertResultFilter}
            style={{ width: 150 }}
            options={[
              { value: 'failure', label: '失败优先' },
              { value: 'success', label: '成功' },
              { value: 'all', label: '全部' },
            ]}
          />
          <Button onClick={clearAlertFilters}>清空</Button>
          {(
            <Popconfirm
              title="删除已选告警"
              description={`将删除 ${selectedAlertRowKeys.length} 条复审告警；巡检日志、报告和原始证据会保留。确定删除吗？`}
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              disabled={!selectedAlertRowKeys.length}
              onConfirm={deleteSelectedAlerts}
            >
              <Button danger icon={<Trash2 size={15} />} disabled={!selectedAlertRowKeys.length} loading={deleteAlerts.isPending}>
                删除已选
              </Button>
            </Popconfirm>
          )}
        </Space>
        <Table
          rowKey="id"
          loading={alerts.isLoading || channels.isLoading}
          dataSource={filteredAlerts}
          locale={{ emptyText: alerts.isLoading || channels.isLoading ? '正在加载复审告警' : hasAlertFilters ? <Empty description="当前筛选条件下无告警" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : <Empty description="暂无复审告警" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          rowSelection={{
            selectedRowKeys: selectedAlertRowKeys,
            onChange: setSelectedAlertRowKeys,
            preserveSelectedRowKeys: true,
          }}
          rowClassName={(alert) => (alert.id === selectedAlertId ? 'highlight-table-row' : '')}
          pagination={{ pageSize: 8, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
          scroll={{ x: 1360 }}
          expandable={{
            expandedRowRender: (alert) => {
              return (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Space wrap>
                    {(alert.trigger_labels?.length ? alert.trigger_labels : ['无异常标签']).map((label) => (
                      <Tag color={label === '无异常标签' ? 'default' : 'red'} key={label}>{label}</Tag>
                    ))}
                  </Space>
                  <Typography.Text type="secondary">
                    渠道：{alertChannelText(alert, channelById.get(alert.channel_id)).displayId} · 判定：{alertErrorText(alert)} · 时间：{formatDateTime(alertProbeCompletedAt(alert)) || formatDateTime(alert.created_at) || '-'}
                  </Typography.Text>
                  <Space wrap>
                    <Button icon={<Eye size={15} />} onClick={() => openAlertLogDrawer(alert)}>查看日志</Button>
                    <Link to={`/runs/${alert.run_id}`}>查看报告</Link>
                    {alert.notification_error ? (
                      <Typography.Text type="danger">飞书发送错误：{alert.notification_error}</Typography.Text>
                    ) : null}
                  </Space>
                </Space>
              );
            },
          }}
          columns={[
            {
              title: '渠道',
              width: 280,
              render: (_, alert) => {
                const channel = alertChannelText(alert, channelById.get(alert.channel_id));
                return (
                  <Space direction="vertical" size={4}>
                    <Typography.Text strong>{channel.displayId}</Typography.Text>
                    {channel.model ? <Typography.Text type="secondary">{channel.model}</Typography.Text> : null}
                  </Space>
                );
              },
            },
            {
              title: '巡检结果',
              width: 120,
              render: (_, alert) => <Tag color={alertOutcomeColor(alert.status)}>{alertOutcomeLabel(alert.status)}</Tag>,
            },
            {
              title: '异常探针 / 时间点 / ID',
              width: 360,
              render: (_, alert) => alertSummaryCell(alert, channelById.get(alert.channel_id)),
            },
            {
              title: '复审状态',
              width: 150,
              render: (_, alert) => <Tag color={alertStatusColor[alert.status] ?? 'default'}>{alertStatusLabel[alert.status] ?? alert.status}</Tag>,
            },
            {
              title: '告警创建时间',
              width: 190,
              render: (_, alert) => formatDateTime(alert.created_at),
            },
            {
              title: '飞书',
              width: 120,
              render: (_, alert) => (
                <Tooltip title={alert.notification_error || undefined}>
                  <Tag color={alert.notification_status === 'sent' ? 'green' : alert.notification_status === 'failed' ? 'red' : 'default'}>
                    {alert.notification_status}
                  </Tag>
                </Tooltip>
              ),
            },
            {
              title: '操作',
              width: 260,
              fixed: 'right',
              render: (_, alert) => (
                <Space wrap>
                  <Link to={`/runs/${alert.run_id}`}>查看详情</Link>
                  {alert.status === 'pending_review' ? <Button type="primary" onClick={() => openReview(alert)}>复审</Button> : <Button onClick={() => openReview(alert)}>更新复审</Button>}
                  <Button
                    icon={<RefreshCw size={15} />}
                    loading={resendingAlertIds.has(alert.id)}
                    disabled={resendingAlertIds.has(alert.id)}
                    onClick={() => resend.mutate(alert.id)}
                  >
                    重发
                  </Button>
                  {(
                    <Popconfirm
                      title="删除告警"
                      description="只删除这条复审告警；巡检日志、报告和原始证据会保留。确定删除吗？"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => deleteOneAlert(alert)}
                    >
                      <Button danger icon={<Trash2 size={15} />} loading={deletingAlertId === alert.id}>删除</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>
            ),
          },
          {
            key: 'report',
            label: '智能报告',
            children: (
              <Space direction="vertical" size={20} style={{ width: '100%' }}>
                <Card
                  title={<span className="card-title-with-icon"><BarChart3 size={18} />智能巡检汇总报告</span>}
                  extra={
                    <Space wrap className="smart-report-actions">
                      <Select
                        value={reportRange}
                        onChange={setReportRange}
                        style={{ width: 130 }}
                        options={[
                          { value: '24h', label: '近 24 小时' },
                          { value: '7d', label: '近 7 天' },
                          { value: '30d', label: '近 30 天' },
                        ]}
                      />
                      <Button href={api.smartPatrolReportUrl(reportDates.from, reportDates.to)} target="_blank">下载 Markdown</Button>
                      <Button icon={<Send size={15} />} loading={sendDaily.isPending} onClick={() => sendDaily.mutate()}>发送日报</Button>
                    </Space>
                  }
                  bordered={false}
                >
                  <Row gutter={[14, 14]} className="smart-report-stats">
                    <Col xs={24} sm={12} lg={6}><Card bordered={false}><Statistic title="巡检任务" value={smartReport.data?.run_count ?? 0} /></Card></Col>
                    <Col xs={24} sm={12} lg={6}><Card bordered={false}><Statistic title="成功" value={smartReport.data?.completed_run_count ?? 0} valueStyle={{ color: '#067647' }} /></Card></Col>
                    <Col xs={24} sm={12} lg={6}><Card bordered={false}><Statistic title="错误" value={smartReport.data?.failed_run_count ?? 0} valueStyle={{ color: '#b42318' }} /></Card></Col>
                    <Col xs={24} sm={12} lg={6}><Card bordered={false}><Statistic title="异常告警" value={smartReport.data?.alert_count ?? 0} valueStyle={{ color: '#b42318' }} /></Card></Col>
                    <Col xs={24} sm={12} lg={6}><Card bordered={false}><Statistic title="待复审" value={smartReport.data?.pending_review_count ?? 0} valueStyle={{ color: '#a35f45' }} /></Card></Col>
                  </Row>
                  <Typography.Title level={5} className="smart-report-section-title">渠道巡检汇总</Typography.Title>
                  {smartReport.isLoading ? (
                    <div className="smart-report-empty">正在加载智能巡检报告</div>
                  ) : channelSummaries.length ? (
                    <Table
                      rowKey="channel_id"
                      dataSource={channelSummaries}
                      pagination={{ pageSize: 8 }}
                      scroll={{ x: 900 }}
                      columns={[
                        {
                          title: '渠道',
                          width: 260,
                          render: (_, item) => {
                            const channel = channelById.get(item.channel_id);
                            const displayId = channel
                              ? formatChannelDisplayName(channel)
                              : formatProviderChannelDisplayName({
                                id: item.channel_id,
                                name: item.channel_name,
                                providerType: item.channel_provider_type,
                                accountType: item.channel_account_type,
                              }, item.channel_id);
                            return (
                              <Space direction="vertical" size={2}>
                                <Typography.Text strong>{displayId}</Typography.Text>
                                {item.channel_model_name ? <Typography.Text type="secondary">{item.channel_model_name}</Typography.Text> : null}
                              </Space>
                            );
                          },
                        },
                        { title: '巡检次数', dataIndex: 'run_count', width: 110 },
                        { title: '错误数', dataIndex: 'alert_count', width: 100, render: (value: number) => <Tag color={value ? 'red' : 'green'}>{value}</Tag> },
                        { title: '待复审', dataIndex: 'pending_review_count', width: 100 },
                        { title: '最近巡检', dataIndex: 'last_run_at', width: 180, render: formatDateTime },
                      ]}
                    />
                  ) : (
                    <div className="smart-report-empty">
                      <Empty description="暂无巡检报告数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    </div>
                  )}
                </Card>
                <Card title="最近异常" bordered={false}>
                  {smartReport.isLoading ? (
                    <div className="smart-report-empty">正在加载最近异常</div>
                  ) : recentAlerts.length ? (
                    <Space wrap style={{ marginBottom: 12 }}>
                      <Select
                        value={alertResultFilter}
                        onChange={setAlertResultFilter}
                        style={{ width: 150 }}
                        options={[
                          { value: 'failure', label: '失败优先' },
                          { value: 'success', label: '成功' },
                          { value: 'all', label: '全部' },
                        ]}
                      />
                      {(
                        <Popconfirm
                          title="删除已选最近异常"
                          description={`将删除当前可见列表中已选的 ${selectedRecentAlertRowKeys.length} 条告警记录；巡检日志、报告和原始证据会保留。确定删除吗？`}
                          okText="删除"
                          okButtonProps={{ danger: true }}
                          cancelText="取消"
                          disabled={!selectedRecentAlertRowKeys.length}
                          onConfirm={deleteSelectedRecentAlerts}
                        >
                          <Button danger icon={<Trash2 size={15} />} disabled={!selectedRecentAlertRowKeys.length} loading={deleteAlerts.isPending}>
                            删除已选
                          </Button>
                        </Popconfirm>
                      )}
                      <Typography.Text type="secondary">已选 {selectedRecentAlertRowKeys.length} / 当前可见 {recentAlerts.length}</Typography.Text>
                    </Space>
                  ) : null}
                  {smartReport.isLoading ? (
                    <div className="smart-report-empty">正在加载最近异常</div>
                  ) : recentAlerts.length ? (
                    <Table
                      rowKey="id"
                      dataSource={recentAlerts}
                      pagination={false}
                      scroll={{ x: 1460 }}
                      rowSelection={{
                        selectedRowKeys: selectedRecentAlertRowKeys,
                        onChange: setSelectedRecentAlertRowKeys,
                      }}
                      columns={[
                        {
                          title: '渠道',
                          width: 250,
                          render: (_, alert) => {
                            const channel = alertChannelText(alert, channelById.get(alert.channel_id));
                            return (
                              <Space direction="vertical" size={2}>
                                <Typography.Text strong>{channel.displayId}</Typography.Text>
                                {channel.model ? <Typography.Text type="secondary">{channel.model}</Typography.Text> : null}
                              </Space>
                            );
                          },
                        },
                        { title: '结果', width: 110, render: (_, alert) => <Tag color={alertOutcomeColor(alert.status)}>{alertOutcomeLabel(alert.status)}</Tag> },
                        { title: '异常探针 / 时间点 / ID', width: 360, render: (_, alert) => alertSummaryCell(alert, channelById.get(alert.channel_id)) },
                        { title: '告警创建时间', dataIndex: 'created_at', width: 180, render: (_, alert) => formatDateTime(alert.created_at) },
                        { title: 'Request ID', width: 210, render: (_, alert) => <Typography.Text copyable={{ text: alertRequestId(alert) }}>{alertRequestId(alert) || '-'}</Typography.Text> },
                        {
                          title: '操作',
                          width: 230,
                          fixed: 'right',
                          render: (_, alert) => (
                            <Space wrap>
                              <Button type="link" icon={<Eye size={15} />} onClick={() => openAlertLogDrawer(alert)}>查看日志</Button>
                              {(
                                <Popconfirm
                                  title="删除最近异常"
                                  description="只删除这条告警记录；巡检日志、报告和原始证据会保留。确定删除吗？"
                                  okText="删除"
                                  okButtonProps={{ danger: true }}
                                  cancelText="取消"
                                  onConfirm={() => deleteOneAlert(alert)}
                                >
                                  <Button danger icon={<Trash2 size={15} />} loading={deletingAlertId === alert.id}>删除</Button>
                                </Popconfirm>
                              )}
                            </Space>
                          ),
                        },
                      ]}
                    />
                  ) : (
                    <div className="smart-report-empty">
                      <Empty description={alertResultFilter === 'failure' ? '暂无失败告警' : '当前筛选条件下无异常告警'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    </div>
                  )}
                </Card>
              </Space>
            ),
          },
          {
            key: 'feishu',
            label: '飞书设置',
            children: (
              <Card
                title={<span className="card-title-with-icon"><Settings size={18} />飞书播报设置</span>}
                extra={
                  <Space wrap>
                    <Tag color={feishuSetting.data?.webhook_configured ? 'green' : 'default'}>
                      {feishuSetting.data?.webhook_configured ? `Webhook ${feishuSetting.data.webhook_preview}` : '未配置 Webhook'}
                    </Tag>
                    <Tag color={feishuSetting.data?.secret_configured ? 'green' : 'default'}>
                      {feishuSetting.data?.secret_configured ? '已配置签名密钥' : '未配置签名密钥'}
                    </Tag>
                  </Space>
                }
                bordered={false}
              >
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 18 }}
                  message="飞书配置教程"
                  description={(
                    <Space direction="vertical" size={8}>
                      <Typography.Text>
                        Webhook 从飞书群机器人复制；签名密钥只有机器人开启签名校验时才填，不懂可以先留空；系统访问地址填写别人能打开的前端地址，用于告警和日报里的跳转链接。
                      </Typography.Text>
                      <Typography.Text>
                        申请方式：进入要接收通知的飞书群，打开群设置或群应用，添加“自定义机器人”，按提示创建机器人后复制 Webhook 地址。机器人安全设置里如果开启“签名校验”，飞书会生成一段签名密钥，把它填到下方“签名密钥”；没有开启签名校验就不用填。
                      </Typography.Text>
                      <Typography.Text>
                        这里使用的是群自定义机器人，不需要申请飞书开放平台应用，也不需要填写 App ID 或 App Secret。保存设置后先点击“发送测试消息”，群里能收到消息再开启告警和日报。
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        官方参考：<Typography.Link href="https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot" target="_blank" rel="noreferrer">飞书自定义机器人使用指南</Typography.Link>
                      </Typography.Text>
                    </Space>
                  )}
                />
                <Form form={feishuForm} layout="vertical" onFinish={submitFeishu} requiredMark={false}>
                  <Row gutter={18}>
                    <Col xs={24} md={12}>
                      <Form.Item label="启用飞书播报" name="enabled" valuePropName="checked">
                        <Switch checkedChildren="启用" unCheckedChildren="停用" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item label="日报发送时间" name="daily_report_time" rules={[{ required: true, message: '请输入日报时间' }]}>
                        <TimePicker allowClear={false} format="HH:mm" minuteStep={5} showNow={false} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item
                        label="飞书机器人 Webhook"
                        name="webhook_url"
                        rules={[
                          {
                            validator: (_, value) => {
                              if (!feishuForm.getFieldValue('enabled') || feishuSetting.data?.webhook_configured || String(value ?? '').trim()) {
                                return Promise.resolve();
                              }
                              return Promise.reject(new Error('请填写飞书机器人 Webhook'));
                            },
                          },
                        ]}
                      >
                        <Input placeholder={feishuSetting.data?.webhook_preview ?? 'https://open.feishu.cn/open-apis/bot/v2/hook/...'} />
                        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                          在飞书群添加自定义机器人后复制 Webhook；已配置过时留空会保留原值。
                        </Typography.Text>
                      </Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item label="签名密钥" name="webhook_secret">
                        <Input.Password placeholder={feishuSetting.data?.secret_configured ? '留空则保留现有密钥' : '可选'} />
                        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                          机器人没有开启签名校验时不用填；已配置过时留空会保留原值。
                        </Typography.Text>
                      </Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item name="clear_webhook_secret" valuePropName="checked">
                        <Checkbox>清空已保存的签名密钥</Checkbox>
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item label="系统访问地址" name="app_base_url">
                        <Input placeholder="http://localhost:5174" />
                        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                          填前端页面地址，例如部署后的域名；本机调试可用 localhost。
                        </Typography.Text>
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item label="时区" name="timezone" rules={[{ required: true, message: '请输入时区' }]}>
                        <Input placeholder="Asia/Shanghai" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="alert_broadcast_enabled" valuePropName="checked">
                        <Checkbox>异常告警立即播报</Checkbox>
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="daily_report_enabled" valuePropName="checked">
                        <Checkbox>每天发送智能巡检日报</Checkbox>
                      </Form.Item>
                    </Col>
                  </Row>
                  <Space wrap>
                    <Button type="primary" htmlType="submit" loading={saveFeishu.isPending}>保存设置</Button>
                    <Button icon={<Send size={15} />} loading={testFeishu.isPending} onClick={() => testFeishu.mutate()}>发送测试消息</Button>
                    <Typography.Text type="secondary">
                      最近日报：{formatDateTime(feishuSetting.data?.last_daily_report_at)}
                    </Typography.Text>
                  </Space>
                </Form>
              </Card>
            ),
          },
        ]}
      />

      <Modal
        title={editingSchedule ? '编辑自动巡检计划' : '新增自动巡检计划'}
        open={scheduleModalOpen}
        onCancel={() => setScheduleModalOpen(false)}
        onOk={() => scheduleForm.submit()}
        okText={editingSchedule ? '保存' : '创建'}
        confirmLoading={createSchedule.isPending || updateSchedule.isPending}
        width={720}
        destroyOnClose
        forceRender
      >
        <Form form={scheduleForm} layout="vertical" onFinish={submitSchedule} requiredMark={false}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="固定巡检内容"
            description="系统会自动执行 Thinking Signature 互通检测和多项真实模型请求探针，不需要再选择测试集、渠道指纹或评分阈值。"
          />
          <Form.Item label="计划名称" name="name" rules={[{ required: true, message: '请输入计划名称' }]}>
            <Input placeholder="第三方 Sonnet 渠道每日巡检" />
          </Form.Item>
          <Form.Item label="待测渠道" name="channel_id" rules={[{ required: true, message: '请选择待测渠道' }]}>
            <Select
              placeholder="选择候选或负样本渠道"
              options={candidateChannels.map((channel) => ({ value: channel.id, label: `${formatChannelDisplayName(channel)} (${roleLabel(channel.role, taxonomy.data)} / ${channel.model_name ?? '未配置模型'})` }))}
            />
          </Form.Item>
          <Form.Item
            label="执行间隔（分钟）"
            name="interval_minutes"
            rules={[
              { required: true, message: '请输入执行间隔' },
              { type: 'number', min: 5, max: 43200, message: '执行间隔需在 5 到 43200 分钟之间' },
            ]}
            extra="日常建议 1440 分钟；刚接入或排查时可用 60 分钟。"
          >
            <InputNumber min={5} max={43200} precision={0} style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="run_window_enabled" valuePropName="checked">
            <Checkbox>限制自动执行时间段</Checkbox>
          </Form.Item>
          {runWindowEnabled ? (
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label="开始时间（北京时间）" name="run_window_start" rules={[{ required: true, message: '请选择开始时间' }]}>
                  <Input type="time" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="结束时间（北京时间）" name="run_window_end" rules={[{ required: true, message: '请选择结束时间' }]}>
                  <Input type="time" />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Typography.Text type="secondary">
                  间隔只在该时间段内生效；窗口外会顺延到下一个开始时间。结束早于开始时按跨天窗口处理。
                </Typography.Text>
              </Col>
            </Row>
          ) : null}
          <Space size="large" wrap>
            <Form.Item name="enabled" valuePropName="checked">
              <Checkbox>启用计划</Checkbox>
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="提交复审结果"
        open={Boolean(reviewingAlert)}
        onCancel={() => setReviewingAlert(null)}
        onOk={() => reviewForm.submit()}
        okText="保存复审"
        confirmLoading={reviewAlert.isPending}
        destroyOnClose
        forceRender
      >
        <Form form={reviewForm} layout="vertical" onFinish={submitReview} requiredMark={false}>
          <Form.Item label="复审结论" name="status" rules={[{ required: true, message: '请选择复审结论' }]}>
            <Select
              options={[
                { value: 'confirmed_issue', label: '确认问题' },
                { value: 'false_positive', label: '误报' },
                { value: 'resolved', label: '已处理' },
              ]}
            />
          </Form.Item>
          <Form.Item label="复审人" name="reviewer_name" rules={[{ required: true, message: '请输入复审人' }]}>
            <Input placeholder="管理员姓名" />
          </Form.Item>
          <Form.Item label="处理备注" name="review_note">
            <Input.TextArea rows={4} placeholder="记录判断依据、处理动作或后续复测安排" />
          </Form.Item>
        </Form>
      </Modal>

      <AlertLogDrawer
        alert={openAlertLog}
        channelName={openAlertLogChannel?.name ?? ''}
        channelDisplayId={openAlertLogChannel?.displayId ?? ''}
        onClose={closeAlertLogDrawer}
      />
    </Space>
  );
}
