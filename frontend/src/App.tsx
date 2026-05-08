import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Button, Layout, Popover, Typography } from 'antd';
import { Activity, CalendarClock, ClipboardList, Database, GitCompare, Headphones, ListChecks, Network } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Channels from './pages/Channels';
import Baselines from './pages/Baselines';
import CreateRun from './pages/CreateRun';
import Runs from './pages/Runs';
import RunDetail from './pages/RunDetail';
import TestCases from './pages/TestCases';
import ScheduledTests from './pages/ScheduledTests';

const { Content, Sider } = Layout;

const navItems = [
  { key: '/', icon: Activity, label: '总览', to: '/' },
  { key: '/channels', icon: Network, label: '渠道管理', to: '/channels' },
  { key: '/test-cases', icon: ClipboardList, label: '题目管理', to: '/test-cases' },
  { key: '/baselines', icon: Database, label: '基线管理', to: '/baselines' },
  { key: '/scheduled-tests', icon: CalendarClock, label: '自动巡检', to: '/scheduled-tests' },
  { key: '/new-run', icon: ListChecks, label: '创建检测', to: '/new-run' },
  { key: '/runs', icon: GitCompare, label: '任务列表', to: '/runs' },
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
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/channels" element={<Channels />} />
            <Route path="/test-cases" element={<TestCases />} />
            <Route path="/baselines" element={<Baselines />} />
            <Route path="/scheduled-tests" element={<ScheduledTests />} />
            <Route path="/new-run" element={<CreateRun />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:runId" element={<RunDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
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
