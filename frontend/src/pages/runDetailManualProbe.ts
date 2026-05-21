import { formatChannelDisplayName } from '../channelCredentials';

export const MANUAL_PROBE_COMBO_PREFIX = '组合纯度检测 ·';

type ManualProbeSummaryRow = {
  label: string;
  value: string;
};

type ManualProbeChannelRow = {
  channelName: string;
  channelDisplayName?: string | null;
  channelId: string;
};

export function isComboManualProbeRun(runName?: string | null, rowCount = 0) {
  return Boolean(runName?.startsWith(MANUAL_PROBE_COMBO_PREFIX)) || rowCount > 1;
}

export function manualProbeSummaryRows(runName: string, rows: ManualProbeChannelRow[], totalJobs: number): ManualProbeSummaryRow[] {
  const isCombo = isComboManualProbeRun(runName, rows.length);
  const firstRow = rows[0];
  const targetChannel = firstRow
    ? (firstRow.channelDisplayName ?? formatChannelDisplayName({ id: firstRow.channelId, name: firstRow.channelName }))
    : '-';
  const total = totalJobs || rows.length;
  return [
    { label: '详情类型', value: isCombo ? '组合纯度检测日志' : '单项参数报错日志' },
    { label: '检测范围', value: isCombo ? '组合纯度检测' : '参数报错探针' },
    { label: '目标渠道', value: targetChannel },
    { label: '已返回日志', value: `${rows.length} / ${total}` },
  ];
}
