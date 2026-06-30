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
      patrol_modules: ['signature_interop'],
      model_request_probe_keys: null,
    });
  });

  it('preserves selected patrol modules in the scheduled patrol payload', () => {
    expect(
      buildScheduleBasePayload({
        name: 'signature only patrol',
        channel_id: 'ch_1',
        interval_minutes: 60,
        patrol_modules: ['signature_interop', 'model_request_probes'],
        enabled: true,
      }),
    ).toMatchObject({
      patrol_modules: ['signature_interop', 'model_request_probes'],
      test_scope: 'scheduled_probe',
    });
  });

  it('keeps an explicit model-request sub-probe subset when that module is enabled', () => {
    expect(
      buildScheduleBasePayload({
        name: 'subset patrol',
        channel_id: 'ch_1',
        interval_minutes: 60,
        patrol_modules: ['model_request_probes'],
        model_request_probe_keys: ['web_search', 'thinking_temperature'],
        enabled: true,
      }),
    ).toMatchObject({
      model_request_probe_keys: ['web_search', 'thinking_temperature'],
    });
  });

  it('drops sub-probe keys when the model-request module is not selected', () => {
    expect(
      buildScheduleBasePayload({
        name: 'signature only',
        channel_id: 'ch_1',
        interval_minutes: 60,
        patrol_modules: ['signature_interop'],
        model_request_probe_keys: ['web_search'],
        enabled: true,
      }),
    ).toMatchObject({ model_request_probe_keys: null });
  });

  it('rejects an empty sub-probe selection when the model-request module is enabled', () => {
    expect(() =>
      buildScheduleBasePayload({
        name: 'empty subset',
        channel_id: 'ch_1',
        interval_minutes: 60,
        patrol_modules: ['model_request_probes'],
        model_request_probe_keys: [],
        enabled: true,
      }),
    ).toThrow('请至少选择一个真实请求子探针');
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
