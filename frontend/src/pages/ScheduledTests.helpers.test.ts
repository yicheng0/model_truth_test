import { describe, expect, it } from 'vitest';
import { probeClassificationColor, probeSummary, toggleTableRowKey } from './ScheduledTests.helpers';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScheduledChannelTest } from '../types';

describe('toggleTableRowKey', () => {
  it('adds an unselected row key', () => {
    expect(toggleTableRowKey(['alert_1'], 'alert_2')).toEqual(['alert_1', 'alert_2']);
  });

  it('removes a selected row key using string comparison', () => {
    expect(toggleTableRowKey(['1', 'alert_2'], '1')).toEqual(['alert_2']);
  });
});

describe('probeSummary', () => {
  it('shows operational failures without rendering them as authenticity anomalies', () => {
    const schedule = {
      last_status: 'completed',
      latest_probe_summary: {
        classification_status: 'operational_issue',
        classification_label: '资源暂不可用',
        labels: ['provider_temporarily_unavailable'],
        model_requests: [{ error: '503 No available channel', labels: ['provider_temporarily_unavailable'] }],
        signature_interop: { status: 'fail' },
      },
    } as ScheduledChannelTest;

    const html = renderToStaticMarkup(probeSummary(schedule));

    expect(html).toContain('资源暂不可用');
    expect(html).not.toContain('异常</span>');
  });

  it('uses non-error colors for operational statuses', () => {
    expect(probeClassificationColor('operational_issue', '资源暂不可用')).toBe('orange');
    expect(probeClassificationColor('operational_issue', '额度不足')).toBe('gold');
    expect(probeClassificationColor('operational_issue', '检测失败')).toBe('default');
  });
});
