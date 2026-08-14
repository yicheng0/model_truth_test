import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const port = 4174;
const baseUrl = `http://127.0.0.1:${port}`;
const runs = Array.from({ length: 65 }, (_, index) => ({
  id: `patrol_${String(index + 1).padStart(2, '0')}`,
  suite_id: 'suite_1',
  name: `巡检日志 ${index + 1}`,
  mode: 'scheduled_probe',
  test_scope: 'scheduled_probe',
  scheduled_test_id: 'schedule_1',
  patrol_channel_id: index % 2 === 0 ? 'channel_a' : 'channel_b',
  patrol_channel_name: index % 2 === 0 ? '渠道 A' : '渠道 B',
  status: index === 63 ? 'pending' : index === 64 ? 'running' : 'completed',
  repeat_count: 1,
  concurrency: 1,
  total_jobs: 1,
  completed_jobs: 1,
  created_at: `2026-08-11T00:${String(index).padStart(2, '0')}:00Z`,
}));

const evidenceByRunId = {
  patrol_01: {
    labels: ['quality_regression'],
    model_requests: [{ status: 'fail', labels: [], error: 'unexpected response shape from upstream' }],
  },
  patrol_02: {
    labels: ['provider_request_failed'],
    model_requests: [{ status: 'error', labels: ['provider_request_failed'], error: '503 Service Unavailable' }],
  },
  patrol_03: {
    labels: ['signature_interop_failed'],
    model_requests: [],
    signature_interop: { status: 'fail', error_http_status: 400, raw_error: 'Invalid `signature` in `thinking` block' },
  },
  patrol_04: {
    labels: ['provider_request_failed'],
    model_requests: [],
    signature_interop: { status: 'fail', raw_error: 'signature validation timed out while connecting to upstream' },
  },
  patrol_05: {
    labels: ['provider_request_failed', 'signature_interop_failed'],
    model_requests: [{ status: 'error', labels: ['provider_request_failed'], error: '该渠道已被禁用' }],
    signature_interop: { status: 'fail', signature_ok: null, error_http_status: 403, raw_error: '该渠道已被禁用' },
  },
  patrol_06: {
    labels: ['quality_regression'],
    model_requests: [{ status: 'fail', labels: [], error: 'context constraint was not followed' }],
  },
};

function runResultsPayload(runId) {
  const evidence = evidenceByRunId[runId] ?? {
    labels: ['patrol_probe_passed'],
    model_requests: [{ status: 'ok', labels: [] }],
  };
  return {
    run: runs.find((run) => run.id === runId) ?? {},
    run_channels: [],
    results: [],
    comparisons: [],
    baseline_results: [],
    reports: [{
      id: `report_${runId}`,
      run_id: runId,
      channel_id: 'channel_a',
      final_score: 100,
      grade: 'A',
      summary: '自动巡检完成',
      evidence: { test_scope: 'scheduled_probe', ...evidence },
    }],
  };
}

const devServer = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: new URL('..', import.meta.url),
  detached: true,
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const detailRequests = [];
  const patrolRequests = [];
  const anomalyRequests = [];
  const deleteRequests = [];
  const deletedRunIds = new Set();
  await page.route('**/api/runs/patrol/anomalies**', async (route) => {
    const url = new URL(route.request().url());
    const channelId = url.searchParams.get('channel_id');
    anomalyRequests.push(channelId ?? 'all');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const anomalyItems = {
      kiro: [{ run_id: 'patrol_52', run_name: '巡检日志 52', channel_id: 'channel_b', channel_name: '渠道 B', request_ids: ['req-kiro-52'], stage: 'identity_self_report' }],
      signature: [{ run_id: 'patrol_03', run_name: '巡检日志 3', channel_id: 'channel_a', channel_name: '渠道 A', request_ids: ['req-signature-3'], http_status: 400, stage: 'relay' }],
    };
    const kiroItems = anomalyItems.kiro.filter((item) => !channelId || item.channel_id === channelId);
    const signatureItems = anomalyItems.signature.filter((item) => !channelId || item.channel_id === channelId);
    const strictItems = [
      ...kiroItems.map((item) => ({ kind: 'kiro_identity_leak', ...item })),
      ...signatureItems.map((item) => ({ kind: 'invalid_thinking_signature', ...item })),
    ];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      strict_total: strictItems.length,
      strict_items: strictItems,
      kiro_identity_leak: { count: kiroItems.length, items: kiroItems, truncated: false },
      invalid_thinking_signature: { count: signatureItems.length, items: signatureItems, truncated: false },
    }) });
  });
  await page.route('**/api/runs/patrol**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/runs/patrol/anomalies') return route.fallback();
    const pageNumber = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('page_size') ?? '10');
    const channelId = url.searchParams.get('channel_id');
    const errorsOnly = url.searchParams.get('errors_only') === 'true';
    patrolRequests.push(`${pageNumber}:${pageSize}:${channelId ?? 'all'}:${errorsOnly}`);
    const errorIds = new Set(['patrol_01', 'patrol_03', 'patrol_05', 'patrol_06', 'patrol_52']);
    const filtered = runs.filter((run) => !deletedRunIds.has(run.id) && (!channelId || run.patrol_channel_id === channelId) && (!errorsOnly || errorIds.has(run.id)));
    const start = (pageNumber - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize).map((run) => ({
      ...run,
      display_state: errorIds.has(run.id) ? 'error' : 'ok',
      needs_review: errorIds.has(run.id),
      has_evidence: true,
    }));
    const deletableCount = filtered.filter((run) => run.status !== 'pending' && run.status !== 'running').length;
    const channelErrorCount = runs.filter((run) => !deletedRunIds.has(run.id) && (!channelId || run.patrol_channel_id === channelId) && errorIds.has(run.id)).length;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, total: filtered.length, error_count: channelErrorCount, deletable_count: deletableCount, anomaly_summary: {}, page: pageNumber, page_size: pageSize }) });
  });
  await page.route('**/api/runs/bulk-delete', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    const ids = Array.isArray(payload.ids) ? payload.ids : [];
    deleteRequests.push(ids);
    ids.forEach((id) => deletedRunIds.add(id));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: ids.length, missing: [], failed: {} }) });
  });
  await page.route('**/api/runs**', (route) => {
    if (new URL(route.request().url()).pathname !== '/api/runs') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(runs.filter((run) => !deletedRunIds.has(run.id)) ) });
  });
  await page.route('**/api/channels**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
    { id: 'channel_a', name: '渠道 A', provider_type: 'anthropic', role: 'candidate', enabled: true, is_reference: false, auth_config: {} },
    { id: 'channel_b', name: '渠道 B', provider_type: 'anthropic', role: 'candidate', enabled: true, is_reference: false, auth_config: {} },
    { id: 'channel_c', name: '渠道 C', provider_type: 'anthropic', role: 'candidate', enabled: true, is_reference: false, auth_config: {} },
  ]) }));
  await page.route('**/api/reports/summary', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/runs/*/results', (route) => {
    const runId = new URL(route.request().url()).pathname.split('/').at(-2);
    detailRequests.push(runId);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(runResultsPayload(runId)) });
  });
  await page.route('**/apipro-logo.svg', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" />' }));

  page.on('console', (message) => console.error('BROWSER', message.type(), message.text()));
  page.on('pageerror', (error) => console.error('PAGEERROR', error.message));
  await page.goto(`${baseUrl}/runs`, { waitUntil: 'load' });
  await page.getByText('检测任务列表', { exact: true }).waitFor({ timeout: 5000 });
  const topErrorSummary = page.getByTestId('patrol-top-error-summary');
  await topErrorSummary.waitFor({ timeout: 5000 });
  await topErrorSummary.getByText('错误日志（2）', { exact: true }).waitFor({ timeout: 5000 });
  assert.match(await topErrorSummary.innerText(), /错误日志（2）/, '检测任务列表顶部只应统计严格异常');
  await topErrorSummary.getByText('Kiro 身份泄漏', { exact: true }).waitFor({ timeout: 5000 });
  await topErrorSummary.getByText('Thinking Signature 无效', { exact: true }).waitFor({ timeout: 5000 });
  assert.doesNotMatch(await topErrorSummary.innerText(), /巡检异常|该渠道已被禁用|unexpected response shape|Invalid `signature`/, '顶部不应混入运营故障、通用错误或完整错误正文');
  assert.equal(await page.getByRole('link', { name: '巡检日志 52' }).first().getAttribute('href'), '/runs/patrol_52', '顶部任务应链接到详情页');
  assert.equal(await page.getByRole('link', { name: '巡检日志 3' }).first().getAttribute('href'), '/runs/patrol_03', '顶部 Signature 任务应链接到详情页');
  assert.equal(detailRequests.length, 0, '点击顶部任务前不应请求完整巡检结果');
  await page.getByRole('link', { name: '巡检日志 3' }).first().click();
  await page.waitForURL(`${baseUrl}/runs/patrol_03`);
  await page.waitForFunction(() => document.body.innerText.length > 0);
  assert.deepEqual(detailRequests, ['patrol_03'], '点击顶部任务应直接请求对应详情');
  await page.goto(`${baseUrl}/runs`, { waitUntil: 'load' });
  await page.getByTestId('patrol-top-error-summary').getByText('错误日志（2）', { exact: true }).waitFor({ timeout: 5000 });
  detailRequests.length = 0;
  assert.equal(await topErrorSummary.locator('.ant-table-tbody > tr:not(.ant-table-measure-row)').count(), 2, '顶部只应展示严格异常');
  assert.equal(patrolRequests.filter((request) => request === '1:10:all:true').length, 0, '首屏不应额外请求通用错误分页作为顶部摘要');
  const initialAnomalyRequestCount = anomalyRequests.length;
  const viewAllErrors = topErrorSummary.getByRole('button', { name: '查看全部异常' });
  const linkedErrorFilter = page.getByRole('button', { name: /只看错误/ });
  const previousErrorFilterState = await linkedErrorFilter.getAttribute('aria-pressed');
  await viewAllErrors.click();
  await page.waitForTimeout(900);
  assert.equal(await linkedErrorFilter.getAttribute('aria-pressed'), previousErrorFilterState, '查看全部异常不应改变下方通用错误筛选');
  const linkedAnomalyBox = await page.getByTestId('patrol-strict-anomaly-summary').boundingBox();
  assert.ok(linkedAnomalyBox && linkedAnomalyBox.y < 320, '查看全部异常应滚动到下方严格异常区域');
  assert.equal(anomalyRequests.length, initialAnomalyRequestCount, '查看全部异常不应重复请求摘要');
  await page.getByText('自动巡检日志', { exact: true }).waitFor({ timeoutMs: 5000 });
  const tableRows = page.locator('.patrol-log-table .ant-table-tbody > tr:not(.ant-table-measure-row)');
  await page.waitForTimeout(1000);
  assert.equal(detailRequests.length, 0, '列表首屏不应请求任何完整巡检结果');
  const initialBodyText = await page.locator('.patrol-log-table').innerText();
  assert.doesNotMatch(initialBodyText, /兼容：|relay 请求失败|Server error|Internal Server Error/, '默认巡检列表不应展示错误说明正文');
  if (await tableRows.count() === 0) {
    throw new Error(`巡检日志行未渲染：${await page.locator('body').innerText()}`);
  }
  const firstPageIds = await tableRows.allTextContents();
  assert.equal(firstPageIds.length, 10, '第一页应显示 10 条巡检日志');
  assert.ok(anomalyRequests.length >= 1, '异常摘要应通过独立接口加载');
  const deleteSelected = page.getByRole('button', { name: '删除已选巡检日志（0）' });
  const deleteRange = page.getByRole('button', { name: '删除当前范围（63）' });
  await deleteSelected.waitFor();
  await deleteRange.waitFor();
  assert.equal(await deleteSelected.isDisabled(), true, '未选择日志时删除已选应禁用');
  const deleteHelp = page.getByTestId('patrol-delete-selected-help');
  assert.equal(await deleteHelp.getAttribute('aria-label'), '请先勾选已结束日志', '键盘和读屏应能获知禁用原因');
  await deleteHelp.hover();
  await page.getByText('请先勾选已结束日志', { exact: true }).waitFor();
  const toolbar = page.locator('.patrol-log-toolbar');
  const patrolCard = page.locator('.patrol-log-card');
  const toolbarBox = await toolbar.boundingBox();
  const cardBox = await patrolCard.boundingBox();
  const selectedBox = await deleteSelected.boundingBox();
  const rangeBox = await deleteRange.boundingBox();
  assert.ok(toolbarBox && cardBox && selectedBox && rangeBox, '删除工具栏、卡片和按钮应可见');
  assert.ok(selectedBox.x + selectedBox.width <= toolbarBox.x + toolbarBox.width + 1, '删除已选按钮不应被工具栏裁切');
  assert.ok(rangeBox.x + rangeBox.width <= toolbarBox.x + toolbarBox.width + 1, '删除当前范围按钮不应被工具栏裁切');
  assert.ok(toolbarBox.x >= cardBox.x && toolbarBox.x + toolbarBox.width <= cardBox.x + cardBox.width + 1, '工具栏整体不应溢出巡检卡片');
  assert.ok(cardBox.x + cardBox.width <= 1001, '巡检卡片不应溢出窄视口');
  for (const control of [
    page.getByRole('combobox', { name: '自动巡检日志渠道筛选' }),
    page.getByRole('button', { name: /只看错误/ }),
    deleteSelected,
    deleteRange,
  ]) {
    assert.equal(await control.isVisible(), true, '窄视口下筛选和删除控件均应可见');
  }
  for (const button of [deleteSelected, deleteRange]) {
    const isTextClipped = await button.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    assert.equal(isTextClipped, false, '删除按钮文字不应被裁切');
  }

  const firstRowCheckbox = page.locator('.patrol-log-table .ant-table-tbody > tr:not(.ant-table-measure-row)').first().locator('.ant-checkbox-wrapper');
  await firstRowCheckbox.click();
  const oneSelected = page.getByRole('button', { name: '删除已选巡检日志（1）' });
  await oneSelected.click();
  await page.getByText('将删除 1 条已选已结束日志及其结果、报告和关联告警。未结束日志会跳过。确定删除吗？', { exact: true }).waitFor();
  await page.locator('.ant-popover button:visible').first().click();
  await firstRowCheckbox.click();
  const errorFilter = page.getByRole('button', { name: /只看错误/ });
  assert.equal(await errorFilter.getAttribute('aria-pressed'), 'false', '只看错误默认关闭');
  assert.match(await errorFilter.textContent(), /只看错误（5）/, '错误数量不应统计正确和运营故障日志');
  await page.getByText(/Kiro 身份泄漏（1）/).first().waitFor();
  await page.getByText(/Thinking Signature 无效（1）/).first().waitFor();
  assert.equal(await page.getByRole('link', { name: '巡检日志 52 · 渠道 B' }).getAttribute('href'), '/runs/patrol_52', 'Kiro 摘要应链接到跨页命中详情');
  assert.equal(await page.getByRole('link', { name: '巡检日志 3 · 渠道 A' }).getAttribute('href'), '/runs/patrol_03', 'Signature 摘要应链接到命中详情');

  await errorFilter.click();
  await page.waitForTimeout(250);
  assert.equal(await errorFilter.getAttribute('aria-pressed'), 'true', '只看错误点击后应开启');
  const errorRows = page.locator('.patrol-log-table .ant-table-tbody > tr:not(.ant-table-measure-row)');
  assert.equal(await errorRows.count(), 5, '只看错误应只显示 5 条真实异常日志');
  const errorText = (await errorRows.allTextContents()).join('\n');
  assert.match(errorText, /巡检日志 1|巡检日志 3|巡检日志 5|巡检日志 6|巡检日志 52/);
  assert.doesNotMatch(errorText, /巡检日志 2|巡检日志 4/);

  await page.getByRole('combobox', { name: '自动巡检日志渠道筛选' }).locator('..').locator('..').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: '渠道 B' }).click();
  await page.waitForTimeout(250);
  assert.equal(await errorRows.count(), 2, '渠道 B + 只看错误应只保留渠道 B 的异常日志');
  assert.match((await errorRows.allTextContents()).join('\n'), /巡检日志 6|巡检日志 52/);
  await page.getByText(/Kiro 身份泄漏（1）/).first().waitFor();
  assert.equal(await page.getByText(/Thinking Signature 无效（1）/).count(), 0, '渠道 B 不应显示渠道 A 的 Signature 摘要');
  await page.getByRole('button', { name: '删除当前范围（2）' }).click();
  await page.getByText('删除渠道「渠道 B」的错误日志中的已结束巡检日志', { exact: true }).waitFor();
  await page.locator('.ant-popover button:visible').first().click();

  await errorFilter.click();
  await page.waitForTimeout(250);
  assert.equal(await errorFilter.getAttribute('aria-pressed'), 'false');
  assert.equal(await errorRows.count(), 10, '关闭只看错误后应恢复渠道 B 的全部第一页日志');

  await page.getByRole('combobox', { name: '自动巡检日志渠道筛选' }).locator('..').locator('..').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: '全部渠道' }).click();
  await page.waitForTimeout(250);
  assert.equal(await tableRows.count(), 10, '切回全部渠道后应恢复全量第一页日志');

  const anomalyRequestCountBeforePagination = anomalyRequests.length;
  await page.locator('.patrol-log-pagination .ant-pagination-item-6 a').click();
  await page.waitForTimeout(500);
  assert.ok(patrolRequests.some((request) => request.startsWith('6:10:all:false')), `点击第 6 页应请求 page=6，实际：${patrolRequests.join(', ')}`);
  assert.equal(await page.locator('.patrol-log-pagination .ant-pagination-item-active').textContent(), '6', '分页器应稳定选中第 6 页');
  const pageSixText = await page.locator('.patrol-log-table').innerText();
  assert.match(pageSixText, /巡检日志 51/, '第 6 页应显示第 51 条记录');
  await page.waitForTimeout(750);
  assert.equal(await page.locator('.patrol-log-pagination .ant-pagination-item-active').textContent(), '6', '等待查询后不应跳回第 1 页');
  assert.equal(anomalyRequests.length, anomalyRequestCountBeforePagination, '下方翻页不应重新请求顶部异常摘要');

  await page.locator('.patrol-log-pagination .ant-pagination-prev button').click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.patrol-log-pagination .ant-pagination-item-active').textContent(), '5');
  await page.locator('.patrol-log-pagination .ant-pagination-next button').click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.patrol-log-pagination .ant-pagination-item-active').textContent(), '6');

  await page.locator('.patrol-log-pagination .ant-pagination-item-1 a').click();
  await page.waitForTimeout(250);

  await page.getByRole('combobox', { name: '自动巡检日志渠道筛选' }).locator('..').locator('..').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: '渠道 C' }).click();
  await topErrorSummary.getByText('暂无需要处理的错误', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: '自动巡检日志渠道筛选' }).locator('..').locator('..').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: '全部渠道' }).click();
  await page.waitForTimeout(250);

  await page.locator('.patrol-log-pagination .ant-pagination-item-2 a').click();
  await page.waitForTimeout(500);
  assert.ok(patrolRequests.some((request) => request.startsWith('2:10:all:false')), `点击第 2 页应请求 page=2，实际：${patrolRequests.join(', ')}`);
  const pageTwoTableText = await page.locator('.patrol-log-table').innerText();
  assert.match(pageTwoTableText, /巡检日志 11/, `第 2 页应显示巡检日志 11；请求：${patrolRequests.join(', ')}；表格：${pageTwoTableText}`);
  const secondPageIds = await tableRows.allTextContents();
  assert.equal(secondPageIds.length, 10, '第二页应显示 10 条巡检日志');
  assert.notDeepEqual(secondPageIds, firstPageIds, '第二页日志必须与第一页不同');
  assert.equal(await page.locator('.patrol-inline-error').count(), 0, '第二页不应残留第一页错误正文');

  const sizeChanger = page.locator('.patrol-log-pagination .ant-select').first();
  await sizeChanger.click();
  await page.getByText('20 条/页', { exact: true }).click();
  const twentyPageIds = await tableRows.allTextContents();
  assert.equal(twentyPageIds.length, 20, '选择 20 条/页后应显示 20 条日志');

  const expandableRow = page.locator('.patrol-log-table .ant-table-tbody > tr:not(.ant-table-measure-row)').first();
  await expandableRow.locator('.ant-table-row-expand-icon').click();
  await page.waitForTimeout(250);
  assert.deepEqual(detailRequests, ['patrol_01'], '展开行只应请求对应日志的完整结果');

  const deleteTargetRow = tableRows.filter({ has: page.getByText('巡检日志 1', { exact: true }) });
  await deleteTargetRow.locator('.ant-checkbox-wrapper').click();
  await page.getByRole('button', { name: '删除已选巡检日志（1）' }).click();
  await page.locator('.ant-popover').filter({ hasText: '删除已选巡检日志' }).last().locator('button:visible').last().click();
  await page.waitForTimeout(500);
  assert.deepEqual(deleteRequests, [['patrol_01']], '确认删除已选只应提交选中的已结束日志');
  assert.equal(await page.getByText('巡检日志 1', { exact: true }).count(), 0, '删除成功后目标日志应从列表消失');
  await page.getByRole('button', { name: '删除已选巡检日志（0）' }).waitFor();
  await page.getByRole('button', { name: '删除当前范围（62）' }).waitFor();
  assert.equal(deletedRunIds.has('patrol_64'), false, 'pending 日志不得进入删除集合');
  assert.equal(deletedRunIds.has('patrol_65'), false, 'running 日志不得进入删除集合');

  await page.getByRole('button', { name: '删除当前范围（62）' }).click();
  await page.locator('.ant-popover').filter({ hasText: '删除全部渠道中的已结束巡检日志' }).last().locator('button:visible').last().click();
  await page.waitForTimeout(500);
  assert.equal(deleteRequests.length, 2, '删除当前范围应发起第二次批量删除请求');
  assert.equal(deleteRequests[1].length, 62, '删除当前范围应提交剩余 62 条已结束日志');
  assert.equal(deleteRequests[1].includes('patrol_64'), false, '当前范围删除不得提交 pending 日志');
  assert.equal(deleteRequests[1].includes('patrol_65'), false, '当前范围删除不得提交 running 日志');
  await page.getByRole('button', { name: '删除当前范围（0）' }).waitFor();
  assert.match(await page.locator('.patrol-log-table').innerText(), /巡检日志 64|巡检日志 65/, '范围删除后未结束日志仍应保留');

  async function openResiliencePage({ anomalyFailure = false }) {
    const resiliencePage = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const normalRun = {
      id: 'manual_1', suite_id: 'suite_1', name: '普通检测任务', mode: 'full_comparison', test_scope: 'full',
      status: 'completed', repeat_count: 1, concurrency: 1, total_jobs: 1, completed_jobs: 1,
      channels: [{ channel_id: 'channel_a', channel_name: '渠道 A', role_in_run: 'candidate' }],
      created_at: '2026-08-13T08:00:00Z',
    };
    const patrolError = { ...runs[0], display_state: 'error', needs_review: true, has_evidence: true };
    await resiliencePage.route('**/api/runs/patrol/anomalies**', (route) => anomalyFailure
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"anomaly unavailable"}' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        strict_total: 0,
        strict_items: [],
        kiro_identity_leak: { count: 0, items: [], truncated: false },
        invalid_thinking_signature: { count: 0, items: [], truncated: false },
      }) }));
    await resiliencePage.route('**/api/runs/patrol**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/runs/patrol/anomalies') return route.fallback();
      const errorsOnly = url.searchParams.get('errors_only') === 'true';
      const items = errorsOnly ? [patrolError] : [patrolError];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, total: 1, error_count: 1, deletable_count: 1, anomaly_summary: {}, page: 1, page_size: 10 }) });
    });
    await resiliencePage.route('**/api/runs**', (route) => {
      if (new URL(route.request().url()).pathname !== '/api/runs') return route.fallback();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([normalRun]) });
    });
    await resiliencePage.route('**/api/channels**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { id: 'channel_a', name: '渠道 A', provider_type: 'anthropic', role: 'candidate', enabled: true, is_reference: false, auth_config: {} },
    ]) }));
    await resiliencePage.route('**/api/reports/summary', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await resiliencePage.route('**/apipro-logo.svg', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" />' }));
    await resiliencePage.goto(`${baseUrl}/runs`, { waitUntil: 'load' });
    await resiliencePage.getByText('普通检测任务', { exact: true }).waitFor({ timeout: 5000 });
    return resiliencePage;
  }

  const anomalyFailurePage = await openResiliencePage({ anomalyFailure: true });
  await anomalyFailurePage.getByText('错误日志加载失败', { exact: true }).waitFor();
  await anomalyFailurePage.getByText('普通检测任务', { exact: true }).waitFor();
  await anomalyFailurePage.close();
} finally {
  await browser?.close();
  try {
    process.kill(-devServer.pid, 'SIGTERM');
  } catch {
    // The preview process already exited.
  }
}
