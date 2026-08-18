# 自动巡检 Source 故障时跳过 Relay Checklist

> 每项均通过运行代码或观察行为验证。

## 实现完整性

- [x] 当前轮 Source 探针在 Source 故障场景实际执行，Relay/Signature 网络入口调用次数为 0（验证：后端替身记录调用次数）。
- [x] Source 故障轮的 Signature 证据为 `status=skipped`、`signature_ok=null`，并包含 Source 错误、Relay 未执行步骤和脱敏原因（验证：读取最新报告证据和 Markdown）。
- [x] Source 故障轮只保留运行故障或不可比标签，不包含 `signature_interop_failed`（验证：报告标签与告警触发标签断言）。
- [x] Source 成功时仍执行现有 Source → Relay 流程（验证：替身记录 Source 成功后 Relay 调用 1 次，结果保留 Source/Relay 标识）。
- [x] Source 成功但 Relay 明确拒绝 Signature 时仍保留 `signature_interop_failed`，短路逻辑不吞掉真实 Signature 异常（验证：Relay 拒绝响应场景）。

## 跨轮与调度集成

- [x] Source 故障后的下一轮重新请求 Source，不读取上一轮失败状态（验证：同一计划连续两轮，Source 调用次数按轮次增加）。
- [x] Source 恢复后的下一轮重新允许 Relay 请求（验证：第一轮 Relay 为 0、第二轮 Relay 为 1）。
- [x] Source 短路轮仍生成历史报告并完成巡检任务、释放锁、推进 `next_run_at`（验证：查询计划、运行、PatrolJobAttempt 和 Report）。
- [x] Source 短路不改变现有告警生成和运行故障归一，且不触发 Signature 专属即时告警（验证：检查告警标签和告警资格）。
- [x] Mock 模式和未启用 Signature 模块路径保持原行为，不产生真实 Relay 请求（验证：既有自动巡检测试回归）。

## 编译与测试

- [x] TDD RED 已观察（验证：实现前运行 `cd backend && PYTHONPATH=. pytest tests/test_api.py -k scheduled_source_failure_relay_skip -v`，测试因现有编排调用 Signature 入口而失败）。
- [x] Source 故障、跨轮恢复和 Relay 拒绝聚焦测试通过（验证：`cd backend && PYTHONPATH=. pytest tests/test_api.py -k 'scheduled_source_failure_skips_relay_signature_request or scheduled_source_recovery_resumes_relay_signature_request or scheduled_relay_signature_rejection_keeps_existing_failure_semantics' -v`）。
- [x] `test_api.py` 后端回归通过（验证：`cd backend && PYTHONPATH=. pytest tests/test_api.py -q`）。
- [x] 完整后端测试通过（验证：`cd backend && PYTHONPATH=. pytest -q`）。
- [x] 差异无空白错误（验证：仓库根目录运行 `git diff --check`）。
- [x] 变更范围只包含批准的实现、测试和四阶段文档，未覆盖既有未提交修改（验证：检查 `git status --short` 与 `git diff`）。

## 端到端场景

- [x] Source 临时故障流程：调度触发 -> Source 请求失败 -> Relay 不请求 -> 生成运行故障报告 -> 锁释放并安排下一轮（验证：后端集成测试和数据库记录）。
- [x] Source 恢复流程：下一次调度 -> Source 请求成功 -> Relay 请求一次 -> 进入现有 Signature 验证 -> 生成正常结果（验证：同一计划跨两轮集成测试）。
- [x] 重要边界场景：Source 成功但 Relay 明确拒绝 Signature -> Relay 仍请求 -> 记录 `signature_interop_failed`，不被 Source 短路分支掩盖（验证：拒绝响应集成测试）。
