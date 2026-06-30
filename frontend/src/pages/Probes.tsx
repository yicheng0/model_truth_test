import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Col, Input, Row, Select, Space, Spin, Table, Tag, Tabs, Typography } from 'antd';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { TestCase, TestSuite } from '../types';

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

export default function Probes() {
  const cases = useQuery({ queryKey: ['cases'], queryFn: () => api.cases() });
  const suites = useQuery({ queryKey: ['suites'], queryFn: api.suites });

  const [search, setSearch] = useState('');
  const [protocolFilter, setProtocolFilter] = useState<string>('all');
  const [moduleFilter, setModuleFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [suiteFilter, setSuiteFilter] = useState<string>('all');

  const allCases: TestCase[] = cases.data ?? [];
  const allSuites: TestSuite[] = suites.data ?? [];

  const builtinSuiteIds = useMemo(() => {
    return new Set(allSuites.filter((s) => s.visibility !== 'public').map((s) => s.id));
  }, [allSuites]);

  const filteredCases = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allCases.filter((tc) => {
      if (q && !tc.id.toLowerCase().includes(q) && !tc.title.toLowerCase().includes(q) && !(tc.prompt ?? '').toLowerCase().includes(q)) return false;
      if (moduleFilter !== 'all' && tc.module !== moduleFilter) return false;
      if (typeFilter !== 'all' && probeType(tc.module) !== typeFilter) return false;
      if (suiteFilter !== 'all' && tc.suite_id !== suiteFilter) return false;
      if (protocolFilter === 'stream' && !inferProtocol(tc).includes('stream')) return false;
      if (protocolFilter === 'thinking' && !inferProtocol(tc).includes('thinking')) return false;
      if (protocolFilter === 'tools' && !inferProtocol(tc).includes('tools')) return false;
      if (protocolFilter === 'standard' && inferProtocol(tc) !== 'anthropic_messages') return false;
      return true;
    });
  }, [allCases, search, moduleFilter, typeFilter, suiteFilter, protocolFilter]);

  const builtinCount = allCases.filter((tc) => builtinSuiteIds.has(tc.suite_id)).length;
  const publicCount = allCases.filter((tc) => !builtinSuiteIds.has(tc.suite_id)).length;

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
                value={suiteFilter}
                onChange={setSuiteFilter}
                style={{ width: 220 }}
                options={[
                  { value: 'all', label: '全部套件' },
                  ...allSuites.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            </Col>
          </Row>
          <Table
            dataSource={allSuites}
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

      {/* 顶部统计 tab 栏 */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #f0f0f0', paddingBottom: 8 }}>
        {[
          { label: '探针', count: allCases.length, active: true },
          { label: '内置', count: builtinCount, active: false },
          { label: '公开', count: publicCount, active: false },
          { label: '套件', count: allSuites.length, active: false },
        ].map((item) => (
          <div
            key={item.label}
            style={{
              padding: '4px 14px',
              borderRadius: 6,
              background: item.active ? '#1677ff' : 'transparent',
              color: item.active ? '#fff' : '#595959',
              cursor: 'default',
              fontWeight: 500,
              fontSize: 13,
            }}
          >
            {item.label} {loading ? <Spin size="small" /> : <Badge count={item.count} showZero style={{ backgroundColor: item.active ? 'rgba(255,255,255,0.25)' : '#f0f0f0', color: item.active ? '#fff' : '#595959', boxShadow: 'none' }} />}
          </div>
        ))}
      </div>

      <Tabs items={tabItems} defaultActiveKey="library" />
    </div>
  );
}
