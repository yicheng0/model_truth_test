# 自动巡检日志错误筛选 Plan

## 架构概览

本次改动限定在前端自动巡检日志集合筛选和工具栏交互，不修改后端接口、数据库或现有巡检证据分类。页面先按现有渠道条件得到巡检日志集合，再按“只看错误”开关调用同一套 `patrolEvidenceDisplayState` 判断结果状态，最后继续使用现有分页、行选择和删除逻辑。

错误状态判断保持现有语义：`displayState === 'error'` 的记录属于错误；`displayState === 'ok'` 的记录不属于错误。无法加载证据的记录不额外制造错误筛选结果，避免把请求失败误当成巡检异常。

## 核心数据结构

### PatrolErrorFilterState

- `onlyErrors: boolean`：是否开启“只看错误”。
- 默认值为 `false`。
- 按钮切换时将巡检页码重置为 1。

### Patrol filtered runs

现有 `filteredPatrolRuns` 拆分为两个连续步骤：

1. 渠道筛选：保留现有顺序。
2. 错误筛选：仅保留已有错误状态的日志；关闭时原样返回渠道筛选结果。

## 核心接口

### `filterPatrolRunsByError`

**输入：** `Run[]`、错误筛选开关和每条日志的已缓存证据状态。

**输出：** 与输入顺序一致的可见日志集合。

由于每条结果证据通过异步查询获取，页面层使用已存在的 React Query 缓存结果计算错误集合；证据尚未加载时不把该日志当成错误，加载完成后随查询状态刷新。

## 模块设计

### `frontend/src/runsUtils.ts`

**职责：** 增加无副作用的错误集合过滤辅助函数，复用 `patrolEvidenceDisplayState`。

**对外接口：** `filterPatrolRunsByError(runs, onlyErrors, stateByRunId)`。

**依赖：** `Run` 类型和已有 `PatrolEvidenceDisplayState`。

### `frontend/src/pages/Runs.tsx`

**职责：** 管理“只看错误”开关，准备当前日志的证据状态缓存，按渠道和错误条件生成列表，并把同一筛选集合用于分页、选择和删除。

**工具栏：** 在渠道 `Select` 旁新增一个按钮，文案为“只看错误”；关闭时为普通按钮，开启时使用选中/危险强调状态，并显示错误日志数量。

**证据查询：** 复用当前每行 `runResults` 查询的 React Query 缓存；列表筛选所需的证据摘要只读取已成功加载的结果，不新增请求接口。

### `frontend/src/runsUtils.test.ts`

**职责：** 覆盖全量、错误筛选、空结果、状态缺失和顺序保持。

### `frontend/e2e/runs-pagination.mjs`

**职责：** 使用固定正常/异常/运营故障日志，验证按钮切换、错误数量、渠道组合、分页和每页条数。

## 模块交互

```text
/api/runs/{run_id}/results
  -> React Query cache
  -> patrolEvidenceDisplayState
  -> stateByRunId
  -> channel filter
  -> only-errors filter
  -> paginateRuns
  -> table / selection / delete scope
```

## 文件组织

```text
frontend/src/runsUtils.ts       # 错误集合过滤纯函数
frontend/src/runsUtils.test.ts  # 过滤规则和顺序测试
frontend/src/pages/Runs.tsx     # 按钮、证据缓存和筛选联动
frontend/e2e/runs-pagination.mjs # 浏览器按钮与分页验收
docs/superpowers/specs/2026-08-12-patrol-error-filter/ # 规格、设计、任务和清单
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 错误定义 | 复用 `patrolEvidenceDisplayState().displayState === 'error'` | 与现有结果标签和复审判断一致 |
| 数据来源 | 复用 React Query 已有结果查询 | 不新增后端接口和重复数据请求 |
| 默认状态 | 关闭“只看错误” | 保持当前日志列表默认行为 |
| 筛选位置 | 自动巡检日志卡片顶部工具栏 | 与图 2 的渠道筛选区域一致，操作路径最短 |
| 计数口径 | 当前渠道条件下已加载且判定为 error 的日志数 | 正常日志不统计；不把加载中的记录误报为错误 |
| 排序 | 不排序，只过滤 | 保持原有时间和日志顺序 |
