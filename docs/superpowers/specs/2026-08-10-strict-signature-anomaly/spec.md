# Signature 异常严格判定 Spec

## 背景

当前 Signature 检测会记录 Source 生成 thinking block、Relay 复用请求以及身份探针的执行结果。部分非验签错误虽然能够被识别为运行故障，但仍存在普通请求失败、缺失字段或其他未知错误被归入 `signature_interop_failed` 的兜底路径，可能让用户误以为渠道明确拒绝了 thinking signature。

用户提供的真实上游错误有两种等价表达：

- `Invalid signature in thinking block`
- `Invalid `signature` in `thinking` block`

只有上游响应明确包含这类验签拒绝语义，才能判定为 Signature 异常。其他失败只能表示本轮没有完成验签，不能证明 signature 无效。

## 目标

- 将 Signature 异常改为明确错误文本白名单判定。
- 消除网络、鉴权、限流、额度、模型权限、服务不可用、响应解析和其他未知错误导致的 Signature 异常误报。
- 保留失败请求的原始错误、阶段、HTTP 状态和请求 ID，方便排查运行问题。

## 功能需求

- F1: 当 Source 已产生 signature，并且 Relay 上游错误明确包含 `Invalid signature in thinking block` 或 `Invalid `signature` in `thinking` block` 时，系统判定 `signature_ok=false`，附加 `signature_interop_failed`，并允许生成 Signature 异常告警。
- F2: 两类明确错误允许出现在嵌套 JSON、SSE error、带字段路径前缀、带一个或多个 request id 的错误文本中；字段路径、request id 和外层包装不影响识别。
- F3: 除 F1/F2 以外的所有错误均不得附加 `signature_interop_failed`，不得生成 Signature 异常告警，且 `signature_ok` 保持未知而不是 false。
- F4: 非验签错误仍记录实际执行状态、失败阶段、HTTP 状态、请求 ID 和脱敏后的原始错误，并按已有规则归为运行问题、不可比或未知失败。
- F5: 手动 Signature 检测、自动巡检报告、异常标签、渠道总览和告警生成使用同一严格判定结果，不能在后续汇总链路中根据通用失败状态重新补上 Signature 异常标签。

## 非功能需求

- N1: 明确错误文本匹配忽略大小写和多余空白，但不得仅凭单独出现 `signature`、`thinking block`、HTTP 400 或请求失败等宽泛信号判异常。
- N2: 不改变现有错误脱敏规则，不在日志、报告或告警中泄露 API Key、鉴权头或其他凭证。
- N3: 保持现有接口字段兼容，不增加数据库迁移；历史已保存记录不自动改写，新规则作用于新执行和新生成的汇总结论。
- N4: Mock、SQLite、本地测试和现有官方渠道不可比规则继续工作。

## 不做的事

- 不把网络错误、超时、连接中断、DNS、TLS、429、5xx、额度不足或无可用渠道判为 Signature 异常。
- 不把鉴权失败、模型不存在、模型无权限、协议不支持或参数错误判为 Signature 异常。
- 不把 Source 未返回 thinking block、thinking block 缺少 signature、响应无法解析或身份探针失败判为 Signature 异常。
- 不删除或隐藏非验签错误的原始排障证据。
- 不修改其他非 Signature 探针的异常判定规则。

## 验收标准

- AC1: 错误 `***.***.***.***.thinking: Invalid signature in thinking block (request id: ...)` 被判为 Signature 异常，结果包含 `signature_ok=false` 和 `signature_interop_failed`。
- AC2: 嵌套错误 `{"error":{"message":"***.***.content.4: Invalid `signature` in `thinking` block (request id: ...) (request id: ...)","type":"<nil>"},"type":"error"}` 被判为 Signature 异常，且 request id 包装不影响识别。
- AC3: 超时、连接错误、502/503、429、额度不足、模型不可用、无权限、普通 400、未知上游错误和身份探针错误均不包含 `signature_interop_failed`，也不产生 Signature 异常告警。
- AC4: Source thinking block 缺少 signature 时，本轮显示为未完成有效验签并保留证据，但不包含 `signature_interop_failed`。
- AC5: 自动巡检附加报告、评分、渠道总览和告警时，不会把 `signature_ok` 未知或通用失败重新升级为 Signature 异常。
- AC6: 两种明确错误的普通 JSON 与 SSE 形式均能识别；大小写或多余空白变化仍能识别，只有宽泛关键词但不包含完整拒绝语义的文本不能识别。
- AC7: 后端相关测试和完整测试通过，现有接口响应结构与敏感信息脱敏行为保持兼容。
