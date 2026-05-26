import { describe, expect, it } from 'vitest';
import { buildPatrolRunDetailLink } from './patrolNavigation';
import type { ChannelAlert } from './types';

function alert(overrides: Partial<ChannelAlert> = {}): ChannelAlert {
  return {
    id: 'alert_1',
    run_id: 'run_1',
    report_id: 'rep_1',
    channel_id: 'channel_1',
    status: 'pending_review',
    severity: 'high',
    grade: 'D',
    final_score: 62,
    notification_status: 'pending',
    evidence_summary: {},
    ...overrides,
  };
}

describe('patrol navigation helpers', () => {
  it('links model request alerts to the focused result row', () => {
    expect(
      buildPatrolRunDetailLink(alert({
        evidence_summary: {
          model_requests: [
            { title: 'ok probe', result_id: 'res_ok' },
            { title: 'failing probe', result_id: 'res_fail', error: 'bad' },
          ],
        },
      })),
    ).toBe('/runs/run_1?focus=patrol&reportId=rep_1&resultId=res_fail');
  });

  it('falls back to the signature section when no model request result exists', () => {
    expect(
      buildPatrolRunDetailLink(alert({
        evidence_summary: {
          signature_reason: 'signature failed',
          signature_relay_message_id: 'msg_relay',
        },
      })),
    ).toBe('/runs/run_1?focus=patrol&reportId=rep_1&section=signature');
  });
});
