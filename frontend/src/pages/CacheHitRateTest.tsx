import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Form, Popconfirm, Progress, Select, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link } from 'react-router-dom';
import { DatabaseZap, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { formatChannelDisplayName } from '../channelCredentials';
import type { CacheHitRateAttempt, CacheHitRateJobStatus, CacheHitRateTestResult, Channel } from '../types';

type CacheTtlOption = '5m' | '1h';

function channelApiKey(channel: Channel) {
  const value = channel.auth_config?.api_key;
  return typeof value === 'string' ? value : '';
}

function formatPercent(value: number) {
  return `${Number.isFinite(value) ? value.toFixed(2) : '0.00'}%`;
}

const cacheAttemptColumns: ColumnsType<CacheHitRateAttempt> = [
  {
    title: '请求',
    dataIndex: 'attempt_index',
    key: 'attempt_index',
    render: (value: number) => `#${value - 1}`,
  },
  {
    title: '命中',
    dataIndex: 'cache_hit',
    key: 'cache_hit',
    render: (value: boolean) => <Tag color={value ? 'green' : 'red'}>{value ? '命中' : '未命中'}</Tag>,
  },
  { title: '缓存 tokens', dataIndex: 'cache_read_input_tokens', key: 'cache_read_input_tokens' },
  { title: '写入 tokens', dataIndex: 'cache_creation_input_tokens', key: 'cache_creation_input_tokens' },
  { title: '输入 tokens', dataIndex: 'input_tokens', key: 'input_tokens' },
  { title: 'Prompt tokens', dataIndex: 'prompt_tokens', key: 'prompt_tokens' },
  {
    title: '延迟',
    dataIndex: 'latency_ms',
    key: 'latency_ms',
    render: (value: number | null) => (value == null ? '-' : `${value} ms`),
  },
  {
    title: 'Message ID',
    dataIndex: 'message_id',
    key: 'message_id',
    render: (value: string | null) => value || '-',
  },
  {
    title: 'Request ID',
    dataIndex: 'request_id',
    key: 'request_id',
    render: (value: string | null) => value || '-',
  },
];

export default function CacheHitRateTest() {
  const queryClient = useQueryClient();
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const [channelId, setChannelId] = useState<string | null>(null);
  const [cacheTtl, setCacheTtl] = useState<CacheTtlOption>('5m');
  const [cacheResult, setCacheResult] = useState<CacheHitRateTestResult | null>(null);
  const [cacheJobId, setCacheJobId] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const availableChannels = useMemo(
    () => (channels.data ?? []).filter((channel) => channel.enabled && channel.base_url && channelApiKey(channel)),
    [channels.data],
  );

  const channelOptions = availableChannels.map((channel) => ({
    value: channel.id,
    label: `${formatChannelDisplayName(channel)} · ${channel.model_name || '未配置模型'}`,
  }));

  useEffect(() => {
    if (channelId || !availableChannels.length) return;
    setChannelId(availableChannels[0].id);
  }, [availableChannels, channelId]);

  const cacheJob = useQuery<CacheHitRateJobStatus>({
    queryKey: ['cacheHitRateJob', cacheJobId],
    queryFn: () => api.cacheHitRateJob(cacheJobId!),
    enabled: Boolean(cacheJobId),
    refetchInterval: (query) => {
      const payload = query.state.data;
      return payload && (payload.status === 'completed' || payload.status === 'failed') ? false : 1000;
    },
  });

  useEffect(() => {
    const payload = cacheJob.data;
    if (!payload) return;
    if (payload.status === 'completed' && payload.result) {
      setCacheResult(payload.result);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      message.success(`缓存测试完成：命中率 ${formatPercent(payload.request_hit_rate)}`);
    } else if (payload.status === 'failed' && payload.error) {
      message.error(payload.error);
    }
  }, [cacheJob.data, queryClient]);

  const runCacheProbe = useMutation({
    mutationFn: (selectedChannelId: string) =>
      api.startCacheHitRateTestJob(selectedChannelId, {
        test_count: 10,
        interval_seconds: 3,
        warmup_wait_seconds: 5,
        cache_ttl: cacheTtl,
        run_name: '缓存命中率测试',
      }),
    onSuccess: (payload) => {
      setRequestError(null);
      setCacheResult(null);
      setCacheJobId(payload.job_id);
      message.info('缓存命中率测试已开始');
    },
    onError: (error) => {
      const detail = error instanceof Error ? error.message : '缓存命中率测试失败';
      setRequestError(detail);
      message.error(detail);
    },
  });

  const deleteProbeRun = useMutation({
    mutationFn: api.deleteRun,
    onSuccess: async (_, runId) => {
      message.success('缓存测试日志已删除');
      setCacheResult((current) => (current?.run.id === runId ? null : current));
      setCacheJobId((current) => (cacheResult?.run.id === runId ? null : current));
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  function submitCacheProbe() {
    if (!channelId) {
      message.warning('请选择请求渠道');
      return;
    }
    setCacheResult(null);
    setCacheJobId(null);
    setRequestError(null);
    runCacheProbe.mutate(channelId);
  }

  const cacheJobPayload = cacheJob.data;
  const cacheRunning = runCacheProbe.isPending || cacheJobPayload?.status === 'queued' || cacheJobPayload?.status === 'running';
  const cachePanel = cacheJobPayload ?? cacheResult;
  const cacheRun = cacheResult?.run ?? cacheJobPayload?.result?.run ?? null;
  const cacheWarmup = cachePanel?.warmup ?? null;
  const cacheAttempts = cachePanel?.attempts ?? [];

  return (
    <Space direction="vertical" size={24} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">PROMPT CACHE</Typography.Text>
          <Typography.Title level={2}>缓存命中率</Typography.Title>
          <Typography.Paragraph>
            使用 5K 级长文本和 Anthropic Messages cache_control 发起预热与重复请求，支持 5m / 1h TTL，实时观察渠道缓存命中率。
          </Typography.Paragraph>
        </div>
        <Tag color="blue">可请求渠道 {availableChannels.length}</Tag>
      </div>

      <Card title={<span className="card-title-with-icon"><DatabaseZap size={18} />缓存测试配置</span>} bordered={false}>
        <Space direction="vertical" size={16} className="full-width">
          {!availableChannels.length ? (
            <Alert type="warning" showIcon message="没有可请求渠道" description="请先到渠道管理页为启用渠道配置 Base URL 和 API Key。" />
          ) : null}
          <Alert
            type="info"
            showIcon
            message="会发起真实缓存测试请求"
            description="默认预热 1 次，等待 5 秒后测量 10 次，每次间隔 3 秒。每轮测试会使用独立缓存标记，避免连续测试互相污染。可选 5m / 1h TTL；1h 更适合识别渠道是否真的透传长 TTL。API Key 只读取渠道配置，不写入原始请求。"
          />
          <div className="signature-config-grid">
            <Form.Item label="请求渠道" style={{ marginBottom: 0 }}>
              <Select
                className="full-width"
                value={channelId ?? undefined}
                options={channelOptions}
                loading={channels.isLoading}
                placeholder="选择已配置密钥的渠道"
                onChange={(value) => {
                  setChannelId(value);
                  setCacheResult(null);
                  setCacheJobId(null);
                  setRequestError(null);
                }}
              />
            </Form.Item>
            <Form.Item label="缓存 TTL" style={{ marginBottom: 0 }}>
              <Select
                className="full-width"
                value={cacheTtl}
                options={[
                  { value: '5m', label: '5m' },
                  { value: '1h', label: '1h' },
                ]}
                onChange={(value: CacheTtlOption) => {
                  setCacheTtl(value);
                  setCacheResult(null);
                  setCacheJobId(null);
                  setRequestError(null);
                }}
              />
            </Form.Item>
          </div>
          <Space wrap>
            <Button type="primary" onClick={submitCacheProbe} loading={cacheRunning} disabled={channels.isLoading || !availableChannels.length} icon={<DatabaseZap size={16} />}>
              {cacheRunning ? '测试中' : '开始缓存命中率测试'}
            </Button>
          </Space>
          {requestError ? <Alert type="error" showIcon message="缓存测试没有发出或接口返回失败" description={requestError} /> : null}
        </Space>
      </Card>

      {cachePanel ? (
        <Space direction="vertical" size={16} className="full-width">
          <Alert
            type={cacheRunning ? 'info' : cachePanel.hits > 0 ? 'success' : 'warning'}
            showIcon
            message={cacheRunning ? '缓存命中率测试运行中' : cachePanel.hits > 0 ? '缓存命中率测试完成' : '未观察到缓存命中'}
            description={`请求命中率 ${formatPercent(cachePanel.request_hit_rate)}，Token 命中率 ${formatPercent(cachePanel.token_hit_rate)}。`}
          />
          {cacheJobPayload ? (
            <Card title="缓存命中率实时监控" bordered={false}>
              <Space direction="vertical" size={12} className="full-width">
                <Progress percent={cacheJobPayload.percent} status={cacheRunning ? 'active' : cacheJobPayload.status === 'failed' ? 'exception' : 'normal'} />
                <Typography.Text type="secondary">
                  当前阶段：{cacheJobPayload.current_title || '-'}，已完成 {cacheJobPayload.completed_count} / {cacheJobPayload.total_count}
                </Typography.Text>
                {cacheJobPayload.error ? <Alert type="error" showIcon message="缓存测试失败" description={cacheJobPayload.error} /> : null}
              </Space>
            </Card>
          ) : null}
          <Card title="缓存命中率结果" bordered={false}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="任务">
                {cacheRun ? <Link to={`/runs/${cacheRun.id}`}>{cacheRun.id}</Link> : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="状态">{cacheRun?.status || cacheJobPayload?.status || '-'}</Descriptions.Item>
              <Descriptions.Item label="请求 TTL">{cachePanel.requested_cache_ttl}</Descriptions.Item>
              <Descriptions.Item label="缓存标记">{cachePanel.cache_probe_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="请求命中">{cachePanel.hits}/{cachePanel.total}</Descriptions.Item>
              <Descriptions.Item label="请求命中率">{formatPercent(cachePanel.request_hit_rate)}</Descriptions.Item>
              <Descriptions.Item label="Token 命中率">{formatPercent(cachePanel.token_hit_rate)}</Descriptions.Item>
              <Descriptions.Item label="总缓存 tokens">{cachePanel.total_cached_tokens}</Descriptions.Item>
              <Descriptions.Item label="总 prompt tokens">{cachePanel.total_prompt_tokens}</Descriptions.Item>
              <Descriptions.Item label="平均缓存 tokens">{cachePanel.avg_cached_tokens}</Descriptions.Item>
              <Descriptions.Item label="预热写入 tokens">{cachePanel.warmup_cache_creation_input_tokens}</Descriptions.Item>
              <Descriptions.Item label="预热 5m 写入">{cachePanel.warmup_cache_creation_ephemeral_5m_input_tokens}</Descriptions.Item>
              <Descriptions.Item label="预热 1h 写入">{cachePanel.warmup_cache_creation_ephemeral_1h_input_tokens}</Descriptions.Item>
              <Descriptions.Item label="渠道特征">{cachePanel.message_channel_type}</Descriptions.Item>
              <Descriptions.Item label="协议">{cachePanel.request_protocol || '-'}</Descriptions.Item>
              <Descriptions.Item label="Endpoint">{cachePanel.provider_endpoint || '-'}</Descriptions.Item>
            </Descriptions>
            {cacheRun ? (
              <Popconfirm
                title="删除本次缓存测试日志"
                description="会删除本次缓存测试生成的任务和所有请求结果。确定删除吗？"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => deleteProbeRun.mutate(cacheRun.id)}
              >
                <Button danger icon={<Trash2 size={15} />} loading={deleteProbeRun.isPending && deleteProbeRun.variables === cacheRun.id} style={{ marginTop: 16 }}>
                  删除本次缓存测试日志
                </Button>
              </Popconfirm>
            ) : null}
          </Card>
          {cacheWarmup ? (
            <Card title="预热请求" bordered={false}>
              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label="Message ID">{cacheWarmup.message_id || '-'}</Descriptions.Item>
                <Descriptions.Item label="Request ID">{cacheWarmup.request_id || '-'}</Descriptions.Item>
                <Descriptions.Item label="写入 tokens">{cacheWarmup.cache_creation_input_tokens}</Descriptions.Item>
                <Descriptions.Item label="5m 写入">{cacheWarmup.cache_creation_ephemeral_5m_input_tokens}</Descriptions.Item>
                <Descriptions.Item label="1h 写入">{cacheWarmup.cache_creation_ephemeral_1h_input_tokens}</Descriptions.Item>
                <Descriptions.Item label="输入 tokens">{cacheWarmup.input_tokens}</Descriptions.Item>
              </Descriptions>
            </Card>
          ) : null}
          <Card title="测量请求明细" bordered={false}>
            <Table<CacheHitRateAttempt>
              rowKey={(row) => row.result.id}
              dataSource={cacheAttempts}
              columns={cacheAttemptColumns}
              pagination={false}
              size="small"
              scroll={{ x: 1100 }}
            />
          </Card>
        </Space>
      ) : null}
    </Space>
  );
}
