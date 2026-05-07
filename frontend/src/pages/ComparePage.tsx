import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { Badge } from "../components/Badge";
import { Section } from "../components/Section";
import type { Channel, Result } from "../types";

export function ComparePage() {
  const { runId = "", testCaseId } = useParams();
  const channels = useQuery({ queryKey: ["channels"], queryFn: api.channels });
  const cases = useQuery({ queryKey: ["cases"], queryFn: () => api.cases() });
  const results = useQuery({ queryKey: ["results", runId], queryFn: () => api.results(runId), enabled: Boolean(runId), refetchInterval: 2000 });
  const comparisons = useQuery({ queryKey: ["comparisons", runId], queryFn: () => api.comparisons(runId), enabled: Boolean(runId), refetchInterval: 2000 });
  const selectedCase = testCaseId || cases.data?.[0]?.id;
  const caseInfo = cases.data?.find((item) => item.id === selectedCase);
  const byChannel = new Map<string, Result>();
  (results.data ?? [])
    .filter((result) => result.test_case_id === selectedCase)
    .forEach((result) => byChannel.set(result.channel_id, result));
  const orderedChannels = orderChannels(channels.data ?? []);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p>Compare</p>
          <h1>单题四路对比</h1>
        </div>
      </header>
      <div className="case-tabs">
        {(cases.data ?? []).map((item) => (
          <Link key={item.id} className={`case-tab ${item.id === selectedCase ? "active" : ""}`} to={`/runs/${runId}/compare/${item.id}`}>
            {item.module}<ChevronRight size={14} />{item.title}
          </Link>
        ))}
      </div>
      {caseInfo ? (
        <Section title={caseInfo.title}>
          <div className="prompt-box">{caseInfo.prompt}</div>
        </Section>
      ) : null}
      <div className="compare-grid">
        {orderedChannels.map((channel) => {
          const result = byChannel.get(channel.id);
          const comparison = comparisons.data?.find((item) => item.test_case_id === selectedCase && item.candidate_channel_id === channel.id);
          return (
            <article key={channel.id} className="compare-column">
              <div className="compare-head">
                <strong>{channel.name}</strong>
                <Badge tone={channel.role === "gold" ? "blue" : channel.role === "official_cloud" ? "green" : channel.role === "candidate" ? "purple" : "red"}>{channel.role}</Badge>
              </div>
              <dl className="meta-grid">
                <div><dt>模型</dt><dd>{result?.normalized_response?.provider_model ?? channel.model_name}</dd></div>
                <div><dt>停止原因</dt><dd>{result?.normalized_response?.stop_reason ?? "-"}</dd></div>
                <div><dt>延迟</dt><dd>{result?.metrics?.latency_ms ?? "-"} ms</dd></div>
                <div><dt>评分</dt><dd>{result?.score?.toFixed(1) ?? "-"}</dd></div>
              </dl>
              {comparison ? (
                <div className="comparison-strip">
                  金标 {comparison.gold_similarity.toFixed(1)}% · 云参考 {comparison.official_cloud_similarity.toFixed(1)}%
                </div>
              ) : null}
              <div className="label-row">
                {(result?.labels?.length ? result.labels : ["no_labels"]).map((label) => <Badge key={label} tone={label === "no_labels" ? "green" : "amber"}>{label}</Badge>)}
              </div>
              <pre className="response-body">{result?.normalized_response?.content_text || JSON.stringify(result?.normalized_response?.tool_calls ?? [], null, 2) || "等待结果"}</pre>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function orderChannels(channels: Channel[]) {
  const rank = { gold: 0, official_cloud: 1, candidate: 2, negative: 3 };
  return [...channels].sort((a, b) => rank[a.role] - rank[b.role]);
}

