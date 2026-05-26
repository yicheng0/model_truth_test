import { describe, expect, it, vi } from 'vitest';
import { ApiError, api, getAdminApiKey, getErrorMessage, setAdminApiKey } from './api';

describe('api request handling', () => {
  it('uses readable FastAPI detail messages for failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Run not found' }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.run('missing')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'Run not found',
    });

    fetchMock.mockRestore();
  });

  it('normalizes unknown thrown values', () => {
    expect(getErrorMessage('bad')).toBe('请求失败，请稍后重试');
    expect(getErrorMessage(new ApiError('Forbidden', 403))).toBe('Forbidden');
  });

  it('treats missing scheduled health endpoint as unavailable diagnostics', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Scheduled test not found' }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.scheduledTestsHealth()).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledWith('/api/scheduled-tests/health', expect.any(Object));
    fetchMock.mockRestore();
  });

  it('treats upstream scheduled health failures as unavailable diagnostics', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    await expect(api.scheduledTestsHealth()).resolves.toBeNull();

    fetchMock.mockRestore();
  });

  it('hides raw upstream html from generic API failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    await expect(api.systemUsage()).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      message: '请求失败，请稍后重试',
    });

    fetchMock.mockRestore();
  });

  it('keeps cleanup preview available even when the dry-run result is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Internal server error' }), {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.cleanupRunLogs(true)).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/system/cleanup-run-logs?dry_run=true', expect.objectContaining({ method: 'POST' }));
    fetchMock.mockRestore();
  });

  it('adds the admin key to destructive requests when configured', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
    setAdminApiKey('test-admin-key');
    expect(getAdminApiKey()).toBe('test-admin-key');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await api.deleteRun('run_1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/runs/run_1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ 'X-Admin-Key': 'test-admin-key' }),
      }),
    );
    setAdminApiKey('');
    vi.unstubAllGlobals();
    fetchMock.mockRestore();
  });

  it('bulk deletes runs with the admin key', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
    setAdminApiKey('test-admin-key');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deleted: 2, missing: [], failed: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await api.deleteRuns(['run_1', 'run_2']);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/runs/bulk-delete',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Admin-Key': 'test-admin-key' }),
        body: JSON.stringify({ ids: ['run_1', 'run_2'] }),
      }),
    );
    setAdminApiKey('');
    vi.unstubAllGlobals();
    fetchMock.mockRestore();
  });

  it('updates channel taxonomy settings with the expected endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'global',
          role_labels: { gold: '金标 Anthropic', official_cloud: '官方云参考', candidate: '客户待测渠道', negative: '负样本' },
          provider_type_labels: {},
          model_options: [],
          default_role_labels: {},
          default_provider_type_labels: {},
          default_model_options: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await api.updateChannelTaxonomy({ role_labels: { candidate: '客户待测渠道' } });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/channel-taxonomy',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ role_labels: { candidate: '客户待测渠道' } }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('creates channels without exposing provider type', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'ch_custom',
          name: 'Custom Gateway',
          role: 'candidate',
          provider_type: 'customer_gateway',
          is_reference: false,
          enabled: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await api.createChannel({
      name: 'Custom Gateway',
      provider_type: 'customer_gateway',
      enabled: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/channels',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Custom Gateway',
          provider_type: 'customer_gateway',
          enabled: true,
        }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('updates channel API keys through auth_config', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'ch_custom',
          name: 'Custom Gateway',
          role: 'candidate',
          provider_type: 'customer_gateway',
          auth_config: { api_key: 'second-key' },
          is_reference: false,
          enabled: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await api.updateChannel('ch_custom', { auth_config: { api_key: 'second-key' } });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/channels/ch_custom',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ auth_config: { api_key: 'second-key' } }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('saves custom model names as channel taxonomy options', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'global',
          role_labels: {},
          provider_type_labels: {},
          model_options: ['custom-internal-model'],
          default_role_labels: {},
          default_provider_type_labels: {},
          default_model_options: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await api.updateChannelTaxonomy({ model_options: ['custom-internal-model'] });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/channel-taxonomy',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ model_options: ['custom-internal-model'] }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('loads system usage from the maintenance endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          disk_path: '/app',
          disk_total_bytes: 100,
          disk_used_bytes: 40,
          disk_free_bytes: 60,
          disk_used_percent: 40,
          run_count: 1,
          result_count: 2,
          comparison_count: 3,
          report_count: 4,
          alert_count: 5,
          cleanup_candidate_run_count: 1,
          cleanup_skipped_baseline_run_count: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await api.systemUsage();

    expect(fetchMock).toHaveBeenCalledWith('/api/system/usage', expect.any(Object));
    fetchMock.mockRestore();
  });

  it('previews and runs run log cleanup through the maintenance endpoint', async () => {
    const payload = {
      dry_run: true,
      deleted_runs: 1,
      deleted_run_channels: 1,
      deleted_results: 2,
      deleted_comparisons: 3,
      deleted_reports: 4,
      deleted_alerts: 5,
      cleared_scheduled_last_run_refs: 0,
      skipped_running_runs: 0,
      skipped_baseline_runs: 0,
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...payload, dry_run: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await api.cleanupRunLogs(true);
    await api.cleanupRunLogs(false);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/system/cleanup-run-logs?dry_run=true',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/system/cleanup-run-logs',
      expect.objectContaining({ method: 'POST' }),
    );
    fetchMock.mockRestore();
  });

  it('sends real model request tests through the channel endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: { id: 'run_1', suite_id: 'manual_model_request_probe', name: 'probe', mode: 'manual_probe', test_scope: 'quick', status: 'completed', repeat_count: 1, concurrency: 1, total_jobs: 1, completed_jobs: 1 },
          result: { id: 'res_1', run_id: 'run_1', test_case_id: 'case_1', channel_id: 'ch_1', attempt_index: 1, score: 100 },
          message_id: 'msg_01abc',
          message_channel_type: 'Anthropic',
          request_protocol: 'anthropic_messages',
          provider_endpoint: 'https://api.anthropic.com/v1/messages',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await api.modelRequestTest('ch_1', {
      prompt: 'hello',
      system_prompt: null,
      request_params: { max_tokens: 16, temperature: 0 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/channels/ch_1/model-request-test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'hello',
          system_prompt: null,
          request_params: { max_tokens: 16, temperature: 0 },
        }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('sends ClaudeCode tests through the isolated channel endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          score: 72,
          risk_level: 'high',
          summary: '失败项：基础回显',
          probes: [
            {
              key: 'basic_echo',
              title: '基础回显',
              category: 'protocol',
              status: 'fail',
              severity: 'core',
              score: 0,
              labels: ['exact_output_mismatch'],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await api.claudeCodeTest('ch_1', {
      source_channel_id: 'source_1',
      image_url: 'https://example.test/red.png',
      include_expensive_context: false,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/channels/ch_1/claude-code-test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          source_channel_id: 'source_1',
          image_url: 'https://example.test/red.png',
          include_expensive_context: false,
        }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('sends ephemeral ClaudeCode relay tests with runtime credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          score: 96,
          risk_level: 'low',
          summary: 'ok',
          probes: [],
          sections: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await api.runClaudeCodeRelayTest({
      base_url: 'https://relay.example/v1',
      api_key: 'sk-test',
      model_name: 'claude-sonnet-4-5',
      provider_type: 'third_party_anthropic',
      request_protocol: 'anthropic_messages',
      source_channel_id: 'source_1',
      image_url: null,
      include_expensive_context: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/claude-code-test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          base_url: 'https://relay.example/v1',
          api_key: 'sk-test',
          model_name: 'claude-sonnet-4-5',
          provider_type: 'third_party_anthropic',
          request_protocol: 'anthropic_messages',
          source_channel_id: 'source_1',
          image_url: null,
          include_expensive_context: true,
        }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('loads ClaudeCode source channels from the dedicated endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: 'anthropic_official',
            name: 'Anthropic Official',
            provider_type: 'anthropic',
            model_name: 'claude-sonnet-4-5',
            account_type: 'claude',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const payload = await api.claudeCodeSourceChannels();

    expect(payload[0].id).toBe('anthropic_official');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/claude-code-test/source-channels',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
    fetchMock.mockRestore();
  });

  it('starts ClaudeCode relay jobs and polls progress', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job_id: 'relay_job_1', status: 'queued' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            job_id: 'relay_job_1',
            kind: 'relay',
            status: 'running',
            started_at: '2026-05-26T00:00:00Z',
            finished_at: null,
            current_key: 'basic_echo',
            current_title: '基础回显',
            current_section: 'structure',
            completed_count: 1,
            total_count: 5,
            percent: 20,
            sections: [],
            probes: [],
            checks: [],
            result: null,
            error: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const started = await api.startClaudeCodeRelayTestJob({
      base_url: 'https://relay.example/v1',
      api_key: 'sk-test',
      model_name: 'claude-sonnet-4-5',
    });
    const progress = await api.claudeCodeRelayTestJob('relay_job_1');

    expect(started.job_id).toBe('relay_job_1');
    expect(progress.status).toBe('running');
    expect(progress.probes).toEqual([]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/claude-code-test/jobs',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/claude-code-test/jobs/relay_job_1',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
    fetchMock.mockRestore();
  });

  it('starts ClaudeCode CLI jobs and polls progress', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job_id: 'cli_job_1', status: 'queued' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            job_id: 'cli_job_1',
            kind: 'cli',
            status: 'running',
            started_at: '2026-05-26T00:00:00Z',
            finished_at: null,
            current_key: 'non_interactive_run',
            current_title: '非交互运行成功',
            current_section: 'cli',
            completed_count: 2,
            total_count: 7,
            percent: 28.6,
            sections: [],
            probes: [],
            checks: [],
            result: null,
            error: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const started = await api.startClaudeCodeCheckJob({ timeout_seconds: 180, max_budget_usd: 0.25, model: 'sonnet' });
    const progress = await api.claudeCodeCheckJob('cli_job_1');

    expect(started.job_id).toBe('cli_job_1');
    expect(progress.current_key).toBe('non_interactive_run');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/claude-code-check/jobs',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/claude-code-check/jobs/cli_job_1',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
    fetchMock.mockRestore();
  });

  it('loads ClaudeCode history list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: 'cce_1',
            channel_label: 'ClaudeCode 临时检测渠道',
            base_url: 'https://relay.example/v1',
            model_name: 'claude-sonnet-4-5',
            provider_type: 'third_party_anthropic',
            score: 82,
            risk_level: 'high',
            ok: false,
            summary: '发现多模态问题',
            probe_count: 12,
            fail_count: 3,
            warning_count: 2,
            created_at: '2026-05-26T12:00:00Z',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const payload = await api.claudeCodeHistory();

    expect(payload[0].id).toBe('cce_1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/claude-code-history',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
    fetchMock.mockRestore();
  });

  it('loads ClaudeCode history detail', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'cce_1',
          channel_label: 'ClaudeCode 临时检测渠道',
          base_url: 'https://relay.example/v1',
          model_name: 'claude-sonnet-4-5',
          provider_type: 'third_party_anthropic',
          request_protocol: 'auto',
          source_channel_id: null,
          image_url: null,
          include_expensive_context: false,
          ok: false,
          score: 82,
          risk_level: 'high',
          summary: '发现多模态问题',
          created_at: '2026-05-26T12:00:00Z',
          result_payload: { ok: false, score: 82, risk_level: 'high', summary: '发现多模态问题', probes: [], sections: [] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const payload = await api.claudeCodeHistoryDetail('cce_1');

    expect(payload.id).toBe('cce_1');
    expect(payload.result_payload.risk_level).toBe('high');
    fetchMock.mockRestore();
  });

  it('deletes one ClaudeCode history item', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await api.deleteClaudeCodeHistory('cce_1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/claude-code-history/cce_1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    fetchMock.mockRestore();
  });

  it('sends web search probe params through the model request endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: { id: 'run_1', suite_id: 'manual_model_request_probe', name: 'probe', mode: 'manual_probe', test_scope: 'quick', status: 'completed', repeat_count: 1, concurrency: 1, total_jobs: 1, completed_jobs: 1 },
          result: { id: 'res_1', run_id: 'run_1', test_case_id: 'case_1', channel_id: 'ch_1', attempt_index: 1, score: 100 },
          message_id: 'msg_01abc',
          message_channel_type: 'Anthropic',
          request_protocol: 'anthropic_messages',
          provider_endpoint: 'https://api.anthropic.com/v1/messages',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await api.modelRequestTest('ch_1', {
      prompt: '请查询今天 Anthropic 官方新闻或博客的最新更新，并给出标题、发布日期和来源链接。',
      system_prompt: null,
      request_params: {
        max_tokens: 900,
        stream: true,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        expected_error_contains: 'web search',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/channels/ch_1/model-request-test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: '请查询今天 Anthropic 官方新闻或博客的最新更新，并给出标题、发布日期和来源链接。',
          system_prompt: null,
          request_params: {
            max_tokens: 900,
            stream: true,
            tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
            expected_error_contains: 'web search',
          },
        }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('can send all three combo purity probes through the existing model request endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: { id: 'run_thinking', suite_id: 'manual_model_request_probe', name: 'thinking', mode: 'manual_probe', test_scope: 'quick', status: 'completed', repeat_count: 1, concurrency: 1, total_jobs: 1, completed_jobs: 1 },
            result: { id: 'res_thinking', run_id: 'run_thinking', test_case_id: 'case_1', channel_id: 'ch_1', attempt_index: 1, score: 100 },
            message_id: null,
            message_channel_type: 'Unknown',
            request_protocol: 'anthropic_messages',
            provider_endpoint: 'https://api.example/v1/messages',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: { id: 'run_web', suite_id: 'manual_model_request_probe', name: 'web', mode: 'manual_probe', test_scope: 'quick', status: 'completed', repeat_count: 1, concurrency: 1, total_jobs: 1, completed_jobs: 1 },
            result: { id: 'res_web', run_id: 'run_web', test_case_id: 'case_2', channel_id: 'ch_1', attempt_index: 1, score: 100 },
            message_id: null,
            message_channel_type: 'Unknown',
            request_protocol: 'anthropic_messages',
            provider_endpoint: 'https://api.example/v1/messages',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: { id: 'run_adaptive', suite_id: 'manual_model_request_probe', name: 'adaptive', mode: 'manual_probe', test_scope: 'quick', status: 'completed', repeat_count: 1, concurrency: 1, total_jobs: 1, completed_jobs: 1 },
            result: { id: 'res_adaptive', run_id: 'run_adaptive', test_case_id: 'case_3', channel_id: 'ch_1', attempt_index: 1, score: 100 },
            message_id: null,
            message_channel_type: 'Unknown',
            request_protocol: 'anthropic_messages',
            provider_endpoint: 'https://api.example/v1/messages',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    await api.modelRequestTest('ch_1', {
      prompt: '请用一句话回答：这是 thinking temperature 纯度探针。',
      system_prompt: null,
      run_name: '组合纯度检测 · thinking_temperature',
      request_params: {
        max_tokens: 2048,
        temperature: 0.2,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        reasoning_effort: 'medium',
        expected_error_contains: 'temperature may only be set to 1 when thinking is enabled',
        expected_error_missing_label: 'thinking_temperature_not_rejected',
      },
    });
    await api.modelRequestTest('ch_1', {
      prompt: '请查询今天 Anthropic 官方新闻或博客的最新更新，并给出标题、发布日期和来源链接。',
      system_prompt: null,
      run_name: '组合纯度检测 · web_search',
      request_params: {
        max_tokens: 900,
        temperature: 0,
        stream: true,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        expected_error_any: ['web_search', 'unsupported', 'not available', 'tool', 'bedrock'],
        expected_error_missing_label: 'web_search_not_rejected',
      },
    });
    await api.modelRequestTest('ch_1', {
      prompt: '回复OK',
      system_prompt: null,
      run_name: '组合纯度检测 · thinking_adaptive_enabled',
      request_params: {
        max_tokens: 2000,
        temperature: 0,
        thinking: {
          type: 'enabled',
          adaptive: { enabled: true },
          budget_tokens: 8000,
          max_tokens: 2000,
        },
        expected_error_required_all: ['enabled', 'not supported', 'output_config.effort'],
        expected_error_variant_any: ['temperature may only be set to 1 when thinking is enabled', 'temperature', 'thinking'],
        expected_error_missing_label: 'thinking_adaptive_enabled_not_rejected',
        expected_error_variant_label: 'provider_error_variant',
        expected_error_unexpected_label: 'thinking_adaptive_enabled_wrong_error',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/channels/ch_1/model-request-test',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('组合纯度检测 · thinking_temperature'),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/channels/ch_1/model-request-test',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('web_search_20260209'),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/channels/ch_1/model-request-test',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('thinking_adaptive_enabled'),
      }),
    );
    const thinkingBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const webSearchBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const adaptiveBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(thinkingBody.request_params.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(thinkingBody.request_params.tools).toBeUndefined();
    expect(webSearchBody.request_params.tools[0].type).toBe('web_search_20260209');
    expect(webSearchBody.request_params.thinking).toBeUndefined();
    expect(adaptiveBody.request_params.thinking.adaptive).toEqual({ enabled: true });
    expect(adaptiveBody.request_params.tools).toBeUndefined();
    fetchMock.mockRestore();
  });

  it('sends the thinking adaptive enabled purity probe through the model request endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: { id: 'run_adaptive', suite_id: 'manual_model_request_probe', name: 'adaptive', mode: 'manual_probe', test_scope: 'quick', status: 'completed', repeat_count: 1, concurrency: 1, total_jobs: 1, completed_jobs: 1 },
          result: { id: 'res_adaptive', run_id: 'run_adaptive', test_case_id: 'case_1', channel_id: 'ch_1', attempt_index: 1, score: 100 },
          message_id: null,
          message_channel_type: 'Unknown',
          request_protocol: 'anthropic_messages',
          provider_endpoint: 'https://api.example/v1/messages',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await api.modelRequestTest('ch_1', {
      prompt: '回复OK',
      system_prompt: null,
      run_name: '纯度检测 · thinking_adaptive_enabled',
      request_params: {
        max_tokens: 2000,
        temperature: 0,
        thinking: {
          type: 'enabled',
          adaptive: { enabled: true },
          budget_tokens: 8000,
          max_tokens: 2000,
        },
        expected_error_required_all: ['enabled', 'not supported', 'output_config.effort'],
        expected_error_variant_any: ['temperature may only be set to 1 when thinking is enabled', 'temperature', 'thinking'],
        expected_error_missing_label: 'thinking_adaptive_enabled_not_rejected',
        expected_error_variant_label: 'provider_error_variant',
        expected_error_unexpected_label: 'thinking_adaptive_enabled_wrong_error',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/channels/ch_1/model-request-test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: '回复OK',
          system_prompt: null,
          run_name: '纯度检测 · thinking_adaptive_enabled',
          request_params: {
            max_tokens: 2000,
            temperature: 0,
            thinking: {
              type: 'enabled',
              adaptive: { enabled: true },
              budget_tokens: 8000,
              max_tokens: 2000,
            },
            expected_error_required_all: ['enabled', 'not supported', 'output_config.effort'],
            expected_error_variant_any: ['temperature may only be set to 1 when thinking is enabled', 'temperature', 'thinking'],
            expected_error_missing_label: 'thinking_adaptive_enabled_not_rejected',
            expected_error_variant_label: 'provider_error_variant',
            expected_error_unexpected_label: 'thinking_adaptive_enabled_wrong_error',
          },
        }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('preserves signature interop request ids from the API response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          status: 'pass',
          reason: '兼容',
          source_channel_id: 'source_1',
          relay_channel_id: 'relay_1',
          source_endpoint: 'https://source.example/v1/messages',
          relay_endpoint: 'https://relay.example/v1/messages',
          model: 'claude-opus-4-6',
          thinking_block_count: 1,
          signature_prefixes: ['sig-source'],
          source_message_id: 'msg_bdrk_01source',
          source_message_channel_type: 'AWS Bedrock',
          source_request_id: 'req_source_123',
          relay_message_id: 'msg_vrtx_01relay',
          relay_message_channel_type: 'Vertex',
          relay_request_id: 'req_relay_456',
          relay_raw_excerpt: '{}',
          fallback_note: '',
          steps: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await api.signatureInteropTest({ source_channel_id: 'source_1', relay_channel_id: 'relay_1' });

    expect(result.source_request_id).toBe('req_source_123');
    expect(result.relay_request_id).toBe('req_relay_456');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/channels/signature-interop-test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source_channel_id: 'source_1', relay_channel_id: 'relay_1' }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('creates simplified scheduled patrol tests with fixed probe settings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'sched_1',
          name: 'daily patrol',
          channel_id: 'ch_1',
          suite_id: 'manual_model_request_probe',
          baseline_snapshot_id: 'scheduled_probe_baseline',
          enabled: true,
          interval_minutes: 1440,
          run_window_start: '09:00',
          run_window_end: '18:00',
          test_scope: 'scheduled_probe',
          repeat_count: 1,
          concurrency: 1,
          use_mock: false,
          alert_grade_threshold: 'D',
          alert_score_threshold: null,
          alert_red_flags_enabled: true,
          quiet_minutes: 0,
          max_retries: 0,
          retry_interval_minutes: 5,
          latest_report_id: 'rep_1',
          latest_grade: 'C',
          latest_score: 78,
          latest_probe_summary: {
            model_requests: [
              {
                key: 'thinking_temperature',
                title: 'Thinking temperature 冲突',
                status: 'ok',
                channel_id: 'ch_1',
                channel_name: 'Relay Channel',
                result_id: 'res_1',
                message_id: 'msg_01abc',
                message_channel_type: 'Claude/Anthropic',
                request_protocol: 'anthropic',
                provider_endpoint: 'https://example.test/v1/messages',
                labels: [],
                score: 100,
                error: null,
              },
              {
                key: 'web_search',
                title: 'Web Search tool',
                status: 'error',
                result_id: 'res_2',
                message_id: null,
                message_channel_type: null,
                request_protocol: 'anthropic',
                provider_endpoint: 'https://example.test/v1/messages',
                labels: ['web_search_not_rejected'],
                score: 40,
                error: null,
              },
              {
                key: 'thinking_adaptive_enabled',
                title: 'thinking.adaptive.enabled',
                status: 'ok',
                result_id: 'res_3',
                message_id: 'msg_01adaptive',
                message_channel_type: 'Claude/Anthropic',
                request_protocol: 'anthropic',
                provider_endpoint: 'https://example.test/v1/messages',
                labels: [],
                score: 100,
                error: null,
              },
            ],
            model_request: {
              status: 'ok',
              channel_id: 'ch_1',
              channel_name: 'Relay Channel',
              result_id: 'res_1',
              message_id: 'msg_01abc',
              message_channel_type: 'Claude/Anthropic',
              request_protocol: 'anthropic',
              provider_endpoint: 'https://example.test/v1/messages',
              error: null,
            },
            signature_interop: {
              status: 'pass',
              reason: '兼容',
              source_channel_id: 'aws_bedrock',
              source_channel_name: 'AWS Bedrock Claude',
              relay_channel_id: 'ch_1',
              relay_channel_name: 'Relay Channel',
              source_message_id: 'msg_bdrk_01source',
              source_message_channel_type: 'AWS Bedrock',
              relay_message_id: 'msg_01relay',
              relay_message_channel_type: 'Claude/Anthropic',
              signature_prefixes: ['sig-source'],
            },
            labels: ['patrol_probe_passed'],
            label_explanations: [{ label: 'patrol_probe_passed', description: '自动巡检通过。' }],
            detected_provider_hint: '疑似 Claude/Anthropic',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await api.createScheduledTest({
      name: 'daily patrol',
      channel_id: 'ch_1',
      interval_minutes: 1440,
      run_window_start: '09:00',
      run_window_end: '18:00',
      enabled: true,
      test_scope: 'scheduled_probe',
      repeat_count: 1,
      concurrency: 1,
      use_mock: false,
      alert_grade_threshold: 'D',
      alert_score_threshold: null,
      alert_red_flags_enabled: true,
      quiet_minutes: 0,
      max_retries: 0,
      retry_interval_minutes: 5,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/scheduled-tests',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'daily patrol',
          channel_id: 'ch_1',
          interval_minutes: 1440,
          run_window_start: '09:00',
          run_window_end: '18:00',
          enabled: true,
          test_scope: 'scheduled_probe',
          repeat_count: 1,
          concurrency: 1,
          use_mock: false,
          alert_grade_threshold: 'D',
          alert_score_threshold: null,
          alert_red_flags_enabled: true,
          quiet_minutes: 0,
          max_retries: 0,
          retry_interval_minutes: 5,
        }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('lists alerts with locator id and time range filters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await api.alerts({
      status: 'pending_review',
      id_query: 'req_locator_123',
      created_from: '2026-05-15T00:00:00.000Z',
      created_to: '2026-05-16T00:00:00.000Z',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/alerts?status=pending_review&id_query=req_locator_123&created_from=2026-05-15T00%3A00%3A00.000Z&created_to=2026-05-16T00%3A00%3A00.000Z',
      expect.any(Object),
    );
    fetchMock.mockRestore();
  });

  it('deletes one alert', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await api.deleteAlert('alert_1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/alerts/alert_1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    fetchMock.mockRestore();
  });

  it('bulk deletes selected alerts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deleted: 2, missing: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await api.deleteAlerts(['alert_1', 'alert_2']);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/alerts/bulk-delete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: ['alert_1', 'alert_2'] }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('deletes one report', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await api.deleteReport('rep_1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reports/rep_1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    fetchMock.mockRestore();
  });

  it('bulk deletes selected reports', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deleted: 2, missing: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await api.deleteReports(['rep_1', 'rep_2']);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reports/bulk-delete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: ['rep_1', 'rep_2'] }),
      }),
    );
    fetchMock.mockRestore();
  });
});
