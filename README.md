# Claude Channel Authenticity Eval Platform

前后端分离的 Claude 渠道真实性检测平台 MVP。

## 已实现

- React + TypeScript + Vite 前端
- FastAPI + SQLAlchemy 后端
- PostgreSQL / SQLite 两种运行方式
- 内置 `claude_full_35` 题库
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
```

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
python -m pytest
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
