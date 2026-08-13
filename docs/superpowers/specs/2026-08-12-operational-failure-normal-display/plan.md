# 巡检运行故障正常展示 Plan

## 架构概览

在前端巡检证据展示层增加统一的“运行故障”识别，并让任务列表、巡检详情和手动探针详情的总状态、探针芯片、失败原因和复审标记共享同一套分类结果。后端已经提供 `operational_issue` 分类和运行故障标签，本次不改变后端数据，只兼容历史结果中可从状态码或错误文本识别的运行故障。

数据流保持为：

```text
runResults API
  -> extractPatrolEvidence
  -> operational failure classifier
  -> shared probe status mapper
  -> patrolResultState / patrolProbeChips / patrolFailureReason
  -> task list, patrol detail and manual probe detail UI
```

## 核心数据结构

### 运行故障判定结果

- `isOperationalFailure`: 当前证据项是否属于上游运行故障。
- `hasRealAnomaly`: 是否存在 Kiro 身份泄漏、明确 Signature 400 拒绝或其他非运行故障异常。
- `displayState`: 任务列表展示状态；运行故障且无真实异常时为正常，存在真实异常时为异常。

判定只消费已经脱敏的证据字段：运行故障标签、HTTP 状态、错误文本、探针状态和 Signature 错误信息，不改变原始对象。

### 运行故障范围

统一识别以下标签或文本：

- `provider_temporarily_unavailable`
- `provider_quota_or_balance_exhausted`
- `provider_request_failed`
- HTTP 5xx、`internal server error`、`service unavailable`、`bad gateway`、`gateway timeout`
- `timeout`、`connection failed/error/reset`、`network error`、`no available channel`

明确的 HTTP 400 `Invalid signature in thinking block` 不归入运行故障；Kiro 身份泄漏也不归入运行故障。

## 核心接口

### 运行故障识别接口

在巡检工具模块提供可测试的证据判断函数，用于判断单个模型探针、Signature 证据以及整轮巡检是否仅为运行故障。接口以现有证据对象为输入，返回布尔值或汇总状态，不负责渲染和副作用。

### 巡检展示状态接口

页面内部状态函数继续输出 `ok` 或 `error`，但遵循以下优先级：

1. 已确认的 Claude/AWS 正常分类为 `ok`。
2. Kiro、明确 Signature 400 和其他真实异常为 `error`。
3. 仅有运行故障时为 `ok`。

探针芯片对仅运行故障的探针显示绿色“正常”或等价正常状态；真实异常仍显示红色失败。失败原因只汇总真实异常，不把运行故障文本放入“需要复审”提示。

### 详情探针状态接口

巡检详情与手动探针详情不得维护独立的错误文本正则。两处状态渲染统一复用巡检工具层的运行故障识别和参数不支持识别，确保 HTTP 5xx、`temporarily unavailable`、超时、网络失败和额度不足与任务列表口径一致。

状态文案优先级为：请求成功显示“正确”；运行故障显示“资源暂不可用”或等价的非异常运营状态；原生参数拒绝显示“参数不支持”；其余真实异常才显示红色“异常”。运营故障仍在响应摘要、展开详情和 Signature 请求日志中保留原始错误与 HTTP 状态。

## 模块设计

### `frontend/src/runsUtils.ts`

**职责：** 提供运行故障匹配、单项证据归类和整轮证据状态判断，兼容结构化标签、状态码和历史错误文本。

**对外接口：** 新增可供页面和测试调用的纯函数；复用现有 `PatrolModelRequestEvidence`、`PatrolSignatureEvidence` 与 `PatrolEvidence` 类型。

**依赖：** 仅依赖现有类型和字符串/数字解析工具。

### `frontend/src/pages/Runs.tsx`

**职责：** 使用统一分类结果渲染总状态、Signature 芯片、固定身份探针芯片、失败原因和复审状态。

**对外接口：** 不新增 API 路由或请求参数。

**依赖：** `runsUtils.ts` 的纯判断函数、现有 React Query 数据和 Ant Design 标签/提示组件。

### `frontend/src/pages/runDetailUtils.ts`

**职责：** 将巡检详情和手动探针详情的状态文字、颜色映射到统一的运行故障分类，移除与巡检工具层重复且口径不完整的旧判断。

**对外接口：** 保留现有详情页状态文字和颜色接口，内部委托给 `runsUtils.ts` 的统一纯函数，避免调用方改动。

**依赖：** `runsUtils.ts` 的探针状态与运行故障判断。

### `frontend/src/pages/runDetailUtils.test.ts`

**职责：** 回归验证详情页对 HTTP 500/临时不可用显示非异常状态，同时保证参数不支持和未知真实错误仍保持原有语义。

**依赖：** Vitest 与现有详情工具测试夹具。

### `frontend/src/runsUtils.test.ts`

**职责：** 覆盖运行故障正常化、真实异常保留、混合结果优先级和历史文本兼容。

**依赖：** Vitest 与现有测试夹具。

## 模块交互

1. 页面从 `runResults` 取得巡检报告和结果。
2. `extractPatrolEvidence` 将后端 snake_case 证据归一化为前端结构。
3. 运行故障判断函数分别检查模型探针和 Signature 证据，并汇总整轮是否存在真实异常。
4. `PatrolEvidenceCell`、`PatrolReviewCell` 和 `PatrolEvidenceSummary` 使用相同的汇总状态，避免同一条记录出现“顶部正常、芯片失败、右侧复审”的不一致。
5. 巡检详情和手动探针详情的状态 Tag 委托统一状态映射，不再把运行故障渲染为红色“异常”。
6. 详情表继续渲染错误文本、HTTP 状态和 Request ID，确保故障可追踪但不被计为真实性异常。

## 文件组织

```text
frontend/
├── src/
│   ├── runsUtils.ts       # 运行故障分类与巡检证据工具
│   ├── runsUtils.test.ts  # 分类与展示状态测试
│   └── pages/
│       ├── Runs.tsx                # 任务列表巡检状态渲染
│       ├── runDetailUtils.ts       # 详情页统一探针状态映射
│       └── runDetailUtils.test.ts  # 详情页状态映射回归测试
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 分类位置 | 前端证据工具层 | 后端已完成运行故障分类，本次只修复任务列表误展示，并需兼容历史证据 |
| 真实异常优先级 | 真实异常覆盖运行故障 | 避免网络故障掩盖 Kiro 泄漏或明确 Signature 拒绝 |
| 历史兼容 | 标签、状态码、错误文本三路识别 | 旧数据可能没有 `classification_status` 或专用标签 |
| 详情状态复用 | 委托统一巡检工具，不保留第二套正则 | 修复任务列表正确但详情页仍显示红色异常的口径分裂 |
| 原始证据 | 只读保留，不重写 | 满足详情排查需求并避免影响审计证据 |
| 测试方式 | 纯函数单元测试 + 全量前端测试/构建 | 先验证边界分类，再确认页面编译和现有行为无回归 |
