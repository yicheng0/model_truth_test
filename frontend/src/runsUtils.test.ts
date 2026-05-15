import { describe, expect, it } from 'vitest';
import { extractPatrolEvidence, splitRunsByPatrol } from './runsUtils';
import type { Run, RunResults } from './types';

function run(id: string, scheduledTestId?: string | null): Run {
  return {
    id,
    suite_id: 'suite_1',
    name: id,
    mode: 'full_comparison',
    test_scope: scheduledTestId ? 'scheduled_probe' : 'full',
    scheduled_test_id: scheduledTestId,
    status: 'completed',
    repeat_count: 1,
    concurrency: 1,
    total_jobs: 1,
    completed_jobs: 1,
  };
}

describe('runs utilities', () => {
  it('splits scheduled patrol runs out of the normal task list', () => {
    const { normalRuns, patrolRuns } = splitRunsByPatrol([
      run('manual_1'),
      run('patrol_1', 'sched_1'),
      run('manual_2', null),
      run('patrol_2', 'sched_2'),
    ]);

    expect(normalRuns.map((item) => item.id)).toEqual(['manual_1', 'manual_2']);
    expect(patrolRuns.map((item) => item.id)).toEqual(['patrol_1', 'patrol_2']);
  });

  it('extracts patrol report evidence from run results', () => {
    const results: RunResults = {
      run: run('patrol_1', 'sched_1'),
      run_channels: [],
      results: [],
      comparisons: [],
      baseline_results: [],
      reports: [
        {
          id: 'rep_1',
          run_id: 'patrol_1',
          channel_id: 'ch_1',
          final_score: 78,
          grade: 'C',
          summary: '自动巡检双探针完成',
          evidence: {
            test_scope: 'scheduled_probe',
            labels: ['signature_interop_failed'],
            label_explanations: { signature_interop_failed: 'Signature 互通失败。' },
            detected_provider_hint: '疑似逆向或中间层改写',
            model_requests: [
              {
                key: 'thinking_temperature',
                title: 'Thinking temperature 冲突',
                result_id: 'res_1',
                message_id: 'msg_01abc',
                message_channel_type: 'Claude/Anthropic',
                request_protocol: 'anthropic_messages',
                provider_endpoint: 'https://example.test/v1/messages',
                labels: [],
                score: 100,
              },
              {
                key: 'web_search',
                title: 'Web Search tool',
                result_id: 'res_2',
                message_id: 'msg_01search',
                message_channel_type: 'Claude/Anthropic',
                request_protocol: 'anthropic_messages',
                provider_endpoint: 'https://example.test/v1/messages',
                labels: ['web_search_not_rejected'],
                score: 40,
              },
              {
                key: 'thinking_adaptive_enabled',
                title: 'thinking.adaptive.enabled',
                result_id: 'res_3',
                message_id: 'msg_01adaptive',
                message_channel_type: 'Claude/Anthropic',
                request_protocol: 'anthropic_messages',
                provider_endpoint: 'https://example.test/v1/messages',
                labels: [],
                score: 100,
              },
            ],
            signature_interop: {
              status: 'fail',
              reason: 'relay 未接受 signature',
              source_channel_id: 'source_1',
              source_message_id: 'msg_source',
              source_message_channel_type: 'AWS Bedrock',
              relay_channel_id: 'ch_1',
              relay_message_id: 'msg_relay',
              relay_message_channel_type: 'Claude/Anthropic',
              signature_prefixes: ['sig-abc'],
            },
          },
        },
      ],
    };

    const evidence = extractPatrolEvidence(results);

    expect(evidence?.reportId).toBe('rep_1');
    expect(evidence?.labels).toEqual(['signature_interop_failed']);
    expect(evidence?.detectedProviderHint).toBe('疑似逆向或中间层改写');
    expect(evidence?.modelRequests[0]).toMatchObject({
      title: 'Thinking temperature 冲突',
      resultId: 'res_1',
      messageId: 'msg_01abc',
      status: 'ok',
    });
    expect(evidence?.modelRequests.map((item) => item.key)).toEqual(['thinking_temperature', 'web_search', 'thinking_adaptive_enabled']);
    expect(evidence?.modelRequests[1]).toMatchObject({
      title: 'Web Search tool',
      resultId: 'res_2',
      messageId: 'msg_01search',
      status: 'error',
    });
    expect(evidence?.signature).toMatchObject({
      status: 'fail',
      sourceMessageId: 'msg_source',
      relayMessageId: 'msg_relay',
      signaturePrefixes: ['sig-abc'],
    });
  });
});
