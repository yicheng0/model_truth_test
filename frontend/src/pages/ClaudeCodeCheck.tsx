import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Descriptions, Form, Input, InputNumber, Progress, Select, Space, Statistic, Table, Tabs, Tag, Typography, message } from 'antd';
import { Link } from 'react-router-dom';
import { Play, RefreshCw, ShieldCheck, TerminalSquare } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { formatChannelDisplayName } from '../channelCredentials';
import { formatDateTime } from '../time';
import type { ClaudeCodeCheckResult, ClaudeCodeJobProbe, ClaudeCodeJobStatus, ClaudeCodeProbeResult, ClaudeCodeRelayTestCreate, ClaudeCodeSection, ClaudeCodeSourceChannel, ClaudeCodeTestResult } from '../types';

type RelayFormValues = {
  base_url: string;
  api_key: string;
  model_name: string;
  provider_type: string;
  request_protocol: string;
  source_channel_id?: string;
  image_url?: string;
  include_expensive_context?: boolean;
};

type CliFormValues = {
  model?: string;
  timeout_seconds: number;
  max_budget_usd: number;
};

const SECTION_DESCRIPTIONS: Record<string, string> = {
  fingerprint: '中转扩展字段、拒绝形态和非原生兼容行为，用于识别链路指纹。',
  structure: '响应结构、message 形态、usage、截断和基础协议行为。',
  behavior: '上下文、提示词防泄露以及运行时行为稳定性。',
  signature: 'Thinking signature 以及跨渠道 signature 互通。',
  multimodal: '图片 base64、图片 URL 和文档输入能力。',
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

function resultAlertType(result: ClaudeCodeCheckResult): 'success' | 'warning' | 'error' {
  if (result.ok) return 'success';
  if (result.score >= 65) return 'warning';
  return 'error';
}

function relayAlertType(result: ClaudeCodeTestResult): 'success' | 'warning' | 'error' {
  if (result.risk_level === 'low' || result.risk_level === 'medium') return 'success';
  if (result.risk_level === 'high') return 'warning';
  return 'error';
}

function excerptBlock(value?: string | null) {
  if (!value?.trim()) return null;
  return <pre className="json-block">{value}</pre>;
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

function ProbeTable({ probes }: { probes: ClaudeCodeProbeResult[] }) {
  return (
    <Table<ClaudeCodeProbeResult>
      rowKey="key"
      dataSource={probes}
      pagination={false}
      size="small"
      scroll={{ x: 1180 }}
      columns={[
        {
          title: '测试项',
          width: 220,
          render: (_, item) => (
            <Space direction="vertical" size={2}>
              <Typography.Text strong>{item.title}</Typography.Text>
              <Typography.Text type="secondary">{item.key}</Typography.Text>
            </Space>
          ),
        },
        { title: '结果', dataIndex: 'status', width: 100, render: (value: string) => <Tag color={statusColor(value)}>{statusLabel(value)}</Tag> },
        { title: '权重', dataIndex: 'severity', width: 110, render: (value: string) => <Tag>{value}</Tag> },
        { title: '分数', dataIndex: 'score', width: 90 },
        {
          title: 'Message / Request',
          width: 260,
          render: (_, item) => (
            <Space direction="vertical" size={2}>
              <Typography.Text copyable={item.message_id ? { text: item.message_id } : false}>{item.message_id || '-'}</Typography.Text>
              <Typography.Text type="secondary" copyable={item.request_id ? { text: item.request_id } : false}>{item.request_id || '-'}</Typography.Text>
            </Space>
          ),
        },
        {
          title: '标签',
          width: 240,
          render: (_, item) => item.labels.length ? item.labels.map((label) => <Tag key={label} color="orange">{label}</Tag>) : '-',
        },
        {
          title: '证据摘要',
          dataIndex: 'evidence_excerpt',
          width: 360,
          render: (value: string | null | undefined) => <Typography.Text ellipsis={{ tooltip: value || undefined }}>{value || '-'}</Typography.Text>,
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
          width: 220,
          render: (_, item) => (
            <Space direction="vertical" size={2}>
              <Typography.Text strong>{item.title}</Typography.Text>
              <Typography.Text type="secondary">{item.key}</Typography.Text>
            </Space>
          ),
        },
        { title: '状态', dataIndex: 'status', width: 110, render: (value: string) => <Tag color={statusColor(value)}>{statusLabel(value)}</Tag> },
        { title: '分数', dataIndex: 'score', width: 90 },
        {
          title: '摘要',
          width: 420,
          render: (_, item) => <Typography.Text ellipsis={{ tooltip: item.evidence_excerpt || item.detail || undefined }}>{item.evidence_excerpt || item.detail || '-'}</Typography.Text>,
        },
      ]}
    />
  );
}

export default function ClaudeCodeCheck() {
  const [relayForm] = Form.useForm<RelayFormValues>();
  const [cliForm] = Form.useForm<CliFormValues>();
  const [relayResult, setRelayResult] = useState<ClaudeCodeTestResult | null>(null);
  const [cliResult, setCliResult] = useState<ClaudeCodeCheckResult | null>(null);
  const [relayJobId, setRelayJobId] = useState<string | null>(null);
  const [cliJobId, setCliJobId] = useState<string | null>(null);

  const sources = useQuery<ClaudeCodeSourceChannel[]>({ queryKey: ['claudeCodeSourceChannels'], queryFn: api.claudeCodeSourceChannels });
  const status = useQuery({ queryKey: ['claudeCodeCheckStatus'], queryFn: api.claudeCodeCheckStatus });
  const relayJob = useQuery<ClaudeCodeJobStatus>({
    queryKey: ['claudeCodeRelayJob', relayJobId],
    queryFn: () => api.claudeCodeRelayTestJob(relayJobId!),
    enabled: Boolean(relayJobId),
    refetchInterval: (query) => {
      const payload = query.state.data;
      return payload && (payload.status === 'completed' || payload.status === 'failed') ? false : 1000;
    },
  });
  const cliJob = useQuery<ClaudeCodeJobStatus>({
    queryKey: ['claudeCodeCliJob', cliJobId],
    queryFn: () => api.claudeCodeCheckJob(cliJobId!),
    enabled: Boolean(cliJobId),
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

  useEffect(() => {
    const payload = relayJob.data;
    if (!payload) return;
    if (payload.status === 'completed' && payload.result) {
      setRelayResult(payload.result as ClaudeCodeTestResult);
      message.success('ClaudeCode 中转检测完成');
    } else if (payload.status === 'failed' && payload.error) {
      message.error(payload.error);
    }
  }, [relayJob.data]);

  useEffect(() => {
    const payload = cliJob.data;
    if (!payload) return;
    if (payload.status === 'completed' && payload.result) {
      setCliResult(payload.result as ClaudeCodeCheckResult);
      void status.refetch();
      const result = payload.result as ClaudeCodeCheckResult;
      if (result.ok) message.success('Claude Code CLI 自检通过');
      else message.warning('Claude Code CLI 自检未通过');
    } else if (payload.status === 'failed' && payload.error) {
      message.error(payload.error);
    }
  }, [cliJob.data, status]);

  const runRelayTest = useMutation({
    mutationFn: (values: RelayFormValues) => {
      const payload: ClaudeCodeRelayTestCreate = {
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
    onSuccess: (payload) => {
      setRelayJobId(payload.job_id);
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const runCliCheck = useMutation({
    mutationFn: api.startClaudeCodeCheckJob,
    onSuccess: (payload) => {
      setCliJobId(payload.job_id);
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  function submitRelay(values: RelayFormValues) {
    setRelayResult(null);
    setRelayJobId(null);
    runRelayTest.mutate(values);
  }

  function submitCli(values: CliFormValues) {
    setCliResult(null);
    setCliJobId(null);
    runCliCheck.mutate({
      model: values.model?.trim() || null,
      timeout_seconds: values.timeout_seconds,
      max_budget_usd: values.max_budget_usd,
    });
  }

  const statusData = status.data;
  const canRunCli = Boolean(statusData?.available) && !runCliCheck.isPending && cliJob.data?.status !== 'running';
  const allCounts = probeCounts(relayResult?.probes ?? []);
  const relayRunning = runRelayTest.isPending || relayJob.data?.status === 'queued' || relayJob.data?.status === 'running';
  const cliRunning = runCliCheck.isPending || cliJob.data?.status === 'queued' || cliJob.data?.status === 'running';

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

      <Tabs
        defaultActiveKey="relay"
        items={[
          {
            key: 'relay',
            label: '中转接口检测',
            children: (
              <Space direction="vertical" size={18} className="full-width">
                <Card title={<span className="card-title-with-icon"><ShieldCheck size={18} />接口配置</span>} bordered={false}>
                  <Form
                    form={relayForm}
                    layout="vertical"
                    initialValues={{ provider_type: 'third_party_anthropic', request_protocol: 'auto', include_expensive_context: false }}
                    onFinish={submitRelay}
                  >
                    <div className="signature-config-grid">
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
                      <Typography.Text type="secondary">Source 渠道只用于 signature interop，不会覆盖待测 URL/Key。</Typography.Text>
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
                        <JobProbeTable probes={section.probes} currentKey={relayJob.data?.current_key} />
                      </Card>
                    ))}
                  </Space>
                ) : null}

                {relayResult ? (
                  <Space direction="vertical" size={18} className="full-width">
                    <Alert
                      type={relayAlertType(relayResult)}
                      showIcon
                      message={(
                        <Space wrap>
                          <span>检测完成</span>
                          <Tag color={riskColor(relayResult.risk_level)}>风险 {relayResult.risk_level}</Tag>
                          <Tag color={relayResult.ok ? 'green' : 'red'}>得分 {relayResult.score}</Tag>
                        </Space>
                      )}
                      description={relayResult.summary}
                    />
                    <div className="signature-sim-grid">
                      <Card bordered={false}><Statistic title="通过" value={allCounts.pass} valueStyle={{ color: '#15803d' }} /></Card>
                      <Card bordered={false}><Statistic title="失败" value={allCounts.fail} valueStyle={{ color: '#b91c1c' }} /></Card>
                      <Card bordered={false}><Statistic title="警告" value={allCounts.warning} valueStyle={{ color: '#c2410c' }} /></Card>
                      <Card bordered={false}><Statistic title="跳过" value={allCounts.skipped} /></Card>
                    </div>
                    <div className="claude-section-grid">
                      {(relayResult.sections ?? []).map((section: ClaudeCodeSection) => (
                        <Card key={section.key} bordered={false} className="claude-section-card">
                          <Space direction="vertical" size={10} className="full-width">
                            <Space wrap className="claude-section-card-head">
                              <Typography.Text strong>{section.title}</Typography.Text>
                              <Tag color={statusColor(section.status)}>{statusLabel(section.status)}</Tag>
                              <Tag>得分 {section.score}</Tag>
                            </Space>
                            <Typography.Text type="secondary">{SECTION_DESCRIPTIONS[section.key] ?? '检测板块'}</Typography.Text>
                            <Progress
                              percent={sectionPercent(section)}
                              size="small"
                              showInfo={false}
                              status={section.status === 'fail' ? 'exception' : 'normal'}
                            />
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
                    {(relayResult.sections ?? []).map((section: ClaudeCodeSection) => {
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
                          <ProbeTable probes={probes} />
                        </Card>
                      );
                    })}
                  </Space>
                ) : null}
              </Space>
            ),
          },
          {
            key: 'cli',
            label: '本机 CLI 自检',
            children: (
              <Space direction="vertical" size={18} className="full-width">
                <Card title={<span className="card-title-with-icon"><TerminalSquare size={18} />CLI 状态</span>} bordered={false}>
                  <Space direction="vertical" size={16} className="full-width">
                    {status.isError ? <Alert type="error" showIcon message="无法读取 Claude Code 状态" description={getErrorMessage(status.error)} /> : null}
                    {statusData && !statusData.available ? (
                      <Alert type="warning" showIcon message="Claude Code CLI 不可用" description={statusData.error || '请确认后端运行环境可以执行 claude --version。'} />
                    ) : null}
                    <Descriptions bordered size="small" column={2}>
                      <Descriptions.Item label="命令">{statusData?.command ?? 'claude'}</Descriptions.Item>
                      <Descriptions.Item label="版本">{statusData?.version ?? '-'}</Descriptions.Item>
                      <Descriptions.Item label="路径" span={2}>{statusData?.command_path ?? '-'}</Descriptions.Item>
                    </Descriptions>
                    <Button icon={<RefreshCw size={16} />} onClick={() => status.refetch()} loading={status.isFetching}>
                      刷新状态
                    </Button>
                    <Typography.Text type="secondary">
                      这是本机 Claude Code CLI 自检，不需要 Base URL / API Key。远程中转请使用上方“中转接口检测”。
                    </Typography.Text>
                  </Space>
                </Card>

                <Card title="检测配置" bordered={false}>
                  <Form form={cliForm} layout="vertical" initialValues={{ timeout_seconds: 180, max_budget_usd: 0.25 }} onFinish={submitCli}>
                    <div className="signature-config-grid">
                      <Form.Item name="model" label="模型别名或模型名">
                        <Input placeholder="留空使用 Claude Code 默认模型，例如 sonnet" allowClear />
                      </Form.Item>
                      <Form.Item name="timeout_seconds" label="超时秒数" rules={[{ required: true, message: '请输入超时秒数' }]}>
                        <InputNumber min={30} max={300} step={30} className="full-width" />
                      </Form.Item>
                      <Form.Item name="max_budget_usd" label="最大预算 USD" rules={[{ required: true, message: '请输入最大预算' }]}>
                        <InputNumber min={0.01} max={1} step={0.01} precision={2} className="full-width" />
                      </Form.Item>
                    </div>
                    <Space wrap>
                      <Button type="primary" htmlType="submit" icon={<Play size={16} />} loading={runCliCheck.isPending} disabled={!canRunCli}>
                        开始 CLI 自检
                      </Button>
                      <Typography.Text type="secondary">检测只会操作后端创建的临时目录，不会让 Claude Code 修改当前仓库。</Typography.Text>
                    </Space>
                  </Form>
                </Card>

                {cliRunning && cliJob.data ? (
                  <Card bordered={false}>
                    <Space direction="vertical" size={12} className="full-width">
                      <Typography.Text strong>正在运行 Claude Code 沙箱检测</Typography.Text>
                      <Progress percent={cliJob.data.percent} status="active" />
                      <Typography.Text type="secondary">
                        当前步骤：{cliJob.data.current_title || '准备中'}，已完成 {cliJob.data.completed_count} / {cliJob.data.total_count}
                      </Typography.Text>
                    </Space>
                  </Card>
                ) : null}

                {cliJob.data ? (
                  <Card title="实时步骤" bordered={false}>
                    <JobProbeTable probes={cliJob.data.checks} currentKey={cliJob.data.current_key} />
                  </Card>
                ) : null}

                {cliResult ? (
                  <Space direction="vertical" size={18} className="full-width">
                    <Alert
                      type={resultAlertType(cliResult)}
                      showIcon
                      message={`检测${cliResult.ok ? '通过' : '未通过'}：${cliResult.score} / 100 · Grade ${cliResult.grade}`}
                      description={`耗时 ${cliResult.duration_ms} ms，版本 ${cliResult.version ?? '-'}。最终判定以沙箱文件变更和后端复跑测试为准。`}
                    />
                    <Card title="检测项" bordered={false}>
                      <Table
                        rowKey="key"
                        dataSource={cliResult.checks}
                        pagination={false}
                        size="small"
                        columns={[
                          { title: '项目', dataIndex: 'title', width: 220 },
                          { title: '状态', dataIndex: 'status', width: 100, render: (value: string) => <Tag color={statusColor(value)}>{statusLabel(value)}</Tag> },
                          { title: '分数', dataIndex: 'score', width: 90 },
                          { title: '详情', dataIndex: 'detail' },
                        ]}
                      />
                    </Card>
                    <Card title="运行信息" bordered={false}>
                      <Descriptions bordered size="small" column={2}>
                        <Descriptions.Item label="命令">{cliResult.command}</Descriptions.Item>
                        <Descriptions.Item label="版本">{cliResult.version ?? '-'}</Descriptions.Item>
                        <Descriptions.Item label="开始">{formatDateTime(cliResult.started_at)}</Descriptions.Item>
                        <Descriptions.Item label="结束">{formatDateTime(cliResult.finished_at)}</Descriptions.Item>
                        <Descriptions.Item label="路径" span={2}>{cliResult.command_path ?? '-'}</Descriptions.Item>
                      </Descriptions>
                    </Card>
                    {cliResult.stdout_excerpt || cliResult.stderr_excerpt ? (
                      <Card title="CLI 输出摘要" bordered={false}>
                        <Space direction="vertical" size={16} className="full-width">
                          {cliResult.stdout_excerpt ? <div><Typography.Text strong>stdout</Typography.Text>{excerptBlock(cliResult.stdout_excerpt)}</div> : null}
                          {cliResult.stderr_excerpt ? <div><Typography.Text strong>stderr</Typography.Text>{excerptBlock(cliResult.stderr_excerpt)}</div> : null}
                        </Space>
                      </Card>
                    ) : null}
                  </Space>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}
