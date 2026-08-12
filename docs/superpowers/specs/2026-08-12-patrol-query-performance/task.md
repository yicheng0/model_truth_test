# 自动巡检日志查询性能优化 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/app/schemas.py` | 定义巡检摘要与分页响应模型 |
| 修改 | `backend/app/main.py` | 实现巡检摘要、筛选、计数和服务端分页接口 |
| 修改 | `backend/tests/test_api.py` | 覆盖接口字段边界、分页、错误筛选和渠道筛选 |
| 修改 | `frontend/src/types.ts` | 定义巡检分页响应类型 |
| 修改 | `frontend/src/api.ts` | 添加巡检列表查询方法 |
| 修改 | `frontend/src/pages/Runs.tsx` | 移除全量详情 N+1，接入服务端分页和按需详情 |
| 修改 | `frontend/src/runsUtils.test.ts` | 覆盖服务端分页状态转换与筛选辅助行为 |
| 修改 | `frontend/e2e/runs-pagination.mjs` | 验证首屏请求数量、翻页、错误筛选和展开详情 |

## T1: 后端接口测试先行

**文件：** `backend/tests/test_api.py`
**依赖：** 无
**步骤：**
1. 增加测试数据构造辅助，创建至少 25 条巡检日志，覆盖正常、异常、需复审和两个渠道。
2. 编写测试验证 `GET /api/runs/patrol?page=1&page_size=10` 返回 `items`、`total`、`error_count`、`page`、`page_size`，且单个 item 不含完整结果字段。
3. 编写测试验证 `errors_only=true` 排除正常日志并保持错误总数；`channel_id` 与 `errors_only` 同时使用时只返回交集。
4. 编写测试验证第二页返回不同 ID 且创建时间倒序。
**验证：** 运行 `cd backend && pytest tests/test_api.py -k patrol_query_performance -v`；期望测试因接口不存在或响应结构缺失而失败。

## T2: 后端摘要 Schema 与查询实现

**文件：** `backend/app/schemas.py`, `backend/app/main.py`
**依赖：** T1
**步骤：**
1. 定义 `PatrolRunSummaryRead` 和 `PatrolRunListRead`，字段与 plan.md 一致并禁止完整结果字段进入响应。
2. 添加摘要构造逻辑：限定 `scheduled_test_id` 非空或 `test_scope == scheduled_probe`，批量读取当前筛选范围的渠道、最新报告和结果标签，计算 `display_state`、`needs_review`、`has_evidence`。
3. 添加 `GET /api/runs/patrol`，规范化页码/页大小，按渠道和错误状态过滤，返回总数、错误数和当前页摘要。
4. 保持现有 `/api/runs`、`/api/eval-runs` 和完整结果接口不变。
**验证：** 重跑 T1 命令，新增接口测试全部通过；运行 `cd backend && pytest tests/test_api.py -k 'patrol_query_performance or run_results' -v`，期望无回归。

## T3: 前端 API 和类型测试先行

**文件：** `frontend/src/types.ts`, `frontend/src/api.ts`, `frontend/src/runsUtils.test.ts`
**依赖：** T2
**步骤：**
1. 增加 `PatrolRunSummary`、`PatrolRunList` 和查询参数类型。
2. 编写 `api.patrolRuns` 测试，验证页码、页大小、渠道 ID、错误筛选被正确编码。
3. 增加辅助测试，验证服务端页码变化时当前页日志直接取 `items`，不再对全量历史日志做本地详情筛选。
**验证：** 运行 `cd frontend && npm test -- --run src/api.test.ts src/runsUtils.test.ts`；新增测试应先因 API 方法或类型缺失而失败。

## T4: 前端巡检列表改为服务端分页

**文件：** `frontend/src/pages/Runs.tsx`
**依赖：** T3
**步骤：**
1. 新增带查询参数的巡检 React Query，使用 `items`、`total` 和 `error_count` 渲染巡检表格和分页器。
2. 删除页面级 `patrolEvidenceQueries`、`patrolErrorStateByRunId` 以及依赖全量详情的本地错误筛选；渠道选项从摘要中的渠道字段生成。
3. 筛选条件或页大小变化时设置页码为 1，删除/取消后失效巡检查询并保持选择范围只针对当前可见项。
4. 列表加载失败显示 Alert 与重试按钮；保留普通任务列表的现有错误处理。
**验证：** 运行 `cd frontend && npm test -- --run` 和 `npm run build`；期望前端全量测试与构建通过。

## T5: 详情按需加载回归测试

**文件：** `frontend/src/pages/Runs.tsx`, `frontend/e2e/runs-pagination.mjs`
**依赖：** T4
**步骤：**
1. 确保巡检结果单元格默认只渲染摘要字段，不在列表挂载时调用 `runResults`。
2. 保留展开区域和详情链接中的 `runResults` 查询，给详情错误提供局部重试/错误提示。
3. 在 Playwright 脚本中监听 `/api/runs/patrol` 与 `/api/runs/*/results`，断言首屏不产生完整结果请求；展开一行后仅请求对应 ID。
4. 在脚本中验证翻页、每页条数、错误筛选与渠道筛选的请求参数和可见行。
**验证：** 运行 `cd frontend && node e2e/runs-pagination.mjs`；期望浏览器流程通过且请求断言满足 AC1-AC5。

## T6: 综合验收与变更范围检查

**文件：** 本需求涉及的源码、测试和文档文件
**依赖：** T5
**步骤：**
1. 运行后端巡检接口测试和完整后端回归测试。
2. 运行前端全量测试、生产构建和 E2E 脚本。
3. 检查 `git diff --stat` 与 `git status --short`，确保不包含用户已有的 Claude Code 修改或生成产物。
4. 按 checklist.md 记录每项实际输出和浏览器观察结果。
**验证：** `cd backend && pytest`; `cd frontend && npm test -- --run && npm run build && node e2e/runs-pagination.mjs`；所有命令退出码为 0。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6
```
