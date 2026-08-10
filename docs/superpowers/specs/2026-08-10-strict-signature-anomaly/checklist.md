# Signature 异常严格判定 Checklist

> 每项均通过运行代码或观察行为验证。

## 明确验签错误

- [x] 无反引号错误 `Invalid signature in thinking block` -> `signature_ok=false` 且包含 `signature_interop_failed`（验证：后端 Signature 测试通过）。
- [x] 用户提供的带字段路径、反引号和多个 request id 的嵌套 JSON -> 同样判为 Signature 异常（验证：`test_explicit_invalid_thinking_signature` 通过）。
- [x] 明确错误的 SSE error 事件 -> 同样判为 Signature 异常，并保留流式 request ID（验证：Signature 相关回归测试通过）。
- [x] 大小写变化和连续空白变化 -> 仍能识别；只有单独的 `signature`、`thinking block` 或 `signature invalid` -> 不识别（验证：7 个纯函数矩阵用例通过）。

## 非验签错误与证据

- [x] 超时、连接错误、DNS/TLS、502/503、429、额度不足、鉴权、模型不可用、无权限、普通 400 和未知错误 -> `signature_ok=null`、无 `signature_interop_failed`、不生成 Signature 异常告警（验证：Signature 相关 53 个测试通过）。
- [x] Source 缺少 thinking signature -> 保留失败步骤、原始响应和阶段，但不生成 `signature_interop_failed`（验证：Source 缺失 signature 回归通过）。
- [x] 非验签错误仍保留脱敏后的 `raw_error`、HTTP 状态、失败阶段、request ID 和 request logs（验证：现有 request log 与脱敏断言通过）。

## 自动巡检与汇总

- [x] 自动巡检报告只使用严格判定已有的 Signature 标签，不因 `signature_ok=null`、`ok=false` 或普通失败重新补标签（验证：新增 unknown failure 回填测试通过）。
- [x] 明确 Signature 错误生成对应报告标签和告警，普通运行错误不生成 Signature 异常告警（验证：自动巡检 Signature 回归通过）。
- [x] 渠道总览和评分使用最终标签，不将运行故障升级为真实性/Signature 异常（验证：后端完整巡检测试通过）。

## 兼容性与安全

- [x] JSON、SSE、SQLite、Mock 和不可比模型路径保持现有接口字段结构（验证：后端完整测试 410/410 通过）。
- [x] 不新增数据库字段或迁移，不改前端接口类型（验证：差异仅涉及 `backend/app/services.py`、`backend/tests/test_api.py` 和规格文档）。
- [x] API Key、`x-api-key`、鉴权头和凭证字段不出现在原始错误或 request logs 中（验证：现有脱敏测试通过）。

## 编译与测试

- [x] Signature 相关测试全部通过（验证：`cd backend && python -m pytest tests/test_api.py -k "signature"`，53/53 通过）。
- [x] 后端完整测试通过（验证：`cd backend && python -m pytest`，410/410 通过）。
- [x] 差异格式检查通过（验证：`git diff --check`，退出码 0）。

## 端到端场景

- [x] Relay 返回用户提供的明确错误 -> 手动检测结果显示 Signature 不兼容，自动巡检产生 Signature 异常标签和告警（验证：Signature API/巡检回归通过）。
- [x] Relay 返回 503/网络错误 -> 手动检测保留运行失败证据，自动巡检只显示运行问题，不显示 Signature 异常（验证：operational failure 与 unknown backfill 测试通过）。

## 验收标准映射

| 验收标准 | 对应清单 |
|---|---|
| AC1 | 明确验签错误 1 |
| AC2 | 明确验签错误 2 |
| AC3 | 非验签错误与证据 1、自动巡检与汇总 2 |
| AC4 | 非验签错误与证据 2 |
| AC5 | 自动巡检与汇总 1、3 |
| AC6 | 明确验签错误 3、4 |
| AC7 | 非验签错误与证据 3、兼容性与安全、编译与测试 |
