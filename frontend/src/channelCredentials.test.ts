import { describe, expect, it } from 'vitest';
import { buildChannelAuthConfig, buildRuntimeCredentials, hasStoredApiKey } from './channelCredentials';
import type { Channel } from './types';

function channel(id: string, auth_config?: Record<string, unknown>): Pick<Channel, 'id' | 'auth_config'> {
  return { id, auth_config };
}

describe('channel credential helpers', () => {
  it('detects stored API keys', () => {
    expect(hasStoredApiKey(channel('stored', { api_key: ' sk-test ' }))).toBe(true);
    expect(hasStoredApiKey(channel('blank', { api_key: '   ' }))).toBe(false);
    expect(hasStoredApiKey(channel('missing'))).toBe(false);
  });

  it('omits runtime credentials for channels that already have a stored key', () => {
    const runtime = buildRuntimeCredentials(
      [
        channel('stored', { api_key: 'saved-key' }),
        channel('missing'),
      ],
      {
        stored: { api_key: 'temporary-override' },
        missing: { api_key: ' temporary-key ' },
      },
    );

    expect(runtime).toEqual({
      missing: { api_key: 'temporary-key' },
    });
  });

  it('keeps an existing channel API key when the edit form key is blank', () => {
    const authConfig = buildChannelAuthConfig(
      { api_key: '   ', request_protocol: 'openai_chat_completions' },
      { api_key: 'saved-key', region: 'us-east-1', request_protocol: 'auto' },
    );

    expect(authConfig).toEqual({
      api_key: 'saved-key',
      region: 'us-east-1',
      request_protocol: 'openai_chat_completions',
    });
  });

  it('updates an existing channel API key when a new key is provided', () => {
    const authConfig = buildChannelAuthConfig(
      { api_key: ' new-key ', request_protocol: 'anthropic_messages' },
      { api_key: 'saved-key' },
    );

    expect(authConfig).toEqual({
      api_key: 'new-key',
      request_protocol: 'anthropic_messages',
    });
  });
});
