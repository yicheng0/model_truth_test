import { describe, expect, it } from 'vitest';
import { CLAUDE_ACCESS_PATHS, CLAUDE_CHANNEL_DIFFERENCES, CLAUDE_EVIDENCE_TIERS } from './claudeFingerprintSpec';

describe('claudeFingerprintSpec', () => {
  it('separates provenance from protocol compatibility and weak behavior signals', () => {
    expect(CLAUDE_EVIDENCE_TIERS.map((item) => item.key)).toEqual([
      'provenance',
      'continuity',
      'protocol',
      'behavior',
    ]);
    expect(CLAUDE_EVIDENCE_TIERS.find((item) => item.key === 'protocol')?.caveat).toContain('可仿造');
    expect(CLAUDE_EVIDENCE_TIERS.find((item) => item.key === 'behavior')?.weight).toBe('低');
  });

  it('documents direct, official cloud, gateway, and non-Claude channel differences', () => {
    expect(CLAUDE_CHANNEL_DIFFERENCES.map((item) => item.key)).toEqual([
      'anthropic_direct',
      'official_cloud',
      'gateway_or_reverse',
      'non_claude',
    ]);
    expect(CLAUDE_CHANNEL_DIFFERENCES.find((item) => item.key === 'gateway_or_reverse')?.conclusion).toContain('不能证明官方直连');
    expect(CLAUDE_CHANNEL_DIFFERENCES.find((item) => item.key === 'official_cloud')?.expected).toContain('合法差异');
  });

  it('keeps transparent Claude Code forwarding unresolved', () => {
    expect(CLAUDE_ACCESS_PATHS.map((item) => item.key)).toEqual([
      'anthropic_api_direct',
      'claude_code_gateway_like',
      'translated_gateway',
      'transparent_unresolved',
    ]);
    expect(CLAUDE_ACCESS_PATHS.find((item) => item.key === 'transparent_unresolved')?.description).toContain('无法区分');
  });
});
