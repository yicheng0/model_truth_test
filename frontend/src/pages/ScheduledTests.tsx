import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Col, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography, message } from 'antd';
import { BarChart3, Bell, CalendarClock, Edit3, Play, RefreshCw, Send, Settings, Trash2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, getErrorMessage } from '../api';
import { isCandidateChannel, roleLabel } from '../channelTaxonomy';
import { formatDateTime } from '../time';
import type { BaselineSnapshot, Channel, ChannelAlert, ChannelAlertStatus, FeishuBroadcastUpdate, ScheduledChannelTest, TestSuite } from '../types';

type ScheduleFormValues = {
  name: string;
  channel_id: string;
  suite_id: string;
  baseline_snapshot_id: string;
  interval_minutes: number;
  repeat_count: number;
  concurrency: number;
  enabled: boolean;
  use_mock: boolean;
  alert_grade_threshold: 'C' | 'D' | 'E';
  alert_score_threshold?: number | null;
  alert_red_flags_enabled: boolean;
  quiet_minutes: number;
  max_retries: number;
  retry_interval_minutes: number;
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

function intervalText(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function schedulePolicyText(schedule: ScheduledChannelTest) {
  const grade = schedule.alert_grade_threshold ?? 'D';
  const score = schedule.alert_score_threshold === null || schedule.alert_score_threshold === undefined ? '' : ` / <=${schedule.alert_score_threshold}分`;
  const redFlags = schedule.alert_red_flags_enabled ? ' + 红旗' : '';
  const quiet = schedule.quiet_minutes ? ` · 静默 ${intervalText(schedule.quiet_minutes)}` : '';
  const retry = schedule.max_retries ? ` · 重试 ${schedule.max_retries} 次` : '';
  return `${grade}级及以下${score}${redFlags}${quiet}${retry}`;
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
  const suites = useQuery<TestSuite[]>({ queryKey: ['suites'], queryFn: api.suites, enabled: needsPlanData });
  const baselines = useQuery<BaselineSnapshot[]>({ queryKey: ['baselines'], queryFn: () => api.baselines(), enabled: needsPlanData });
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
  const suiteById = useMemo(() => new Map((suites.data ?? []).map((suite) => [suite.id, suite])), [suites.data]);
  const baselineById = useMemo(() => new Map((baselines.data ?? []).map((baseline) => [baseline.id, baseline])), [baselines.data]);
  const candidateChannels = useMemo(() => (channels.data ?? []).filter(isCandidateChannel), [channels.data]);
  const watchedSuiteId = Form.useWatch('suite_id', scheduleForm);
  const readyBaselines = useMemo(
    () => (baselines.data ?? []).filter((baseline) => baseline.status === 'ready' && (!watchedSuiteId || baseline.suite_id === watchedSuiteId)),
    [baselines.data, watchedSuiteId],
  );

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
      interval_minutes: 1440,
      repeat_count: 1,
      concurrency: 4,
      enabled: true,
      use_mock: false,
      alert_grade_threshold: 'D',
      alert_score_threshold: null,
      alert_red_flags_enabled: true,
      quiet_minutes: 0,
      max_retries: 0,
      retry_interval_minutes: 5,
    });
    setScheduleModalOpen(true);
  }

  function openEditSchedule(schedule: ScheduledChannelTest) {
    setEditingSchedule(schedule);
    scheduleForm.setFieldsValue({
      name: schedule.name,
      channel_id: schedule.channel_id,
      suite_id: schedule.suite_id,
      baseline_snapshot_id: schedule.baseline_snapshot_id,
      interval_minutes: schedule.interval_minutes,
      repeat_count: schedule.repeat_count,
      concurrency: schedule.concurrency,
      enabled: schedule.enabled,
      use_mock: schedule.use_mock,
      alert_grade_threshold: schedule.alert_grade_threshold ?? 'D',
      alert_score_threshold: schedule.alert_score_threshold ?? null,
      alert_red_flags_enabled: schedule.alert_red_flags_enabled ?? true,
      quiet_minutes: schedule.quiet_minutes ?? 0,
      max_retries: schedule.max_retries ?? 0,
      retry_interval_minutes: schedule.retry_interval_minutes ?? 5,
    });
    setScheduleModalOpen(true);
  }

  async function submitSchedule(values: ScheduleFormValues) {
    const payload = { ...values, alert_score_threshold: values.alert_score_threshold ?? null, test_scope: 'full' as const };
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

  const planError = needsPlanData ? schedules.error ?? channels.error ?? suites.error ?? baselines.error : null;
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
          action={<Button onClick={() => Promise.all([schedules.refetch(), alerts.refetch(), channels.refetch(), suites.refetch(), baselines.refetch(), smartReport.refetch(), feishuSetting.refetch()])}>重试</Button>}
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
      <Card
        title={<span className="card-title-with-icon"><CalendarClock size={18} />按渠道自动巡检</span>}
        extra={<Button type="primary" size="large" onClick={openCreateSchedule}>新增计划</Button>}
        bordered={false}
      >
        <Table
          rowKey="id"
          loading={schedules.isLoading || channels.isLoading || suites.isLoading || baselines.isLoading}
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
              title: '渠道指纹 / 测试集',
              width: 260,
              render: (_, schedule) => (
                <Space direction="vertical" size={2}>
                  <span>{baselineById.get(schedule.baseline_snapshot_id)?.name ?? schedule.baseline_snapshot_id}</span>
                  <Typography.Text type="secondary">{suiteById.get(schedule.suite_id)?.name ?? schedule.suite_id}</Typography.Text>
                </Space>
              ),
            },
            {
              title: '频率',
              width: 110,
              render: (_, schedule) => intervalText(schedule.interval_minutes),
            },
            {
              title: '策略',
              width: 260,
              render: (_, schedule) => (
                <Tooltip title="评级阈值、分数阈值、红旗标签、静默窗口和失败重试设置">
                  <Typography.Text>{schedulePolicyText(schedule)}</Typography.Text>
                </Tooltip>
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
          scroll={{ x: 1180 }}
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
              width: 260,
              render: (_, alert) => (
                <Space wrap>
                  {(alert.trigger_labels?.length ? alert.trigger_labels : ['无']).map((label) => <Tag color={label === '无' ? 'default' : 'red'} key={label}>{label}</Tag>)}
                </Space>
              ),
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
                      </Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item label="签名密钥" name="webhook_secret">
                        <Input.Password placeholder={feishuSetting.data?.secret_configured ? '留空则保留现有密钥' : '可选'} />
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
          <Form.Item label="计划名称" name="name" rules={[{ required: true, message: '请输入计划名称' }]}>
            <Input placeholder="第三方 Sonnet 渠道每日巡检" />
          </Form.Item>
          <Form.Item label="待测渠道" name="channel_id" rules={[{ required: true, message: '请选择待测渠道' }]}>
            <Select
              placeholder="选择候选或负样本渠道"
              options={candidateChannels.map((channel) => ({ value: channel.id, label: `${channel.name} (${roleLabel(channel.role, taxonomy.data)} / ${channel.model_name ?? '未配置模型'})` }))}
            />
          </Form.Item>
          <Form.Item label="测试集" name="suite_id" rules={[{ required: true, message: '请选择测试集' }]}>
            <Select
              placeholder="选择测试集"
              onChange={() => scheduleForm.setFieldValue('baseline_snapshot_id', undefined)}
              options={(suites.data ?? []).map((suite) => ({ value: suite.id, label: `${suite.name} (${suite.version ?? '未标版'})` }))}
            />
          </Form.Item>
          <Form.Item label="渠道指纹" name="baseline_snapshot_id" rules={[{ required: true, message: '请选择 ready 状态的渠道指纹' }]}>
            <Select
              placeholder={watchedSuiteId ? '选择可复用渠道指纹' : '请先选择测试集'}
              options={readyBaselines.map((baseline) => ({ value: baseline.id, label: `${baseline.name} · ${formatDateTime(baseline.ready_at)}` }))}
              notFoundContent={watchedSuiteId ? '当前测试集暂无 ready 状态渠道指纹，请先提取渠道指纹' : '请先选择测试集'}
            />
          </Form.Item>
          <Space size="large" wrap>
            <Form.Item label="执行间隔（分钟）" name="interval_minutes" rules={[{ required: true }]}>
              <InputNumber min={5} max={43200} style={{ width: 160 }} />
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                最小 5 分钟；日常巡检建议 60 或 1440，排查期可临时调短。
              </Typography.Text>
            </Form.Item>
            <Form.Item label="重复次数" name="repeat_count" rules={[{ required: true }]}>
              <InputNumber min={1} max={5} style={{ width: 120 }} />
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                范围 1-5；次数越高越容易发现低概率混路，调用成本也越高。
              </Typography.Text>
            </Form.Item>
            <Form.Item label="并发度" name="concurrency" rules={[{ required: true }]}>
              <InputNumber min={1} max={16} style={{ width: 120 }} />
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                范围 1-16；限流严格或不稳定渠道建议 1-4。
              </Typography.Text>
            </Form.Item>
          </Space>
          <Typography.Title level={5}>告警策略</Typography.Title>
          <Typography.Paragraph type="secondary">
            默认保持兼容：D/E 评级或红旗标签会创建告警。分数阈值留空时不按分数单独触发。
          </Typography.Paragraph>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Tooltip title="当报告评级达到该等级或更差时触发告警。D 表示 D/E，C 表示 C/D/E。">
                <Form.Item label="评级阈值" name="alert_grade_threshold" rules={[{ required: true }]}>
                  <Select
                    options={[
                      { value: 'C', label: 'C 及以下' },
                      { value: 'D', label: 'D 及以下' },
                      { value: 'E', label: '仅 E' },
                    ]}
                  />
                  <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                    默认 D 及以下；C 更敏感，E 更保守。
                  </Typography.Text>
                </Form.Item>
              </Tooltip>
            </Col>
            <Col xs={24} md={8}>
              <Tooltip title="可选。报告分数小于等于该值时触发告警，范围 0-100；留空表示不启用。">
                <Form.Item label="分数阈值" name="alert_score_threshold">
                  <InputNumber min={0} max={100} precision={1} style={{ width: '100%' }} placeholder="留空" />
                  <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                    留空不启用；填写后低于或等于该分数会告警。
                  </Typography.Text>
                </Form.Item>
              </Tooltip>
            </Col>
            <Col xs={24} md={8}>
              <Tooltip title="开启后，身份错配、协议异常、请求失败、Signature 互通失败等红旗标签会触发告警。">
                <Form.Item label="红旗标签告警" name="alert_red_flags_enabled" valuePropName="checked">
                  <Switch checkedChildren="启用" unCheckedChildren="关闭" />
                  <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                    覆盖身份错配、协议异常、请求失败、Signature 失败等高风险信号。
                  </Typography.Text>
                </Form.Item>
              </Tooltip>
            </Col>
            <Col xs={24} md={8}>
              <Tooltip title="同计划同渠道已有待复审告警时，静默期内不重复创建和发送告警。0 表示不静默。">
                <Form.Item label="重复告警静默（分钟）" name="quiet_minutes" rules={[{ required: true }]}>
                  <InputNumber min={0} max={10080} style={{ width: '100%' }} />
                  <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                    0 表示不静默；建议 360，避免同一问题反复刷屏。
                  </Typography.Text>
                </Form.Item>
              </Tooltip>
            </Col>
          </Row>
          <Typography.Title level={5}>失败重试</Typography.Title>
          <Typography.Paragraph type="secondary">
            只在巡检任务执行失败时重试，不会因为低分或异常标签重试。默认不重试。
          </Typography.Paragraph>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Tooltip title="巡检失败后的最大重试次数，范围 0-3。0 表示失败后不自动重试。">
                <Form.Item label="最大重试次数" name="max_retries" rules={[{ required: true }]}>
                  <InputNumber min={0} max={3} style={{ width: '100%' }} />
                  <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                    只在任务执行失败时重试；低分或异常标签不会触发重试。
                  </Typography.Text>
                </Form.Item>
              </Tooltip>
            </Col>
            <Col xs={24} md={8}>
              <Tooltip title="两次失败重试之间等待的分钟数，范围 1-60。">
                <Form.Item label="重试间隔（分钟）" name="retry_interval_minutes" rules={[{ required: true }]}>
                  <InputNumber min={1} max={60} style={{ width: '100%' }} />
                  <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                    建议 5-10 分钟，给渠道短时波动留恢复时间。
                  </Typography.Text>
                </Form.Item>
              </Tooltip>
            </Col>
          </Row>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="参数配置建议"
            description="日常巡检：1440 分钟 / 重复 1 / 并发 1-4 / D 及以下 / 静默 360 分钟 / 重试 1 次。排查期：60 分钟 / 重复 3 / 并发 1-2 / C 及以下 / 静默 60 分钟。"
          />
          <Space size="large" wrap>
            <Form.Item name="enabled" valuePropName="checked">
              <Checkbox>启用计划</Checkbox>
            </Form.Item>
            <Form.Item name="use_mock" valuePropName="checked">
              <Checkbox>使用 mock client</Checkbox>
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
