# 渠道总览逆向异常记录 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `frontend/src/runsUtils.test.ts` | 先定义总览异常标签筛选的预期行为 |
| 修改 | `frontend/src/runsUtils.ts` | 实现异常白名单、稳定顺序和去重逻辑 |
| 修改 | `frontend/src/pages/Runs.tsx` | 在异常标签列使用筛选结果并保留空态 |

## T1: 添加失败测试定义异常筛选契约

**文件：** `frontend/src/runsUtils.test.ts`

**依赖：** 无

**步骤：**

1. 导入尚未实现的 `extractOverviewAnomalyLabels`。
2. 添加 Kiro 身份泄漏单标签用例，期望保留 `kiro_identity_leak`。
3. 添加 Signature 互验失败单标签用例，期望保留 `signature_interop_failed`。
4. 添加正常和无关标签用例，输入巡检通过、兼容、未知标签，期望空数组。
5. 添加组合异常和重复标签用例，期望以 Kiro、Signature 的固定顺序各返回一次。
6. 添加空数组、`null`、`undefined` 用例，期望空数组。
7. 运行测试并确认因接口未实现而失败，记录预期失败信息。

**验证：** 在 `frontend` 目录运行 `npm test -- src/runsUtils.test.ts`，期望测试失败，失败原因是 `extractOverviewAnomalyLabels` 尚不存在或不可调用。

## T2: 实现最小异常标签归一函数

**文件：** `frontend/src/runsUtils.ts`

**依赖：** T1

**步骤：**

1. 定义固定顺序的允许标签列表：`kiro_identity_leak`、`signature_interop_failed`。
2. 实现 `extractOverviewAnomalyLabels`，接受可空标签数组。
3. 使用集合判断输入是否包含允许标签，并按固定列表顺序构造输出。
4. 不修改输入数组，不保留未知或正常标签。
5. 运行聚焦测试，确认 T1 全部通过。

**验证：** 在 `frontend` 目录运行 `npm test -- src/runsUtils.test.ts`，期望该测试文件全部通过且无失败。

## T3: 接入渠道总览异常标签列

**文件：** `frontend/src/pages/Runs.tsx`

**依赖：** T2

**步骤：**

1. 从总览工具模块导入 `extractOverviewAnomalyLabels`。
2. 在“异常标签”列渲染时对最新报告的标签进行筛选。
3. 筛选结果非空时按既有红色 Tag 样式展示全部结果，不再用前三项截断两类目标异常。
4. 筛选结果为空或无报告时继续显示 `-`。
5. 保持其他列、指标、链接和任务操作不变。

**验证：** 在 `frontend` 目录运行 `npm run build`，期望 TypeScript 编译和 Vite 构建成功，退出码为 0。

## T4: 完整回归与差异检查

**文件：** `frontend/src/runsUtils.test.ts`、`frontend/src/runsUtils.ts`、`frontend/src/pages/Runs.tsx`

**依赖：** T3

**步骤：**

1. 运行完整前端测试，确认无既有用例回归。
2. 运行生产构建，确认类型和打包通过。
3. 运行差异格式检查，确认没有空白错误。
4. 检查 Git diff，仅包含批准范围内的实现、测试和四阶段文档，不覆盖用户已有的其他未提交修改。

**验证：** 依次运行 `npm test`、`npm run build` 和仓库根目录的 `git diff --check`，期望所有命令退出码均为 0。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4
```
