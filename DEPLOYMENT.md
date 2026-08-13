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
5. 每次推送或合并到远程仓库后，监控 Railway 的部署状态和日志；只有部署成功、`/api/health` 通过并完成公网 URL 基础烟测后，才算发布完成。GitHub CI 通过不能替代 Railway 部署验证。

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

启用魔法写作 Pro 收费时，还必须配置以下变量；部署代码但暂不收费时保持 `BILLING_ENABLED=false`：

```env
BILLING_ENABLED=true
PADDLE_ENVIRONMENT=production
VITE_PADDLE_ENVIRONMENT=production
PADDLE_API_KEY=pdl_live_apikey_...
PADDLE_WEBHOOK_SECRET=pdl_ntfset_secret
VITE_PADDLE_CLIENT_TOKEN=live_client_side_token
PADDLE_MAGIC_WRITE_PRODUCT_ID=pro_...
PADDLE_MAGIC_WRITE_MONTHLY_PRICE_ID=pri_...
PADDLE_MAGIC_WRITE_YEARLY_PRICE_ID=pri_...
# 可选：逗号分隔的历史 Price ID，仅用于继续授权已有订阅
PADDLE_MAGIC_WRITE_LEGACY_PRICE_IDS=pri_legacy_...
REFUND_CONTACT_EMAIL=refunds@your-domain.example
```

`PADDLE_API_KEY` 和 `PADDLE_WEBHOOK_SECRET` 只能保存在 Railway Variables 中，不能进入浏览器、日志或仓库。`VITE_PADDLE_ENVIRONMENT` 必须与 `PADDLE_ENVIRONMENT` 一致；`VITE_PADDLE_CLIENT_TOKEN` 是 Paddle.js 使用的公开构建变量，但仍必须与环境匹配。Sandbox 和 Live 必须使用完全独立的 API key、Client Token、Product、Price 和 webhook。生产收费开启时，不得使用 `test_` Client Token 或 Sandbox API key。

### 可选
```env
PORT=1000
RSSHUB_BASE=https://rsshub.app
RSS_REFRESH_INTERVAL_MINUTES=30
RSS_MAX_CONCURRENCY=4
RSS_MEMORY_WARNING_MB=600
RSS_MEMORY_PAUSE_MB=700
RSS_MEMORY_RESUME_MB=550
NODE_OPTIONS=--max-old-space-size=768
RESEND_API_KEY=your-resend-key
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=your-app-password
BAIDU_TRANSLATE_APPID=your-appid
BAIDU_TRANSLATE_KEY=your-key
WRITE_AGENT_ALLOWED_MODELS=mimo-v2.5-pro
WRITE_AGENT_MAX_OUTPUT_TOKENS=2000
MEDIA_PROXY_RANGE_MB=8
MEDIA_PROXY_TIMEOUT_MS=20000
MEDIA_PROXY_USER_CONCURRENCY=2
MEDIA_PROXY_GLOBAL_CONCURRENCY=8
PAID_OPERATION_DAILY_LIMIT=100
PAID_OUTPUT_TOKENS_DAILY_LIMIT=200000
CANVAS_PDF_MAX_PAGES=100
```

> **注意**：Railway 会自动注入 `DATABASE_URL`（添加 PostgreSQL 插件后）。其他变量需要在 Railway Variables 面板手动添加。

### 发布前检查

- **Wait for CI**：GitHub checks 全部通过后再合并和部署。
- `SESSION_SECRET` 使用至少 32 个随机字符，`APP_URL` 使用正式 HTTPS 地址；`VITE_TLDRAW_LICENSE_KEY` 必须在构建阶段存在。
- Railway 的 `/api/health` 健康检查通过，且 `healthcheckTimeout` 已显式配置。
- Railway 会先运行 `npm run migrate`；迁移失败时不得启动新容器或绕过健康检查。Web 进程只验证迁移版本，不执行全量 DDL。
- Hobby 工作区在 Usage → Compute Usage 设置 US$10 邮件提醒与 US$30 hard limit。Hard limit 会停止整个工作区的 workload，只能在完成事故排查后临时调整。
- RSS 每轮完成后等待 30 分钟再刷新，单轮最多并发 4 个来源；连续三次达到 600 MB 会告警，首次达到 700 MB 会立即暂停刷新并向 `SECURITY_CONTACT_EMAIL` 告警。
- 每用户每日付费操作和输出 token 预留额度已写入 PostgreSQL；分钟级限流、全局并发、RSS 缓存和任务协调仍有单进程状态，因此 Railway 先保持 1 个 Web 副本。公开发布前完成 Cloudflare/WAF、Redis、对象存储、后台队列、监控告警和数据库备份；共享状态迁移并压测后再扩到 2 个以上副本。
- 本地或单进程内存限流只适合开发验证，不能替代多副本生产环境的共享限流和协调。

### Paddle 上线顺序

本地 UI 预检如需独立账号，可先运行 `npm run billing:setup:test-account`。命令只允许 loopback PostgreSQL，生成的账号凭据写入权限为 `0600` 的 `.env.billing.test-account`，不会输出密码，也不得用于生产。

1. 在 Paddle Sandbox 创建一枚最小权限 API Key，并准备一个转发到本机 `/api/billing/webhooks/paddle` 的公网 HTTPS 地址。把两项放入被 git 忽略的 `.env.paddle.sandbox`：

   ```env
   PADDLE_API_KEY=pdl_sdbx_apikey_...
   PADDLE_WEBHOOK_URL=https://your-temporary-tunnel.example/api/billing/webhooks/paddle
   ```

   运行 `npm run billing:setup:sandbox`。该命令只接受 Sandbox Key，并且只允许连接 loopback PostgreSQL；它会幂等创建/校验 `saas` 商品、`CNY amount=3900`（¥39/月）、`CNY amount=39900`（¥399/年）两档无试用自动续费价格、Client Token、精确事件 webhook 和本地隔离测试账号，再写入权限为 `0600`、被 git 忽略的 `.env.billing.sandbox`。可用 `npm run billing:verify:sandbox` 做只读 Paddle 复核；脚本不会设置 Live 资源或 Paddle Dashboard 的默认付款链接。
2. 在 Paddle Sandbox Dashboard 把 Default payment link 设置到一个始终加载 AtomFlow 前端的 HTTPS 页面，并创建至少五个关联上述 webhook destination 的 simulations；自动创建的 webhook 会精确订阅订阅创建/更新/激活/欠费/暂停/恢复/取消的生命周期事件，以及 `transaction.completed`、`transaction.payment_failed`、`adjustment.updated`，且接收真实平台与 simulation 事件。
3. 首次部署数据库与应用代码时保持 `BILLING_ENABLED=false`；确认旧用户数据、知识库和文章原子化没有受到 Pro 权限影响。
4. 在 Paddle Live 创建完全独立且同构的商品、价格、凭据和 webhook。Live 资源 ID 不能复用 Sandbox 值。
5. 在 Paddle 提交并获批 `www.atomflow.cloud`，把 `https://www.atomflow.cloud/?view=write` 设置为默认付款链接。Paddle 在 Live 创建交易前要求有效且已审批的付款链接域名。
6. 在 Railway 配置 Live 变量，并确认真实运营者名称和地址、`REFUND_CONTACT_EMAIL`、服务邮箱、隐私联系人、适用法律、数据地区与保留期限均已填写。缺少法律身份或账单配置时不得开启收费。
7. 验证 `/api/health`、生产 CSP、Paddle webhook 签名、未付款 Overlay Checkout、Customer Portal 和账户注销取消流程；随后再将 `BILLING_ENABLED=true`。
8. 每次收费相关部署后继续监控 Railway 日志、webhook inbox 和订阅对账任务，确认公网健康检查与基本结账冒烟测试均通过。

默认 `npm test` 不访问 Paddle，也不持有付款凭据。真实 Sandbox 测试必须显式设置 `RUN_REAL_BILLING_TESTS=true`，使用隔离测试账户和 Sandbox 凭据，覆盖成功卡、3DS、拒付、续费失败、Portal、取消、退款和 webhook。GitHub Actions 必须始终设置 `RUN_REAL_BILLING_TESTS=false`，不得注入本地或 Live 支付凭据。

启动 Sandbox 服务使用 `npm run billing:dev:sandbox`。在 `.env.billing.sandbox` 中补入至少五个 `PADDLE_SANDBOX_SIMULATION_IDS` 并显式把 `RUN_REAL_BILLING_TESTS` 改为 `true` 后，运行 `npm run billing:test:sandbox`。该测试验证本地 checkout 幂等、状态、Portal，并运行成功、付款失败、续费失败、取消和退款 webhook simulations。Overlay 成功卡、3DS 与拒付卡仍需在 Sandbox 浏览器中完成，因为它们依赖 Paddle 托管的支付交互；测试结果必须与 AtomFlow webhook inbox、最终 `/api/billing/status` 权限和本地账单缓存一并核对，不能只以 Paddle simulation 显示 completed 作为通过。

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
