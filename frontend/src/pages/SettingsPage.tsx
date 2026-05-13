import { Save } from "lucide-react";
import { Section } from "../components/Section";

const weights = [
  ["渠道指纹一致性", 25],
  ["云参考一致性", 15],
  ["协议结构可信度", 15],
  ["流式响应一致性", 8],
  ["参数遵守与截断行为", 8],
  ["Tool Use 一致性", 8],
  ["能力表现", 10],
  ["多轮上下文稳定性", 6],
  ["延迟、失败率、token 异常", 5]
];

export function SettingsPage() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p>Settings</p>
          <h1>系统设置</h1>
        </div>
      </header>
      <div className="two-column">
        <Section title="模型列表">
          <div className="setting-list">
            {["claude-sonnet-4-5", "anthropic.claude-sonnet-4-5-v1:0", "claude-opus-4-1", "claude-haiku-4-5"].map((model) => (
              <label key={model} className="check-row"><input type="checkbox" defaultChecked />{model}</label>
            ))}
          </div>
        </Section>
        <Section title="评分权重" actions={<button className="primary-button" type="button"><Save size={16} />保存</button>}>
          <div className="weight-list">
            {weights.map(([label, value]) => (
              <label key={label}>
                <span>{label}</span>
                <input type="number" min={0} max={100} defaultValue={value} />
              </label>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
