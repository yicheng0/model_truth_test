import type { OpenAIResourceCheckRequest } from './types';

export const OPENAI_COMMON_MODEL_OPTIONS = [
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna（高效 / 常用）' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra（均衡）' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol（旗舰）' },
  { value: 'gpt-5.6', label: 'GPT-5.6（旗舰别名）' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
];

export type OpenAIResourceFormValues = {
  base_url?: string;
  api_key: string;
  organization?: string;
  project?: string;
  model?: string;
  detection_mode?: 'auto' | 'openai_api' | 'codex_relay';
  probe_depth?: 'quick' | 'deep';
};

export function openAIResourcePayload(values: OpenAIResourceFormValues): OpenAIResourceCheckRequest {
  return {
    base_url: values.base_url?.trim() || 'https://api.openai.com/v1',
    api_key: values.api_key.trim(),
    organization: values.organization?.trim() || null,
    project: values.project?.trim() || null,
    model: values.model?.trim() || null,
    detection_mode: values.detection_mode || 'auto',
    probe_depth: values.probe_depth || 'quick',
  };
}

export function capabilityState(value?: boolean | null) {
  if (value == null) return { color: 'default', text: '未执行' };
  if (value) return { color: 'green', text: '通过' };
  return { color: 'orange', text: '不支持 / 未通过' };
}

export function resourceFamilyMeta(value?: string | null) {
  const map: Record<string, { color: string; text: string }> = {
    official_openai_api_likely: { color: 'green', text: 'OpenAI API 官方直连高一致' },
    openai_api_relay_likely: { color: 'blue', text: '疑似 OpenAI API 中转' },
    codex_compatible_relay_likely: { color: 'purple', text: '疑似 Codex-compatible 中转' },
    hybrid_or_translated_gateway: { color: 'geekblue', text: '混合 / 协议转换网关' },
    openai_compatible_unverified: { color: 'orange', text: 'OpenAI-compatible，来源待确认' },
    suspicious_rewrite: { color: 'red', text: '疑似协议改写' },
    invalid_or_unverified: { color: 'default', text: '未验证' },
  };
  return map[value || ''] ?? { color: 'default', text: value || '-' };
}
