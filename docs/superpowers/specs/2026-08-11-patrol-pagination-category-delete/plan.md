# 自动巡检日志分页与按类别删除 Plan

## 架构概览

本次改动限定在前端运行记录页的自动巡检日志区域，不改变后端查询协议或数据库结构。页面继续通过现有 `runs` 查询取得全部已加载任务，并按以下顺序处理数据：

1. 从全部运行记录拆出自动巡检日志。
2. 根据渠道选择器得到当前筛选集合。
3. 在当前筛选集合上维护受控分页状态，由 Ant Design 表格负责渲染当前页。
4. 删除操作根据当前筛选集合选取已结束日志 ID，调用现有批量删除接口。
5. 成功响应立即更新 React Query 缓存，再由查询失效完成服务端状态同步；失败项继续留在表格中并展示后端原因。

## 核心数据结构

### PatrolPaginationState

- `current`: 当前自动巡检日志页码，最小值为 1。
- `pageSize`: 当前每页条数，使用表格提供的可选值。

分页总页数由当前筛选集合长度和 `pageSize` 计算。筛选集合为空时仍保持页码 1；数据变化后将页码限制在有效范围内。

### PatrolDeleteScope

- `channel`: 当前渠道筛选值；全部渠道或具体渠道（包含未识别渠道）。
- `runs`: 当前筛选集合中的日志。
- `deletableRuns`: `runs` 中状态已结束、允许提交删除的日志。

该结构只用于页面计算，不写入后端或持久化存储。

## 核心接口

### 自动巡检日志表格分页

表格接收受控 `current` 和 `pageSize`，页码变更更新页面状态；每页条数变更更新 `pageSize` 并回到第一页。筛选渠道变化也回到第一页，筛选或删除导致总页数减少时自动校正到最后有效页。

### 自动巡检日志批量删除

继续调用前端 `api.deleteRuns(ids)` 对应的 `POST /api/runs/bulk-delete`。未筛选时传入全部自动巡检日志中的可删除 ID；选择渠道后只传入当前渠道筛选集合中的可删除 ID。接口返回的 `deleted`、`failed` 和 `missing` 按现有消息和缓存清理逻辑处理，不新增 API。

### 纯函数辅助逻辑

在 `frontend/src/runsUtils.ts` 增加可测试的分页和删除范围计算辅助函数（或沿用现有工具模块）：

- 根据列表、页码和每页条数计算当前页切片。
- 根据总条数和每页条数将页码校正到有效范围。
- 根据渠道筛选集合返回可删除的已结束日志 ID。

辅助函数保持无副作用，页面状态同步仍由 `Runs` 组件负责。

## 模块设计

### `Runs` 页面

**职责：** 管理自动巡检日志筛选、分页、选择状态、批量删除确认和查询缓存刷新。

**对外接口：** 保持现有路由和 `api.runs`、`api.deleteRuns` 调用不变；新增仅为表格分页回调和页面内部状态。

**依赖：** React 状态与副作用、TanStack Query、Ant Design `Table`/`Select`/`Popconfirm`，以及 `runsUtils` 中的纯函数。

### `runsUtils`

**职责：** 提供分页切片、页码校正和按当前渠道筛选已结束日志的确定性计算。

**对外接口：** 仅暴露纯函数和现有类型兼容的返回值，供页面和 Vitest 使用。

**依赖：** `Run` 类型与现有 `isTerminalRun` 语义；不依赖 React 或网络请求。

### 现有批量删除 API

**职责：** 执行删除、保护运行中任务和基线引用任务，并返回失败原因。

**对外接口：** 不修改。

## 模块交互

```text
runs query
  -> splitRunsByPatrol
  -> filterPatrolRunsByChannel
  -> clamp page + paginate
  -> Table(dataSource=currentPageRuns)

channel/page interaction
  -> update local state
  -> reset or clamp page

delete confirmation
  -> current filtered runs
  -> terminal/deletable IDs
  -> api.deleteRuns
  -> remove successful IDs from query cache
  -> invalidate runs/reports
  -> clamp page and clear selection
```

## 文件组织

```text
frontend/src/pages/Runs.tsx       # 自动巡检日志分页状态、表格交互和按筛选范围删除
frontend/src/runsUtils.ts        # 分页与删除范围纯函数
frontend/src/runsUtils.test.ts    # 分页、页码校正和渠道删除范围测试
```

不修改后端文件；已有后端批量删除测试继续作为保护规则回归保障。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 分页位置 | 前端本地分页 | 现有接口已返回运行记录集合，用户需求是修复表格分页，无需扩大后端协议和查询复杂度 |
| 分页控制方式 | 受控 `current`/`pageSize` | 明确解决页码显示与实际内容不同步，并可在筛选、删除、刷新后校正 |
| 删除范围 | 当前渠道筛选集合 | 满足“选择一类删除”，避免误删其他渠道；全部渠道时保持现有全部删除语义 |
| 可删除条件 | 仅已结束日志 | 保留运行中任务和后端保护规则，和现有逐条/已选删除一致 |
| 缓存更新 | 成功后先移除已删除 ID，再失效查询 | 让表格和分页总数立即响应，同时最终以服务端数据为准 |
| 测试位置 | 现有 `runsUtils.test.ts` | 纯函数可隔离验证，避免为页面引入重量级渲染测试依赖 |

## 需求映射

| 需求 | 负责组件 |
|---|---|
| F1、F2 | `Runs` 分页状态与 `runsUtils` 页码校正 |
| F3、F4 | `Runs` 删除确认与 `runsUtils` 删除范围计算 |
| F5、F6 | `Runs` 缓存更新、选择清理和确认文案；后端现有保护接口 |
| N1、N2 | `Runs` 与 `runsUtils` |
| N3、N4 | 保持现有普通任务逻辑、API 和后端保护实现不变 |
