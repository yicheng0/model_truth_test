# Signature 待测源方向修正 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `frontend/src/signatureInterop.test.ts` | 先定义待测 Source → 官方 Relay 推荐组合契约 |
| 修改 | `frontend/src/signatureInterop.ts` | 实现推荐组合和反向选择判断 |
| 修改 | `frontend/src/pages/SignatureInterop.tsx` | 更新页面方向、步骤、警告和结果文案 |
| 修改 | `frontend/src/types.ts` | 在保留现有未提交内容的前提下补充可选 `signature_ok` |
| 修改 | `backend/tests/test_api.py` | 定义核心、持久化、查询、巡检和深度探针的新方向契约 |
| 修改 | `backend/app/services.py` | 修正身份对象、独立 Signature 状态、结果归属、巡检和深度探针 |
| 修改 | `backend/app/schemas.py` | 暴露可选 `signature_ok` 响应字段 |
| 修改 | `backend/app/routers/channels.py` | 最新日志按 Source 查询并兼容旧 Relay 归属 |

## T1: 保护现有同文件未提交修改

**文件：** `frontend/src/types.ts`、工作树状态

**依赖：** 无

**步骤：**

1. 保存实现前 `git status --short` 和 `git diff -- frontend/src/types.ts` 的证据。
2. 确认 `types.ts` 中现有 `client_fingerprint` 修改属于用户已有工作。
3. 后续只在 Signature 类型附近添加 `signature_ok`，不改动或格式化现有指纹区块。
4. 实现结束后重新比较该区块，确认已有修改逐字保留。

**验证：** 运行 `git diff -- frontend/src/types.ts`，期望既有 `client_fingerprint` 差异保持不变，新增差异仅位于 `SignatureInteropResult`。

## T2: 添加前端推荐组合失败测试

**文件：** `frontend/src/signatureInterop.test.ts`

**依赖：** T1

**步骤：**

1. 将推荐组合用例改为包含多个候选 Source 和多个官方 Relay。
2. 断言推荐 Source 是非参考待测渠道。
3. 断言推荐 Relay 是与 Source 同模型的参考渠道。
4. 添加没有同模型 Relay 时选择备用参考渠道的用例。
5. 添加“官方 Source → 非官方 Relay”为反向组合的判断用例。
6. 运行聚焦测试并确认因现有实现仍选择官方 Source 而失败。

**验证：** 在 `frontend` 目录运行 `npm test -- src/signatureInterop.test.ts`，期望新增方向测试失败且失败原因与推荐角色相反一致。

## T3: 实现前端推荐组合与页面方向

**文件：** `frontend/src/signatureInterop.ts`、`frontend/src/pages/SignatureInterop.tsx`

**依赖：** T2

**步骤：**

1. 实现返回待测 Source 和官方 Relay 的推荐组合纯函数。
2. 固定优先选择同模型官方 Relay，并保持稳定 fallback。
3. 实现反向组合判断函数。
4. 页面“填入推荐组合”使用新组合函数。
5. Source 和 Relay 选择器分别提示“待测产签名渠道”和“官方验签渠道”。
6. 当 Source 为参考渠道、Relay 为非参考渠道时展示方向警告。
7. 将步骤和恢复状态中的“Relay 身份验证”改为“Source 身份验证”。
8. 将页面说明和成功文案限制为“Source Signature 被官方 Relay 接受”，不声称来源已验证。
9. 运行聚焦测试确认通过。

**验证：** 在 `frontend` 目录运行 `npm test -- src/signatureInterop.test.ts`，期望全部通过。

## T4: 添加核心身份对象和标签归因失败测试

**文件：** `backend/tests/test_api.py`

**依赖：** T1

**步骤：**

1. 修改手动通过用例，断言第三次身份请求发送到 Source endpoint，使用 Source 模型。
2. 断言步骤名为“Source 身份验证”，日志阶段为 `source_identity`。
3. 修改 Kiro 用例，让 Source 身份请求返回 Kiro，断言 `signature_ok=true`、整体 `ok=false`。
4. 断言 Kiro 用例包含身份标签但不包含 `signature_interop_failed`。
5. 修改无效签名用例，断言 `signature_ok=false` 且包含 `signature_interop_failed`。
6. 添加 Source 身份请求运行失败用例，断言保留身份运行错误但不伪造 Signature 失败。
7. 运行聚焦测试并确认现有 Relay 身份逻辑导致失败。

**验证：** 在 `backend` 目录使用临时 SQLite 执行 `DATABASE_URL="sqlite:///$TMPDIR/signature-direction-red.db" PYTHONPATH=. python3 -m pytest tests/test_api.py -k "signature_interop_endpoint_passes or signature_interop_kiro or signature_interop_identity or invalid_signature" -q`，期望新增断言失败且指向身份请求对象或标签归因。

## T5: 实现 Source 身份探针和独立 Signature 状态

**文件：** `backend/app/services.py`、`backend/app/schemas.py`、`frontend/src/types.ts`

**依赖：** T4

**步骤：**

1. 在 Relay 复用结果确定时保存 `signature_ok`，不可比状态保持独立。
2. 身份探针改用 Source endpoint、Source 凭证和 Source 模型。
3. 步骤改名为“Source 身份验证”，错误阶段和日志阶段改为 `source_identity`。
4. 整体 `ok` 合并 Signature 与身份状态，但 `signature_interop_failed` 只由 `signature_ok=false` 的真实 Signature 失败产生。
5. Source 命中 Kiro 时只添加身份异常标签，不额外添加 Signature 失败。
6. Schema 和前端 Signature 类型添加可选 `signature_ok`。
7. 重新运行 T4 聚焦测试确认通过。

**验证：** 运行 T4 相同 pytest 命令，期望相关测试全部通过。

## T6: 添加并实现手动结果归属与历史查询兼容

**文件：** `backend/tests/test_api.py`、`backend/app/services.py`、`backend/app/routers/channels.py`

**依赖：** T5

**步骤：**

1. 先修改手动检测测试，断言 Result `channel_id` 为 Source。
2. 断言 Kiro 的 upstream response/request ID 来自 Source 身份请求。
3. 添加最新日志查询用例：新数据按 Source 归属可查询。
4. 保留旧数据按 Relay 归属仍可查询的兼容用例。
5. 修改 Result 持久化、normalized provider endpoint 和标签生成逻辑以归属 Source。
6. 修改最新日志查询，优先搜索 Source 归属，再兼容 Relay 归属，并继续精确匹配 Source/Relay/stream。
7. 运行聚焦测试确认通过。

**验证：** 在 `backend` 目录使用临时 SQLite 运行 `DATABASE_URL="sqlite:///$TMPDIR/signature-persistence.db" PYTHONPATH=. python3 -m pytest tests/test_api.py -k "signature_interop_endpoint or signature_interop_latest" -q`，期望全部通过。

## T7: 添加并实现自动巡检方向修正

**文件：** `backend/tests/test_api.py`、`backend/app/services.py`

**依赖：** T5

**步骤：**

1. 将现有巡检方向测试改为断言 scheduled channel 是 Source、基线参考是 Relay。
2. 断言巡检证据中的 Source/Relay 名称和 ID 正确。
3. 断言 Signature 结果附加到 scheduled Source 的 Report。
4. 将参考选择函数语义改为选择官方 Relay，并更新缺失提示和变量名。
5. 调用核心服务时使用 `test_signature_interop(scheduled_channel, reference_relay)`。
6. 报告附加函数按 Source channel ID 查询并更新报告。
7. 保留 operational/not_comparable 过滤逻辑。

**验证：** 在 `backend` 目录使用临时 SQLite 运行 `DATABASE_URL="sqlite:///$TMPDIR/signature-patrol.db" PYTHONPATH=. python3 -m pytest tests/test_api.py -k "scheduled_signature" -q`，期望全部通过。

## T8: 添加并实现 Claude 深度快捷探针方向修正

**文件：** `backend/tests/test_api.py`、`backend/app/services.py`

**依赖：** T5

**步骤：**

1. 修改快捷 Signature 探针测试，断言当前被测 channel 是 Source，传入的参考 ID 是 Relay。
2. 断言凭证 override 只覆盖待测 Source，不覆盖官方 Relay。
3. 将内部变量从 source reference 改为 relay reference，保持外部 `source_channel_id` 参数兼容。
4. 自动 fallback 只选择 `is_reference=true` 的官方 Relay。
5. 调用核心服务时使用 `test_signature_interop(channel, official_relay, stream=True)`。
6. 原始证据明确携带真实 Source/Relay ID。

**验证：** 在 `backend` 目录使用临时 SQLite 运行 `DATABASE_URL="sqlite:///$TMPDIR/signature-claude-code.db" PYTHONPATH=. python3 -m pytest tests/test_api.py -k "claude_code_signature_probe or create_claude_code_test_runs_deep" -q`，期望全部通过。

## T9: 完整页面与接口文案回归

**文件：** `frontend/src/pages/SignatureInterop.tsx`、必要的现有测试

**依赖：** T6、T7、T8

**步骤：**

1. 搜索并移除当前流程中残留的“Relay 身份验证”“强制 Relay 身份探针”等错误文案。
2. 确认请求日志展示能识别 `source_identity`。
3. 确认结果标题分别表达 Signature 验证和 Source 身份结果。
4. 确认反向手动组合仅警告，不阻止高级用户提交。
5. 确认历史 `relay_identity` 日志仍能显示，不破坏旧结果。

**验证：** 运行 `rg -n "Relay 身份验证|强制 Relay 身份探针" frontend/src/pages/SignatureInterop.tsx backend/app/services.py`，期望当前流程无残留；历史兼容处理可保留显式分支。

## T10: 完整验证与工作树保护核对

**文件：** 本次全部修改文件

**依赖：** T9

**步骤：**

1. 使用全新临时 SQLite 数据库运行完整后端测试。
2. 运行完整前端测试。
3. 运行前端生产构建。
4. 运行 `git diff --check`。
5. 核对 `frontend/src/types.ts` 的既有 `client_fingerprint` 差异未被覆盖。
6. 核对其余 Claude 指纹未提交文件未被修改。
7. 对照 spec 的 AC1-AC9 逐项记录实际证据。

**验证：**

- 后端：`tmp_dir=$(mktemp -d) && DATABASE_URL="sqlite:///$tmp_dir/test.db" PYTHONPATH=. python3 -m pytest -q`
- 前端：`npm test`
- 构建：`npm run build`
- 差异：仓库根目录运行 `git diff --check` 和 `git status --short`

期望所有命令退出码为 0，且工作树中用户原有 Claude 指纹修改仍完整保留。

## 执行顺序

```text
T1 -> T2 -> T3
T1 -> T4 -> T5 -> T6
                 ├-> T7
                 └-> T8
T3 + T6 + T7 + T8 -> T9 -> T10
```
