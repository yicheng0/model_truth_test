# 自动巡检删除入口易用性优化 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/tests/test_api.py` | 先增加巡检可删除数量的失败接口测试 |
| 修改 | `backend/app/schemas.py` | 为巡检分页响应增加 `deletable_count` |
| 修改 | `backend/app/main.py` | 统计当前筛选范围内已结束日志数量 |
| 修改 | `frontend/src/types.ts` | 同步分页响应类型；保留文件中现有 Claude Code 修改 |
| 修改 | `frontend/src/runsUtils.test.ts` | 先增加删除按钮状态和文案的失败测试 |
| 修改 | `frontend/src/runsUtils.ts` | 实现删除摘要纯函数 |
| 修改 | `frontend/e2e/runs-pagination.mjs` | 先增加窄视口、选择和删除流程的失败验收 |
| 修改 | `frontend/src/pages/Runs.tsx` | 实现删除数量、提示、确认文案和刷新交互 |
| 修改 | `frontend/src/styles.css` | 实现局部自适应操作栏布局 |
| 新建 | `docs/superpowers/specs/2026-08-12-patrol-delete-button-usability/checklist.md` | 定义最终行为验收清单 |

## T1: 锁定变更基线与同文件保护

**文件：** `frontend/src/types.ts`、当前 Git 工作区

**依赖：** 无

**步骤：**

1. 记录当前分支、HEAD 和工作区修改文件。
2. 保存 `frontend/src/types.ts` 中 `PatrolRunList` 附近与 Claude Code 类型附近的现有 diff 作为对照。
3. 确认 `Runs.tsx`、`styles.css`、`runsUtils.ts`、测试文件没有未提交的同文件覆盖风险。

**验证：** 运行 `git status --short` 和 `git diff -- frontend/src/types.ts`，期望明确区分本任务目标区域与用户现有修改。

## T2: RED - 增加服务端可删除数量接口测试

**文件：** `backend/tests/test_api.py`

**依赖：** T1

**步骤：**

1. 在现有巡检分页性能测试附近构造 completed、failed、pending、running 状态的多渠道日志。
2. 断言默认查询的 `deletable_count` 只统计 completed/failed。
3. 断言渠道筛选和 `errors_only=true` 后的 `deletable_count` 与当前筛选范围一致。
4. 断言空结果返回 `deletable_count=0`。
5. 运行目标测试并确认因响应缺少字段而失败。

**验证：** 运行 `cd backend && PYTHONPATH=. pytest tests/test_api.py -k patrol_delete_button_usability -v`，期望测试以缺少或错误的 `deletable_count` 失败，而不是测试环境错误。

## T3: GREEN - 实现巡检可删除数量摘要

**文件：** `backend/app/schemas.py`、`backend/app/main.py`

**依赖：** T2

**步骤：**

1. 为巡检分页响应增加默认值为 0 的 `deletable_count` 字段。
2. 默认/渠道筛选查询使用与列表相同的巡检条件，加上状态不是 pending/running 的条件进行聚合统计。
3. 错误筛选查询复用异常摘要集合，统计其中已结束日志数量。
4. 补齐所有空结果提前返回分支的字段值。
5. 运行目标测试，确认由红转绿。

**验证：** 运行 `cd backend && PYTHONPATH=. pytest tests/test_api.py -k 'patrol_delete_button_usability or patrol_query_performance' -v`，期望相关测试全部通过。

## T4: RED - 增加前端删除摘要纯函数测试

**文件：** `frontend/src/runsUtils.test.ts`

**依赖：** T3

**步骤：**

1. 增加空选择时已选可删除数量为 0、提示为“请先勾选已结束日志”的测试。
2. 增加只选择 pending/running 日志时不可删除的测试。
3. 增加混合选择时只统计 completed/failed 的测试。
4. 增加全部渠道、指定渠道和只看错误情况下删除范围文案的测试。
5. 运行目标测试并确认因纯函数尚不存在而失败。

**验证：** 运行 `cd frontend && npm test -- --run src/runsUtils.test.ts`，期望新增测试因缺少删除摘要行为而失败。

## T5: GREEN - 实现前端删除摘要状态

**文件：** `frontend/src/runsUtils.ts`、`frontend/src/types.ts`

**依赖：** T4

**步骤：**

1. 在 `PatrolRunList` 类型中追加 `deletable_count`，不改动 Claude Code 类型区域。
2. 基于现有终态判断实现删除摘要纯函数，返回已选数量、是否有选择和范围文案。
3. 保证函数不修改输入数组，且不重复定义终态枚举。
4. 运行纯函数测试并确认由红转绿。
5. 对照 T1 的 diff，确认用户现有 `types.ts` 修改完整保留。

**验证：** 运行 `cd frontend && npm test -- --run src/runsUtils.test.ts src/api.test.ts`，期望全部通过；运行 `git diff -- frontend/src/types.ts`，期望仅在目标类型附近出现本任务新增行。

## T6: RED - 增加删除入口浏览器回归

**文件：** `frontend/e2e/runs-pagination.mjs`

**依赖：** T5

**步骤：**

1. 在巡检分页 mock 响应中加入准确的 `deletable_count`，并包含至少一条 running 日志。
2. 拦截 `/api/runs/bulk-delete`，记录提交 ID 并从 mock 数据中移除成功删除项。
3. 设置能复现截图问题的较窄视口，断言两个删除按钮的边界位于工具栏可视区域内且文本没有裁切。
4. 断言默认“删除已选”不可执行并能观察到“请先勾选已结束日志”提示。
5. 勾选已结束日志，断言按钮数量、确认文案和提交 ID 正确。
6. 切换渠道与错误筛选，断言“删除当前范围”数量和范围文案同步更新。
7. 确认删除后，断言列表总数和选择状态刷新，running 日志仍存在。
8. 运行浏览器脚本并确认因现有 UI 未满足新断言而失败。

**验证：** 运行 `cd frontend && npm run test:runs-pagination`，期望新增断言在按钮布局、提示或数量处失败，现有分页断言仍可执行。

## T7: GREEN - 优化删除操作栏与交互

**文件：** `frontend/src/pages/Runs.tsx`、`frontend/src/styles.css`

**依赖：** T6

**步骤：**

1. 将卡片操作区拆分为筛选区和删除区，并添加局部 class。
2. 使用 `deletable_count` 和删除摘要状态生成按钮数量及确认文案。
3. 为不可执行的“删除已选”提供可悬停、可聚焦的提示包装，同时保持实际按钮禁用。
4. 将“删除全部已结束”调整为“删除当前范围（N）”，渠道筛选时明确渠道范围，错误筛选时明确仅错误范围。
5. 数量为 0 时禁用范围删除；确认执行继续调用现有批量删除路径。
6. 删除成功后清空选择并失效相关查询，确保分页总数重新计算。
7. 增加局部 flex 换行、gap、最小宽度和按钮不收缩样式，避免文字裁切。
8. 运行浏览器回归并确认由红转绿。

**验证：** 运行 `cd frontend && npm run test:runs-pagination`，期望删除入口、窄视口、筛选和刷新断言全部通过。

## T8: 回归测试与生产构建

**文件：** 所有本任务文件

**依赖：** T3、T5、T7

**步骤：**

1. 运行后端目标测试和完整测试。
2. 运行前端完整单元测试、生产构建和浏览器回归。
3. 运行 `git diff --check`。
4. 检查控制台无 React 警告、未处理异常或失败网络请求。

**验证：**

- `cd backend && PYTHONPATH=. pytest -q` 全部通过。
- `cd frontend && npm test -- --run` 全部通过。
- `cd frontend && npm run build` 成功。
- `cd frontend && npm run test:runs-pagination` 成功。
- `git diff --check` 无输出。

## T9: 变更范围与文档核对

**文件：** 本任务文档、源码和测试文件

**依赖：** T8

**步骤：**

1. 对照 `spec.md`、`plan.md` 和后续 `checklist.md` 核对每项需求。
2. 检查 `git diff --stat` 和逐文件 diff，只保留本任务改动。
3. 确认未修改普通检测任务删除、批量删除接口、权限校验和未结束日志保护逻辑。
4. 确认用户现有 Claude Code 修改及其他规格文档修改未被覆盖或纳入本任务。

**验证：** 运行 `git status --short`、`git diff --stat` 和目标文件 diff，期望范围与文件清单一致，其他用户修改保持原样。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T7 -> T8 -> T9
```
