import { describe, expect, it } from 'vitest';
import { buildFeishuBroadcastUpdate } from './feishuBroadcast';

describe('buildFeishuBroadcastUpdate', () => {
  it('requires a webhook when enabling and none exists yet', () => {
    const result = buildFeishuBroadcastUpdate(
      {
        enabled: true,
        webhook_url: '   ',
        webhook_secret: '',
        clear_webhook_secret: false,
        app_base_url: ' http://localhost:5174/ ',
        alert_broadcast_enabled: true,
        daily_report_enabled: true,
        daily_report_time: { format: () => '09:00' },
        timezone: 'Asia/Shanghai',
      },
      false,
    );

    expect(result.missingWebhook).toBe(true);
    expect(result.payload).toMatchObject({
      enabled: true,
      app_base_url: 'http://localhost:5174',
      alert_broadcast_enabled: true,
      daily_report_enabled: true,
      daily_report_time: '09:00',
      timezone: 'Asia/Shanghai',
    });
    expect(result.payload.webhook_url).toBeUndefined();
  });

  it('preserves an existing webhook when the field is left blank', () => {
    const result = buildFeishuBroadcastUpdate(
      {
        enabled: true,
        webhook_url: '',
        webhook_secret: ' secret-value ',
        clear_webhook_secret: false,
        app_base_url: '',
        alert_broadcast_enabled: true,
        daily_report_enabled: false,
        daily_report_time: { format: () => '18:30' },
        timezone: 'Asia/Shanghai',
      },
      true,
    );

    expect(result.missingWebhook).toBe(false);
    expect(result.payload).toMatchObject({
      enabled: true,
      webhook_secret: 'secret-value',
      app_base_url: null,
      alert_broadcast_enabled: true,
      daily_report_enabled: false,
      daily_report_time: '18:30',
      timezone: 'Asia/Shanghai',
    });
    expect(result.payload.webhook_url).toBeUndefined();
  });
});
