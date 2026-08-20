# Fable 5 渠道检测点模式 Checklist

> 每项均通过运行代码或观察行为验证；未完成前不得宣称功能交付。

## 实现完整性

- [x] 检测点注册表固定包含 `fable5_behavior`、`kiro_bedrock`、`claude_code_client`、`anthropic_origin`、`calibration` 五组，并为每组提供标题、证据层级、官方资料链接和资料日期（验证：注册表单元测试与题库覆盖测试）。
- [x] `detection_points` 测试范围只选择显式标记的启用题目，按注册表顺序稳定排序；`quick`、`full`、`scheduled_probe` 语义不变（验证：范围选择测试与既有运行测试）。
- [x] 检测点模式默认执行 3 次采样，仅允许 3 或 5 次；传入 1 次时返回校验错误，旧模式默认重复次数不变（验证：schema/API 边界测试）。
- [ ] Fable 5 组包含模型字段/可用性、adaptive thinking、禁止关闭 thinking、非默认采样参数、reasoning extraction、thinking signature 和 SSE 边界题（验证：题库元数据审计和检测点计划输出）。
- [x] Fable 5 组同时存在正向、负向和篡改/改写对照；单个错误文案、`msg_` ID、SSE 或 signature 不会单独生成官方直连结论（验证：正负/篡改聚合单元测试）。
- [x] Kiro/Bedrock 组包含模型目录差分、盲身份、Bedrock 线索和目录矛盾状态；Kiro 泄漏不会直接转化为非 Claude 或模型替换（验证：Kiro 聚合测试）。
- [x] Claude Code 组仅在真实入站请求捕获且特征满足时输出 `claude_code_like`；主动探针、无入站捕获时输出 `unobservable`（验证：被动/主动两类客户端指纹测试）。
- [x] Anthropic 来源组区分端点配置、协议兼容和控制面闭环；只有 endpoint、request-id 与账单/用量/审计关联时才允许 `anthropic_api_direct_verified`（验证：来源评估三类输入测试）。
- [x] 能力、代码、知识、安全、长上下文和多轮题被标记为校准题，不改变官方来源字段（验证：题库元数据和报告聚合测试）。
- [ ] 新增社区短文本、多约束、错误 envelope、fallback 和拒答边界题不要求生成危险操作内容（验证：题库安全扫描和测试用例审计）。
- [x] 结果独立输出 `model_identity`、`client_likelihood`、`access_path`、`resource_identity`、`control_plane_evidence` 和 `detection_points`，总分不能覆盖这些字段（验证：报告 schema/API 断言）。
- [x] 运营故障、认证失败、限流、超时、配额、无可用账户和未配置能力显示为运营/不可判定或不适用，不写入 Signature 失败、模型替换或 Kiro 泄漏统计（验证：故障分类测试）。
- [x] 检测点报告保留结构化证据摘要、重复计数、官方资料链接、抓取日期和不可比较原因（验证：报告 JSON 与 Markdown 检查）。
- [x] API Key、Authorization、Cookie、OAuth token、完整认证头和未脱敏原始凭据不出现在数据库报告、API 响应、日志或前端摘要（验证：脱敏测试和关键词扫描）。
- [x] 完整模式、mock 模式、历史报告和既有 Signature 异常口径保持兼容（验证：后端/前端全量回归）。

## 集成

- [x] 创建运行页面能选择“检测点模式”，显示默认 3 次采样、低成本范围和“Fable 5 行为一致不等于官方直连”的说明（验证：页面交互与前端组件测试）。
- [ ] 检测点模式运行计划包含五组检测点，并向运行详情持续报告当前检测点、样本数和状态（验证：mock 运行端到端观察）。
- [x] 报告详情同时展示五组检测点和四类独立身份字段，来源未验证、透明中转未决、客户端不可观测、运营故障和官方云差异使用非绝对化文案（验证：mock 报告页面观察）。
- [ ] 题目管理页能显示检测点、证据层级、正向/负向/篡改控制、校准标记和官方资料日期（验证：题目页面观察）。
- [x] 报告列表能显示检测模式和需要复核的检测点，不改变原有评分、等级、删除和详情跳转（验证：列表页面观察与既有导航测试）。
- [x] 一个符合 Fable 5 行为的样本不会自动出现 `anthropic_api_direct_verified`（验证：mock 正向控制报告）。
- [x] Kiro 泄漏或目录矛盾样本显示 Kiro 线索/矛盾，不直接显示 `model_swap_suspected`（验证：mock 异常报告）。
- [x] 没有入口侧入站捕获时，Claude Code 客户端字段显示 `unobservable`（验证：主动探针报告）。

## 编译与测试

- [x] 检测点后端聚焦测试通过（验证：`cd backend && PYTHONPATH=. python3 -m pytest tests/test_detection_points.py -q`）。
- [ ] 检测点 API 聚焦回归通过（验证：`cd backend && PYTHONPATH=. python3 -m pytest tests/test_detection_points.py tests/test_api.py -k "detection_point or test_scope or report" -q`）。
- [x] 后端全量测试通过（验证：`cd backend && PYTHONPATH=. python3 -m pytest -q`）。
- [ ] 前端检测点工具测试通过（验证：`cd frontend && npm test -- src/detectionPointUtils.test.ts src/lightweightDetection.test.ts`）。
- [x] 前端全量测试通过（验证：`cd frontend && npm test`）。
- [x] 前端生产构建通过（验证：`cd frontend && npm run build`，退出码为 0）。
- [x] 差异无空白错误（验证：`git diff --check`）。

## 端到端场景

- [ ] mock gold、official_cloud、candidate 和 negative 渠道运行检测点模式三次 -> 页面显示五组检测点、重复计数和独立身份字段（验证：本地 mock 运行与报告详情）。
- [ ] Fable 5 行为一致但无控制面闭环 -> `model_identity=fable5_consistent`，来源保持未验证，不显示官方直连（验证：正向控制报告）。
- [ ] 返回改写错误、缺失 signature、重建 SSE 或违反参数边界 -> 至少两个独立检测点记录异常，并输出疑似改写/换模或证据不足（验证：篡改对照 fixture）。
- [ ] Kiro 身份泄漏与当前目录差分 -> 显示 `kiro_identity_leak` / `kiro_model_catalog_contradiction`，不直接判非 Claude（验证：Kiro fixture）。
- [ ] 认证失败、限流、超时、配额、无可用账户或 503 -> 显示运营/不可判定，不增加 `signature_interop_failed`、`model_swap_suspected` 或 Kiro 泄漏（验证：运营故障 fixture）。
- [ ] 同一渠道先运行检测点模式再运行 full 模式 -> 两次运行均完成，历史列表可区分模式，full 报告仍按旧口径评分（验证：连续 mock 运行）。
- [ ] 官方资料目录发生更新或超过资料有效期 -> 页面显示资料抓取日期和时间敏感提示，不把旧差分当成永久结论（验证：时间字段 fixture）。

## 文档与交付边界

- [x] 技术研究文档记录官方资料链接、检测点模式、时间敏感性和“不能证明”的边界（验证：文档审阅）。
- [x] 报告和页面不出现“真货”“假货”“100% 官方”等绝对化结论（验证：文案关键词扫描）。
- [x] 无法进行真实官方控制面验证时，验收报告明确写明“来源未验证”，不得用 mock 通过替代官 API 证据（验证：验收报告审阅）。
