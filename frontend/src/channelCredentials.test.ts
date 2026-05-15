import { describe, expect, it } from 'vitest';
import {
  accountTypeLabel,
  buildChannelAuthConfig,
  buildRuntimeCredentials,
  buildTokenflowApiKey,
  buildTokenflowChannelId,
  hasStoredApiKey,
  isValidChannelNumber,
  parseTokenflowChannelNumber,
  providerTypeForAccountType,
} from './channelCredentials';
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
      { api_key: '   ', channel_number: '9333', request_protocol: 'openai_chat_completions' },
      { api_key: 'saved-key', region: 'us-east-1', request_protocol: 'auto' },
    );

    expect(authConfig).toEqual({
      api_key: 'sk--9333',
      account_type: 'reverse',
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
      account_type: 'reverse',
      request_protocol: 'anthropic_messages',
    });
  });

  it('stores account type and maps it to the internal provider type', () => {
    const authConfig = buildChannelAuthConfig(
      { api_key: 'aws-key', account_type: 'aws', request_protocol: 'aws_bedrock' },
      {},
    );

    expect(authConfig).toEqual({
      api_key: 'aws-key',
      account_type: 'aws',
      request_protocol: 'aws_bedrock',
    });
    expect(accountTypeLabel('vertex')).toBe('Vertex');
    expect(providerTypeForAccountType('aws')).toBe('aws_bedrock');
    expect(providerTypeForAccountType('claude')).toBe('anthropic');
    expect(providerTypeForAccountType('vertex')).toBe('vertex_ai');
  });

  it('builds tokenflow channel ids and API keys from the channel number', () => {
    expect(buildTokenflowChannelId(' 9333 ', 'aws')).toBe('9333-tokenflow-aws');
    expect(buildTokenflowChannelId('9333', 'claude_code')).toBe('9333-tokenflow-claude-code');
    expect(buildTokenflowApiKey(' 9333 ')).toBe('sk--9333');
    expect(parseTokenflowChannelNumber('9333-tokenflow-aws')).toBe('9333');
    expect(isValidChannelNumber('9333_ab-c')).toBe(true);
    expect(isValidChannelNumber('9333 token')).toBe(false);
  });
});
