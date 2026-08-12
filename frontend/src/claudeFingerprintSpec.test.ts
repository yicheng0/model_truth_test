import { describe, expect, it } from 'vitest';
import { CLAUDE_ACCESS_PATHS, CLAUDE_CHANNEL_DIFFERENCES, CLAUDE_CLIENT_FINGERPRINT_META, CLAUDE_EVIDENCE_TIERS, CLAUDE_RESOURCE_IDENTITY_META, UPSTREAM_INTEGRITY_META } from './claudeFingerprintSpec';

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
      'anthropic_endpoint_configured',
      'claude_code_gateway_like',
      'translated_gateway',
      'transparent_unresolved',
    ]);
    expect(CLAUDE_ACCESS_PATHS.find((item) => item.key === 'transparent_unresolved')?.description).toContain('无法区分');
  });

  it('documents all upstream integrity outcomes without claiming official origin', () => {
    expect(Object.keys(UPSTREAM_INTEGRITY_META)).toEqual([
      'signature_chain_verified',
      'mixed_routing_suspected',
      'protocol_reconstruction_suspected',
      'model_swap_suspected',
      'insufficient_evidence',
      'operationally_inconclusive',
    ]);
    expect(UPSTREAM_INTEGRITY_META.signature_chain_verified.description).toContain('不等于官方直连');
  });

  it('separates resource identity from Claude Code gateway compatibility', () => {
    expect(CLAUDE_RESOURCE_IDENTITY_META.gateway_credential_configured.description).toContain('仍未解析');
    expect(CLAUDE_RESOURCE_IDENTITY_META.claude_code_oauth_confirmed.description).toContain('不代表远程渠道');
  });

  it('labels passive client fingerprints without implying origin verification', () => {
    expect(CLAUDE_CLIENT_FINGERPRINT_META.claude_code_like.label).toContain('Claude Code');
    expect(CLAUDE_CLIENT_FINGERPRINT_META.unobservable.label).toContain('未捕获');
  });
});
