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

  it('creates channels with a custom provider type', async () => {
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
});
