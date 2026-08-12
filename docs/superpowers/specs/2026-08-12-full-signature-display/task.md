# Signature 完整展示 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/tests/test_api.py` | 添加完整 Signature、短摘要和凭证脱敏回归测试 |
| 修改 | `backend/app/services.py` | 区分原始证据与摘要证据的 Signature 处理策略 |
| 条件修改 | `frontend/src/styles.css` | 仅当现有样式验证不能容纳长 Signature 时做最小修复 |
| 复核 | `frontend/src/pages/SignatureInterop.tsx` | 确认手动检测原始证据沿用可滚动代码块 |
| 复核 | `frontend/src/pages/ReportDetailPage.tsx` | 确认巡检报告原始证据沿用可滚动代码块 |

## T1: 添加原始 Signature 完整保留回归测试（RED）

**文件：** `backend/tests/test_api.py`

**依赖：** 无

**步骤：**

1. 在现有 Signature 互通接口测试附近构造长度明显超过 50 个字符的固定 Signature。
2. 让 Source 响应返回该完整 Signature，并让 Relay 请求复用同一 thinking block。
3. 断言 Source `response_excerpt` 和 Relay `request_excerpt` 都包含逐字符一致的完整 Signature。
4. 断言原始证据中不存在由系统追加在该 Signature 后的 `...`。
5. 运行该测试并确认它因当前只保留前 50 字符而失败，记录预期失败信息。

**验证：** 运行 `cd backend && python -m pytest tests/test_api.py -k "signature_interop and full_signature" -q`，期望测试断言失败，失败原因是原始证据缺少完整 Signature，而不是测试语法或夹具错误。

## T2: 添加摘要和安全边界回归测试（RED）

**文件：** `backend/tests/test_api.py`

**依赖：** T1

**步骤：**

1. 在同一场景断言 `signature_prefixes` 仍等于完整 Signature 的前 50 个字符。
2. 在请求/响应夹具中加入 API Key、Authorization 和 Token 类字段。
3. 断言 API 返回和持久化的请求日志不包含真实凭证值。
4. 添加历史截断字符串夹具，断言读取时原样返回且系统不拼接缺失后缀。
5. 运行聚焦测试并确认完整 Signature 相关断言仍处于 RED，既有脱敏断言保持有效。

**验证：** 运行 `cd backend && python -m pytest tests/test_api.py -k "signature_interop and (full_signature or redacts_credentials or legacy_truncated)" -q`，期望只有尚未实现的完整 Signature 行为失败，凭证保护和历史兼容断言不出现测试错误。

## T3: 实现原始证据与摘要证据双策略（GREEN）

**文件：** `backend/app/services.py`

**依赖：** T1、T2

**步骤：**

1. 保留现有摘要策略，使 `signature_prefixes`、步骤摘要和 Relay 摘要继续使用短前缀。
2. 为请求日志的原始证据路径增加保留完整 Signature 的递归处理策略。
3. 原始证据策略继续调用既有认证秘密脱敏逻辑，并继续限制 thinking 正文长度。
4. 调整 Source 响应日志和 Relay 请求日志生成，避免固定总长度裁剪掉 Signature 后缀。
5. 不改变 Source/Relay 调用顺序、`signature_ok`、异常标签、评分或公开响应字段形状。
6. 重跑 T1、T2 的聚焦测试直至全部通过。

**验证：** 运行 `cd backend && python -m pytest tests/test_api.py -k "signature_interop and (full_signature or redacts_credentials or legacy_truncated)" -q`，期望所有选中测试通过。

## T4: 验证前端完整查看与布局

**文件：** `frontend/src/pages/SignatureInterop.tsx`、`frontend/src/pages/ReportDetailPage.tsx`、`frontend/src/styles.css`

**依赖：** T3

**步骤：**

1. 确认手动 Signature 页面和报告详情页均直接渲染后端返回的 `request_excerpt`、`response_excerpt`，没有前端 `slice`、ellipsis 或二次裁剪。
2. 确认相关代码块使用 `white-space: pre-wrap`、自动断词和容器滚动，长 Signature 不会撑开页面。
3. 确认浏览器可直接选择完整文本；不添加只复制前缀的交互。
4. 若现有样式不能满足窄屏或长连续字符串展示，只在 `frontend/src/styles.css` 做最小调整并运行构建；若已满足则不修改前端文件。

**验证：** 运行 `rg -n "request_excerpt|response_excerpt|slice\\(|ellipsis" frontend/src/pages/SignatureInterop.tsx frontend/src/pages/ReportDetailPage.tsx` 与 `rg -n "signature-step-excerpt|patrol-probe-response|white-space|word-break|overflow-wrap|overflow" frontend/src/styles.css`，期望原始证据没有前端截断，代码块具备换行和滚动规则。

## T5: 运行 Signature 回归与前端生产构建

**文件：** `backend/tests/test_api.py`、`backend/app/services.py`，以及 T4 中实际修改的前端文件

**依赖：** T4

**步骤：**

1. 运行完整 Signature 互通测试组，确认方向、判断语义、异常标签与完整证据均通过。
2. 运行后端完整测试，确认通用结果和报告读取未发生回归。
3. 运行前端测试与生产构建，确认类型和页面构建通过。
4. 查看任务相关 diff，只保留本次文档、测试和实现文件，不覆盖现有其他未提交修改。

**验证：**

- 运行 `cd backend && python -m pytest tests/test_api.py -k "signature_interop" -q`，期望 0 失败。
- 运行 `cd backend && python -m pytest -q`，期望 0 失败。
- 运行 `cd frontend && npm test -- --run`，期望 0 失败。
- 运行 `cd frontend && npm run build`，期望退出码为 0。
- 运行 `git diff --check -- backend/app/services.py backend/tests/test_api.py frontend/src/styles.css docs/superpowers/specs/2026-08-12-full-signature-display`，期望无输出且退出码为 0。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5
```
