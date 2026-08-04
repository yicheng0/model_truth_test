import { describe, expect, it } from 'vitest';
import { findRecommendedSignatureRelay, signatureModelComparisonKey, signatureModelsComparable } from './signatureInterop';

describe('signature interop model selection', () => {
  it('normalizes effort suffixes like the backend', () => {
    expect(signatureModelComparisonKey('claude-opus-4-7-high')).toBe('claude-opus-4-7');
  });

  it('selects a same-model candidate for the recommended pair', () => {
    const source = { id: 'source', model_name: 'claude-sonnet-4-6', is_reference: true };
    const channels = [
      source,
      { id: 'opus-relay', model_name: 'claude-opus-4-7', is_reference: false },
      { id: 'sonnet-relay', model_name: 'claude-sonnet-4-6', is_reference: false },
    ];
    expect(findRecommendedSignatureRelay(channels, source)?.id).toBe('sonnet-relay');
  });

  it('recognizes mismatched models before submitting', () => {
    expect(signatureModelsComparable(
      { id: 'source', model_name: 'claude-sonnet-4-6' },
      { id: 'relay', model_name: 'claude-opus-4-7' },
    )).toBe(false);
  });
});
