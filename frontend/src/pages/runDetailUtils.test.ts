import { describe, expect, it } from 'vitest';
import { shouldShowRunSummaryModule } from './runDetailUtils';

describe('shouldShowRunSummaryModule', () => {
  it('hides the generic report summary module for automatic patrol logs', () => {
    expect(shouldShowRunSummaryModule({ hasSummary: true, isPatrolRun: true, mode: 'manual_probe' })).toBe(false);
  });

  it('keeps the generic report summary module for normal completed runs', () => {
    expect(shouldShowRunSummaryModule({ hasSummary: true, isPatrolRun: false, mode: 'candidate_eval' })).toBe(true);
  });
});
