import { describe, expect, it } from 'vitest';
import {
  claudeFingerprintAlertLevel,
  claudeFingerprintVerdicts,
  labelDescription,
  labelText,
  probeDiagnosis,
  topRiskLabels,
} from './claudeCodeDiagnostics';

describe('claudeCodeDiagnostics', () => {
  it('translates known labels and keeps unknown labels readable', () => {
    expect(labelText('suspected_cache')).toBe('疑似缓存复用');
    expect(labelDescription('openai_shape_response')).toContain('Chat Completions');
    expect(labelText('unknown_label')).toBe('unknown_label');
    expect(labelDescription('json_missing:checks')).toContain('checks');
    expect(labelDescription('upstream_error_rewrapped')).toContain('错误 envelope');
    expect(labelDescription('stream_buffered_by_gateway')).toContain('首事件');
    expect(labelDescription('gateway_model_alias_capability_mismatch')).toContain('alias');
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

  it('surfaces protocol, gateway contract, and origin as separate top-level verdicts', () => {
    const verdicts = claudeFingerprintVerdicts({
      classification_status: 'claude',
      classification_label: 'Claude 资源',
      upstream_integrity: {
        classification: 'protocol_reconstruction_suspected',
        confidence: 'high',
        official_origin_confirmed: false,
        gateway_contract: {
          status: 'warning',
          labels: ['upstream_error_rewrapped', 'stream_buffered_by_gateway'],
          interpretation: '检测到 Claude Code 网关契约改写或实时性异常。',
        },
      },
    });

    expect(verdicts.map((item) => item.key)).toEqual(['protocol', 'gateway_contract', 'official_origin']);
    expect(verdicts[0]).toMatchObject({ status: 'pass', label: 'Claude 资源' });
    expect(verdicts[1]).toMatchObject({ status: 'warning', label: '检测到网关改写' });
    expect(verdicts[1].detail).toContain('上游错误被重包');
    expect(verdicts[2]).toMatchObject({ status: 'insufficient_evidence', label: '官方来源未确认' });
  });

  it('does not treat legacy Claude Code status as OAuth resource evidence', () => {
    const verdicts = claudeFingerprintVerdicts({
      classification_status: 'claude_code',
      classification_label: 'ClaudeCode 链路',
      capability_flags: { is_claude_code_like: true, claude_code_gateway_compatible: false },
      resource_identity: {
        classification: 'insufficient_evidence',
        confidence: 'low',
        claude_code_oauth_confirmed: false,
        reason: '仅有远程响应证据',
      },
    });

    expect(verdicts.find((item) => item.key === 'official_origin')?.status).toBe('insufficient_evidence');
    expect(verdicts.some((item) => item.detail.includes('OAuth'))).toBe(true);
  });

  it('raises the primary result alert when a Claude-compatible channel has gateway warnings', () => {
    expect(
      claudeFingerprintAlertLevel({
        classification_status: 'claude_code',
        risk_level: 'low',
        upstream_integrity: {
          classification: 'insufficient_evidence',
          confidence: 'low',
          official_origin_confirmed: false,
          gateway_contract: { status: 'warning' },
        },
      }),
    ).toBe('warning');
  });
});
