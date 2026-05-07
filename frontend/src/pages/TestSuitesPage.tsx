import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { api } from "../api";
import { Badge } from "../components/Badge";
import { Section } from "../components/Section";

export function TestSuitesPage() {
  const queryClient = useQueryClient();
  const suites = useQuery({ queryKey: ["suites"], queryFn: api.suites });
  const cases = useQuery({ queryKey: ["cases"], queryFn: () => api.cases() });
  const [suiteForm, setSuiteForm] = useState({ name: "", description: "", version: "2026.05", visibility: "public" });
  const [caseForm, setCaseForm] = useState({ suite_id: "", module: "identity", title: "", prompt: "", is_hidden: false });
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    (cases.data ?? []).forEach((item) => map.set(item.suite_id, (map.get(item.suite_id) ?? 0) + 1));
    return map;
  }, [cases.data]);
  const createSuite = useMutation({
    mutationFn: api.createSuite,
    onSuccess: () => {
      setSuiteForm({ name: "", description: "", version: "2026.05", visibility: "public" });
      queryClient.invalidateQueries({ queryKey: ["suites"] });
    }
  });
  const createCase = useMutation({
    mutationFn: api.createCase,
    onSuccess: () => {
      setCaseForm({ suite_id: "", module: "identity", title: "", prompt: "", is_hidden: false });
      queryClient.invalidateQueries({ queryKey: ["cases"] });
    }
  });

  function submitSuite(event: FormEvent) {
    event.preventDefault();
    createSuite.mutate(suiteForm);
  }

  function submitCase(event: FormEvent) {
    event.preventDefault();
    createCase.mutate({ ...caseForm, request_params: { max_tokens: 256, temperature: 0 }, enabled: true });
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p>Test Suites</p>
          <h1>测试集与题目</h1>
        </div>
      </header>
      <div className="two-column">
        <Section title="新增测试集">
          <form className="stacked-form" onSubmit={submitSuite}>
            <label>名称<input value={suiteForm.name} onChange={(event) => setSuiteForm({ ...suiteForm, name: event.target.value })} required /></label>
            <label>描述<textarea value={suiteForm.description} onChange={(event) => setSuiteForm({ ...suiteForm, description: event.target.value })} rows={4} /></label>
            <label>版本<input value={suiteForm.version} onChange={(event) => setSuiteForm({ ...suiteForm, version: event.target.value })} /></label>
            <button className="primary-button" type="submit"><Plus size={16} />新增测试集</button>
          </form>
        </Section>
        <Section title="新增题目">
          <form className="stacked-form" onSubmit={submitCase}>
            <label>
              所属测试集
              <select value={caseForm.suite_id} onChange={(event) => setCaseForm({ ...caseForm, suite_id: event.target.value })} required>
                <option value="">选择测试集</option>
                {(suites.data ?? []).map((suite) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}
              </select>
            </label>
            <label>模块<select value={caseForm.module} onChange={(event) => setCaseForm({ ...caseForm, module: event.target.value })}>
              <option value="identity">identity</option>
              <option value="protocol">protocol</option>
              <option value="streaming">streaming</option>
              <option value="truncation">truncation</option>
              <option value="tool_use">tool_use</option>
              <option value="capability">capability</option>
              <option value="knowledge">knowledge</option>
              <option value="safety">safety</option>
              <option value="context">context</option>
            </select></label>
            <label>标题<input value={caseForm.title} onChange={(event) => setCaseForm({ ...caseForm, title: event.target.value })} required /></label>
            <label>Prompt<textarea value={caseForm.prompt} onChange={(event) => setCaseForm({ ...caseForm, prompt: event.target.value })} rows={4} required /></label>
            <label className="check-row"><input type="checkbox" checked={caseForm.is_hidden} onChange={(event) => setCaseForm({ ...caseForm, is_hidden: event.target.checked })} />隐藏题</label>
            <button className="primary-button" type="submit"><Plus size={16} />新增题目</button>
          </form>
        </Section>
      </div>

      <Section title="题库列表">
        <div className="table-wrap">
          <table>
            <thead><tr><th>测试集</th><th>版本</th><th>可见性</th><th>题目数</th><th>描述</th></tr></thead>
            <tbody>
              {(suites.data ?? []).map((suite) => (
                <tr key={suite.id}>
                  <td><strong>{suite.name}</strong></td>
                  <td>{suite.version}</td>
                  <td><Badge tone={suite.visibility === "hidden" ? "red" : "blue"}>{suite.visibility ?? "public"}</Badge></td>
                  <td>{counts.get(suite.id) ?? 0}</td>
                  <td>{suite.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
