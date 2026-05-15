# Claude Channel Authenticity Eval Platform

前后端分离的 Claude 渠道真实性检测平台 MVP。

## 已实现

- React + TypeScript + Vite 前端
- FastAPI + SQLAlchemy 后端
- PostgreSQL / SQLite 两种运行方式
- 内置 `claude_full_35` 高区分度真实性题库
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

## 自动巡检配置说明

自动巡检在“自动巡检”页面按渠道创建计划。每个计划只检测一个待测渠道，并使用一个 ready 状态的渠道指纹作为对照基线。

- 执行间隔（分钟）：两次计划巡检之间的间隔，最小 5 分钟。生产环境建议从 60 或 1440 开始。
- 重复次数：同一题目重复请求次数，范围 1-5。提高后更容易发现低概率混路，但会增加调用成本。
- 并发度：巡检请求并发数，范围 1-16。第三方渠道限流较严时建议设置为 1-4。
- 使用 mock client：只用于演示和本地自测；真实巡检应关闭。
- 评级阈值：默认 `D 及以下`，即 D/E 评级触发告警；选 `C 及以下` 会更敏感，选 `仅 E` 会更保守。
- 分数阈值：可选，设置后报告分数小于等于该值也会触发告警；留空表示不按分数单独告警。
- 红旗标签告警：默认启用。身份错配、协议异常、请求失败、Signature 互通失败等高风险标签会触发告警。
- 重复告警静默（分钟）：默认 0。大于 0 时，同计划同渠道已有待复审告警的静默期内不重复创建和发送告警。
- 最大重试次数：默认 0，范围 0-3。只在巡检任务执行失败时重试，不会因为低分或异常标签重试。
- 重试间隔（分钟）：默认 5，范围 1-60。控制失败重试之间的等待时间。
