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

export type ChannelDisplayInput = Omit<Partial<Pick<Channel, 'id' | 'name' | 'provider_type' | 'auth_config'>>, 'id' | 'name' | 'provider_type'> & {
  id?: string | null;
  name?: string | null;
  provider_type?: string | null;
  account_type?: string | null;
  accountType?: string | null;
  providerType?: string | null;
  channel_number?: string | null;
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

function accountTypeFromToken(value?: string | null) {
  const text = (value ?? '').trim().toLowerCase();
  switch (text) {
    case 'kiro.claudecode':
    case 'kiro-claudecode':
    case 'kiro_claudecode':
      return 'kiro.claudecode';
    case 'aws':
    case 'aws_bedrock':
    case 'bedrock':
      return 'aws';
    case 'claude_code':
    case 'claude-code':
      return 'claude_code';
    case 'claude':
    case 'anthropic':
      return 'claude';
    case 'azure':
    case 'azure_foundry':
      return 'azure';
    case 'vertex':
    case 'vertex_ai':
      return 'vertex';
    case 'reverse':
    case 'custom_provider':
      return 'reverse';
    default:
      return '';
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

function nonEmptyText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isRedactedSecretPlaceholder(value?: string) {
  return Boolean(value?.includes('[REDACTED]'));
}

function channelNameTokens(name?: string | null) {
  return nonEmptyText(name).split('-').map((part) => part.trim()).filter(Boolean);
}

export function inferChannelNumber(channel?: ChannelDisplayInput | null, fallbackId?: string | null) {
  const rawId = nonEmptyText(channel?.id) || nonEmptyText(fallbackId);
  const explicit = nonEmptyText(channel?.channel_number);
  if (explicit) return explicit;
  const fromId = parseTokenflowChannelNumber(rawId);
  if (fromId) return fromId;
  const [firstNameToken] = channelNameTokens(channel?.name);
  return firstNameToken && /^[A-Za-z0-9_]+$/.test(firstNameToken) ? firstNameToken : '';
}

export function inferChannelAccountType(channel?: ChannelDisplayInput | null) {
  const configured =
    accountTypeFromToken(nonEmptyText(channel?.auth_config?.account_type)) ||
    accountTypeFromToken(nonEmptyText(channel?.accountType)) ||
    accountTypeFromToken(nonEmptyText(channel?.account_type)) ||
    accountTypeFromToken(nonEmptyText(channel?.providerType)) ||
    accountTypeFromToken(nonEmptyText(channel?.provider_type));
  const tokens = channelNameTokens(channel?.name);
  if (tokens.length > 1) {
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const accountType = accountTypeFromToken(tokens[index]);
      if (accountType && accountType !== defaultAccountType) return accountType;
    }
  }
  return configured;
}

export function normalizeChannelNickname(channel?: ChannelDisplayInput | null, fallbackId?: string | null) {
  return nonEmptyText(channel?.name);
}

export function channelDisplayAccountType(channel?: ChannelDisplayInput | null) {
  return inferChannelAccountType(channel);
}

export function formatChannelDisplayName(channel?: ChannelDisplayInput | null, fallbackId?: string | null) {
  const rawId = nonEmptyText(channel?.id) || nonEmptyText(fallbackId);
  return normalizeChannelNickname(channel, fallbackId) || rawId || '-';
}

export function canonicalChannelName(channel?: ChannelDisplayInput | null, fallbackId?: string | null) {
  return formatChannelDisplayName(channel, fallbackId);
}

export function formatProviderChannelDisplayName(channel?: ChannelDisplayInput | null, fallbackId?: string | null) {
  return formatChannelDisplayName(
    {
      id: channel?.id,
      name: channel?.name,
      channel_number: channel?.channel_number,
      accountType: channel?.providerType ?? channel?.provider_type ?? channel?.accountType ?? channel?.account_type ?? channel?.auth_config?.account_type,
    },
    fallbackId,
  );
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
  const explicitApiKey = trimmedValue(values.api_key);
  const existingApiKey = typeof existingAuthConfig?.api_key === 'string' ? existingAuthConfig.api_key : undefined;
  const apiKey = explicitApiKey ?? (existingAuthConfig ? undefined : buildTokenflowApiKey(values.channel_number));
  if (apiKey) {
    authConfig.api_key = apiKey;
  } else if (isRedactedSecretPlaceholder(existingApiKey)) {
    authConfig.api_key = existingApiKey;
  }
  authConfig.account_type = values.account_type || defaultAccountType;
  authConfig.request_protocol = values.request_protocol || 'auto';
  return authConfig;
}
