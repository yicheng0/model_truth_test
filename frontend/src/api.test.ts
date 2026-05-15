import { describe, expect, it, vi } from 'vitest';
import { ApiError, api, getErrorMessage } from './api';

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
      enabled: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/channels',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Custom Gateway',
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

  it('can send both combo purity probes through the existing model request endpoint', async () => {
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
      );

    await api.modelRequestTest('ch_1', {
      prompt: '请用一句话回答：这是 thinking temperature 纯度探针。',
      system_prompt: null,
      run_name: '组合纯度检测 · thinking',
      request_params: {
        max_tokens: 2048,
        temperature: 0.2,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        reasoning_effort: 'medium',
        expected_error_contains: 'temperature may only be set to 1 when thinking is enabled',
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

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/channels/ch_1/model-request-test',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('组合纯度检测 · thinking'),
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
      run_name: 'thinking.adaptive.enabled 纯度检测',
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
        expected_error_missing_label: 'thinking_adaptive_enabled_not_rejected',
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
          run_name: 'thinking.adaptive.enabled 纯度检测',
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
            expected_error_missing_label: 'thinking_adaptive_enabled_not_rejected',
            expected_error_unexpected_label: 'thinking_adaptive_enabled_wrong_error',
          },
        }),
      }),
    );
    fetchMock.mockRestore();
  });
});
