import { useQuery } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../api";
import { Badge } from "../components/Badge";
import { Section } from "../components/Section";

const gradeTone = {
  A: "green",
  B: "blue",
  C: "amber",
  D: "red",
  E: "red"
} as const;

export function ReportsPage() {
  const reports = useQuery({ queryKey: ["reports"], queryFn: api.reports });
  const channels = useQuery({ queryKey: ["channels"], queryFn: api.channels });
  const [selectedId, setSelectedId] = useState<string>("");
  const channelById = useMemo(() => new Map((channels.data ?? []).map((channel) => [channel.id, channel.name])), [channels.data]);
  const selected = reports.data?.find((report) => report.id === (selectedId || reports.data?.[0]?.id));

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p>Reports</p>
          <h1>渠道评级报告</h1>
        </div>
      </header>
      <div className="reports-layout">
        <Section title="报告列表">
          <div className="report-list">
            {(reports.data ?? []).map((report) => (
              <button key={report.id} className={`report-row ${selected?.id === report.id ? "active" : ""}`} type="button" onClick={() => setSelectedId(report.id)}>
                <FileText size={16} />
                <span>{channelById.get(report.channel_id) ?? report.channel_id}</span>
                <Badge tone={gradeTone[report.grade]}>{report.grade}</Badge>
                <strong>{report.final_score.toFixed(1)}</strong>
              </button>
            ))}
          </div>
        </Section>
        <Section title="Markdown 报告" actions={<button className="icon-button" aria-label="导出 Markdown"><Download size={16} /></button>}>
          <pre className="markdown-preview">{selected?.markdown ?? "暂无报告"}</pre>
        </Section>
      </div>
    </div>
  );
}

