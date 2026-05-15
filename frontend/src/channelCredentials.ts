import type { Channel } from './types';

export type RuntimeCredentialValues = {
  api_key?: string;
};

export type ChannelAuthFormValues = {
  api_key?: string;
  request_protocol?: string;
};

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
  authConfig.request_protocol = values.request_protocol || 'auto';
  return authConfig;
}
