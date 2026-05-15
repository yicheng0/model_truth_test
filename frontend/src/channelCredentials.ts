import type { Channel } from './types';

export type RuntimeCredentialValues = {
  api_key?: string;
};

export type ChannelAuthFormValues = {
  api_key?: string;
  request_protocol?: string;
  account_type?: string;
};

export const accountTypeOptions = [
  { value: 'reverse', label: '逆向' },
  { value: 'aws', label: 'AWS' },
  { value: 'claude_code', label: 'Claude Code' },
  { value: 'claude', label: 'Claude' },
  { value: 'azure', label: 'Azure' },
  { value: 'vertex', label: 'Vertex' },
];

export const defaultAccountType = 'reverse';

export function accountTypeLabel(value?: unknown) {
  const text = typeof value === 'string' ? value : defaultAccountType;
  return accountTypeOptions.find((option) => option.value === text)?.label ?? text;
}

export function providerTypeForAccountType(value?: string) {
  switch (value) {
    case 'aws':
      return 'aws_bedrock';
    case 'claude_code':
      return 'claude_code';
    case 'claude':
      return 'anthropic';
    case 'azure':
      return 'azure_foundry';
    case 'vertex':
      return 'vertex_ai';
    case 'reverse':
    default:
      return 'custom_provider';
  }
}

export function trimmedValue(value?: string) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function hasStoredApiKey(channel: Pick<Channel, 'auth_config'>) {
  const value = channel.auth_config?.api_key;
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildRuntimeCredentials(
  channels: Array<Pick<Channel, 'id' | 'auth_config'>>,
  formCredentials?: Record<string, RuntimeCredentialValues>,
) {
  const runtimeCredentials: Record<string, Record<string, string>> = {};
  for (const channel of channels) {
    if (hasStoredApiKey(channel)) continue;
    const apiKey = trimmedValue(formCredentials?.[channel.id]?.api_key);
    if (apiKey) runtimeCredentials[channel.id] = { api_key: apiKey };
  }
  return runtimeCredentials;
}

export function buildChannelAuthConfig(
  values: ChannelAuthFormValues,
  existingAuthConfig?: Record<string, unknown>,
) {
  const authConfig: Record<string, unknown> = { ...(existingAuthConfig ?? {}) };
  const apiKey = trimmedValue(values.api_key);
  if (apiKey) {
    authConfig.api_key = apiKey;
  }
  authConfig.account_type = values.account_type || defaultAccountType;
  authConfig.request_protocol = values.request_protocol || 'auto';
  return authConfig;
}
