# 无品牌 JSON 身份填空探针 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 新建 | `docs/superpowers/specs/2026-08-17-blind-json-identity-probe/task.md` | 记录实现任务、依赖和验证方式 |
| 修改 | `backend/app/services.py` | 探针配置、请求审计、JSON 分析、评分、Mock、执行与 evidence |
| 修改 | `backend/app/scheduled_probe.py` | 状态文案、身份分类理由和 Markdown 报告 |
| 修改 | `backend/app/main.py` | 站内 Kiro 异常的实际探针定位 |
| 修改 | `backend/tests/test_api.py` | 后端规则、执行、报告、异常、Mock 和飞书隔离测试 |
| 修改 | `frontend/src/runsUtils.ts` | JSON 探针 evidence 类型和归一化 |
| 修改 | `frontend/src/runsUtils.test.ts` | JSON 探针归一化测试 |
| 修改 | `frontend/src/pages/Runs.tsx` | JSON 解析状态和字段展示 |
| 修改 | `frontend/e2e/runs-pagination.mjs` | 自动巡检详情页面断言 |

明确不修改 `backend/app/models.py`、`backend/app/schemas.py`、数据库迁移、`frontend/src/types.ts` 和飞书 Signature-only 白名单。保持当前无关改动 `docs/superpowers/specs/2026-08-12-patrol-delete-button-usability/checklist.md`、`frontend/src/channelFingerprintRemoval.test.ts` 不变。

## T1: 添加请求品牌扫描测试

**文件：** `backend/tests/test_api.py`

**依赖：** 无

**步骤：**

1. 添加 `test_blind_identity_json_request_audit_*` 测试组。
2. 覆盖 user、system、tool 可见文本及大小写差异。
3. 断言协议 model、endpoint、headers 和内部元数据不参与扫描。

**验证：** 在 `backend/` 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json_request_audit" -q`，期望因 `audit_blind_identity_request` 尚不存在而失败。

## T2: 实现 BlindIdentityRequestAudit

**文件：** `backend/app/services.py`

**依赖：** T1

**步骤：**

1. 定义集中受监控品牌规则，至少覆盖 Kiro、Claude、Anthropic、OpenAI、ChatGPT、GPT、Gemini、Qwen 和 DeepSeek。
2. 实现 `audit_blind_identity_request`，返回计划中的 `BlindIdentityRequestAudit` 字段：`prompt_brand_hits`、`visible_text_scanned`、`contaminated`、`request_sent`。
3. 只递归读取模型可见的 system、messages 和 tools 文本。

**验证：** 运行 T1 命令，期望请求审计测试全部通过。

## T3: 添加 JSON 提取器测试

**文件：** `backend/tests/test_api.py`

**依赖：** T2

**步骤：**

1. 添加 `test_blind_identity_json_extract_*` 参数化测试。
2. 覆盖完整 JSON、响应开头 JSON 加解释、唯一 fenced code block 和代码块外正文。
3. 覆盖多个代码块、缺字段、多字段、非字符串值、数组和非法 JSON。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json_extract" -q`，期望因 `extract_blind_identity_json` 尚不存在而失败。

## T4: 实现严格 JSON 提取器

**文件：** `backend/app/services.py`

**依赖：** T3

**步骤：**

1. 实现 `extract_blind_identity_json` 的完整响应解析。
2. 使用 `JSONDecoder.raw_decode` 支持响应开头对象，并记录对象外非空文字。
3. 支持唯一 fenced code block；严格要求对象恰好包含三个字符串字段。

**验证：** 运行 T3 命令，期望 JSON 提取测试全部通过。

## T5: 添加身份分析状态测试

**文件：** `backend/tests/test_api.py`

**依赖：** T4

**步骤：**

1. 添加 `test_blind_identity_json_analysis_*` 参数化测试。
2. 覆盖 Kiro、其他品牌、Claude/Anthropic、空字段、无法确认、拒答和格式错误。
3. 覆盖污染请求和运营失败的优先级。
4. 断言对象外解释文字和额外字段不参与身份匹配。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json_analysis" -q`，期望因 `analyze_blind_identity_json_probe` 尚不存在而失败。

## T6: 实现 BlindIdentityJsonAnalysis

**文件：** `backend/app/services.py`

**依赖：** T5

**步骤：**

1. 实现 `analyze_blind_identity_json_probe`，返回计划中的 `BlindIdentityJsonAnalysis` 全部字段。
2. 按污染、运营失败、拒答/格式、品牌命中、正常/待确认顺序分类。
3. Kiro 返回 `hidden_brand_leak`、`kiro_identity_leak`，不返回 `suspected_model_swap`。
4. 其他明确品牌返回 `hidden_brand_leak`、`identity_mismatch`。

**验证：** 运行 T5 命令，期望身份分析测试全部通过。

## T7: 添加探针配置和注册测试

**文件：** `backend/tests/test_api.py`

**依赖：** T6

**步骤：**

1. 添加 `test_blind_identity_json_registry_*` 测试。
2. 断言计划中的 `BlindIdentityProbeConfig` 对应常量 key 为 `identity_blind_json`，提示没有受监控品牌，参数只有输出长度上限。
3. 断言执行顺序为开放式身份探针、JSON 身份探针、所选参数探针。
4. 断言新探针不进入两个参数探针 key 集合。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json_registry" -q`，期望因探针尚未注册而失败。

## T8: 注册固定 JSON 身份探针

**文件：** `backend/app/services.py`

**依赖：** T7

**步骤：**

1. 新增 `SCHEDULED_BLIND_IDENTITY_JSON_PROBE`，实现 `BlindIdentityProbeConfig` 设计。
2. 修改 `scheduled_execution_probes`，固定追加新探针。
3. 保持 `SCHEDULED_MODEL_REQUEST_PROBE_KEYS` 和 `EXPECTED_SCHEDULED_PROBE_KEYS` 不变。

**验证：** 运行 T7 命令，期望探针配置和顺序测试全部通过。

## T9: 添加评分和标签解释测试

**文件：** `backend/tests/test_api.py`

**依赖：** T8

**步骤：**

1. 添加 `test_blind_identity_json_score_*` 测试。
2. 检查 Kiro、其他品牌、正常、待确认、拒答、格式错误、污染和运营失败的标签。
3. 检查新增标签均有专用解释，且 `hidden_brand_leak` 不在 `ALERT_RED_FLAGS`。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json_score or blind_identity_json_label_explanation" -q`，期望因评分分支尚未实现而失败。

## T10: 接入评分分支和标签解释

**文件：** `backend/app/services.py`

**依赖：** T9

**步骤：**

1. 在 `score_result` 增加 `scheduled_blind_identity_json_probe` 专用分支。
2. 复用 `analyze_blind_identity_json_probe` 生成标签。
3. 增加 `hidden_brand_leak`、`identity_json_extra_text`、`identity_json_refused`、`identity_json_invalid`、`identity_probe_contaminated` 的解释。

**验证：** 运行 T9 命令，期望评分和标签解释测试全部通过。

## T11: 添加确定性 Mock 测试

**文件：** `backend/tests/test_api.py`

**依赖：** T10

**步骤：**

1. 添加 `test_blind_identity_json_mock_*` 测试。
2. 对同一新探针重复调用 `invoke_channel(..., use_mock=True)`。
3. 断言返回合法三字段 JSON，分析状态稳定且不访问真实 provider。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json_mock" -q`，期望因 Mock 分支尚未支持新探针而失败。

## T12: 实现新探针 Mock 响应

**文件：** `backend/app/services.py`

**依赖：** T11

**步骤：**

1. 在 `_answer_for_case` 为新评分规则返回确定性正常 JSON。
2. 不改变普通任务、Signature 或参数探针的 Mock 响应。

**验证：** 运行 T11 命令，期望 Mock 测试全部通过。

## T13: 添加执行请求形态测试

**文件：** `backend/tests/test_api.py`

**依赖：** T12

**步骤：**

1. 添加 `test_blind_identity_json_execution_shape_*` 测试。
2. 捕获新探针 TestCase 和 raw request。
3. 断言 `system_prompt=None`、单条 user message、无历史消息、提示无品牌且每轮只执行一次。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json_execution_shape" -q`，期望因执行审计尚未接入而失败。

## T14: 接入发送前和发送后请求审计

**文件：** `backend/app/services.py`

**依赖：** T13

**步骤：**

1. 在 provider 调用前用 `build_raw_request` 构造请求并执行审计。
2. 正常调用后再次审计 normalized raw request。
3. 把审计结果附加到新探针执行 payload。

**验证：** 运行 T13 命令，期望执行请求形态测试全部通过。

## T15: 添加污染拦截测试

**文件：** `backend/tests/test_api.py`

**依赖：** T14

**步骤：**

1. 添加 `test_blind_identity_json_contamination_*` 测试。
2. 在实际模型可见请求文本中注入品牌。
3. 断言 provider 调用次数为 0，结果状态为 `contaminated`，且没有身份异常标签和伪造上游 ID。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json_contamination" -q`，期望因污染短路尚未实现而失败。

## T16: 实现污染请求短路结果

**文件：** `backend/app/services.py`

**依赖：** T15

**步骤：**

1. 污染时跳过 `invoke_channel`。
2. 构造可持久化的归一化无效结果，保留审计字段。
3. 保证不产生 `hidden_brand_leak`、`identity_mismatch`、`kiro_identity_leak` 或 `suspected_model_swap`。

**验证：** 运行 T15 命令，期望污染拦截测试全部通过。

## T17: 添加 evidence 序列化测试

**文件：** `backend/tests/test_api.py`

**依赖：** T16

**步骤：**

1. 添加 `test_blind_identity_json_evidence_*` 测试。
2. 模拟“合法 Kiro JSON + 解释文字”和其他品牌、拒答、格式错误、运营失败。
3. 断言 Result/model request evidence 保存分析状态、格式、三个字段、品牌命中、Message ID、Request ID、HTTP 状态、时间和脱敏响应。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json_evidence" -q`，期望因 evidence 字段尚未序列化而失败。

## T18: 序列化新探针 evidence

**文件：** `backend/app/services.py`

**依赖：** T17

**步骤：**

1. 把 `BlindIdentityJsonAnalysis` 字段加入执行 payload。
2. 在 `_scheduled_model_request_evidence` 透传全部分析字段和 HTTP 状态。
3. 对两条身份探针保存脱敏 `response_text` 和 `raw_response`。

**验证：** 运行 T17 命令，期望 evidence 测试全部通过。

## T19: 添加计划 Mock/live 执行测试

**文件：** `backend/tests/test_api.py`

**依赖：** T18

**步骤：**

1. 添加 `test_blind_identity_json_scheduled_mock_*` 测试。
2. 断言 `scheduled.use_mock=true` 时所有模型请求使用 Mock。
3. 断言 live 计划仍使用 `use_mock=false`，且新探针只增加一次请求。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json_scheduled_mock" -q`，期望因巡检调用仍硬编码 live 而失败。

## T20: 透传巡检 Mock 模式

**文件：** `backend/app/services.py`

**依赖：** T19

**步骤：**

1. 将 `scheduled.use_mock` 传给巡检模型请求调用。
2. 保持 live 计划、Signature 跳过规则和普通执行逻辑不变。

**验证：** 运行 T19 命令，期望计划 Mock/live 测试全部通过。

## T21: 添加分类和状态文案测试

**文件：** `backend/tests/test_api.py`

**依赖：** T18

**步骤：**

1. 添加 `test_blind_identity_json_classification_*` 和 `test_blind_identity_json_status_text_*`。
2. 区分开放式自报与无品牌结构化泄漏理由。
3. 覆盖正常、待确认、拒答、格式异常、请求污染、额外文字、品牌泄漏和运营状态。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json_classification or blind_identity_json_status_text" -q`，期望因分类和文案尚未区分而失败。

## T22: 更新巡检分类和状态文案

**文件：** `backend/app/scheduled_probe.py`

**依赖：** T21

**步骤：**

1. 定位实际携带身份异常标签的探针 key。
2. JSON 探针 Kiro 文案使用“疑似 Kiro 路由或隐藏人格注入”，不表述为确定模型替换。
3. 扩展 `_probe_status_text`，保持运营失败优先。

**验证：** 运行 T21 命令，期望分类和状态文案测试全部通过。

## T23: 添加 Markdown 报告测试

**文件：** `backend/tests/test_api.py`

**依赖：** T22

**步骤：**

1. 添加 `test_blind_identity_json_markdown_*` 测试。
2. 断言两条身份探针分行展示。
3. 断言 JSON 行包含解析状态、三个字段和自身上游 ID。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json_markdown" -q`，期望因报告列尚未扩展而失败。

## T24: 扩展 Markdown 身份证据

**文件：** `backend/app/scheduled_probe.py`

**依赖：** T23

**步骤：**

1. 扩展 model request 表格或身份证据区的 JSON 状态和字段展示。
2. 保留两条身份探针的独立 Message ID、Request ID 和响应。

**验证：** 运行 T23 命令，期望 Markdown 测试全部通过。

## T25: 添加站内 Kiro 异常定位测试

**文件：** `backend/tests/test_api.py`

**依赖：** T22

**步骤：**

1. 添加 `test_patrol_anomalies_blind_identity_json_*` 测试。
2. 断言 JSON 探针 Kiro 进入现有异常组，stage 为 `identity_blind_json`，Request ID 只来自命中项。
3. 断言拒答、污染、格式异常和运营失败不进入 Kiro 异常组。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "patrol_anomalies_blind_identity_json" -q`，期望因异常定位仍固定开放式探针而失败。

## T26: 实现站内异常实际探针定位

**文件：** `backend/app/main.py`

**依赖：** T25

**步骤：**

1. 从实际携带 `kiro_identity_leak` 的 model request 提取 Request ID 和 stage。
2. 标签证据优先，文本识别只兼容旧报告。
3. 保持 `/api/runs/patrol/anomalies` schema 不变。

**验证：** 运行 T25 命令，期望异常定位测试全部通过。

## T27: 添加飞书 Signature-only 回归测试

**文件：** `backend/tests/test_api.py`

**依赖：** T26

**步骤：**

1. 添加 `test_feishu_blind_identity_json_*` 测试。
2. 只有 JSON Kiro 泄漏时断言 Webhook 调用次数为 0。
3. 同时存在明确 Signature 拒绝时断言消息只包含 Signature 异常。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "feishu_blind_identity_json" -q`，期望全部通过；若失败且需要修改飞书生产筛选，停止并返回规格阶段重新审批。

## T28: 添加前端 evidence 归一化测试

**文件：** `frontend/src/runsUtils.test.ts`

**依赖：** T18

**步骤：**

1. 添加 `identity_blind_json` evidence fixture。
2. 覆盖七种身份状态、格式状态、三个字段、品牌命中和额外文字。
3. 断言不从 response text 补全空字段，旧 evidence 仍兼容。

**验证：** 在 `frontend/` 运行 `npm test -- runsUtils.test.ts`，期望因新字段尚未归一化而失败。

## T29: 扩展 PatrolModelRequestEvidence

**文件：** `frontend/src/runsUtils.ts`

**依赖：** T28

**步骤：**

1. 加入 `identityJsonStatus`、`identityJsonFormat`、`identityJsonFields`、提取/额外文字标志和品牌命中数组。
2. 在 `normalizeModelRequest` 读取对应 snake_case 字段。
3. 保证 `hydrateModelRequest` 不用响应正文覆盖解析字段。

**验证：** 运行 T28 命令，期望 `runsUtils` 测试全部通过。

## T30: 展示 JSON 解析字段

**文件：** `frontend/src/pages/Runs.tsx`

**依赖：** T29

**步骤：**

1. 在巡检详情表添加紧凑“JSON 解析”和 HTTP 状态列。
2. JSON 探针显示状态、格式和三个字段；普通探针显示 `-`。
3. 保留 Message ID、Request ID、时间、标签和脱敏响应。

**验证：** 在 `frontend/` 运行 `npm run build`，期望 TypeScript 与 Vite 构建成功。

## T31: 添加页面 JSON 探针 fixture

**文件：** `frontend/e2e/runs-pagination.mjs`

**依赖：** T30

**步骤：**

1. 在一个巡检详情 fixture 中加入开放式身份探针和 JSON 探针。
2. JSON 探针使用“合法 Kiro JSON + 解释文字”的完整 evidence。
3. 为两行配置不同 Message ID 和 Request ID。

**验证：** 运行 `npm run test:runs-pagination`，期望现有页面测试仍通过。

## T32: 添加页面展示断言

**文件：** `frontend/e2e/runs-pagination.mjs`

**依赖：** T31

**步骤：**

1. 展开 fixture 对应巡检日志。
2. 断言两条身份探针分别可见，JSON 行显示三个字段、泄漏标签、额外文字状态和正确上游 ID。
3. 断言运营失败、污染或格式错误不会显示为 Kiro 泄漏。

**验证：** 运行 `npm run test:runs-pagination`，期望全部页面断言通过。

## T33: 运行后端聚焦回归

**文件：** `backend/app/services.py`、`backend/app/scheduled_probe.py`、`backend/app/main.py`、`backend/tests/test_api.py`

**依赖：** T2-T27

**步骤：**

1. 运行新探针全部测试。
2. 同时运行 scheduled probe、旧身份探针、Signature、运营失败和巡检异常相关测试。
3. 只修复本任务引起的回归。

**验证：** 在 `backend/` 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json or scheduled_probe or scheduled_identity or signature_interop or operational_failure or patrol_anomal" -q`，期望全部选中测试通过。

## T34: 运行前端聚焦回归

**文件：** `frontend/src/runsUtils.ts`、`frontend/src/runsUtils.test.ts`、`frontend/src/pages/Runs.tsx`、`frontend/e2e/runs-pagination.mjs`

**依赖：** T28-T32

**步骤：**

1. 运行前端完整 Vitest。
2. 运行生产构建和自动巡检页面 E2E。
3. 检查旧 evidence 和普通探针显示兼容。

**验证：** 在 `frontend/` 运行 `npm test && npm run build && npm run test:runs-pagination`，期望全部通过。

## T35: 执行全量验证和范围检查

**文件：** 本任务全部修改文件

**依赖：** T33、T34

**步骤：**

1. 运行后端完整 pytest，并记录实际通过数量。
2. 再运行前端完整测试、生产构建和页面 E2E。
3. 运行 diff check、状态和任务文件范围检查。
4. 确认探针可见文本无品牌、无 system、单条 user message；飞书生产代码和白名单未改；无凭据、迁移或生成产物。

**验证：** 依次运行：

```text
cd backend && PYTHONPATH=. python3 -m pytest -q
cd ../frontend && npm test && npm run build && npm run test:runs-pagination
cd .. && git diff --check
git status --short
git diff --stat -- backend/app/services.py backend/app/scheduled_probe.py backend/app/main.py backend/tests/test_api.py frontend/src/runsUtils.ts frontend/src/runsUtils.test.ts frontend/src/pages/Runs.tsx frontend/e2e/runs-pagination.mjs docs/superpowers/specs/2026-08-17-blind-json-identity-probe
```

期望后端完整测试、前端完整测试、构建、页面 E2E 和 diff check 全部通过；无本任务范围外的新改动。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T7 -> T8 -> T9 -> T10
  -> T11 -> T12 -> T13 -> T14 -> T15 -> T16 -> T17 -> T18
  -> T19 -> T20 -> T21 -> T22 -> T23 -> T24 -> T25 -> T26 -> T27

T18 -> T28 -> T29 -> T30 -> T31 -> T32

T2-T27 -> T33
T28-T32 -> T34
T33 + T34 -> T35
```

后端测试与实现按红绿顺序串行推进。T28-T32 在 T18 已提供稳定 evidence 后可以与 T19-T27 独立推进；最终仍以 T33、T34、T35 的串行回归和全量验证收口。
