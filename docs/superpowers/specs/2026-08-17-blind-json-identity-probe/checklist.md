# 无品牌 JSON 身份填空探针 Checklist

> 每项均通过运行代码或观察行为验证；验收时记录实际命令输出、响应 evidence 或页面截图/文本，不以代码阅读代替结果证据。

## 实现完整性

- [x] 每次自动巡检固定保留原开放式身份探针，并额外产生且只产生一条“无品牌 JSON 身份填空”证据。（验证：执行一次只选择一个参数探针的巡检，查看该 run 的 `model_requests` 和 Result 数量；期望依次看到 `identity_self_report`、`identity_blind_json`、所选参数探针，两个身份探针具有不同 Result ID）【AC6】

- [x] 查看新探针实际 raw request，用户文本不包含 Kiro、Claude、Anthropic、OpenAI、ChatGPT、GPT、Gemini、Qwen、DeepSeek 等受监控品牌，`system` 为空且只有一条 user message。（验证：运行后端 execution-shape 测试并查看持久化 raw request；期望品牌命中数组为空、无历史消息、无用户侧 system）【AC1】

- [x] 新探针不进入参数探针可选集合，也不改变 Claude/AWS 参数形态的完整性计数。（验证：运行 registry 与 scheduled-probe 分类测试；期望参数探针 key 集合仍只有原三项，选择子集行为和原分类结果不变）【AC8】

- [x] 纯 JSON `{"vendor":"Kiro","product":"Kiro","model":""}` 被提取为三个字符串字段，并记录 `hidden_brand_leak` 与 `kiro_identity_leak`。（验证：运行后端分析、评分和 evidence 测试；期望状态为品牌泄漏，且不包含 `suspected_model_swap`）【AC2】

- [x] 合法 Kiro JSON 后附带解释文字时，泄漏证据仍保留，同时单独记录额外文字/格式偏差。（验证：输入合法 JSON 后追加解释段落；期望 `json_extracted=true`、字段值不变、泄漏标签存在、`extra_text_present=true`，解释文字不参与字段补全）【AC2】

- [x] 合法 JSON 位于唯一 Markdown 代码块中时可以提取；多个代码块、缺字段、多字段、非字符串值、数组或非法 JSON 均显示格式异常而不产生品牌泄漏。（验证：运行 JSON 提取参数化测试；期望每个输入得到对应 fenced/invalid 状态和稳定标签）【AC4】

- [x] 合法对象填写其他明确非 Claude/Anthropic 身份时记录 `hidden_brand_leak` 与 `identity_mismatch`，但不记录 `kiro_identity_leak`。（验证：使用 OpenAI/ChatGPT、Gemini、Qwen、DeepSeek 等大小写和空白变体运行分析测试；期望标签严格符合该组合）【AC3】

- [x] 合法对象填写 Claude/Anthropic 时显示正常，不记录 `hidden_brand_leak`。（验证：分别填写 vendor、product 或 model 字段并运行分析测试；期望状态为 clean，无品牌泄漏标签）【AC4】

- [x] 三字段全部为空或明确表示无法确认时显示身份待确认，不记录 `hidden_brand_leak` 或身份不一致。（验证：运行空字段和无法确认 fixture；期望状态为 uncertain，仅保留待确认类标签）【AC4】

- [x] 纯拒答显示拒答状态；无法解析或结构不完整显示格式异常；两者均不产生身份泄漏。（验证：运行拒答、缺字段和非法 JSON fixture；期望分别显示 refused/format_error，且无 Kiro、身份不一致或模型替换标签）【AC4】

- [x] 身份匹配只读取合法对象中的 `vendor`、`product`、`model`；解释文字、错误正文、额外字段和请求之外的文本不能制造身份命中。（验证：在对象外或额外字段中放入品牌词，指定三字段保持空值；期望没有 `hidden_brand_leak`）【AC4】

- [x] 请求发送前若模型可见文本出现受监控品牌，provider 不被调用，证据标记为请求污染且不产生任何身份异常。（验证：运行 contamination 测试并检查调用计数；期望调用数为 0、`request_sent=false`、无 Message ID/Request ID、无身份泄漏或模型替换标签）【AC1】【AC5】

- [x] 协议层 model 路由字段、endpoint、headers 或内部元数据含品牌名时不会误判请求污染。（验证：只在这些非提示位置加入品牌词；期望审计通过并允许请求发送）【AC1】

- [x] HTTP 失败、超时、权限、额度不足和资源不可用只显示运营状态，不产生身份泄漏、身份不一致或模型替换。（验证：运行 400/401/403/429/5xx、timeout、No available accounts 和额度 fixture；期望命中对应运营标签，身份标签为空）【AC5】

- [x] 新探针 evidence 完整保留探针名称、身份状态、格式状态、三个解析字段、标签、Message ID、Request ID、HTTP 状态、发生时间和脱敏原始响应。（验证：查看报告 JSON 与页面展开详情；期望字段齐全，上游 ID 与该探针自身 Result 一致）【AC6】

- [x] API Key、Authorization、x-api-key 和其他凭据不会出现在 Result、报告、Markdown、日志或页面响应中。（验证：用带唯一秘密标记的运行凭据执行测试并在数据库序列化结果、API 响应和页面文本中搜索该标记；期望零命中）【AC6】【AC8】

- [x] 报告结论能区分“直接身份自报异常”和“无品牌结构化探针泄漏”，Kiro 文案只表述为疑似路由或隐藏人格注入，不宣称已确定底层模型替换。（验证：分别构造两种探针命中并查看 classification reason/Markdown；期望来源描述不同且 JSON 探针无确定模型替换措辞）【AC6】

- [x] Kiro JSON 探针命中进入站内现有 Kiro 异常组，异常 stage 为 `identity_blind_json`，Request ID 只来自实际命中项。（验证：调用 `/api/runs/patrol/anomalies`；期望 count 增加、stage 和 Request ID 正确，开放式探针 ID 未串入）【AC7】

- [x] 拒答、污染、格式异常、正常结果和运营失败不会进入站内 Kiro 异常组。（验证：分别创建五类报告后调用异常接口；期望这些 run 均不出现在 `kiro_identity_leak.items`）【AC7】

- [x] Mock 自动巡检重复执行得到稳定、合法的 JSON 探针结果，并覆盖正常、Kiro 泄漏、拒答、格式错误和运营失败测试场景。（验证：运行 mock 相关测试两次；期望分类和标签一致，且不访问真实 provider）【AC8】

- [x] 每次巡检只增加一次新模型请求，不增加该探针的重试轮次或三轮采样。（验证：捕获 provider/Mock 调用次数与 run total_jobs；期望相对原流程只增加 1 次，探针 attempt/repeat 均为 1）【AC1】【AC8】

## 集成

- [x] 后端从探针执行到 Result、报告 evidence、站内分类和异常接口的数据链完整一致。（验证：执行 Kiro JSON 集成场景，依次比对 Result labels、report `model_requests`、classification 和 anomaly API；期望状态、字段、标签与上游 ID 一致）【AC2】【AC6】【AC7】

- [x] 自动巡检详情页面同时显示开放式身份探针和 JSON 身份探针，两行的 Message ID、Request ID、响应和标签互不串行。（验证：运行页面 E2E 并展开指定日志；期望两行独立可见，JSON 行有解析字段，开放式行 JSON 解析列为 `-`）【AC6】

- [x] JSON 探针详情显示身份状态、格式状态、`vendor/product/model` 和 HTTP 状态；空字符串明确为空，不从响应解释文字补值。（验证：查看“合法 JSON + 解释”和空字段页面 fixture；期望页面字段与 evidence 完全一致）【AC2】【AC4】【AC6】

- [x] 飞书小时任务在只有 JSON 探针 Kiro 泄漏时不调用 Webhook。（验证：运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "feishu_blind_identity_json" -q`；期望身份泄漏单独场景的 Webhook 调用次数为 0）【AC7】

- [x] 同一小时同时存在 JSON Kiro 泄漏和明确 Thinking Signature 拒绝时，飞书仅发送 Signature 异常，不包含身份探针、品牌泄漏或运营错误。（验证：运行组合 fixture 并检查发送 payload；期望只出现明确 `Invalid signature in thinking block` 对应内容）【AC7】

- [x] 现有 Signature、thinking、Web Search、参数兼容性和普通评测执行行为不变。（验证：运行后端聚焦回归；期望既有相关测试全部通过，新探针未改变请求参数或标签判定）【AC8】

- [x] 旧巡检报告缺少新 JSON 字段时，前端仍能正常打开和展示，不出现 undefined、对象渲染错误或页面崩溃。（验证：用旧 evidence fixture 运行前端测试和页面 E2E；期望正常显示，JSON 解析列为 `-`）【AC6】【AC8】

## 编译与测试

- [x] 后端全部新探针与相邻模块聚焦测试通过。（验证：在 `backend/` 运行 `PYTHONPATH=. python3 -m pytest tests/test_api.py -k "blind_identity_json or scheduled_probe or scheduled_identity or signature_interop or operational_failure or patrol_anomal" -q`；期望零失败）【AC8】

- [x] 后端完整测试通过。（验证：在 `backend/` 运行 `PYTHONPATH=. python3 -m pytest -q`；期望零失败并记录实际通过数量）【AC8】

- [x] 前端完整单元测试通过。（验证：在 `frontend/` 运行 `npm test`；期望零失败并记录实际测试数量）【AC8】

- [x] 前端生产构建通过。（验证：在 `frontend/` 运行 `npm run build`；期望 TypeScript 检查和 Vite build 均成功）【AC8】

- [x] 自动巡检页面交互测试通过。（验证：在 `frontend/` 运行 `npm run test:runs-pagination`；期望分页、既有功能移除和 JSON 探针详情断言全部通过）【AC6】【AC8】

- [x] 仓库当前没有独立 lint script，使用现有静态检查替代项全部通过。（验证：查看 `frontend/package.json` scripts 无 lint 命令；运行 `npm run build` 和仓库根目录 `git diff --check`，期望无 TypeScript 错误和空白错误）【AC8】

- [x] 本任务未新增数据库迁移、队列、凭据持久化或生成产物，也未修改飞书 Signature-only 白名单。（验证：运行 `git status --short`、本任务文件 `git diff --stat` 并检查飞书生产文件 diff；期望变更仅在已批准文件范围，飞书白名单无生产改动）【AC7】【AC8】

- [x] 当前工作区原有无关改动保持原样。（验证：实施前后比对 `docs/superpowers/specs/2026-08-12-patrol-delete-button-usability/checklist.md` 和 `frontend/src/channelFingerprintRemoval.test.ts` 的状态与内容；期望本任务没有改写或暂存它们）【AC8】

## 端到端场景

- [x] 完整泄漏流程：启动一次自动巡检，使新增探针返回合法 Kiro JSON 后附解释文字；查看 run 详情、报告和异常汇总，依次看到独立 JSON 探针行、三个解析字段、`hidden_brand_leak`、`kiro_identity_leak`、额外文字状态、上游 ID 和 `identity_blind_json` 异常 stage；执行飞书小时任务时不发送身份告警。（验证：后端集成测试 + `/runs` 页面 E2E + 异常 API + Webhook 调用记录）【AC2】【AC6】【AC7】

- [x] 重要边界流程：在新探针实际可见请求中加入受监控品牌；系统发送前阻断请求，页面显示“请求污染/无效证据”，没有上游 ID、身份异常、站内 Kiro 异常或飞书消息。（验证：污染集成测试、报告 evidence、异常 API 和 Webhook 调用记录）【AC1】【AC5】【AC7】

- [x] 运营边界流程：依次模拟超时、额度不足和资源池不可用；页面只显示相应运营状态，报告不输出身份结论，站内 Kiro 异常和飞书消息均不增加。（验证：运营失败参数化集成测试 + 页面 evidence 检查 + 异常/通知计数）【AC5】【AC7】

- [x] 正常兼容流程：Mock 巡检返回合法 Claude/Anthropic 或空字段 JSON；页面分别显示正常或身份待确认，完整后端/前端回归均通过，原有 Signature 与参数探针结果不变。（验证：Mock 自动巡检、报告详情、聚焦回归和全量测试）【AC4】【AC8】

## 验收标准映射

| 验收标准 | 清单覆盖 |
|---|---|
| AC1 | 请求形态、品牌扫描、污染阻断、单次调用、污染端到端流程 |
| AC2 | Kiro 纯 JSON、JSON 加解释、evidence 链、页面展示、完整泄漏流程 |
| AC3 | 其他非预期品牌标签组合 |
| AC4 | 正常、待确认、拒答、代码块、格式错误和仅三字段判定 |
| AC5 | 污染、HTTP/超时/权限/额度/资源不可用和运营边界流程 |
| AC6 | 两条探针独立保存、报告字段、脱敏、页面详情和旧 evidence 兼容 |
| AC7 | 站内 Kiro 异常、实际 stage/Request ID、飞书 Signature-only 和零误报 |
| AC8 | Mock 稳定性、相邻模块回归、全量测试、构建、页面 E2E 和范围检查 |


## 2026-08-17 验收记录

- 后端聚焦回归：`81 passed, 404 deselected`。
- 后端完整测试：`494 passed in 49.20s`。
- 前端完整单元测试：`20 test files passed`，`177 tests passed`。
- 前端生产构建：`tsc -b && vite build` 成功。
- Runs 页面交互测试：`npm run test:runs-pagination` 成功。
- 静态替代检查：仓库无独立 lint script；`git diff --check` 成功。
- 范围核对：未新增数据库迁移、队列、凭据持久化或生成产物；飞书生产告警分类仍只由明确 Thinking Signature 拒绝触发。
- 工作区核对：原有 `2026-08-12-patrol-delete-button-usability/checklist.md` 改动和未跟踪的 `channelFingerprintRemoval.test.ts` 保持未暂存、未覆盖。
