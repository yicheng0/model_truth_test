# 自动巡检日志查询性能优化 Plan

## 架构概览

保留现有 `/api/runs/{run_id}/results` 完整证据接口和巡检轻量列表接口。后端必须在数据库中完成最新报告选择、渠道/错误过滤、计数和分页；禁止先加载全部历史 Run/Report 再在 Python 中过滤分页。前端将普通任务、巡检分页和顶部真实性异常摘要拆成独立的 React Query 数据源，列表先展示当前页，摘要查询不得阻塞分页表格。巡检行的证据单元格不再自动查询详情，只有展开行组件或详情页挂载时才调用完整结果接口。

线上基准（2026-08-13，3116 条巡检、1087 条错误）：普通列表约 2.51 秒，`errors_only=true` 约 2.84 秒。目标是在相同数量级、数据库和服务器负载正常时，将巡检分页接口稳定控制在 500ms 内；异常摘要可稍后独立完成，但不得阻塞列表筛选和翻页。

## 核心数据结构

### `PatrolRunSummary`

复用 `Run` 的基础字段，并增加：

- `display_state`: `ok` 或 `error`，由现有巡检证据分类规则在服务端根据最新报告/结果摘要计算。
- `needs_review`: 布尔值，表示该日志是否需要复审。
- `has_evidence`: 布尔值，表示是否已有可展示报告或结果证据。

列表不返回 `results`、`comparisons`、`baseline_results` 或原始请求/响应。

### `PatrolRunListResponse`

- `items`: 当前页 `PatrolRunSummary[]`
- `total`: 当前筛选条件下的日志总数
- `error_count`: 当前渠道筛选范围内的异常日志数；错误筛选开启时仍表示该范围的总异常数
- `page`: 服务端接受并规范化后的页码
- `page_size`: 服务端接受并规范化后的每页条数

列表响应不再同步计算跨全部历史的 Kiro/Signature 入口集合；该摘要由独立查询返回，避免真实性摘要扫描拖慢基本分页。

### `PatrolAnomalySummaryResponse`

- 保持现有 Kiro 身份泄漏和明确 Thinking Signature 拒绝两类统计口径。
- 每类返回总数、固定数量的最新入口和是否截断。
- 支持可选 `channel_id`，不受“只看错误”开关影响。
- 作为独立请求加载；失败或较慢时只影响顶部提示，不阻塞巡检表格。

### 前端查询状态

巡检查询 key 包含 `selectedPatrolChannel`、`onlyPatrolErrors`、`patrolPage` 和 `patrolPageSize`。查询参数变化会触发新请求；页面在筛选或页大小改变时先设置页码为 1。

## 核心接口

### `GET /api/runs/patrol`

查询参数：

- `page`: 默认 1，最小 1
- `page_size`: 默认 10，范围 1-100
- `channel_id`: 可选，使用已选巡检渠道 ID
- `errors_only`: 默认 false；为 true 时只返回 `display_state=error` 或 `needs_review=true` 的记录

响应为 `PatrolRunListResponse`。排序固定为 `created_at DESC`，并以 `id DESC` 作为稳定的并列排序。

实现约束：

- 使用“每个 run/channel 最新 Report”子查询或窗口查询，不能对全部历史报告执行相关子查询后再传入 Python。
- `errors_only` 的错误条件必须在 SQL 中完成，`COUNT` 与分页复用相同过滤条件。
- 当前页只加载 `page_size` 条 Run、对应最新 Report 和渠道摘要。
- `error_count` 使用数据库聚合，不通过遍历全部 Report 计算。
- SQLAlchemy 表达式必须同时兼容 SQLite 和 PostgreSQL；需要读取 JSON 分类字段时使用统一表达式/方言兼容封装，并用两种语义一致的测试数据验证。

### `GET /api/runs/patrol/anomalies`

查询参数：

- `channel_id`: 可选，约束当前渠道范围。

返回 `PatrolAnomalySummaryResponse`。后端仅选择最新报告需要的轻量列，统计总数并各取固定数量最新入口。允许使用短 TTL 的进程内只读缓存降低轮询重复开销，但缓存键必须包含渠道范围，新增/删除巡检报告后必须失效；缓存不是正确性的唯一来源。

### `GET /api/runs/{run_id}/results`

保持现有响应结构和字段，继续用于展开行与详情页；不为列表增加新的完整数据请求。

## 模块设计

### 后端巡检摘要查询

**职责：** 从 `runs`、`run_channels`、`channels` 和每个 run/channel 的最新 `reports` 中构造巡检摘要，在数据库完成过滤、计数和分页。查询返回行数随当前页大小增长，不随 3116 条历史记录线性加载 ORM 对象。

**对外接口：** `GET /api/runs/patrol`。

**依赖：** SQLAlchemy 查询、现有 `run_read` 的渠道字段映射、现有巡检异常分类规则；不得调用完整结果序列化路径。

### 后端真实性异常摘要查询

**职责：** 独立计算 Kiro/Signature 跨页摘要，保持已批准的真实性边界，并将其延迟和失败与基本列表解耦。

**对外接口：** `GET /api/runs/patrol/anomalies`。

**依赖：** 最新报告子查询、有限字段投影、现有 Kiro/Signature 分类器；不得返回完整 Report、Result 或原始响应。

### 后端 Schema

**职责：** 定义摘要和分页响应模型，明确字段边界，避免把完整证据序列化进列表响应。

**对外接口：** `PatrolRunSummaryRead`、`PatrolRunListRead`。

### 前端 API 客户端

**职责：** 将巡检分页和异常摘要参数分别编码为稳定 URL；保留现有 `runResults` 详情调用。

**对外接口：** `api.patrolRuns(params)`、`api.patrolAnomalies(params)`。

### `Runs.tsx` 巡检列表

**职责：** 用服务端分页响应渲染巡检表格、渠道筛选、只看错误按钮、错误数量和删除选择；顶部异常摘要使用独立 Query，加载中或失败不遮挡表格。普通任务仍走现有普通列表数据源。

### 按需详情组件

**职责：** `PatrolEvidenceCell`、`PatrolReviewCell` 和展开区域只在对应组件实际挂载时请求 `runResults`。详情失败显示行内重试/错误，不改变其他行状态。

## 模块交互

```text
Runs 页面
  ├─ 普通任务查询（保持现有行为）
  ├─ patrolRuns(page, size, channel, errors_only)
  │    └─ 数据库完成最新报告、错误过滤、COUNT、LIMIT/OFFSET
  │         └─ 返回当前页摘要
  └─ patrolAnomalies(channel)
       └─ 独立返回跨页 Kiro/Signature 摘要，不阻塞表格

用户展开行 / 点击详情
  └─ runResults(run_id)
       └─ 返回完整 results、comparisons、reports、baseline_results
```

## 文件组织

```text
backend/app/schemas.py                 # 新增巡检摘要与分页响应模型
backend/app/main.py                    # 新增巡检分页/筛选查询和摘要构造
backend/tests/test_api.py              # 新增接口分页、错误筛选和轻量响应测试
frontend/src/types.ts                  # 新增巡检摘要/分页类型
frontend/src/api.ts                    # 新增 patrolRuns 客户端方法
frontend/src/pages/Runs.tsx            # 拆分巡检查询，移除全量 N+1，改为按需详情
frontend/src/runsUtils.test.ts         # 补充摘要状态和分页交互纯函数测试（如现有测试结构适用）
frontend/e2e/runs-pagination.mjs       # 增加请求数量与展开详情浏览器验收
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 列表接口 | 新增巡检专用接口，不改变普通 `/api/runs` 响应 | 降低兼容风险，普通任务已有消费者无需迁移 |
| 分页位置 | 服务端分页 | 历史日志数量增长时响应和数据库读取保持受控 |
| 错误状态来源 | 服务端复用现有报告/结果证据分类 | 错误计数跨页准确，避免前端重新请求完整详情 |
| 错误筛选执行位置 | SQL 最新报告子查询和数据库谓词 | 避免 1087 条错误时把 3116 条 Run/Report 全部加载到 Python |
| 顶部异常摘要 | 独立接口和独立 React Query | 摘要扫描或缓存失效不阻塞列表首屏、筛选和翻页 |
| 最新报告选择 | 一次子查询/窗口查询并复用 | 避免每个 Report 的相关 `NOT EXISTS` 放大数据库工作量 |
| 详情加载 | 展开/详情时 React Query 按 run id 查询 | 首屏不请求完整证据，且详情缓存可复用 |
| 渠道参数 | 传递渠道 ID；未识别渠道使用显式空值语义 | 避免依赖展示名称，查询稳定且可索引 |
| 数据库变更 | 本轮先不新增迁移 | 先通过查询形态、字段投影和请求解耦消除全量 ORM 加载；若 PostgreSQL `EXPLAIN` 仍无法满足 500ms，再单独走索引迁移审批，不静默加表或索引 |

## 验证设计

- 后端：用隔离数据库构造至少 3000 条巡检/1000 条错误，验证响应不含完整结果字段、分页总数、错误筛选和渠道交集；记录 SQL 次数、加载 ORM 行数和接口耗时，证明 `errors_only` 不再全量加载。
- 前端：先写失败测试证明列表初始化不会调用 `runResults`，再实现按需查询；验证分页/筛选变更会更新请求参数并回到第一页。
- 浏览器：在真实 `/runs` 页面监听分页、异常摘要与详情请求，确认分页表格不等待异常摘要；展开一行后仅产生对应详情请求。
- 线上：部署前后对同一生产接口各采样至少 5 次，分别记录普通列表、错误筛选和渠道+错误筛选耗时；目标中位数低于 500ms，且返回总数仍为 3116/1087 的真实范围或部署时最新值。
