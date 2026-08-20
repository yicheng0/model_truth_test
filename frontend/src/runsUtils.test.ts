import { describe, expect, it } from 'vitest';
import { ALL_PATROL_CHANNELS, UNKNOWN_PATROL_CHANNEL, buildChannelResultOverview, buildPatrolChannelFilterOptions, buildPatrolDeleteSummary, buildPatrolTopErrorSummary, clampPage, countedPatrolModelRequests, deletablePatrolRunIds, extractInvalidThinkingSignatureErrors, extractKiroIdentityLeaks, extractOverviewAnomalyLabels, extractPatrolEvidence, extractSignatureAnomalyRunIds, filterPatrolRunsByChannel, filterPatrolRunsByError, formatPatrolChannel, isPatrolOperationalFailure, paginateRuns, patrolEvidenceDisplayState, patrolInlineError, patrolProbeStatusColor, patrolProbeStatusText, patrolReportedLabels, patrolSignatureDisplayState, removeBulkDeletedRuns, resolvePatrolPage, selectableRunIds, splitRunsByPatrol } from './runsUtils';
import type { Channel, PatrolAnomalyGroup, PatrolAnomalySummary, ReportSummary, Run, RunResults } from './types';

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

function emptyAnomalies(): PatrolAnomalySummary {
  return {
    strict_total: 0,
    strict_items: [],
    kiro_identity_leak: { count: 0, items: [], truncated: false },
    invalid_thinking_signature: { count: 0, items: [], truncated: false },
  };
}

describe('runs utilities', () => {
  it('maps only server-provided strict Kiro and Signature anomalies', () => {
    const anomalies: PatrolAnomalySummary = {
      strict_total: 2,
      strict_items: [
        { kind: 'kiro_identity_leak', run_id: 'kiro_1', run_name: 'Kiro 任务', channel_id: 'ch_2', channel_name: '渠道二', created_at: '2026-08-10T08:00:00Z', request_ids: ['req-secret'] },
        { kind: 'invalid_thinking_signature', run_id: 'signature_1', run_name: 'Signature 任务', channel_id: 'ch_1', channel_name: '渠道一', created_at: '2026-08-11T08:00:00Z', request_ids: [], http_status: 400 },
      ],
      kiro_identity_leak: {
        count: 1,
        items: [{ run_id: 'kiro_1', run_name: 'Kiro 任务', channel_id: 'ch_2', channel_name: '渠道二', created_at: '2026-08-10T08:00:00Z', request_ids: [] }],
        truncated: false,
      },
      invalid_thinking_signature: {
        count: 1,
        items: [{ run_id: 'signature_1', run_name: 'Signature 任务', channel_id: 'ch_1', channel_name: '渠道一', created_at: '2026-08-11T08:00:00Z', request_ids: [], http_status: 400 }],
        truncated: false,
      },
    };

    const summary = buildPatrolTopErrorSummary(anomalies);

    expect(summary.items.map((item) => [item.runId, item.kind, item.priority])).toEqual([
      ['kiro_1', 'kiro_identity_leak', 1],
      ['signature_1', 'invalid_thinking_signature', 2],
    ]);
    expect(summary.total).toBe(2);
    expect(JSON.stringify(summary)).not.toMatch(/req-secret|request.?id|raw.?response|full.?text|error.?body/i);
  });

  it('defensively deduplicates strict entries and keeps the highest-priority Kiro type', () => {
    const anomalies: PatrolAnomalySummary = {
      strict_total: 1,
      strict_items: [
        { kind: 'kiro_identity_leak', run_id: 'duplicate_1', run_name: '重复任务', channel_id: 'ch_1', channel_name: '渠道一', created_at: '2026-08-12T08:00:00Z', request_ids: [] },
        { kind: 'invalid_thinking_signature', run_id: 'duplicate_1', run_name: '重复任务', channel_id: 'ch_1', channel_name: '渠道一', created_at: '2026-08-12T08:00:00Z', request_ids: [], http_status: 400 },
      ],
      kiro_identity_leak: { count: 1, items: [], truncated: false },
      invalid_thinking_signature: { count: 1, items: [], truncated: false },
    };

    const summary = buildPatrolTopErrorSummary(anomalies);

    expect(summary.items).toHaveLength(1);
    expect(summary.items[0]).toMatchObject({ runId: 'duplicate_1', kind: 'kiro_identity_leak', priority: 1 });
  });

  it('limits strict entries to ten while preserving the server strict total', () => {
    const anomalies: PatrolAnomalySummary = {
      ...emptyAnomalies(),
      strict_total: 17,
      strict_items: Array.from({ length: 12 }, (_, index) => ({
        kind: 'invalid_thinking_signature' as const,
        run_id: `signature_${index + 1}`,
        run_name: `Signature ${index + 1}`,
        request_ids: [],
      })),
    };

    const summary = buildPatrolTopErrorSummary(anomalies);

    expect(summary.total).toBe(17);
    expect(summary.items).toHaveLength(10);
  });

  it('keeps the requested patrol page while stale responses are in flight', () => {
    expect(resolvePatrolPage({ requestedPage: 6, responsePage: 1, total: 289, pageSize: 10, isFetching: true })).toBe(6);
    expect(resolvePatrolPage({ requestedPage: 6, responsePage: 1, total: 289, pageSize: 10, isFetching: false })).toBe(6);
    expect(resolvePatrolPage({ requestedPage: 6, responsePage: 6, total: 289, pageSize: 10, isFetching: false })).toBe(6);
    expect(resolvePatrolPage({ requestedPage: 6, responsePage: 6, total: 49, pageSize: 10, isFetching: false })).toBe(5);
    expect(resolvePatrolPage({ requestedPage: 6, responsePage: 6, total: 0, pageSize: 10, isFetching: false })).toBe(1);
  });
  it('extracts only explicit HTTP 400 invalid thinking signature errors', () => {
    const results = [
      {
        ...({ ...run('sig_1') }),
        upstream_request_id: 'req_1',
        normalized_response: { status_code: 400, error: 'Invalid `signature` in `thinking` block' },
      },
      {
        ...({ ...run('sig_2') }),
        raw_response: { status_code: 400, detail: 'INVALID `SIGNATURE` IN `THINKING` BLOCK', request_id: 'req_2' },
      },
      {
        ...({ ...run('sig_3') }),
        metrics: { http_status: 400 },
        normalized_response: { error: 'Invalid `signature` in `thinking` block' },
      },
      {
        ...({ ...run('not_400') }),
        upstream_request_id: 'req_3',
        normalized_response: { status_code: 422, error: 'Invalid `signature` in `thinking` block' },
      },
      {
        ...({ ...run('other_error') }),
        normalized_response: { status_code: 400, error: 'temperature is deprecated for this model' },
      },
    ] as unknown as RunResults['results'];

    expect(extractInvalidThinkingSignatureErrors(results)).toEqual({ requestIds: ['req_1', 'req_2'], count: 3 });
    expect(extractInvalidThinkingSignatureErrors([])).toBeNull();
  });

  it('does not invent request ids for signature errors without ids', () => {
    const results = [{
      ...run('sig_no_id'),
      normalized_response: { status_code: 400, error: 'Invalid `signature` in `thinking` block' },
    }] as unknown as RunResults['results'];

    expect(extractInvalidThinkingSignatureErrors(results)).toEqual({ requestIds: [], count: 1 });
  });

  it('extracts labeled and explicit Kiro identity self-reports', () => {
    const results = [
      {
        ...run('kiro_labeled'),
        labels: ['identity_mismatch', 'kiro_identity_leak'],
        upstream_request_id: 'req_labeled',
        normalized_response: { content_text: '你好，我是 Kiro' },
      },
      {
        ...run('kiro_cn_legacy'),
        raw_response: { content: [{ type: 'text', text: '你好，朋友，我是 Kiro，很高兴认识你。' }], request_id: 'req_cn' },
      },
      {
        ...run('kiro_en_legacy'),
        normalized_response: { content_text: "Hello, I'm Kiro, your coding assistant.", request_id: 'req_en' },
      },
      {
        ...run('kiro_en_duplicate'),
        normalized_response: { content_text: 'I am Kiro.', request_id: 'req_en' },
      },
    ] as unknown as RunResults['results'];

    expect(extractKiroIdentityLeaks(results)).toEqual({
      requestIds: ['req_labeled', 'req_cn', 'req_en'],
      count: 4,
    });
  });

  it('ignores Kiro mentions outside explicit response identity evidence', () => {
    const results = [
      {
        ...run('kiro_request_only'),
        raw_request: { messages: [{ role: 'user', content: '请问你是不是 Kiro？' }] },
        normalized_response: { content_text: '我是 Claude。' },
      },
      {
        ...run('kiro_discussion'),
        normalized_response: { content_text: 'Kiro 是一个开发工具，我可以介绍它。' },
      },
      {
        ...run('kiro_error'),
        normalized_response: { status_code: 400, error: 'Kiro channel configuration is invalid' },
      },
      {
        ...run('kiro_negated'),
        normalized_response: { content_text: '我不是 Kiro，我是 Claude。' },
      },
    ] as unknown as RunResults['results'];

    expect(extractKiroIdentityLeaks(results)).toBeNull();
    expect(extractKiroIdentityLeaks([])).toBeNull();
  });

  it('keeps only reverse-routing anomalies for the channel overview', () => {
    expect(extractOverviewAnomalyLabels(['patrol_probe_claude', 'kiro_identity_leak', 'signature_interop_failed', 'kiro_identity_leak'])).toEqual([
      'kiro_identity_leak',
      'signature_interop_failed',
    ]);
    expect(extractOverviewAnomalyLabels(['signature_chain_verified', 'patrol_probe_passed', 'operational_failure', 'provider_error_variant'])).toEqual([]);
    expect(extractOverviewAnomalyLabels([])).toEqual([]);
    expect(extractOverviewAnomalyLabels(null)).toEqual([]);
    expect(extractOverviewAnomalyLabels(undefined)).toEqual([]);
  });

  it('normalizes strict Signature anomaly run ids without using other anomaly fields', () => {
    const group: PatrolAnomalyGroup = {
      count: 4,
      truncated: false,
      items: [
        { run_id: 'sig_run_1', run_name: '重复任务', request_ids: [], http_status: 400 },
        { run_id: 'sig_run_1', run_name: '重复任务', request_ids: [], http_status: 400 },
        { run_id: 'sig_run_2', run_name: '另一个任务', request_ids: [], http_status: 400 },
        { run_id: '   ', run_name: '空 ID', request_ids: [], http_status: 400 },
        { run_id: null as unknown as string, run_name: '缺失 ID', request_ids: [], http_status: 400 },
        { run_id: undefined as unknown as string, run_name: '未定义 ID', request_ids: [], http_status: 400 },
      ],
    };

    expect([...extractSignatureAnomalyRunIds(group)]).toEqual(['sig_run_1', 'sig_run_2']);
  });

  it('returns an empty Signature anomaly run-id set for empty or missing groups', () => {
    expect(extractSignatureAnomalyRunIds(null)).toEqual(new Set());
    expect(extractSignatureAnomalyRunIds(undefined)).toEqual(new Set());
    expect(extractSignatureAnomalyRunIds({ count: 0, truncated: false, items: [] })).toEqual(new Set());
  });

  it('builds a latest-result overview for every channel', () => {
    const channels: Channel[] = [
      { id: 'ch_1', name: '渠道一', provider_type: 'anthropic', role: 'candidate', is_reference: false, enabled: true },
      { id: 'ch_2', name: '渠道二', provider_type: 'anthropic', role: 'candidate', is_reference: false, enabled: false },
    ];
    const reports: ReportSummary[] = [
      {
        report_id: 'rep_old', run_id: 'run_old', run_name: '旧测试', mode: 'candidate_eval', channel_id: 'ch_1', channel_name: '渠道一',
        channel_role: 'candidate', suite_id: 'suite_1', grade: 'C', final_score: 72, labels: ['style_drift'], dimension_scores: {},
        performance: { success_count: 1, failure_count: 0, failure_rate: 0, slow_case_ids: [] }, created_at: '2026-07-22T08:00:00Z',
      },
      {
        report_id: 'rep_new', run_id: 'run_new', run_name: '最新测试', mode: 'candidate_eval', channel_id: 'ch_1', channel_name: '渠道一',
        channel_role: 'candidate', suite_id: 'suite_1', grade: 'A', final_score: 95, labels: [], dimension_scores: {},
        performance: { success_count: 1, failure_count: 0, failure_rate: 0, slow_case_ids: [] }, created_at: '2026-07-23T08:00:00Z',
      },
    ];
    const runs: Run[] = [
      { ...run('run_new'), name: '最新测试', channels: [{ channel_id: 'ch_1', channel_name: '渠道一', role_in_run: 'candidate' }], created_at: '2026-07-23T07:59:00Z' },
    ];

    const overview = buildChannelResultOverview(channels, reports, runs);

    expect(overview).toHaveLength(2);
    expect(overview[0]).toMatchObject({ channelId: 'ch_1', latestReport: { report_id: 'rep_new', grade: 'A' }, latestRun: { id: 'run_new' } });
    expect(overview[1]).toMatchObject({ channelId: 'ch_2', latestReport: null, latestRun: null });
  });

  it('selects every deletable task while excluding running tasks', () => {
    const completed = run('completed_1');
    const failed = { ...run('failed_1'), status: 'failed' as const };
    const pending = { ...run('pending_1'), status: 'pending' as const };
    const running = { ...run('running_1'), status: 'running' as const };

    expect(selectableRunIds([completed, failed, pending, running])).toEqual(['completed_1', 'failed_1']);
  });

  it('removes successfully bulk-deleted tasks from the cached list immediately', () => {
    const runs = [run('deleted_1'), run('failed_1'), run('missing_1'), run('untouched_1')];

    expect(removeBulkDeletedRuns(
      runs,
      ['deleted_1', 'failed_1', 'missing_1'],
      { missing: ['missing_1'], failed: { failed_1: 'blocked' } },
    )?.map((item) => item.id)).toEqual(['failed_1', 'missing_1', 'untouched_1']);
  });

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

  it('builds stable deduplicated patrol channel options', () => {
    const input: Run[] = [
      { ...run('patrol_1', 'sched_1'), patrol_channel_id: 'ch_2', patrol_channel_name: '渠道乙' },
      { ...run('patrol_2', 'sched_2'), patrol_channel_id: 'ch_1', patrol_channel_name: '渠道甲' },
      { ...run('patrol_3', 'sched_3'), patrol_channel_id: 'ch_1', patrol_channel_name: '渠道甲旧名称' },
      { ...run('patrol_unknown', 'sched_4'), patrol_channel_id: null, patrol_channel_name: null },
    ];
    const snapshot = [...input];

    expect(buildPatrolChannelFilterOptions(input)).toEqual([
      { value: ALL_PATROL_CHANNELS, label: '全部渠道' },
      { value: 'ch_1', label: '渠道甲' },
      { value: 'ch_2', label: '渠道乙' },
      { value: UNKNOWN_PATROL_CHANNEL, label: '未识别渠道' },
    ]);
    expect(input).toEqual(snapshot);
  });

  it('filters patrol logs by channel without changing their order', () => {
    const input: Run[] = [
      { ...run('patrol_1', 'sched_1'), patrol_channel_id: 'ch_1', patrol_channel_name: '渠道甲' },
      { ...run('patrol_2', 'sched_2'), patrol_channel_id: 'ch_2', patrol_channel_name: '渠道乙' },
      { ...run('patrol_3', 'sched_3'), patrol_channel_id: 'ch_1', patrol_channel_name: '渠道甲' },
      { ...run('patrol_unknown', 'sched_4'), patrol_channel_id: null, patrol_channel_name: null },
    ];

    expect(filterPatrolRunsByChannel(input, 'ch_1').map((item) => item.id)).toEqual(['patrol_1', 'patrol_3']);
    expect(filterPatrolRunsByChannel(input, UNKNOWN_PATROL_CHANNEL).map((item) => item.id)).toEqual(['patrol_unknown']);
    expect(filterPatrolRunsByChannel(input, ALL_PATROL_CHANNELS).map((item) => item.id)).toEqual(input.map((item) => item.id));
    expect(filterPatrolRunsByChannel(input, 'missing')).toEqual([]);
    expect(filterPatrolRunsByChannel([], 'ch_1')).toEqual([]);
  });

  it('paginates patrol logs without changing input order', () => {
    const input = [run('run_1'), run('run_2'), run('run_3'), run('run_4'), run('run_5')];

    expect(paginateRuns(input, 1, 2).map((item) => item.id)).toEqual(['run_1', 'run_2']);
    expect(paginateRuns(input, 2, 2).map((item) => item.id)).toEqual(['run_3', 'run_4']);
    expect(paginateRuns(input, 1, 3).map((item) => item.id)).toEqual(['run_1', 'run_2', 'run_3']);
    expect(input.map((item) => item.id)).toEqual(['run_1', 'run_2', 'run_3', 'run_4', 'run_5']);
  });

  it('clamps patrol page to the valid range', () => {
    expect(clampPage(2, 25, 10)).toBe(2);
    expect(clampPage(9, 25, 10)).toBe(3);
    expect(clampPage(0, 25, 10)).toBe(1);
    expect(clampPage(4, 0, 10)).toBe(1);
  });

  it('selects only terminal patrol logs from the current channel scope', () => {
    const channelA = { ...run('patrol_a_completed', 'sched_a'), patrol_channel_id: 'ch_a' };
    const channelARunning = { ...run('patrol_a_running', 'sched_a'), patrol_channel_id: 'ch_a', status: 'running' as const };
    const channelB = { ...run('patrol_b_failed', 'sched_b'), patrol_channel_id: 'ch_b', status: 'failed' as const };

    expect(deletablePatrolRunIds([channelA, channelARunning])).toEqual(['patrol_a_completed']);
    expect(deletablePatrolRunIds([channelA, channelB])).toEqual(['patrol_a_completed', 'patrol_b_failed']);
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
                title: 'Adaptive thinking 协议',
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
                title: 'Adaptive thinking effort',
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
              raw_error: 'Invalid signature request_id=req_relay',
              error_http_status: 400,
              error_stage: 'relay',
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
              request_logs: [
                {
                  stage: 'source',
                  name: '步骤 A：请求 Source thinking',
                  status: 'ok',
                  started_at: '2026-05-16T01:02:04Z',
                  completed_at: '2026-05-16T01:02:04Z',
                  endpoint: 'https://source.example/v1/messages',
                  http_status: 200,
                  latency_ms: 120,
                  message_id: 'msg_source',
                  request_id: 'req_source',
                  request_excerpt: '{"model":"claude"}',
                  response_excerpt: '{"id":"msg_source"}',
                },
                {
                  stage: 'relay',
                  name: '步骤 B：发送 Relay 复用请求',
                  status: 'fail',
                  started_at: '2026-05-16T01:02:04Z',
                  completed_at: '2026-05-16T01:02:05Z',
                  endpoint: 'https://relay.example/v1/messages',
                  http_status: 400,
                  latency_ms: 350,
                  request_id: 'req_relay',
                  gateway_request_id: 'gateway_req_relay',
                  upstream_request_id: 'upstream_req_relay',
                  error: 'Invalid signature',
                  request_excerpt: '{"messages":[]}',
                  response_excerpt: '{"error":"Invalid signature"}',
                },
              ],
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
      title: 'Adaptive thinking 协议',
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
      rawError: 'Invalid signature request_id=req_relay',
      errorHttpStatus: 400,
      errorStage: 'relay',
    });
    expect(evidence?.signature?.requestLogs).toHaveLength(2);
    expect(evidence?.signature?.requestLogs[1]).toMatchObject({
      stage: 'relay',
      status: 'fail',
      httpStatus: 400,
      requestId: 'req_relay',
      gatewayRequestId: 'gateway_req_relay',
      upstreamRequestId: 'upstream_req_relay',
      error: 'Invalid signature',
      responseExcerpt: '{"error":"Invalid signature"}',
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
              { key: 'thinking_temperature', result_id: 'res_1', response_id: 'msg_canonical_response', message_id: 'msg_legacy_alias', labels: [] },
              { key: 'web_search', result_id: 'res_2', labels: ['web_search_not_rejected'] },
            ],
          },
        },
      ],
    };

    const evidence = extractPatrolEvidence(results);

    expect(evidence?.modelRequests[0]).toMatchObject({
      resultId: 'res_1',
      messageId: 'msg_canonical_response',
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
                title: 'Adaptive thinking 协议',
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
      title: 'Adaptive thinking 协议',
      status: 'ok',
      resultId: 'res_1',
      messageId: 'msg_1',
      channelName: 'Patrol Channel',
    });
    expect(evidence?.labels).toEqual(['patrol_probe_passed']);
    expect(evidence?.detectedProviderHint).toBe('疑似 Claude/Anthropic');
  });

  it('normalizes blind identity JSON evidence without inferring fields from response text', () => {
    const evidence = extractPatrolEvidence({
      run: run('patrol_blind_identity', 'sched_blind_identity'),
      run_channels: [],
      comparisons: [],
      baseline_results: [],
      results: [],
      reports: [{
        id: 'rep_blind_identity',
        run_id: 'patrol_blind_identity',
        channel_id: 'ch_blind',
        final_score: 0,
        grade: 'E',
        summary: '无品牌结构化探针泄漏',
        evidence: {
          test_scope: 'scheduled_probe',
          labels: ['hidden_brand_leak', 'kiro_identity_leak', 'identity_json_extra_text'],
          model_requests: [{
            key: 'identity_blind_json',
            title: '无品牌 JSON 身份填空',
            status: 'error',
            message_id: 'msg_blind_ui',
            request_id: 'req_blind_ui',
            http_status: 200,
            identity_json_status: 'brand_leak',
            identity_json_format: 'extra_text',
            identity_json_fields: { vendor: 'Kiro', product: 'Kiro', model: '' },
            json_extracted: true,
            extra_text_present: true,
            prompt_brand_hits: [],
            response_brand_hits: ['kiro'],
            response_text: '{"vendor":"Kiro","product":"Kiro","model":""}\nmodel=Claude outside JSON',
            labels: ['hidden_brand_leak', 'kiro_identity_leak', 'identity_json_extra_text'],
          }],
        },
      }],
    });

    expect(evidence?.modelRequests[0]).toMatchObject({
      key: 'identity_blind_json',
      httpStatus: 200,
      identityJsonStatus: 'brand_leak',
      identityJsonFormat: 'extra_text',
      identityJsonFields: { vendor: 'Kiro', product: 'Kiro', model: '' },
      jsonExtracted: true,
      extraTextPresent: true,
      promptBrandHits: [],
      responseBrandHits: ['kiro'],
    });
    expect(evidence?.modelRequests[0].identityJsonFields?.model).toBe('');
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
    expect(formatPatrolChannel({ id: '8890-tokenflow-aws', name: '鬼手', accountType: 'aws' }, '8890-tokenflow-aws')).toBe('鬼手');
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

  it('treats provider runtime failures as non-anomalous probe results', () => {
    const operationalItems = [
      { status: 'fail', httpStatus: 403, error: "Client error '403 Forbidden' for url 'https://api.example.com/v1/messages'" },
      { status: 'error', error: "Server error '500 Internal Server Error' response body: Service is temporarily unavailable" },
      { status: 'fail', error: '503 Service Unavailable' },
      { status: 'fail', httpStatus: 400, error: 'No available accounts: no available accounts' },
      { status: 'fail', httpStatus: 400, error: 'Upstream access forbidden, please contact administrator' },
      { status: 'error', error: 'request timeout while connecting to upstream' },
      { status: 'error', error: 'network connection reset by peer' },
      { status: 'error', labels: ['provider_quota_or_balance_exhausted'], error: '余额不足' },
      { status: 'error', labels: ['provider_temporarily_unavailable'], error: 'identity_probe_failed' },
    ];

    for (const item of operationalItems) {
      expect(isPatrolOperationalFailure(item)).toBe(true);
    }
  });

  it('does not count forbidden requests as completed model probes', () => {
    const items = [
      { status: 'fail', httpStatus: 403, error: "Client error '403 Forbidden' for url 'https://api.example.com/v1/messages'", labels: [] },
      { status: 'ok', httpStatus: 200, responseText: 'Claude response', labels: [] },
      { status: 'fail', httpStatus: 400, error: 'unexpected response shape', labels: ['protocol_mismatch'] },
    ];

    expect(countedPatrolModelRequests(items as never)).toEqual(items.slice(1));
    expect(patrolProbeStatusText(items[0])).toBe('正常');
    expect(patrolProbeStatusColor(items[0])).toBe('green');
  });

  it('keeps explicit protocol and identity anomalies outside operational failures', () => {
    expect(isPatrolOperationalFailure({ status: 'fail', errorHttpStatus: 400, rawError: 'Invalid `signature` in `thinking` block' })).toBe(false);
    expect(isPatrolOperationalFailure({ status: 'error', labels: ['kiro_identity_leak'], error: '你好，我是 Kiro' })).toBe(false);
    expect(isPatrolOperationalFailure({ status: 'error', error: 'unexpected response shape' })).toBe(false);
  });

  it('preserves unknown signature state from patrol evidence', () => {
    const results = {
      run: run('signature_unknown_run', 'signature_unknown_schedule'),
      channels: [],
      results: [],
      comparisons: [],
      reports: [{
        id: 'signature_unknown_report',
        run_id: 'signature_unknown_run',
        channel_id: 'channel_1',
        summary: '检测未完成',
        evidence: {
          test_scope: 'scheduled_probe',
          labels: ['provider_request_failed'],
          classification_status: 'operational_issue',
          signature_interop: {
            status: 'fail',
            signature_ok: null,
            raw_error: 'Upstream access forbidden, please contact administrator',
            error_http_status: 500,
            error_stage: 'source_identity',
            request_logs: [{ stage: 'source_identity', status: 'fail', http_status: 500, request_id: 'req_forbidden' }],
          },
        },
      }],
      baseline_results: [],
    } as unknown as RunResults;

    expect(extractPatrolEvidence(results)?.signature).toMatchObject({
      signatureOk: null,
      status: 'fail',
      rawError: 'Upstream access forbidden, please contact administrator',
      errorHttpStatus: 500,
      errorStage: 'source_identity',
    });
  });

  it('suppresses signature and AI failure cards for operational access errors', () => {
    const sourceForbidden = {
      reportId: 'report_source_forbidden',
      labels: ['provider_request_failed', 'identity_probe_failed'],
      labelExplanations: {},
      classificationStatus: 'operational_issue',
      aiJudge: { classification_status: 'anomaly', classification_label: '检测失败' },
      modelRequests: [],
      signature: {
        status: 'fail',
        signatureOk: null,
        errorHttpStatus: 500,
        errorStage: 'source_identity',
        rawError: 'Upstream access forbidden, please contact administrator',
        signaturePrefixes: [],
        requestLogs: [],
      },
    } as unknown as Parameters<typeof patrolSignatureDisplayState>[0];
    const relayNotAllowed = {
      ...sourceForbidden,
      reportId: 'report_relay_not_allowed',
      signature: {
        ...sourceForbidden.signature,
        errorHttpStatus: 400,
        errorStage: 'relay',
        rawError: 'ValidationException: models is not allowed for this account',
      },
    } as unknown as Parameters<typeof patrolSignatureDisplayState>[0];

    expect(patrolSignatureDisplayState(sourceForbidden)).toEqual({
      state: 'unknown',
      label: '未完成验证',
      color: 'default',
      showFailureAlert: false,
      showAiJudge: false,
    });
    expect(patrolSignatureDisplayState(relayNotAllowed)).toEqual({
      state: 'unknown',
      label: '未完成验证',
      color: 'default',
      showFailureAlert: false,
      showAiJudge: false,
    });
    expect(patrolSignatureDisplayState(sourceForbidden).showFailureAlert).toBe(false);
  });

  it('shows only explicit signature rejection and preserves Kiro review', () => {
    const rejected = {
      reportId: 'report_rejected',
      labels: ['signature_interop_failed'],
      labelExplanations: {},
      aiJudge: { classification_status: 'anomaly' },
      modelRequests: [],
      signature: {
        status: 'fail',
        signatureOk: false,
        errorHttpStatus: 400,
        errorStage: 'relay',
        rawError: 'Invalid `signature` in `thinking` block',
        signaturePrefixes: [],
        requestLogs: [],
      },
    } as unknown as Parameters<typeof patrolSignatureDisplayState>[0];
    const kiroWithOperationalSignature = {
      ...rejected,
      reportId: 'report_kiro',
      labels: ['kiro_identity_leak', 'provider_request_failed'],
      signature: {
        ...rejected.signature,
        signatureOk: null,
        errorHttpStatus: 500,
        errorStage: 'source_identity',
        rawError: 'Upstream access forbidden',
      },
    } as unknown as Parameters<typeof patrolSignatureDisplayState>[0];

    expect(patrolSignatureDisplayState(rejected)).toMatchObject({
      state: 'rejected',
      label: 'Signature 失败',
      color: 'red',
      showFailureAlert: true,
      showAiJudge: true,
    });
    expect(patrolSignatureDisplayState(kiroWithOperationalSignature)).toMatchObject({
      state: 'unknown',
      showFailureAlert: false,
      showAiJudge: true,
    });
  });

  it('keeps historical explicit signature rejection without signature_ok', () => {
    const results = {
      run: run('historical_signature_rejection', 'historical_signature_schedule'),
      channels: [],
      results: [],
      comparisons: [],
      reports: [{
        id: 'historical_signature_report',
        run_id: 'historical_signature_rejection',
        channel_id: 'channel_1',
        summary: 'Signature rejected',
        evidence: {
          test_scope: 'scheduled_probe',
          labels: ['signature_interop_failed'],
          classification_status: 'anomaly',
          signature_interop: {
            status: 'fail',
            raw_error: 'Invalid `signature` in `thinking` block',
            error_http_status: 400,
            error_stage: 'relay',
          },
        },
      }],
      baseline_results: [],
    } as unknown as RunResults;
    const evidence = extractPatrolEvidence(results);

    expect(evidence?.signature?.signatureOk).toBeUndefined();
    expect(patrolSignatureDisplayState(evidence!)).toMatchObject({
      state: 'rejected',
      showFailureAlert: true,
    });
  });

  it('normalizes an operational-only patrol while preserving mixed real anomalies', () => {
    const operationalEvidence = {
      reportId: 'report_operational',
      labels: ['provider_request_failed', 'identity_probe_failed', 'identity_uncertain'],
      labelExplanations: {},
      classificationStatus: 'operational_issue',
      modelRequests: [{ status: 'error', labels: ['provider_request_failed'], error: '500 Internal Server Error' }],
      signature: { status: 'fail', errorHttpStatus: 503, rawError: 'Service temporarily unavailable', signaturePrefixes: [], requestLogs: [] },
    } as unknown as Parameters<typeof patrolEvidenceDisplayState>[0];
    expect(patrolEvidenceDisplayState(operationalEvidence)).toEqual({
      displayState: 'ok',
      isOperationalFailure: true,
      hasRealAnomaly: false,
    });

    const mixedEvidence = {
      ...operationalEvidence,
      labels: ['provider_request_failed', 'kiro_identity_leak'],
      modelRequests: [
        { status: 'error', labels: ['provider_request_failed'], error: '500 Internal Server Error' },
        { status: 'error', labels: ['kiro_identity_leak'], error: 'I am Kiro' },
      ],
    } as unknown as Parameters<typeof patrolEvidenceDisplayState>[0];
    expect(patrolEvidenceDisplayState(mixedEvidence)).toEqual({
      displayState: 'error',
      isOperationalFailure: true,
      hasRealAnomaly: true,
    });
    expect(patrolReportedLabels(operationalEvidence)).toEqual([]);
    expect(patrolReportedLabels(mixedEvidence)).toEqual(['kiro_identity_leak']);
  });

  it('extracts the most specific inline patrol error and classifies operational failures', () => {
    const evidence = {
      reportId: 'report_operational',
      summary: '巡检失败',
      labels: ['provider_request_failed'],
      labelExplanations: { provider_request_failed: '上游请求失败' },
      modelRequests: [{ status: 'error', labels: ['provider_request_failed'], error: '  503   Service Unavailable  ' }],
      signature: null,
    } as unknown as Parameters<typeof patrolInlineError>[0];

    expect(patrolInlineError(evidence)).toEqual({
      kind: 'operational',
      text: '503 Service Unavailable',
      fullText: '503 Service Unavailable',
      source: 'model_request',
    });
  });

  it('distinguishes explicit Signature rejection from signature-related timeout', () => {
    const base = {
      reportId: 'report_signature',
      labels: [],
      labelExplanations: {},
      modelRequests: [],
      signature: { status: 'fail', signaturePrefixes: [], requestLogs: [] },
    };

    expect(patrolInlineError({
      ...base,
      signature: { ...base.signature, errorHttpStatus: 400, rawError: 'Invalid `signature` in `thinking` block' },
    })).toMatchObject({ kind: 'signature', source: 'signature' });
    expect(patrolInlineError({
      ...base,
      signature: { ...base.signature, rawError: 'signature validation timed out while connecting to upstream' },
    })).toMatchObject({ kind: 'operational', source: 'signature' });
  });

  it('falls back to explanations while keeping normal patrols free of inline errors', () => {
    const failure = {
      reportId: 'report_probe',
      labels: ['quality_regression'],
      labelExplanations: { quality_regression: '能力表现低于参考区间' },
      modelRequests: [{ status: 'fail', labels: [], responseText: '  unexpected   response shape  ' }],
      signature: null,
    } as unknown as Parameters<typeof patrolInlineError>[0];
    const normal = {
      reportId: 'report_ok',
      labels: ['patrol_probe_passed'],
      labelExplanations: {},
      modelRequests: [{ status: 'ok', labels: [], responseText: '正常回答' }],
      signature: null,
    } as unknown as Parameters<typeof patrolInlineError>[0];

    expect(patrolInlineError(failure)).toMatchObject({ kind: 'probe', text: 'unexpected response shape' });
    expect(patrolInlineError(normal)).toBeNull();
  });

  it('filters patrol runs to only explicit error states while preserving order', () => {
    const input = [run('ok_1', 'sched_1'), run('error_1', 'sched_1'), run('unknown_1', 'sched_1'), run('error_2', 'sched_1')];
    const states = new Map([['ok_1', 'ok'], ['error_1', 'error'], ['error_2', 'error']] as const);

    expect(filterPatrolRunsByError(input, false, states).map((item) => item.id)).toEqual(['ok_1', 'error_1', 'unknown_1', 'error_2']);
    expect(filterPatrolRunsByError(input, true, states).map((item) => item.id)).toEqual(['error_1', 'error_2']);
    expect(filterPatrolRunsByError([], true, states)).toEqual([]);
  });

  it('explains why patrol selection cannot be deleted and counts only terminal runs', () => {
    const completed = run('completed', 'sched_1');
    const failed = { ...run('failed', 'sched_1'), status: 'failed' as const };
    const pending = { ...run('pending', 'sched_1'), status: 'pending' as const };
    const running = { ...run('running', 'sched_1'), status: 'running' as const };

    expect(buildPatrolDeleteSummary({
      selectedRuns: [],
      selectedRowCount: 0,
      filteredDeletableCount: 8,
      selectedChannel: ALL_PATROL_CHANNELS,
      selectedChannelLabel: '全部渠道',
      onlyErrors: false,
    })).toMatchObject({
      selectedDeletableCount: 0,
      hasSelectedRows: false,
      selectedDisabledReason: '请先勾选已结束日志',
      deleteScopeLabel: '全部渠道',
    });

    expect(buildPatrolDeleteSummary({
      selectedRuns: [pending, running],
      selectedRowCount: 2,
      filteredDeletableCount: 8,
      selectedChannel: ALL_PATROL_CHANNELS,
      selectedChannelLabel: '全部渠道',
      onlyErrors: false,
    })).toMatchObject({
      selectedDeletableCount: 0,
      hasSelectedRows: true,
      selectedDisabledReason: '未结束的巡检日志不能删除',
    });

    expect(buildPatrolDeleteSummary({
      selectedRuns: [completed, failed, pending],
      selectedRowCount: 3,
      filteredDeletableCount: 8,
      selectedChannel: ALL_PATROL_CHANNELS,
      selectedChannelLabel: '全部渠道',
      onlyErrors: false,
    })).toMatchObject({
      selectedDeletableCount: 2,
      hasSelectedRows: true,
      selectedDisabledReason: null,
      filteredDeletableCount: 8,
    });
  });

  it('builds patrol delete scope labels for channel and error filters', () => {
    const base = {
      selectedRuns: [] as Run[],
      selectedRowCount: 0,
      filteredDeletableCount: 3,
      selectedChannelLabel: '渠道 A',
    };

    expect(buildPatrolDeleteSummary({
      ...base,
      selectedChannel: ALL_PATROL_CHANNELS,
      onlyErrors: true,
    }).deleteScopeLabel).toBe('全部渠道的错误日志');
    expect(buildPatrolDeleteSummary({
      ...base,
      selectedChannel: 'channel_a',
      onlyErrors: false,
    }).deleteScopeLabel).toBe('渠道「渠道 A」');
    expect(buildPatrolDeleteSummary({
      ...base,
      selectedChannel: 'channel_a',
      onlyErrors: true,
    }).deleteScopeLabel).toBe('渠道「渠道 A」的错误日志');
  });
});
