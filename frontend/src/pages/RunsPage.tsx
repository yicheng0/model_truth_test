import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCompare, Play } from "lucide-react";
import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Badge } from "../components/Badge";
import { Section } from "../components/Section";

export function RunsPage() {
  const queryClient = useQueryClient();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api.runs(), refetchInterval: 2000 });
  const suites = useQuery({ queryKey: ["suites"], queryFn: api.suites });
  const cases = useQuery({ queryKey: ["cases"], queryFn: () => api.cases() });
  const [form, setForm] = useState({ name: "四路渠道真实性测评", suite_id: "", repeat_count: 1, concurrency: 4 });
  const create = useMutation({
    mutationFn: api.createRun,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      queryClient.invalidateQueries({ queryKey: ["reports"] });
    }
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({ ...form, repeat_count: Number(form.repeat_count), concurrency: Number(form.concurrency) });
  }

  const firstCase = cases.data?.[0]?.id;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p>Runs</p>
          <h1>测评任务</h1>
        </div>
      </header>
      <Section title="创建测评任务">
        <form className="form-grid" onSubmit={submit}>
          <label>任务名<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
          <label>
            测试集
            <select value={form.suite_id} onChange={(event) => setForm({ ...form, suite_id: event.target.value })} required>
              <option value="">选择测试集</option>
              {(suites.data ?? []).map((suite) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}
            </select>
          </label>
          <label>重复次数<input type="number" min={1} max={5} value={form.repeat_count} onChange={(event) => setForm({ ...form, repeat_count: Number(event.target.value) })} /></label>
          <label>并发度<input type="number" min={1} max={16} value={form.concurrency} onChange={(event) => setForm({ ...form, concurrency: Number(event.target.value) })} /></label>
          <button className="primary-button" type="submit" disabled={create.isPending}><Play size={16} />启动</button>
        </form>
      </Section>
      <Section title="任务列表">
        <div className="table-wrap">
          <table>
            <thead><tr><th>任务</th><th>状态</th><th>进度</th><th>重复</th><th>并发</th><th>对比</th></tr></thead>
            <tbody>
              {(runs.data ?? []).map((run) => (
                <tr key={run.id}>
                  <td><strong>{run.name}</strong></td>
                  <td><Badge tone={run.status === "completed" ? "green" : run.status === "failed" ? "red" : "amber"}>{run.status}</Badge></td>
                  <td>
                    <div className="progress"><span style={{ width: `${run.total_jobs ? (run.completed_jobs / run.total_jobs) * 100 : 0}%` }} /></div>
                    {run.completed_jobs} / {run.total_jobs}
                  </td>
                  <td>{run.repeat_count}</td>
                  <td>{run.concurrency}</td>
                  <td>
                    <Link className="text-button" to={`/runs/${run.id}`}><GitCompare size={16} />查看</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
