# 巡检运行故障正常展示 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `frontend/src/runsUtils.ts` | 增加运行故障识别和证据状态汇总工具 |
| 修改 | `frontend/src/runsUtils.test.ts` | 增加运行故障、真实异常和混合结果测试 |
| 修改 | `frontend/src/pages/Runs.tsx` | 统一任务列表、探针芯片和复审展示状态 |
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

## T4: 完成全量验收

**文件：** `frontend/src/runsUtils.test.ts`、`frontend/src/pages/Runs.tsx`
**依赖：** T3
**步骤：**
1. 运行完整前端测试套件。
2. 检查差异格式和工作区状态，确认只包含本次文件和既有未提交改动。
3. 对照截图场景确认 500 临时不可用不再显示异常、Signature 叉号、固定身份探针叉号或需要复审。

**验证：** `cd frontend && npm test`、`cd frontend && npm run build`、`git diff --check`；命令全部成功。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4
```
