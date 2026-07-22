import { describe, expect, it } from 'vitest';
import { formatHealthReason, healthDimensionLabel, healthStatusColor, healthStatusLabel } from './channelHealthProfile';

describe('channel health profile mappings', () => {
  it('maps statuses and dimensions to stable UI labels', () => {
    expect(healthStatusLabel('stale')).toBe('数据过期');
    expect(healthStatusColor('critical')).toBe('red');
    expect(healthDimensionLabel('availability')).toBe('运行健康');
  });

  it('keeps unknown evidence codes visible', () => {
    expect(formatHealthReason('new_signal')).toBe('new_signal');
    expect(formatHealthReason('degraded_two_windows')).toBe('连续两个窗口异常');
  });
});
