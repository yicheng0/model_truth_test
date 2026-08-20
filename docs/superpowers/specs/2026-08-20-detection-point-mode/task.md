# Fable 5 渠道检测点模式 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 新建 | `backend/app/detection_points.py` | 检测点注册表、官方资料引用、状态归并和题目元数据读取 |
| 修改 | `backend/app/suite_seed.py` | 为现有题目补充检测点元数据，新增安全的错误/格式边界题，标记检测点模式题目 |
| 修改 | `backend/app/schemas.py` | 扩展 `detection_points` 范围、检测点报告证据和运行读取类型 |
| 修改 | `backend/app/services.py` | 选择检测点题目、运行端点观察、聚合检测点、注入报告证据和独立身份字段 |
| 修改 | `backend/app/routers/reports.py` | 复用报告详情/列表返回检测点字段；只在当前路由需要时补充筛选参数 |
| 新建 | `backend/tests/test_detection_points.py` | 检测点注册表、范围筛选、聚合和来源边界测试 |
| 修改 | `backend/tests/test_api.py` | `/api/runs` 检测点范围、mock 运行和报告回归测试 |
| 修改 | `frontend/src/types.ts` | 检测点、独立身份评估和 `detection_points` 类型 |
| 新建 | `frontend/src/detectionPointUtils.ts` | 检测点状态、标签、摘要和来源边界纯函数 |
| 新建 | `frontend/src/detectionPointUtils.test.ts` | 前端检测点状态和身份字段测试 |
| 修改 | `frontend/src/pages/CreateRun.tsx` | 增加检测点模式选择、重复次数限制和运行说明 |
| 修改 | `frontend/src/pages/TestCases.tsx` | 展示题目所属检测点、证据层级、控制类型和官方资料日期 |
| 修改 | `frontend/src/pages/RunDetail.tsx` | 展示运行中的检测点进度和完成后的检测点表 |
| 修改 | `frontend/src/pages/ReportDetailPage.tsx` | 展示检测点证据、四类身份字段、资料链接和结论边界 |
| 修改 | `frontend/src/pages/ReportsPage.tsx` | 在报告摘要/筛选中显示检测点模式和高风险检测点状态 |
| 修改 | `frontend/src/lightweightDetection.ts` | 将轻量检测结果映射到检测点状态，保留主动探针客户端不可观测边界 |
| 修改 | `frontend/src/claudeFingerprintSpec.ts` | 补充检测点标签与“Fable 行为不等于官方直连”说明 |

## T1: 定义检测点注册表和公共状态契约

**文件：** `backend/app/detection_points.py`、`backend/tests/test_detection_points.py`

**依赖：** 无

**步骤：**

1. 定义 `fable5_behavior`、`kiro_bedrock`、`claude_code_client`、`anthropic_origin`、`calibration` 五个检测点及稳定顺序。
2. 为每个检测点声明标题、证据层级、官方文档 URL、资料抓取日期占位字段和时间敏感标记。
3. 定义检测点状态归并规则，至少覆盖 `pass`、`warning`、`fail`、`not_applicable`、`operationally_inconclusive` 和 `insufficient_evidence`。
4. 提供从题目 `scoring_rules` 读取检测点元数据的纯函数；缺失元数据的旧题目不得自动进入新模式。
5. 先写注册表顺序、未知检测点、时间敏感资料和状态归并的失败测试。

**验证：** 在 `backend` 目录运行 `PYTHONPATH=. python3 -m pytest tests/test_detection_points.py -q`，期望新增测试在实现前失败，且失败原因仅限于注册表接口尚不存在。

## T2: 扩展测试范围为 detection_points

**文件：** `backend/app/schemas.py`、`backend/app/services.py`、`frontend/src/types.ts`

**依赖：** T1

**步骤：**

1. 将运行创建、运行读取、样本计划和必要的定时配置类型接受 `detection_points`，保持 `quick`、`full` 和 `scheduled_probe` 既有行为。
2. 更新 `cases_for_scope`，按注册表顺序、`sort_order`、case ID 返回 `scoring_rules.detection_point_mode=true` 的启用题目。
3. 对检测点模式强制 `repeat_count` 为 3 或 5；未传时默认 3，旧模式默认值不变。
4. 在前端 `TestScope` 和运行表单类型中增加 `detection_points`。
5. 添加 schema、范围选择和重复次数边界测试。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_detection_points.py -k "scope or repeat" -q`，期望检测点模式只选择已标记题目，`repeat_count=1` 被拒绝，quick/full 旧用例仍通过。

## T3: 重映射现有题目并补充安全边界题

**文件：** `backend/app/suite_seed.py`、`backend/tests/test_detection_points.py`

**依赖：** T1、T2

**步骤：**

1. 将协议、消息 ID、usage、stop reason、参数拒绝、tool-use、thinking、signature 和 SSE 题标记为 `fable5_behavior` 或 `claude_code_client`。
2. 将盲身份 JSON、Kiro 泄漏相关题和模型目录矛盾题标记为 `kiro_bedrock`。
3. 将端点、request-id、控制面引用和来源配置相关题标记为 `anthropic_origin`；没有控制面证据的题只能输出 configured/unverified。
4. 将能力、代码、长上下文、知识、安全和多轮稳定性题标记为 `calibration_only`，不参与官方来源判断。
5. 增加短文本、多约束、错误 envelope、fallback 和拒答类别的安全题；不得要求生成危险操作步骤。
6. 为 Fable 5 组明确标记 `positive_control`、`negative_control`、`tamper_control` 和 `expected_error_category`，确保至少有一组正向、负向和篡改对照。
7. 增加题库覆盖测试，确保五个检测点均有题目，Fable 5 组具备三类控制。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_detection_points.py -k "metadata or coverage or safety" -q`，期望覆盖检查通过且危险内容生成题不存在。

## T4: 增加检测点报告证据 schema 和脱敏边界

**文件：** `backend/app/schemas.py`、`frontend/src/types.ts`、`backend/tests/test_detection_points.py`

**依赖：** T1、T2

**步骤：**

1. 定义检测点结果、检测点集合、独立身份评估和控制面证据的响应结构。
2. 把 `detection_points`、`identity_assessment`、`control_plane_evidence`、`suite_version`、`case_version` 和 `source_checked_at` 加入报告证据类型。
3. 复用现有 `redact_secrets`、`redact_signatures` 和字段序列化器，禁止序列化 API Key、Authorization、Cookie、OAuth token 和完整认证头。
4. 对仅响应证据、仅 endpoint 配置、具备控制面闭环三种输入分别定义 `origin_verified` 的默认值和结果。
5. 为脱敏前后结构、空证据、运营故障和未知字段添加测试。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_detection_points.py -k "schema or redact or origin" -q`，期望秘密字段不出现在序列化结果中，响应兼容证据不能单独把 `origin_verified` 设为 true。

## T5: 实现 Fable/Kiro/Claude Code/官方来源检测点聚合器

**文件：** `backend/app/detection_points.py`、`backend/app/services.py`、`backend/tests/test_detection_points.py`

**依赖：** T3、T4

**步骤：**

1. 实现纯聚合函数，按 `detection_point`、重复样本和控制类型统计 pass/warning/fail/skipped。
2. Fable 5 只有正向、负向和篡改对照均可比较且重复稳定时，才输出行为一致；单个错误文案、ID、SSE 或 signature 不能输出官方直连。
3. 将 `thinking_disabled`、采样参数、reasoning extraction、signature 和 SSE 异常分别保留标签，并在多个独立硬异常时才允许 `protocol_reconstruction_suspected` 或 `model_swap_suspected`。
4. 将 Kiro 泄漏、模型目录矛盾、Bedrock 线索和运营故障分开；Kiro 线索不直接变成非 Claude。
5. 调用现有 Claude Code 客户端指纹函数时，只有 `inbound_request_observed` 才允许 `claude_code_like`；主动探针统一 `unobservable`。
6. 只有控制面证据满足 endpoint、request-id 和账单/审计关联时，才输出 `anthropic_api_direct_verified`；否则输出 `configured_not_verified` 或 `transparent_unresolved`。
7. 运营错误、认证失败、限流、超时、配额、无可用账户和未配置能力统一进入不可判定/不适用分支，不写入 Signature 失败或换模标签。
8. 生成每个检测点的官方资料 URL、抓取日期、证据引用和不可比较原因。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_detection_points.py -k "aggregate or fable or kiro or claude_code or control_plane or operational" -q`，期望正向、负向、篡改、Kiro、客户端不可观测和官方来源边界用例全部通过。

## T6: 接入运行创建、执行进度和报告生成

**文件：** `backend/app/services.py`、`backend/app/routers/reports.py`、`backend/tests/test_api.py`

**依赖：** T2、T4、T5

**步骤：**

1. 在运行创建和执行链中识别 `test_scope=detection_points`，按检测点题目计算总任务数，并保持 runtime credentials 只在本轮使用。
2. 将每次归一化响应的结构化证据、错误类别、协议族、模型名、request-id 摘要和脱敏标签传给检测点聚合器。
3. 在 `build_reports` 中仅对检测点模式追加 `detection_mode`、检测点结果、独立身份评估和控制面证据；quick/full 旧报告不得生成虚假字段。
4. 在报告详情和列表接口复用现有序列化，必要时支持按检测模式筛选，不修改已有报告评分和标签语义。
5. 生成 Markdown 时添加检测点表和结论边界，禁止写“真货/假货/100% 官方”。
6. 添加 mock 模式检测点运行、重复采样、报告详情、历史运行和旧模式回归测试。

**验证：** 运行 `PYTHONPATH=. python3 -m pytest tests/test_detection_points.py tests/test_api.py -k "detection_point or test_scope or report" -q`，期望 mock 检测点运行完成、报告包含五组检测点，quick/full 既有测试不回归。

## T7: 增加前端类型、状态工具和检测点运行选择

**文件：** `frontend/src/types.ts`、`frontend/src/detectionPointUtils.ts`、`frontend/src/detectionPointUtils.test.ts`、`frontend/src/pages/CreateRun.tsx`、`frontend/src/lightweightDetection.ts`

**依赖：** T4、T6

**步骤：**

1. 增加检测点结果、独立身份评估、控制面证据和检测范围类型。
2. 实现检测点状态、标签、来源边界、运营故障和不可观测状态的纯函数映射。
3. 在运行创建页面增加“检测点模式”选项，显示默认三次采样、低成本范围和“行为一致不等于官方直连”的说明。
4. 选择该模式时限制重复次数为 3 或 5；切回 quick/full 时恢复原有表单行为。
5. 将轻量检测结果映射为检测点摘要，不把主动探针结果映射成 `claude_code_like`。
6. 添加前端纯函数测试覆盖五组检测点、空证据、运营故障、来源未验证和客户端不可观测。

**验证：** 在 `frontend` 目录运行 `npm test -- src/detectionPointUtils.test.ts src/lightweightDetection.test.ts`，期望所有新增测试通过；运行 `npm run build`，期望 TypeScript 和 Vite 构建成功。

## T8: 展示题目元数据、运行结果和报告证据

**文件：** `frontend/src/pages/TestCases.tsx`、`frontend/src/pages/RunDetail.tsx`、`frontend/src/pages/ReportDetailPage.tsx`、`frontend/src/pages/ReportsPage.tsx`、`frontend/src/claudeFingerprintSpec.ts`

**依赖：** T7

**步骤：**

1. 在题目管理页显示检测点、证据层级、正向/负向/篡改控制、校准标记和官方资料日期。
2. 在运行详情页展示检测点进度、样本数、通过/警告/失败/不可判定计数和当前证据摘要。
3. 在报告详情页展示 Fable 行为、Kiro/Bedrock、Claude Code、官方来源和校准五组检测点。
4. 单独展示 `model_identity`、`client_likelihood`、`access_path`、`resource_identity`、`origin_verified` 和 limitations。
5. 显示官方资料链接和抓取日期；对 Kiro 模型目录差分增加“资料可能更新”的时间敏感提示。
6. 对来源未验证、透明中转未决、客户端不可观测、运营故障和官方云差异使用非绝对化文案。
7. 在报告列表显示检测模式和需要复核的检测点，不改变原有评分、等级、删除和详情跳转。
8. 添加前端渲染测试或页面工具测试，验证秘密字段不会出现在显示摘要中。

**验证：** 在 `frontend` 目录运行 `npm test` 和 `npm run build`，期望完整前端测试与生产构建通过；手动打开 mock 检测点报告，看到五组检测点和四类独立身份字段。

## T9: 端到端回归、文档和安全检查

**文件：** `backend/tests/test_detection_points.py`、`backend/tests/test_api.py`、`frontend/src/detectionPointUtils.test.ts`、`docs/lightweight-detector-technical-research.md`

**依赖：** T6、T8

**步骤：**

1. 用 mock gold、official_cloud、candidate 和 negative 样本运行检测点模式三次，检查五组检测点均产生结果。
2. 验证一个 Fable 5 行为一致样本不会显示 `anthropic_api_direct_verified`。
3. 验证 Kiro 泄漏/目录矛盾不会直接变成 `model_swap_suspected`，而是保留 Kiro 线索标签。
4. 验证没有入站请求捕获时客户端字段是 `unobservable`。
5. 验证认证、限流、超时、配额、无可用账户和 503 只产生运营/不可判定状态。
6. 验证 quick/full、历史报告、mock 和现有 Signature 异常口径不回归。
7. 更新技术研究文档，记录检测点模式、官方资料链接、时间敏感性和“不能证明”的边界。
8. 检查报告、日志、截图和前端证据中没有 API Key、Authorization、OAuth token 或完整敏感请求头。

**验证：** 依次运行：

```text
cd backend && PYTHONPATH=. python3 -m pytest -q
cd ../frontend && npm test
cd ../frontend && npm run build
cd .. && git diff --check
```

期望后端和前端全量测试通过、生产构建退出码为 0、差异无空白错误；无法进行真实官方控制面验证时，报告必须明确显示“来源未验证”，不能以 mock 通过替代官方来源证据。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T7 -> T8 -> T9
```

T1 的注册表和状态契约先于范围扩展；T3 题库元数据先于 T5 聚合；T6 后端报告数据完成后才能进行 T7/T8 前端接入；T9 必须最后执行完整回归和文档更新。
