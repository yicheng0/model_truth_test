# 任务列表 Kiro 身份泄漏统计 Plan

## 架构概览

扩展现有任务展开区异常汇总组件，继续复用 `api.runResults` 返回的结果列表。新增纯函数从结果标签和身份响应正文中提取 Kiro 身份泄漏摘要；页面分别计算 Kiro 摘要与 Thinking Signature 400 摘要，并按固定顺序独立渲染。

```text
任务分组展开
  -> 复用 runResults 查询
  -> extractKiroIdentityLeaks(results)
  -> extractInvalidThinkingSignatureErrors(results)
  -> Kiro 命中时显示独立异常项
  -> Signature 命中时显示独立异常项
  -> 两者均未命中则不显示异常区
```

## 核心数据结构

### Kiro 身份泄漏摘要

- `requestIds: string[]`：命中结果中的去重 Request ID，保持结果顺序。
- `count: number`：命中结果数量。

### Kiro 命中证据

1. 优先证据：结果 `labels` 包含 `kiro_identity_leak`。
2. 历史兼容证据：结果响应正文明确匹配中文“我是 Kiro”或英文 “I am Kiro / I'm Kiro” 身份自报句式。
3. 排除来源：不读取 `raw_request`、渠道名称、provider/account type 和错误文本作为历史身份自报证据。

## 核心接口

### `extractKiroIdentityLeaks`

**输入：** `Result[]`。

**输出：** `{ requestIds: string[]; count: number } | null`。

**行为：** 每条结果最多计数一次；结构化标签直接命中；无标签时仅从 normalized/raw response 的响应正文读取明确身份自报句式；Request ID 复用现有提取顺序并去重；无命中返回 `null`。

## 模块设计

### 运行结果工具模块

**职责：** 新增 Kiro 身份泄漏提取函数，复用现有响应与 Request ID 辅助方法，不改变 Signature 400 函数。

### 任务异常汇总组件

**职责：** 将现有单一 Signature 提示组件调整为任务异常汇总；同一批查询结果分别计算 Kiro 和 Signature 摘要。固定先展示“Kiro 身份泄漏”，再展示“Thinking Signature 无效”；任一为空就不渲染对应项。

### 前端测试

**职责：** 覆盖结构化标签、中文/英文历史自报、普通 Kiro 文本误报防护、单结果去重、多结果 Request ID 去重和空输入。

## 文件组织

```text
frontend/src/
├── runsUtils.ts           # 新增 Kiro 身份泄漏摘要纯函数
├── runsUtils.test.ts      # 新增 Kiro 正反例及去重测试
└── pages/Runs.tsx         # 扩展现有任务异常汇总组件
```

## 需求映射

| 需求 | 组件 |
|---|---|
| F1 | `extractKiroIdentityLeaks` 标签分支、页面 Kiro 提示 |
| F2 | 纯函数历史身份句式兼容分支 |
| F3 | Request ID 复用与去重逻辑 |
| F4 | 页面分别渲染两类摘要 |
| F5 | 空摘要返回 `null`，现有任务表不变 |

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 首选证据 | `kiro_identity_leak` 标签 | 后端已经按身份探针上下文生成，误报风险最低 |
| 历史兼容 | 仅明确第一人称身份句式 | 兼容旧数据，同时避免普通讨论或配置名称误报 |
| 响应字段 | 只读取响应正文，不读取请求和错误说明 | 用户 prompt 可能主动包含 Kiro，错误说明也可能引用该词，均不代表模型自报 |
| 展示顺序 | Kiro 在前、Signature 在后 | Kiro 明确身份泄漏的风险级别高于 Signature 链路不可验证 |
| 查询策略 | 复用现有任务结果查询和缓存 key | 不新增请求接口，不重复拉取同一数据 |
