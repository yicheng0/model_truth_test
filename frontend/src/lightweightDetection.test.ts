import { describe, expect, it } from 'vitest';
import { buildLightweightChecks, sanitizeDetectionHistory } from './lightweightDetection';
import type { ClaudeCodeTestResult } from './types';

function result(probes: ClaudeCodeTestResult['probes']): ClaudeCodeTestResult {
  return {
    ok: true,
    score: 88,
    risk_level: 'medium',
    summary: '本轮整体一致',
    probes,
    sections: [],
  };
}

function probe(key: string, status: string, reason = 'evidence') {
  return { key, title: key, category: 'structure', status, severity: 'medium', score: status === 'pass' ? 100 : 0, labels: [], reason };
}

describe('buildLightweightChecks', () => {
  it('maps detailed evidence into a stable lightweight checklist', () => {
    const checks = buildLightweightChecks(result([
      probe('basic_echo', 'pass'),
      probe('response_schema', 'pass'),
      probe('usage_tokens', 'pass'),
      probe('identity_direct', 'pass'),
      probe('stream_lifecycle', 'pass'),
      probe('context_ladder', 'pass'),
      probe('strict_json_schema', 'warning', 'JSON schema was rewritten'),
    ]));

    expect(checks.map((item) => item.key)).toEqual([
      'connectivity', 'protocol', 'message_id', 'model_identity', 'thinking_signature',
      'tool_use', 'structured_output', 'streaming', 'context', 'capability',
    ]);
    expect(checks.find((item) => item.key === 'structured_output')?.status).toBe('warning');
    expect(checks.find((item) => item.key === 'message_id')?.status).toBe('passed');
    expect(checks.find((item) => item.key === 'protocol')?.probeKeys).toEqual(['response_schema', 'usage_tokens']);
    expect(checks.find((item) => item.key === 'model_identity')?.status).toBe('passed');
    expect(checks.find((item) => item.key === 'context')?.status).toBe('passed');
  });

  it('does not turn unsupported optional capabilities into authenticity failures', () => {
    const checks = buildLightweightChecks(result([
      probe('document_input', 'skipped', '当前渠道不支持文档输入'),
      probe('thinking_signature', 'skipped', '当前模型未开放 thinking'),
    ]));

    expect(checks.find((item) => item.key === 'thinking_signature')?.status).toBe('unavailable');
    expect(checks.every((item) => item.status !== 'failed')).toBe(true);
  });

  it('downgrades optional capability failures to warnings', () => {
    const checks = buildLightweightChecks(result([
      probe('thinking_signature', 'fail', '当前端点不支持 thinking'),
      probe('image_base64', 'fail', '当前端点不支持图片'),
      probe('document_input', 'fail', '当前端点不支持文档'),
    ]));

    expect(checks.find((item) => item.key === 'thinking_signature')?.status).toBe('warning');
    expect(checks.find((item) => item.key === 'capability')?.status).toBe('warning');
  });
});

describe('sanitizeDetectionHistory', () => {
  it('keeps only safe display fields and never credentials', () => {
    const history = sanitizeDetectionHistory({
      id: 'job_1', baseUrl: 'https://relay.example/v1', model: 'claude-sonnet-4-5',
      apiKey: 'sk-secret', score: 91, status: 'passed', createdAt: '2026-07-22T00:00:00Z',
    });
    expect(history).toEqual({
      id: 'job_1', endpointHost: 'relay.example', model: 'claude-sonnet-4-5',
      score: 91, status: 'passed', createdAt: '2026-07-22T00:00:00Z',
    });
    expect(JSON.stringify(history)).not.toContain('sk-secret');
  });
});
