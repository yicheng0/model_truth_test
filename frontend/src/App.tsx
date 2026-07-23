import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Button, Layout, Typography } from 'antd';
import { Activity, CalendarClock, ChevronLeft, ChevronRight, ClipboardList, Database, DatabaseZap, Gauge, GitCompare, Layers, ListChecks, Network, Send, ShieldCheck, Settings2, TerminalSquare } from 'lucide-react';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Channels = lazy(() => import('./pages/Channels'));
const Baselines = lazy(() => import('./pages/Baselines'));
const CreateRun = lazy(() => import('./pages/CreateRun'));
const Runs = lazy(() => import('./pages/Runs'));
const RunDetail = lazy(() => import('./pages/RunDetail'));
const TestCases = lazy(() => import('./pages/TestCases'));
const ScheduledTests = lazy(() => import('./pages/ScheduledTests'));
const SignatureInterop = lazy(() => import('./pages/SignatureInterop'));
const CacheHitRateTest = lazy(() => import('./pages/CacheHitRateTest'));
const ModelRequestTest = lazy(() => import('./pages/ModelRequestTest'));
const FullModelCheck = lazy(() => import('./pages/FullModelCheck'));
const OpenAIResourceCheck = lazy(() => import('./pages/OpenAIResourceCheck'));
const GeminiResourceCheck = lazy(() => import('./pages/GeminiResourceCheck'));
const ClaudeCodeCheck = lazy(() => import('./pages/ClaudeCodeCheck'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const ReportDetailPage = lazy(() => import('./pages/ReportDetailPage'));
const ComparePage = lazy(() => import('./pages/ComparePage'));
const ResourceLogManagement = lazy(() => import('./pages/ResourceLogManagement'));
const Probes = lazy(() => import('./pages/Probes'));
const QuickCheck = lazy(() => import('./pages/QuickCheck'));

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
  { key: '/probes', icon: Layers, label: '探针管理', to: '/probes' },
  { key: '/cache-hit-rate-test', icon: DatabaseZap, label: '缓存命中率', to: '/cache-hit-rate-test' },
  { key: '/claude-code-check', icon: TerminalSquare, label: 'Claude 指纹', to: '/claude-code-check' },
  { key: '/model-request-test', icon: Send, label: '模型请求', to: '/model-request-test' },
  { key: '/full-model-check', icon: Gauge, label: '完整检测', to: '/full-model-check' },
  { key: '/openai-resource-check', icon: ShieldCheck, label: 'OpenAI / Codex 资源', to: '/openai-resource-check' },
  { key: '/gemini-resource-check', icon: ShieldCheck, label: 'Gemini 直连', to: '/gemini-resource-check' },
  { key: '/signature-interop', icon: ShieldCheck, label: 'Signature 检测', to: '/signature-interop' },
  { key: '/test-cases', icon: ClipboardList, label: '题目管理', to: '/test-cases' },
  { key: '/baselines', icon: Database, label: '渠道指纹', to: '/baselines' },
  { key: '/scheduled-tests', icon: CalendarClock, label: '自动巡检', to: '/scheduled-tests' },
  { key: '/new-run', icon: ListChecks, label: '新建任务', to: '/new-run' },
  { key: '/runs', icon: GitCompare, label: '任务列表', to: '/runs' },
];

function Shell() {
  const location = useLocation();
  if (location.pathname === '/check') {
    return (
      <Suspense fallback={<div className="route-loading">加载中...</div>}>
        <QuickCheck />
      </Suspense>
    );
  }
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
        </div>
      </Sider>

      <Layout className="workspace">
        <Content className="content">
          <Suspense fallback={<div className="route-loading">加载中...</div>}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/channels" element={<Channels />} />
              <Route path="/probes" element={<Probes />} />
              <Route path="/cache-hit-rate-test" element={<CacheHitRateTest />} />
              <Route path="/model-request-test" element={<ModelRequestTest />} />
              <Route path="/full-model-check" element={<FullModelCheck />} />
              <Route path="/openai-resource-check" element={<OpenAIResourceCheck />} />
              <Route path="/gemini-resource-check" element={<GeminiResourceCheck />} />
              <Route path="/claude-code-check" element={<ClaudeCodeCheck />} />
              <Route path="/signature-interop" element={<SignatureInterop />} />
              <Route path="/test-cases" element={<TestCases />} />
              <Route path="/baselines" element={<Baselines />} />
              <Route path="/scheduled-tests" element={<ScheduledTests />} />
              <Route path="/resource-log-management" element={<ResourceLogManagement />} />
              <Route path="/new-run" element={<CreateRun />} />
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
