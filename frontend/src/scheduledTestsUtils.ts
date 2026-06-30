import type { ScheduledChannelTestCreate, ScheduledPatrolModule } from './types';

export type ScheduleFormValues = {
  name: string;
  channel_id: string;
  interval_minutes?: number | null;
  patrol_modules?: ScheduledPatrolModule[];
  run_window_enabled?: boolean;
  run_window_start?: string;
  run_window_end?: string;
  enabled: boolean;
};

export type ScheduledProbeSchedulePayload = Required<
  Pick<ScheduledChannelTestCreate, 'name' | 'channel_id' | 'enabled' | 'interval_minutes' | 'test_scope' | 'patrol_modules'>
> &
  Pick<ScheduledChannelTestCreate, 'run_window_start' | 'run_window_end'>;

export function intervalText(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

const DEFAULT_PATROL_MODULES: ScheduledPatrolModule[] = ['signature_interop'];
const ALLOWED_PATROL_MODULES = new Set<ScheduledPatrolModule>(['signature_interop', 'model_request_probes']);

function normalizePatrolModules(value?: ScheduledPatrolModule[]) {
  if (value && !value.length) throw new Error('请至少选择一个巡检模块');
  const source = value ?? DEFAULT_PATROL_MODULES;
  const modules = Array.from(new Set(source.filter((item): item is ScheduledPatrolModule => ALLOWED_PATROL_MODULES.has(item))));
  if (!modules.length) throw new Error('请至少选择一个巡检模块');
  return modules;
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
    patrol_modules: normalizePatrolModules(values.patrol_modules),
  };
}
