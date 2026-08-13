import { describe, expect, it } from 'vitest';
import { patrolProbeStatusColor, patrolProbeStatusText, shouldShowRunSummaryModule } from './runDetailUtils';

describe('shouldShowRunSummaryModule', () => {
  it('hides the generic report summary module for automatic patrol logs', () => {
    expect(shouldShowRunSummaryModule({ hasSummary: true, isPatrolRun: true, mode: 'manual_probe' })).toBe(false);
  });

  it('keeps the generic report summary module for normal completed runs', () => {
    expect(shouldShowRunSummaryModule({ hasSummary: true, isPatrolRun: false, mode: 'candidate_eval' })).toBe(true);
  });
});

describe('patrol probe detail status', () => {
  it('shows HTTP 500 temporary upstream failures as non-anomalous', () => {
    const item = {
      status: 'error',
      labels: [],
      error: "Server error '500 Internal Server Error' for url 'https://api.example.com/v1/messages'",
      responseText: 'Upstream service temporarily unavailable',
      rawResponseText: null,
    };

    expect(patrolProbeStatusText(item)).toBe('正常');
    expect(patrolProbeStatusColor(item)).toBe('green');
  });

  it.each([
    '503 Service Unavailable',
    'request timeout while connecting to upstream',
    'network connection reset by peer',
  ])('shows operational failure %s as non-anomalous', (error) => {
    const item = { status: 'error', labels: [], error, responseText: null, rawResponseText: null };
    expect(patrolProbeStatusText(item)).toBe('正常');
    expect(patrolProbeStatusColor(item)).toBe('green');
  });

  it('keeps native parameter rejection and unknown failures distinct', () => {
    const nativeRejection = {
      status: 'error',
      labels: ['provider_error_variant'],
      error: '400 Bad Request: temperature is not supported',
      responseText: null,
      rawResponseText: null,
    };
    const unknownFailure = {
      status: 'error',
      labels: [],
      error: 'unexpected response shape',
      responseText: null,
      rawResponseText: null,
    };

    expect(patrolProbeStatusText(nativeRejection)).toBe('参数不支持');
    expect(patrolProbeStatusColor(nativeRejection)).toBe('gold');
    expect(patrolProbeStatusText(unknownFailure)).toBe('异常');
    expect(patrolProbeStatusColor(unknownFailure)).toBe('red');
  });
});
