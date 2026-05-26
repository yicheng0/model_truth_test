import { describe, expect, it } from 'vitest';
import { extractPatrolEvidence, formatPatrolChannel, patrolProbeStatusColor, patrolProbeStatusText, splitRunsByPatrol } from './runsUtils';
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
          summary: '自动巡检完成',
          evidence: {
            test_scope: 'scheduled_probe',
            labels: ['signature_interop_failed'],
            label_explanations: [{ label: 'signature_interop_failed', description: 'Signature 互通失败。' }],
            detected_provider_hint: '疑似逆向或中间层改写',
            model_requests: [
              {
                key: 'thinking_temperature',
                title: 'Thinking temperature 冲突',
                channel_id: 'ch_1',
                channel_name: 'Relay Channel',
                result_id: 'res_1',
                message_id: 'msg_01abc',
                request_id: 'req_evidence_1',
                message_channel_type: 'Claude/Anthropic',
                request_protocol: 'anthropic_messages',
                provider_endpoint: 'https://example.test/v1/messages',
                completed_at: '2026-05-16T01:02:03Z',
                labels: [],
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
              },
            ],
            signature_interop: {
              status: 'fail',
              reason: 'relay 未接受 signature',
              created_at: '2026-05-16T01:02:04Z',
              completed_at: '2026-05-16T01:02:05Z',
              source_channel_id: 'source_1',
              source_channel_name: 'AWS Bedrock Claude',
              source_message_id: 'msg_source',
              source_request_id: 'req_source',
              source_message_channel_type: 'AWS Bedrock',
              relay_channel_id: 'ch_1',
              relay_channel_name: 'Relay Channel',
              relay_message_id: 'msg_relay',
              relay_request_id: 'req_relay',
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
      channelId: 'ch_1',
      channelName: 'Relay Channel',
      resultId: 'res_1',
      messageId: 'msg_01abc',
      requestId: 'req_evidence_1',
      completedAt: '2026-05-16T01:02:03Z',
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
      sourceChannelName: 'AWS Bedrock Claude',
      completedAt: '2026-05-16T01:02:05Z',
      sourceMessageId: 'msg_source',
      sourceRequestId: 'req_source',
      relayChannelName: 'Relay Channel',
      relayMessageId: 'msg_relay',
      relayRequestId: 'req_relay',
      signaturePrefixes: ['sig-abc'],
    });
  });

  it('prefers a requested patrol report when multiple reports exist', () => {
    const results: RunResults = {
      run: run('patrol_1', 'sched_1'),
      run_channels: [],
      results: [],
      comparisons: [],
      baseline_results: [],
      reports: [
        {
          id: 'rep_other',
          run_id: 'patrol_1',
          channel_id: 'channel_other',
          final_score: 100,
          grade: 'A',
          evidence: {
            test_scope: 'scheduled_probe',
            model_requests: [{ key: 'other', title: 'Other', result_id: 'res_other' }],
          },
        },
        {
          id: 'rep_target',
          run_id: 'patrol_1',
          channel_id: 'channel_target',
          final_score: 50,
          grade: 'D',
          evidence: {
            test_scope: 'scheduled_probe',
            model_requests: [{ key: 'target', title: 'Target', result_id: 'res_target' }],
          },
        },
      ],
    };

    const evidence = extractPatrolEvidence(results, 'rep_target');

    expect(evidence?.reportId).toBe('rep_target');
    expect(evidence?.modelRequests[0].resultId).toBe('res_target');
  });

  it('attaches saved result response text to patrol model request evidence', () => {
    const results: RunResults = {
      run: run('patrol_1', 'sched_1'),
      run_channels: [],
      comparisons: [],
      baseline_results: [],
      results: [
        {
          id: 'res_1',
          run_id: 'patrol_1',
          test_case_id: 'case_1',
          channel_id: 'ch_1',
          attempt_index: 1,
          normalized_response: { content_text: '真实响应正文' },
          raw_request: {},
          raw_response: { content: [{ type: 'text', text: '真实响应正文' }], _response_metadata: { request_id: 'req_from_header' } },
          metrics: {},
          score: 100,
          labels: [],
          created_at: '2026-05-16T02:03:04Z',
        },
        {
          id: 'res_2',
          run_id: 'patrol_1',
          test_case_id: 'case_2',
          channel_id: 'ch_1',
          attempt_index: 1,
          normalized_response: { error: '上游返回参数错误' },
          raw_request: {},
          raw_response: { error: { message: 'raw error', request_id: 'req_from_error' } },
          metrics: {},
          score: 40,
          labels: ['web_search_not_rejected'],
          created_at: '2026-05-16T02:04:05Z',
        },
      ],
      reports: [
        {
          id: 'rep_1',
          run_id: 'patrol_1',
          channel_id: 'ch_1',
          final_score: 40,
          grade: 'E',
          evidence: {
            test_scope: 'scheduled_probe',
            labels: ['web_search_not_rejected'],
            model_requests: [
              { key: 'thinking_temperature', result_id: 'res_1', labels: [] },
              { key: 'web_search', result_id: 'res_2', labels: ['web_search_not_rejected'] },
            ],
          },
        },
      ],
    };

    const evidence = extractPatrolEvidence(results);

    expect(evidence?.modelRequests[0]).toMatchObject({
      resultId: 'res_1',
      responseText: '真实响应正文',
      requestId: 'req_from_header',
      completedAt: '2026-05-16T02:03:04Z',
    });
    expect(evidence?.modelRequests[1]).toMatchObject({
      resultId: 'res_2',
      responseText: '上游返回参数错误',
      requestId: 'req_from_error',
      completedAt: '2026-05-16T02:04:05Z',
    });
    expect(evidence?.modelRequests[1].rawResponseText).toContain('raw error');
  });

  it('treats patrol request state as response and error evidence only', () => {
    const results: RunResults = {
      run: run('patrol_1', 'sched_1'),
      run_channels: [],
      comparisons: [],
      baseline_results: [],
      results: [
        {
          id: 'res_ok',
          run_id: 'patrol_1',
          test_case_id: 'case_ok',
          channel_id: 'ch_1',
          attempt_index: 1,
          normalized_response: { content_text: 'OK' },
          raw_request: {},
          raw_response: { content: [{ type: 'text', text: 'OK' }] },
          metrics: {},
          score: 100,
          labels: [],
        },
        {
          id: 'res_err',
          run_id: 'patrol_1',
          test_case_id: 'case_err',
          channel_id: 'ch_1',
          attempt_index: 1,
          normalized_response: { error: '请求失败' },
          raw_request: {},
          raw_response: { error: 'raw error' },
          metrics: {},
          score: 0,
          labels: ['request_failed'],
        },
      ],
      reports: [
        {
          id: 'rep_1',
          run_id: 'patrol_1',
          channel_id: 'ch_1',
          final_score: 0,
          grade: 'E',
          summary: '自动巡检完成',
          evidence: {
            test_scope: 'scheduled_probe',
            labels: ['request_failed'],
            label_explanations: [{ label: 'request_failed', description: '请求失败。' }],
            model_requests: [
              { key: 'thinking_temperature', result_id: 'res_ok', labels: [] },
              { key: 'web_search', result_id: 'res_err', labels: ['request_failed'], error: '请求失败' },
            ],
          },
        },
      ],
    };

    const evidence = extractPatrolEvidence(results);

    expect(evidence?.modelRequests[0]).toMatchObject({
      resultId: 'res_ok',
      responseText: 'OK',
      status: 'ok',
    });
    expect(evidence?.modelRequests[1]).toMatchObject({
      resultId: 'res_err',
      responseText: '请求失败',
      error: '请求失败',
      status: 'error',
    });
    expect(evidence?.signature).toBeNull();
  });

  it('keeps patrol evidence usable without score-heavy rendering', () => {
    const results: RunResults = {
      run: run('patrol_2', 'sched_2'),
      run_channels: [],
      comparisons: [],
      baseline_results: [],
      results: [],
      reports: [
        {
          id: 'rep_2',
          run_id: 'patrol_2',
          channel_id: 'ch_2',
          final_score: 92,
          grade: 'A',
          summary: '自动巡检完成',
          evidence: {
            test_scope: 'scheduled_probe',
            labels: ['patrol_probe_passed'],
            label_explanations: [{ label: 'patrol_probe_passed', description: '巡检通过。' }],
            detected_provider_hint: '疑似 Claude/Anthropic',
            model_requests: [
              {
                key: 'thinking_temperature',
                title: 'Thinking temperature 冲突',
                channel_id: 'ch_2',
                channel_name: 'Patrol Channel',
                result_id: 'res_1',
                message_id: 'msg_1',
                message_channel_type: 'Claude/Anthropic',
                request_protocol: 'anthropic_messages',
                provider_endpoint: 'https://example.test/v1/messages',
                labels: [],
                error: null,
              },
            ],
          },
        },
      ],
    };

    const evidence = extractPatrolEvidence(results);

    expect(evidence?.modelRequests[0]).toMatchObject({
      title: 'Thinking temperature 冲突',
      status: 'ok',
      resultId: 'res_1',
      messageId: 'msg_1',
      channelName: 'Patrol Channel',
    });
    expect(evidence?.labels).toEqual(['patrol_probe_passed']);
    expect(evidence?.detectedProviderHint).toBe('疑似 Claude/Anthropic');
  });

  it('formats patrol channels with channel id, name and account type', () => {
    const evidence = extractPatrolEvidence({
      run: run('patrol_3', 'sched_3'),
      run_channels: [],
      results: [],
      comparisons: [],
      baseline_results: [],
      reports: [
        {
          id: 'rep_3',
          run_id: 'patrol_3',
          channel_id: 'ch_3',
          final_score: 90,
          grade: 'A',
          evidence: {
            test_scope: 'scheduled_probe',
            model_requests: [
              {
                key: 'thinking_temperature',
                channel_id: '8890',
                channel_name: '鬼手',
                channel_account_type: 'aws',
                channel_provider_type: 'aws_bedrock',
                result_id: 'res_1',
              },
            ],
            signature_interop: {
              source_channel_id: '8890',
              source_channel_name: '鬼手',
              source_channel_account_type: 'aws',
              source_channel_provider_type: 'aws_bedrock',
              relay_channel_id: '8890',
              relay_channel_name: '鬼手',
              relay_channel_account_type: 'aws',
              relay_channel_provider_type: 'aws_bedrock',
            },
          },
        },
      ],
    });

    expect(evidence?.modelRequests[0].channelAccountType).toBe('aws');
    expect(formatPatrolChannel({ id: '8890-tokenflow-aws', name: '鬼手', accountType: 'aws' }, '8890-tokenflow-aws')).toBe('8890-鬼手-aws');
  });

  it('classifies native rejection probe status as parameter unsupported', () => {
    expect(
      patrolProbeStatusText({
        status: 'error',
        labels: ['provider_error_variant'],
        error: "Client error '400 Bad Request' for url 'https://api.example.com/v1/messages'",
      }),
    ).toBe('参数不支持');
    expect(
      patrolProbeStatusColor({
        status: 'error',
        labels: ['provider_error_variant'],
        error: "Client error '400 Bad Request' for url 'https://api.example.com/v1/messages'",
      }),
    ).toBe('gold');
  });
});
