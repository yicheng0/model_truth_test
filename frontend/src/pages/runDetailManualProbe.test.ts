import { describe, expect, it } from 'vitest';
import { isComboManualProbeRun, manualProbeSummaryRows } from './runDetailManualProbe';

describe('manual probe run detail summary', () => {
  it('uses combo purity copy for single saved combo probe runs', () => {
    const rows = [{ channelName: 'Claude Gateway', channelId: 'ch_1' }];

    expect(isComboManualProbeRun('组合纯度检测 · thinking_temperature', rows.length)).toBe(true);
    expect(manualProbeSummaryRows('组合纯度检测 · thinking_temperature', rows, 1)).toEqual([
      { label: '详情类型', value: '组合纯度检测日志' },
      { label: '检测范围', value: '组合纯度检测' },
      { label: '目标渠道', value: 'Claude Gateway (ch_1)' },
      { label: '已返回日志', value: '1 / 1' },
    ]);
  });

  it('uses single-probe copy for regular manual probe runs', () => {
    const rows = [{ channelName: 'Claude Gateway', channelId: 'ch_1' }];

    expect(isComboManualProbeRun('纯度检测 · web_search', rows.length)).toBe(false);
    expect(manualProbeSummaryRows('纯度检测 · web_search', rows, 1)).toEqual([
      { label: '详情类型', value: '单项参数报错日志' },
      { label: '检测范围', value: '参数报错探针' },
      { label: '目标渠道', value: 'Claude Gateway (ch_1)' },
      { label: '已返回日志', value: '1 / 1' },
    ]);
  });

  it('keeps compatibility for grouped manual probe rows', () => {
    const rows = [
      { channelName: 'Claude Gateway', channelId: 'ch_1' },
      { channelName: 'Claude Gateway', channelId: 'ch_1' },
    ];

    expect(isComboManualProbeRun('手动模型请求 · Claude Gateway', rows.length)).toBe(true);
    expect(manualProbeSummaryRows('手动模型请求 · Claude Gateway', rows, 3)).toContainEqual({ label: '已返回日志', value: '2 / 3' });
  });
});
