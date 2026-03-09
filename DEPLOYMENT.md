# AtomFlow 部署指南

## 问题说明

AtomFlow 是一个全栈应用，包含：
- **前端**：React + Vite（静态页面）
- **后端**：Express + Node.js（API服务，RSS抓取）

如果只部署前端静态文件，RSS订阅功能将无法工作，因为需要后端API服务。

## 部署方案

### 方案1：Railway（推荐，免费额度）

1. 访问 [Railway.app](https://railway.app)
2. 连接你的 GitHub 仓库
3. Railway 会自动检测 `railway.json` 配置
4. 点击 Deploy
5. 部署完成后，Railway 会提供一个公网URL

### 方案2：Render（免费）

1. 访问 [Render.com](https://render.com)
2. 创建新的 Web Service
3. 连接你的 GitHub 仓库
4. Render 会自动检测 `render.yaml` 配置
5. 或手动配置：
   - Build Command: `npm install && npm run build`
   - Start Command: `npm run dev`
6. 点击 Create Web Service

### 方案3：Docker 部署（VPS/云服务器）

```bash
# 构建镜像
docker build -t atomflow .

# 运行容器
docker run -d -p 3001:3001 --name atomflow atomflow
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
pm2 start npm --name "atomflow" -- run dev
pm2 save
pm2 startup

# 或直接运行
npm run dev
```

## 环境变量配置

创建 `.env` 文件（可选）：

```env
PORT=3001
NODE_ENV=production
RSSHUB_BASE=https://rsshub.app
```

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
A: 默认端口是 3001，可以通过环境变量 `PORT` 修改。大多数云平台会自动设置端口。
