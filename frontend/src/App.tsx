import { lazy, Suspense } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Button, Layout, Popover, Typography } from 'antd';
import { Activity, BarChart3, CalendarClock, ClipboardList, Database, FileText, GitCompare, Headphones, ListChecks, Network, Send, ShieldCheck, Settings2, Trophy } from 'lucide-react';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Channels = lazy(() => import('./pages/Channels'));
const Baselines = lazy(() => import('./pages/Baselines'));
const CreateRun = lazy(() => import('./pages/CreateRun'));
const CreatePerformanceRun = lazy(() => import('./pages/CreatePerformanceRun'));
const CreateArenaRun = lazy(() => import('./pages/CreateArenaRun'));
const Runs = lazy(() => import('./pages/Runs'));
const RunDetail = lazy(() => import('./pages/RunDetail'));
const TestCases = lazy(() => import('./pages/TestCases'));
const ScheduledTests = lazy(() => import('./pages/ScheduledTests'));
const SignatureInterop = lazy(() => import('./pages/SignatureInterop'));
const ModelRequestTest = lazy(() => import('./pages/ModelRequestTest'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const ReportDetailPage = lazy(() => import('./pages/ReportDetailPage'));
const ComparePage = lazy(() => import('./pages/ComparePage'));
const ResourceLogManagement = lazy(() => import('./pages/ResourceLogManagement'));

const { Content, Sider } = Layout;

const navItems = [
  { key: '/', icon: Activity, label: '总览', to: '/' },
  { key: '/channels', icon: Network, label: '渠道管理', to: '/channels' },
  { key: '/model-request-test', icon: Send, label: '模型请求', to: '/model-request-test' },
  { key: '/signature-interop', icon: ShieldCheck, label: 'Signature 检测', to: '/signature-interop' },
  { key: '/test-cases', icon: ClipboardList, label: '题目管理', to: '/test-cases' },
  { key: '/baselines', icon: Database, label: '渠道指纹', to: '/baselines' },
  { key: '/scheduled-tests', icon: CalendarClock, label: '自动巡检', to: '/scheduled-tests' },
  { key: '/new-run', icon: ListChecks, label: '新建任务', to: '/new-run' },
  { key: '/new-performance', icon: BarChart3, label: '性能诊断', to: '/new-performance' },
  { key: '/new-arena', icon: Trophy, label: 'Arena 排名', to: '/new-arena' },
  { key: '/runs', icon: GitCompare, label: '任务列表', to: '/runs' },
  { key: '/reports', icon: FileText, label: '报告中心', to: '/reports' },
];

function Shell() {
  const location = useLocation();
  const selected = `/${location.pathname.split('/')[1] || ''}`;

  return (
    <Layout className="app-shell">
      <Sider width={288} className="enterprise-sidebar">
        <Link className="brand-lockup" to="/">
          <img className="brand-logo" src="https://wenwen-us.oss-us-west-1.aliyuncs.com/apipro_logo.png" alt="APIPro logo" />
          <span>
            <Typography.Text className="brand-kicker">APIPro Team</Typography.Text>
            <Typography.Title level={4}>APIPro Relay Eval</Typography.Title>
          </span>
        </Link>

        <nav className="side-nav" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = selected === item.key || (item.key === '/' && selected === '/');
            return (
              <Link key={item.key} className={`side-nav-item ${active ? 'active' : ''}`} to={item.to}>
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-tools">
          <Link className="side-tool-link" to="/resource-log-management">
            <Button className="side-tool-button" icon={<Settings2 size={16} />}>
              资源与日志管理
            </Button>
          </Link>
          <Popover
            trigger="click"
            placement="rightBottom"
            content={
              <div className="support-popover">
                <img src="/support-qr.svg" alt="APIPro customer support QR code" />
                <strong>APIPro 客服</strong>
                <span>扫码联系团队客服</span>
              </div>
            }
          >
            <Button className="side-tool-button" icon={<Headphones size={16} />}>
              联系客服
            </Button>
          </Popover>
        </div>
      </Sider>

      <Layout className="workspace">
        <Content className="content">
          <Suspense fallback={<div className="route-loading">加载中...</div>}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/channels" element={<Channels />} />
              <Route path="/model-request-test" element={<ModelRequestTest />} />
              <Route path="/signature-interop" element={<SignatureInterop />} />
              <Route path="/test-cases" element={<TestCases />} />
              <Route path="/baselines" element={<Baselines />} />
              <Route path="/scheduled-tests" element={<ScheduledTests />} />
              <Route path="/resource-log-management" element={<ResourceLogManagement />} />
              <Route path="/new-run" element={<CreateRun />} />
              <Route path="/new-performance" element={<CreatePerformanceRun />} />
              <Route path="/new-arena" element={<CreateArenaRun />} />
              <Route path="/runs" element={<Runs />} />
              <Route path="/runs/:runId" element={<RunDetail />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/reports/:reportId" element={<ReportDetailPage />} />
              <Route path="/compare" element={<ComparePage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
