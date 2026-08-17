# 飞书仅播报 Signature 异常与检测任务列表移除 Checklist

> 本清单已于 2026-08-17 按实际命令和浏览器流程验收；所有通过项已勾选。

## Signature-only 通知资格

- [x] AC1：构造同一小时内的明确 Relay Signature 拒绝、Kiro 身份泄漏、普通真实性异常和运营问题，执行小时任务后只调用一次 Webhook，返回的 `alert_count` 只统计 Signature 告警。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_sends_one_message_for_all_channels" -q`，期望通过）

- [x] AC1：明确 Signature 拒绝必须同时满足 Relay 阶段、HTTP 400、固定错误文本和 `signature_ok=false` 或兼容的字段缺失；只带历史标签、普通 HTTP 400 或其他阶段均不得发送。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_eligibility_signature or feishu_alert_eligibility_non_whitelist or feishu_resend_whitelist_legacy_signature_label" -q`，期望通过）

- [x] AC2：只有结构化 Kiro 身份泄漏的小时不调用 Webhook，Kiro 站内告警仍创建但通知状态为 `skipped`。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_eligibility_kiro or alert_notification_initial_status_kiro or hourly_patrol_summary_kiro_only" -q`，期望通过）

- [x] AC2：只有普通真实性异常、低评分、协议偏差或 D/E 等级的小时不调用 Webhook，历史 `pending`/`failed` 通知状态改为 `skipped` 且尝试次数不增加。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_whitelist_skips_historical_non_whitelist or alert_notification_initial_status_non_whitelist" -q`，期望通过）

- [x] AC2：只有网络、超时、HTTP 5xx、权限、额度、无可用渠道、账号错误或正常结果的小时不调用 Webhook。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_eligibility_operational or hourly_patrol_summary_sends_normal_channel_without_alerts" -q`，期望通过）

## 飞书消息内容

- [x] AC3：Signature 小时消息包含 `Thinking Signature 异常汇总`、异常条数、固定错误摘要、Source 渠道、Relay 渠道、发生时间，以及双方 Message ID 和 Request ID。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_sends_one_message_for_all_channels or feishu_alert_text_signature" -q`，期望通过）

- [x] AC3：Signature 标识缺失时对应字段显示“未提供”，不从原始请求、响应或 header 中猜测补全。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_text_signature_missing_ids" -q`，期望通过）

- [x] AC3：小时消息不包含 Kiro、巡检次数、正常数、真实性异常总数、运营问题、渠道综合情况、最低分、评分、等级或复审链接。（验证：检查 `hourly_patrol_summary_sends_one_message_for_all_channels` 捕获的飞书正文负向断言，期望全部通过）

- [x] AC4：报告证据包含完整 Signature、Signature 前缀、完整 thinking、API Key、认证头、完整原始请求和响应时，飞书正文均不包含这些值。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_text_signature_redacts_sensitive_evidence" -q`，期望通过）

- [x] AC4：原始错误正文附带长载荷或凭据形态时，飞书仍只显示固定摘要 `Invalid signature in thinking block`。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_text_signature or feishu_alert_text_sanitizes_identifiers" -q`，期望通过）

## 无 Signature 小时与状态流转

- [x] AC2、AC5：有巡检记录但没有合格 Signature 告警时，不构造飞书 payload、不调用 Webhook，返回“该小时无 Signature 异常”。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_sends_normal_channel_without_alerts or hourly_patrol_summary_whitelist_skips_historical_non_whitelist" -q`，期望 Webhook 调用次数为 0）

- [x] AC5：无 Signature 异常时仍将 `last_hourly_summary_at` 推进到时间窗结束并释放租约；相同时间再次执行不会重复扫描或发送。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_advances_without_signature or hourly_patrol_summary_advances_past_empty_hour" -q`，期望通过）

- [x] 小时边界继续使用左闭右开区间：整点前的 Signature 属于当前小时，恰好整点的 Signature 留到下一小时。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_excludes_next_hour_boundary" -q`，期望通过）

- [x] 整点后五分钟水位保持不变：过早执行不推进游标、不调用 Webhook。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_waits_five_minutes_after_hour_boundary" -q`，期望通过）

- [x] Signature 小时发送成功后仅合格 Signature 告警更新为 `sent` 并增加一次尝试；Kiro 和其他非 Signature 告警为 `skipped` 且尝试次数不增加。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_sends_one_message_for_all_channels" -q`，期望通过）

- [x] Signature 小时发送失败时仅合格 Signature 告警更新为 `failed` 并增加尝试次数；非 Signature 告警不进入重试队列，小时租约被释放。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_whitelist_failure_only_retries_eligible_alerts" -q`，期望通过）

## 单条通知、重发与去重

- [x] AC7：Kiro 告警进行首次发送或人工重发时，发送前资格复核将其改为 `skipped`，Webhook 调用次数为 0，发送尝试次数不增加。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_resend_kiro_skipped or feishu_resend_endpoint_cannot_bypass_whitelist" -q`，期望通过）

- [x] 只有历史 `signature_interop_failed` 标签但无明确拒绝正文的告警，人工重发仍被拦截。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_resend_whitelist_legacy_signature_label" -q`，期望通过）

- [x] AC8：明确 Signature 告警单条发送失败时继续执行现有最多三次网络重试，最终状态为 `failed`；合法重发仍可再次尝试。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "alert_notification_marks_failed or feishu_resend_whitelist_retry" -q`，期望通过）

- [x] AC8：同一 Signature 异常在静默期内重复出现时继续复用现有站内告警并更新连续窗口，不创建重复告警。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "alert_dedup or quiet_window or refreshed_whitelist_evidence" -q`，期望通过）

- [x] AC8：飞书测试消息不需要巡检报告或 Signature 证据，仍调用一次 Webhook 并发送 `哈喽`。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_test_message_bypasses_alert_whitelist" -q`，期望通过）

## 图二功能移除

- [x] AC5：打开 `/runs`，页面不显示截图二中的普通检测任务渠道分组表、任务数、最近状态、最近进度、最近任务和最近创建时间。（验证：运行 `cd frontend && npm run build && npm run test:runs-pagination`，浏览器负向断言全部通过）

- [x] AC5：页面不显示普通任务的“全选可删除”“删除已选”及展开后的普通任务明细和单条操作。（验证：运行 `cd frontend && npm run test:runs-pagination`，期望相关元素数量为 0）

- [x] AC5：进入 `/runs` 时普通 `/api/runs?exclude_patrol=true` 列表请求次数为 0，确认功能是真正移除而非仅隐藏。（验证：运行 `cd frontend && npm run test:runs-pagination`，期望普通列表请求计数为 0）

- [x] 普通任务后端数据和接口仍存在，没有数据库删除或公共路由移除。（验证：运行后端完整测试，并检查 `git diff -- backend/app/routers backend/app/models.py backend/app/schemas.py backend/migrations`，期望无相关删除）

## 自动巡检页面保留

- [x] AC6：`/runs` 页面保留当前仍存在的“真实性对比”创建入口，链接指向 `/new-run`；并行工作区中已批准的“提取渠道指纹”移除保持不变，不在本任务中恢复。（验证：`channelFingerprintRemoval.test.ts` 断言旧入口不可见，`runs-pagination.mjs` 断言“真实性对比”链接可见且 href 正确；两者均通过）

- [x] AC6：自动巡检日志仍能按渠道筛选、切换“只看错误”、稳定分页并调整每页数量。（验证：运行 `cd frontend && npm run test:runs-pagination`，期望完整筛选和分页流程通过）

- [x] AC6：自动巡检全局异常摘要仍展示站内 Kiro 身份泄漏与 Thinking Signature 无效，并能链接到跨页命中详情。（验证：运行 `cd frontend && npm run test:runs-pagination`，期望两个摘要及链接断言通过）

- [x] AC6：展开一条自动巡检日志时只请求该条完整结果，首屏不产生逐行详情请求。（验证：运行 `cd frontend && npm run test:runs-pagination`，期望详情请求计数断言通过）

- [x] AC6：自动巡检单条取消、单条删除、删除已选和删除当前范围仍保留；pending/running 日志不进入删除集合。（验证：运行 `cd frontend && npm run test:runs-pagination`，期望删除请求 ID 与未结束保护断言通过）

- [x] AC7：Kiro、运营故障和其他非 Signature 记录继续存在于自动巡检日志及站内异常摘要，不因飞书策略收紧而从前端证据中删除。（验证：浏览器巡检日志 mock 同时包含 Kiro、运营失败和普通异常，观察列表与摘要仍可定位；并运行后端站内告警可见性测试）

## 端到端场景

- [x] 完整 Signature 流程：Source 产生 thinking，Relay 明确返回 HTTP 400 Signature 拒绝，系统创建 `pending` 告警；小时任务发送一条纯 Signature 飞书消息，消息包含定位字段且不包含综合巡检统计或敏感证据。（验证：运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_signature_end_to_end or hourly_patrol_summary_sends_one_message_for_all_channels" -q`，期望通过）

- [x] 重要边界流程：一个小时只有 Kiro、运营错误和正常巡检，系统保留站内记录，将通知状态标记为 `skipped`，推进小时游标，Webhook 调用次数为 0。（验证：运行对应 Kiro-only、operational-only 和 normal-only 小时测试，期望全部通过）

- [x] 页面完整流程：进入 `/runs` 看不到图二功能，仍能使用现有“真实性对比”入口、筛选自动巡检、展开详情、勾选已结束日志并删除、取消运行中巡检，页面无未处理错误。（验证：运行 `cd frontend && npm run test:runs-pagination`，退出码为 0；取消请求只提交 `patrol_65`，`pageErrors` 为空）

## 编译与测试

- [x] 后端飞书、告警、Signature、Kiro 和小时调度聚焦测试在全新临时 SQLite 数据库中全部通过。（验证：运行 `cd backend && patrol_test_tmp=$(mktemp -d) && DATABASE_URL="sqlite:///$patrol_test_tmp/test.db" python3 -m pytest tests/test_api.py -k "feishu or alert_notification or signature_interop or kiro or hourly_patrol_summary" -q`）

- [x] 后端完整测试在全新临时 SQLite 数据库中通过。（验证：运行 `cd backend && full_test_tmp=$(mktemp -d) && DATABASE_URL="sqlite:///$full_test_tmp/test.db" python3 -m pytest -q`）

- [x] 前端全部 Vitest 测试通过。（验证：运行 `cd frontend && npm test`）

- [x] TypeScript 检查与生产构建通过。（验证：运行 `cd frontend && npm run build`）

- [x] 巡检页面浏览器端到端测试通过。（验证：运行 `cd frontend && npm run test:runs-pagination`）

- [x] 目标差异无空白错误。（验证：运行 `git diff --check`，期望无输出且退出码为 0）

## 变更范围

- [x] AC9：业务代码只修改 `backend/app/services.py`、`backend/tests/test_api.py`、`frontend/src/pages/Runs.tsx` 和 `frontend/e2e/runs-pagination.mjs`。（验证：检查 `git status --short` 与逐文件 diff）

- [x] AC9：未新增数据库迁移、队列、缓存、任务类型、渠道配置、身份系统或凭据持久化。（验证：检查迁移、依赖、模型和配置差异，期望无相关改动）

- [x] 飞书日报代码和文案未修改。（验证：检查 `smart_patrol_daily_text` 及日报发送相关差异，期望无变化）

- [x] 普通检测任务后端接口未删除；只从 `/runs` 页面移除普通列表读取和展示。（验证：检查路由差异并运行后端完整测试）

- [x] 用户已有 `docs/superpowers/specs/2026-08-12-patrol-delete-button-usability/checklist.md` 修改完整保留，本任务未编辑、还原、暂存或纳入提交。（验证：比较实现前后该文件差异与 Git 状态）

- [x] 本规格目录四份文档没有未解决标记或临时留白，且实现与批准范围一致。（验证：运行 `python3 -c "from pathlib import Path; terms=[''.join(map(chr, codes)) for codes in ((84,79,68,79),(84,66,68),(21344,20301),(24453,23450))]; root=Path('docs/superpowers/specs/2026-08-17-signature-only-feishu-and-task-list-removal'); hits=[str(path) for path in root.glob('*.md') if any(term in path.read_text() for term in terms)]; print('\\n'.join(hits))"`，期望无输出）

## 2026-08-17 验收记录

- 后端聚焦回归：`64 passed, 388 deselected`。
- 后端完整回归：全新临时 SQLite 数据库，`461 tests collected`，进度到 `[100%]`，退出码 `0`。
- 前端单元测试：`20 passed` 测试文件，`176 passed` 测试。
- 前端生产构建：TypeScript 与 Vite 构建退出码 `0`；仅保留既有的大 chunk 警告。
- `/runs` 浏览器流程：退出码 `0`；普通任务接口请求次数为 `0`，图二元素不可见，巡检筛选、分页、异常摘要、展开、删除和运行中取消均通过，无 `PAGEERROR`。
- 范围检查：`git diff --check` 退出码 `0`；后端路由、模型、Schema、迁移与飞书日报无差异。
- 并行改动处理：保留已存在的“提取渠道指纹”入口移除及其未跟踪回归测试，不恢复、不纳入本任务实现范围；用户已有的 2026-08-12 checklist 修改未触碰。
