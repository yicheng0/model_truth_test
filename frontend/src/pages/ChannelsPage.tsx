import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Plus, RefreshCw } from "lucide-react";
import { FormEvent, useState } from "react";
import { api } from "../api";
import { Badge } from "../components/Badge";
import { Section } from "../components/Section";
import {
  accountTypeLabel,
  accountTypeOptions,
  buildTokenflowApiKey,
  buildTokenflowChannelId,
  defaultAccountType,
  providerTypeForAccountType,
} from "../channelCredentials";
import type { ChannelRole } from "../types";

const roleTone = {
  gold: "blue",
  official_cloud: "green",
  candidate: "purple",
  negative: "red"
} as const;

export function ChannelsPage() {
  const queryClient = useQueryClient();
  const channels = useQuery({ queryKey: ["channels"], queryFn: api.channels });
  const [health, setHealth] = useState<Record<string, string>>({});
  const emptyForm = { name: "", channel_number: "", account_type: defaultAccountType, role: "candidate" as ChannelRole };
  const [form, setForm] = useState(emptyForm);
  const create = useMutation({
    mutationFn: api.createChannel,
    onSuccess: () => {
      setForm(emptyForm);
      queryClient.invalidateQueries({ queryKey: ["channels"] });
    }
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const { account_type, ...values } = form;
    create.mutate({
      ...values,
      id: buildTokenflowChannelId(values.channel_number, account_type),
      provider_type: providerTypeForAccountType(account_type),
      auth_config: { account_type, api_key: buildTokenflowApiKey(values.channel_number), request_protocol: "auto" },
      enabled: true,
    });
  }

  async function check(id: string) {
    setHealth((current) => ({ ...current, [id]: "checking" }));
    const result = await api.healthCheck(id);
    setHealth((current) => ({ ...current, [id]: result.ok ? "ok" : "fail" }));
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p>Channels</p>
          <h1>渠道管理</h1>
        </div>
      </header>
      <Section title="新增渠道">
        <form className="form-grid" onSubmit={submit}>
          <label>
            渠道名
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          </label>
          <label>
            渠道编号
            <input value={form.channel_number} onChange={(event) => setForm({ ...form, channel_number: event.target.value })} placeholder="9333" required />
          </label>
          <label>
            账号类型
            <select value={form.account_type} onChange={(event) => setForm({ ...form, account_type: event.target.value })}>
              {accountTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            角色
            <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as ChannelRole })}>
              <option value="gold">gold</option>
              <option value="official_cloud">official_cloud</option>
              <option value="candidate">candidate</option>
              <option value="negative">negative</option>
            </select>
          </label>
          <button className="primary-button" type="submit" disabled={create.isPending}>
            <Plus size={16} />新增
          </button>
        </form>
      </Section>

      <Section title="渠道列表">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>渠道</th>
                <th>账号类型</th>
                <th>角色</th>
                <th>API Key</th>
                <th>健康检查</th>
              </tr>
            </thead>
            <tbody>
              {(channels.data ?? []).map((channel) => (
                <tr key={channel.id}>
                  <td><strong>{channel.name}</strong></td>
                  <td>{accountTypeLabel(channel.auth_config?.account_type)}</td>
                  <td><Badge tone={roleTone[channel.role as keyof typeof roleTone] ?? "purple"}>{channel.role}</Badge></td>
                  <td>{channel.auth_config?.api_key ? "自动生成" : "未配置"}</td>
                  <td>
                    <button className="icon-button" type="button" aria-label="健康检查" onClick={() => check(channel.id)}>
                      {health[channel.id] === "ok" ? <CheckCircle2 size={16} /> : <RefreshCw size={16} />}
                    </button>
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
