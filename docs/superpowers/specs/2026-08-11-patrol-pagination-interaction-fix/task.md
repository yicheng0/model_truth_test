# 自动巡检日志分页交互修复 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `frontend/src/pages/Runs.tsx` | 使用当前页切片作为表格数据源，并用独立受控分页器管理交互 |
| 修改（仅在边界测试需要时） | `frontend/src/runsUtils.ts` | 修正分页切片或页码校正边界 |
| 修改 | `frontend/src/runsUtils.test.ts` | 保留分页纯函数、筛选和删除范围回归 |
| 新建 | `frontend/e2e/runs-pagination.mjs` | 启动浏览器、模拟 API、真实点击分页器并断言可见日志 |
| 修改 | `frontend/package.json` | 增加分页交互测试命令 |
| 新建（仅需要时） | `frontend/playwright.config.ts` | 仅当现有 Playwright 脚本无法自行管理服务器时提供配置 |

## T1: 建立真实分页交互失败用例

**文件：** `frontend/e2e/runs-pagination.mjs`、`frontend/package.json`

**依赖：** 无

**步骤：**
1. 使用现有 Playwright 启动 Chromium，并启动或连接专用 Vite 测试端口。
2. 拦截 `/api/runs`、`/api/channels` 和 `/api/reports/summary` 等 `/runs` 页面所需请求，返回至少 25 条固定顺序的巡检日志和两个渠道。
3. 打开 `/runs`，读取自动巡检日志表格中第一页的稳定日志标识。
4. 点击第 2 页，断言可见日志标识与第一页不同。
5. 打开每页条数菜单选择 20 条/页，断言回到第 1 页并显示 20 条日志。
6. 切换渠道筛选，断言回到第 1 页且只显示该渠道日志。
7. 在修复页面前运行用例，记录其失败在可见行未按交互变化，而不是环境或选择器问题。

**验证：** 运行 `cd frontend && npm run test:runs-pagination`，修复前期望在页码或页大小的可见行断言处失败。

## T2: 将分页切片接入真实表格数据流

**文件：** `frontend/src/pages/Runs.tsx`

**依赖：** T1

**步骤：**
1. 基于已校正页码、筛选集合和每页条数计算 `visiblePatrolRuns`。
2. 将自动巡检日志 Table 的数据源改为 `visiblePatrolRuns`。
3. 关闭 Table 内部分页，确保日志只被页面切片一次。
4. 在表格下方增加独立受控 Pagination，并配置当前页、总数、每页条数选项、总数文本和页码/页大小回调。
5. 保持 Table 的展开、行选择、详情、删除和横向滚动配置不变。
6. 保持批量删除、当前渠道可删除数量和选中状态基于完整 `filteredPatrolRuns`，不改为当前页范围。

**验证：** 重跑 `cd frontend && npm run test:runs-pagination`，期望页码、返回第一页、20 条/页和渠道筛选交互全部通过。

## T3: 补充分页状态变化边界测试

**文件：** `frontend/e2e/runs-pagination.mjs`、`frontend/src/runsUtils.test.ts`、必要时 `frontend/src/runsUtils.ts`

**依赖：** T2

**步骤：**
1. 在交互测试中从较后页切换每页条数，验证页码回到 1。
2. 在交互测试中切换到日志数量较少的渠道，验证页面不为空且页码为 1。
3. 通过可变 mock 响应模拟日志集合减少或刷新，验证当前页被校正到最后有效页。
4. 确认不足 20 条时选择 20 条/页会显示全部剩余日志。
5. 保留并运行 `clampPage`、`paginateRuns`、渠道筛选和删除范围纯函数测试；只有发现真实边界缺陷时才最小修改工具函数。

**验证：** 运行 `cd frontend && npm run test:runs-pagination && npx vitest run src/runsUtils.test.ts`，期望交互和纯函数测试全部通过。

## T4: 执行前端完整回归

**文件：** 本次所有前端改动

**依赖：** T3

**步骤：**
1. 运行前端全量 Vitest。
2. 运行 TypeScript 与 Vite 生产构建。
3. 再运行分页交互测试，确认构建或其他测试没有掩盖交互问题。
4. 检查控制台错误和未处理请求；测试脚本退出时关闭浏览器和测试服务器。

**验证：**

- `cd frontend && npm test`：全部测试通过。
- `cd frontend && npm run build`：TypeScript 和 Vite 构建成功。
- `cd frontend && npm run test:runs-pagination`：真实分页交互测试通过。

## T5: 在确认身份的实际页面完成浏览器验收

**文件：** 无代码文件；结果记录到后续 `checklist.md`

**依赖：** T4

**步骤：**
1. 启动并确认本仓库前端和后端的端口所有者、页面标题和 `/api/health` 身份；不得使用当前被其他项目占用的端口作为证据。
2. 准备或确认至少 25 条巡检日志，打开该实例的 `/runs`。
3. 记录第一页可见日志，点击第 2 页并确认日志变化，再返回第一页。
4. 选择 20 条/页，确认可见行数和总页数变化。
5. 在较后页切换渠道筛选，确认回到第 1 页且只显示对应渠道。
6. 若本地真实数据不足以覆盖分页，使用 T1 的确定性测试实例作为浏览器验收页面，但必须确认它运行的是当前工作区代码。

**验证：** 浏览器实际观察满足 AC1、AC2、AC3；任一项未观察到时不得宣告修复完成。

## T6: 范围与发布前检查

**文件：** 本次任务文件与批准文档

**依赖：** T5

**步骤：**
1. 运行 `git diff --check`。
2. 运行 `git status --short`，确认用户已有 Claude Code 前端改动未被覆盖。
3. 检查任务差异只涉及分页数据流、交互测试、测试命令和批准文档。
4. 未收到提交或 push 指令时不执行发布。

**验证：** `git diff --check` 无输出；工作区中现有用户改动保持原样，本次文件范围符合批准设计。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6
```
