import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Col, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography, message } from 'antd';
import { BarChart3, Bell, CalendarClock, Edit3, Play, RefreshCw, Send, Settings, Trash2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, getErrorMessage } from '../api';
import { isCandidateChannel, roleLabel } from '../channelTaxonomy';
import { formatDateTime } from '../time';
import type { Channel, ChannelAlert, ChannelAlertStatus, FeishuBroadcastUpdate, ScheduledChannelTest } from '../types';

type ScheduleFormValues = {
  name: string;
  channel_id: string;
  interval_minutes: number;
  run_window_enabled?: boolean;
  run_window_start?: string;
  run_window_end?: string;
  enabled: boolean;
};

type ReviewFormValues = {
  status: Exclude<ChannelAlertStatus, 'pending_review'>;
  reviewer_name: string;
  review_note?: string;
};

type FeishuFormValues = {
  enabled: boolean;
  webhook_url?: string;
  webhook_secret?: string;
  clear_webhook_secret?: boolean;
  app_base_url?: string;
  alert_broadcast_enabled: boolean;
  daily_report_enabled: boolean;
  daily_report_time: string;
  timezone: string;
};

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
  { title: '查看判断依据', description: '告警会返回 run、report、result、message id 和 source/relay 响应 ID。' },
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
    children: '系统发送 thinking temperature 探针，记录 message id、协议、endpoint 和 result id，用于判断 AWS/Bedrock、Claude/Anthropic 或中间层改写。',
  },
  {
    key: 'alert_ids',
    label: '告警里的 ID 有什么用？',
    children: 'run_id 和 report_id 用来查看完整报告；model_request_result_id 对应原始请求/响应；message id 和 source/relay id 用来判断响应来源特征。',
  },
];

function intervalText(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function runWindowText(schedule: Pick<ScheduledChannelTest, 'run_window_start' | 'run_window_end'>) {
  if (!schedule.run_window_start || !schedule.run_window_end) return '全天';
  if (schedule.run_window_start > schedule.run_window_end) {
    return `${schedule.run_window_start}-次日 ${schedule.run_window_end} 北京时间`;
  }
  return `${schedule.run_window_start}-${schedule.run_window_end} 北京时间`;
}

function evidenceText(alert: ChannelAlert) {
  const evidence = alert.evidence_summary ?? {};
  const hint = evidence.detected_provider_hint ? String(evidence.detected_provider_hint) : '';
  const messageId = evidence.model_request_message_id ? ` · ${String(evidence.model_request_message_id)}` : '';
  return hint ? `${hint}${messageId}` : messageId || '-';
}

function reportRangeToDates(range: string) {
  const to = new Date();
  const from = new Date(to);
  const days = range === '24h' ? 1 : range === '30d' ? 30 : 7;
  from.setDate(from.getDate() - days);
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function ScheduledTests() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const selectedAlertId = searchParams.get('alert');
  const initialTab = searchParams.get('tab') === 'report' ? 'report' : searchParams.get('tab') === 'feishu' ? 'feishu' : selectedAlertId ? 'alerts' : 'plans';
  const [scheduleForm] = Form.useForm<ScheduleFormValues>();
  const [reviewForm] = Form.useForm<ReviewFormValues>();
  const [feishuForm] = Form.useForm<FeishuFormValues>();
  const [editingSchedule, setEditingSchedule] = useState<ScheduledChannelTest | null>(null);
  const [reviewingAlert, setReviewingAlert] = useState<ChannelAlert | null>(null);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [alertStatus, setAlertStatus] = useState<string>('pending_review');
  const [activeTab, setActiveTab] = useState(initialTab);
  const [reportRange, setReportRange] = useState('7d');
  const runWindowEnabled = Form.useWatch('run_window_enabled', scheduleForm);
  const reportDates = useMemo(() => reportRangeToDates(reportRange), [reportRange]);
  const needsPlanData = activeTab === 'plans';
  const needsAlertData = activeTab === 'alerts';

  const schedules = useQuery({
    queryKey: ['scheduledTests'],
    queryFn: api.scheduledTests,
    enabled: needsPlanData,
    refetchInterval: activeTab === 'plans' ? 5000 : false,
  });
  const alerts = useQuery({
    queryKey: ['alerts', alertStatus],
    queryFn: () => api.alerts(alertStatus === 'all' ? undefined : alertStatus),
    enabled: needsAlertData,
    refetchInterval: activeTab === 'alerts' && alertStatus === 'pending_review' ? 5000 : false,
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
      daily_report_time: feishuSetting.data.daily_report_time,
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
    mutationFn: ({ id, payload }: { id: string; payload: Partial<ScheduledChannelTest> }) => api.updateScheduledTest(id, payload),
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
  });

  const runNow = useMutation({
    mutationFn: api.runScheduledTestNow,
    onSuccess: async () => {
      message.success('已触发立即巡检');
      await queryClient.invalidateQueries({ queryKey: ['scheduledTests'] });
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
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

  const resend = useMutation({
    mutationFn: api.resendAlertNotification,
    onSuccess: async () => {
      message.success('已重新发送通知');
      await queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const saveFeishu = useMutation({
    mutationFn: api.updateFeishuBroadcastSetting,
    onSuccess: async () => {
      message.success('飞书播报设置已保存');
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
    const payload = {
      name: values.name,
      channel_id: values.channel_id,
      interval_minutes: values.interval_minutes,
      run_window_start: values.run_window_enabled ? values.run_window_start : null,
      run_window_end: values.run_window_enabled ? values.run_window_end : null,
      enabled: values.enabled,
      test_scope: 'scheduled_probe' as const,
      repeat_count: 1,
      concurrency: 1,
      use_mock: false,
      alert_grade_threshold: 'D' as const,
      alert_score_threshold: null,
      alert_red_flags_enabled: true,
      quiet_minutes: 0,
      max_retries: 0,
      retry_interval_minutes: 5,
    };
    if (editingSchedule) {
      updateSchedule.mutate({ id: editingSchedule.id, payload });
      return;
    }
    createSchedule.mutate(payload);
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

  function submitFeishu(values: FeishuFormValues) {
    const payload: FeishuBroadcastUpdate = {
      enabled: values.enabled,
      webhook_url: values.webhook_url?.trim() || undefined,
      webhook_secret: values.webhook_secret?.trim() || undefined,
      clear_webhook_secret: values.clear_webhook_secret,
      app_base_url: values.app_base_url?.trim() || null,
      alert_broadcast_enabled: values.alert_broadcast_enabled,
      daily_report_enabled: values.daily_report_enabled,
      daily_report_time: values.daily_report_time,
      timezone: values.timezone,
    };
    saveFeishu.mutate(payload);
  }

  const planError = needsPlanData ? schedules.error ?? channels.error : null;
  const alertError = needsAlertData ? alerts.error ?? channels.error : null;
  const reportError = activeTab === 'report' ? smartReport.error : null;
  const feishuError = activeTab === 'feishu' ? feishuSetting.error : null;
  const error = planError ?? alertError ?? reportError ?? feishuError;
  const hasError = Boolean(error);
  const channelSummaries = smartReport.data?.channel_summaries ?? [];
  const recentAlerts = smartReport.data?.recent_alerts ?? [];

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }} className="page-stack">
      {hasError ? (
        <Alert
          type="error"
          showIcon
          message="自动巡检数据加载失败"
          description={getErrorMessage(error)}
          action={<Button onClick={() => Promise.all([schedules.refetch(), alerts.refetch(), channels.refetch(), smartReport.refetch(), feishuSetting.refetch()])}>重试</Button>}
        />
      ) : null}

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
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
                        自动巡检只跑两项真实探针：Signature 互通检测和真实模型请求，用响应 ID 判断渠道来源特征。
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
                      <small>真实模型请求：记录 message id、协议、endpoint、result id。</small>
                    </div>
                    <div className="patrol-preset-preview">
                      <strong>告警证据</strong>
                      <small>返回 run/report/result/message/source/relay 等定位 ID。</small>
                    </div>
                  </div>
                </section>
                <Card
                  title={<span className="card-title-with-icon"><CalendarClock size={18} />按渠道自动巡检</span>}
                  extra={<Button type="primary" size="large" onClick={() => openCreateSchedule()}>新增计划</Button>}
                  bordered={false}
                >
                  <Table
                    rowKey="id"
                    loading={schedules.isLoading || channels.isLoading}
                    dataSource={schedules.data ?? []}
                    pagination={{ pageSize: 8, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
                    scroll={{ x: 1380 }}
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
                        render: (_, schedule) => channelById.get(schedule.channel_id)?.name ?? schedule.channel_id,
                      },
                      {
                        title: '巡检依据',
                        width: 260,
                        render: () => 'Signature 互通 + 真实模型请求',
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
                        render: (_, schedule) => formatDateTime(schedule.next_run_at),
                      },
                      {
                        title: '状态',
                        width: 150,
                        render: (_, schedule) => (
                          <Space direction="vertical" size={4}>
                            <Tag color={schedule.enabled ? 'green' : 'default'}>{schedule.enabled ? '启用' : '停用'}</Tag>
                            <Tag color={scheduleStatusColor[schedule.last_status ?? 'idle'] ?? 'default'}>{schedule.last_status ?? 'idle'}</Tag>
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
                              <Button icon={<Play size={15} />} loading={runNow.isPending} onClick={() => runNow.mutate(schedule.id)}>执行</Button>
                            </Tooltip>
                            <Button icon={<Edit3 size={15} />} onClick={() => openEditSchedule(schedule)}>编辑</Button>
                            <Popconfirm title="删除自动巡检计划" description="历史告警会保留，但不再关联该计划。" onConfirm={() => deleteSchedule.mutate(schedule.id)}>
                              <Button danger icon={<Trash2 size={15} />} loading={deleteSchedule.isPending}>删除</Button>
                            </Popconfirm>
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
        <Table
          rowKey="id"
          loading={alerts.isLoading || channels.isLoading}
          dataSource={alerts.data ?? []}
          rowClassName={(alert) => (alert.id === selectedAlertId ? 'highlight-table-row' : '')}
          pagination={{ pageSize: 8, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
          scroll={{ x: 1480 }}
          columns={[
            {
              title: '告警',
              width: 260,
              render: (_, alert) => (
                <Space direction="vertical" size={4}>
                  <strong>{alert.message ?? '渠道自动巡检异常'}</strong>
                  <Typography.Text type="secondary">{formatDateTime(alert.created_at)}</Typography.Text>
                </Space>
              ),
            },
            {
              title: '渠道',
              width: 180,
              render: (_, alert) => channelById.get(alert.channel_id)?.name ?? alert.channel_id,
            },
            {
              title: '评级',
              width: 120,
              render: (_, alert) => (
                <Space>
                  <Tag color={alert.grade === 'E' ? 'red' : 'volcano'}>{alert.grade}</Tag>
                  <strong>{alert.final_score.toFixed(1)}</strong>
                </Space>
              ),
            },
            {
              title: '异常标签',
              width: 230,
              render: (_, alert) => (
                <Space wrap>
                  {(alert.trigger_labels?.length ? alert.trigger_labels : ['无']).map((label) => <Tag color={label === '无' ? 'default' : 'red'} key={label}>{label}</Tag>)}
                </Space>
              ),
            },
            {
              title: '判断依据',
              width: 320,
              render: (_, alert) => {
                const evidence = alert.evidence_summary ?? {};
                return (
                  <Space direction="vertical" size={2}>
                    <Typography.Text>{evidenceText(alert)}</Typography.Text>
                    <Typography.Text type="secondary">
                      result: {String(evidence.model_request_result_id ?? '-')} · relay: {String(evidence.signature_relay_message_id ?? '-')}
                    </Typography.Text>
                  </Space>
                );
              },
            },
            {
              title: '状态',
              width: 130,
              render: (_, alert) => <Tag color={alertStatusColor[alert.status] ?? 'default'}>{alertStatusLabel[alert.status] ?? alert.status}</Tag>,
            },
            {
              title: '飞书',
              width: 150,
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
              width: 250,
              fixed: 'right',
              render: (_, alert) => (
                <Space wrap>
                  <Link to={`/runs/${alert.run_id}`}>查看报告</Link>
                  <Button onClick={() => openReview(alert)}>复审</Button>
                  <Button icon={<RefreshCw size={15} />} loading={resend.isPending} onClick={() => resend.mutate(alert.id)}>重发</Button>
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
                    <Col xs={24} sm={12} lg={6}><Card bordered={false}><Statistic title="异常告警" value={smartReport.data?.alert_count ?? 0} valueStyle={{ color: '#b42318' }} /></Card></Col>
                    <Col xs={24} sm={12} lg={6}><Card bordered={false}><Statistic title="待复审" value={smartReport.data?.pending_review_count ?? 0} valueStyle={{ color: '#a35f45' }} /></Card></Col>
                    <Col xs={24} sm={12} lg={6}><Card bordered={false}><Statistic title="平均分" value={smartReport.data?.avg_score ?? '-'} /></Card></Col>
                  </Row>
                  <Typography.Title level={5} className="smart-report-section-title">渠道风险排行</Typography.Title>
                  {smartReport.isLoading ? (
                    <div className="smart-report-empty">正在加载智能巡检报告</div>
                  ) : channelSummaries.length ? (
                    <Table
                      rowKey="channel_id"
                      dataSource={channelSummaries}
                      pagination={{ pageSize: 8 }}
                      scroll={{ x: 900 }}
                      columns={[
                        { title: '渠道', dataIndex: 'channel_name', width: 240 },
                        { title: '巡检次数', dataIndex: 'run_count', width: 110 },
                        { title: '异常数', dataIndex: 'alert_count', width: 100, render: (value: number) => <Tag color={value ? 'red' : 'green'}>{value}</Tag> },
                        { title: '待复审', dataIndex: 'pending_review_count', width: 100 },
                        { title: '最新评级', dataIndex: 'latest_grade', width: 110, render: (value: string | null) => value ? <Tag color={value === 'A' ? 'green' : value === 'E' ? 'red' : 'gold'}>{value}</Tag> : '-' },
                        { title: '最新分', dataIndex: 'latest_score', width: 110, render: (value: number | null) => value === null || value === undefined ? '-' : value.toFixed(1) },
                        { title: '均分', dataIndex: 'avg_score', width: 110, render: (value: number | null) => value === null || value === undefined ? '-' : value.toFixed(1) },
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
                    <Table
                      rowKey="id"
                      dataSource={recentAlerts}
                      pagination={false}
                      scroll={{ x: 920 }}
                      columns={[
                        { title: '告警', dataIndex: 'message', width: 280 },
                        { title: '评级', dataIndex: 'grade', width: 90, render: (value: string) => <Tag color={value === 'E' ? 'red' : 'volcano'}>{value}</Tag> },
                        { title: '分数', dataIndex: 'final_score', width: 100, render: (value: number) => value.toFixed(1) },
                        { title: '状态', dataIndex: 'status', width: 130, render: (value: string) => <Tag color={alertStatusColor[value] ?? 'default'}>{alertStatusLabel[value] ?? value}</Tag> },
                        { title: '创建时间', dataIndex: 'created_at', width: 180, render: formatDateTime },
                        { title: '操作', width: 120, render: (_, alert) => <Link to={`/runs/${alert.run_id}`}>查看报告</Link> },
                      ]}
                    />
                  ) : (
                    <div className="smart-report-empty">
                      <Empty description="暂无异常告警" image={Empty.PRESENTED_IMAGE_SIMPLE} />
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
                        <Input placeholder="09:00" />
                      </Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item label="飞书机器人 Webhook" name="webhook_url">
                        <Input.Password placeholder={feishuSetting.data?.webhook_preview ?? 'https://open.feishu.cn/open-apis/bot/v2/hook/...'} />
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
            description="系统会自动执行 Thinking Signature 互通检测和真实模型请求探针，不需要再选择测试集、渠道指纹或评分阈值。"
          />
          <Form.Item label="计划名称" name="name" rules={[{ required: true, message: '请输入计划名称' }]}>
            <Input placeholder="第三方 Sonnet 渠道每日巡检" />
          </Form.Item>
          <Form.Item label="待测渠道" name="channel_id" rules={[{ required: true, message: '请选择待测渠道' }]}>
            <Select
              placeholder="选择候选或负样本渠道"
              options={candidateChannels.map((channel) => ({ value: channel.id, label: `${channel.name} (${roleLabel(channel.role, taxonomy.data)} / ${channel.model_name ?? '未配置模型'})` }))}
            />
          </Form.Item>
          <Form.Item label="执行间隔（分钟）" name="interval_minutes" rules={[{ required: true }]}>
            <InputNumber min={5} max={43200} style={{ width: 180 }} />
            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
              日常建议 1440 分钟；刚接入或排查时可用 60 分钟。
            </Typography.Text>
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
    </Space>
  );
}
