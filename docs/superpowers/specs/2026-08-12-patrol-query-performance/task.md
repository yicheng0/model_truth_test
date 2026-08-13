# 自动巡检日志查询性能优化 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/app/schemas.py` | 定义巡检摘要与分页响应模型 |
| 修改 | `backend/app/main.py` | 将最新报告、错误筛选、计数和分页下推数据库，并拆分异常摘要接口 |
| 修改 | `backend/tests/test_api.py` | 覆盖大数据量查询边界、SQL 下推、分页、错误筛选和异常摘要 |
| 修改 | `frontend/src/types.ts` | 定义巡检分页响应类型 |
| 修改 | `frontend/src/api.ts` | 分离巡检分页与真实性异常摘要查询方法 |
| 修改 | `frontend/src/pages/Runs.tsx` | 让分页表格和顶部摘要独立加载，保留按需详情 |
| 修改 | `frontend/src/runsUtils.test.ts` | 覆盖服务端分页状态转换与筛选辅助行为 |
| 修改 | `frontend/src/api.test.ts` | 覆盖异常摘要独立接口的参数编码与响应边界 |
| 修改 | `frontend/e2e/runs-pagination.mjs` | 验证分页不等待异常摘要、翻页、错误筛选和展开详情 |

## T1: 建立生产规模查询回归测试

**文件：** `backend/tests/test_api.py`
**依赖：** 无
**步骤：**
1. 增加可批量构造巡检 Run、RunChannel 和 Report 的辅助，创建至少 3000 条巡检，其中至少 1000 条为真实错误，覆盖两个渠道、运营故障、正常记录和同一任务多份历史报告。
2. 对普通列表、`errors_only=true`、渠道筛选以及渠道+错误组合分别断言总数、当前页 10 条、倒序和最新报告语义。
3. 监听 SQL 执行或 ORM 装载范围，断言错误筛选不把全部 3000 条 Run/Report 实体加载进 Python，当前页实体数量受 `page_size` 约束。
4. 记录接口耗时作为本地回归指标；避免把固定绝对时间作为唯一测试条件，但要求优化后显著低于旧的全量 Python 过滤路径。
5. 断言基本分页响应不依赖异常摘要完成，且不会携带完整 Report/Result 集合。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "patrol_query_large_dataset or patrol_query_performance" -v`；实现前新增“禁止全量装载”和独立摘要断言应失败。

## T2: 构建可复用的最新报告查询

**文件：** `backend/app/main.py`
**依赖：** T1
**步骤：**
1. 使用 SQLAlchemy 子查询或窗口函数表示每个 run/channel 的最新 Report，以 `created_at` 和 `id` 形成稳定顺序。
2. 将渠道范围与巡检范围加入同一可组合查询，避免先获取全部 run id 再构造大 `IN` 集合。
3. 只投影分页和分类所需字段，不加载 Report markdown、summary 或其他无关大字段。
4. 为 SQLite 和 PostgreSQL 生成兼容 SQL；不要使用只在单一数据库可用的 JSON/窗口写法而无兼容路径。
5. 保留当前工作区中已有的最新报告查询改动，必要时在其上收敛，不覆盖同文件其他并发优化。

**验证：** 运行 T1 定向测试中的最新报告、渠道范围和实体装载断言；期望最新报告选择稳定且无全量 ORM 装载。

## T3: 将错误过滤、计数和分页下推数据库

**文件：** `backend/app/main.py`, `backend/tests/test_api.py`
**依赖：** T2
**步骤：**
1. 将 `_patrol_needs_review` 的已批准语义转成数据库可复用的错误谓词，保持 Claude/AWS/Signature 正常分类和运营故障排除规则。
2. 让 `total`、`error_count` 和 `deletable_count` 使用数据库聚合，并与渠道/错误筛选共享同一范围条件。
3. 在数据库过滤完成后再应用 `ORDER BY`、`OFFSET` 和 `LIMIT`，只加载当前页 Run 和对应最新 Report。
4. 删除 `errors_only` 下先加载全部 Run、Python 构造全部摘要、再切片分页的路径。
5. 保持越界页返回真实总数，前端可据此校正到最后有效页。
6. 运行 3000/1000 规模测试并记录普通、错误和组合查询耗时。

**验证：** `cd backend && python3 -m pytest tests/test_api.py -k "patrol_query_large_dataset or patrol_query_performance or patrol_query_preserves" -v`；所有语义断言通过，加载范围不随 3000 条历史线性增长。

## T4: 拆分真实性异常摘要接口

**文件：** `backend/app/schemas.py`, `backend/app/main.py`, `backend/tests/test_api.py`
**依赖：** T2
**步骤：**
1. 保留现有异常摘要 Schema，并增加独立 `GET /api/runs/patrol/anomalies` 路由。
2. 路由支持可选渠道筛选，不接收或不受 `errors_only` 影响。
3. 使用最新报告查询，只读取分类所需 evidence 和有限入口字段；每类统计完整总数并最多返回既有上限数量入口。
4. 基本 `/api/runs/patrol` 不再同步计算异常摘要；如为兼容保留字段，则返回安全空默认且前端不依赖它。
5. 若实现短 TTL 进程内缓存，覆盖渠道键、超时和新增/删除报告后的失效测试；不以缓存掩盖错误查询结果。
6. 验证运营故障、`signature_ok=null`、普通 400 和普通 Kiro 文本仍不计入摘要。

**验证：** `cd backend && python3 -m pytest tests/test_api.py -k "patrol and (anomaly or signature or kiro)" -v`；摘要数量、入口、渠道范围和误报反例全部通过。

## T5: 前端独立查询测试先行

**文件：** `frontend/src/types.ts`, `frontend/src/api.ts`, `frontend/src/api.test.ts`, `frontend/src/runsUtils.test.ts`
**依赖：** T3、T4
**步骤：**
1. 增加独立异常摘要响应类型和 `api.patrolAnomalies({ channel_id })`。
2. 保持 `api.patrolRuns` 只编码页码、页大小、渠道和错误筛选。
3. 编写 API 测试，验证两个请求 URL、渠道参数和错误筛选互不串扰。
4. 增加辅助测试，验证异常摘要加载中或失败不会改变当前分页状态和列表 items。

**验证：** `cd frontend && ./node_modules/.bin/vitest run src/api.test.ts src/runsUtils.test.ts`；实现前新增独立接口测试应失败。

## T6: 前端分页与摘要解耦

**文件：** `frontend/src/pages/Runs.tsx`
**依赖：** T5
**步骤：**
1. 巡检分页 Query 只消费列表接口，先渲染当前页、错误数和分页器。
2. 顶部 Kiro/Signature 使用独立 Query；加载中不显示遮罩，失败仅隐藏/提示摘要而不阻塞筛选、翻页和删除。
3. 渠道变化同时刷新两类 Query；“只看错误”和页码变化只刷新分页 Query，不重复请求不受影响的摘要。
4. 删除/取消成功后失效相关分页与异常摘要，保持数量正确。
5. 保留当前工作区中普通任务 `exclude_patrol` 和渠道选项的并发修改，不覆盖其 query key 或缓存逻辑。

**验证：** `cd frontend && ./node_modules/.bin/vitest run`、`./node_modules/.bin/tsc -b`；前端测试和类型检查通过。

## T7: 浏览器并行加载与交互回归

**文件：** `frontend/src/pages/Runs.tsx`, `frontend/e2e/runs-pagination.mjs`
**依赖：** T6
**步骤：**
1. 让异常摘要 fixture 延迟返回，断言巡检列表和分页先完成渲染并可切换“只看错误”。
2. 监听分页、异常摘要和详情请求，断言错误筛选不触发不必要的异常摘要重复请求。
3. 保持首屏完整详情请求数为 0；展开一行后只请求对应 run ID。
4. 验证第 6 页稳定、渠道筛选、错误筛选、每页条数和删除范围仍正确。
5. 验证异常摘要失败时表格仍可用，重试摘要不重置页码。

**验证：** `cd frontend && node e2e/runs-pagination.mjs`；分页先于延迟摘要可用，全部交互断言通过。

## T8: 干净合并环境全量验收

**文件：** 本需求涉及的源码、测试和文档文件
**依赖：** T7
**步骤：**
1. 在从最新 `origin/main` 创建的隔离 worktree 中合入本次提交，避免当前脏工作区并发修改影响结果。
2. 运行后端完整测试、前端完整测试、TypeScript、生产构建和浏览器脚本。
3. 检查 `git diff --check`、提交范围和工作区状态，确认未带入未批准修改。
4. 记录本地 3000/1000 基准的普通、错误和组合查询中位耗时。

**验证：** `cd backend && python3 -m pytest`; `cd frontend && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build && node e2e/runs-pagination.mjs`; 所有命令退出码为 0。

## T9: 生产部署与线上性能验收

**文件：** 无业务文件修改
**依赖：** T8
**步骤：**
1. push 功能分支并非快进合并到 `main`，确认远端 SHA。
2. 使用已授权的服务器部署入口，在生产目录拉取 `main`，执行 `docker compose up -d --build --force-recreate`，不运行数据库迁移或清理数据。
3. 检查 `docker compose ps`、后端/前端日志和首页/API 实际响应；容器必须为 Up/healthy，而不是 Created。
4. 对普通列表、错误筛选和至少一个渠道+错误筛选各采样 5 次，记录中位数和 P95。
5. 验证线上总数仍为部署时真实数据，分页内容、错误数和顶部摘要准确。
6. 若分页接口中位数仍高于 500ms，停止生产验收并收集 PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)`，不得用提高超时或前端 loading 掩盖问题。

**验证：** 生产分页接口中位数低于 500ms，5 次请求全部成功；页面切换渠道和“只看错误”无明显阻塞。

## 执行顺序

```text
T1 -> T2 -> T3
      |
      +-> T4
T3 + T4 -> T5 -> T6 -> T7 -> T8 -> T9
```
