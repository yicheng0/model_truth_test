# 当前自动巡检架构说明

本文档记录当前代码已经实现的自动巡检链路，作为企业级改造前的基线。本文只描述现状，不代表最终企业级目标。

## 渠道健康画像数据链路

入口为 `GET /api/channels/{channel_id}/health-profile?days=1|7|30`。聚合过程只加载时间窗内的 Result、Comparison、巡检任务与告警；当窗口内无结果时，仅额外读取该渠道最近一条历史 Result 用于 stale 判定。

```text
Result + Comparison + ChannelAlert + PatrolJob + AuditLog
  -> 样本置信度 / stale
  -> availability / performance / protocol / quality
  -> Gold / official cloud reference band
  -> 连续窗口防抖与状态原因
  -> ChannelHealthProfile API
  -> Channels 健康画像面板
```

性能 P50/P95/P99、TTFT 和吞吐只使用成功请求，失败请求只进入 availability。普通异常连续两个半窗口才降级；严重协议异常或最新连续三次失败立即 critical。官方参考缺失时返回 `baseline_inconclusive`，不降低候选自身运行健康。画像结论是风险和置信度摘要，不修改已有报告评分、等级或真实性判断。

查询使用 `results(channel_id, created_at)` 与 `channel_alerts(channel_id, created_at)` 复合索引。`AuditLog(target_type=channel, target_id=...)` 提供最近配置变更时间，帮助定位配置与指标突变的相关性。

## 1. 运行模式

系统有两类检测入口：

- 手动检测：通过 `/api/runs` 创建 run，按测试集、渠道、重复次数和并发度执行。
- 自动巡检：通过 `/api/scheduled-tests` 创建计划，由后台调度器或手动 `run-now` 触发。

自动巡检当前默认使用 `scheduled_probe` 范围，固定执行：

- Thinking temperature 参数冲突探针。
- Web Search tool 参数探针。
- `adaptive thinking effort` 参数探针。
- Thinking Signature 互通检测。
- 报告生成、风险分类、异常标签和告警通知。

## 2. 核心数据模型关系

```text
Channel
  └─ ScheduledChannelTest.channel_id
       ├─ Run.scheduled_test_id
       │    ├─ Result.run_id
       │    ├─ Report.run_id
       │    └─ ChannelAlert.run_id
       └─ ChannelAlert.scheduled_test_id

BaselineSnapshot
  └─ ScheduledChannelTest.baseline_snapshot_id
```

### 2.1 `Channel`

渠道/资源定义。关键字段：

- `id`：渠道 ID。
- `provider_type`：渠道类型，如 Anthropic、AWS Bedrock、Azure Foundry、第三方 relay。
- `role`：gold、official_cloud、candidate、negative。
- `base_url`、`model_name`：请求目标和模型名称。
- `auth_config_encrypted`：当前是 JSON 配置字段，可能包含凭证或非敏感 provider 配置。注意：当前模型层没有证明该字段已强加密。

敏感性：高。`auth_config_encrypted`/`auth_config` 必须按潜在敏感字段处理。

### 2.2 `ScheduledChannelTest`

自动巡检计划。关键字段：

- `channel_id`：被巡检资源。
- `suite_id`、`baseline_snapshot_id`：兼容完整候选评测；`scheduled_probe` 默认使用内置手动探针 suite 和 `scheduled_probe_baseline`。
- `interval_minutes`、`run_window_start`、`run_window_end`：调度频率与执行窗口。
- `test_scope`：当前自动巡检主要为 `scheduled_probe`。
- `quiet_minutes`、`max_retries`、`retry_interval_minutes`：告警降噪和重试设置。
- `locked_by`、`locked_until`：调度锁。
- `last_queued_at`、`last_started_at`、`last_finished_at`、`last_status`、`last_error`、`last_run_id`：最近执行摘要。

### 2.3 `Run`

一次检测任务。自动巡检触发时会写入：

- `scheduled_test_id`：关联计划。
- `test_scope`：通常为 `scheduled_probe`。
- `status`：pending、running、completed、failed、canceled 等。
- `total_jobs`、`completed_jobs`：进度统计。

### 2.4 `Result`

单个 probe/case/channel/attempt 的结果。关键字段：

- `normalized_response`：归一化后的响应。
- `raw_request`：脱敏后的请求证据。
- `raw_response`：脱敏后的响应证据。
- `metrics`：latency、first token latency、status code、error type 等。
- `score`、`labels`：单项评分与异常标签。

证据性：高。必须持续保持脱敏。

### 2.5 `Report`

渠道级报告。自动巡检报告包含：

- `final_score`、`grade`。
- `summary`：风险摘要。
- `evidence`：结构化证据，包括 model request、signature interop、labels、classification。
- `markdown`：可下载的 Markdown 报告。

证据性：高。报告结论必须能回溯到 result、message id、request id、probe key。

### 2.6 `ChannelAlert`

异常告警。关键字段：

- `scheduled_test_id`、`run_id`、`report_id`、`channel_id`。
- `status`：当前主要是 `pending_review` 等简单状态。
- `severity`：high/critical 等。
- `trigger_labels`：触发标签。
- `dedupe_key`：告警去重。
- `notification_status`：pending、sent、failed、skipped。
- `reviewer_name`、`review_note`、`reviewed_at`：复审信息。

## 3. 自动巡检执行链路

### 3.1 计划创建

入口：

```text
POST /api/scheduled-tests
```

主要行为：

1. 校验 channel 存在且不是 reference channel。
2. 如果未显式传 suite/baseline，默认创建或复用 `scheduled_probe_baseline`。
3. 写入 `ScheduledChannelTest`。
4. 计算 `next_run_at`。

当前简化创建只需要：

```json
{
  "name": "daily patrol",
  "channel_id": "third_party_demo",
  "interval_minutes": 1440,
  "enabled": true
}
```

### 3.2 调度器 tick

入口函数：

```text
scheduled_test_loop()
scheduled_test_tick()
```

调度器由 `AUTO_SCHEDULER_ENABLED` 控制。tick 行为：

1. 尝试发送到期日报。
2. 刷新活跃计划锁。
3. 恢复过期锁任务。
4. 查询 `enabled = true` 且 `next_run_at <= now` 的计划。
5. 通过 `claim_scheduled_test()` 设置 `locked_by`、`locked_until`、`last_status = queued`。
6. 对 claimed 计划创建后台 task 执行。

### 3.3 手动立即巡检

入口：

```text
POST /api/scheduled-tests/{scheduled_id}/run-now
```

主要行为：

1. 强制 claim 当前计划。
2. 立即返回计划状态，通常是 `queued`。
3. 后台执行 `execute_scheduled_channel_test()`。
4. 手动运行不依赖 `AUTO_SCHEDULER_ENABLED`。

### 3.4 scheduled_probe 执行

入口函数：

```text
execute_scheduled_channel_test()
execute_scheduled_probe_run()
```

`scheduled_probe` 主要步骤：

1. 设置计划为 running。
2. 调用 `create_scheduled_model_request_probe()` 发起固定真实模型参数探针。
3. 创建 run/result。
4. 调用 `attach_signature_interop_to_scheduled_run()` 执行 Thinking Signature 互通检测。
5. 调用 `build_scheduled_probe_report()` 生成报告。
6. 释放计划锁并标记 completed/failed。
7. 调用 `create_alerts_for_run()` 创建告警并发送通知。

### 3.5 告警通知

入口函数：

```text
create_alerts_for_run()
send_alert_notification()
```

主要行为：

1. 遍历 run 下的 report。
2. 按 grade、score、red flag、scheduled_probe classification 判断是否需要告警。
3. 生成 `dedupe_key`，结合 `quiet_minutes` 避免重复刷屏。
4. 写入 `ChannelAlert`。
5. 根据飞书设置发送通知。
6. 如果飞书未启用或未配置 webhook，`notification_status = skipped`。
7. 如果发送成功，`notification_status = sent`。
8. 如果重试后仍失败，`notification_status = failed`。

## 4. API 路由清单

### 4.1 主运行 API

```text
GET    /api/runs
POST   /api/runs
GET    /api/runs/{run_id}
GET    /api/runs/{run_id}/results
GET    /api/runs/{run_id}/progress
POST   /api/runs/{run_id}/cancel
DELETE /api/runs/{run_id}
GET    /api/runs/{run_id}/report.md
```

说明：新代码应优先使用 `/api/runs`。

### 4.2 兼容运行 API

```text
/api/eval-runs/*
```

说明：兼容旧前端/旧脚本，不应随意破坏。

### 4.3 自动巡检 API

```text
GET    /api/scheduled-tests
POST   /api/scheduled-tests
GET    /api/scheduled-tests/health
GET    /api/scheduled-tests/report
GET    /api/scheduled-tests/report.md
POST   /api/scheduled-tests/report/send-daily
GET    /api/scheduled-tests/{scheduled_id}
PATCH  /api/scheduled-tests/{scheduled_id}
DELETE /api/scheduled-tests/{scheduled_id}
POST   /api/scheduled-tests/{scheduled_id}/run-now
```

### 4.4 告警 API

```text
GET    /api/alerts
PATCH  /api/alerts/{id}/review
DELETE /api/alerts/{id}
POST   /api/alerts/bulk-delete
POST   /api/alerts/{id}/resend-notification
```

### 4.5 报告 API

```text
GET    /api/reports
GET    /api/reports/summary
GET    /api/reports/{id}/detail
DELETE /api/reports/{id}
POST   /api/reports/bulk-delete
GET    /api/reports/compare
```

### 4.6 设置 API

```text
GET   /api/settings/feishu-broadcast
PATCH /api/settings/feishu-broadcast
POST  /api/settings/feishu-broadcast/test
GET   /api/settings/channel-taxonomy
PATCH /api/settings/channel-taxonomy
```

## 5. 敏感字段和证据字段

### 5.1 必须视为敏感

- `Channel.auth_config_encrypted` / `Channel.auth_config`。
- runtime credentials。
- API key、Authorization header、x-api-key、token、secret。
- `FeishuBroadcastSetting.webhook_url`。
- `FeishuBroadcastSetting.webhook_secret`。
- provider request headers。

### 5.2 证据字段

- `Result.raw_request`。
- `Result.raw_response`。
- `Result.normalized_response`。
- `Result.metrics`。
- `Report.evidence`。
- `Report.markdown`。
- `ChannelAlert.message`。
- `ChannelAlert.trigger_labels`。
- `ChannelAlert.dedupe_key`。

要求：证据字段可以保存诊断信息，但不得包含密钥明文。

## 6. 当前安全限制

当前实现支持运行时密钥和脱敏逻辑，但还不是完整企业密钥托管方案：

- `auth_config_encrypted` 只是当前模型字段名，不能据此假设已经强加密。
- 企业生产部署前应优先改造为 Secret 引用、KMS/Vault/Secret Manager 或环境变量引用。
- 报告和告警必须继续使用 `redact_secrets()` / `redact_text()` 这类脱敏入口。
- 调整 provider live-call 行为前必须查当前官方文档，避免因 API 变更导致误报。

## 7. 当前测试覆盖基线

已有后端测试覆盖：

- 自动巡检计划创建。
- `run-now` 触发。
- 调度 tick claim 和 next_run 推进。
- run/report/alert 关联删除。
- scheduled_probe 简化创建。
- run window 校验。
- alert dedupe 和 report 汇总部分行为。
- 飞书设置密钥遮罩和保留。

Phase 0 补齐重点：

- 飞书告警发送成功时，`notification_status = sent`。
- 飞书告警发送失败时，`notification_status = failed` 且记录错误。
- README 明确当前生产部署前密钥治理限制。
