import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Button, Layout, Popover, Typography } from 'antd';
import { Activity, BarChart3, CalendarClock, ChevronLeft, ChevronRight, ClipboardList, Database, GitCompare, Headphones, ListChecks, Network, Send, ShieldCheck, Settings2, TerminalSquare, Trophy } from 'lucide-react';

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
const ClaudeCodeCheck = lazy(() => import('./pages/ClaudeCodeCheck'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const ReportDetailPage = lazy(() => import('./pages/ReportDetailPage'));
const ComparePage = lazy(() => import('./pages/ComparePage'));
const ResourceLogManagement = lazy(() => import('./pages/ResourceLogManagement'));

const { Content, Sider } = Layout;
const SIDEBAR_COLLAPSED_KEY = 'apipro.sidebar.collapsed';

function readSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}

const navItems = [
  { key: '/', icon: Activity, label: '总览', to: '/' },
  { key: '/channels', icon: Network, label: '渠道管理', to: '/channels' },
  { key: '/model-request-test', icon: Send, label: '模型请求', to: '/model-request-test' },
  { key: '/claude-code-check', icon: TerminalSquare, label: 'Claude Code', to: '/claude-code-check' },
  { key: '/signature-interop', icon: ShieldCheck, label: 'Signature 检测', to: '/signature-interop' },
  { key: '/test-cases', icon: ClipboardList, label: '题目管理', to: '/test-cases' },
  { key: '/baselines', icon: Database, label: '渠道指纹', to: '/baselines' },
  { key: '/scheduled-tests', icon: CalendarClock, label: '自动巡检', to: '/scheduled-tests' },
  { key: '/new-run', icon: ListChecks, label: '新建任务', to: '/new-run' },
  { key: '/new-performance', icon: BarChart3, label: '性能诊断', to: '/new-performance' },
  { key: '/new-arena', icon: Trophy, label: 'Arena 排名', to: '/new-arena' },
  { key: '/runs', icon: GitCompare, label: '任务列表', to: '/runs' },
];

function Shell() {
  const location = useLocation();
  const selected = `/${location.pathname.split('/')[1] || ''}`;
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);

  useEffect(() => {
    writeSidebarCollapsed(collapsed);
  }, [collapsed]);

  return (
    <Layout className="app-shell">
      <Sider
        width={288}
        collapsedWidth={88}
        collapsed={collapsed}
        className="enterprise-sidebar"
      >
        <Link className="brand-lockup" to="/">
          <img className="brand-logo" src="/apipro-logo.svg" alt="APIPro logo" />
          <span className="brand-lockup-copy">
            <Typography.Text className="brand-kicker">APIPro Team</Typography.Text>
            <Typography.Title level={4}>APIPro Relay Eval</Typography.Title>
          </span>
        </Link>

        <Button
          className="sidebar-collapse-button"
          type="text"
          icon={collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
        />

        <nav className="side-nav" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = selected === item.key || (item.key === '/' && selected === '/');
            return (
              <Link
                key={item.key}
                className={`side-nav-item ${active ? 'active' : ''}`}
                to={item.to}
                title={collapsed ? item.label : undefined}
                aria-label={item.label}
              >
                <Icon size={18} />
                <span className="side-nav-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-tools">
          <Link className="side-tool-link" to="/resource-log-management">
            <Button className="side-tool-button" icon={<Settings2 size={16} />} title={collapsed ? '资源与日志管理' : undefined}>
              <span className="side-tool-label">资源与日志管理</span>
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
            <Button className="side-tool-button" icon={<Headphones size={16} />} title={collapsed ? '联系客服' : undefined}>
              <span className="side-tool-label">联系客服</span>
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
              <Route path="/claude-code-check" element={<ClaudeCodeCheck />} />
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
