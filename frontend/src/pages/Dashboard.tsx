import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Row, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { Activity, CheckCircle2, Clock3, FileText, ShieldCheck } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { providerTypeLabel, roleLabel } from '../channelTaxonomy';

const modules = [
  ['身份一致性', 10, '看渠道会不会把 Claude 说成别的模型、别的平台，或者自报信息前后打架。'],
  ['推理能力', 2, '用基础逻辑题和概率题看解题步骤是否稳定，结论是否自洽。'],
  ['代码生成', 2, '看代码题能不能给出正确实现、类型注解和边界处理。'],
  ['上下文记忆', 1, '看多轮对话里前面给过的事实会不会丢、会不会串。'],
  ['知识更新', 4, '看模型对明确时间点事件的覆盖情况，以及自报知识边界是否稳定。'],
  ['协议细节', 8, '看 message id、tool id、max_tokens 截断和流式结构是否符合预期。'],
  ['思考模式', 2, '看 thinking 内容和签名有没有真的返回，不只是给一个普通答案。'],
  ['敏感议题', 5, '看高关注议题上的表达完整度、信息密度和回答风格是否明显变化。'],
];

const sampleCases = [
  ['厂商与模型名', '要求模型直接给出厂商、模型名和版本，观察是否稳定自报为 Claude/Anthropic，还是漂移到其他模型。'],
  ['max_tokens=1 截断探针', '检测渠道是否真正遵守 max_tokens 上限，以及流式返回在极限截断下是否仍保持自洽。'],
  ['Tool Use 协议结构', '检查 tool_use block、tool id、工具参数 JSON 是否符合 Claude 原生结构。'],
  ['多轮上下文稳定性', '观察模型在干扰信息之后，是否还能按固定 JSON 格式输出指定事实。'],
  ['历史公共议题', '观察模型在高关注历史议题上的信息完整度、表达稳定性和风格变化。'],
];

export default function Dashboard() {
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: api.runs,
    refetchInterval: (query) => (query.state.data?.some((run) => run.status === 'pending' || run.status === 'running') ? 3000 : false),
  });
  const suites = useQuery({ queryKey: ['suites'], queryFn: api.suites });
  const taxonomy = useQuery({ queryKey: ['channelTaxonomy'], queryFn: api.channelTaxonomy });
  const reports = useQuery({
    queryKey: ['reports'],
    queryFn: api.reports,
    refetchInterval: () => (runs.data?.some((run) => run.status === 'pending' || run.status === 'running') ? 3000 : false),
  });

  const completed = runs.data?.filter((run) => run.status === 'completed').length ?? 0;
  const running = runs.data?.filter((run) => run.status === 'running').length ?? 0;
  const totalJobs = runs.data?.reduce((sum, run) => sum + run.completed_jobs, 0) ?? 0;
  const fingerprintChannels = channels.data?.filter((channel) => channel.is_reference).length ?? 0;
  const latestReports = reports.data?.slice(0, 4) ?? [];
  const recentChannels = channels.data?.slice(0, 6) ?? [];

  return (
    <Space direction="vertical" size={28} className="page-stack">
      {channels.isError || runs.isError || suites.isError || reports.isError ? (
        <Alert
          type="error"
          showIcon
          message="仪表盘数据加载失败"
          description={getErrorMessage(channels.error ?? runs.error ?? suites.error ?? reports.error)}
        />
      ) : null}
      <section className="reference-hero">
        <Typography.Text className="section-kicker">APIPRO RELAY EVAL</Typography.Text>
        <Typography.Title>渠道真实性测评</Typography.Title>

        <div className="soft-panel">
          <Typography.Title level={4}>这套检测在测什么</Typography.Title>
          <Typography.Paragraph>
            这套公开检测围绕固定题目测试集运行。重点不是只看渠道能不能答题，而是同时看身份自报、能力表现、协议细节、工具调用和敏感议题输出是否稳定。
          </Typography.Paragraph>
        </div>

        <div className="coverage-panel">
          <Typography.Title level={4}>测试集覆盖方向</Typography.Title>
          <Row gutter={[14, 14]}>
            {modules.map(([name, count, description]) => (
              <Col xs={24} md={12} key={name}>
                <div className="coverage-card">
                  <strong>{name}</strong>
                  <span>{count} 题</span>
                  <p>{description}</p>
                </div>
              </Col>
            ))}
          </Row>
        </div>

        <div className="soft-panel">
          <Typography.Title level={4}>代表题目</Typography.Title>
          <ul className="sample-list">
            {sampleCases.map(([title, description]) => (
              <li key={title}>
                <strong>{title}</strong>
                <span>{description}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="metric-strip">
        <div><span>指纹源渠道</span><strong>{fingerprintChannels}</strong></div>
        <div><span>当前可用</span><strong>{channels.data?.filter((channel) => channel.enabled).length ?? 0}</strong></div>
        <div><span>测评通过</span><strong>{completed}</strong></div>
        <div><span>单次测试</span><strong>{totalJobs || 183}</strong></div>
      </section>

      <section className="tab-actions">
        <Link className="tab-pill active" to="/">渠道可用性</Link>
        <Link className="tab-pill" to="/runs">渠道质量检测</Link>
        <Link className="tab-pill" to="/new-run">新建任务</Link>
      </section>

      <Card className="section-card" bordered={false}>
        <div className="section-heading">
          <div>
            <Typography.Text className="section-kicker">渠道可用性</Typography.Text>
            <Typography.Title level={2}>查看托管渠道最近的可用性变化</Typography.Title>
            <Typography.Paragraph>
              每个渠道都会保留最近检测任务的关键指标。你可以先看它最近是不是稳定，再决定要不要继续打开历史或做完整检测。
            </Typography.Paragraph>
          </div>
          <Button type="primary" icon={<Activity size={16} />}>
            轻量探测
          </Button>
        </div>

        <div className="filter-row">
          {['全部', 'Anthropic', 'Aws Bedrock', 'Azure', 'OpenAI Compatible', '负样本'].map((item, index) => (
            <button key={item} className={`filter-chip ${index === 0 ? 'active' : ''}`} type="button">
              {item}
            </button>
          ))}
        </div>

        <div className="channel-stack">
          {recentChannels.map((channel) => {
            const report = latestReports.find((item) => item.channel_id === channel.id);
            return (
              <article className="relay-card" key={channel.id}>
                <div className="relay-main">
                  <div className="relay-title-row">
                    <h3>{channel.name}</h3>
                    <Tag color={channel.enabled ? 'green' : 'red'}>{channel.enabled ? '维护中' : '停用'}</Tag>
                  </div>
                  <p>测试模型：{channel.model_name || '未配置'}</p>
                  <p>渠道来源：{roleLabel(channel.role, taxonomy.data)}</p>
                  <p>渠道分类：{providerTypeLabel(channel.provider_type, taxonomy.data)}</p>
                  <p className="relay-desc">
                    通过统一题集和同参数执行，比较协议结构、截断行为、工具调用、内容相似度和稳定性。
                  </p>
                </div>
                <div className="availability-box">
                  <div>
                    <span>最近可用性</span>
                    <strong>{report ? `${Math.round(report.final_score)} 分` : '未探测'}</strong>
                  </div>
                  <div className="availability-bar">
                    <span style={{ width: `${report ? Math.max(8, report.final_score) : 8}%` }} />
                  </div>
                  <small>{report?.summary ?? '还没有探测记录'}</small>
                </div>
                <div className="relay-metrics">
                  <div><Clock3 size={15} /><span>最近状态</span><strong>{report ? report.grade : '未探测'}</strong></div>
                  <div><CheckCircle2 size={15} /><span>成功次数</span><strong>{completed}</strong></div>
                  <div><ShieldCheck size={15} /><span>异常标签</span><strong>{report?.evidence?.labels?.length ?? 0}</strong></div>
                  <div><FileText size={15} /><span>报告</span><strong>{latestReports.length}</strong></div>
                </div>
                <Link className="history-link" to="/runs">查看历史</Link>
              </article>
            );
          })}
        </div>
      </Card>
    </Space>
  );
}
