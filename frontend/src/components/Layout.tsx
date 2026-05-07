import { BarChart3, FileText, Gauge, GitCompare, Layers3, Settings, TestTubeDiagonal } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

const navItems = [
  { to: "/dashboard", label: "仪表盘", icon: Gauge },
  { to: "/channels", label: "渠道", icon: Layers3 },
  { to: "/test-suites", label: "测试集", icon: TestTubeDiagonal },
  { to: "/runs", label: "测评任务", icon: BarChart3 },
  { to: "/reports", label: "报告", icon: FileText },
  { to: "/settings", label: "设置", icon: Settings }
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <GitCompare size={22} aria-hidden="true" />
          <div>
            <strong>Claude Eval</strong>
            <span>Channel Authenticity</span>
          </div>
        </div>
        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </aside>
      <main className="main-pane">{children}</main>
    </div>
  );
}

