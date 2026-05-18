import { describe, expect, it } from 'vitest';
import { buildScheduleBasePayload, intervalText } from './scheduledTestsUtils';

describe('scheduled test utilities', () => {
  it('formats schedule intervals by their minute value', () => {
    expect(intervalText(60)).toBe('1 小时');
    expect(intervalText(120)).toBe('2 小时');
    expect(intervalText(1440)).toBe('1 天');
    expect(intervalText(90)).toBe('90 分钟');
  });

  it('keeps edited minute intervals in the scheduled patrol payload', () => {
    expect(
      buildScheduleBasePayload({
        name: '9335-阿宝-aws',
        channel_id: '9335-tokenflow-aws',
        interval_minutes: 60,
        run_window_enabled: false,
        run_window_start: '09:00',
        run_window_end: '18:00',
        enabled: true,
      }),
    ).toEqual({
      name: '9335-阿宝-aws',
      channel_id: '9335-tokenflow-aws',
      interval_minutes: 60,
      run_window_start: null,
      run_window_end: null,
      enabled: true,
      test_scope: 'scheduled_probe',
    });
  });

  it('rejects missing interval values before submit', () => {
    expect(() =>
      buildScheduleBasePayload({
        name: 'bad patrol',
        channel_id: 'ch_1',
        interval_minutes: undefined,
        enabled: true,
      }),
    ).toThrow('请输入执行间隔');
  });

  it('rejects invalid interval values before submit', () => {
    expect(() =>
      buildScheduleBasePayload({
        name: 'bad patrol',
        channel_id: 'ch_1',
        interval_minutes: 0,
        enabled: true,
      }),
    ).toThrow('执行间隔需在 5 到 43200 分钟之间');
  });
});
