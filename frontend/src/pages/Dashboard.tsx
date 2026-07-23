import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Space, Typography } from 'antd';
import { Link } from 'react-router-dom';
import {
  BarChart3,
  CalendarClock,
  Database,
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
    title: '维护渠道指纹',
    description: '管理可信渠道生成的指纹基线，作为后续渠道真实性判断的参考资产。',
    to: '/baselines',
    action: '看指纹',
    icon: Database,
  },
  {
    title: '查看检测报告',
    description: '查看渠道评分、异常标签、性能指标和 Markdown 诊断结论。',
    to: '/reports',
    action: '看报告',
    icon: BarChart3,
  },
  {
    title: '复核渠道结论',
    description: '结合单渠道请求、Signature 检测和报告结果，定位渠道差异与风险。',
    to: '/reports',
    action: '去复核',
    icon: ShieldCheck,
  },
];

const featureLinks = [
  { title: '渠道管理', description: '维护渠道、协议、模型和密钥。', to: '/channels', icon: Network },
  { title: '渠道指纹', description: '管理已经生成的基线指纹。', to: '/baselines', icon: Database },
  { title: '模型请求', description: '向单个渠道发真实请求，查看 message id 和原始响应。', to: '/model-request-test', icon: Send },
  { title: 'Signature 检测', description: '验证 thinking signature 跨渠道复用行为。', to: '/signature-interop', icon: ShieldCheck },
  { title: '自动巡检', description: '为候选渠道设置周期检测和告警。', to: '/scheduled-tests', icon: CalendarClock },
  { title: '新建任务', description: '创建真实性对比或指纹提取任务。', to: '/new-run', icon: PlayCircle },
];

export default function Dashboard() {
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const baselines = useQuery({ queryKey: ['baselines'], queryFn: () => api.baselines() });
  const reports = useQuery({ queryKey: ['reports'], queryFn: api.reports });

  const enabledChannels = channels.data?.filter((channel) => channel.enabled).length ?? 0;
  const referenceChannels = channels.data?.filter((channel) => channel.is_reference).length ?? 0;
  const readyBaselines = baselines.data?.filter((baseline) => baseline.status === 'ready').length ?? 0;

  return (
    <Space direction="vertical" size={24} className="page-stack">
      {channels.isError || baselines.isError || reports.isError ? (
        <Alert
          type="error"
          showIcon
          message="总览数据加载失败"
          description={getErrorMessage(channels.error ?? baselines.error ?? reports.error)}
        />
      ) : null}

      <section className="reference-hero overview-hero">
        <div className="overview-hero-copy">
          <Typography.Text className="section-kicker">APIPRO RELAY EVAL</Typography.Text>
          <Typography.Title>渠道真实性测评工作台</Typography.Title>
          <Typography.Paragraph>
            这里聚合渠道配置、渠道指纹和报告结论。先确认渠道信息，再维护可信指纹资产，最后复核渠道评分、异常标签和诊断结论。
          </Typography.Paragraph>
        </div>
        <div className="overview-actions">
          <Link to="/channels">
            <Button type="primary" size="large" icon={<Network size={17} />}>配置渠道</Button>
          </Link>
          <Link to="/reports">
            <Button size="large" icon={<BarChart3 size={17} />}>查看报告</Button>
          </Link>
        </div>
      </section>

      <section className="metric-strip overview-metrics">
        <div><span>已配置渠道</span><strong>{channels.data?.length ?? 0}</strong></div>
        <div><span>可用渠道</span><strong>{enabledChannels}</strong></div>
        <div><span>指纹源渠道</span><strong>{referenceChannels}</strong></div>
        <div><span>Ready 指纹</span><strong>{readyBaselines}</strong></div>
        <div><span>报告数量</span><strong>{reports.data?.length ?? 0}</strong></div>
      </section>

      <section className="overview-section">
        <div className="section-heading">
          <div>
            <Typography.Text className="section-kicker">WORKFLOW</Typography.Text>
            <Typography.Title level={2}>推荐使用流程</Typography.Title>
          </div>
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
            <Typography.Paragraph>常用能力集中在这里，首页只保留渠道、指纹和报告的概览信息。</Typography.Paragraph>
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
    </Space>
  );
}
