import { describe, expect, it } from 'vitest';
import api from './api.ts?raw';
import app from './App.tsx?raw';
import maintenance from './components/SystemMaintenanceModal.tsx?raw';
import createRun from './pages/CreateRun.tsx?raw';
import dashboard from './pages/Dashboard.tsx?raw';
import reportDetail from './pages/ReportDetailPage.tsx?raw';
import reports from './pages/ReportsPage.tsx?raw';
import runDetail from './pages/RunDetail.tsx?raw';
import runs from './pages/Runs.tsx?raw';

describe('standalone channel fingerprint removal', () => {
  it('removes the channel fingerprint page from navigation and routing', () => {
    expect(app).not.toContain("import('./pages/Baselines')");
    expect(app).not.toContain("key: '/baselines'");
    expect(app).not.toContain('path="/baselines"');
  });

  it('removes the unused channel fingerprint management API client', () => {
    expect(api).not.toContain('baselines:');
    expect(api).not.toContain('baselineResults:');
    expect(api).not.toContain('validateBaseline:');
    expect(api).not.toContain('updateBaseline:');
    expect(api).not.toContain('deleteBaseline:');
  });

  it('removes channel fingerprint entry points from the dashboard and run list', () => {
    expect(dashboard).not.toContain("to: '/baselines'");
    expect(dashboard).not.toContain("queryKey: ['baselines']");
    expect(runs).not.toContain('/new-run?mode=baseline');
    expect(runs).not.toContain('提取渠道指纹');
  });

  it('creates a direct comparison instead of a baseline build task', () => {
    expect(createRun).not.toContain("type CreateMode = 'baseline_build'");
    expect(createRun).not.toContain('api.buildBaseline');
    expect(createRun).not.toContain('提取渠道指纹');
    expect(createRun).toContain("mode: 'full_comparison'");
  });

  it('does not expose the removed feature name in remaining user-facing flows', () => {
    for (const file of [dashboard, createRun, runs, runDetail, reports, reportDetail, maintenance]) {
      expect(file).not.toContain('渠道指纹');
    }
  });
});
