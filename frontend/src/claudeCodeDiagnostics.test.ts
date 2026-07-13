import { describe, expect, it } from 'vitest';
import { labelDescription, labelText, probeDiagnosis, topRiskLabels } from './claudeCodeDiagnostics';

describe('claudeCodeDiagnostics', () => {
  it('translates known labels and keeps unknown labels readable', () => {
    expect(labelText('suspected_cache')).toBe('疑似缓存复用');
    expect(labelDescription('openai_shape_response')).toContain('Chat Completions');
    expect(labelText('unknown_label')).toBe('unknown_label');
    expect(labelDescription('json_missing:checks')).toContain('checks');
  });

  it('prioritizes high-risk probe diagnosis labels', () => {
    expect(
      probeDiagnosis({
        key: 'repeatability_nonce_pair',
        status: 'fail',
        labels: ['latency_outlier', 'suspected_cache', 'nonce_cross_talk'],
        evidence_excerpt: 'attempt1...',
      }),
    ).toContain('不同 nonce');

    expect(
      probeDiagnosis({
        key: 'response_schema',
        status: 'fail',
        labels: ['usage_missing', 'openai_shape_response'],
      }),
    ).toContain('Chat Completions');

    expect(
      probeDiagnosis({
        key: 'tool_use_shape',
        status: 'fail',
        labels: ['tool_use_invalid'],
      }),
    ).toContain('tool_use');
  });

  it('extracts top risk labels only from failed or warning probes', () => {
    const labels = topRiskLabels([
      { key: 'ok', status: 'pass', labels: ['suspected_cache'] },
      { key: 'reference', status: 'fail', severity: 'reference', labels: ['web_search_not_available'] },
      { key: 'shape', status: 'fail', labels: ['openai_shape_response', 'usage_missing'] },
      { key: 'nonce', status: 'warning', labels: ['suspected_cache'] },
      { key: 'queued', status: 'queued', labels: ['tool_use_invalid'] },
    ]);

    expect(labels).toEqual(['suspected_cache', 'openai_shape_response', 'usage_missing']);
  });

  it('keeps pass diagnosis concise while preserving evidence fallback', () => {
    expect(probeDiagnosis({ key: 'ok', status: 'pass', labels: [] })).toBe('测试通过，未发现该项异常。');
    expect(probeDiagnosis({ key: 'legacy', status: 'warning', labels: [], evidence_excerpt: 'legacy evidence' })).toBe('legacy evidence');
  });

  it('prioritizes backend reason and full upstream error before legacy evidence', () => {
    expect(
      probeDiagnosis({
        key: 'web_search_reference',
        status: 'warning',
        labels: ['web_search_tool_error'],
        reason: 'Web Search 工具返回错误：max_uses_exceeded',
        error_detail: 'upstream error',
        evidence_excerpt: 'legacy evidence',
      }),
    ).toBe('Web Search 工具返回错误：max_uses_exceeded');
    expect(
      probeDiagnosis({ key: 'request', status: 'warning', labels: [], error_detail: '完整上游错误', evidence_excerpt: 'legacy evidence' }),
    ).toBe('完整上游错误');
    expect(labelDescription('web_search_evidence_missing')).toContain('无法证明真实联网');
    expect(labelDescription('identity_uncertain')).toContain('未明确');
    expect(labelDescription('identity_mismatch')).toContain('其他厂商');
  });
});
