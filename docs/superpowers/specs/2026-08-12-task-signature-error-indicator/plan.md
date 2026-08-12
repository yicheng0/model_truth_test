# 任务列表 Signature 错误提示 Plan

## 架构概览

在现有任务列表的正常任务分组表中增加按需加载的错误提示：任务行展开时复用现有 `api.runResults` 获取结果，通过纯函数从 `Result` 的 normalized response、raw response 和 metrics 中提取 HTTP 状态码、错误文本与 Request ID；仅对状态码 400 且匹配明确 Signature 错误的结果渲染提示。

```text
任务列表分组行展开
  -> api.runResults(run.id)
  -> extractInvalidThinkingSignatureErrors(results)
  -> 命中时显示错误提示 + 去重 Request ID
  -> 未命中显示空内容
```

## 核心数据结构

### Signature 错误摘要

- `requestIds: string[]`：匹配结果中的去重 Request ID，按结果顺序保留。
- `count: number`：匹配错误结果数量，用于提示语。

### 错误来源兼容读取

- 状态码候选：`normalized_response.status_code`、`raw_response.status_code`、`metrics.status_code`、对应 `http_status` 字段。
- 错误文本候选：normalized/raw response 的 `error`、`detail`、`message`、`error_detail` 及结果错误文本字段。
- Request ID 候选：`upstream_request_id`，以及 raw/normalized response 中的 `request_id`/`requestId`。

## 核心接口

### `extractInvalidThinkingSignatureErrors`

**输入：** `Result[]`。

**输出：** `{ requestIds: string[]; count: number } | null`。

**规则：** 仅保留状态码严格为 400 且错误文本大小写不敏感包含 `invalid \`signature\` in \`thinking\` block` 的结果；无命中返回 `null`；Request ID 去重且不生成虚假 ID。

## 模块设计

### 运行结果工具模块

**职责：** 集中处理多种现有响应结构的状态码、错误文本和 Request ID 提取，提供可单元测试的纯函数。

### 任务列表页面

**职责：** 在正常任务组的可展开详情中调用结果查询和纯函数；命中时在任务组详情顶部显示警告/错误提示，未命中不渲染任何新增内容。

**兼容性：** 不改变任务分组、评分、状态标签、删除/取消操作和详情链接。

### 前端测试

**职责：** 覆盖匹配、状态码过滤、文本过滤、无错误、去重 Request ID 和无 ID 场景。

## 文件组织

```text
frontend/src/
├── runsUtils.ts           # 新增 Signature 错误纯函数
├── runsUtils.test.ts      # 新增正反例和去重测试
└── pages/Runs.tsx         # 在正常任务展开区按需展示提示
```

## 需求映射

| 需求 | 组件 |
|---|---|
| F1 | `extractInvalidThinkingSignatureErrors`、任务列表详情提示 |
| F2 | 纯函数摘要结构、任务列表渲染 |
| F3 | 状态码/错误文本严格过滤、空态不渲染 |
| F4 | 页面仅新增展开区提示，不改既有任务表操作 |

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 数据来源 | 复用 `/api/runs/{id}/results` | 已有接口包含结果、响应和请求标识，无需后端改协议 |
| 展示位置 | 正常任务分组展开区顶部 | 保留主列表紧凑性，命中时才出现，且靠近具体任务 |
| 匹配范围 | HTTP 400 + 明确错误文本双条件 | 避免把其他 Signature 失败或普通 400 误标记 |
| Request ID | 仅展示已记录且去重的 ID | 方便追踪且不制造无法核验的信息 |
| 错误类型 | 统一中文提示“Thinking Signature 无效” | 用户可快速理解，原始错误仍可在详情中查看 |
