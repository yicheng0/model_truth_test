# 任务列表 Kiro 身份泄漏统计 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `frontend/src/runsUtils.test.ts` | 定义 Kiro 标签和历史身份自报识别契约 |
| 修改 | `frontend/src/runsUtils.ts` | 实现 Kiro 身份泄漏摘要纯函数 |
| 修改 | `frontend/src/pages/Runs.tsx` | 将 Kiro 摘要接入现有任务异常汇总 |

## T1: 添加失败 Kiro 识别测试

**文件：** `frontend/src/runsUtils.test.ts`

**依赖：** 无

**步骤：**

1. 导入尚未实现的 `extractKiroIdentityLeaks`。
2. 添加 `labels` 含 `kiro_identity_leak` 的正例。
3. 添加 normalized/raw response 中包含“我是 Kiro”“I am Kiro”“I'm Kiro”的历史数据正例。
4. 添加仅在 raw request、渠道配置、普通讨论文本或错误说明中出现 `kiro` 的反例。
5. 添加多条结果去重 Request ID、无 ID 和空输入断言。
6. 运行聚焦测试，确认因函数不存在而失败。

**验证：** 在 `frontend` 目录运行 `npm test -- src/runsUtils.test.ts`，期望新增用例失败且原因是导入函数不存在。

## T2: 实现 Kiro 摘要纯函数

**文件：** `frontend/src/runsUtils.ts`

**依赖：** T1

**步骤：**

1. 实现 `extractKiroIdentityLeaks(results)`，返回 `{ requestIds, count } | null`。
2. 优先检查 `result.labels` 的 `kiro_identity_leak`。
3. 无标签时只从 normalized/raw response 的身份响应正文读取明确第一人称 Kiro 自报句式。
4. 复用既有 Request ID 提取逻辑并去重，单条结果最多计数一次。
5. 运行聚焦测试确认正反例全部通过。

**验证：** 在 `frontend` 目录运行 `npm test -- src/runsUtils.test.ts`，期望通过。

## T3: 扩展任务异常汇总展示

**文件：** `frontend/src/pages/Runs.tsx`

**依赖：** T2

**步骤：**

1. 在现有 `InvalidThinkingSignatureAlert` 查询结果上调用 Kiro 摘要函数。
2. 命中时先展示“Kiro 身份泄漏”错误项，再展示已有 Thinking Signature 错误项。
3. 两类摘要分别显示命中数量和去重 Request ID；为空的异常项不渲染。
4. 保持任务表的状态、评分、进度、分组、操作和详情链接不变。

**验证：** 在 `frontend` 目录运行 `npm run build`，期望构建成功。

## T4: 完整回归与范围检查

**文件：** `frontend/src/runsUtils.test.ts`、`frontend/src/runsUtils.ts`、`frontend/src/pages/Runs.tsx`

**依赖：** T3

**步骤：**

1. 运行完整前端测试。
2. 运行生产构建。
3. 运行 `git diff --check`。
4. 检查差异只包含本次 Kiro 统计相关文件及文档，不改写用户其他并行前端工作。

**验证：** 在 `frontend` 目录运行 `npm test`、`npm run build`；仓库根目录运行 `git diff --check`，期望全部退出码为 0。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4
```
