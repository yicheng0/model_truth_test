# Signature 异常巡检行同步高亮 Plan

## 架构概览

复用现有 `patrolAnomaliesQuery` 的严格异常摘要和 `patrolQuery` 的当前分页数据，在前端页面内建立一个只读的 Signature 异常任务 ID 集合。Ant Design 巡检表格通过现有 `rowClassName` 接口为命中的任务行增加专用 class，CSS 仅调整该 class 的单元格背景与悬停颜色。

数据流：

```text
/api/runs/patrol/anomalies
  -> invalid_thinking_signature.items[].run_id
  -> signatureAnomalyRunIds
  -> 自动巡检表格 rowClassName(run.id)
  -> Signature 专属浅红色行背景
```

顶部异常提示继续使用现有异常摘要，不新增请求、不改异常判定和链接行为。表格行只读取当前已有的 `run.id`，因此分页、渠道筛选和“只看错误”切换会自然使用当前查询结果重新计算高亮。

## 核心数据结构

### Signature 异常任务 ID 集合

- 输入：现有 `PatrolAnomalyGroup | undefined`，读取其中的 `items`。
- 输出：`Set<string>`，内容为去除空值后的 `run_id`。
- 语义：集合只代表顶部严格分类 `invalid_thinking_signature` 的任务，不从表格行状态、标签或任务名称推导。
- 生命周期：随异常摘要查询结果更新；查询为空、失败或没有条目时为空集合。

### 巡检表格行 class

- 命中 Signature 异常集合：`patrol-signature-anomaly-row`。
- 未命中：空 class。
- 行 key 仍使用现有 `run.id`，不改变展开、选择和操作逻辑。

## 核心接口

### `extractSignatureAnomalyRunIds`

**用途：** 将严格 Signature 异常分组归一为任务 ID 集合，供列表渲染使用。

**输入：** `PatrolAnomalyGroup | null | undefined`。

**输出：** `Set<string>`。

**行为：** 仅读取 `items[].run_id`；忽略空 ID；不修改输入；重复 ID 只保留一次；空输入返回空集合。

### 巡检表格 `rowClassName`

**用途：** 将当前行任务 ID 映射为 Signature 专属高亮 class。

**行为：** 仅当 `signatureAnomalyRunIds.has(run.id)` 时返回 `patrol-signature-anomaly-row`；其他行保持空 class。

## 模块设计

### 前端巡检工具模块

**职责：** 提供可单元测试的 Signature 异常任务 ID 归一函数，集中处理空值、重复值和异常摘要边界。

**对外接口：** `extractSignatureAnomalyRunIds`。

**依赖：** 现有 `PatrolAnomalyGroup` 类型，无新增依赖。

### 自动巡检日志页面

**职责：** 从现有严格异常查询派生 ID 集合，并通过表格 `rowClassName` 为命中行添加 class。

**依赖：** `patrolAnomaliesQuery.data?.invalid_thinking_signature`、现有 `patrolQuery` 和 Ant Design Table。

**边界：** 不读取 Kiro 分组、不读取普通错误数量、不按 `run.name` 匹配，不发起任务详情请求。

### 巡检表格样式

**职责：** 用与顶部错误提示一致的浅红色语义突出命中行；为 hover 状态提供略深的浅红色背景，保证文字、标签和操作按钮的现有对比度。

**边界：** 只作用于 `.patrol-log-table` 下的专用行 class，不影响其他表格、展开行或全局颜色语义。

### 前端测试与浏览器回归

**职责：** 单元测试验证 ID 归一和严格边界；现有巡检分页 E2E 增加 DOM class 断言，验证顶部 Signature 条目与当前页行同步、渠道切换后移除非当前渠道高亮，以及普通/Kiro/运营行不误高亮。

## 模块交互

1. 页面加载现有巡检分页和严格异常摘要查询。
2. 页面将 `invalid_thinking_signature` 分组交给归一函数，得到任务 ID 集合。
3. Table 为每个当前分页 `run` 调用 `rowClassName`。
4. 命中集合的行获得 Signature 专属 class，其他行维持原样。
5. 渠道、页码、每页数量或错误筛选变化时，React Query 返回新数据，集合和行 class 随之重新计算。
6. 删除或取消任务后，现有 query invalidation 刷新摘要与表格，高亮同步消失或更新。

## 文件组织

```text
frontend/src/runsUtils.ts
  # 新增 Signature 异常 run_id 归一函数

frontend/src/runsUtils.test.ts
  # 新增空值、重复、严格匹配和运营边界测试

frontend/src/pages/Runs.tsx
  # 派生集合并接入巡检表格 rowClassName

frontend/src/styles.css
  # 新增 Signature 专属行背景与 hover 样式

frontend/e2e/runs-pagination.mjs
  # 增加顶部摘要与表格行高亮的浏览器断言
```

不修改后端接口、数据库模型、巡检执行器、评分、报告、告警和飞书通知逻辑。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 异常来源 | 使用严格摘要的 `invalid_thinking_signature.items[].run_id` | 与顶部展示共享同一证据口径，避免前端从普通失败状态猜测 Signature 异常 |
| 匹配键 | `run.id` 与 `run_id` 精确匹配 | 任务名称可重复或被格式化，任务标识才是稳定定位键 |
| 数据结构 | `Set<string>` | 查询更新时快速判断，天然去重，不改变源数据 |
| 页面接入 | Ant Design Table `rowClassName` | 只增加展示 class，不改行数据、列、展开、选择和操作事件 |
| 颜色 | 巡检表格专用浅红背景，hover 使用更深浅红 | 与顶部 error Alert 语义一致，同时保持表格可读性 |
| 请求策略 | 复用现有两个查询 | 满足不新增详情请求，筛选和分页状态自动同步 |
