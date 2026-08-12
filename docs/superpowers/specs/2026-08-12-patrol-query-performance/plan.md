# 自动巡检日志查询性能优化 Plan

## 架构概览

保留现有 `/api/runs/{run_id}/results` 完整证据接口，新增巡检专用的轻量列表接口。后端在一次查询中完成巡检范围、渠道、错误状态过滤和分页，并返回摘要总数；前端将普通任务和巡检日志拆成独立的 React Query 数据源，巡检表格直接消费分页结果。巡检行的证据单元格不再自动查询详情，只有展开行组件或详情页挂载时才调用完整结果接口。

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

### `GET /api/runs/{run_id}/results`

保持现有响应结构和字段，继续用于展开行与详情页；不为列表增加新的完整数据请求。

## 模块设计

### 后端巡检摘要查询

**职责：** 从 `runs`、`run_channels`、`channels`、`reports` 和必要的 `results` 标签中批量构造巡检摘要，完成过滤、计数和分页。

**对外接口：** `GET /api/runs/patrol`。

**依赖：** SQLAlchemy 查询、现有 `run_read` 的渠道字段映射、现有巡检异常分类规则；不得调用完整结果序列化路径。

### 后端 Schema

**职责：** 定义摘要和分页响应模型，明确字段边界，避免把完整证据序列化进列表响应。

**对外接口：** `PatrolRunSummaryRead`、`PatrolRunListRead`。

### 前端 API 客户端

**职责：** 将巡检查询参数编码为稳定 URL，并返回分页响应；保留现有 `runResults` 详情调用。

**对外接口：** `api.patrolRuns(params)`。

### `Runs.tsx` 巡检列表

**职责：** 用服务端分页响应渲染巡检表格、渠道筛选、只看错误按钮、错误数量和删除选择；移除页面级 `patrolEvidenceQueries`。普通任务仍走现有普通列表数据源。

### 按需详情组件

**职责：** `PatrolEvidenceCell`、`PatrolReviewCell` 和展开区域只在对应组件实际挂载时请求 `runResults`。详情失败显示行内重试/错误，不改变其他行状态。

## 模块交互

```text
Runs 页面
  ├─ 普通任务查询（保持现有行为）
  └─ patrolRuns(page, size, channel, errors_only)
       └─ 后端一次完成摘要过滤、error_count、分页
            └─ 返回当前页摘要

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
| 详情加载 | 展开/详情时 React Query 按 run id 查询 | 首屏不请求完整证据，且详情缓存可复用 |
| 渠道参数 | 传递渠道 ID；未识别渠道使用显式空值语义 | 避免依赖展示名称，查询稳定且可索引 |
| 数据库变更 | 不新增迁移 | 当前 `run_id`、`channel_id` 相关索引已存在，先消除请求级 N+1 |

## 验证设计

- 后端：用隔离数据库构造正常、异常、复审和多渠道巡检日志，验证响应不含完整结果字段、分页总数、错误筛选和渠道交集。
- 前端：先写失败测试证明列表初始化不会调用 `runResults`，再实现按需查询；验证分页/筛选变更会更新请求参数并回到第一页。
- 浏览器：在真实 `/runs` 页面监听 `/api/runs/patrol` 与 `/api/runs/*/results` 请求，确认首屏无详情请求，展开一行后仅产生对应详情请求。
