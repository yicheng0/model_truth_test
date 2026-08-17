# 无品牌 JSON 身份填空探针 Plan

## 架构概览

本次在现有自动巡检真实请求链路中增加一条固定执行、独立保存的 `identity_blind_json` 探针。它与现有 `identity_self_report` 并列，不进入可选参数探针集合，也不参与 Claude/AWS 参数形态的完整性计数。

整体数据流分为六段：

1. 自动巡检解析固定探针列表，始终先执行开放式身份探针，再执行无品牌 JSON 身份探针，最后执行计划选择的参数探针。
2. JSON 探针在发送前使用与真实调用相同的请求构造结果，扫描模型可见的 user、system 和 tool 文本；命中受监控品牌时停止发送并生成“请求污染”无效证据。
3. 上游响应先经过现有协议归一化，再由专用分析器提取 JSON、检查三字段结构、区分运营失败、拒答、格式偏差、身份待确认和品牌泄漏。
4. 分析结果与 Message ID、Request ID、HTTP 状态、脱敏原始响应一起进入现有 Result 和巡检报告 evidence，不新增数据库字段。
5. 站内分类、异常汇总和运行记录页面读取该独立证据；Kiro 泄漏继续进入现有 Kiro 异常组，且记录实际命中的探针阶段。
6. 飞书小时通知继续使用现有 Signature-only 条件，新探针标签不加入飞书白名单。

关键证据边界是：无品牌 JSON 探针主动泄漏 Kiro 或其他明确非预期身份，属于隐藏身份/路由异常证据；单条探针本身不直接证明底层模型已被替换。运营失败、请求污染、拒答和无效 JSON 均不产生身份泄漏结论。

## 核心数据结构

### BlindIdentityProbeConfig

- `key`: 固定为 `identity_blind_json`。
- `title`: 页面和报告使用的“无品牌 JSON 身份填空”。
- `prompt`: 只包含 JSON 输出约束和 `vendor`、`product`、`model` 字段，不包含任何厂商、产品或模型品牌名。
- `request_params`: 仅设置输出长度上限，不增加 temperature、thinking、tools 或重复采样。
- `scoring_rules`: 使用独立的 JSON 身份探针规则标志，不复用开放式身份评分。

### BlindIdentityRequestAudit

- `prompt_brand_hits`: 请求可见文本命中的受监控品牌词，正常情况为空数组。
- `visible_text_scanned`: 标记已扫描 user、system 和 tool 可见文本。
- `contaminated`: 是否存在品牌污染。
- `request_sent`: 污染时为 `false`，正常通过审计后为 `true`。

扫描范围来自与真实调用相同的 raw request 构造结果，包括 `system`、`messages[*].content`、工具名称/描述/schema 中的文本，以及请求参数中最终会成为可见内容的 system/message/tool 数据。协议层 `model` 路由字段、endpoint、headers 和内部元数据不作为提示文本扫描对象。

受监控品牌词采用集中、大小写不敏感的边界匹配，至少覆盖 Kiro、Claude、Anthropic、OpenAI、ChatGPT、GPT、Gemini、Qwen 和 DeepSeek。`vendor`、`product`、`model` 只是字段名，不属于品牌污染。

### BlindIdentityJsonAnalysis

- `identity_json_status`: `clean`、`uncertain`、`refused`、`format_error`、`contaminated`、`brand_leak` 或 `operational`。
- `identity_json_format`: `plain`、`fenced`、`extra_text`、`invalid` 或 `none`。
- `identity_json_fields`: 只保存 `vendor`、`product`、`model` 三个字符串值。
- `json_extracted`: 是否提取到满足结构要求的 JSON 对象。
- `extra_text_present`: 合法对象之外是否仍有非空解释文字。
- `prompt_brand_hits`: 请求审计命中的品牌词。
- `response_brand_hits`: 仅从三个合法 JSON 字段中命中的品牌词。
- `labels`: 本次探针产生的稳定标签。

身份状态和输出格式分成两个维度。例如“合法 Kiro JSON 后附解释”仍是 `brand_leak`，同时 `identity_json_format=extra_text` 并带格式偏差标签；解释文字不能覆盖已从合法对象取得的泄漏证据。

### PatrolModelRequestEvidence 扩展

现有 model request evidence 增加上述 JSON 分析字段，并继续保留：

- 探针 key、标题、执行状态和标签。
- Result ID、Message ID、Request ID、协议、endpoint、HTTP 状态和时间。
- 脱敏后的响应正文与原始响应。
- 渠道 ID、名称、provider type 和 account type。

这些字段全部放入现有 JSON evidence/normalized response，不增加表、列或迁移。

## 核心接口

### `audit_blind_identity_request(raw_request) -> BlindIdentityRequestAudit`

递归提取 raw request 中真正对模型可见的 system、user message 和 tool 文本，并执行集中品牌扫描。发送前命中品牌时返回污染结果，调用方不发起上游请求；发送后再次对归一化结果中的 raw request 审计，防止请求构造与实际发送形态漂移。

污染证据只产生 `identity_probe_contaminated`，状态为 `contaminated`，不产生 `hidden_brand_leak`、`identity_mismatch`、`kiro_identity_leak` 或 `suspected_model_swap`。

### `extract_blind_identity_json(text) -> extraction result`

使用标准 JSON 解码器执行确定性提取：

1. 去除响应首尾空白后，先尝试把完整响应解析为 JSON。
2. 若失败，使用 `JSONDecoder.raw_decode` 解析响应开头的第一个完整对象，并记录对象后的非空文字。
3. 若响应不是对象开头，再允许从唯一一个 Markdown fenced code block 中解析完整 JSON；存在多个代码块或代码块外有非空正文时按格式偏差/格式错误记录。
4. 只接受 JSON object，且 key 必须恰好为 `vendor`、`product`、`model`，三个值都必须是字符串。
5. 缺字段、多字段、非字符串值、数组或完全不可解析响应均返回格式错误；不读取额外字段推断身份。

### `analyze_blind_identity_json_probe(normalized, request_audit) -> BlindIdentityJsonAnalysis`

分析顺序固定为：

1. 请求污染优先，直接返回无效证据。
2. HTTP、超时、权限、额度和资源不可用等错误复用 `operational_failure_label`，返回运营状态。
3. 无合法 JSON 时识别纯拒答；拒答与一般格式错误分开记录，但都不生成身份泄漏。
4. 合法 JSON 中 Kiro 命中时返回 `hidden_brand_leak`、`kiro_identity_leak`，不自动添加 `suspected_model_swap`。
5. 合法 JSON 中其他明确非 Claude/Anthropic 品牌命中时返回 `hidden_brand_leak`、`identity_mismatch`。
6. 合法 JSON 中只有 Claude/Anthropic 时返回正常；全空或明确无法确认时返回待确认。
7. 对象后的解释文字只产生格式偏差，不参与品牌识别或身份补全。

### `score_result` 专用分支

新增 `scheduled_blind_identity_json_probe` 分支，调用统一分析结果生成分数和标签：

- Kiro 泄漏为高风险身份异常。
- 其他明确品牌泄漏为身份不一致。
- 正常 JSON 保持通过。
- 空字段、无法确认、拒答和格式偏差保留可复核标签，但不升级为品牌泄漏。
- 运营失败和请求污染不参与真伪判断。

评分与 evidence 序列化必须复用同一个分析器，避免报告状态与 Result 标签不一致。

### 巡检分类与异常摘要

`scheduled_probe_classification` 在发现身份异常标签时检查实际命中的探针 key：

- `identity_self_report`：文案说明为直接身份自报异常。
- `identity_blind_json`：文案说明为无品牌结构化探针主动泄漏。

Kiro 仍归入现有 `kiro_identity_leak` 异常组，但结论统一表述为“疑似 Kiro 路由或隐藏人格注入”，不把单探针写成确定模型替换。异常条目的 `stage` 和 Request ID 从实际命中 Kiro 的 model request evidence 提取。

## 模块设计

### 探针注册与执行

**职责：** 注册固定 JSON 探针、保证全新对话、执行发送前污染审计、完成一次请求并保存独立 Result。

**对外接口：** `scheduled_execution_probes` 固定返回 `identity_self_report`、`identity_blind_json`，再按计划附加可选参数探针。`SCHEDULED_MODEL_REQUEST_PROBE_KEYS` 与 `EXPECTED_SCHEDULED_PROBE_KEYS` 保持不变。

**依赖：** 现有 `build_raw_request`、`invoke_channel`、Result 持久化和凭据脱敏逻辑。

每条探针继续创建独立 TestCase，JSON 探针明确使用 `system_prompt=None`、单条 user message 和 `repeat_count=1`。污染审计未通过时不调用 provider，并保存可观察的无效证据。

### JSON 提取、评分与 Mock

**职责：** 提供无副作用的请求品牌扫描、JSON 提取、身份分类和标签生成。

**对外接口：** 分析器供 `score_result`、执行结果组装和单元测试共同使用。

**依赖：** 标准库 `json`/`re` 和现有运营失败分类。

Mock 使用确定性响应，不依赖随机文本。新探针在 mock 调用边界支持稳定的正常响应；Kiro、拒答、格式错误和运营失败通过固定 channel/test fixture 或调用替身覆盖。该支持只服务新探针及其测试，不改变 Signature、参数探针或普通评测的 mock/live 语义。

### 报告、分类和标签解释

**职责：** 把分析字段序列化进 `model_requests`，聚合风险标签，生成区分两种身份探针的分类理由和 Markdown 证据。

**对外接口：** 复用现有报告 evidence 结构；新增标签解释包括 `hidden_brand_leak`、`identity_json_extra_text`、`identity_json_refused`、`identity_json_invalid`、`identity_probe_contaminated`。现有 `identity_uncertain`、`kiro_identity_leak` 和 `identity_mismatch` 继续复用。

**依赖：** `build_scheduled_probe_report`、`scheduled_probe_classification`、`label_explanations` 和现有脱敏函数。

`hidden_brand_leak` 本身不加入 `ALERT_RED_FLAGS`：Kiro 已由 `kiro_identity_leak` 覆盖，其他品牌已由 `identity_mismatch` 覆盖，避免重复提升严重度。

### 站内异常汇总

**职责：** 让 JSON 探针的 Kiro 标签进入现有站内 Kiro 异常组，并从实际命中项提取 Request ID 和 stage。

**对外接口：** 不改变 `/api/runs/patrol/anomalies` schema，不新增异常组。

**依赖：** 报告 evidence 中的 `model_requests` 和聚合 labels。

### 前端证据展示

**职责：** 归一化 JSON 分析字段，并在自动巡检展开详情中展示解析状态、三字段值、格式状态及既有上游标识和原始响应。

**对外接口：** 扩展前端内部 `PatrolModelRequestEvidence`；不改变公共 API 请求方式。

**依赖：** 现有 `extractPatrolEvidence`、`normalizeModelRequest`、Ant Design 表格与标签组件。

普通探针在新增“JSON 解析”列显示 `-`；JSON 探针用紧凑文本展示 `vendor/product/model`，空值明确显示为空，不从响应解释文字补值。

### 飞书隔离

**职责：** 通过回归测试证明新身份标签不会触发飞书小时 Webhook。

**对外接口：** 不修改现有 Signature-only 飞书白名单和消息格式。

**依赖：** 现有小时汇总筛选和发送函数。

## 模块交互

```text
scheduled test
  -> scheduled_execution_probes
  -> identity_self_report
  -> identity_blind_json
       -> build_raw_request
       -> visible prompt brand audit
          -> contaminated: persist invalid evidence, do not send
          -> clean: invoke provider once
       -> normalized response
       -> JSON extraction + identity analysis
       -> Result labels + structured analysis
  -> selected parameter probes
  -> model request evidence aggregation
  -> scheduled probe classification
  -> report + site anomaly summary + Runs detail

hourly Feishu task
  -> existing explicit Signature rejection filter
  -> blind identity labels ignored
```

依赖方向保持单向：执行层依赖纯分析器，报告层只消费执行证据，前端只消费报告 evidence；前端和异常汇总不反向参与评分。

## 文件组织

```text
backend/app/services.py
  # 探针配置、发送前审计、JSON 分析、评分、执行结果与 evidence 序列化、标签解释、Mock 响应
backend/app/scheduled_probe.py
  # 探针状态文案、身份异常分类理由和 Markdown 报告区分
backend/app/main.py
  # Kiro 站内异常的实际探针 stage 与 Request ID 提取
backend/tests/test_api.py
  # 请求无品牌、解析/标签、运营边界、报告、异常汇总、Mock 与飞书隔离测试
frontend/src/runsUtils.ts
  # JSON 分析字段类型和 evidence 归一化
frontend/src/runsUtils.test.ts
  # 新字段、状态和空值归一化测试
frontend/src/pages/Runs.tsx
  # 独立 JSON 探针解析结果展示
frontend/e2e/runs-pagination.mjs
  # 自动巡检展开详情中的 JSON 探针可见性与字段展示断言
docs/superpowers/specs/2026-08-17-blind-json-identity-probe/plan.md
  # 本技术设计
```

不修改 `backend/app/models.py`、`backend/app/schemas.py`、数据库迁移或 `frontend/src/types.ts`。新增数据均复用现有 JSON evidence 与 Result 响应结构。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 探针位置 | 固定身份探针，与可选参数探针分离 | 每轮必跑一次，又不破坏 Claude/AWS 参数探针完整性判断 |
| 会话隔离 | 独立 TestCase、无 system、单条 user message | 避免历史上下文和用户侧 system 污染证据 |
| 污染检查 | 发送前扫描同一 raw request 构造结果，发送后复核 | 既阻止已知污染请求，又能发现实际请求形态漂移 |
| 扫描范围 | 只扫描模型可见文本，不扫描路由 model 字段 | model 参数可能天然带品牌名，但不属于用户提示复述来源 |
| JSON 提取 | 完整响应、开头 raw decode、唯一 fenced block | 覆盖 K2 类“JSON + 解释”，同时保持确定性和窄接受面 |
| 对象结构 | key 恰好为三个指定字段且值均为字符串 | 防止从额外字段或非结构化内容猜测身份 |
| 格式与身份 | 两个独立维度 | “品牌泄漏 + 额外文字”不能因单一状态互相覆盖 |
| 品牌识别来源 | 只读取合法 JSON 三字段 | 遵守证据边界，不从解释文字、错误正文或额外字段猜测 |
| Kiro 结论 | 高风险路由/隐藏人格注入证据，不自动加模型替换标签 | 单探针足以说明异常，但不足以证明底层模型必然替换 |
| 运营错误 | 复用现有运营失败分类且优先处理 | 超时、额度、权限和资源不可用不是身份异常 |
| 数据持久化 | 扩展现有 evidence JSON，不迁移数据库 | 满足展示和追溯，降低兼容风险 |
| 飞书通知 | 保持 Signature-only，不增加身份标签 | 符合当前告警范围，避免恢复其他即时噪声 |
| 测试策略 | 纯分析单测 + 巡检集成 + 前端归一化 + 页面交互 | 同时验证证据规则、执行链路和用户可见结果 |

## 需求覆盖矩阵

| 需求 | 负责组件与验证重点 |
|---|---|
| F1、N3 | 固定探针注册与执行；每轮恰好新增一次独立请求，无 system、无历史 |
| F2、N5 | JSON 提取器与双维度状态；三字段严格结构、开头 JSON、唯一代码块和额外文字 |
| F3 | 请求审计器；发送前污染拦截、发送后复核、污染结果不生成身份异常 |
| F4 | JSON 分析与评分；Kiro 产生 `hidden_brand_leak`、`kiro_identity_leak`，不自动产生模型替换标签 |
| F5 | 其他品牌分类；产生 `hidden_brand_leak`、`identity_mismatch`，不产生 Kiro 标签 |
| F6 | 正常、待确认、拒答、格式错误和额外文字状态；解释文字不覆盖合法 JSON 泄漏 |
| F7 | 运营失败优先级；HTTP、超时、权限、额度和资源不可用不产生身份泄漏 |
| F8、N1 | Result/evidence 序列化、脱敏和 Runs 详情；保留字段、标签、IDs、HTTP、时间与安全原始响应 |
| F9 | 站内分类与异常汇总；飞书 Signature-only 回归测试 |
| F10 | 两条身份探针独立 key、Result、报告文案和前端行 |
| N2 | 新探针确定性 Mock 正常结果及 Kiro、拒答、格式错误、运营失败固定测试场景 |
| N4 | Signature、thinking、Web Search、参数探针和普通执行回归测试 |
| AC1 | 检查持久化 raw request 与发送前审计结果 |
| AC2、AC3、AC4、AC5 | 分析器参数化测试与 `score_result`/报告集成测试 |
| AC6 | 报告 evidence 和 Runs 展开详情测试 |
| AC7 | 站内异常 API 测试与飞书 Webhook 零调用测试 |
| AC8 | Mock 巡检、后端完整 pytest、前端完整测试、生产 build 和页面交互测试 |
