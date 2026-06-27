import { describe, expect, it } from 'vitest';
import {
  accountTypeLabel,
  buildChannelAuthConfig,
  buildRuntimeCredentials,
  buildTokenflowApiKey,
  buildTokenflowChannelId,
  formatChannelDisplayName,
  hasStoredApiKey,
  inferChannelAccountType,
  inferChannelNumber,
  isValidChannelNumber,
  normalizeChannelNickname,
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
      api_key: 'saved-key',
      account_type: 'reverse',
      region: 'us-east-1',
      request_protocol: 'openai_chat_completions',
    });
  });

  it('keeps a redacted stored API key placeholder when editing other channel fields', () => {
    const authConfig = buildChannelAuthConfig(
      { api_key: '', channel_number: '9333', account_type: 'aws', request_protocol: 'auto' },
      { api_key: 'sec...key [REDACTED] len=16', region: 'us-east-1' },
    );

    expect(authConfig).toEqual({
      api_key: 'sec...key [REDACTED] len=16',
      account_type: 'aws',
      region: 'us-east-1',
      request_protocol: 'auto',
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

  it('stores account type without auto-generating API keys from channel numbers', () => {
    const authConfig = buildChannelAuthConfig(
      { channel_number: '9333', account_type: 'aws', request_protocol: 'aws_bedrock' },
      {},
    );

    expect(authConfig).toEqual({
      account_type: 'aws',
      request_protocol: 'aws_bedrock',
    });
  });

  it('stores explicit API keys and maps account type to the internal provider type', () => {
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
    expect(accountTypeLabel('kiro.claudecode')).toBe('Kiro Claude Code');
    expect(providerTypeForAccountType('aws')).toBe('aws_bedrock');
    expect(providerTypeForAccountType('kiro.claudecode')).toBe('kiro_claudecode');
    expect(providerTypeForAccountType('claude')).toBe('anthropic');
    expect(providerTypeForAccountType('vertex')).toBe('vertex_ai');
  });

  it('builds tokenflow channel ids and API keys from the channel number', () => {
    expect(buildTokenflowChannelId(' 9333 ', 'aws')).toBe('9333-tokenflow-aws');
    expect(buildTokenflowChannelId('9333', 'kiro.claudecode')).toBe('9333-tokenflow-kiro-claudecode');
    expect(buildTokenflowChannelId('9333', 'claude_code')).toBe('9333-tokenflow-claude-code');
    expect(buildTokenflowApiKey(' 9333 ')).toBe('sk--9333');
    expect(parseTokenflowChannelNumber('9333-tokenflow-aws')).toBe('9333');
    expect(isValidChannelNumber('9333_ab-c')).toBe(true);
    expect(isValidChannelNumber('9333 token')).toBe(false);
  });

  it('formats the channel display name from configured fields', () => {
    expect(
      formatChannelDisplayName({
        id: '8678-tokenflow-aws',
        name: '鬼手',
        auth_config: { account_type: 'aws' },
      }),
    ).toBe('鬼手');
    expect(formatChannelDisplayName({ name: '鬼手', account_type: 'aws' })).toBe('鬼手');
    expect(formatChannelDisplayName({ name: '1', account_type: 'reverse' })).toBe('1');
    expect(formatChannelDisplayName({ name: '9333-鬼手', account_type: 'aws' })).toBe('9333-鬼手');
    expect(formatChannelDisplayName(null, 'legacy_channel')).toBe('legacy_channel');
  });

  it('uses the explicit channel name as the display name', () => {
    expect(
      formatChannelDisplayName({
        id: '9029-tokenflow-aws',
        name: '风雨',
        auth_config: { account_type: 'aws' },
      }),
    ).toBe('风雨');
    expect(
      formatChannelDisplayName({
        id: '9029-tokenflow-aws',
        name: '9029-风雨-aws',
        auth_config: { account_type: 'aws' },
      }),
    ).toBe('9029-风雨-aws');
    expect(
      formatChannelDisplayName({
        id: 'ch_312aeef14fd0',
        name: '9335-阿宝-claude-aws-relay',
      }),
    ).toBe('9335-阿宝-claude-aws-relay');
  });

  it('extracts clean channel form values from legacy display names', () => {
    const legacy = { id: 'ch_312aeef14fd0', name: '9335-阿宝-claude-aws-relay' };

    expect(inferChannelNumber(legacy)).toBe('9335');
    expect(inferChannelAccountType(legacy)).toBe('aws');
    expect(normalizeChannelNickname(legacy)).toBe('9335-阿宝-claude-aws-relay');
    expect(normalizeChannelNickname({ name: '8559-风雨-aws', channel_number: '8559', account_type: 'aws' })).toBe('8559-风雨-aws');
  });
});
