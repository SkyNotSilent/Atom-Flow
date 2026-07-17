# AtomFlow 部署指南

## 问题说明

AtomFlow 是一个全栈应用，包含：
- **前端**：React + Vite（静态页面）
- **后端**：Express + Node.js（API服务，RSS抓取）

如果只部署前端静态文件，RSS订阅功能将无法工作，因为需要后端API服务。

## 部署方案

### 方案1：Railway（推荐）

1. 访问 [Railway.app](https://railway.app)
2. 连接 GitHub 仓库，启用 GitHub 自动部署到 Railway
3. Railway 会自动读取 `railway.json`，并使用 `npm start` 启动服务
4. 每次合并前 **Wait for CI**，确认 GitHub CI 全部通过后再触发部署
5. 确认 `/api/health` 健康检查通过，部署完成后再绑定公网 URL

### 方案2：Render（免费）

1. 访问 [Render.com](https://render.com)
2. 创建新的 Web Service
3. 连接你的 GitHub 仓库
4. Render 会自动检测 `render.yaml` 配置
5. 或手动配置：
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
6. 点击 Create Web Service

### 方案3：Docker 部署（VPS/云服务器）

```bash
# 构建镜像
docker build --build-arg VITE_TLDRAW_LICENSE_KEY="$VITE_TLDRAW_LICENSE_KEY" -t atomflow .

# 运行容器（本地默认端口 1000；云平台通常注入 PORT）
docker run -d -p 1000:1000 --name atomflow atomflow
```

### 方案4：传统 VPS 部署

```bash
# 1. 克隆代码
git clone https://github.com/SkyNotSilent/Atom-Flow.git
cd Atom-Flow

# 2. 安装依赖
npm install

# 3. 构建前端
npm run build

# 4. 使用 PM2 运行（推荐）
npm install -g pm2
pm2 start npm --name "atomflow" -- start
pm2 save
pm2 startup

# 或直接运行
npm start
```

## 环境变量配置

创建 `.env` 文件或在部署平台配置以下环境变量：

### 必需
```env
DATABASE_URL=postgresql://user:pass@host:5432/dbname
SESSION_SECRET=your-random-secret-string
AI_API_KEY=your-mimo-token-plan-api-key
AI_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1
AI_MODEL=mimo-v2.5-pro
NODE_ENV=production
APP_URL=https://your-domain.example
ALLOWED_ORIGINS=https://your-domain.example
VITE_TLDRAW_LICENSE_KEY=your-production-tldraw-license-key
```

### 可选
```env
PORT=1000
RSSHUB_BASE=https://rsshub.app
RESEND_API_KEY=your-resend-key
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=your-app-password
BAIDU_TRANSLATE_APPID=your-appid
BAIDU_TRANSLATE_KEY=your-key
WRITE_AGENT_ALLOWED_MODELS=mimo-v2.5-pro
WRITE_AGENT_MAX_OUTPUT_TOKENS=2000
PAID_OPERATION_DAILY_LIMIT=100
PAID_OUTPUT_TOKENS_DAILY_LIMIT=200000
CANVAS_PDF_MAX_PAGES=100
```

> **注意**：Railway 会自动注入 `DATABASE_URL`（添加 PostgreSQL 插件后）。其他变量需要在 Railway Variables 面板手动添加。

### 发布前检查

- **Wait for CI**：GitHub checks 全部通过后再合并和部署。
- `SESSION_SECRET` 使用至少 32 个随机字符，`APP_URL` 使用正式 HTTPS 地址；`VITE_TLDRAW_LICENSE_KEY` 必须在构建阶段存在。
- Railway 的 `/api/health` 健康检查通过，且 `healthcheckTimeout` 已显式配置。
- 每用户每日付费操作和输出 token 预留额度已写入 PostgreSQL；分钟级限流、全局并发、RSS 缓存和任务协调仍有单进程状态，因此 Railway 先保持 1 个 Web 副本。公开发布前完成 Cloudflare/WAF、Redis、对象存储、后台队列、监控告警和数据库备份；共享状态迁移并压测后再扩到 2 个以上副本。
- 本地或单进程内存限流只适合开发验证，不能替代多副本生产环境的共享限流和协调。

## 验证部署

部署成功后，访问：
- 前端页面：`https://your-domain.com`
- API测试：`https://your-domain.com/api/articles`

如果 `/api/articles` 返回 JSON 数据，说明后端正常运行。

## 常见问题

### Q: 为什么只有前端页面，没有RSS内容？
A: 因为只部署了静态文件，后端API服务没有运行。需要使用支持 Node.js 的平台。

### Q: Vercel/Netlify 可以用吗？
A: 不推荐。这些平台主要用于静态网站，虽然支持 Serverless Functions，但需要大量改造代码。

### Q: 如何查看后端日志？
A: 
- Railway/Render：在平台控制台查看日志
- VPS：使用 `pm2 logs atomflow` 或 `docker logs atomflow`

### Q: 端口配置
A: 本地默认端口是 1000，可以通过环境变量 `PORT` 修改。大多数云平台会自动设置端口。
