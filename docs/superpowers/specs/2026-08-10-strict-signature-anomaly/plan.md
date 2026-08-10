# Signature 异常严格判定 Plan

## 架构概览

在后端 Signature 互通服务中增加一个唯一的“明确验签拒绝”判定函数，所有产生 `signature_interop_failed` 的路径都必须依赖它。该函数只检查脱敏后的错误文本是否包含完整语义：`invalid signature in thinking block`，允许反引号、字段路径、request id、JSON 包装和 SSE 包装存在。

```text
Relay JSON/SSE/HTTP 错误
  -> 提取可读错误文本
  -> is_explicit_invalid_thinking_signature()
  -> signature_ok=false + signature_interop_failed
                             或
     signature_ok=None + operational/not_comparable/unknown evidence
  -> 自动巡检报告与告警沿用结果，不再通用兜底补标签
```

## 核心数据结构

### Signature 判定结果

- `explicit_signature_error: bool`：是否命中明确的 thinking signature 拒绝语义；内部判定字段，不强制新增 API 字段。
- `signature_ok: true | false | null`：成功接受为 true，明确拒绝为 false，其他失败或未完成为 null。
- `labels: string[]`：明确拒绝才包含 `signature_interop_failed`；其他错误保留 operational/not_comparable 等既有标签。
- `raw_error`、`error_http_status`、`error_stage`、`request_logs`：继续记录脱敏排障证据。

## 核心接口

### 明确验签错误识别函数

提供纯函数 `is_explicit_invalid_thinking_signature(error_text: str | None) -> bool`：

1. 转小写并把连续空白折叠为单空格。
2. 将带反引号的 ``invalid `signature` in `thinking` block`` 归一化为相同语义。
3. 仅当归一化文本包含完整短语 `invalid signature in thinking block` 时返回 true。
4. 不依赖 HTTP 状态、错误类型、单词片段或 `signature_ok=false` 单独判断。

### 错误文本收集

复用现有 JSON 错误提取、SSE 解析和脱敏逻辑，将 HTTP body、响应头 request ID、流式 error 事件和异常文本合并为判定输入；不改变对外错误字段。

## 模块设计

### Signature 核心服务

**职责：** 在 Relay 失败和 Relay 返回错误 body 两个分支中使用唯一判定函数；明确错误设 `signature_ok=false`，其他错误设 `signature_ok=None`。

**约束：** Source 缺少 signature 的本地结构错误也设 `signature_ok=None`；成功响应设 true。保留 `not_comparable` 分类优先级。

### 自动巡检报告附加

**职责：** 读取 Signature 结果中的明确标签；只在结果已包含 `signature_interop_failed` 或明确判定字段为 true 时加入该标签，不再根据 `signature_ok is False` 或 `ok is False` 兜底生成。

### 告警与汇总

**职责：** 继续消费报告标签。因为非验签结果不会再产生该标签，告警和渠道总览自然不会创建 Signature 异常；运行问题仍按已有 operational 标签展示。

### 测试

**职责：** 添加纯函数矩阵测试、手动 JSON/SSE 明确错误测试、网络/普通错误回归测试、Source 缺少 signature 测试，以及自动巡检报告不补标签测试。

## 模块交互

1. Relay 调用返回后，先提取 body/stream 错误文本。
2. 明确错误函数命中：构造 `signature_ok=false`、`signature_interop_failed` 和 Signature 异常原因。
3. 未命中但请求失败：调用现有 operational/not-comparable 分类，`signature_ok=None`，不生成 Signature 标签。
4. 成功：`signature_ok=true`，保留既有成功结果。
5. 自动巡检将 Signature 结果附加到 Source 报告时，只合并已存在的明确标签，不再重新推断。
6. `create_alerts_for_run` 继续依据最终报告标签生成告警，因此只有明确验签错误进入 Signature 告警。

## 文件组织

```text
backend/app/
├── services.py              # 严格错误识别、Signature 分支和自动巡检附加逻辑
└── scheduled_probe.py       # 如需调整分类优先级，保持 operational 分类独立

backend/tests/
└── test_api.py              # 明确错误、SSE、网络/普通错误、缺失 signature 和告警回归

docs/superpowers/specs/2026-08-10-strict-signature-anomaly/
├── spec.md
├── plan.md
├── task.md
└── checklist.md
```

不新增数据库字段，不修改前端接口类型；前端继续展示后端提供的标签和原始错误。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 异常判定 | 完整错误短语白名单 | 避免 HTTP 状态或通用失败造成误导 |
| 反引号处理 | 归一化后匹配同一语义 | 覆盖 Anthropic JSON 与代理包装差异 |
| signature_ok | 普通失败使用 null | 区分“明确拒绝”与“未完成验证” |
| Source 缺少 signature | null，不报异常 | 这是 Source 响应结构问题，不是 Relay 明确拒绝 |
| not_comparable | 保持现有优先级 | 模型权限/可用性问题不能转成真实性结论 |
| 自动巡检兜底 | 删除通用 `is False` 补标签 | 防止后续报告链路重新制造误报 |
| 历史数据 | 不回写 | 保留历史证据，规则只约束新运行结果 |
