# 巡检运行故障正常展示 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `frontend/src/runsUtils.ts` | 增加运行故障识别和证据状态汇总工具 |
| 修改 | `frontend/src/runsUtils.test.ts` | 增加运行故障、真实异常和混合结果测试 |
| 修改 | `frontend/src/pages/Runs.tsx` | 统一任务列表、探针芯片和复审展示状态 |
| 修改 | `frontend/src/pages/runDetailUtils.ts` | 让巡检详情和手动探针详情复用统一探针状态分类 |
| 修改 | `frontend/src/pages/runDetailUtils.test.ts` | 增加详情页 HTTP 5xx 与临时不可用回归测试 |
| 新建 | `docs/superpowers/specs/2026-08-12-operational-failure-normal-display/checklist.md` | 记录最终验收项 |

## T1: 建立运行故障测试夹具

**文件：** `frontend/src/runsUtils.test.ts`
**依赖：** 无
**步骤：**
1. 扩展现有工具导入，准备包含模型探针和 Signature 证据的最小对象。
2. 添加 HTTP 5xx、503/Service Unavailable、timeout/network error、额度不足和运行故障标签的测试用例。
3. 添加明确 Signature 400、Kiro 标签和运行故障与真实异常混合的反例。
4. 运行针对该文件的 Vitest，确认新增断言在实现更新前按预期失败。

**验证：** `cd frontend && npm test -- --run src/runsUtils.test.ts`；新增行为断言应先失败，失败原因应是现有分类仍把运行故障当异常。

## T2: 实现纯运行故障识别

**文件：** `frontend/src/runsUtils.ts`
**依赖：** T1
**步骤：**
1. 增加结构化运行故障标签、HTTP 5xx 和历史错误文本的匹配逻辑。
2. 分别支持模型探针和 Signature 证据，明确排除 HTTP 400 `Invalid signature in thinking block`。
3. 提供整轮证据汇总函数，区分仅运行故障、真实异常和混合结果。
4. 保持输入证据只读，不改写错误、标签、状态或请求标识。

**验证：** `cd frontend && npm test -- --run src/runsUtils.test.ts`；T1 新增分类测试全部通过，既有工具测试不回归。

## T3: 接入巡检展示状态

**文件：** `frontend/src/pages/Runs.tsx`
**依赖：** T2
**步骤：**
1. 将总巡检状态、探针芯片和失败原因改为复用统一证据汇总结果。
2. 仅运行故障时显示绿色正常状态，不显示红色叉号或需要复审。
3. 运行故障与 Kiro/Signature/其他真实异常混合时保持异常和复审提示。
4. 保留详情表中原始错误、HTTP 状态、Request ID 和标签的展示。

**验证：** `cd frontend && npm run build`；构建成功且 TypeScript 无错误。

## T4: 建立详情页误报回归测试

**文件：** `frontend/src/pages/runDetailUtils.test.ts`
**依赖：** T2
**步骤：**
1. 添加截图对应的 HTTP 500 `Internal Server Error` 与 `Upstream service temporarily unavailable` 探针夹具。
2. 断言详情页状态不得返回红色“异常”，而应返回非异常的运营状态和颜色。
3. 添加 503、超时、网络错误和运行故障结构化标签的等价用例。
4. 保留原生参数拒绝显示“参数不支持”、未知错误显示“异常”的反例。
5. 运行详情工具测试，确认新增 HTTP 500 断言在实现更新前按预期失败。

**验证：** `cd frontend && ./node_modules/.bin/vitest run src/pages/runDetailUtils.test.ts`；修复前新增 HTTP 500 用例应失败，并显示当前实际值为“异常”。

## T5: 统一详情页探针状态映射

**文件：** `frontend/src/pages/runDetailUtils.ts`
**依赖：** T2、T4
**步骤：**
1. 保留详情页现有状态文字和颜色接口，避免修改所有渲染调用点。
2. 将接口内部实现委托给巡检工具层统一的运行故障和参数不支持判断。
3. 确保请求成功优先显示“正确”，运行故障显示非异常运营状态，参数拒绝显示“参数不支持”，其余未知错误显示“异常”。
4. 不删除响应摘要、HTTP 状态、Request ID、错误详情或 Signature 请求日志。
5. 运行详情工具测试，确认 T4 新增用例和既有用例全部通过。

**验证：** `cd frontend && ./node_modules/.bin/vitest run src/pages/runDetailUtils.test.ts src/runsUtils.test.ts`；两个文件全部通过。

## T6: 完成全量验收

**文件：** `frontend/src/runsUtils.test.ts`、`frontend/src/pages/runDetailUtils.test.ts`、`frontend/src/pages/runDetailUtils.ts`、`frontend/src/pages/Runs.tsx`
**依赖：** T3、T5
**步骤：**
1. 运行完整前端测试套件。
2. 运行 TypeScript 编译和生产构建。
3. 检查差异格式和工作区状态，确认只包含本次文件和既有未提交改动。
4. 对照截图场景确认详情页固定身份探针的 500 临时不可用不再显示红色“异常”，同时响应摘要和 Signature 请求日志仍可查看。
5. 确认 Kiro 身份泄漏、明确 Signature 400 拒绝与未知非运营错误仍显示异常。

**验证：** `cd frontend && ./node_modules/.bin/vitest run`、`cd frontend && ./node_modules/.bin/tsc -b`、`cd frontend && ./node_modules/.bin/vite build`、`git diff --check`；命令全部成功。

## 执行顺序

```text
T1 -> T2 -> T3
      |
      +-> T4 -> T5
T3 + T5 -> T6
```
