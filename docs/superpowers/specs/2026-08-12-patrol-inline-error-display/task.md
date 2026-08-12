# 自动巡检日志直接展示错误 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `frontend/src/runsUtils.test.ts` | 先建立错误选择、分类和边界失败测试 |
| 修改 | `frontend/src/runsUtils.ts` | 实现统一的主要错误提取和分类纯函数 |
| 修改 | `frontend/src/pages/Runs.tsx` | 在紧凑巡检结果和加载失败分支直接展示错误 |
| 修改 | `frontend/src/styles.css` | 控制错误正文两行截断、换行和颜色 |
| 修改 | `frontend/e2e/runs-pagination.mjs` | 验证错误无需交互即可看见且分页后对应正确日志 |
| 修改 | `docs/superpowers/specs/2026-08-12-patrol-inline-error-display/checklist.md` | 记录实际验收证据 |

## T1: 建立主要错误提取回归矩阵

**文件：** `frontend/src/runsUtils.test.ts`

**依赖：** 无

**步骤：**
1. 增加普通模型探针错误测试，验证优先返回具体 `error` 而不是内部标签。
2. 增加只有错误响应正文的测试，验证正文可作为直接展示错误。
3. 增加网络超时、500/503、额度不足和资源池不可用测试，验证类型均为运营错误并保留具体正文。
4. 增加明确 `Invalid signature in thinking block` 测试，验证类型为 Signature。
5. 增加 `signature validation timed out` 和 `network error while validating signature` 测试，验证类型为运营错误。
6. 增加正常证据测试，验证不返回错误；增加分类原因和标签中文解释兜底测试。
7. 先运行测试，确认失败原因是主要错误提取函数尚不存在或行为缺失。

**验证：** `cd frontend && npx vitest run src/runsUtils.test.ts`，实现前新增用例应失败，且失败点与错误提取行为一致。

## T2: 实现统一主要错误提取

**文件：** `frontend/src/runsUtils.ts`

**依赖：** T1

**步骤：**
1. 定义主要错误返回结构和允许的错误类型。
2. 按批准优先级遍历模型探针、Signature 证据、分类原因、报告摘要和标签解释。
3. 复用现有运营故障判断；运营错误优先于 Signature 单词的模糊匹配。
4. 只有明确 thinking block Signature 拒绝才返回 Signature 类型。
5. 压缩列表正文中的连续空白，同时保留完整脱敏正文供 Tooltip 使用。
6. 正常证据且没有运营失败时返回 `null`，不直接显示内部通过标签。

**验证：** 重跑 `cd frontend && npx vitest run src/runsUtils.test.ts`，新增和既有测试全部通过。

## T3: 接入巡检列表直接错误展示

**文件：** `frontend/src/pages/Runs.tsx`

**依赖：** T2

**步骤：**
1. 在紧凑巡检结果中读取主要错误。
2. 保留第一层结果和探针标签，在其下增加错误正文层。
3. 运营错误使用警示语义，Signature/普通真异常使用危险语义；不改变现有状态和复审判定。
4. 错误正文无需悬浮或点击即可出现在 DOM 中，Tooltip 展示完整脱敏正文。
5. 详情接口加载失败时，直接显示“日志加载失败”和实际可读原因，而不是只在 Tooltip 中展示。
6. 正常证据不渲染错误正文。

**验证：** 运行 `cd frontend && npm run build`，期望类型检查与构建通过；再运行相关 Vitest，期望无回归。

## T4: 限制长错误布局

**文件：** `frontend/src/styles.css`

**依赖：** T3

**步骤：**
1. 为直接错误正文增加巡检日志作用域样式。
2. 将正文限制为两行和固定最大高度，超出部分省略。
3. 为长 URL、JSON、request ID 和无空格字符串启用安全断行，避免溢出单元格。
4. 保持错误正文可读字号和行高，避免覆盖标签或操作列。
5. 运营错误和真异常使用现有告警颜色体系中的不同文本颜色，不新增大面积底色或卡片。

**验证：** 在浏览器固定数据中加入超长 JSON 与长 request ID，截图检查表格没有横向异常扩张、文字重叠或行高失控。

## T5: 扩展真实浏览器列表测试

**文件：** `frontend/e2e/runs-pagination.mjs`

**依赖：** T3、T4

**步骤：**
1. 为固定巡检日志详情响应增加普通探针错误、运营错误、明确 Signature 错误、含 signature 的超时错误和正常证据。
2. 不触发 hover、展开或详情导航，直接断言错误正文在表格中可见。
3. 断言运营错误行没有 Signature 失败文案，明确 Signature 错误行包含对应错误正文。
4. 点击第 2 页后，验证错误正文属于第二页对应日志，第一页错误不残留。
5. 选择 20 条/页后，验证错误正文仍与对应日志一致。
6. 捕获浏览器控制台错误，保证测试结束关闭浏览器和预览服务器。

**验证：** `cd frontend && npm run build && npm run test:runs-pagination`，期望错误直显和既有分页交互断言全部通过。

## T6: 完整回归与实际页面验收

**文件：** 本次全部修改和 `checklist.md`

**依赖：** T5

**步骤：**
1. 运行主要错误提取测试和前端全量测试。
2. 运行生产构建和真实浏览器列表测试。
3. 在确认运行当前工作区代码的 `/runs` 页面检查异常日志无需交互即可看到具体错误。
4. 检查网络/超时错误未显示成 Signature 失败，明确 Signature 拒绝显示正确。
5. 切换渠道、页码和每页条数，确认错误与日志对应且现有操作可用。
6. 运行 `git diff --check` 和 `git status --short`，保留用户现有未提交改动；未获 push 指令不发布。

**验证：**

- `cd frontend && npx vitest run src/runsUtils.test.ts`：错误提取和既有工具测试通过。
- `cd frontend && npm test`：前端全量测试通过。
- `cd frontend && npm run build`：TypeScript/Vite 构建通过。
- `cd frontend && npm run test:runs-pagination`：真实错误展示与分页测试通过。
- `git diff --check`：无格式错误。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6
```
