import { describe, expect, it } from 'vitest';
import { toggleTableRowKey } from './ScheduledTests.helpers';

describe('toggleTableRowKey', () => {
  it('adds an unselected row key', () => {
    expect(toggleTableRowKey(['alert_1'], 'alert_2')).toEqual(['alert_1', 'alert_2']);
  });

  it('removes a selected row key using string comparison', () => {
    expect(toggleTableRowKey(['1', 'alert_2'], '1')).toEqual(['alert_2']);
  });
});
