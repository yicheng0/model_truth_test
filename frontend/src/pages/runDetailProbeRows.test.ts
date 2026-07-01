import { describe, expect, it } from 'vitest';
import type { Result, TestCase } from '../types';
import { buildModuleGroups, buildProbeDetailRows } from './runDetailProbeRows';

function makeCase(id: string, module: string, title: string): TestCase {
  return { id, suite_id: 's1', module, title } as TestCase;
}

function makeResult(id: string, testCaseId: string, score: number, extra: Partial<Result> = {}): Result {
  return {
    id,
    run_id: 'run_1',
    test_case_id: testCaseId,
    channel_id: 'ch_1',
    attempt_index: 1,
    score,
    ...extra,
  } as Result;
}

describe('buildProbeDetailRows', () => {
  it('marks score 100 as passed and passes labels through', () => {
    const caseById = new Map([['c1', makeCase('c1', 'protocol', '协议结构探针')]]);
    const results = [makeResult('r1', 'c1', 100, { labels: ['provider_error_variant'] })];

    const rows = buildProbeDetailRows(results, caseById);

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('协议结构探针');
    expect(rows[0].module).toBe('protocol');
    expect(rows[0].passed).toBe(true);
    expect(rows[0].labels).toEqual(['provider_error_variant']);
  });

  it('marks non-100 score as failed and falls back to test_case_id when case missing', () => {
    const rows = buildProbeDetailRows([makeResult('r2', 'unknown_case', 42)], new Map());

    expect(rows[0].passed).toBe(false);
    expect(rows[0].title).toBe('unknown_case');
    expect(rows[0].module).toBe('unknown');
    expect(rows[0].labels).toEqual([]);
  });
});

describe('buildModuleGroups', () => {
  it('aggregates pass/total per module and honors the provided order', () => {
    const caseById = new Map([
      ['c1', makeCase('c1', 'reasoning', 'A')],
      ['c2', makeCase('c2', 'protocol', 'B')],
      ['c3', makeCase('c3', 'protocol', 'C')],
    ]);
    const results = [
      makeResult('r1', 'c1', 100),
      makeResult('r2', 'c2', 100),
      makeResult('r3', 'c3', 0),
    ];

    const groups = buildModuleGroups(results, caseById, ['protocol', 'reasoning']);

    expect(groups).toEqual([
      { module: 'protocol', pass: 1, total: 2 },
      { module: 'reasoning', pass: 1, total: 1 },
    ]);
  });
});
