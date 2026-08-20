# Fable 5 渠道检测点模式 Plan

## 架构概览

在现有 `/api/runs` 测试集执行链上增加一个 `detection_points` 测试范围。该范围复用当前的 `TestSuite`、`TestCase`、`Run`、`Result` 和 `Report.evidence` 存储，不新增数据库表或迁移。

数据流：

```text
检测点模式配置
  -> 选择 detection_points 题目
  -> gold / official_cloud / candidate / negative 重复采样
  -> 复用 invoke_channel + score_result
  -> 检测点聚合器
       ├─ Fable 5 行为证据
       ├─ Kiro / Bedrock 线索
       ├─ Claude Code 客户端可能性
       ├─ Anthropic 来源与控制面证据
       └─ 运营故障 / 不可判定分离
  -> Report.evidence.detection_points
  -> 独立身份字段和前端检测点表
```

现有 `quick` 和 `full` 范围保持原语义。`detection_points` 是面向渠道筛查的新范围，不替换完整评估；用户可以先运行检测点模式，再对同一渠道运行完整模式复核。

## 核心数据结构

### DetectionPointDefinition

由后端常量注册表维护，不落库：

- `key`：稳定检测点键，例如 `fable5_behavior`、`kiro_bedrock`、`claude_code_client`、`anthropic_origin`、`calibration`。
- `title`：前端展示名称。
- `case_ids`：关联的题目 ID。
- `evidence_tier`：`control_plane`、`cryptographic_continuity`、`protocol`、`behavior`。
- `status_policy`：通过、异常、警告、不可观测、运营故障和不适用的归并规则。
- `official_doc_refs`：官方文档 URL 和抓取日期标识。
- `time_sensitive`：是否需要在报告中显示资料时效提示。

### TestCase detection metadata

继续存放在现有 `scoring_rules` JSON 中，避免数据库迁移。新增约定字段：

- `detection_point`：所属检测点键。
- `detection_point_mode`：是否进入 `detection_points` 范围。
- `evidence_tier`：该题目的证据层级。
- `positive_control`：是否为官方或官方云正向控制题。
- `negative_control`：是否为非 Claude/协议改写负向控制题。
- `tamper_control`：是否为字段篡改、错误改写或 SSE 重建对照题。
- `expected_error_category`：例如 `reasoning_extraction`、`thinking_disabled`、`invalid_sampling_parameter`。
- `official_doc_refs`：题目对应的官方资料链接。
- `calibration_only`：是否只进入能力、安全、知识和上下文校准，不参与来源结论。

### DetectionPointResult

写入 `Report.evidence.detection_points.items[]`，并通过现有报告接口返回：

- `key`、`title`、`status`、`conclusion`、`caveat`。
- `sample_count`、`pass_count`、`warning_count`、`fail_count`、`skipped_count`。
- `evidence_tier`、`evidence_refs`、`labels`。
- `observed_summary`：只含脱敏后的字段摘要、HTTP 状态、协议族、模型名、request-id 摘要和错误类别。
- `official_doc_refs`、`source_checked_at`、`time_sensitive`。
- `not_comparable_reason`：模型、协议、能力或控制面不满足比较条件时填写。

不在该结构中保存 API Key、Authorization、Cookie、OAuth token、完整认证头或未脱敏原始请求。

### IndependentIdentityAssessment

写入 `Report.evidence.identity_assessment`，四个字段独立计算：

- `model_identity`：`fable5_consistent`、`claude_like`、`model_mismatch_suspected`、`inconclusive`。
- `client_likelihood`：`claude_code_like`、`api_direct_like`、`mixed_or_relay`、`unobservable`。
- `access_path`：`anthropic_endpoint_configured`、`official_cloud_reference`、`claude_code_gateway_like`、`translated_gateway`、`transparent_unresolved`。
- `resource_identity`：`anthropic_api_key_configured`、`cloud_provider_credentials`、`gateway_credential_configured`、`insufficient_evidence`。
- `origin_verified`：默认 `false`；只有控制面闭环满足时才为 `true`。
- `reason`、`limitations`、`evidence_refs`。

### ControlPlaneEvidence

仅允许非秘密证据引用：

- `endpoint_host`、`request_id`、`observed_at`。
- `account_or_workspace_ref` 的脱敏引用，不保存账号密钥。
- `billing_or_audit_ref` 的外部记录编号。
- `verified_by` 和 `verified_at`。

没有这类关联记录时，官方 API 检测点只能返回 `configured_not_verified` 或 `transparent_unresolved`。

## 核心接口

### `cases_for_scope(db, suite_id, test_scope)`

扩展现有范围选择逻辑：

- `quick`：保持原有 `quick=true` 题目。
- `full`：返回所有启用题目。
- `detection_points`：返回 `scoring_rules.detection_point_mode=true` 的题目，并按检测点注册表顺序、题目 `sort_order` 和 ID 稳定排序。
- `scheduled_probe`：保持现有定时探针逻辑，不与新范围混用。

检测点模式创建运行时要求 `repeat_count >= 3`；默认值为 3，最大仍受现有上限约束。

### `build_detection_point_assessment(results, cases, channel, control_plane_evidence=None)`

纯聚合接口，不发起网络请求：

1. 按 `detection_point` 聚合当前运行结果。
2. 统计重复采样和每种状态。
3. 对 Fable 5 正向、负向和篡改对照执行独立条件检查。
4. 把 Kiro 泄漏、模型目录矛盾、Bedrock 线索、协议重建和运营失败分开。
5. 调用现有 `_claude_client_fingerprint_assessment`、`_claude_code_access_path_assessment` 和 `_claude_resource_identity_assessment`，但不把主动探针当作真实客户端来源证据。
6. 生成 `identity_assessment` 和 `detection_points`，并保留 `origin_verified=false` 的边界。

### `run_detection_point_endpoint_probes(channel, credentials)`

只对支持的协议执行低成本端点观察：

- Anthropic Messages 入口：`HEAD /api/hello`、可选 `GET /v1/models?limit=1000`、可选 `POST /v1/messages/count_tokens`。
- Kiro/Bedrock 线索：记录响应中可观察的模型目录、错误族、区域/提供商字段；不猜测账户来源。
- 非 Anthropic 或不支持的协议：返回 `not_applicable`，不计为模型异常。

该接口只保存端点类型、状态、模型列表摘要、错误类别和脱敏 request-id；不能把端点探测 200 解释成官方直连。

### `build_detection_point_report_evidence(...)`

在现有 `build_reports` 完成比较分数和普通标签后追加：

- `detection_mode: "detection_points"`。
- `detection_points` 聚合结果。
- `identity_assessment`。
- `control_plane_evidence` 的脱敏引用。
- `suite_version`、`case_version`、`source_checked_at`。

完整模式和旧报告没有检测点证据时，不生成虚假的检测点结论。

## 模块设计

### 检测点注册表与题库元数据

**文件：** `backend/app/detection_points.py`、`backend/app/suite_seed.py`

**职责：** 定义检测点顺序、官方资料引用、题目归属和正向/负向/篡改控制关系；将现有协议、身份、工具、thinking、上下文、安全和能力题重新映射。

**主要检测点：**

1. `fable5_behavior`
   - Fable 5 模型可用性/模型字段。
   - adaptive thinking 默认行为。
   - `thinking.type=disabled` 原生拒绝。
   - 非默认 `temperature/top_p/top_k` 原生拒绝。
   - reasoning extraction 拒答类别。
   - thinking signature、`signature_delta` 和 SSE 生命周期。
   - 正向官方控制、负向非 Claude 控制和篡改错误对照必须成组存在。
2. `kiro_bedrock`
   - Kiro/Bedrock 模型目录差分。
   - 无 system prompt 的盲身份 JSON 题。
   - Kiro persona 泄漏单独标记 `kiro_identity_leak`。
   - Fable 5 与当前 Kiro 公开目录矛盾标记 `kiro_model_catalog_contradiction`，附资料日期。
   - Bedrock 风格差异只作为辅助证据。
3. `claude_code_client`
   - `/v1/messages`、`count_tokens`、`/v1/models` 和 SSE 兼容性。
   - `x-claude-code-session-id`、agent headers、attribution block 和请求序列。
   - 没有真实入站捕获时固定为 `unobservable`；主动添加 header 的检测器不产生客户端身份结论。
4. `anthropic_origin`
   - 目标 host 与协议配置。
   - Anthropic `request-id`、Console usage/billing、组织或云审计关联。
   - 没有控制面闭环时只显示 `configured_not_verified` 或 `transparent_unresolved`。
5. `calibration`
   - 现有能力、代码、长上下文、知识、安全和多轮题。
   - 只校准模型行为和稳定性，不改变官方来源字段。

### 执行与评分服务

**文件：** `backend/app/services.py`、`backend/app/schemas.py`

**职责：** 支持新范围、运行低成本端点探针、聚合检测点并维持现有评分兼容。

**设计约束：**

- 不改变现有 A-E 分数权重；检测点异常通过稳定 labels 和 `identity_assessment` 体现。
- `signature_interop_failed` 仅在明确的 Signature 拒绝或缺失且满足可比较条件时产生。
- 认证、限流、超时、配额、无可用账户和服务不可用保持 `operationally_inconclusive` 或现有运营标签。
- Fable 5 正向行为通过不自动提高官方来源分数；Fable 行为与来源验证独立。

### 报告 API 与序列化

**文件：** `backend/app/schemas.py`、`backend/app/routers/reports.py`、`backend/app/services.py`

**职责：** 让检测点证据和四类身份字段通过现有报告详情、列表和 Markdown 报告返回；复用已有敏感字段序列化器。

### 运行配置与题目管理前端

**文件：** `frontend/src/types.ts`、`frontend/src/pages/CreateRun.tsx`、`frontend/src/pages/TestCases.tsx`

**职责：** 增加 `detection_points` 范围选项，显示检测点题目归属、证据层级、正向/负向/篡改控制和官方资料日期；保留 quick/full 选项。

### 运行结果与报告前端

**文件：** `frontend/src/pages/RunDetail.tsx`、`frontend/src/pages/ReportsPage.tsx`、`frontend/src/pages/ReportDetailPage.tsx`、`frontend/src/lightweightDetection.ts`、`frontend/src/claudeFingerprintSpec.ts`

**职责：** 展示检测点状态表、四类独立身份字段、重复采样计数、不可判定原因和官方文档链接；明确“Fable 5 行为一致”不等于“官方 API 直连”。

### 测试

**文件：** `backend/tests/test_api.py`、新增 `backend/tests/test_detection_points.py`、`frontend/src/lightweightDetection.test.ts`、`frontend/src/pages/runDetailUtils.test.ts`、新增 `frontend/src/detectionPointUtils.test.ts`

**职责：** 验证范围筛选、正负/篡改控制聚合、Kiro 泄漏与运营故障分离、客户端不可观测边界、来源未验证边界和前端渲染。

## 模块交互

1. 用户在创建运行页面选择 `detection_points`，后端校验重复次数并生成运行计划。
2. 题库选择器按注册表顺序选出 Fable、Kiro、Claude Code、来源和校准题。
3. 执行器对每个渠道运行三次；官方 gold、official_cloud 和 negative 角色作为可选对照，不改变候选渠道角色。
4. 每次响应经过现有归一化和 `score_result`，保留结构化字段、错误类别、标签和脱敏证据。
5. 检测点聚合器按题目元数据汇总状态；重复采样不稳定时标记 `mixed_routing_suspected` 或 `evidence_insufficient`，而不是强行判假。
6. 端点观察和渠道配置形成访问路径证据；主动探针没有真实入站请求时，客户端字段保持 `unobservable`。
7. 若存在受信任的脱敏控制面引用，再把 endpoint/request-id/账单或审计记录关联到官方来源字段；否则 `origin_verified=false`。
8. 报告同时保留原有分数、等级、标签和 Markdown，并追加检测点表和独立身份摘要。

## 文件组织

```text
backend/app/
├── detection_points.py          # 检测点定义、题目分组、官方资料引用
├── suite_seed.py                # 现有题目重映射及新增安全边界题
├── schemas.py                   # detection_points 范围与报告证据结构
├── services.py                  # 范围选择、端点探针、聚合与报告注入
└── routers/reports.py           # 复用现有报告接口，必要时补充过滤字段

backend/tests/
├── test_detection_points.py     # 聚合、边界和故障分类
└── test_api.py                  # /api/runs、报告详情和 mock 回归

frontend/src/
├── types.ts                     # DetectionPoint / IdentityAssessment 类型
├── detectionPointUtils.ts       # 状态、标签和摘要纯函数
├── pages/CreateRun.tsx           # 新增检测点模式选择
├── pages/TestCases.tsx           # 检测点元数据和资料引用展示
├── pages/RunDetail.tsx           # 运行中/运行后检测点表
├── pages/ReportDetailPage.tsx    # 报告检测点和来源边界
├── pages/ReportsPage.tsx         # 列表摘要和筛选
└── lightweightDetection.ts       # 轻量结果映射到检测点状态

docs/superpowers/specs/2026-08-20-detection-point-mode/
├── spec.md
├── plan.md
├── task.md
└── checklist.md
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 新模式位置 | 复用 `/api/runs` 的 `test_scope=detection_points` | 保留统一运行、报告、mock、历史和权限路径，避免另起一套检测系统 |
| 检测点元数据 | 放入 `scoring_rules`，由注册表解释 | 现有题库已支持 JSON 评分规则，无需数据库迁移；注册表保证展示和聚合顺序稳定 |
| Fable 5 证据 | 正向 + 负向 + 篡改对照 | 防止单个拒绝文案或错误包裹被伪造后直接判定来源 |
| Kiro 判断 | 目录差分、盲身份和 Bedrock 线索分离 | Kiro 可能调用真实 Claude，不能把 Kiro 线索等同于非 Claude |
| Claude Code 判断 | 被动入站指纹优先；主动探针无来源结论 | 官方协议公开且可仿造，主动发送 header 没有识别力 |
| 官 API 判断 | 控制面闭环优先，响应兼容仅作低层证据 | `msg_`、SSE、signature 和 request-id 都可能被透明中转保留 |
| 运营失败 | 单独的不可判定状态 | 避免把超时、配额和服务不可用误记为 Signature/换模异常 |
| 评分兼容 | 保持现有 A-E 和维度分数，新增独立证据字段 | 用户需要新检测重点，但历史分数和既有报告必须可比较 |
| 敏感信息 | 只保存脱敏结构化摘要和外部证据引用 | 满足 API Key/runtime-only 约束，避免控制面证据变成凭据存储 |
| 时间敏感资料 | 记录官方文档 URL、抓取日期和目录版本 | Kiro/Fable 模型目录会变化，避免旧结论被误读为永久规则 |
