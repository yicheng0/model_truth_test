import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Collapse, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from 'antd';
import { Download, Edit3, Plus, Shuffle, Trash2, Upload } from 'lucide-react';
import { api } from '../api';
import type { SamplePlanCreate, TestCase, TestCaseCreate, TestSuite } from '../types';

type CaseFormValues = {
  suite_id: string;
  module: string;
  sort_order: number;
  title: string;
  prompt: string;
  system_prompt?: string;
  request_params?: string;
  scoring_rules?: string;
  is_hidden?: boolean;
  enabled?: boolean;
};

const moduleOptions = [
  { value: 'identity', label: '身份一致性' },
  { value: 'reasoning', label: '推理能力' },
  { value: 'code', label: '代码生成' },
  { value: 'knowledge', label: '知识边界' },
  { value: 'context', label: '上下文' },
  { value: 'protocol', label: '协议细节' },
  { value: 'safety', label: '安全边界' },
  { value: 'format_boundary', label: '格式边界' },
  { value: 'tool', label: '工具调用' },
  { value: 'tool_use', label: '工具调用' },
  { value: 'streaming', label: '流式输出' },
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
  custom: 'default',
};

function toJsonText(value: Record<string, unknown> | null | undefined) {
  return value ? JSON.stringify(value, null, 2) : '';
}

function parseJsonField(value: string | undefined, fieldName: string) {
  if (!value?.trim()) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error(`${fieldName} 必须是合法 JSON`);
  }
}

function suiteName(suites: TestSuite[] | undefined, id: string) {
  return suites?.find((suite) => suite.id === id)?.name ?? id;
}

export default function TestCases() {
  const queryClient = useQueryClient();
  const suites = useQuery({ queryKey: ['suites'], queryFn: api.suites });
  const cases = useQuery({ queryKey: ['cases'], queryFn: () => api.cases() });
  const [form] = Form.useForm<CaseFormValues>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TestCase | null>(null);
  const [suiteFilter, setSuiteFilter] = useState<string>('all');
  const [moduleFilter, setModuleFilter] = useState<string>('all');
  const [enabledFilter, setEnabledFilter] = useState<string>('all');
  const [bundleText, setBundleText] = useState('');
  const [evalScopeJsonl, setEvalScopeJsonl] = useState('');
  const [diffAgainst, setDiffAgainst] = useState('');

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['cases'] });
    await queryClient.invalidateQueries({ queryKey: ['suites'] });
  };

  const create = useMutation({
    mutationFn: api.createCase,
    onSuccess: async () => {
      message.success('题目已新增');
      closeModal();
      await invalidate();
    },
    onError: (error) => message.error(error instanceof Error ? error.message : '新增失败'),
  });

  const update = useMutation({
    mutationFn: ({ id, values }: { id: string; values: Partial<TestCaseCreate> }) => api.updateCase(id, values),
    onSuccess: async () => {
      message.success('题目已更新');
      closeModal();
      await invalidate();
    },
    onError: (error) => message.error(error instanceof Error ? error.message : '更新失败'),
  });

  const remove = useMutation({
    mutationFn: api.deleteCase,
    onSuccess: async () => {
      message.success('题目已删除');
      await invalidate();
    },
    onError: (error) => message.error(error instanceof Error ? error.message : '删除失败'),
  });

  const importBundle = useMutation({
    mutationFn: api.importSuite,
    onSuccess: async (result) => {
      message.success(`题库已导入：新增 ${result.created_cases}，更新 ${result.updated_cases}`);
      setBundleText('');
      await invalidate();
    },
    onError: (error) => message.error(error instanceof Error ? error.message : '导入失败'),
  });

  const importEvalScope = useMutation({
    mutationFn: (jsonl: string) => {
      const suiteId = selectedExportSuiteId || suites.data?.[0]?.id || 'evalscope_imported_suite';
      const suite = suites.data?.find((item) => item.id === suiteId);
      return api.importEvalScopeJsonl({
        suite: {
          id: suiteId,
          name: suite?.name ?? 'EvalScope Imported Suite',
          description: suite?.description ?? 'Imported from EvalScope-style JSONL',
          version: suite?.version ?? 'evalscope-jsonl',
          visibility: suite?.visibility ?? 'public',
        },
        jsonl,
        default_module: moduleFilter !== 'all' ? moduleFilter : 'custom',
        default_task_type: 'qa',
      });
    },
    onSuccess: async (result) => {
      message.success(`EvalScope JSONL 已导入：新增 ${result.created_cases}，更新 ${result.updated_cases}`);
      setEvalScopeJsonl('');
      await invalidate();
    },
    onError: (error) => message.error(error instanceof Error ? error.message : 'EvalScope JSONL 导入失败'),
  });

  const selectedExportSuiteId = suiteFilter !== 'all' ? suiteFilter : suites.data?.[0]?.id;
  const exportedBundle = useQuery({
    queryKey: ['suiteExport', selectedExportSuiteId],
    queryFn: () => api.exportSuite(selectedExportSuiteId || ''),
    enabled: Boolean(selectedExportSuiteId),
  });
  const suiteDiff = useQuery({
    queryKey: ['suiteDiff', selectedExportSuiteId, diffAgainst],
    queryFn: () => api.diffSuite(selectedExportSuiteId || '', diffAgainst),
    enabled: Boolean(selectedExportSuiteId && diffAgainst.trim()),
  });
  const suiteCoverage = useQuery({
    queryKey: ['suiteCoverage', selectedExportSuiteId],
    queryFn: () => api.suiteCoverage(selectedExportSuiteId || ''),
    enabled: Boolean(selectedExportSuiteId),
  });
  const suiteValidation = useQuery({
    queryKey: ['suiteValidation', selectedExportSuiteId],
    queryFn: () => api.validateSuite(selectedExportSuiteId || ''),
    enabled: Boolean(selectedExportSuiteId),
  });
  const samplePlan = useQuery({
    queryKey: ['samplePlan', selectedExportSuiteId, moduleFilter, enabledFilter],
    queryFn: () => api.samplePlan({
      suite_id: selectedExportSuiteId || '',
      test_scope: 'full',
      modules: moduleFilter !== 'all' ? [moduleFilter] : [],
      group_by: 'module',
      per_group_limit: 3,
    } satisfies SamplePlanCreate),
    enabled: Boolean(selectedExportSuiteId),
  });

  const filteredCases = useMemo(() => {
    return (cases.data ?? []).filter((item) => {
      if (suiteFilter !== 'all' && item.suite_id !== suiteFilter) return false;
      if (moduleFilter !== 'all' && item.module !== moduleFilter) return false;
      if (enabledFilter === 'enabled' && !item.enabled) return false;
      if (enabledFilter === 'disabled' && item.enabled) return false;
      return true;
    });
  }, [cases.data, enabledFilter, moduleFilter, suiteFilter]);

  const moduleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of cases.data ?? []) counts.set(item.module, (counts.get(item.module) ?? 0) + 1);
    return counts;
  }, [cases.data]);
  const nextSortOrder = useMemo(() => Math.max(0, ...(cases.data ?? []).map((item) => item.sort_order ?? 0)) + 1, [cases.data]);

  function openCreate() {
    setEditing(null);
    form.setFieldsValue({
      suite_id: suites.data?.[0]?.id,
      module: 'identity',
      sort_order: nextSortOrder,
      title: '',
      prompt: '',
      system_prompt: '',
      request_params: JSON.stringify({ max_tokens: 256, temperature: 0 }, null, 2),
      scoring_rules: '',
      is_hidden: false,
      enabled: true,
    });
    setModalOpen(true);
  }

  function openEdit(testCase: TestCase) {
    setEditing(testCase);
    form.setFieldsValue({
      suite_id: testCase.suite_id,
      module: testCase.module,
      sort_order: testCase.sort_order,
      title: testCase.title,
      prompt: testCase.prompt,
      system_prompt: testCase.system_prompt ?? '',
      request_params: toJsonText(testCase.request_params),
      scoring_rules: toJsonText(testCase.scoring_rules),
      is_hidden: Boolean(testCase.is_hidden),
      enabled: testCase.enabled !== false,
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    form.resetFields();
  }

  function submit(values: CaseFormValues) {
    let requestParams: Record<string, unknown> | null;
    let scoringRules: Record<string, unknown> | null;

    try {
      requestParams = parseJsonField(values.request_params, '请求参数');
      scoringRules = parseJsonField(values.scoring_rules, '评分规则');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'JSON 格式错误');
      return;
    }

    const payload: TestCaseCreate = {
      suite_id: values.suite_id,
      module: values.module,
      sort_order: values.sort_order,
      title: values.title,
      prompt: values.prompt,
      system_prompt: values.system_prompt?.trim() || null,
      request_params: requestParams,
      scoring_rules: scoringRules,
      is_hidden: Boolean(values.is_hidden),
      enabled: values.enabled !== false,
    };

    if (editing) {
      update.mutate({ id: editing.id, values: payload });
    } else {
      create.mutate(payload);
    }
  }

  function toggleEnabled(testCase: TestCase, enabled: boolean) {
    update.mutate({ id: testCase.id, values: { enabled } });
  }

  function submitBundleImport() {
    try {
      const parsed = JSON.parse(bundleText);
      importBundle.mutate(parsed);
    } catch {
      message.error('导入内容必须是合法 JSON');
    }
  }

  function submitEvalScopeImport() {
    if (!evalScopeJsonl.trim()) {
      message.warning('请先粘贴 EvalScope JSONL');
      return;
    }
    importEvalScope.mutate(evalScopeJsonl);
  }

  function downloadBundle() {
    if (!exportedBundle.data) return;
    const blob = new Blob([JSON.stringify(exportedBundle.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${exportedBundle.data.suite.id || selectedExportSuiteId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Space direction="vertical" size={24} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">TEST CASES</Typography.Text>
          <Typography.Title level={2}>测试题目管理</Typography.Title>
          <Typography.Paragraph>
            内置题库会在这里完整展示，也可以新增自定义题目、编辑 Prompt 与评分规则，并控制是否参与后续检测任务。
          </Typography.Paragraph>
        </div>
        <Space wrap>
          <Button icon={<Download size={16} />} onClick={downloadBundle} disabled={!exportedBundle.data}>导出题库</Button>
          <Button type="primary" size="large" icon={<Plus size={16} />} onClick={openCreate}>
            新增题目
          </Button>
        </Space>
      </div>

      <section className="metric-strip">
        <div><span>题目总数</span><strong>{cases.data?.length ?? 0}</strong></div>
        <div><span>当前展示</span><strong>{filteredCases.length}</strong></div>
        <div><span>模块数量</span><strong>{moduleCounts.size}</strong></div>
        <div><span>Quick 题</span><strong>{suiteCoverage.data?.quick_count ?? '-'}</strong></div>
      </section>

      <Card title="题库质量与抽样" bordered={false}>
        <Space direction="vertical" size={14} className="full-width">
          <Space wrap>
            <Tag color={suiteValidation.data?.ok ? 'green' : 'red'}>
              校验 {suiteValidation.data?.ok ? '通过' : `${suiteValidation.data?.issue_count ?? '-'} 项`}
            </Tag>
            {Object.entries(suiteCoverage.data?.by_task_type ?? {}).map(([key, value]) => <Tag key={key} color="blue">{key}: {value}</Tag>)}
            {Object.entries(suiteCoverage.data?.by_risk_dimension ?? {}).map(([key, value]) => <Tag key={key} color="gold">{key}: {value}</Tag>)}
          </Space>
          {suiteValidation.data?.issues?.length ? (
            <Alert
              type={suiteValidation.data.ok ? 'info' : 'warning'}
              showIcon
              message="题库校验结果"
              description={
                <Space wrap>
                  {suiteValidation.data.issues.slice(0, 8).map((issue, index) => (
                    <Tag key={`${issue.case_id ?? 'suite'}-${index}`} color={issue.severity === 'error' ? 'red' : issue.severity === 'warning' ? 'orange' : 'default'}>
                      {issue.case_id ?? 'suite'} · {issue.field ?? '-'} · {issue.message}
                    </Tag>
                  ))}
                </Space>
              }
            />
          ) : null}
          <Alert
            type="info"
            showIcon
            icon={<Shuffle size={16} />}
            message={`抽样预览：${samplePlan.data?.selected_count ?? 0} / ${samplePlan.data?.total_available ?? 0} 道`}
            description={
              <Space wrap>
                {(samplePlan.data?.cases ?? []).slice(0, 12).map((item) => <Tag key={item.id}>{item.sort_order}. {item.title}</Tag>)}
              </Space>
            }
          />
        </Space>
      </Card>

      <Card title="题目筛选" bordered={false}>
          <div className="case-filter-grid">
            <Select
            value={suiteFilter}
            onChange={setSuiteFilter}
            options={[{ value: 'all', label: '全部测试集' }, ...(suites.data ?? []).map((suite) => ({ value: suite.id, label: suite.name }))]}
          />
          <Select
            value={moduleFilter}
            onChange={setModuleFilter}
            options={[{ value: 'all', label: '全部模块' }, ...moduleOptions]}
          />
          <Select
            value={enabledFilter}
            onChange={setEnabledFilter}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'enabled', label: '仅启用' },
              { value: 'disabled', label: '仅停用' },
            ]}
          />
        </div>
      </Card>

      <Collapse
        className="case-import-collapse"
        bordered={false}
        defaultActiveKey={[]}
        items={[
          {
            key: 'import',
            label: <span className="card-title-with-icon"><Upload size={18} />题库导入与差异</span>,
            children: (
              <Card bordered={false} className="case-import-card">
                <Space direction="vertical" size={14} className="full-width">
                  <Input.TextArea
                    rows={5}
                    value={bundleText}
                    onChange={(event) => setBundleText(event.target.value)}
                    placeholder="粘贴 TestSuite bundle JSON，包含 suite 与 cases"
                  />
                  <Space wrap>
                    <Button type="primary" icon={<Upload size={16} />} loading={importBundle.isPending} disabled={!bundleText.trim()} onClick={submitBundleImport}>导入/更新题库</Button>
                    <Button onClick={() => exportedBundle.data && setBundleText(JSON.stringify(exportedBundle.data, null, 2))} disabled={!exportedBundle.data}>填入当前导出</Button>
                  </Space>
                  <Input.TextArea
                    rows={4}
                    value={evalScopeJsonl}
                    onChange={(event) => setEvalScopeJsonl(event.target.value)}
                    placeholder='粘贴 EvalScope JSONL，每行一个样本，例如 {"id":"case1","question":"...","answer":"...","choices":["A","B"]}'
                  />
                  <Space wrap>
                    <Button icon={<Upload size={16} />} loading={importEvalScope.isPending} disabled={!evalScopeJsonl.trim()} onClick={submitEvalScopeImport}>导入 EvalScope JSONL</Button>
                    <Typography.Text type="secondary">导入到当前导出测试集，自动映射 question/prompt、choices、answer、tags、difficulty。</Typography.Text>
                  </Space>
                  <Input.TextArea
                    rows={3}
                    value={diffAgainst}
                    onChange={(event) => setDiffAgainst(event.target.value)}
                    placeholder="粘贴对比 bundle JSON，或输入另一个 suite_id"
                  />
                  {suiteDiff.data ? (
                    <Alert
                      type="info"
                      showIcon
                      message={`差异：新增 ${suiteDiff.data.added.length}，删除 ${suiteDiff.data.removed.length}，变更 ${suiteDiff.data.changed.length}，未变 ${suiteDiff.data.unchanged.length}`}
                      description={
                        <Space wrap>
                          {suiteDiff.data.changed.slice(0, 6).map((item) => <Tag key={item.id}>{item.id}: {item.fields.join(', ')}</Tag>)}
                        </Space>
                      }
                    />
                  ) : null}
                </Space>
              </Card>
            ),
          },
        ]}
      />

      <Card title="内置与自定义题目" bordered={false}>
        <Table
          rowKey="id"
          loading={cases.isLoading || suites.isLoading}
          dataSource={filteredCases}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 道题` }}
          expandable={{
            expandedRowRender: (record) => (
              <Space direction="vertical" size={12} className="full-width">
                <div>
                  <Typography.Text strong>Prompt</Typography.Text>
                  <pre className="prompt-preview">{record.prompt}</pre>
                </div>
                {record.system_prompt ? (
                  <div>
                    <Typography.Text strong>System Prompt</Typography.Text>
                    <pre className="prompt-preview">{record.system_prompt}</pre>
                  </div>
                ) : null}
                <div className="case-json-grid">
                  <pre className="json-block">{toJsonText(record.request_params) || 'null'}</pre>
                  <pre className="json-block">{toJsonText(record.scoring_rules) || 'null'}</pre>
                </div>
              </Space>
            ),
          }}
          columns={[
            {
              title: '顺序',
              dataIndex: 'sort_order',
              width: 96,
              sorter: (a, b) => a.sort_order - b.sort_order,
              render: (value: number) => <Tag color={value === 1 ? 'red' : 'default'}>#{value}</Tag>,
            },
            {
              title: '题目',
              dataIndex: 'title',
              width: 260,
              render: (title: string, record) => (
                <Space direction="vertical" size={2}>
                  <strong>{title}</strong>
                  <Typography.Text type="secondary">{record.id}</Typography.Text>
                </Space>
              ),
            },
            {
              title: '测试集',
              dataIndex: 'suite_id',
              width: 220,
              render: (id: string) => suiteName(suites.data, id),
            },
            {
              title: '模块',
              dataIndex: 'module',
              width: 140,
              render: (module: string) => <Tag color={moduleColor[module] ?? 'default'}>{module}</Tag>,
            },
            {
              title: '检测策略',
              width: 190,
              render: (_, record) => {
                const rules = record.scoring_rules ?? {};
                return (
                  <Space wrap size={4}>
                    {rules.quick ? <Tag color="blue">快速</Tag> : <Tag>完整</Tag>}
                    <Tag color="purple">权重 {String(rules.weight ?? 1)}</Tag>
                    <Tag color="gold">{String(rules.risk_dimension ?? 'quality')}</Tag>
                  </Space>
                );
              },
            },
            {
              title: '状态',
              dataIndex: 'enabled',
              width: 130,
              render: (enabled: boolean, record) => (
                <Switch
                  checked={enabled !== false}
                  checkedChildren="启用"
                  unCheckedChildren="停用"
                  loading={update.isPending}
                  onChange={(checked) => toggleEnabled(record, checked)}
                />
              ),
            },
            {
              title: '可见性',
              dataIndex: 'is_hidden',
              width: 110,
              render: (hidden: boolean) => <Tag color={hidden ? 'orange' : 'green'}>{hidden ? '隐藏题' : '公开'}</Tag>,
            },
            {
              title: 'Prompt 摘要',
              dataIndex: 'prompt',
              ellipsis: true,
            },
            {
              title: '操作',
              width: 180,
              fixed: 'right',
              render: (_, record) => (
                <Space>
                  <Button icon={<Edit3 size={15} />} onClick={() => openEdit(record)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除测试题目"
                    description="删除后不会再参与新检测任务。确定删除吗？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => remove.mutate(record.id)}
                  >
                    <Button danger icon={<Trash2 size={15} />} loading={remove.isPending}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          scroll={{ x: 1280 }}
        />
      </Card>

      <Modal
        title={editing ? '编辑测试题目' : '新增测试题目'}
        open={modalOpen}
        onCancel={closeModal}
        onOk={() => form.submit()}
        okText={editing ? '保存修改' : '创建题目'}
        cancelText="取消"
        width={860}
        confirmLoading={create.isPending || update.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={submit}>
          <div className="case-form-grid">
            <Form.Item name="suite_id" label="所属测试集" rules={[{ required: true, message: '请选择测试集' }]}>
              <Select options={(suites.data ?? []).map((suite) => ({ value: suite.id, label: suite.name }))} />
            </Form.Item>
            <Form.Item name="module" label="模块" rules={[{ required: true, message: '请选择模块' }]}>
              <Select options={moduleOptions} />
            </Form.Item>
            <Form.Item name="sort_order" label="顺序/优先级" rules={[{ required: true, message: '请输入顺序' }]}>
              <InputNumber min={1} max={9999} style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <Form.Item name="title" label="题目标题" rules={[{ required: true, message: '请输入题目标题' }]}>
            <Input placeholder="例如：厂商与模型名" />
          </Form.Item>
          <Form.Item name="prompt" label="Prompt" rules={[{ required: true, message: '请输入 Prompt' }]}>
            <Input.TextArea rows={6} placeholder="输入测评题目内容" />
          </Form.Item>
          <Form.Item name="system_prompt" label="System Prompt">
            <Input.TextArea rows={3} placeholder="可选" />
          </Form.Item>
          <div className="case-form-grid">
            <Form.Item name="request_params" label="请求参数 JSON">
              <Input.TextArea rows={7} placeholder='{"max_tokens":256,"temperature":0}' />
            </Form.Item>
            <Form.Item name="scoring_rules" label="评分规则 JSON">
              <Input.TextArea rows={7} placeholder='{"must_include":["Claude"]}' />
            </Form.Item>
          </div>
          <div className="case-switch-row">
            <Form.Item name="enabled" label="参与检测" valuePropName="checked">
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
            <Form.Item name="is_hidden" label="隐藏题" valuePropName="checked">
              <Switch checkedChildren="隐藏" unCheckedChildren="公开" />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </Space>
  );
}
