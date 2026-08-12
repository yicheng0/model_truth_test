# Signature 运营故障误报抑制 Checklist

> 每项均通过运行代码或观察行为验证。

## 实现完整性

- [x] Signature 三态字段完整传入详情展示（验证：构造 `true`、`false`、`null` 三种后端证据，期望前端归一化结果分别保持通过、明确拒绝和未知）。
- [x] Source Identity HTTP 500 `Upstream access forbidden` 不显示红色 Signature 失败（验证：渲染对应详情，期望顶部无“Signature 失败” Alert，Signature 状态为“未完成验证/无法判定”）。
- [x] Relay HTTP 400 `models is not allowed for this account` 不显示红色 Signature 失败（验证：渲染对应详情，期望顶部无错误 Alert，且不产生 Signature 异常状态）。
- [x] 配额不足、网络失败、超时、HTTP 5xx 和临时不可用均显示为未知而不是 Signature 失败（验证：参数化运行展示状态测试，期望全部为 unknown）。
- [x] 明确 `Invalid signature in thinking block` 仍显示红色 Signature 失败（验证：HTTP 400 + 明确错误文本，期望 `signatureRejected=true` 且红色 Alert 可见）。
- [x] Kiro 身份泄漏不被运营故障隐藏（验证：Kiro 标签与 Signature unknown 同时存在，期望身份异常仍展示、Signature 失败不展示）。
- [x] 缺少 `signature_ok` 的历史运营故障保守显示未知（验证：仅提供历史状态和可识别错误文本，期望不升级为明确拒绝）。

## 页面展示

- [x] 纯运营故障不展示 AI 真伪疑难复核卡片（验证：两张截图对应场景，页面中不存在“AI 疑难复核”标题）。
- [ ] 真实身份或协议异常仍展示必要复核信息（验证：Kiro 与明确 Signature 拒绝场景，期望异常提示和复核信息保持可见）。
- [ ] 运营错误不会在详情顶部直接爆出完整正文（验证：默认详情视图无完整 `Upstream access forbidden` 或账号权限错误正文）。
- [ ] 用户主动展开请求日志后仍能看到脱敏错误、阶段、HTTP 状态和 Request ID（验证：展开 Source Identity/Relay 请求日志，期望诊断字段完整且无凭据）。
- [ ] Signature 顶部状态标签颜色与三态一致（验证：通过为成功色、未知为中性色、明确拒绝为错误色）。

## 集成与回归

- [ ] 自动巡检列表和错误筛选不把运营故障计入 Signature 真伪异常（验证：对应历史记录不包含 `signature_interop_failed`，错误筛选只按现有运营口径处理）。
- [ ] 后端 Signature 分类和持久化行为未被修改（验证：本次差异不包含后端服务、模型、Schema 和数据库文件）。
- [ ] 普通检测任务详情和独立 Signature 检测页面不受影响（验证：现有前端测试通过，相关页面仍按自身语义展示）。

## 编译与测试

- [ ] `runsUtils` 三态和运营故障测试通过（验证：在 `frontend` 运行定向测试，期望退出码为 0）。
- [ ] 详情组件展示测试通过（验证：运行详情页测试，期望两张运营场景隐藏误报、明确拒绝显示错误）。
- [x] 前端完整测试通过（验证：`vitest run`，19 个测试文件、163 个测试通过）。
- [x] 前端生产构建通过（验证：`tsc -b && vite build`，期望退出码为 0）。
- [x] 差异格式检查通过（验证：仓库根目录运行 `git diff --check`，期望无输出）。

## 端到端场景

- [ ] Source Identity 权限故障 -> 详情中性状态 -> 展开日志查看错误（验证：页面默认无红色/黄色误报，展开后能看到 HTTP 500、`source_identity` 和 Request ID）。
- [ ] Relay 模型权限故障 -> 详情中性状态 -> 展开日志查看错误（验证：页面默认无红色/黄色误报，展开后能看到 HTTP 400、`relay` 和权限错误）。
- [ ] 明确 Signature 拒绝 -> 红色 Signature 失败（验证：真实或测试数据命中明确错误文本后，红色 Alert 和拒绝证据均可见）。
- [ ] 生产部署后复查两张截图对应记录（验证：生产页面不再出现误导性顶部提示，展开诊断证据仍可用）。
