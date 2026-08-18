# Signature 异常巡检行同步高亮 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `frontend/src/runsUtils.test.ts` | 先定义 Signature 异常任务 ID 归一契约 |
| 修改 | `frontend/src/runsUtils.ts` | 实现空值、重复值和任务 ID 归一 |
| 修改 | `frontend/src/pages/Runs.tsx` | 派生严格 Signature ID 集合并接入表格行 class |
| 修改 | `frontend/src/styles.css` | 增加 Signature 专属浅红背景及 hover 样式 |
| 修改 | `frontend/e2e/runs-pagination.mjs` | 验证顶部异常与表格行高亮同步及筛选更新 |

## T1: 添加归一函数失败测试

**文件：** `frontend/src/runsUtils.test.ts`

**依赖：** 无

**步骤：**

1. 从 `runsUtils` 导入尚未实现的 `extractSignatureAnomalyRunIds`。
2. 添加包含多个 `run_id` 的 Signature 异常分组用例，期望返回对应 `Set`。
3. 添加重复 ID、空字符串和缺失 ID 用例，期望只保留一次有效 ID。
4. 添加 `null`、`undefined`、空 `items` 用例，期望返回空集合。
5. 添加 Kiro 分组、普通错误标签和运营失败输入不参与归一的边界用例，确保函数只读取传入的 Signature 分组。
6. 运行聚焦测试，确认因导出函数不存在而失败，失败原因不是测试语法或环境问题。

**验证：** 在 `frontend` 目录运行 `./node_modules/.bin/vitest run src/runsUtils.test.ts`，期望新增断言失败。

## T2: 实现最小任务 ID 归一函数

**文件：** `frontend/src/runsUtils.ts`

**依赖：** T1

**步骤：**

1. 导入 `PatrolAnomalyGroup` 类型。
2. 实现并导出 `extractSignatureAnomalyRunIds(group)`。
3. 对空输入使用空集合；读取 `group.items` 中的 `run_id`。
4. 过滤空白或非有效字符串 ID，并用 `Set` 去重。
5. 不修改异常分组或其条目对象。
6. 重新运行 T1 聚焦测试，确认全部通过。

**验证：** 在 `frontend` 目录运行 `./node_modules/.bin/vitest run src/runsUtils.test.ts`，期望新增归一测试全部通过。

## T3: 接入巡检表格行 class

**文件：** `frontend/src/pages/Runs.tsx`

**依赖：** T2

**步骤：**

1. 从 `runsUtils` 导入 `extractSignatureAnomalyRunIds`。
2. 在 `Runs` 页面根据 `patrolAnomaliesQuery.data?.invalid_thinking_signature` 派生 `signatureAnomalyRunIds`，并在查询数据变化时更新。
3. 为巡检 `Table` 增加 `rowClassName`，仅当 `signatureAnomalyRunIds.has(run.id)` 时返回 `patrol-signature-anomaly-row`。
4. 保持现有 `rowKey`、展开、复选、查看详情、取消和删除逻辑不变。
5. 确认不会读取任务名称、普通错误状态、Kiro 分组或发起额外详情请求。
6. 运行 TypeScript 检查或生产构建，确认页面接入没有类型错误。

**验证：** 在 `frontend` 目录运行 `npm run build`，期望构建成功。

## T4: 添加 Signature 专属行视觉样式

**文件：** `frontend/src/styles.css`

**依赖：** T3

**步骤：**

1. 在巡检表格样式区域新增 `.patrol-signature-anomaly-row` 规则，为单元格设置与顶部 error Alert 一致的浅红色背景。
2. 增加该行 hover 状态的略深浅红色背景，避免被全局表格 hover 规则覆盖。
3. 保持边框、文字、标签和操作按钮继承现有颜色，不调整全局表格或其他页面样式。
4. 使用专用 class 限定作用域，避免影响 Kiro、普通异常、展开详情和其他表格。

**验证：** 在 `frontend` 目录运行 `npm run build`，期望 CSS 与 TypeScript 构建成功。

## T5: 增加浏览器同步高亮回归断言

**文件：** `frontend/e2e/runs-pagination.mjs`

**依赖：** T3、T4

**步骤：**

1. 使用现有 fixture 中顶部 Signature 异常对应的任务 ID，定位巡检表格中同一任务的行。
2. 断言该行包含 `patrol-signature-anomaly-row` class。
3. 断言当前页的普通异常、Kiro 异常和运营故障行不包含该 class，除非 fixture 明确把同一任务放入 Signature 异常组。
4. 切换到不包含该 Signature 异常的渠道，断言顶部 Signature 摘要消失且当前表格行不再高亮。
5. 切换“只看错误”或分页后，断言可见行的高亮状态仍按当前异常摘要和当前数据匹配，不新增任务详情请求。
6. 保留现有分页、删除、筛选和详情链接断言。

**验证：** 先运行 `npm run build`，再在 `frontend` 目录运行 `node e2e/runs-pagination.mjs`，期望新增高亮断言通过。

## T6: 完整回归与差异检查

**文件：** 本次涉及的规格文档、前端工具、页面、样式和 E2E 测试文件

**依赖：** T5

**步骤：**

1. 运行前端完整单元测试，确认既有巡检、异常摘要和 API 用例无回归。
2. 运行生产构建，确认 TypeScript、Vite 和 CSS 打包成功。
3. 运行浏览器巡检分页脚本，确认端到端交互通过。
4. 运行 `git diff --check`，确认无空白错误。
5. 检查差异文件，只包含本次规格文档和批准范围内的前端测试、工具、页面、样式及 E2E 变更；保留已有未提交改动。

**验证：** 在 `frontend` 目录依次运行 `npm test -- --run`、`npm run build`、`node e2e/runs-pagination.mjs`，并在仓库根目录运行 `git diff --check`，期望全部退出码为 0。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6
```
