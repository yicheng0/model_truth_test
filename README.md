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

## 使用流程

1. 打开前端首页，确认题库和渠道已自动 seed。
2. 进入“创建检测”。
3. 保持“使用 mock 模式”勾选，直接启动一次完整检测。
4. 在任务详情页查看四路结果、对比评分和报告。
5. 下载 Markdown 报告。

真实调用时关闭 mock，并在创建检测页填写对应渠道的运行时密钥。
