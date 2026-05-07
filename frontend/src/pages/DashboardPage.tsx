import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, FileCheck2, Layers3, TimerReset } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { Badge } from "../components/Badge";
import { Section } from "../components/Section";
import { StatCard } from "../components/StatCard";

export function DashboardPage() {
  const channels = useQuery({ queryKey: ["channels"], queryFn: api.channels });
  const runs = useQuery({ queryKey: ["runs"], queryFn: api.runs, refetchInterval: 2500 });
  const reports = useQuery({ queryKey: ["reports"], queryFn: api.reports });

  const riskData = ["A", "B", "C", "D", "E"].map((grade) => ({
    grade,
    count: reports.data?.filter((report) => report.grade === grade).length ?? 0
  }));
  const trendData =
    reports.data?.slice(0, 8).reverse().map((report, index) => ({
      name: `R${index + 1}`,
      score: report.final_score
    })) ?? [];
  const runningCount = runs.data?.filter((run) => run.status === "running").length ?? 0;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p>Dashboard</p>
          <h1>Claude 渠道真实性测评</h1>
        </div>
        <Badge tone={runningCount > 0 ? "amber" : "green"}>{runningCount > 0 ? "任务执行中" : "系统就绪"}</Badge>
      </header>

      <div className="stats-grid">
        <StatCard label="渠道总数" value={channels.data?.length ?? 0} detail="金标、云参考、待测、负样本" icon={Layers3} tone="blue" />
        <StatCard label="测评任务" value={runs.data?.length ?? 0} detail="包含历史与当前任务" icon={Activity} tone="purple" />
        <StatCard label="报告数量" value={reports.data?.length ?? 0} detail="候选渠道评级报告" icon={FileCheck2} tone="green" />
        <StatCard label="运行中" value={runningCount} detail="后台模拟执行队列" icon={TimerReset} tone="amber" />
      </div>

      <div className="two-column">
        <Section title="近期平均分趋势">
          <div className="chart-frame">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="name" />
                <YAxis domain={[0, 100]} />
                <Tooltip />
                <Line type="monotone" dataKey="score" stroke="#2563EB" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Section>
        <Section title="第三方风险分布">
          <div className="chart-frame">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={riskData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="grade" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="count" fill="#F97316" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <Section title="最近测评任务">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>进度</th>
                <th>重复次数</th>
                <th>并发</th>
              </tr>
            </thead>
            <tbody>
              {(runs.data ?? []).slice(0, 6).map((run) => (
                <tr key={run.id}>
                  <td>{run.name}</td>
                  <td><Badge tone={run.status === "completed" ? "green" : "amber"}>{run.status}</Badge></td>
                  <td>{run.completed_jobs} / {run.total_jobs}</td>
                  <td>{run.repeat_count}</td>
                  <td>{run.concurrency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {channels.isError || runs.isError || reports.isError ? (
        <div className="inline-alert"><AlertTriangle size={18} />后端接口暂不可用，请确认 FastAPI 已启动。</div>
      ) : null}
    </div>
  );
}

