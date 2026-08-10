# Signature 待测源方向修正 Checklist

> 每项均通过运行代码、检查持久化证据或观察页面行为验证。

## 角色方向

- [x] 点击“填入推荐组合”，看到非官方待测渠道位于 Source、同模型官方参考渠道位于 Relay（验证：前端推荐组合单元测试和页面表单值）。
- [x] 手动选择官方 Source → 非官方 Relay 时出现方向警告，但高级用户仍可手动提交（验证：页面条件渲染或对应纯函数测试）。
- [x] 手动检测第一次 thinking 请求发送给待测 Source（验证：后端测试捕获第一个请求 URL、模型和凭证目标）。
- [x] 携带 Source assistant content 和 signature 的复用请求发送给官方 Relay（验证：后端测试检查第二个请求 URL，以及 messages 中的 signature 与 Source 返回值一致）。
- [x] Claude 深度快捷 Signature 探针调用方向为当前待测渠道 Source → 官方参考 Relay（验证：mock 捕获 `test_signature_interop` 的两个渠道 ID）。
- [x] 自动巡检调用方向为 scheduled channel Source → baseline/reference Relay（验证：巡检测试捕获两个渠道 ID）。

## Source 身份验证

- [x] 身份请求发送到 Source endpoint，使用 Source 模型和 Source 凭证，不请求官方 Relay 身份（验证：捕获第三个请求 URL、请求 model 和认证目标）。
- [x] 页面步骤名称显示“Source 身份验证”，当前日志阶段保存为 `source_identity`（验证：API 响应步骤和 request_logs）。
- [x] Source 明确返回 Kiro 时出现 `identity_mismatch`、`kiro_identity_leak`、`suspected_model_swap`（验证：Kiro 聚焦测试）。
- [x] Source 身份请求失败时保留 `identity_probe_failed` 和 Source 身份错误阶段，不伪造官方 Relay 身份异常（验证：身份请求失败测试）。
- [x] 历史记录中的 `relay_identity` 日志仍能被详情页面识别和展示（验证：历史 payload 兼容测试或页面兼容分支）。

## Signature 与身份独立归因

- [x] 官方 Relay 接受 Source signature 时 `signature_ok=true`（验证：手动通过测试）。
- [x] Source 命中 Kiro、但官方 Relay 已接受 signature 时，整体 `ok=false`，同时不出现 `signature_interop_failed`（验证：Kiro 测试同时检查状态与标签）。
- [x] 官方 Relay 明确拒绝 Source signature 时 `signature_ok=false` 且出现 `signature_interop_failed`（验证：invalid signature 测试）。
- [x] 模型不可比时状态为 `not_comparable`，不发起跨模型验签且不出现 `signature_interop_failed`（验证：模型不可比测试和请求次数）。
- [x] 超时、配额、服务不可用等运行故障继续归一为 operational 标签，不出现 `signature_interop_failed`（验证：现有 scheduled operational failure 测试）。
- [x] 通过文案只说明“Source Signature 被所选官方 Relay 接受”，不出现官方直连、来源已验证或百分之百真实的结论（验证：搜索页面和报告文案）。

## 结果归属与查询

- [x] 新手动检测 Result 的 `channel_id` 为待测 Source（验证：查询持久化 Result）。
- [x] 新手动检测的 upstream response/request ID 在 Kiro 场景取自 Source 身份请求（验证：Kiro 持久化测试）。
- [x] 自动巡检 Signature 证据和异常标签更新被巡检 Source 的报告，官方 Relay 报告不被降级（验证：报告查询和等级/标签断言）。
- [x] 新手动检测可通过 Source/Relay 参数从 latest 接口查询（验证：新归属查询测试）。
- [x] 旧的 Relay 归属历史 Result 仍可通过相同 Source/Relay 参数查询（验证：legacy 查询测试）。
- [x] 新证据中的 `source_channel_id` 是待测渠道，`relay_channel_id` 是官方参考渠道（验证：手动、巡检和 Claude 快捷探针响应）。

## 页面与操作流程

- [x] 页面说明明确展示“待测 Source 产签名、官方 Relay 验签、Source 身份检测”（验证：页面文案检查）。
- [x] Source 选择器提示待测产签名渠道，Relay 选择器提示官方验签渠道（验证：页面渲染或源代码行为检查）。
- [x] 检测步骤顺序为“请求 Source thinking → Signature 校验 → 官方 Relay 复用请求 → Source 身份验证 → 最终判定”（验证：API 响应和前端默认步骤）。
- [x] 同步请求超时后的日志恢复仍使用真实 Source/Relay 参数和本次 client probe ID（验证：现有恢复逻辑保持并通过前端构建）。

## 安全与兼容

- [x] API Key、Authorization、thinking 全文和完整 signature 不新增到报告、日志或页面（验证：脱敏测试与实现差异检查）。
- [x] 现有 POST 和 latest Signature API 路由及参数保持兼容（验证：既有接口测试通过）。
- [x] SQLite、Mock 和既有历史记录不要求数据库迁移（验证：无迁移文件，现有 mock/接口测试通过）。
- [x] `frontend/src/types.ts` 原有 `client_fingerprint` 未提交改动完整保留（验证：实施前后 diff 对照）。
- [x] 其余 Claude 指纹未提交文件未被本任务修改或覆盖（验证：`git status --short` 和逐文件 diff）。

## 编译与测试

- [x] 前端推荐组合聚焦测试通过（验证：`npm test -- src/signatureInterop.test.ts`）。
- [x] 后端手动 Signature 与身份聚焦测试通过（验证：对应 `pytest -k` 命令）。
- [x] 后端自动巡检 Signature 聚焦测试通过（验证：`pytest -k "scheduled_signature"`）。
- [x] 后端 Claude 快捷 Signature 探针聚焦测试通过（验证：对应 `pytest -k` 命令）。
- [x] 全新临时 SQLite 数据库上的完整后端测试通过（验证：`DATABASE_URL="sqlite:///$tmp_dir/test.db" PYTHONPATH=. python3 -m pytest -q`）。
- [x] 完整前端测试通过（验证：`npm test`）。
- [x] 前端生产构建通过（验证：`npm run build`）。
- [x] 差异无空白错误（验证：`git diff --check`）。

## 端到端场景

- [x] 正常场景：待测 Source 生成 signature，官方 Relay 接受，Source 身份为 Claude → Signature 通过，结果归属 Source，页面仅说明官方 Relay 接受该签名。
- [x] 身份异常场景：官方 Relay 接受 signature，但 Source 身份返回 Kiro → `signature_ok=true`、整体失败、出现 Kiro 标签、不出现 Signature 失败标签，结果归属 Source。
- [x] Signature 异常场景：Source 生成 signature，官方 Relay 返回 invalid signature → `signature_ok=false`、出现 `signature_interop_failed`，Source 身份证据仍单独记录。
- [x] 边界场景：Source 与官方 Relay 模型不同或官方 Relay 无权限 → 标记不可比/运行故障，不将其认定为 Source signature 无效。
- [x] 巡检场景：对候选渠道执行自动巡检 → 候选是 Source、官方是 Relay，异常只更新候选报告。

## 验证记录

- 后端完整测试：临时 SQLite 数据库，`402 passed`。
- 前端完整测试：`19 files / 139 tests passed`。
- 前端生产构建：`tsc -b && vite build` 成功。
- 差异检查：`git diff --check` 通过。
