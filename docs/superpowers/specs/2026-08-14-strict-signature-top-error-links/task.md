# 顶部巡检异常严格分类与直达详情 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/app/schemas.py` | 增加严格异常条目类型、去重总数和顶部条目字段 |
| 修改 | `backend/app/main.py` | 严格提取、排序、去重并返回异常摘要 |
| 修改 | `backend/tests/test_api.py` | 覆盖 403、运营故障、明确 Signature、Kiro 优先和渠道范围 |
| 修改 | `frontend/src/types.ts` | 同步严格异常摘要响应类型 |
| 修改 | `frontend/src/runsUtils.ts` | 顶部只映射服务端严格异常条目 |
| 修改 | `frontend/src/runsUtils.test.ts` | 覆盖严格总数、两类异常、去重及敏感数据边界 |
| 修改 | `frontend/src/pages/Runs.tsx` | 移除顶部通用错误查询，复用严格摘要并保留详情链接 |
| 修改 | `frontend/e2e/runs-pagination.mjs` | 浏览器验证误报抑制、直达详情和查询隔离 |
| 不修改 | 数据库模型与迁移 | 本次按读取规则解释现有证据，不回写历史数据 |

## T1: 建立服务端严格摘要失败测试

**文件：** `backend/tests/test_api.py`
**依赖：** 无

**步骤：**

1. 扩展巡检异常摘要测试数据，加入 HTTP 403 且错误为“渠道已被禁用”的 Signature 记录。
2. 加入网络、超时、HTTP 5xx、权限、额度和无可用渠道或账号的运营故障记录。
3. 加入 HTTP 400 且明确包含 `Invalid signature in thinking block` 的记录。
4. 加入同一任务同时包含 Kiro 身份泄漏与明确 Signature 拒绝的记录。
5. 断言响应包含 `strict_total` 和 `strict_items`。
6. 断言 403 及其他运营故障不进入严格总数、严格条目和 Signature 分类组。
7. 断言明确 Signature 进入 Signature 分类组和严格条目。
8. 断言同一任务只计一次且严格条目显示 Kiro 类型。
9. 断言指定渠道后，严格总数和条目只属于该渠道。
10. 运行测试并确认因响应尚无严格字段或行为尚未实现而失败。

**验证：** 在 `backend` 目录运行：

```bash
python3 -m pytest tests/test_api.py -k "patrol_query_preserves_real_total_on_out_of_range_page_and_loads_anomaly_summary_separately or patrol_strict_anomaly" -q
```

期望新增断言失败，失败原因指向缺少严格摘要字段或错误条目仍被纳入，而不是测试环境或语法错误。

## T2: 实现服务端严格异常响应结构

**文件：** `backend/app/schemas.py`
**依赖：** T1

**步骤：**

1. 为严格顶部条目增加只允许 Kiro 和 Signature 的异常类型字段。
2. 保留现有异常条目的任务、渠道、时间、请求标识、HTTP 状态和阶段字段。
3. 为巡检异常摘要增加 `strict_total`，默认值为 0。
4. 为巡检异常摘要增加 `strict_items`，默认空列表。
5. 保持现有两个分类组字段不变，确保旧前端字段继续可用。

**验证：** 在 `backend` 目录运行：

```bash
python3 -m pytest tests/test_api.py -k "patrol_query_preserves_real_total_on_out_of_range_page_and_loads_anomaly_summary_separately or patrol_strict_anomaly" -q
```

期望测试推进到严格排序、去重或过滤行为失败，响应模型不再缺字段。

## T3: 实现服务端严格提取、排序和去重

**文件：** `backend/app/main.py`
**依赖：** T2

**步骤：**

1. 继续复用现有 Kiro 明确身份判定。
2. 继续要求 Signature 同时满足 HTTP 400 和明确错误文本匹配。
3. 为 Kiro 与 Signature 分类条目填充严格异常类型。
4. 两个分类组分别按发生时间从新到旧排序，时间缺失时使用稳定任务顺序。
5. 先处理 Kiro、再处理 Signature，并按任务标识去重。
6. 同一任务同时命中两类时，保留 Kiro 条目，分类组仍可分别保留其分类证据和计数。
7. `strict_total` 使用去重后的完整任务数量。
8. `strict_items` 返回前 10 条，不以分类组各自的五条展示上限截断总数。
9. 确保历史 `signature_interop_failed` 标签、低评分、失败状态和 HTTP 403 都不能绕过明确 Signature 判定。
10. 保持渠道筛选、脱敏请求标识和现有响应字段兼容。

**验证：** 在 `backend` 目录运行：

```bash
python3 -m pytest tests/test_api.py -k "patrol_query_preserves_real_total_on_out_of_range_page_and_loads_anomaly_summary_separately or patrol_strict_anomaly" -q
```

期望定向测试全部通过。

## T4: 建立前端严格顶部组合器失败测试

**文件：** `frontend/src/runsUtils.test.ts`
**依赖：** T3

**步骤：**

1. 修改顶部摘要测试数据，使输入只使用服务端严格异常摘要，不再传入通用错误分页。
2. 编写测试：输出只包含 Kiro 和明确 Signature 两类。
3. 编写测试：服务端严格总数作为顶部标题总数。
4. 编写测试：同一任务只显示一条且 Kiro 优先。
5. 编写测试：保持服务端 Kiro 优先、Signature 次之和时间顺序。
6. 编写测试：即使另有通用错误分页或失败运行，也不能进入顶部组合结果。
7. 编写测试：输出不包含 Request ID、完整错误正文、原始请求或原始响应。
8. 运行测试并确认因现有组合器仍消费通用分页或仍支持 `patrol_error` 而失败。

**验证：** 在 `frontend` 目录运行：

```bash
./node_modules/.bin/vitest run src/runsUtils.test.ts
```

期望新增用例失败，且失败原因指向旧的顶部组合行为。

## T5: 同步前端严格异常类型并实现组合器

**文件：** `frontend/src/types.ts`、`frontend/src/runsUtils.ts`
**依赖：** T4

**步骤：**

1. 为异常摘要增加 `strict_total` 和 `strict_items` 类型。
2. 为严格条目增加只允许 Kiro 与 Signature 的 `kind`。
3. 移除顶部条目中的通用 `patrol_error` 类型和对应优先级分支。
4. 修改顶部组合器，只接收严格异常摘要。
5. 使用服务端 `strict_total` 作为总数。
6. 按服务端 `strict_items` 顺序映射紧凑字段，不再读取通用错误分页。
7. 对任务标识做防御性去重，Kiro 覆盖同任务的 Signature。
8. 最多返回 10 条，不解析错误正文。
9. 运行 T4 测试并修正至全部通过。

**验证：** 在 `frontend` 目录运行：

```bash
./node_modules/.bin/vitest run src/runsUtils.test.ts
```

期望全部通过。

## T6: 建立页面浏览器失败场景

**文件：** `frontend/e2e/runs-pagination.mjs`
**依赖：** T5

**步骤：**

1. 修改异常摘要 fixture，返回 `strict_total`、`strict_items` 及两个分类组。
2. 在通用错误分页 fixture 中加入 HTTP 403“渠道已被禁用”任务，证明它仍可存在于历史日志。
3. 在严格摘要中只返回 Kiro 和明确 Signature 条目。
4. 断言顶部总数只计算严格异常，不等于下方通用错误数量。
5. 断言顶部不存在 403 任务名称和通用“巡检异常”标签。
6. 断言顶部存在明确 Signature 和 Kiro 标签及任务链接。
7. 断言点击顶部任务链接进入对应 `/runs/{run_id}`，详情请求只在点击后发生。
8. 断言下方两类异常提示链接继续可用。
9. 断言渠道切换同步收窄顶部和下方异常提示。
10. 断言下方分页、错误筛选变化不重复触发严格摘要查询。
11. 断言摘要失败时只出现局部错误，普通任务表和下方分页仍可用。
12. 运行浏览器脚本并确认因页面仍使用顶部通用错误查询或旧 fixture 结构而失败。

**验证：** 先运行生产构建，再在 `frontend` 目录运行：

```bash
npm run build
node e2e/runs-pagination.mjs
```

期望新增浏览器断言失败，原有分页基础流程能执行到该断言位置。

## T7: 移除顶部通用错误查询并复用严格摘要

**文件：** `frontend/src/pages/Runs.tsx`
**依赖：** T5、T6

**步骤：**

1. 删除固定请求 `page=1&page_size=10&errors_only=true` 的顶部通用错误 Query。
2. 使用现有渠道范围内的异常摘要 Query 生成顶部错误摘要。
3. 顶部标题使用严格去重总数。
4. 顶部表格只渲染 Kiro 与 Thinking Signature 无效标签，删除“巡检异常”分支。
5. 保持错误类型、渠道、任务链接和时间四列。
6. 任务链接继续指向 `/runs/{runId}`。
7. 摘要加载失败时顶部显示局部错误和重试，普通任务表不进入 loading。
8. 摘要为空时显示“暂无需要处理的错误”。
9. 顶部和下方异常提示共享同一查询响应。
10. 将“查看全部错误”改为“查看全部异常”，仅滚动到下方严格异常提示区域，不切换下方通用“只看错误”。
11. 删除所有 `patrolTopErrors` 查询失效调用；保留巡检分页和异常摘要的删除、取消刷新。

**验证：** 在 `frontend` 目录运行：

```bash
./node_modules/.bin/tsc -b
node e2e/runs-pagination.mjs
```

期望类型检查和浏览器回归通过。

## T8: 补齐后端和前端回归

**文件：** `backend/tests/test_api.py`、`frontend/src/runsUtils.test.ts`、`frontend/e2e/runs-pagination.mjs`
**依赖：** T7

**步骤：**

1. 增加历史仅带 `signature_interop_failed` 标签但没有明确错误文本的后端用例，断言不进入严格摘要。
2. 增加 `signature_ok=null` + HTTP 403 的后端用例，断言不进入严格摘要。
3. 增加明确 Signature 错误大小写及引号变体的用例，断言仍进入严格摘要。
4. 增加严格异常超过 10 条时 `strict_total` 保持真实而 `strict_items` 限制 10 条的用例。
5. 增加当前渠道无严格异常时的浏览器空状态。
6. 增加顶部 DOM 不出现完整错误正文、Request ID 或原始响应的断言。
7. 保留原有第 6 页、筛选、详情展开、选择和批量删除回归。

**验证：**

```bash
cd backend
python3 -m pytest tests/test_api.py -k "patrol" -q

cd ../frontend
./node_modules/.bin/vitest run src/runsUtils.test.ts src/api.test.ts
node e2e/runs-pagination.mjs
```

期望全部通过。

## T9: 完整验证与范围审查

**文件：** 本任务涉及的全部文件
**依赖：** T1-T8

**步骤：**

1. 使用独立临时 SQLite 数据库运行后端完整测试，避免污染本地默认数据库。
2. 运行前端定向测试。
3. 运行前端完整测试。
4. 运行生产构建。
5. 运行浏览器交互脚本。
6. 运行差异格式检查。
7. 检查网络记录，确认顶部首屏未请求 `/api/runs/{id}/results`。
8. 检查差异文件，不得包含数据库迁移、调度、评分或任务详情证据删除。
9. 检查主工作区既有 `2026-08-12-patrol-delete-button-usability/checklist.md` 修改未被覆盖。
10. 逐项对照批准的 spec、plan 和 checklist，不以单元测试通过替代用户流程验收。

**验证：**

```bash
cd backend
test_db_dir=$(mktemp -d)
DATABASE_URL="sqlite:///$test_db_dir/test.db" python3 -m pytest -q

cd ../frontend
./node_modules/.bin/vitest run src/runsUtils.test.ts src/api.test.ts
npm test -- --run
npm run build
node e2e/runs-pagination.mjs

cd ..
git diff --check
git diff --name-only
git status --short
```

期望所有命令退出码为 0，且差异范围只包含本任务的规格、后端严格摘要、前端顶部展示及测试文件。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T7 -> T8 -> T9
```

TDD 门禁：T1、T4 和 T6 必须先观察到预期失败，才允许修改对应生产代码。
