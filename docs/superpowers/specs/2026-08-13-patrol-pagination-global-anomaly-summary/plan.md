# 自动巡检分页与全局异常置顶 Plan

## 架构概览

本方案沿用现有自动巡检服务端分页接口，在一次分页响应中同时返回：当前页日志、当前渠道范围的总数/错误数，以及固定大小的全局真实性异常摘要。

分页交互以页面本地的目标页为唯一控制状态。查询结果只负责提供数据，不直接替代分页器当前页；仅当响应明确对应当前目标页，且总数证明该页已经越界时，才把页码校正到最后一个有效页。切换渠道和每页条数仍由用户操作显式重置到第 1 页。

异常汇总由后端基于当前渠道范围内每个巡检任务的最新报告统一计算。后端区分明确 Kiro 身份泄漏、明确 Thinking Signature 拒绝与运营故障，返回每类总数及有限数量的可定位记录。前端直接渲染摘要并链接到任务详情，不再为全部任务逐条请求完整结果。

## 核心数据结构

### PatrolAnomalyEntry

单条可定位异常摘要：

- `run_id`: 对应巡检任务标识，用于进入详情。
- `run_name`: 任务名称，用于顶部入口文案。
- `channel_id`、`channel_name`: 命中渠道信息。
- `created_at`: 任务或最新报告时间，用于稳定排序。
- `request_ids`: 已脱敏、去重的少量 Request ID。
- `http_status`: 明确 Signature 拒绝时的 HTTP 状态；Kiro 无对应状态时为空。
- `stage`: 可用的检测阶段，例如身份探针或 Relay。

### PatrolAnomalyGroup

单类异常的跨页汇总：

- `count`: 当前渠道筛选范围内的命中任务总数，不受当前页和“只看错误”开关影响。
- `items`: 按最新时间倒序排列的有限数量 `PatrolAnomalyEntry`，用于顶部快捷入口。
- `truncated`: 命中数是否超过返回入口数量，前端据此显示“另有 N 条”。

### PatrolAnomalySummary

- `kiro_identity_leak`: Kiro 身份泄漏汇总。
- `invalid_thinking_signature`: 明确 Thinking Signature 拒绝汇总。

### PatrolRunList

在现有分页响应中增加 `anomaly_summary`。现有 `items`、`total`、`error_count`、`deletable_count`、`page` 和 `page_size` 保持兼容。

### PatrolPaginationState

前端分页状态由以下值组成：

- `requestedPage`: 用户当前目标页，直接驱动查询参数和分页器。
- `pageSize`: 当前每页条数。
- `responsePage`: 服务端响应对应的请求页，仅用于判断响应是否仍然有效。
- `total`: 当前筛选范围总数。

越界校正只在 `responsePage === requestedPage` 且该响应已完成时执行；若 `requestedPage` 大于按 `total/pageSize` 计算的最后页，则校正到最后页，否则不改页码。

## 核心接口

### 自动巡检分页查询

继续使用 `GET /api/runs/patrol`：

- 输入：`page`、`page_size`、可选 `channel_id`、`errors_only`。
- 输出：当前页轻量日志、统计计数和 `anomaly_summary`。
- `channel_id` 同时约束日志和异常摘要。
- `errors_only` 只约束日志 `items`、`total` 和删除范围，不约束 `anomaly_summary`。
- 无数据或请求页越界时仍返回真实总数和请求页，不用临时 `total=0` 表示空页。

### 明确异常分类

后端对每个范围内任务只采用最新报告：

- Kiro：优先命中结构化 `kiro_identity_leak` 标签；历史兼容只识别身份探针中的明确“我是 Kiro”或 “I am Kiro”自报。
- Signature：优先命中明确拒绝结构；历史兼容要求 HTTP 400 且错误文本匹配 `Invalid signature in thinking block`。
- 运营故障：`signature_ok=null`、权限/账号/模型不可用、配额、网络、超时、HTTP 5xx 和临时不可用均不进入两类汇总。
- 普通讨论文本只出现 `kiro` 或 `signature` 不命中。

### 页码校正

前端提供可测试的纯逻辑，输入当前目标页、响应页、总数、每页条数和查询完成状态，输出保持当前页或最后一个有效页。旧响应、加载中状态和仍在有效范围内的页码一律保持不变。

## 模块设计

### 后端巡检列表 Schema

**职责：** 定义异常入口、异常分组和分页响应新增字段，保持已有字段默认值兼容。

**对外接口：** `PatrolAnomalyEntryRead`、`PatrolAnomalyGroupRead`、`PatrolAnomalySummaryRead` 及扩展后的 `PatrolRunListRead`。

**依赖：** 仅依赖现有 Pydantic 模型。

### 后端巡检汇总服务

**职责：** 在当前渠道范围内读取最新报告，复用现有异常边界生成错误数和两类全局异常摘要；确保分页页数据与全局统计使用一致的“每任务最新报告”口径。

**对外接口：** 由自动巡检分页路由内部调用的纯分类和汇总函数。

**依赖：** 现有 Run、RunChannel、Report 和 Channel 数据；不读取完整 Result 集合，不新增数据库表。

### 前端领域类型与 API

**职责：** 描述 `anomaly_summary`，保持自动巡检查询调用方式不变。

**对外接口：** 扩展 `PatrolRunList` 及新增异常摘要类型。

**依赖：** 现有集中 API 客户端。

### 前端分页状态逻辑

**职责：** 阻止旧响应或短暂空结果覆盖新目标页；在真实越界时计算最后有效页。

**对外接口：** 可单元测试的页码校正函数，以及页面内受控分页状态。

**依赖：** 查询响应中的 `page`、`total` 和当前 `pageSize`。

### 自动巡检日志页面

**职责：** 以目标页驱动查询和分页器；在表格顶部渲染 Kiro 与 Signature 两类 Alert；展示总数、有限入口和剩余数量；入口链接到 `/runs/{run_id}`。

**对外接口：** 不新增路由。异常详情继续复用现有任务详情页。

**依赖：** 自动巡检分页响应、React Query、Ant Design Alert/Tag/Link。

### 自动化测试

**职责：** 后端验证跨页/渠道/运营故障分类；前端纯函数验证响应竞态和越界；浏览器测试真实点击第 6 页、轮询稳定性、渠道变化和异常入口。

**依赖：** 现有 pytest、Vitest 和 Playwright 脚本。

## 模块交互

```text
用户点击第 6 页
  -> requestedPage = 6
  -> GET /api/runs/patrol?page=6...
  -> 旧第 1 页响应到达
       -> responsePage != requestedPage
       -> 不校正页码
  -> 第 6 页响应到达
       -> responsePage == requestedPage
       -> 有效页：保持第 6 页
       -> 已越界：校正到最后有效页并重新查询

GET /api/runs/patrol
  -> 建立巡检及渠道筛选范围
  -> 读取范围内每个任务的最新报告
  -> 计算 error_count + anomaly_summary
  -> 对日志集合应用 errors_only 和分页
  -> 返回固定大小响应
  -> 页面顶部渲染跨页 Kiro/Signature 摘要
  -> 点击入口进入现有巡检详情
```

## 文件组织

```text
backend/
├── app/schemas.py                 # 异常摘要与分页响应模型
├── app/main.py                    # 最新报告查询、异常分类、汇总和分页路由
└── tests/test_api.py              # 跨页统计、过滤边界和越界分页测试
frontend/
├── src/types.ts                   # 异常摘要领域类型
├── src/runsUtils.ts               # 页码校正纯逻辑
├── src/runsUtils.test.ts          # 竞态、有效页和越界校正单元测试
├── src/pages/Runs.tsx             # 受控分页与顶部异常摘要 UI
└── e2e/runs-pagination.mjs        # 第 6 页稳定性和跨页异常浏览器测试
docs/superpowers/specs/2026-08-13-patrol-pagination-global-anomaly-summary/
├── spec.md
└── plan.md
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 异常汇总接口 | 随巡检分页响应返回 | 页面只需一个固定请求；渠道范围天然一致；不增加逐条详情请求 |
| 汇总范围 | 当前渠道、全部分页，不受 `errors_only` 影响 | 符合“顶部全局真实性异常”语义，避免开关改变异常事实 |
| 报告口径 | 每任务最新报告 | 与列表当前状态一致，避免历史旧异常重复计数 |
| 入口数量 | 每类固定上限，另返回总数与截断标记 | 控制响应大小，同时保留跨页总量和可定位能力 |
| 分页当前值 | 使用本地目标页 | 防止旧响应中的页码覆盖用户新操作 |
| 页码校正 | 仅处理与当前请求匹配的完成响应 | 消除查询竞态，同时保留删除后的合法越界修正 |
| Signature 判定 | 结构化明确拒绝，或 HTTP 400 + 精确错误 | 保持已批准的运营故障不误报边界 |
| Kiro 判定 | 结构化标签优先，历史明确身份自报兜底 | 兼容历史数据但避免关键词误报 |
| 数据库变更 | 不新增表、索引或迁移 | 现有报告证据足以支持本周期，保持 SQLite/PostgreSQL 兼容 |
