import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { labelDescription } from './claudeCodeDiagnostics';
import type { ClaudeCodeHistoryFilters, ClaudeCodeHistoryItem } from './types';

export type ClaudeCodeHistoryDayGroup = {
  date: string;
  runCount: number;
  passCount: number;
  failCount: number;
  warningCount: number;
  skippedCount: number;
  items: ClaudeCodeHistoryItem[];
};

type ClaudeCodeProbeLike = {
  status?: string | null;
  labels?: string[] | null;
  reason?: string | null;
  error_detail?: string | null;
  evidence_excerpt?: string | null;
  detail?: string | null;
};

export function localDayRangeIso(range: [Dayjs, Dayjs] | null): ClaudeCodeHistoryFilters {
  if (!range) return {};
  return {
    from: range[0].startOf('day').toISOString(),
    to: range[1].endOf('day').toISOString(),
  };
}

export function groupClaudeFingerprintHistory(items: ClaudeCodeHistoryItem[]): ClaudeCodeHistoryDayGroup[] {
  const groups = new Map<string, ClaudeCodeHistoryDayGroup>();
  for (const item of items) {
    const date = item.created_at ? dayjs(item.created_at).format('YYYY-MM-DD') : 'unknown';
    const group = groups.get(date) ?? {
      date,
      runCount: 0,
      passCount: 0,
      failCount: 0,
      warningCount: 0,
      skippedCount: 0,
      items: [],
    };
    group.runCount += 1;
    const probes = item.result_payload?.probes ?? [];
    if (probes.length) {
      group.passCount += probes.filter((probe) => probe.status === 'pass').length;
      group.failCount += probes.filter((probe) => probe.status === 'fail').length;
      group.warningCount += probes.filter((probe) => probe.status === 'warning').length;
      group.skippedCount += probes.filter((probe) => probe.status === 'skipped').length;
    } else {
      group.failCount += item.fail_count;
      group.warningCount += item.warning_count;
      group.passCount += Math.max(item.probe_count - item.fail_count - item.warning_count, 0);
    }
    group.items.push(item);
    groups.set(date, group);
  }
  return [...groups.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export function probeDiagnosticText(probe: ClaudeCodeProbeLike): string {
  const reason = probe.reason?.trim();
  const legacyGenericReason = reason === '检测项返回异常，需要结合原始响应复核。'
    || reason === '暂无完整判定原因，请结合标签和原始证据复核。';
  if (reason && !legacyGenericReason) return reason;
  if (legacyGenericReason && probe.labels?.length) {
    return probe.labels.map(labelDescription).join('；');
  }
  if (probe.error_detail?.trim()) return probe.error_detail.trim();
  if (probe.evidence_excerpt?.trim()) return probe.evidence_excerpt.trim();
  if (probe.detail?.trim()) return probe.detail.trim();
  if (probe.status === 'queued') return '等待执行该探针。';
  if (probe.status === 'running') return '正在执行该探针。';
  if (probe.status === 'pass') return '测试通过，未发现该项异常。';
  return '暂无完整判定原因，请结合标签和原始证据复核。';
}
