import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import type { ClaudeCodeHistoryItem } from './types';
import { groupClaudeFingerprintHistory, localDayRangeIso, probeDiagnosticText } from './claudeFingerprintHistory';

function historyItem(
  id: string,
  createdAt: string,
  failCount: number,
  warningCount: number,
  probeCount = 6,
): ClaudeCodeHistoryItem {
  return {
    id,
    channel_label: `channel-${id}`,
    base_url: `https://${id}.example`,
    model_name: 'claude-sonnet-4-5',
    provider_type: 'anthropic',
    score: 90,
    risk_level: 'low',
    ok: failCount === 0,
    probe_count: probeCount,
    fail_count: failCount,
    warning_count: warningCount,
    created_at: createdAt,
  };
}

describe('claudeFingerprintHistory', () => {
  it('groups history by local day with probe totals', () => {
    const groups = groupClaudeFingerprintHistory([
      historyItem('a', '2026-07-13T01:00:00', 1, 2),
      historyItem('b', '2026-07-13T20:00:00', 0, 1),
      historyItem('c', '2026-07-12T12:00:00', 2, 0),
    ]);

    expect(groups[0]).toMatchObject({ date: '2026-07-13', runCount: 2, failCount: 1, warningCount: 3, passCount: 8 });
    expect(groups[1]).toMatchObject({ date: '2026-07-12', runCount: 1, failCount: 2, warningCount: 0, passCount: 4 });
  });

  it('converts local day bounds to ISO filters and supports all history', () => {
    const filters = localDayRangeIso([dayjs('2026-07-13T10:30:00'), dayjs('2026-07-14T12:00:00')]);
    expect(dayjs(filters.from).isSame(dayjs('2026-07-13').startOf('day'))).toBe(true);
    expect(dayjs(filters.to).isSame(dayjs('2026-07-14').endOf('day'))).toBe(true);
    expect(localDayRangeIso(null)).toEqual({});
  });

  it('counts skipped probes separately when structured history is available', () => {
    const item = historyItem('structured', '2026-07-13T10:00:00', 0, 1, 3);
    item.result_payload = {
      ok: true,
      score: 90,
      risk_level: 'low',
      summary: 'structured',
      probes: [
        { key: 'pass', title: 'Pass', category: 'behavior', status: 'pass', severity: 'weak', score: 100, labels: [] },
        { key: 'warning', title: 'Warning', category: 'behavior', status: 'warning', severity: 'weak', score: 50, labels: [] },
        { key: 'skipped', title: 'Skipped', category: 'web_capability', status: 'skipped', severity: 'reference', score: 0, labels: [] },
      ],
      sections: [],
    };

    expect(groupClaudeFingerprintHistory([item])[0]).toMatchObject({ passCount: 1, failCount: 0, warningCount: 1, skippedCount: 1 });
  });

  it('uses structured reason and falls back to legacy evidence', () => {
    expect(probeDiagnosticText({ status: 'warning', reason: '具体判定原因', evidence_excerpt: '旧摘要' })).toBe('具体判定原因');
    expect(probeDiagnosticText({ status: 'warning', labels: [], evidence_excerpt: 'legacy warning' })).toBe('legacy warning');
  });

  it('replaces legacy generic warnings with the mapped label explanation', () => {
    const text = probeDiagnosticText({
      status: 'warning',
      labels: ['thinking_signature_missing'],
      reason: '检测项返回异常，需要结合原始响应复核。',
    });

    expect(text).toContain('观测：');
    expect(text).toContain('影响：');
    expect(text).toContain('复核：');
  });
});
