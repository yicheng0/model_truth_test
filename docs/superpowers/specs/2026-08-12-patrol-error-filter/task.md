# 自动巡检日志错误筛选 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `frontend/src/runsUtils.test.ts` | 增加只看错误过滤纯函数测试 |
| 修改 | `frontend/src/runsUtils.ts` | 实现错误集合过滤辅助函数 |
| 修改 | `frontend/src/pages/Runs.tsx` | 增加按钮、证据状态缓存和筛选联动 |
| 修改 | `frontend/e2e/runs-pagination.mjs` | 增加按钮、渠道组合和分页浏览器验收 |
| 新建 | `docs/superpowers/specs/2026-08-12-patrol-error-filter/checklist.md` | 记录验收证据 |

## T1: 建立错误集合过滤回归矩阵

**文件：** `frontend/src/runsUtils.test.ts`

**依赖：** 无

**步骤：**

1. 增加 `filterPatrolRunsByError` 的导入和测试数据构造辅助。
2. 增加默认关闭测试：关闭“只看错误”时返回输入全部日志且顺序不变。
3. 增加开启测试：错误状态映射为 `error` 的日志保留，`ok` 日志排除。
4. 增加边界测试：空列表、缺少状态的日志和全部正常日志返回空集合。
5. 增加组合测试：先按渠道得到集合，再按错误过滤不会改变剩余顺序。
6. 运行聚焦测试，确认新增用例在函数尚不存在时失败。

**验证：**

```bash
cd frontend
npx vitest run src/runsUtils.test.ts
```

预期：新增测试因 `filterPatrolRunsByError` 尚不存在而失败，既有测试保持可收集。

## T2: 实现错误集合过滤纯函数

**文件：** `frontend/src/runsUtils.ts`

**依赖：** T1

**步骤：**

1. 定义 `filterPatrolRunsByError(runs, onlyErrors, stateByRunId)`。
2. 当 `onlyErrors` 为 `false` 时返回原数组的浅拷贝，避免调用方意外修改输入。
3. 当 `onlyErrors` 为 `true` 时只保留 `stateByRunId.get(run.id) === 'error'` 的日志。
4. 对未加载或没有状态的日志按非错误处理，不推断为错误。
5. 保持输入顺序，不在纯函数内排序、去重或改变日志对象。
6. 重跑聚焦工具测试确认 RED -> GREEN。

**验证：**

```bash
cd frontend
npx vitest run src/runsUtils.test.ts
```

预期：全部工具测试通过。

## T3: 接入“只看错误”按钮和筛选数据流

**文件：** `frontend/src/pages/Runs.tsx`

**依赖：** T2

**步骤：**

1. 增加 `onlyPatrolErrors` 状态，默认 `false`。
2. 复用当前自动巡检行结果查询，把成功结果归一化为 `run.id -> patrolEvidenceDisplayState(evidence).displayState` 的映射。
3. 在现有渠道筛选结果上调用 `filterPatrolRunsByError`，形成最终 `filteredPatrolRuns`。
4. 让 `selectedPatrolRuns`、可删除集合、分页总数、表格数据源和页码校正全部使用最终筛选集合。
5. 在自动巡检日志卡片工具栏渠道选择旁增加“只看错误”按钮；按钮点击切换状态并将页码设为 1。
6. 按钮文案固定为“只看错误”，开启时使用 `type="primary"` 或等效选中样式；关闭时保持普通按钮样式。
7. 在按钮旁显示当前渠道范围内已判定错误数量；数量不把正确、运营故障或未加载记录计入。
8. 去除本需求范围内默认行的错误正文直显，恢复紧凑结果区域；保留状态标签、探针芯片、展开和详情入口。
9. 确认切换筛选不会清理筛选外日志的后端数据，只清理当前不可见行的选择状态。

**验证：**

```bash
cd frontend
npx vitest run src/api.test.ts src/runsUtils.test.ts
npm run build
```

预期：聚焦测试和生产构建通过。

## T4: 扩展浏览器交互验收

**文件：** `frontend/e2e/runs-pagination.mjs`

**依赖：** T3

**步骤：**

1. 固定返回正确、真实异常、运营故障和需要复审的巡检日志。
2. 进入 `/runs`，断言“只看错误”按钮默认关闭，默认行数包含正确和错误日志。
3. 点击“只看错误”，断言按钮进入选中状态，正确日志消失，错误数量与可见行数只对应异常/复审日志。
4. 在错误筛选开启时切换渠道 A，断言只保留渠道 A 的错误日志。
5. 切换回全部日志，断言渠道 A 的正常日志恢复且原顺序不变。
6. 构造超过一页的错误日志，验证第 2 页数据变化；切换页大小后页码回到 1。
7. 检查浏览器控制台和页面错误为空，结束时关闭浏览器和预览进程组。

**验证：**

```bash
cd frontend
npm run build
npm run test:runs-pagination
```

预期：浏览器按钮、组合筛选和分页断言全部通过。

## T5: 完整验收与清单记录

**文件：** `docs/superpowers/specs/2026-08-12-patrol-error-filter/checklist.md`

**依赖：** T4

**步骤：**

1. 根据已批准 spec 和 plan 建立实现、集成、编译测试和端到端清单。
2. 运行前端全量测试、生产构建、浏览器验收和 `git diff --check`。
3. 逐项记录实际输出，只有有证据的项目才勾选。
4. 检查 `git status --short`，确认用户已有 Claude Code 未提交改动未被暂存。

**验证：**

```bash
cd frontend
npm test
npm run build
npm run test:runs-pagination
cd ..
git diff --check
git status --short
```

预期：测试、构建和浏览器验收通过；工作区范围仅包含本需求文件与用户已有未提交文件。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5
```
