import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Col, Descriptions, Input, Modal, Row, Select, Space, Spin, Table, Tag, Tabs, Typography, message } from 'antd';
import { RefreshCw, Send } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getErrorMessage } from '../api';
import { formatChannelDisplayName } from '../channelCredentials';
import { responseSnippet } from './runDetailUtils';
import type { Channel, ModelRequestTestResult, TestCase, TestSuite } from '../types';

const { Title, Text } = Typography;

const moduleOptions = [
  { value: 'identity', label: '身份一致性' },
  { value: 'reasoning', label: '推理能力' },
  { value: 'code', label: '代码生成' },
  { value: 'knowledge', label: '知识边界' },
  { value: 'context', label: '上下文稳定' },
  { value: 'protocol', label: '协议细节' },
  { value: 'safety', label: '安全边界' },
  { value: 'format_boundary', label: '格式边界' },
  { value: 'tool', label: '工具调用' },
  { value: 'tool_use', label: '工具调用' },
  { value: 'streaming', label: '流式输出' },
  { value: 'websearch', label: 'Web 搜索' },
  { value: 'custom', label: '自定义' },
];

const moduleColor: Record<string, string> = {
  identity: 'blue',
  reasoning: 'cyan',
  code: 'geekblue',
  knowledge: 'green',
  context: 'lime',
  protocol: 'gold',
  safety: 'red',
  format_boundary: 'purple',
  tool: 'magenta',
  tool_use: 'magenta',
  streaming: 'orange',
  websearch: 'processing',
  custom: 'default',
};

// 协议 tag 映射：根据 request_params 中的 protocol 字段推断
function inferProtocol(tc: TestCase): string {
  const params = tc.request_params as Record<string, unknown> | null | undefined;
  if (!params) return 'anthropic_messages';
  if (params.stream === true || params.stream === 'true') return 'anthropic_messages (stream)';
  if (params.thinking) return 'anthropic_messages (thinking)';
  if (params.tools) return 'anthropic_messages (tools)';
  return 'anthropic_messages';
}

// 根据 module 派生 P 级别标签
function pLevel(module: string): string | null {
  const p1 = new Set(['protocol', 'tool', 'tool_use', 'format_boundary', 'identity']);
  const p2 = new Set(['reasoning', 'code', 'knowledge', 'context', 'safety', 'streaming']);
  if (p1.has(module)) return 'P1 标准';
  if (p2.has(module)) return 'P2 标准';
  return null;
}

// 根据 module 派生探针类型标签
function probeType(module: string): string {
  const behavior = new Set(['identity', 'reasoning', 'code', 'knowledge', 'safety']);
  const structural = new Set(['protocol', 'tool', 'tool_use', 'format_boundary', 'streaming']);
  if (behavior.has(module)) return '行为观测';
  if (structural.has(module)) return '协议指纹';
  return '功能验证';
}

function moduleLabel(module: string): string {
  return moduleOptions.find((o) => o.value === module)?.label ?? module;
}

// 套件分类
function suiteCategory(suite: TestSuite): string {
  if (suite.visibility === 'private') return '内置套件';
  return '普通套件';
}

function channelApiKey(channel: Channel) {
  const value = channel.auth_config?.api_key;
  return typeof value === 'string' ? value : '';
}

type SourceFilter = 'all' | 'builtin' | 'public';

export default function Probes() {
  const navigate = useNavigate();
  const cases = useQuery({ queryKey: ['cases'], queryFn: () => api.cases() });
  const suites = useQuery({ queryKey: ['suites'], queryFn: api.suites });
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });

  const [search, setSearch] = useState('');
  const [protocolFilter, setProtocolFilter] = useState<string>('all');
  const [moduleFilter, setModuleFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [librarySuiteFilter, setLibrarySuiteFilter] = useState<string>('all');
  const [suiteTabFilter, setSuiteTabFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [activeTab, setActiveTab] = useState<'library' | 'suites'>('library');

  // 发起测试 Modal 状态
  const [testProbe, setTestProbe] = useState<TestCase | null>(null);
  const [testChannelId, setTestChannelId] = useState<string | undefined>(undefined);
  const [testResult, setTestResult] = useState<ModelRequestTestResult | null>(null);

  const allCases: TestCase[] = cases.data ?? [];
  const allSuites: TestSuite[] = suites.data ?? [];

  const builtinSuiteIds = useMemo(() => {
    return new Set(allSuites.filter((s) => s.visibility !== 'public').map((s) => s.id));
  }, [allSuites]);

  const testableChannels = useMemo(
    () => (channels.data ?? []).filter((channel) => channel.enabled && channel.base_url && channelApiKey(channel)),
    [channels.data],
  );

  const filteredCases = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allCases.filter((tc) => {
      if (q && !tc.id.toLowerCase().includes(q) && !tc.title.toLowerCase().includes(q) && !(tc.prompt ?? '').toLowerCase().includes(q)) return false;
      if (moduleFilter !== 'all' && tc.module !== moduleFilter) return false;
      if (typeFilter !== 'all' && probeType(tc.module) !== typeFilter) return false;
      if (librarySuiteFilter !== 'all' && tc.suite_id !== librarySuiteFilter) return false;
      if (sourceFilter === 'builtin' && !builtinSuiteIds.has(tc.suite_id)) return false;
      if (sourceFilter === 'public' && builtinSuiteIds.has(tc.suite_id)) return false;
      if (protocolFilter === 'stream' && !inferProtocol(tc).includes('stream')) return false;
      if (protocolFilter === 'thinking' && !inferProtocol(tc).includes('thinking')) return false;
      if (protocolFilter === 'tools' && !inferProtocol(tc).includes('tools')) return false;
      if (protocolFilter === 'standard' && inferProtocol(tc) !== 'anthropic_messages') return false;
      return true;
    });
  }, [allCases, search, moduleFilter, typeFilter, librarySuiteFilter, sourceFilter, protocolFilter, builtinSuiteIds]);

  const filteredSuites = useMemo(() => {
    if (suiteTabFilter === 'all') return allSuites;
    return allSuites.filter((s) => s.id === suiteTabFilter);
  }, [allSuites, suiteTabFilter]);

  const builtinCount = allCases.filter((tc) => builtinSuiteIds.has(tc.suite_id)).length;
  const publicCount = allCases.filter((tc) => !builtinSuiteIds.has(tc.suite_id)).length;

  const runProbeTest = useMutation({
    mutationFn: ({ channelId, probe }: { channelId: string; probe: TestCase }) =>
      api.modelRequestTest(channelId, {
        prompt: probe.prompt,
        system_prompt: probe.system_prompt?.trim() || null,
        request_params: (probe.request_params as Record<string, unknown> | null) ?? { max_tokens: 256, temperature: 0 },
        run_name: `探针测试 · ${probe.title}`,
      }),
    onSuccess: (payload) => {
      setTestResult(payload);
      if (payload.result.score === 100) {
        message.success('探针测试完成');
      } else {
        message.warning('探针测试完成，结果需复核');
      }
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  function openTestModal(probe: TestCase) {
    setTestProbe(probe);
    setTestResult(null);
    setTestChannelId(testableChannels[0]?.id);
    runProbeTest.reset();
  }

  function closeTestModal() {
    setTestProbe(null);
    setTestResult(null);
    runProbeTest.reset();
  }

  function submitProbeTest() {
    if (!testProbe) return;
    if (!testChannelId) {
      message.warning('请选择请求渠道');
      return;
    }
    setTestResult(null);
    runProbeTest.mutate({ channelId: testChannelId, probe: testProbe });
  }

  function selectStat(stat: 'all' | 'builtin' | 'public' | 'suites') {
    if (stat === 'suites') {
      setActiveTab('suites');
      return;
    }
    setSourceFilter(stat);
    setActiveTab('library');
  }

  const probeColumns = [
    {
      title: '探针名称',
      key: 'title',
      render: (_: unknown, tc: TestCase) => (
        <div>
          <div style={{ fontWeight: 500, marginBottom: 2 }}>{tc.title}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {(tc.prompt ?? '').slice(0, 60)}{(tc.prompt ?? '').length > 60 ? '…' : ''}
          </Text>
        </div>
      ),
    },
    {
      title: '标签',
      key: 'tags',
      width: 280,
      render: (_: unknown, tc: TestCase) => {
        const level = pLevel(tc.module);
        return (
          <Space size={4} wrap>
            <Tag color="default" style={{ fontFamily: 'monospace', fontSize: 11 }}>
              {inferProtocol(tc).replace(' (', '\n(').split('\n')[0]}
            </Tag>
            {level && <Tag color="processing" style={{ fontSize: 11 }}>{level}</Tag>}
            <Tag color={moduleColor[tc.module] ?? 'default'} style={{ fontSize: 11 }}>
              {probeType(tc.module)}
            </Tag>
          </Space>
        );
      },
    },
    {
      title: '类型',
      key: 'module',
      width: 110,
      render: (_: unknown, tc: TestCase) => (
        <Tag color={moduleColor[tc.module] ?? 'default'}>{moduleLabel(tc.module)}</Tag>
      ),
    },
    {
      title: '来源',
      key: 'source',
      width: 70,
      render: (_: unknown, tc: TestCase) => (
        builtinSuiteIds.has(tc.suite_id)
          ? <Tag color="default">内置</Tag>
          : <Tag color="blue">公开</Tag>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 110,
      render: (_: unknown, tc: TestCase) => (
        <Button size="small" icon={<Send size={13} />} onClick={() => openTestModal(tc)}>
          发起测试
        </Button>
      ),
    },
  ];

  const suiteColumns = [
    {
      title: '套件名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, suite: TestSuite) => (
        <div>
          <div style={{ fontWeight: 500 }}>{name}</div>
          {suite.description && (
            <Text type="secondary" style={{ fontSize: 12 }}>{suite.description}</Text>
          )}
        </div>
      ),
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: 80,
      render: (v: string) => <Text type="secondary">{v ?? 'v1'}</Text>,
    },
    {
      title: '分类',
      key: 'category',
      width: 100,
      render: (_: unknown, suite: TestSuite) => (
        <Tag color={suite.visibility === 'private' ? 'default' : 'blue'}>
          {suiteCategory(suite)}
        </Tag>
      ),
    },
    {
      title: '探针数',
      key: 'count',
      width: 80,
      render: (_: unknown, suite: TestSuite) => (
        <Text>{allCases.filter((tc) => tc.suite_id === suite.id).length}</Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_: unknown, suite: TestSuite) => (
        <Button size="small" icon={<Send size={13} />} onClick={() => navigate('/new-run', { state: { suiteId: suite.id } })}>
          运行套件
        </Button>
      ),
    },
  ];

  const tabItems = [
    {
      key: 'library',
      label: '探针库',
      children: (
        <div>
          <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
            <Col flex="1">
              <Input
                placeholder="探针 ID / 用途 / 信号"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                allowClear
              />
            </Col>
            <Col>
              <Select
                value={protocolFilter}
                onChange={setProtocolFilter}
                style={{ width: 140 }}
                options={[
                  { value: 'all', label: '全部协议' },
                  { value: 'standard', label: '标准消息' },
                  { value: 'stream', label: '流式' },
                  { value: 'tools', label: '工具调用' },
                  { value: 'thinking', label: 'Thinking' },
                ]}
              />
            </Col>
            <Col>
              <Select
                value={moduleFilter}
                onChange={setModuleFilter}
                style={{ width: 140 }}
                options={[
                  { value: 'all', label: '全部模型族' },
                  ...moduleOptions,
                ]}
              />
            </Col>
            <Col>
              <Select
                value={typeFilter}
                onChange={setTypeFilter}
                style={{ width: 130 }}
                options={[
                  { value: 'all', label: '全部类型' },
                  { value: '行为观测', label: '行为观测' },
                  { value: '协议指纹', label: '协议指纹' },
                  { value: '功能验证', label: '功能验证' },
                ]}
              />
            </Col>
            <Col>
              <Select
                value={librarySuiteFilter}
                onChange={setLibrarySuiteFilter}
                style={{ width: 200 }}
                options={[
                  { value: 'all', label: '全部套件' },
                  ...allSuites.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            </Col>
          </Row>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary">
              {filteredCases.length} / {allCases.length} 根探针
            </Text>
          </div>
          <Table
            dataSource={filteredCases}
            columns={probeColumns}
            rowKey="id"
            size="small"
            loading={cases.isLoading}
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 根` }}
          />
        </div>
      ),
    },
    {
      key: 'suites',
      label: '探针套件',
      children: (
        <div>
          <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
            <Col flex="1">
              <Select
                value={suiteTabFilter}
                onChange={setSuiteTabFilter}
                style={{ width: 220 }}
                options={[
                  { value: 'all', label: '全部套件' },
                  ...allSuites.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            </Col>
          </Row>
          <Table
            dataSource={filteredSuites}
            columns={suiteColumns}
            rowKey="id"
            size="small"
            loading={suites.isLoading}
            expandable={{
              expandedRowRender: (suite) => {
                const suiteCases = allCases.filter((tc) => tc.suite_id === suite.id);
                return (
                  <Table
                    dataSource={suiteCases}
                    columns={[
                      { title: '探针名称', dataIndex: 'title', key: 'title' },
                      {
                        title: '类型',
                        key: 'module',
                        width: 110,
                        render: (_: unknown, tc: TestCase) => (
                          <Tag color={moduleColor[tc.module] ?? 'default'}>{moduleLabel(tc.module)}</Tag>
                        ),
                      },
                      {
                        title: '操作',
                        key: 'actions',
                        width: 110,
                        render: (_: unknown, tc: TestCase) => (
                          <Button size="small" icon={<Send size={13} />} onClick={() => openTestModal(tc)}>
                            发起测试
                          </Button>
                        ),
                      },
                    ]}
                    rowKey="id"
                    size="small"
                    pagination={false}
                  />
                );
              },
            }}
            pagination={false}
          />
        </div>
      ),
    },
  ];

  const loading = cases.isLoading || suites.isLoading;

  const stats: Array<{ key: 'all' | 'builtin' | 'public' | 'suites'; label: string; count: number; active: boolean }> = [
    { key: 'all', label: '探针', count: allCases.length, active: activeTab === 'library' && sourceFilter === 'all' },
    { key: 'builtin', label: '内置', count: builtinCount, active: activeTab === 'library' && sourceFilter === 'builtin' },
    { key: 'public', label: '公开', count: publicCount, active: activeTab === 'library' && sourceFilter === 'public' },
    { key: 'suites', label: '套件', count: allSuites.length, active: activeTab === 'suites' },
  ];

  return (
    <div style={{ padding: '24px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Title level={2} style={{ margin: 0 }}>探针管理</Title>
        <Space>
          <Button
            icon={<RefreshCw size={14} />}
            onClick={() => {
              void cases.refetch();
              void suites.refetch();
              void channels.refetch();
            }}
            loading={loading}
          >
            刷新探针
          </Button>
        </Space>
      </div>
      <Text type="secondary" style={{ display: 'block', marginBottom: 20 }}>
        按探针用途、适用模型族和区分点管理探针，把常用组合保存成套件。
      </Text>

      {/* 顶部统计 tab 栏（可点击筛选） */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #f0f0f0', paddingBottom: 8 }}>
        {stats.map((item) => (
          <div
            key={item.key}
            role="button"
            tabIndex={0}
            onClick={() => selectStat(item.key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectStat(item.key);
              }
            }}
            style={{
              padding: '4px 14px',
              borderRadius: 6,
              background: item.active ? '#1677ff' : 'transparent',
              color: item.active ? '#fff' : '#595959',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: 13,
            }}
          >
            {item.label} {loading ? <Spin size="small" /> : <Badge count={item.count} showZero style={{ backgroundColor: item.active ? 'rgba(255,255,255,0.25)' : '#f0f0f0', color: item.active ? '#fff' : '#595959', boxShadow: 'none' }} />}
          </div>
        ))}
      </div>

      <Tabs items={tabItems} activeKey={activeTab} onChange={(key) => setActiveTab(key as 'library' | 'suites')} />

      <Modal
        open={Boolean(testProbe)}
        title={testProbe ? `发起测试 · ${testProbe.title}` : '发起测试'}
        onCancel={closeTestModal}
        onOk={submitProbeTest}
        okText="发送真实请求"
        confirmLoading={runProbeTest.isPending}
        okButtonProps={{ disabled: !testableChannels.length }}
        width={640}
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {!testableChannels.length ? (
            <Alert type="warning" showIcon message="没有可请求渠道" description="请先到渠道管理页为启用渠道配置 Base URL 和 API Key。" />
          ) : (
            <Alert type="info" showIcon message="会向所选渠道发起真实请求" description="请求和响应会保存为一条手动模型请求任务，API Key 只读取渠道配置。" />
          )}
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>请求渠道</Text>
            <Select
              value={testChannelId}
              onChange={setTestChannelId}
              style={{ width: '100%' }}
              loading={channels.isLoading}
              placeholder="选择已配置密钥的渠道"
              options={testableChannels.map((channel) => ({
                value: channel.id,
                label: `${formatChannelDisplayName(channel)} · ${channel.model_name || '未配置模型'}`,
              }))}
            />
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>探针 Prompt</Text>
            <Input.TextArea value={testProbe?.prompt ?? ''} rows={3} readOnly />
          </div>
          {testResult && (
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="任务">
                <Link to={`/runs/${testResult.run.id}`}>{testResult.run.id}</Link>
              </Descriptions.Item>
              <Descriptions.Item label="评分">{testResult.result.score}</Descriptions.Item>
              <Descriptions.Item label="标签">{(testResult.result.labels ?? []).join(', ') || '-'}</Descriptions.Item>
              <Descriptions.Item label="Message ID">{testResult.message_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="渠道特征">{testResult.message_channel_type}</Descriptions.Item>
              <Descriptions.Item label="输出摘要">{responseSnippet(testResult.result)}</Descriptions.Item>
            </Descriptions>
          )}
        </Space>
      </Modal>
    </div>
  );
}
