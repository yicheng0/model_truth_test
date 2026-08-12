# Signature 完整展示 Checklist

> 每项均通过运行代码或观察行为验证。

## 实现完整性

- [x] 新产生的 Source 原始响应保留超过 50 个字符的完整 Signature，值与测试上游返回逐字符一致，且 Signature 后没有系统人工追加的 `...`。（验证：运行完整 Signature 聚焦测试，检查 `request_logs` 中 Source `response_excerpt`；期望包含完整固定 Signature）【AC1】
- [x] 新产生的 Relay 原始请求保留并展示从 Source 复用的完整 Signature。（验证：检查 Relay `request_excerpt`；期望 Signature 与 Source 返回值完全相同）【AC2】
- [x] 原始证据中的长 Signature 可以完整选择和复制。（验证：在手动 Signature 检测页或报告详情展开原始证据，复制 Signature 后与测试固定值比对；期望逐字符相同）【AC2】
- [x] `signature_prefixes`、步骤摘要和报告概览仍保持短文本，不直接展开完整 Signature。（验证：检查同一检测结果的摘要字段和页面“Signature 前缀”；期望最多展示预定前缀）【AC3】
- [x] 已经保存为截断字符串的历史记录原样可读，系统不拼接、猜测或生成不存在的后缀。（验证：读取历史截断夹具；期望返回值与存储值完全一致）【AC1】【AC3】

## 安全与数据边界

- [x] Source 与 Relay 原始证据中不出现测试使用的真实 API Key。（验证：在夹具中放入固定 API Key 并搜索 API 响应及持久化结果；期望无真实值）【AC4】
- [x] Authorization、Token、Password 等既有敏感字段继续脱敏。（验证：运行凭证脱敏测试并检查返回文本；期望只出现脱敏占位或安全片段）【AC4】
- [x] 完整 Signature 只出现在原始证据区域，不进入任务列表、巡检摘要或报告概览的长文本展示。（验证：检查 API 摘要字段与相关页面；期望仅出现短前缀）【AC3】【AC4】
- [x] 本次改动不新增数据库迁移，也不修改历史记录。（验证：查看任务 diff；期望无 Alembic 文件和数据回填逻辑）【AC1】【AC3】

## 集成

- [x] Source 生成 Signature、官方 Relay 验证 Signature 的方向保持不变。（验证：运行候选 Source/官方 Relay 方向测试；期望 Source 和 Relay ID 与既有语义一致）【AC6】
- [x] 官方 Relay 接受 Signature 时仍记录通过和 `signature_ok=true`。（验证：运行 Relay 接受场景测试；期望评分和标签不变）【AC6】
- [x] 官方 Relay 明确拒绝 Signature 时仍记录 `signature_interop_failed`，运行故障仍保持无法判定。（验证：运行拒绝与运行故障场景测试；期望异常分类不变）【AC6】
- [x] 手动 Signature 检测接口、运行原始结果接口和报告详情均能读取新证据，字段结构与现有客户端兼容。（验证：运行接口测试并构建前端；期望无响应模型或类型错误）【AC1】【AC2】【AC6】

## 布局与可用性

- [x] 桌面端长 Signature 在代码块内换行或滚动，不撑开卡片、不覆盖相邻内容。（验证：用超长连续 Signature 打开原始证据；期望容器宽度不变且能查看末尾）【AC5】
- [x] 窄屏下长 Signature 仍限制在容器内并能滚动查看完整末尾。（验证：使用窄视口检查同一记录；期望页面无异常横向撑开或内容重叠）【AC5】
- [x] 前端不对 `request_excerpt` 和 `response_excerpt` 使用 `slice`、ellipsis 或其他二次截断。（验证：搜索两个页面的原始证据渲染代码；期望直接渲染完整字段）【AC1】【AC2】【AC5】

## 编译与测试

- [x] 完整 Signature、摘要前缀、凭证脱敏和历史兼容的聚焦测试通过。（验证：`cd backend && python -m pytest tests/test_api.py -k "signature_interop and (full_signature or redacts_credentials or legacy_truncated)" -q`）【AC1】【AC2】【AC3】【AC4】
- [x] Signature 互通完整测试组通过。（验证：`cd backend && python -m pytest tests/test_api.py -k "signature_interop" -q`）【AC6】
- [x] 后端完整测试通过。（验证：`cd backend && python -m pytest -q`）【AC6】
- [x] 前端测试通过。（验证：`cd frontend && npm test -- --run`）【AC5】【AC6】
- [x] 前端生产构建无错误。（验证：`cd frontend && npm run build`）【AC5】【AC6】
- [x] 任务相关文件无空白和补丁格式错误。（验证：`git diff --check -- backend/app/services.py backend/tests/test_api.py frontend/src/styles.css docs/superpowers/specs/2026-08-12-full-signature-display`）【AC6】

## 端到端场景

- [x] 完整流程：候选 Source 返回长 Signature -> 官方 Relay 复用并接受 -> 打开检测详情 -> Source 原始响应和 Relay 原始请求均能查看、选择、复制完整 Signature -> “Signature 前缀”仍为短文本。（验证：接口夹具或本地可控渠道执行完整流程，逐项比对固定 Signature）【AC1】【AC2】【AC3】【AC5】【AC6】
- [x] 安全边界：请求数据同时包含长 Signature 和固定测试凭证 -> 原始证据保留完整 Signature，但不出现任何真实凭证。（验证：自动化安全夹具及 API 返回检查）【AC1】【AC2】【AC4】
- [x] 历史边界：打开已有带 `...` 的旧记录 -> 页面原样展示旧值并明确无法恢复，不生成虚假完整 Signature；新记录则展示完整值。（验证：分别读取历史夹具和新记录进行对比）【AC1】【AC3】
