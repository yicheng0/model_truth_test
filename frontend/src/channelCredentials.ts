import type { Channel } from './types';

export type RuntimeCredentialValues = {
  api_key?: string;
};

export type ChannelAuthFormValues = {
  api_key?: string;
  request_protocol?: string;
  account_type?: string;
  channel_number?: string;
};

export const accountTypeOptions = [
  { value: 'reverse', label: '逆向' },
  { value: 'kiro.claudecode', label: 'Kiro Claude Code' },
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

export function accountTypeSlug(value?: string) {
  switch (value) {
    case 'kiro.claudecode':
      return 'kiro-claudecode';
    case 'aws':
      return 'aws';
    case 'claude_code':
      return 'claude-code';
    case 'claude':
      return 'claude';
    case 'azure':
      return 'azure';
    case 'vertex':
      return 'vertex';
    case 'reverse':
    default:
      return 'reverse';
  }
}

export function providerTypeForAccountType(value?: string) {
  switch (value) {
    case 'kiro.claudecode':
      return 'kiro_claudecode';
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

export function normalizeChannelNumber(value?: string) {
  return (value ?? '').trim();
}

export function isValidChannelNumber(value?: string) {
  return /^[A-Za-z0-9_-]+$/.test(normalizeChannelNumber(value));
}

export function buildTokenflowChannelId(channelNumber?: string, accountType?: string) {
  const normalized = normalizeChannelNumber(channelNumber);
  return normalized ? `${normalized}-tokenflow-${accountTypeSlug(accountType)}` : '';
}

export function buildTokenflowApiKey(channelNumber?: string) {
  const normalized = normalizeChannelNumber(channelNumber);
  return normalized ? `sk--${normalized}` : '';
}

export function parseTokenflowChannelNumber(channelId?: string) {
  const match = (channelId ?? '').match(/^(.+)-tokenflow-[A-Za-z0-9-]+$/);
  return match?.[1] ?? '';
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
  const apiKey = trimmedValue(values.api_key) ?? buildTokenflowApiKey(values.channel_number);
  if (apiKey) {
    authConfig.api_key = apiKey;
  }
  authConfig.account_type = values.account_type || defaultAccountType;
  authConfig.request_protocol = values.request_protocol || 'auto';
  return authConfig;
}
