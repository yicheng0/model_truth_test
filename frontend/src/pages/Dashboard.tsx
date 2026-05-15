import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  CalendarClock,
  Database,
  FileText,
  GitCompare,
  ListChecks,
  Network,
  PlayCircle,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { api, getErrorMessage } from '../api';

const workflowSteps = [
  {
    title: '配置渠道',
    description: '录入 Base URL、模型名和 API Key，标记哪些是指纹源，哪些是待测渠道。',
    to: '/channels',
    action: '去配置',
    icon: Network,
  },
  {
    title: '提取渠道指纹',
    description: '用可信指纹源渠道生成可复用基线，后续对比任务直接引用这份指纹。',
    to: '/new-run?mode=baseline',
    action: '提取指纹',
    icon: Database,
  },
  {
    title: '发起检测任务',
    description: '选择渠道指纹和待测渠道，运行真实性对比任务。',
    to: '/new-run?mode=compare',
    action: '新建任务',
    icon: ListChecks,
  },
  {
    title: '查看结论',
    description: '在任务详情和报告中心查看评分、异常标签、性能指标和 Markdown 报告。',
    to: '/reports',
    action: '看报告',
    icon: FileText,
  },
];

const featureLinks = [
  { title: '渠道管理', description: '维护渠道、协议、模型和密钥。', to: '/channels', icon: Network },
  { title: '模型请求', description: '向单个渠道发真实请求，查看 message id 和原始响应。', to: '/model-request-test', icon: Send },
  { title: 'Signature 检测', description: '验证 thinking signature 跨渠道复用行为。', to: '/signature-interop', icon: ShieldCheck },
  { title: '渠道指纹', description: '管理已经生成的基线指纹。', to: '/baselines', icon: Database },
  { title: '新建任务', description: '创建真实性对比或指纹提取任务。', to: '/new-run', icon: PlayCircle },
  { title: '性能诊断', description: '对渠道做延迟、TTFT、TPOT 和吞吐诊断。', to: '/new-performance', icon: BarChart3 },
  { title: 'Arena 排名', description: '比较候选渠道胜率、题目分和样本分歧。', to: '/new-arena', icon: GitCompare },
  { title: '任务列表', description: '跟踪运行进度和历史任务。', to: '/runs', icon: GitCompare },
  { title: '报告中心', description: '集中查看渠道评分和诊断结论。', to: '/reports', icon: BarChart3 },
  { title: '自动巡检', description: '为候选渠道设置周期检测和告警。', to: '/scheduled-tests', icon: CalendarClock },
];

function statusTone(status: string) {
  if (status === 'completed') return 'green';
  if (status === 'failed' || status === 'canceled') return 'red';
  if (status === 'running' || status === 'pending') return 'gold';
  return 'default';
}

export default function Dashboard() {
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const baselines = useQuery({ queryKey: ['baselines'], queryFn: () => api.baselines() });
  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: api.runs,
    refetchInterval: (query) => (query.state.data?.some((run) => run.status === 'pending' || run.status === 'running') ? 3000 : false),
  });
  const reports = useQuery({
    queryKey: ['reports'],
    queryFn: api.reports,
    refetchInterval: () => (runs.data?.some((run) => run.status === 'pending' || run.status === 'running') ? 3000 : false),
  });

  const enabledChannels = channels.data?.filter((channel) => channel.enabled).length ?? 0;
  const referenceChannels = channels.data?.filter((channel) => channel.is_reference).length ?? 0;
  const readyBaselines = baselines.data?.filter((baseline) => baseline.status === 'ready').length ?? 0;
  const runningRuns = runs.data?.filter((run) => run.status === 'pending' || run.status === 'running').length ?? 0;
  const recentRuns = runs.data?.slice(0, 5) ?? [];

  return (
    <Space direction="vertical" size={24} className="page-stack">
      {channels.isError || baselines.isError || runs.isError || reports.isError ? (
        <Alert
          type="error"
          showIcon
          message="总览数据加载失败"
          description={getErrorMessage(channels.error ?? baselines.error ?? runs.error ?? reports.error)}
        />
      ) : null}

      <section className="reference-hero overview-hero">
        <div className="overview-hero-copy">
          <Typography.Text className="section-kicker">APIPRO RELAY EVAL</Typography.Text>
          <Typography.Title>渠道真实性测评工作台</Typography.Title>
          <Typography.Paragraph>
            这里是操作入口和流程总览。先配置渠道，再提取可信渠道指纹，随后发起真实性对比、性能诊断或 Arena 排名任务，最后在报告中心查看结论。
          </Typography.Paragraph>
        </div>
        <div className="overview-actions">
          <Link to="/new-run">
            <Button type="primary" size="large" icon={<ListChecks size={17} />}>新建任务</Button>
          </Link>
          <Link to="/channels">
            <Button size="large" icon={<Network size={17} />}>配置渠道</Button>
          </Link>
        </div>
      </section>

      <section className="metric-strip overview-metrics">
        <div><span>已配置渠道</span><strong>{channels.data?.length ?? 0}</strong></div>
        <div><span>可用渠道</span><strong>{enabledChannels}</strong></div>
        <div><span>指纹源渠道</span><strong>{referenceChannels}</strong></div>
        <div><span>Ready 指纹</span><strong>{readyBaselines}</strong></div>
        <div><span>检测任务</span><strong>{runs.data?.length ?? 0}</strong></div>
        <div><span>报告数量</span><strong>{reports.data?.length ?? 0}</strong></div>
      </section>

      <section className="overview-section">
        <div className="section-heading">
          <div>
            <Typography.Text className="section-kicker">WORKFLOW</Typography.Text>
            <Typography.Title level={2}>推荐使用流程</Typography.Title>
          </div>
          <Tag color={runningRuns ? 'gold' : 'green'}>{runningRuns ? `运行中 ${runningRuns}` : '系统就绪'}</Tag>
        </div>
        <div className="overview-workflow-grid">
          {workflowSteps.map((step, index) => {
            const Icon = step.icon;
            return (
              <article className="overview-step-card" key={step.title}>
                <div className="overview-step-index">{index + 1}</div>
                <Icon size={20} />
                <h3>{step.title}</h3>
                <p>{step.description}</p>
                <Link className="history-link" to={step.to}>{step.action}</Link>
              </article>
            );
          })}
        </div>
      </section>

      <section className="overview-section">
        <div className="section-heading">
          <div>
            <Typography.Text className="section-kicker">FEATURES</Typography.Text>
            <Typography.Title level={2}>核心功能</Typography.Title>
            <Typography.Paragraph>常用能力集中在这里，渠道明细和题目内容不再放在首页展开。</Typography.Paragraph>
          </div>
        </div>
        <div className="overview-feature-grid">
          {featureLinks.map((feature) => {
            const Icon = feature.icon;
            return (
              <Link className="overview-feature-card" to={feature.to} key={feature.title}>
                <Icon size={20} />
                <span>
                  <strong>{feature.title}</strong>
                  <small>{feature.description}</small>
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="overview-section">
        <div className="section-heading">
          <div>
            <Typography.Text className="section-kicker">RECENT RUNS</Typography.Text>
            <Typography.Title level={2}>最近任务</Typography.Title>
          </div>
          <Link className="history-link" to="/runs">查看全部任务</Link>
        </div>
        <div className="overview-run-list">
          {recentRuns.length ? recentRuns.map((run) => (
            <Link className="overview-run-row" to={`/runs/${run.id}`} key={run.id}>
              <span>
                <strong>{run.name}</strong>
                <small>{run.completed_jobs} / {run.total_jobs} jobs</small>
              </span>
              <Tag color={statusTone(run.status)}>{run.status}</Tag>
            </Link>
          )) : (
            <div className="overview-empty">
              <Activity size={18} />
              <span>还没有检测任务，先从新建任务开始。</span>
            </div>
          )}
        </div>
      </section>
    </Space>
  );
}
