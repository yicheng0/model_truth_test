# Signature 运营故障误报抑制 Plan

## 架构概览

本方案保持后端现有 Signature 三态分类，只修复证据传输和详情展示：

1. 后端继续输出 `signature_ok=true/false/null`、运营错误阶段、HTTP 状态、错误正文和请求日志。
2. 前端巡检证据归一化补充 `signature_ok` 字段，避免历史/当前结果在转换时丢失三态语义。
3. 前端增加纯函数判断“是否为明确 Signature 拒绝”和“是否为运营故障”，集中复用后端已定义的错误边界。
4. 详情页顶部只在明确 Signature 拒绝时展示红色错误；未知状态展示中性状态，不展示错误 Alert。
5. AI 疑难复核卡片仅在存在真实身份/协议异常，或不是纯运营故障时展示；运营错误仍通过请求日志和探针详情查看。

## 核心数据结构

### PatrolSignatureEvidence

在现有前端巡检 Signature 证据上增加：

- `signatureOk`: `true` 表示 Relay 接受，`false` 表示明确拒绝，`null` 表示未完成或运营不确定。
- `status`: 保留后端原始状态，用于兼容历史数据。
- `reason`、`rawError`、`errorHttpStatus`、`errorStage`、`requestLogs`: 保留现有诊断字段。

### PatrolEvidenceDisplayState

由纯函数计算的展示状态：

- `signatureRejected`: 是否命中 HTTP 400 且明确 `Invalid signature in thinking block`。
- `signatureUnknown`: `signatureOk === null` 或历史数据可识别为运营故障。
- `operationalOnly`: 本轮是否只有运营故障，没有 Kiro 或真实协议异常。
- `showAiJudge`: 是否展示 AI 真伪疑难复核卡片。

不新增后端表、字段或 API。

## 核心接口

### Signature 证据归一化

输入后端 `signature_interop` 对象，输出包含 `signatureOk` 的前端证据。缺少该字段的历史记录按错误文本、阶段和 HTTP 状态推断：可识别运营故障按未知；明确 Signature 拒绝按拒绝；无法判断时默认未知，不将整体失败升级为拒绝。

### Signature 展示状态判断

输入 Signature 证据和整轮巡检标签/模型请求，输出顶部展示所需的三态结果。明确拒绝必须同时满足明确错误文本和对应协议错误边界；普通权限、账号、配额、网络、超时、5xx 和临时不可用均归运营故障。

### 详情页展示

- 顶部状态标签：通过显示成功，未知显示“未完成验证/无法判定”，明确拒绝显示失败。
- 红色错误 Alert：仅 `signatureRejected=true` 时渲染。
- AI 疑难复核 Alert：`operationalOnly=true` 时隐藏；存在 Kiro 或真实异常时继续显示。
- 请求日志/探针展开：继续展示脱敏错误、阶段、HTTP 状态和 Request ID。

## 模块设计

### `frontend/src/runsUtils.ts`

**职责：** 归一化 Signature 三态字段，识别运营故障和明确 Signature 拒绝，计算巡检展示状态。

**对外接口：** 扩展 `PatrolSignatureEvidence`；新增或扩展纯函数供详情页与测试复用。

**依赖：** 现有错误文本、HTTP 状态、标签和请求日志字段；不调用网络。

### `frontend/src/pages/RunDetail.tsx`

**职责：** 按展示状态决定红色 Signature Alert、未知状态文案和 AI 疑难复核卡片。

**对外接口：** 不新增路由或请求；继续使用现有 `PatrolEvidence`。

### `frontend/src/runsUtils.test.ts` 与详情组件测试

**职责：** 覆盖两张截图中的权限/模型访问错误、网络/配额/超时、明确 Signature 拒绝、Kiro + 运营故障组合和历史缺字段记录。

## 模块交互

```text
后端 signature_interop
  -> signature_ok + error fields + request_logs
  -> extractPatrolEvidence
       -> normalizeSignature(signatureOk preserved)
       -> classify operational vs explicit rejection
  -> RunDetail
       -> unknown: neutral status, no red Signature Alert
       -> explicit rejection: red Signature Alert
       -> operational-only: hide AI authenticity review
       -> expanded logs: show redacted diagnostics
```

## 文件组织

```text
frontend/src/runsUtils.ts          # 三态归一化和展示状态判断
frontend/src/runsUtils.test.ts     # 纯函数与证据归一化测试
frontend/src/pages/RunDetail.tsx   # 详情页展示条件
frontend/src/pages/RunDetail.test.tsx  # 如现有测试基础支持则补组件行为测试
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| Signature 语义 | 保留 true/false/null 三态 | 与后端现有分类一致，避免整体失败覆盖未知状态 |
| 明确拒绝判定 | HTTP 400 + `Invalid signature in thinking block` | 防止普通权限、网络和 400 错误被误标为协议拒绝 |
| 历史字段缺失 | 可识别运营错误默认 unknown，无法判断也默认 unknown | 保守避免误报，保留详情证据 |
| 红色 Alert | 仅明确拒绝显示 | 用户看到的红色提示必须有协议证据支撑 |
| AI 复核 | 纯运营故障隐藏，真实身份/协议异常保留 | 不让不可判定运行故障制造真伪结论 |
| 错误详情 | 只在展开日志/探针详情显示 | 同时满足排障需要和顶部界面降噪 |
| 后端范围 | 不修改后端执行和分类 | 后端已经正确输出 `signature_ok=null`，根因在前端展示丢字段 |
