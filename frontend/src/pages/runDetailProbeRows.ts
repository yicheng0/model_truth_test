import type { Result, TestCase } from '../types';
import { responseSnippet } from './runDetailUtils';

export type ProbeDetailRow = {
  key: string;
  title: string;
  module: string;
  passed: boolean;
  score: number;
  labels: string[];
  outputSummary: string;
};

export type ModuleGroup = {
  module: string;
  pass: number;
  total: number;
};

/**
 * Build per-probe detail rows for the RunDetail "探针输出与结果" section.
 *
 * Each row surfaces the probe title, pass/fail status, hit signals (labels)
 * and a redacted output snippet, so the section matches its promise instead of
 * only showing module-level pass counts.
 */
export function buildProbeDetailRows(
  results: Result[],
  caseById: Map<string, TestCase>,
): ProbeDetailRow[] {
  return results.map((result) => {
    const caseItem = caseById.get(result.test_case_id);
    return {
      key: result.id,
      title: caseItem?.title ?? result.test_case_id,
      module: caseItem?.module ?? 'unknown',
      passed: result.score === 100,
      score: result.score,
      labels: result.labels ?? [],
      outputSummary: responseSnippet(result),
    };
  });
}

/**
 * Compact module-level pass/total summary shown above the per-probe table.
 * Ordering follows the platform's canonical module order, then any extras.
 */
export function buildModuleGroups(
  results: Result[],
  caseById: Map<string, TestCase>,
  moduleOrder: string[] = [],
): ModuleGroup[] {
  const groups = new Map<string, { pass: number; total: number }>();
  for (const result of results) {
    const module = caseById.get(result.test_case_id)?.module ?? 'unknown';
    const current = groups.get(module) ?? { pass: 0, total: 0 };
    current.total += 1;
    if (result.score === 100) current.pass += 1;
    groups.set(module, current);
  }
  const ordered = [...new Set([...moduleOrder, ...groups.keys()])].filter((module) => groups.has(module));
  return ordered.map((module) => ({ module, ...groups.get(module)! }));
}
