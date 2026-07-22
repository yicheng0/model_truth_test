import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AutoComplete, Button, Card, Collapse, Form, Input, Progress, Tag, Typography, message } from 'antd';
import { ArrowLeft, Check, CircleAlert, LoaderCircle, LockKeyhole, Play, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { buildLightweightChecks, sanitizeDetectionHistory, type LightweightCheck, type SafeDetectionHistory } from '../lightweightDetection';
import type { ClaudeCodeJobStatus, ClaudeCodeRelayTestCreate, ClaudeCodeTestResult } from '../types';

const HISTORY_KEY = 'apipro.quick-check.history';
const MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { value: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

function readHistory(): SafeDetectionHistory[] {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(value) ? value.slice(0, 6) : [];
  } catch {
    return [];
  }
}

function writeHistory(value: SafeDetectionHistory[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(value.slice(0, 6))); } catch { /* storage is optional */ }
}

function statusMeta(status: LightweightCheck['status']) {
  if (status === 'passed') return { label: '通过', color: 'success', icon: <Check size={17} /> };
  if (status === 'failed') return { label: '失败', color: 'error', icon: <X size={17} /> };
  if (status === 'warning') return { label: '警告', color: 'warning', icon: <CircleAlert size={17} /> };
  if (status === 'unavailable') return { label: '未验证', color: 'default', icon: <CircleAlert size={17} /> };
  return { label: '未执行', color: 'default', icon: <CircleAlert size={17} /> };
}

function ResultChecklist({ result }: { result: ClaudeCodeTestResult }) {
  const checks = useMemo(() => buildLightweightChecks(result), [result]);
  return (
    <div className="quick-check-result">
      <div className="quick-check-result-head">
        <div>
          <Typography.Text className="quick-check-eyebrow">检测完成</Typography.Text>
          <Typography.Title level={2}>{result.risk_level === 'low' ? '与 Claude 行为高度一致' : result.risk_level === 'medium' ? '基本可用，存在少量差异' : '发现需要关注的差异'}</Typography.Title>
          <Typography.Paragraph type="secondary">{result.summary}</Typography.Paragraph>
        </div>
        <div className="quick-score"><strong>{Math.round(result.score)}</strong><span>/ 100</span></div>
      </div>
      <div className="quick-check-list">
        {checks.map((check) => {
          const meta = statusMeta(check.status);
          return (
            <div className={`quick-check-row ${meta.color}`} key={check.key}>
              <span className="quick-check-icon">{meta.icon}</span>
              <div className="quick-check-copy"><strong>{check.title}</strong><Typography.Text type="secondary">{check.summary}</Typography.Text></div>
              <Tag color={meta.color}>{meta.label}</Tag>
            </div>
          );
        })}
      </div>
      <Collapse ghost items={[{ key: 'evidence', label: '展开技术证据', children: <pre className="quick-evidence">{JSON.stringify({ classification: result.classification_label, access_path: result.access_path_label, protocol: result.protocol_profile, probes: result.probes.map((probe) => ({ key: probe.key, status: probe.status, labels: probe.labels, reason: probe.reason })) }, null, 2)}</pre> }]} />
    </div>
  );
}

export default function QuickCheck() {
  const [form] = Form.useForm<ClaudeCodeRelayTestCreate>();
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<ClaudeCodeTestResult | null>(null);
  const [history, setHistory] = useState<SafeDetectionHistory[]>(readHistory);
  const [showKey, setShowKey] = useState(false);
  const [recordedJobId, setRecordedJobId] = useState<string | null>(null);
  const job = useQuery<ClaudeCodeJobStatus>({
    queryKey: ['quickCheckJob', jobId],
    queryFn: () => api.claudeCodeRelayTestJob(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) => query.state.data && ['completed', 'failed'].includes(query.state.data.status) ? false : 900,
  });
  const run = useMutation({
    mutationFn: (values: ClaudeCodeRelayTestCreate) => api.startClaudeCodeRelayTestJob({
      ...values,
      channel_label: values.channel_label?.trim() || '轻量检测',
      base_url: values.base_url.trim(),
      api_key: values.api_key.trim(),
      model_name: values.model_name?.trim() || 'claude-sonnet-4-5',
      probe_depth: 'standard',
      repeat_count: 3,
    }),
    onSuccess: (payload) => { setResult(null); setJobId(payload.job_id); },
    onError: (error) => message.error(getErrorMessage(error)),
  });
  const running = run.isPending || job.data?.status === 'queued' || job.data?.status === 'running';

  useEffect(() => {
    const next = job.data?.result;
    if (job.data?.status === 'completed' && next && 'probes' in next && recordedJobId !== job.data.job_id) {
      const completed = next as ClaudeCodeTestResult;
      setResult(completed);
      const values = form.getFieldsValue();
      const item = sanitizeDetectionHistory({ id: job.data.job_id, baseUrl: values.base_url || '', model: values.model_name || '', apiKey: values.api_key, score: completed.score, status: completed.risk_level, createdAt: new Date().toISOString() });
      setHistory((current) => { const updated = [item, ...current.filter((entry) => entry.id !== item.id)]; writeHistory(updated); return updated.slice(0, 6); });
      setRecordedJobId(job.data.job_id);
    }
  }, [job.data, form, recordedJobId]);

  useEffect(() => {
    if (job.data?.status === 'failed') {
      message.error(job.data.error || '检测任务失败，请核对接口地址、密钥和模型名称');
      setJobId(null);
    }
  }, [job.data?.error, job.data?.status]);

  function submit(values: ClaudeCodeRelayTestCreate) { setResult(null); setJobId(null); setRecordedJobId(null); run.mutate(values); }

  return (
    <main className="quick-check-page">
      <div className="quick-check-topbar"><Button type="text" icon={<ArrowLeft size={17} />} onClick={() => window.location.assign('/')}>返回控制台</Button><span><ShieldCheck size={18} /> APIPro 轻量检测</span></div>
      <section className="quick-check-hero"><Typography.Text className="quick-check-eyebrow">CLAUDE CHANNEL EVALUATION</Typography.Text><Typography.Title>验证你的 Claude API</Typography.Title><Typography.Paragraph>用同一组协议、能力和稳定性探针，快速看清一个接口是否保持 Claude 兼容行为。</Typography.Paragraph></section>
      {!result ? (
        <Card className="quick-check-config" bordered={false}>
          <div className="quick-check-card-head"><Typography.Title level={3}>接口配置</Typography.Title><Typography.Text type="secondary"><LockKeyhole size={14} /> 密钥仅用于本次检测，不会写入历史</Typography.Text></div>
          <Form form={form} layout="vertical" initialValues={{ base_url: 'https://api.anthropic.com/v1', model_name: 'claude-sonnet-4-5' }} onFinish={submit}>
            <div className="quick-check-fields"><Form.Item name="base_url" label="API 接口地址" rules={[{ required: true, message: '请输入 API 地址' }, { type: 'url', message: '请输入完整 URL' }]}><Input autoComplete="off" placeholder="https://api.anthropic.com/v1" /></Form.Item><Form.Item name="channel_label" label="备注（可选）"><Input autoComplete="off" placeholder="例如：我的中转站" maxLength={100} /></Form.Item><Form.Item name="api_key" label="API Key" rules={[{ required: true, message: '请输入 API Key' }]}><Input.Password autoComplete="new-password" visibilityToggle={{ visible: showKey, onVisibleChange: setShowKey }} placeholder="sk-ant-..." /></Form.Item></div>
            <Form.Item name="model_name" label="目标模型"><AutoComplete options={MODEL_OPTIONS} filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())} placeholder="例如 claude-sonnet-4-5" /></Form.Item>
            <div className="quick-check-actions"><Typography.Text type="secondary">检测包含协议结构、消息标识、流式响应、工具调用、上下文保持和重复稳定性。</Typography.Text><Button type="primary" size="large" htmlType="submit" icon={running ? <LoaderCircle className="spin" size={18} /> : <Play size={18} />} loading={running}>开始检测</Button></div>
          </Form>
        </Card>
      ) : <Card className="quick-check-result-card" bordered={false}><ResultChecklist result={result} /><Button icon={<RotateCcw size={16} />} onClick={() => { setResult(null); setJobId(null); }}>再次检测</Button></Card>}
      {running && !result ? <Card className="quick-check-progress" bordered={false}><Progress percent={Math.round(job.data?.percent ?? 0)} status="active" /><Typography.Text>{job.data?.current_title || '正在准备检测探针...'}</Typography.Text></Card> : null}
      {history.length ? <section className="quick-check-history"><Typography.Title level={4}>最近检测</Typography.Title>{history.map((item) => <div className="quick-history-row" key={item.id}><span>{item.endpointHost}</span><Typography.Text type="secondary">{item.model}</Typography.Text><Tag color={item.status === 'low' ? 'green' : item.status === 'medium' ? 'orange' : 'red'}>{Math.round(item.score)} 分</Tag></div>)}</section> : null}
      <Typography.Text className="quick-check-footnote">检测结果是证据摘要，不等同于官方来源证明。第三方网关可能重写协议字段或混合路由。</Typography.Text>
    </main>
  );
}
