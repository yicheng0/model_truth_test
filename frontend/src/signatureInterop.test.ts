import { describe, expect, it } from 'vitest';
import { findRecommendedSignaturePair, isReverseSignaturePair, signatureModelComparisonKey, signatureModelsComparable, signatureResultMessage } from './signatureInterop';

describe('signature interop model selection', () => {
  it('normalizes effort suffixes like the backend', () => {
    expect(signatureModelComparisonKey('claude-opus-4-7-high')).toBe('claude-opus-4-7');
  });

  it('selects a candidate source and a same-model official relay for the recommended pair', () => {
    const channels = [
      { id: 'official-opus', model_name: 'claude-opus-4-7', is_reference: true },
      { id: 'official-sonnet', model_name: 'claude-sonnet-4-6', is_reference: true },
      { id: 'candidate-sonnet', model_name: 'claude-sonnet-4-6', is_reference: false },
      { id: 'candidate-opus', model_name: 'claude-opus-4-7', is_reference: false },
    ];
    expect(findRecommendedSignaturePair(channels)).toEqual({
      source: channels[2],
      relay: channels[1],
    });
  });

  it('falls back to an official relay when no same-model reference exists', () => {
    const channels = [
      { id: 'official-opus', model_name: 'claude-opus-4-7', is_reference: true },
      { id: 'candidate-sonnet', model_name: 'claude-sonnet-4-6', is_reference: false },
    ];
    expect(findRecommendedSignaturePair(channels)).toEqual({
      source: channels[1],
      relay: channels[0],
    });
  });

  it('flags the old official-source candidate-relay direction as reversed', () => {
    expect(isReverseSignaturePair(
      { id: 'official', is_reference: true },
      { id: 'candidate', is_reference: false },
    )).toBe(true);
    expect(isReverseSignaturePair(
      { id: 'candidate', is_reference: false },
      { id: 'official', is_reference: true },
    )).toBe(false);
  });

  it('recognizes mismatched models before submitting', () => {
    expect(signatureModelsComparable(
      { id: 'source', model_name: 'claude-sonnet-4-6' },
      { id: 'relay', model_name: 'claude-opus-4-7' },
    )).toBe(false);
  });

  it('shows operational or unexecuted signature checks as inconclusive', () => {
    expect(signatureResultMessage({ ok: false, signature_ok: null, status: 'fail' })).toBe('[无法判定] Signature 未完成验证');
  });
});
