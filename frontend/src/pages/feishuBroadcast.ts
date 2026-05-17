import type { FeishuBroadcastUpdate } from '../types';

export type FeishuBroadcastFormValues = {
  enabled?: boolean;
  webhook_url?: string;
  webhook_secret?: string;
  clear_webhook_secret?: boolean;
  app_base_url?: string;
  alert_broadcast_enabled?: boolean;
  daily_report_enabled?: boolean;
  daily_report_time?: { format: (format: string) => string } | null;
  timezone?: string;
};

export type FeishuBroadcastUpdateResult = {
  payload: FeishuBroadcastUpdate;
  missingWebhook: boolean;
};

export function buildFeishuBroadcastUpdate(
  values: FeishuBroadcastFormValues,
  hasExistingWebhook: boolean,
): FeishuBroadcastUpdateResult {
  const webhookUrl = values.webhook_url?.trim();
  const webhookSecret = values.webhook_secret?.trim();
  const appBaseUrl = values.app_base_url?.trim().replace(/\/+$/, '') || null;

  const payload: FeishuBroadcastUpdate = {
    enabled: Boolean(values.enabled),
    clear_webhook_secret: Boolean(values.clear_webhook_secret),
    app_base_url: appBaseUrl,
    alert_broadcast_enabled: Boolean(values.alert_broadcast_enabled),
    daily_report_enabled: Boolean(values.daily_report_enabled),
    daily_report_time: values.daily_report_time?.format('HH:mm') ?? '09:00',
    timezone: values.timezone || 'Asia/Shanghai',
  };

  if (webhookUrl) payload.webhook_url = webhookUrl;
  if (webhookSecret) payload.webhook_secret = webhookSecret;

  return {
    payload,
    missingWebhook: Boolean(values.enabled) && !hasExistingWebhook && !webhookUrl,
  };
}
