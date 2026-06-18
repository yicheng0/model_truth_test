# 企业级 Claude 资源自动巡检改造开发计划

本文档用于把当前 Claude 渠道真实性检测平台，从 MVP/内部工具演进为企业级 Claude 资源自动巡检、风险检测、证据留存和告警运营平台。

当前项目已经具备自动巡检基础：`ScheduledChannelTest`、进程内调度器、DB 锁、巡检健康检查、Thinking Signature 互通检测、真实模型请求参数探针、飞书告警、日报、Markdown 报告和告警复审。后续重点不是继续堆叠单点检测，而是补齐企业长期运行所需的密钥治理、审计、调度可靠性、可观测性、证据治理和多团队运营能力。

## 1. 改造目标

### 1.1 产品目标

- 统一纳管企业内 Claude 相关资源：Anthropic 官方 API、AWS Bedrock、Azure/Microsoft Foundry、第三方代理、OpenAI-compatible Claude relay、负样本校准渠道。
- 按计划自动巡检资源真实性、协议一致性、参数支持、Thinking/Signature 行为、Tool Use、Streaming、性能、稳定性和异常漂移。
- 输出风险与置信度评级，而不是绝对真假判断。
- 为异常提供可追溯证据链：run、result、report、alert、message id、request id、endpoint、协议字段、stream trace、latency、labels。
- 支持企业运营：告警降噪、复审闭环、日报/周报、趋势分析、权限、审计和数据保留。

### 1.2 非目标

- 不把结论表述为“100% 真 Claude / 假 Claude”。
- 不在第一阶段引入大规模微服务拆分。
- 不在没有明确任务前引入 Redis、Celery、完整 IAM 或复杂租户体系。
- 不破坏现有 SQLite 本地开发和 mock 模式。
- 不破坏现有 `/api/runs` 主路径与 `/api/eval-runs` 兼容路径。

## 2. 当前基线梳理

### 2.1 已有能力

- 前端：React 19、TypeScript、Vite、React Query、Ant Design、Recharts。
- 后端：FastAPI、SQLAlchemy 2.x、Pydantic v2、httpx、boto3、pytest。
- 数据库：SQLite 默认本地开发，Docker Compose 可用 PostgreSQL。
- 自动巡检：`/api/scheduled-tests` 计划创建、更新、删除、手动立即运行。
- 调度器：`AUTO_SCHEDULER_ENABLED` 控制进程内 `asyncio` 调度循环。
- 调度锁：`locked_by`、`locked_until`、`last_status`、`next_run_at`。
- 告警：`ChannelAlert`、dedupe、quiet window、飞书通知、日报。
- 证据：`Result.raw_request`、`Result.raw_response`、`Report.evidence`、Markdown 报告。
- 巡检探针：Thinking temperature 冲突、Web Search tool、thinking.adaptive.enabled、Thinking Signature 互通。
- 评分和标签：grade A-E、labels、red flags、classification。

### 2.2 主要短板

- `Channel.auth_config_encrypted` 当前是 JSON 字段，命名像加密但缺少明确加密/密钥引用实现。
- 缺少完整认证、RBAC、操作审计和多团队资源归属。
- `backend/app/services.py` 和 `backend/app/main.py` 过大，后续扩展 probe 与 provider 容易失控。
- 调度器依赖进程内循环，企业多实例、重启恢复、attempt 追踪能力不足。
- 告警生命周期偏简单，缺少恢复通知、聚合、升级策略和误报标记分析。
- 巡检策略主要硬编码在 Python 常量中，不利于企业按资源等级配置。
- 缺少 Prometheus/结构化日志等运维指标。
- 报告和证据缺少 hash、规则版本、probe 版本、baseline 版本等不可抵赖信息。

## 3. 企业级能力分层

### 3.1 资源层

资源对象建议从单纯 channel 扩展为企业资产：

- 渠道 ID、名称、provider_type、role、base_url、model_name。
- 所属团队、业务线、环境：生产、测试、预发。
- 账号类型：Anthropic direct、AWS、Azure、Vertex、relay、aggregator。
- 供应商、合同/工单编号、负责人、告警联系人。
- 风险等级：核心生产、高风险实验、低成本采样。
- 成本预算、每日 token 上限、允许并发、巡检频率上限。
- 凭证引用：secret_ref，而不是直接保存明文 key。

### 3.2 策略层

巡检策略应从硬编码升级为模板化：

- `quick_smoke`：低成本探活和基础协议检查。
- `protocol_strict`：message id、model、usage、stop_reason、error schema。
- `streaming`：SSE 事件顺序、first-token latency、message_start/content_block_delta/message_stop。
- `thinking_signature`：thinking block、signature 生成与互通。
- `tool_use`：tool_use id、JSON args、schema adherence。
- `parameter_enforcement`：max_tokens、stop_sequences、temperature/thinking 冲突。
- `web_capability`：web_search server tool 支持与错误形态。
- `performance_cost`：latency P50/P95、失败率、token usage skew、成本估算。
- `full_evidence`：深度复核，多轮重复和 baseline 对比。

策略模板需要记录版本号，保证历史报告可复现。

### 3.3 执行层

- 每次计划触发生成 job。
- 每次 job 可有多个 attempt。
- attempt 记录开始、结束、状态、错误、超时、重试原因。
- provider 调用应经过统一 adapter，便于审计、脱敏、超时、重试和 metrics。
- 支持全局并发、单渠道并发、单 provider 并发和成本限制。

### 3.4 证据层

- 标准化 evidence schema。
- 保存脱敏 raw request/response。
- 保存 request hash、response hash、normalized hash。
- 保存 probe version、scoring version、baseline snapshot id、suite fingerprint。
- 报告结论必须能回链到具体 result/probe/label。
- 支持 evidence export，用于审计或供应商沟通。

### 3.5 告警层

- 告警状态流转：`pending_review`、`acknowledged`、`investigating`、`resolved`、`false_positive`、`suppressed`。
- 告警恢复通知：连续 N 次恢复后自动关闭或提示恢复。
- 聚合规则：同渠道、同 probe、同 label、同 locator 聚合。
- 升级策略：核心生产资源、连续失败、red flag、signature 失败应提升严重级别。
- 通知通道抽象：飞书、企业微信、Slack、Teams、Email、Generic Webhook。

### 3.6 运营层

- 自动巡检总览：运行数、成功率、异常率、待复审。
- 资源风险排行榜。
- 单渠道趋势：score、grade、labels、latency、failure rate、token usage。
- 报告中心：日报、周报、月报、资源报告、异常复盘报告。
- 复审工作台：批量处理、备注、负责人、误报原因。

## 4. 分阶段开发路线图

## Phase 0：现状固化与风险清点

目标：在不大改业务的前提下，给后续改造建立安全边界和测试基线。

### 任务

- [ ] 补充当前自动巡检架构说明：调度器、scheduled test、run、result、report、alert 的关系。
- [ ] 梳理当前 API 路由清单，标注兼容接口和主接口。
- [ ] 梳理当前数据模型字段，标注敏感字段和证据字段。
- [ ] 给自动巡检关键链路增加回归测试：创建计划、run-now、调度 tick、生成 report、生成 alert、飞书 skipped/sent/failed。
- [ ] 明确当前 `auth_config_encrypted` 不是强加密的事实，避免误导部署文档。

### 验收

- [ ] 新增 `docs/current-architecture.md`。
- [ ] 新增自动巡检链路测试或补齐已有测试断点。
- [ ] README 标注生产部署前密钥治理限制。

## Phase 1：密钥治理与脱敏强化

目标：企业上线前先解决凭证风险。

### 任务

- [ ] 将渠道凭证从普通 `auth_config` 里拆出：
  - `auth_config` 保存非敏感配置。
  - `secret_ref` 或 `credential_ref` 指向外部 Secret。
- [ ] 支持环境变量 Secret 引用，例如 `env:ANTHROPIC_API_KEY`。
- [ ] 预留 Vault/KMS/Secret Manager provider 接口。
- [ ] 后端统一 `CredentialResolver`：运行时按 channel + secret_ref 解析凭证。
- [ ] 前端不回显明文 key，只显示 masked preview 和 configured 状态。
- [ ] 对 raw request、raw response、report、alert、日志进行统一脱敏检查。
- [ ] 增加 secret 泄露单元测试：API key 不得出现在 DB report markdown、alert message、日志文本中。

### 验收

- [ ] 创建/更新 channel 不再要求把 API key 明文存入 DB。
- [ ] 真实调用仍可通过 runtime credentials 或 secret_ref 工作。
- [ ] mock 模式不受影响。
- [ ] 测试覆盖常见 key/header/token 脱敏。

## Phase 2：审计日志与权限边界

目标：让企业知道谁改了什么，先实现轻量内控。

### 任务

- [ ] 新增 `audit_logs` 表。
- [ ] 记录操作类型：channel create/update/delete、schedule create/update/delete/run-now、alert review/delete、report delete、setting update、credential change。
- [ ] 每条记录包含 actor、action、target_type、target_id、before/after diff 摘要、request id、created_at。
- [ ] 当前没有完整登录时，可先使用 `X-Admin-Token` / `X-Actor` / 本地默认 actor 过渡。
- [ ] 删除类接口统一要求 admin 依赖。
- [ ] 前端管理操作增加确认和操作人提示。

### 验收

- [ ] 管理操作能在审计日志查询到。
- [ ] 删除 report/alert/schedule 有审计记录。
- [ ] 审计记录不包含密钥明文。

## Phase 3：调度可靠性升级

目标：从“进程内定时循环”升级到“可恢复、可追踪、可多实例安全运行”。

### 任务

- [ ] 新增 `scheduled_jobs` 或 `patrol_jobs` 表。
- [ ] 新增 `patrol_job_attempts` 表。
- [ ] 每次计划到期先创建 job，再由 worker claim job。
- [ ] attempt 记录：queued_at、started_at、finished_at、status、error、timeout_seconds、worker_id、run_id。
- [ ] 支持退避重试：retry_interval、max_retries、jitter。
- [ ] 调度器健康检查增加：overdue jobs、stale attempts、worker heartbeat、last claim。
- [ ] 兼容现有 `ScheduledChannelTest.last_*` 字段，用作摘要缓存。
- [ ] 支持启动时恢复 stale job，并将未完成 run 标记为 failed/interrupted。

### 验收

- [ ] 服务重启后未完成任务可恢复或明确失败。
- [ ] 多实例下同一 job 不重复执行。
- [ ] 每次巡检可以看到 job 和 attempt 历史。

## Phase 4：巡检策略模板化

目标：把固定探针升级为可配置策略，便于不同资源按等级巡检。

### 任务

- [ ] 新增 `patrol_policies` 表。
- [ ] 策略字段：name、description、version、enabled probes、repeat_count、concurrency、budget、timeout、alert_rules。
- [ ] 内置策略：`quick_smoke`、`scheduled_probe_default`、`full_evidence`、`performance_cost`。
- [ ] 将现有 `SCHEDULED_MODEL_REQUEST_PROBES` 封装为 policy/probe registry。
- [ ] 每次 run/report 写入 policy id 和 policy version。
- [ ] 前端创建计划时选择策略，默认仍用当前固定巡检内容。
- [ ] 保留历史字段，兼容旧数据。

### 验收

- [ ] 新旧计划均可运行。
- [ ] 报告显示本次使用的策略和 probe 版本。
- [ ] 增加一个新 probe 不需要改动主调度流程。

## Phase 5：证据链与报告版本化

目标：让每个结论可追溯、可复核、可导出。

### 任务

- [ ] 定义标准 Evidence Schema。
- [ ] 为每个 result 保存：request_hash、response_hash、normalized_hash。
- [ ] 为 report 保存：evidence_schema_version、scoring_version、policy_version、generated_at。
- [ ] 报告不覆盖历史，可创建新版本或记录 `regenerated_from_report_id`。
- [ ] Markdown 报告增加 evidence index：result id、probe key、message id、request id、hash。
- [ ] 增加 JSON evidence export 接口。

### 验收

- [ ] 报告结论可通过 ID 定位到 result 和原始脱敏证据。
- [ ] 历史报告不因规则升级而静默变化。
- [ ] evidence export 不包含密钥。

## Phase 6：告警运营闭环

目标：从“发通知”升级为“可运营的事件闭环”。

### 任务

- [ ] 扩展告警状态：acknowledged、investigating、resolved、false_positive、suppressed。
- [ ] 增加恢复检测：连续 N 次正常后自动生成 recovery event。
- [ ] 告警聚合：按 channel + probe + label + locator 聚合。
- [ ] 告警升级：核心资源、连续失败、red flag、signature 失败升级 severity。
- [ ] 误报原因记录：provider API change、network issue、baseline stale、expected drift、manual exception。
- [ ] 通知通道接口抽象，飞书作为第一个实现。
- [ ] 支持 Generic Webhook，便于接 SIEM / SOAR。

### 验收

- [ ] 一个异常不会在 quiet window 内重复刷屏。
- [ ] 恢复后能看到恢复记录。
- [ ] 飞书之外可以配置通用 webhook。

## Phase 7：可观测性与运维指标

目标：让平台自己可监控。

### 任务

- [ ] 增加 `/metrics` Prometheus endpoint。
- [ ] 指标包括：
  - `patrol_runs_total`
  - `patrol_run_duration_seconds`
  - `patrol_alerts_total`
  - `patrol_jobs_overdue_total`
  - `provider_errors_total`
  - `channel_latency_ms`
  - `channel_failure_rate`
  - `scheduler_last_tick_timestamp`
- [ ] 结构化日志统一字段：run_id、scheduled_test_id、channel_id、result_id、report_id、alert_id、probe_key、request_id。
- [ ] 增加 `/api/ready`：DB、scheduler、secret resolver、notification setting。
- [ ] 前端增加“系统健康”页。

### 验收

- [ ] Prometheus 能抓到指标。
- [ ] 故障时可以通过日志按 run/channel/probe 串起链路。
- [ ] 健康页能定位调度器、DB、通知配置异常。

## Phase 8：前端企业控制台升级

目标：从任务列表升级为巡检运营工作台。

### 任务

- [ ] 资源台账页：渠道、团队、环境、风险、最近巡检、最近异常。
- [ ] 单资源详情页：趋势、最近 report、labels 分布、latency、failure rate、token usage。
- [ ] 巡检计划页：策略、频率、窗口、状态、job 历史、attempt 历史。
- [ ] 告警工作台：筛选、批量复审、状态流转、误报原因、负责人。
- [ ] 报告中心：日报、周报、导出、对比。
- [ ] 系统健康页：scheduler、overdue、stale、notification、metrics。

### 验收

- [ ] 企业用户可以从首页看到哪些资源最危险。
- [ ] 任一告警可以一键跳转到证据和报告。
- [ ] 任一资源可以看到趋势和最近异常原因。

## Phase 9：代码结构重构

目标：降低维护成本，为更多 provider/probe 扩展做准备。

### 任务

- [ ] 拆分 `backend/app/main.py` 路由：
  - `routers/runs.py`
  - `routers/channels.py`
  - `routers/scheduled_tests.py`
  - `routers/alerts.py`
  - `routers/reports.py`
  - `routers/settings.py`
- [ ] 拆分 `backend/app/services.py`：
  - `services/scheduler.py`
  - `services/runner.py`
  - `services/scoring.py`
  - `services/reports.py`
  - `services/alerts.py`
  - `services/notifications/feishu.py`
  - `services/probes/scheduled_probe.py`
  - `services/probes/signature_interop.py`
  - `services/probes/model_request.py`
- [ ] 抽象 provider adapter：
  - `providers/anthropic.py`
  - `providers/aws_bedrock.py`
  - `providers/azure_foundry.py`
  - `providers/openai_compatible.py`
- [ ] 抽象 domain 常量：labels、grades、roles、risk vocabulary。
- [ ] 保持 API 行为兼容，先移动代码再改设计。

### 验收

- [ ] 现有测试全部通过。
- [ ] 主接口响应结构不变。
- [ ] 新增 probe/provider 不需要修改巨型服务文件。

## 5. 建议数据模型增量

### 5.1 `audit_logs`

```text
id
actor_id
actor_name
action
target_type
target_id
request_id
before_summary
after_summary
metadata
created_at
```

### 5.2 `patrol_jobs`

```text
id
scheduled_test_id
channel_id
policy_id
status
priority
due_at
claimed_by
claimed_until
run_id
created_at
started_at
finished_at
last_error
```

### 5.3 `patrol_job_attempts`

```text
id
job_id
attempt_index
worker_id
status
run_id
started_at
finished_at
timeout_seconds
error_type
error_message
metadata
```

### 5.4 `patrol_policies`

```text
id
name
description
version
enabled
probe_config
alert_rules
cost_budget
created_at
updated_at
```

### 5.5 `notification_channels`

```text
id
name
type
enabled
config_encrypted_or_secret_ref
send_alerts
send_daily_reports
created_at
updated_at
```

### 5.6 `resource_owners`

```text
id
channel_id
team_name
owner_name
owner_contact
environment
criticality
metadata
```

## 6. API 规划

优先保持现有接口，新增企业级接口：

```text
GET    /api/patrol/policies
POST   /api/patrol/policies
PATCH  /api/patrol/policies/{id}

GET    /api/patrol/jobs
GET    /api/patrol/jobs/{id}
POST   /api/patrol/jobs/{id}/retry
POST   /api/patrol/jobs/{id}/cancel

GET    /api/audit-logs

GET    /api/notifications/channels
POST   /api/notifications/channels
PATCH  /api/notifications/channels/{id}
POST   /api/notifications/channels/{id}/test

GET    /api/ready
GET    /metrics

GET    /api/reports/{id}/evidence.json
GET    /api/channels/{id}/risk-trend
GET    /api/channels/{id}/patrol-summary
```

## 7. 代码拆分顺序建议

为了降低风险，先不大改功能，按下面顺序拆：

1. 抽出纯函数：grades、labels、red flags、时间工具。
2. 抽出 notification/feishu，不改变调用方。
3. 抽出 alerts service，不改变 API。
4. 抽出 reports markdown/evidence builder。
5. 抽出 scheduled probe 相关常量和函数。
6. 抽出 scheduler tick/loop/lock。
7. 最后拆 router。

每一步都跑：

```powershell
cd backend
python -m pytest

cd frontend
npm test
npm run build
```

## 8. 测试计划

### 8.1 后端单元测试

- 密钥脱敏：raw/report/alert/log 不出现 key。
- 调度：next_run、run window、claim lock、stale recovery。
- job attempt：retry、timeout、cancel、resume。
- probe classification：Claude、AWS、anomaly、provider error variant。
- alert dedupe：quiet window、same locator、different locator。
- report evidence：hash、schema version、policy version。

### 8.2 API 测试

- scheduled test CRUD。
- run-now。
- alerts review/delete/bulk。
- policies CRUD。
- audit logs query。
- evidence export。

### 8.3 前端测试

- API client request shape。
- 巡检计划创建。
- 告警筛选和复审。
- 报告下载和证据跳转。
- 系统健康状态 fallback。

### 8.4 集成测试

- mock 模式完整跑通。
- SQLite 本地跑通。
- PostgreSQL Docker Compose 跑通。
- 多调度器实例模拟 claim 不重复。

## 9. 安全与合规要求

- API key、webhook secret、provider credential 不得出现在：
  - DB 明文业务字段。
  - report markdown。
  - alert message。
  - frontend response。
  - backend log。
- 删除操作必须有权限和审计。
- 报告结论必须是风险和置信度表达。
- 安全测试 prompt 不得请求非法有害内容。
- provider 行为变更必须查官方文档后再调整 live-call 逻辑。
- hidden test fixture 应可轮换，不破坏公开 suite。

## 10. 里程碑建议

### M1：企业内测安全版

包含 Phase 0、1、2 的核心内容。

成功标准：可以安全给内部团队长期试用，不担心密钥泄露和操作不可追溯。

### M2：自动巡检可靠版

包含 Phase 3、4、5 的核心内容。

成功标准：调度可靠、策略可配置、报告可复核。

### M3：告警运营版

包含 Phase 6、7、8 的核心内容。

成功标准：异常能闭环，趋势能看清，平台自身可监控。

### M4：长期维护版

包含 Phase 9。

成功标准：代码结构支持持续增加 provider、probe、policy 和报告类型。

## 11. 首批落地任务建议

建议下一轮优先做以下 5 个小步，风险低且收益高：

1. 新增 `docs/current-architecture.md`，固化当前自动巡检链路。
2. README 增加生产部署安全说明，明确当前凭证治理限制。
3. 新增 `AuditLog` 模型和最小审计写入工具。
4. 为 scheduled test 的 create/update/delete/run-now 写审计记录。
5. 将飞书通知相关函数从 `services.py` 拆到独立模块，并保证测试通过。
