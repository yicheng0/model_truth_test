# 渠道健康画像完善开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有“健康画像”从成功率/P95 看板升级为可解释、可追溯、带样本置信度和官方参考带的渠道健康评估能力。

**Architecture:** 保持现有 FastAPI + SQLAlchemy + React Query 架构，不引入队列、Redis 或新的服务拆分。后端复用 `Result`、`Comparison`、`Report`、`BaselineResult`、`ChannelAlert` 和巡检数据计算健康画像；前端继续通过 `/api/channels/{channel_id}/health-profile` 获取数据。健康、来源一致性、能力质量分开计算，最终状态只作为摘要，不替代证据明细。

**Tech Stack:** FastAPI、SQLAlchemy 2.x、Pydantic v2、pytest、React 19、TypeScript、Ant Design、Recharts、Vitest。

---

## 1. 规则：完成一条，删除一条

本文件的“开发队列”是唯一执行清单，按顺序逐条完成。每条任务完成后必须同时满足：

1. 先写/更新测试，再实现代码。
2. 运行该任务的聚焦测试。
3. 运行相关回归测试。
4. 在“完成记录”追加日期、变更文件、测试命令和结果。
5. 从“开发队列”中删除已完成的任务行，不保留已完成 checkbox。

这样做的目的是让剩余队列始终代表未完成工作，而“完成记录”保留验收证据。

## 2. 产品边界

### 2.1 健康画像必须回答的问题

- 这个渠道最近是否可用？
- 延迟和首 token 是否明显偏离官方参考带？
- 协议字段、流式事件、工具调用和 Signature 是否稳定？
- 模型质量是否相对 Anthropic Gold / 官方云参考出现回归？
- 当前结论有多少样本支撑，样本是否过期？
- 当前状态由哪些可定位的证据触发？

### 2.2 必须避免的结论

- 不输出“100% 真 Claude”“假 Claude”“已证明官方直连”。
- 不把一次成功请求当作健康证明。
- 不把延迟异常单独当成来源真实性证据。
- 不把模型自报身份覆盖协议、能力和参考带证据。

### 2.3 健康与真实性分离

画像必须同时展示三个独立维度：

| 维度 | 含义 | 典型证据 |
|---|---|---|
| 运行健康 | 能否稳定完成请求 | 成功率、超时率、429/5xx、连续失败、巡检新鲜度 |
| 来源一致性 | 是否符合 Claude/Anthropic 协议和参考行为 | `model`、`usage`、`stop_reason`、SSE、tool-use、Signature、官方参考带 |
| 能力质量 | 输出质量是否出现回归 | Gold 相似度、官方云相似度、模块分数、重复一致性 |

## 3. 市场方案结论

调研参考：

- [LangSmith Dashboards](https://docs.langchain.com/langsmith/dashboards)：运行量、错误率、延迟、token、成本、反馈分数，可按标签、运行类型和元数据切分。
- [LangSmith Alerts](https://docs.langchain.com/langsmith/alerts)：使用时间窗口、计数/百分比/平均值阈值，并支持 Slack、PagerDuty、Dynatrace 和 Webhook。
- [Langfuse Metrics](https://langfuse.com/docs/metrics/overview)：将质量、延迟、成本、流量作为一组可按模型、版本、用户等维度切分的指标。
- [Arize Phoenix](https://arize.com/docs/phoenix)：Trace、在线/离线评测、同输入实验和回归分析结合。
- [Datadog Agent Observability](https://docs.datadoghq.com/llm_observability/)：运行指标、成本、质量评测和自动异常洞察结合，按 Span、工作流和主题发现漂移。
- [OpenTelemetry GenAI Semantic Conventions](https://github.com/open-telemetry/semantic-conventions-genai)：作为后续导出和字段命名参考，不作为本期外部依赖。

落到本项目的共性结论：

1. 健康判断必须带时间窗和样本量。
2. 运行、质量、成本/性能、异常证据必须可以分维度查看。
3. 阈值告警和趋势异常要分开，不能把一个固定阈值当成全部异常检测。
4. 每个摘要指标都应能下钻到请求、探针、run、report 和原始脱敏证据。

## 4. 当前代码基线与差距

### 4.1 当前实现

- 健康接口：`backend/app/routers/channels.py:339` 的 `GET /api/channels/{channel_id}/health-profile`。
- 当前状态函数：`backend/app/routers/channels.py:331`，只有 `insufficient_data`、`degraded`、`ok`。
- 当前状态规则：结果数为 0 算样本不足；失败率达到 30% 或存在待复审告警即降级。
- 当前聚合字段：成功率、失败率、平均延迟、P95、标签分布、错误分布、探针摘要、Signature、巡检、最近失败。
- 当前前端：`frontend/src/pages/Channels.tsx:92` 的 `ChannelHealthProfilePanel`。
- 当前类型：`frontend/src/types.ts:61` 的 `ChannelHealthProfile`。
- 当前测试：`backend/tests/test_api.py:5059` 至 `backend/tests/test_api.py:5237`。

### 4.2 本期差距

- 缺少最小样本量、独立运行数、模块覆盖数和数据新鲜度。
- 失败、协议异常、质量回归混在同一状态规则中。
- P95 没有明确只统计成功请求。
- 已有 TTFT、吞吐、token、协议标签和 baseline 数据，但健康接口没有统一展示。
- 没有官方 Gold/official cloud 参考带偏移。
- 没有连续窗口防抖、恢复状态和状态原因贡献度。
- 没有配置变更时间线。
- 前端没有健康/来源/质量三层视图。

## 5. 目标数据契约

### 5.1 保持接口路径不变

```text
GET /api/channels/{channel_id}/health-profile?days=1|7|30
```

现有字段全部保留；新增字段只能向后兼容，旧前端仍可读取原有 `status`、`success_rate`、`p95_latency_ms` 和 `trend`。

### 5.2 新增响应字段

```json
{
  "status": "healthy|watch|degraded|critical|insufficient_data|stale",
  "confidence": {
    "level": "low|medium|high",
    "score": 0,
    "sample_count": 0,
    "independent_run_count": 0,
    "module_coverage": 0.0,
    "freshness_hours": 0.0,
    "reasons": []
  },
  "dimensions": {
    "availability": {"score": 0, "status": "healthy|watch|degraded|critical", "reasons": []},
    "performance": {"score": 0, "status": "healthy|watch|degraded|critical", "reasons": []},
    "protocol": {"score": 0, "status": "healthy|watch|degraded|critical", "reasons": []},
    "quality": {"score": 0, "status": "healthy|watch|degraded|critical", "reasons": []}
  },
  "reference_band": {
    "p95_latency_ms": {"candidate": null, "lower": null, "upper": null, "deviation_ratio": null},
    "ttft_ms": {"candidate": null, "lower": null, "upper": null, "deviation_ratio": null},
    "gold_similarity": {"candidate": null, "lower": null},
    "official_cloud_similarity": {"candidate": null, "lower": null}
  },
  "status_reasons": [],
  "latest_config_change_at": null,
  "trend": []
}
```

### 5.3 状态含义

| 状态 | 判定原则 |
|---|---|
| `insufficient_data` | 样本或独立运行数不足，不能输出风险结论 |
| `stale` | 最近有效结果超过巡检周期的两倍，或时间窗内无新鲜结果 |
| `healthy` | 高置信度，四个维度均未越线 |
| `watch` | 低/中置信度、单点异常、轻微漂移或待复审告警 |
| `degraded` | 某一维度持续越线，或失败率/质量/参考带显著异常 |
| `critical` | 连续失败、严重协议破坏、疑似模型切换或多个维度同时严重异常 |

## 6. 评分、置信度和异常算法

### 6.1 四维评分

总分只作为排序和摘要，不作为真实性结论：

```text
health_score = availability * 0.30
             + performance  * 0.20
             + protocol     * 0.30
             + quality      * 0.20
```

维度定义：

- `availability`：成功率 50%，超时/5xx/429 30%，连续失败 20%。
- `performance`：成功请求 P95 40%，TTFT P95 30%，吞吐 20%，参考带偏移 10%。
- `protocol`：协议标签反向扣分，`protocol_mismatch`、`usage_missing`、`streaming_event_missing`、`tool_use_invalid` 为高权重异常。
- `quality`：Gold 相似度 40%，official cloud 相似度 30%，模块覆盖质量 20%，重复一致性 10%。

### 6.2 样本置信度

```text
confidence_score = 结果量因子 35%
                 + 独立运行因子 25%
                 + 模块覆盖因子 20%
                 + 新鲜度因子 20%
```

建议门槛：

- `low`：结果少于 10 条，或独立运行少于 2 次。
- `medium`：结果至少 10 条、独立运行至少 2 次、模块覆盖至少 50%。
- `high`：结果至少 30 条、独立运行至少 3 次、模块覆盖至少 75%，且最近有效结果未过期。

如果结果只有 1 条成功，必须仍为 `insufficient_data`，不能显示 `healthy`。

### 6.3 参考带

- 延迟参考带：同时间窗、相同模型/参数/探针的 Anthropic Gold 和官方云渠道 P50/P95。
- 质量参考带：Gold/official cloud 的相似度和模块分数分布。
- 官方参考不足时：保留候选自身运行健康，但将来源一致性标为 `inconclusive`，不能据此降级真实性。
- 参考渠道异常时：暂停基于参考带的降级，显示 `baseline_unhealthy` 原因。

### 6.4 防抖与恢复

- 普通阈值越线：连续 2 个时间窗口才进入 `degraded`。
- 严重协议异常、连续 3 次失败：立即进入 `critical`。
- 恢复：连续 2 个窗口正常后进入 `healthy` 或 `watch`。
- 告警记录需保存 `first_seen_at`、`last_seen_at`、`consecutive_windows`、`resolved_at`。

## 7. 开发队列（按顺序执行，完成后删除该条）

### Task 1：建立健康画像聚合边界和测试夹具

**Files:**
- Modify: `backend/tests/test_api.py`
- Modify: `backend/app/routers/channels.py`

- [ ] 增加统一 helper：区分 `request_failed`、`protocol_failure`、`quality_regression`、`operational_anomaly`。
- [ ] 增加测试数据工厂，能生成不同 `created_at`、run 数、module、baseline、metrics 和 labels。
- [ ] 增加 0、1、9、10、29、30 条结果和 1/2/3 次独立运行的边界测试。
- [ ] 验证旧字段结果不变，且脱敏测试继续通过。

**Verification:**

```bash
cd backend
python -m pytest tests/test_api.py -k "channel_health_profile" -q
```

### Task 2：实现样本置信度与 stale 判定

**Files:**
- Modify: `backend/app/routers/channels.py`
- Modify: `backend/app/schemas.py`
- Modify: `frontend/src/types.ts`
- Modify: `backend/tests/test_api.py`

- [ ] 新增 `confidence`、`sample_count`、`independent_run_count`、`module_coverage`、`freshness_hours`。
- [ ] 将单条结果从 `ok` 改为 `insufficient_data`。
- [ ] 增加 `stale` 状态和 `data_stale` 原因。
- [ ] 保留现有 `total_results`、`total_runs` 字段。

**Verification:**

```bash
cd backend
python -m pytest tests/test_api.py -k "health_profile" -q
cd ../frontend
npm test -- --run
```

### Task 3：拆分四个健康维度

**Files:**
- Modify: `backend/app/routers/channels.py`
- Modify: `backend/app/schemas.py`
- Modify: `backend/tests/test_api.py`

- [ ] 实现 availability、performance、protocol、quality 四个维度的纯函数。
- [ ] 成功请求延迟单独统计 P50/P95/P99，失败请求只进入可用性，不污染成功性能 P95。
- [ ] 从现有 `metrics` 提取 TTFT、吞吐、input/output tokens。
- [ ] 从 `labels` 和 `Comparison` 提取协议及质量扣分。
- [ ] 维度函数输出 `score`、`status`、`reasons`，不直接修改旧报告评分。

**Verification:**

```bash
cd backend
python -m pytest tests/test_api.py -k "health_profile or performance" -q
```

### Task 4：接入 Gold/official cloud 参考带

**Files:**
- Modify: `backend/app/routers/channels.py`
- Modify: `backend/app/schemas.py`
- Modify: `backend/tests/test_api.py`

- [ ] 按相同 suite、test case、模型和请求参数聚合 Gold 与 official cloud 基线。
- [ ] 计算延迟、TTFT、Gold similarity、official cloud similarity 的上下界和偏移比例。
- [ ] 基线无效、过期或样本不足时返回 `baseline_unhealthy` / `baseline_inconclusive`，不直接惩罚候选真实性。
- [ ] 增加“候选运行健康”和“来源一致性”分离断言。

**Verification:**

```bash
cd backend
python -m pytest tests/test_api.py -k "baseline or reference_band or health_profile" -q
```

### Task 5：实现状态原因、贡献度和恢复防抖

**Files:**
- Modify: `backend/app/routers/channels.py`
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/models.py`
- Modify: `backend/tests/test_api.py`

- [ ] 返回最多 5 条 `status_reasons`，每条包含维度、触发值、阈值、影响说明和关联标签。
- [ ] 普通异常连续两个窗口才降级；严重协议异常或连续失败立即升级。
- [ ] 增加恢复判定和 `resolved` 证据，不改变现有告警兼容字段。
- [ ] 为同渠道、同标签、同探针提供稳定的去重键。

**Verification:**

```bash
cd backend
python -m pytest tests/test_api.py -k "alert or recovery or health_profile" -q
```

### Task 6：补充配置变更时间线和查询性能

**Files:**
- Modify: `backend/app/routers/channels.py`
- Modify: `backend/app/audit.py`
- Modify: `backend/app/database.py`
- Create: `backend/alembic/versions/20260722_channel_health_indexes.py`
- Modify: `backend/tests/test_api.py`

- [ ] 从 `AuditLog` 提取渠道配置变更时间，返回 `latest_config_change_at`。
- [ ] 对 `results(channel_id, created_at)`、`channel_alerts(channel_id, created_at)` 增加复合索引。
- [ ] 查询只加载时间窗内结果，保留最近失败按需下钻。
- [ ] 不在本期引入快照表；只有性能测试证明聚合超时才进入下一阶段。

**Verification:**

```bash
cd backend
python -m pytest tests/test_api.py -k "audit or health_profile" -q
```

### Task 7：升级健康画像前端

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/pages/Channels.tsx`
- Create: `frontend/src/channelHealthProfile.ts`
- Create: `frontend/src/channelHealthProfile.test.ts`

- [ ] 顶部摘要改为：状态、置信度、成功率、成功请求 P95、最近失败/过期时间。
- [ ] 增加“运行健康 / 来源一致性 / 能力质量”三块维度卡片。
- [ ] 趋势图增加成功率、失败率、P95/TTFT 和参考带；无参考带时明确显示“参考不足”。
- [ ] 异常标签 Top 增加次数、最近出现时间和影响维度。
- [ ] 增加“状态原因”列表，可跳转到 run/report/result。
- [ ] 样本不足文案必须明确“不会输出风险结论”。
- [ ] 将状态标签、维度颜色和文案映射收敛到 `channelHealthProfile.ts`，避免页面内重复条件分支。

**Verification:**

```bash
cd frontend
npm test -- --run
npm run build
```

### Task 8：补齐文档、回归和发布检查

**Files:**
- Modify: `README.md`
- Modify: `docs/current-architecture.md`
- Modify: `frontend/src/api.test.ts`
- Modify: `backend/tests/test_api.py`

- [ ] README 增加健康画像字段、状态语义和“不是绝对真实性结论”的说明。
- [ ] 更新架构文档中的健康接口和数据链路。
- [ ] 增加 API 契约测试，确保旧字段和新字段同时存在。
- [ ] 增加 mock 模式稳定性测试，禁止凭证进入响应、日志、报告或截图。
- [ ] 运行后端全量测试、前端全量测试和生产构建。
- [ ] 检查 SQLite 与 PostgreSQL 的索引迁移兼容性。

**Verification:**

```bash
cd backend
python -m pytest -q
cd ../frontend
npm test -- --run
npm run build
```

## 8. 完成记录

每完成一条开发队列任务，在这里追加一行；不要把已完成任务放回开发队列。

| 日期 | 任务 | 变更文件 | 聚焦测试 | 回归测试 | 结果 |
|---|---|---|---|---|---|

## 9. 运行与发布门禁

### 后端门禁

- `python -m pytest -q` 必须通过。
- SQLite 默认启动和 mock 模式必须可用。
- API key、auth header、secret_ref 解析结果不得进入报告、日志、截图和健康画像。
- 健康接口的 P95、状态、置信度必须能由测试夹具重现。

### 前端门禁

- `npm test -- --run` 必须通过。
- `npm run build` 必须通过。
- 小屏幕下三层健康维度仍可读，不使用装饰性嵌套卡片堆叠。
- 空数据、过期数据、基线不足、异常标签为空均有明确状态。

### 兼容性门禁

- `/api/channels/{id}/health-profile` 路径不变。
- 旧字段不删除，新增字段允许旧客户端忽略。
- `/api/runs` 和 `/api/eval-runs` 不受影响。
- 不改动基础真实性评分和报告等级的既有计算，健康画像只消费其结果。

## 10. 后续阶段（本期完成后再评估）

以下内容不进入本期开发队列，避免过早扩大范围：

- 小时/日级 `channel_health_snapshots` 预聚合表。
- Prometheus `/metrics` 和 OpenTelemetry 导出。
- 多实例 worker 直接 claim job 的完整队列化调度。
- Webhook、Slack、企业微信等多通知通道。
- 基于 MAD/IQR 或变点检测的自动漂移算法。
- 团队、环境、RBAC 和多租户隔离。
