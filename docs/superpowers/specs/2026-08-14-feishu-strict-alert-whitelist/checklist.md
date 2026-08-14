# 飞书即时告警严格白名单 Checklist

> 每项均通过运行代码或观察行为验证；只有本清单明确批准后才开始开发。

## 白名单资格

- [x] AC1：构造 Relay 阶段 HTTP 400 且正文明确包含 `Invalid signature in thinking block` 的报告，创建并发送告警，看到飞书 Webhook 收到一条 Signature 异常通知。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_eligibility_signature or feishu_resend_whitelist_signature" -q`，期望通过）

- [x] AC2：构造身份探针明确命中 `kiro_identity_leak` 的报告，创建并发送告警，看到飞书 Webhook 收到一条 Kiro 身份泄漏通知。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_eligibility_kiro or feishu_resend_whitelist_kiro" -q`，期望通过）

- [x] AC3：分别构造 `protocol_mismatch`、普通身份异常、低评分、D/E 等级、普通探针失败及其他非白名单标签，看到站内规则允许的告警仍可创建，但飞书 Webhook 未被调用。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_eligibility_non_whitelist or alert_notification_initial_status_non_whitelist" -q`，期望通过）

- [x] AC4：分别构造网络、超时、HTTP 5xx、权限、额度、无可用渠道或账号错误，看到它们不会被判定为 Signature/Kiro 飞书即时异常，且 Webhook 未被调用。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_eligibility_operational" -q`，期望通过）

- [x] Kiro 与 Signature 同时存在时，只生成 Kiro 类型通知，不重复发送两条即时异常。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_eligibility_kiro_priority" -q`，期望通过）

## 历史告警与通知状态

- [x] AC5：创建仅带历史 `signature_interop_failed` 标签、没有明确 Signature 拒绝正文的 `pending` 或 `failed` 告警，首次发送和手动重发均被跳过，Webhook 调用次数为 0。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_resend_whitelist_legacy_signature_label" -q`，期望通过）

- [x] AC6：检查非白名单站内告警仍可通过告警列表和详情读取，`notification_status` 为 `skipped`，`notification_error` 明确说明“不符合飞书即时告警白名单”。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "alert_notification_initial_status_non_whitelist" -q`，期望通过）

- [x] 非白名单告警在发送前被拦截时，不增加真实 `notification_attempt_count`，也不写成网络发送失败。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_resend_whitelist_attempt_count" -q`，期望通过）

## 通知定位字段

- [x] AC9：发送 Signature 告警，通知正文可以直接看到 Source 渠道名称和 ID、Relay 渠道名称和 ID、发生时间、固定错误摘要、Source Message ID/Request ID、Relay Message ID/Request ID。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_text_signature" -q`，期望通过）

- [x] AC9 边界：Signature 任一 Message ID 或 Request ID 缺失时，通知对应字段明确显示“未提供”，不从原始响应或 header 值猜测补全。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_text_signature_missing_ids" -q`，期望通过）

- [x] AC10：发送 Kiro 告警，通知正文可以直接看到命中的待测渠道名称和 ID、发生时间、身份探针 Message ID 和 Request ID。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_text_kiro" -q`，期望通过）

- [x] Kiro 旧报告回退：缺少命中的 `model_requests` 记录但仍有结构化 Kiro 证据时，按批准的回退顺序取得身份探针标识；完全缺失时显示“未提供”。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_text_kiro_legacy_fallback" -q`，期望通过）

## 数据安全

- [x] AC11：在测试证据中放入长 Signature、Signature 前缀、完整 thinking、API Key、认证头、完整原始请求与响应，发送后的飞书正文不包含上述内容。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_text_redacts_sensitive_evidence" -q`，期望通过）

- [x] AC11：原始错误正文即使附带请求载荷、密钥形态或长证据，飞书只显示固定短摘要 `Invalid signature in thinking block`，不直接截取 `raw_error`。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_text_uses_fixed_error_summary" -q`，期望通过）

- [x] 所有允许输出的渠道名称、Message ID 和 Request ID 经过现有文本脱敏与长度限制，超长或含凭据形态的字段不会原样输出。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_text_sanitizes_identifiers" -q`，期望通过）

## 去重、静默与失败重试

- [x] AC7：同一 Signature 或 Kiro 异常在静默期内重复出现时，仍使用现有告警去重记录并增加连续窗口计数，不创建重复站内告警。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "alert_dedup or quiet_window" -q`，期望通过）

- [x] AC7：对白名单告警模拟飞书连续失败，看到最多三次网络重试后状态为 `failed`；再次合法重发仍可按现有机制尝试。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "alert_notification_marks_failed or feishu_resend_whitelist_retry" -q`，期望通过）

## 小时汇总与日报

- [x] AC8：同一小时包含 Signature、Kiro、普通真实性异常和运营问题时，小时任务只调用一次 Webhook，正文保留巡检/正常/真实性异常/运营问题统计，并只追加 Signature 与 Kiro 安全明细。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_whitelist" -q`，期望通过）

- [x] 小时汇总成功后，仅白名单告警更新为 `sent`；历史非白名单 `pending`/`failed` 告警更新为 `skipped`。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_whitelist_status" -q`，期望通过）

- [x] 小时汇总发送失败时，仅白名单告警更新为 `failed` 并增加尝试次数；非白名单告警不进入重试队列。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_whitelist_failure" -q`，期望通过）

- [x] AC8：飞书测试消息无需巡检报告或白名单证据即可正常调用 Webhook。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_test_message" -q`，期望通过）

- [x] AC8：小时汇总和日报继续把网络、额度、权限等问题称为“运营问题”，不会表述为 Signature 或 Kiro 即时异常。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_operational_wording or smart_patrol_daily_operational_wording" -q`，期望通过）

## 端到端场景

- [x] 完整 Signature 流程：自动巡检生成 Source thinking，Relay 返回明确 HTTP 400 Signature 拒绝，系统创建 `pending` 告警；小时发送或手动重发前复核通过；最终飞书正文包含 Source/Relay 渠道、时间和双方 ID，且不包含完整 Signature/thinking。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_signature_end_to_end" -q`，期望通过）

- [x] 完整 Kiro 流程：身份探针响应明确泄漏 Kiro，系统创建 `pending` 告警；发送前复核通过；最终飞书正文包含待测渠道、时间及身份探针 ID。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_kiro_end_to_end" -q`，期望通过）

- [x] 重要边界流程：历史告警只有 `signature_interop_failed` 标签，即使人工点击重发，也看到状态变为 `skipped` 且 Webhook 完全未调用。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_resend_whitelist_legacy_signature_label" -q`，期望通过）

## 范围与兼容性

- [x] 普通异常仍保留站内报告、原始证据、告警详情、筛选和统计能力，未因飞书白名单被删除。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "non_whitelist_alert_remains_visible" -q`，期望通过）

- [x] 未新增数据库迁移、队列、渠道配置、巡检任务类型、前端改动或公共响应 schema 变更。（验证：运行 `git diff --name-only -- backend`，期望只有 `backend/app/services.py` 与 `backend/tests/test_api.py`）

- [x] 用户原有 `docs/superpowers/specs/2026-08-12-patrol-delete-button-usability/checklist.md` 修改保持不变，未被覆盖或纳入本任务提交。（验证：实现前后对比 `git diff -- docs/superpowers/specs/2026-08-12-patrol-delete-button-usability/checklist.md`，期望本任务未增加该文件差异）

## 编译与测试

- [x] 飞书、告警、Signature、Kiro 和小时汇总聚焦测试全部通过。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu or alert or signature_interop or kiro or hourly_patrol_summary" -q`）

- [x] 后端全量测试在全新临时 SQLite 数据库中通过。（验证：运行 `cd backend && test_db_dir=$(mktemp -d) && DATABASE_URL="sqlite:///$test_db_dir/test.db" python3 -m pytest -q`）

- [x] 目标代码和测试差异没有空白错误。（验证：运行 `git diff --check -- backend/app/services.py backend/tests/test_api.py`，期望无输出且退出码为 0）

## 验收报告

### 通过（31/31）

- [x] 严格白名单、通知字段、脱敏、状态流转、小时汇总、手动重发和去重边界均由后端自动化测试覆盖。
- [x] 聚焦验证：`python3 -m pytest tests/test_api.py -k "feishu or alert or signature_interop or kiro or hourly_patrol_summary" -q`，结果 `91 passed, 360 deselected`。
- [x] 全量验证：临时 SQLite 数据库执行 `python3 -m pytest -q`，结果 `460 passed`。
- [x] 差异验证：`git diff --check` 无输出；后端仅修改 `backend/app/services.py` 和 `backend/tests/test_api.py`。
- [x] 用户原有删除按钮 checklist 差异哈希实现前后均为 `b9c50c0262c18203bb3a5f15709f6c45a4ca2300894cfa3aaeb1d97aaa380004`。

### 未通过

无。

### 端到端

- [x] Signature、Kiro、历史标签手动重发和跨小时去重刷新均通过模拟飞书 Webhook 完成端到端验证；未调用真实飞书 Webhook。
