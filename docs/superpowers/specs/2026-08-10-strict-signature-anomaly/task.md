# Signature 异常严格判定 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/app/services.py` | 增加严格错误识别，修正手动检测和自动巡检标签生成 |
| 视需要修改 | `backend/app/scheduled_probe.py` | 确保非验签失败保持运行问题/未知分类，不产生 Signature 异常 |
| 修改 | `backend/tests/test_api.py` | 覆盖两类明确错误及所有非验签错误边界 |

## T1: 添加明确验签错误判定测试

**文件：** `backend/tests/test_api.py`

**依赖：** 无

**步骤：**
1. 导入待新增的明确错误判定纯函数。
2. 使用用户提供的无反引号字段路径错误验证返回 true。
3. 使用用户提供的嵌套 JSON、反引号、两个 request id 错误验证返回 true。
4. 覆盖大小写和连续空白变化。
5. 覆盖普通 `signature invalid`、缺少 signature、thinking block 解析错误、HTTP 400、超时、503、429、鉴权和模型权限错误，验证均返回 false。

**验证：** 运行 `cd backend && python -m pytest tests/test_api.py -k "explicit_invalid_thinking_signature"`，实现前期望因函数缺失或断言失败而红灯。

## T2: 实现统一严格判定函数

**文件：** `backend/app/services.py`

**依赖：** T1

**步骤：**
1. 增加错误文本归一化和完整短语匹配纯函数。
2. 支持反引号、大小写、连续空白、字段路径、JSON 和 request id 包装。
3. 禁止依赖 HTTP 状态、错误类型或宽泛关键词单独命中。
4. 保持函数无副作用，便于手动、流式和自动巡检共同调用。

**验证：** 运行 T1 定向测试，期望全部通过。

## T3: 修正 Signature 核心结果生成

**文件：** `backend/app/services.py`

**依赖：** T2

**步骤：**
1. Relay HTTP/调用失败分支使用严格函数决定 `signature_ok` 和错误原因。
2. Relay 成功返回 error body 或 SSE error 分支使用相同严格函数。
3. 明确错误设置 `signature_ok=false` 并生成 `signature_interop_failed`。
4. 普通失败设置 `signature_ok=None`，保留 raw error、HTTP 状态、阶段、request id 和运行故障/不可比分类。
5. Source thinking block 缺少 signature 时设置 `signature_ok=None`，不生成 Signature 异常标签。
6. 结果构造函数只根据严格判定结果附加 Signature 标签，不根据通用 `ok=false` 推断。

**验证：** 运行 `cd backend && python -m pytest tests/test_api.py -k "signature_interop and (streaming_error or without_signature or operational_failure or permission_error)"`，期望相关回归全部通过。

## T4: 移除自动巡检与报告的误报回填

**文件：** `backend/app/services.py`，必要时 `backend/app/scheduled_probe.py`

**依赖：** T3

**步骤：**
1. `_attach_signature_interop_result_to_reports` 不再根据 `signature_ok is False` 或 `ok is False` 自动补 `signature_interop_failed`。
2. `build_scheduled_probe_report` 只合并 Signature 结果已经包含的明确标签。
3. 非验签失败继续进入 operational/not-comparable/unknown 分类，不被真实性评分或渠道提示升级为 Signature 异常。
4. 确认告警生成只消费最终报告标签，不新增另一套错误文本推断。

**验证：** 运行 `cd backend && python -m pytest tests/test_api.py -k "scheduled_signature or signature_alert"`，期望普通运行错误无 Signature 标签/告警，明确错误仍有标签/告警。

## T5: 补充端到端回归测试

**文件：** `backend/tests/test_api.py`

**依赖：** T3、T4

**步骤：**
1. 普通 JSON 测试覆盖无反引号明确错误，验证 `signature_ok=false` 和标签。
2. 嵌套 JSON 测试覆盖反引号和多个 request id。
3. SSE error 测试验证明确错误仍能识别。
4. 普通 400、网络/503、429、鉴权、额度、模型权限、未知错误测试验证 `signature_ok=None` 且无标签。
5. Source 缺少 signature 测试更新为无标签。
6. 自动巡检报告和告警测试分别验证明确错误与普通错误两条路径。

**验证：** 运行 `cd backend && python -m pytest tests/test_api.py -k "signature"`，期望所有 Signature 相关测试通过。

## T6: 执行完整验证

**文件：** 无新增文件；检查 T1-T5 改动

**依赖：** T5

**步骤：**
1. 运行后端完整测试。
2. 检查代码差异和格式，确认没有修改数据库模型、迁移或前端接口。
3. 使用两个用户示例通过单元或 API 测试验证明确命中。
4. 使用至少一个 503 和一个普通 400 示例验证不命中、不产生告警。

**验证：** 运行 `cd backend && python -m pytest` 和 `git diff --check`，期望退出码均为 0。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6
```
