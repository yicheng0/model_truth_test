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
});
