import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const port = 4174;
const baseUrl = `http://127.0.0.1:${port}`;
const runs = Array.from({ length: 26 }, (_, index) => ({
  id: `patrol_${String(index + 1).padStart(2, '0')}`,
  suite_id: 'suite_1',
  name: `巡检日志 ${index + 1}`,
  mode: 'scheduled_probe',
  test_scope: 'scheduled_probe',
  scheduled_test_id: 'schedule_1',
  patrol_channel_id: index % 2 === 0 ? 'channel_a' : 'channel_b',
  patrol_channel_name: index % 2 === 0 ? '渠道 A' : '渠道 B',
  status: 'completed',
  repeat_count: 1,
  concurrency: 1,
  total_jobs: 1,
  completed_jobs: 1,
  created_at: `2026-08-11T00:${String(index).padStart(2, '0')}:00Z`,
}));

const devServer = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: new URL('..', import.meta.url),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
devServer.stdout.on('data', (chunk) => process.stderr.write(`VITE ${chunk}`));
devServer.stderr.on('data', (chunk) => process.stderr.write(`VITE_ERR ${chunk}`));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite did not start on ${baseUrl}`);
}

try {
  await waitForServer();
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();
  await page.route('**/api/runs**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(runs) }));
  await page.route('**/api/channels**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/reports/summary', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/runs/*/results', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: {}, run_channels: [], results: [], comparisons: [], baseline_results: [], reports: [] }) }));
  await page.route('**/apipro-logo.svg', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" />' }));

  page.on('console', (message) => console.error('BROWSER', message.type(), message.text()));
  page.on('pageerror', (error) => console.error('PAGEERROR', error.message));
  await page.goto(`${baseUrl}/runs`, { waitUntil: 'load' });
  await page.getByText('自动巡检日志', { exact: true }).waitFor({ timeoutMs: 5000 });
  const tableRows = page.locator('.patrol-log-table .ant-table-tbody > tr:not(.ant-table-measure-row)');
  await page.waitForTimeout(1000);
  if (await tableRows.count() === 0) {
    throw new Error(`巡检日志行未渲染：${await page.locator('body').innerText()}`);
  }
  const firstPageIds = await tableRows.allTextContents();
  assert.equal(firstPageIds.length, 10, '第一页应显示 10 条巡检日志');

  await page.getByRole('listitem', { name: '2' }).click();
  const secondPageIds = await tableRows.allTextContents();
  assert.equal(secondPageIds.length, 10, '第二页应显示 10 条巡检日志');
  assert.notDeepEqual(secondPageIds, firstPageIds, '第二页日志必须与第一页不同');

  const sizeChanger = page.locator('.patrol-log-pagination .ant-select').first();
  await sizeChanger.click();
  await page.getByText('20 条/页', { exact: true }).click();
  const twentyPageIds = await tableRows.allTextContents();
  assert.equal(twentyPageIds.length, 20, '选择 20 条/页后应显示 20 条日志');
} finally {
  await browser?.close();
  devServer.kill('SIGTERM');
}
