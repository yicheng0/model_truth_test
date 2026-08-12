# 任务列表 Signature 错误提示 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `frontend/src/runsUtils.test.ts` | 定义明确 400 Signature 错误的识别契约 |
| 修改 | `frontend/src/runsUtils.ts` | 实现状态码、错误文本和 Request ID 提取纯函数 |
| 修改 | `frontend/src/pages/Runs.tsx` | 在正常任务展开区按需显示提示 |

## T1: 添加失败纯函数测试

**文件：** `frontend/src/runsUtils.test.ts`

**依赖：** 无

**步骤：**

1. 导入尚未实现的 `extractInvalidThinkingSignatureErrors`。
2. 添加 HTTP 400 且 normalized response 匹配的正例。
3. 添加 raw response、metrics 和多种 Request ID 来源的正例。
4. 添加状态码非 400、文本不匹配、无错误和无结果的反例。
5. 添加多条匹配结果去重 Request ID、无 Request ID 和稳定顺序断言。
6. 运行聚焦测试并确认因函数不存在而失败。

**验证：** 在 `frontend` 目录运行 `npm test -- src/runsUtils.test.ts`，期望测试失败且原因是导入函数不存在。

## T2: 实现错误识别纯函数

**文件：** `frontend/src/runsUtils.ts`

**依赖：** T1

**步骤：**

1. 定义返回结构 `{ requestIds, count } | null`。
2. 从 normalized/raw response 和 metrics 读取候选状态码，严格要求 400。
3. 从 normalized/raw response 读取错误文本，大小写不敏感匹配固定 Signature 错误片段。
4. 按结果顺序提取并去重 upstream 或响应 Request ID。
5. 运行聚焦测试确认全部通过。

**验证：** 在 `frontend` 目录运行 `npm test -- src/runsUtils.test.ts`，期望该测试文件通过。

## T3: 接入正常任务展开区

**文件：** `frontend/src/pages/Runs.tsx`

**依赖：** T2

**步骤：**

1. 新增正常任务组展开区的结果查询组件，任务未结束时不请求或不显示提示。
2. 调用错误识别纯函数。
3. 命中时渲染“Thinking Signature 无效”提示和去重 Request ID；未命中不渲染新增节点。
4. 保持任务状态、进度、分组、操作按钮和详情链接不变。

**验证：** 在 `frontend` 目录运行 `npm run build`，期望 TypeScript 和 Vite 构建成功。

## T4: 完整回归与范围检查

**文件：** `frontend/src/runsUtils.test.ts`、`frontend/src/runsUtils.ts`、`frontend/src/pages/Runs.tsx`

**依赖：** T3

**步骤：**

1. 运行完整前端测试。
2. 运行生产构建。
3. 运行 `git diff --check`。
4. 检查差异只包含本次条件提示相关文件，不改写用户其他并行前端工作。

**验证：** 在 `frontend` 目录运行 `npm test`、`npm run build`；仓库根目录运行 `git diff --check`，期望全部退出码为 0。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4
```
