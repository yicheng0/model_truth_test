# Claude Channel Authenticity Eval Platform

前后端分离的 Claude 渠道真实性检测平台 MVP。

## 已实现

- React + TypeScript + Vite 前端
- FastAPI + SQLAlchemy 后端
- PostgreSQL / SQLite 两种运行方式
- 内置 `claude_full_35` 高区分度真实性题库（保留历史 ID，当前 32 题）
- 四路对比模型：Anthropic 金标、AWS Bedrock、Azure AI Foundry、第三方待测渠道
- 手动触发检测任务
- mock 模式完整跑通，无需真实 API Key
- 运行时 API Key 传入，不落库
- 检测任务支持按并发度执行
- 前端任务页按运行状态自动轮询，完成后停止刷新
- 自动规则评分、异常标签、候选渠道报告
- Markdown 报告下载

## Docker Compose

```powershell
docker compose up --build
```

- 前端：http://localhost:5173
- 后端：http://localhost:8000
- API 文档：http://localhost:8000/docs

## 本地开发

后端：

```powershell
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

前端：

```powershell
cd frontend
npm install
npm run dev
```

本地不配置 `DATABASE_URL` 时，后端默认使用 `backend/claude_eval.db` SQLite 文件。

## 环境变量

后端：

```powershell
$env:DATABASE_URL="sqlite:///./claude_eval.db"
$env:CORS_ORIGINS="http://localhost:5173,http://127.0.0.1:5173"
$env:AUTO_SCHEDULER_ENABLED="true"
```

`AUTO_SCHEDULER_ENABLED` 控制后台自动巡检调度器，默认启用；设置为 `0`、`false` 或 `no` 可关闭定时调度，手动“立即巡检”不受影响。

前端：

```powershell
$env:VITE_API_BASE_URL=""
```

`VITE_API_BASE_URL` 留空时走 Vite 同源代理；生产部署可配置为后端服务地址。

## API 主路径

新代码统一使用 `/api/runs`：

- `GET /api/runs`
- `POST /api/runs`
- `GET /api/runs/{run_id}`
- `GET /api/runs/{run_id}/results`
- `GET /api/runs/{run_id}/progress`
- `POST /api/runs/{run_id}/cancel`
- `DELETE /api/runs/{run_id}`
- `GET /api/runs/{run_id}/report.md`

旧的 `/api/eval-runs` 路径仍保留兼容。

## 测试

后端：

```powershell
cd backend
.\scripts\check_backend.ps1
```

也可以直接使用当前虚拟环境运行：

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest -q
```

前端：

```powershell
cd frontend
npm test
npm run build
```

## 使用流程

1. 打开前端首页，确认题库和渠道已自动 seed。
2. 进入“创建检测”。
3. 保持“使用 mock 模式”勾选，直接启动一次完整检测。
4. 在任务详情页查看四路结果、对比评分和报告。
5. 下载 Markdown 报告。

真实调用时关闭 mock，并在创建检测页填写对应渠道的运行时密钥。

## Claude 指纹检测说明

「Claude 指纹」页面会保存每次检测的脱敏证据，并支持按日期范围查看每天的检测记录。警告和失败探针可展开查看判定原因、标签解释、HTTP 状态、上游错误、脱敏请求快照和结构化证据。

- Web Search 使用 Anthropic server-side tool block、引用和 `usage.server_tool_use.web_search_requests` 作为成功证据；能力不支持会跳过，工具错误、限流和证据缺失会分别保留具体原因，不单独作为 Claude 真伪核心失败。
- 身份探针使用“你是谁”和“你好，请介绍一下你自己”等自然问题。模型自报身份只作为低权重辅助信号，不能覆盖协议结构、message id、usage 和 tool use 等硬证据。
- 流式协议探针检查 Anthropic 官方 SSE 关键生命周期；事件可被仿造，因此只证明原生协议兼容度，不证明第三方 URL 的来源。
- 页面内置四级证据 Spec 和渠道差异矩阵：来源/控制面证据最高，跨请求 Signature 连续性其次，协议形态为中等证据，行为与自报仅作弱信号。
- 页面把结论拆成五层：Claude 得分衡量模型与 Messages API 兼容性，Claude Code 网关兼容度衡量客户端/网关契约，访问路径描述官方端点配置、网关、协议翻译或透明未决，上游完整性独立汇总双向验签与差分证据，资源身份单独记录调用方配置或本机 CLI 认证证据。自定义 Base URL 即使响应与官方完全相同，也不会被标成官方直连或 Claude Code OAuth 资源。
- Claude Code 网关专项检查 `x-claude-code-session-id`、`anthropic-beta`、attribution system block、`/v1/messages/count_tokens` 和 `/v1/models?limit=1000`；这些是兼容证据，不是上游来源证明，并且不会降低 Claude 基础分。
- 深度模式需要可比的官方基线，重复执行双向 thinking signature、篡改对照、thinking + tool loop、参数/错误、SSE、usage/tokenizer 和路由指纹探针。`signature_chain_verified` 只表示 Claude signature 链路已由基线验证，不等于官方直连；API Key、Claude.ai OAuth 和透明转发仍需账单、request-id 或云审计确认。
- Claude Code 与 Claude API 的资源来源独立展示：signature、tool、SSE、attribution、`/v1/models` 和 `count_tokens` 只计入模型/网关兼容证据，不再把官方 API 响应标成 Claude Code 资源。远程检测新增 `resource_identity`；本机 CLI 检测可读取脱敏的 `claude auth status --json`，但沙箱使用 `--bare` 时不会继承 OAuth/keychain，因此本机登录状态不能投射为远程渠道来源。
- 运行时 API Key 只用于本次调用，不写入 Claude 指纹历史；请求快照和错误文本在返回及持久化前都会脱敏。

## 自动巡检配置说明

自动巡检在“自动巡检”页面按渠道创建计划。每个计划只检测一个待测渠道，创建时只需要选择待测渠道和执行间隔。

巡检内容固定为 Thinking Signature 互通检测和多项真实模型请求探针：

- Thinking Signature 互通检测：指纹源渠道生成带 signature 的 thinking block，再让待测渠道复用。
- 真实模型请求探针：发送 adaptive thinking 协议、Web Search tool、adaptive thinking effort 等参数探针，记录 `message.id`、request id、协议和 endpoint。

告警会携带 run、report、message id、request id 和 source/relay message id 等证据，方便复审定位。自动巡检默认不使用 mock，也不需要手动选择测试集、渠道指纹、重复次数、并发度或评分阈值；这些旧字段仅用于兼容已有数据。
## 生产部署安全说明

当前项目支持运行时传入 API Key，并在报告、告警和原始请求/响应证据中尽量执行脱敏；但现有 `Channel.auth_config_encrypted` 字段在模型层仍是 JSON 配置字段，不能仅凭字段名视为已经完成企业级强加密或 KMS/Vault 托管。

生产部署前建议优先完成：

- 使用 Secret 引用、环境变量引用、KMS、Vault 或云 Secret Manager 托管 provider 凭证。
- 禁止在报告、日志、截图、告警和 seeded fixtures 中保存密钥明文。
- 为渠道、巡检计划、告警复审、报告删除和通知设置增加权限控制与操作审计。
- 调整真实 provider 调用行为前，先核对当前官方 API 文档，避免巡检规则因接口变更产生误报。
### 凭证引用

渠道 `auth_config` 支持使用环境变量引用来避免在数据库中直接保存 API Key 明文：

```json
{
  "auth_config": {
    "secret_ref": "env:ANTHROPIC_API_KEY",
    "request_protocol": "anthropic_messages"
  }
}
```

运行时会把 `secret_ref` / `credential_ref` 解析为 `api_key`。同一次 run 传入的 runtime credentials 仍然优先于渠道配置。当前已支持 `env:NAME` 形式；Vault、KMS、云 Secret Manager 属于后续企业级扩展。
