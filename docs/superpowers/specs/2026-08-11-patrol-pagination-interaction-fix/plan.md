# 自动巡检日志分页交互修复 Plan

## 架构概览

本次修复限定在运行记录页的自动巡检日志区域。页面继续一次性获取现有运行记录，在渠道筛选后由页面根据受控页码和每页条数计算当前页日志；表格只渲染这份当前页数据，不再同时承担数据切片。

分页数据流固定为：

1. 全部运行记录中拆出自动巡检日志。
2. 按渠道得到当前筛选集合。
3. 根据当前页码和每页条数校正有效页码。
4. 对筛选集合做一次且仅一次分页切片。
5. 表格渲染当前页切片；独立分页器展示筛选集合总数并更新受控状态。

删除、轮询和筛选仍作用于完整筛选集合，不会因为表格只接收当前页数据而缩小操作范围。

## 核心数据结构

### PatrolPaginationState

- `current`: 当前页码，最小为 1，并被限制在当前总页数内。
- `pageSize`: 每页条数，只接受 10、20、50、100。
- `total`: 当前渠道筛选集合的总条数。
- `visibleRuns`: 当前页应显示的日志切片。

### PatrolInteractionFixture

- 至少 25 条按固定顺序排列的自动巡检日志。
- 至少两个渠道，保证渠道筛选可验证。
- 每条日志具有稳定且可在页面读取的 ID/名称。
- 模拟现有运行记录、渠道和报告摘要接口响应，不写入真实数据库。

## 核心接口

### 当前页计算

复用现有分页纯函数，根据完整筛选集合、有效页码和每页条数返回当前页切片。该切片是表格唯一的数据源。

### 分页交互

使用独立受控分页器：

- 页码变化只更新 `current`。
- 每页条数变化同时更新 `pageSize` 并将 `current` 重置为 1。
- 渠道变化将 `current` 重置为 1。
- 筛选集合长度因轮询或删除变化时，将 `current` 校正到最后一个有效页。

分页器读取完整筛选集合的 `total`，表格关闭内部分页，避免完整集合与已切片集合被重复分页。

### 浏览器交互测试

使用仓库已有 Playwright 依赖启动前端页面，并拦截页面需要的 API 请求提供确定性数据。测试通过真实点击：

- 点击第 2 页并读取当前可见行。
- 打开每页条数菜单并选择 20 条/页。
- 切换渠道筛选并验证回到第 1 页。

测试断言表格行内容和数量发生变化，而不是只断言分页控件文本。

## 模块设计

### `Runs` 页面

**职责：** 管理渠道筛选、分页状态、当前页切片、完整筛选集合上的选择与批量删除。

**对外接口：** 保持 `/runs` 路由、查询键和后端 API 不变。

**依赖：** React 状态、TanStack Query、Ant Design Table/Pagination/Select、现有分页与筛选纯函数。

### `runsUtils`

**职责：** 保留并复用无副作用的渠道筛选、页码校正和分页切片逻辑。

**对外接口：** 现有函数签名不变；若测试暴露边界缺口，仅做最小修正。

**依赖：** `Run` 数据形状，不依赖 React 或浏览器。

### Playwright 分页交互测试

**职责：** 在真实 React、Ant Design 和路由环境中证明分页器点击会改变可见日志。

**对外接口：** 新增独立测试命令或配置，只用于自动化验收，不进入生产包。

**依赖：** 仓库现有 Playwright、Vite 开发服务器以及确定性 API mock。

## 模块交互

```text
/api/runs
  -> splitRunsByPatrol
  -> filterPatrolRunsByChannel
  -> clampPage
  -> paginateRuns
  -> Table(pagination=false, dataSource=visibleRuns)

Pagination(total=filteredRuns.length)
  -> page change -> current
  -> size change -> pageSize + current=1

filter/delete/refetch
  -> filteredRuns length changes
  -> clamp current
  -> recompute visibleRuns
```

## 文件组织

```text
frontend/src/pages/Runs.tsx                    # 当前页切片、独立受控分页器和完整集合操作
frontend/src/runsUtils.ts                     # 现有分页纯函数，必要时修正边界
frontend/src/runsUtils.test.ts                # 纯函数回归
frontend/playwright.config.ts                 # 分页交互测试的本地服务器与浏览器配置
frontend/e2e/runs-pagination.spec.ts          # 真实分页器点击、页大小和筛选交互测试
frontend/package.json                         # 增加分页交互测试命令
```

若现有 Playwright 可在不新增配置的情况下稳定执行，则不创建多余配置文件。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 数据切片责任 | 页面只切片一次 | 消除页面受控状态与 Table 内部分页之间的隐式协作和重复分页风险 |
| 表格分页 | 关闭 Table 内部分页，使用独立受控 Pagination | 表格接收当前页数据，分页器接收完整总数，职责明确 |
| 删除与选择范围 | 继续使用完整渠道筛选集合 | 分页只影响可见行，不改变已批准的按渠道删除语义 |
| 交互测试 | Playwright 页面测试 | 仓库已有 Playwright，能够覆盖 React + Ant Design 的真实点击行为，无需引入新的 DOM 测试框架 |
| 测试数据 | API 拦截提供固定 25+ 条日志 | 不依赖本地数据库或线上数据，页码和行数断言稳定可重复 |
| 最终验收 | 自动化交互测试 + 已确认页面身份的浏览器实测 | 避免再次出现纯函数测试通过但真实控件不可用 |

## 需求映射

| 需求 | 负责组件 |
|---|---|
| F1、F2、F3 | `Runs` 当前页切片与独立 Pagination；Playwright 交互测试 |
| F4 | `Runs` 页码校正副作用与交互测试 |
| F5 | `Runs` 完整筛选集合、选择和删除逻辑；现有工具函数测试 |
| N1、N2 | 前端本地分页数据流 |
| N3 | Playwright 分页交互测试 |
| N4 | checklist 中的实际 `/runs` 浏览器验收门槛 |
| N5 | 精确暂存和工作区差异检查 |
