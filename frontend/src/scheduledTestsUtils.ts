import type { ScheduledChannelTestCreate } from './types';

export type ScheduleFormValues = {
  name: string;
  channel_id: string;
  interval_minutes?: number | null;
  run_window_enabled?: boolean;
  run_window_start?: string;
  run_window_end?: string;
  enabled: boolean;
};

export type ScheduledProbeSchedulePayload = Required<
  Pick<ScheduledChannelTestCreate, 'name' | 'channel_id' | 'enabled' | 'interval_minutes' | 'test_scope'>
> &
  Pick<ScheduledChannelTestCreate, 'run_window_start' | 'run_window_end'>;

export function intervalText(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

export function buildScheduleBasePayload(values: ScheduleFormValues): ScheduledProbeSchedulePayload {
  if (values.interval_minutes == null) {
    throw new Error('请输入执行间隔');
  }
  const intervalMinutes = Number(values.interval_minutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 43200) {
    throw new Error('执行间隔需在 5 到 43200 分钟之间');
  }
  return {
    name: values.name,
    channel_id: values.channel_id,
    interval_minutes: intervalMinutes,
    run_window_start: values.run_window_enabled ? values.run_window_start : null,
    run_window_end: values.run_window_enabled ? values.run_window_end : null,
    enabled: values.enabled,
    test_scope: 'scheduled_probe',
  };
}
