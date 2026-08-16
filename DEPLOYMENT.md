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
BILLING_PROVIDER=alipay
ALIPAY_APP_ID=...
ALIPAY_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
ALIPAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
ALIPAY_KEY_TYPE=PKCS8
ALIPAY_APP_AUTH_TOKEN=...
ALIPAY_NOTIFY_URL=https://www.atomflow.cloud/api/billing/webhooks/alipay
ALIPAY_RETURN_URL=https://www.atomflow.cloud/?view=write&billing_return=alipay
ALIPAY_MAGIC_WRITE_PRODUCT_ID=...
ALIPAY_MAGIC_WRITE_MONTHLY_PRICE_ID=...
ALIPAY_MAGIC_WRITE_YEARLY_PRICE_ID=...
# 团队订阅全部配置后才会展示；商品必须配置 unit_label。
ALIPAY_TEAM_PRODUCT_ID=...
ALIPAY_TEAM_MONTHLY_PRICE_ID=...
ALIPAY_TEAM_YEARLY_PRICE_ID=...
ALIPAY_TEAM_MONTHLY_PRICE_CNY=...
ALIPAY_TEAM_YEARLY_PRICE_CNY=...
REFUND_CONTACT_EMAIL=refunds@your-domain.example
```

应用私钥、支付宝公钥和 `ALIPAY_APP_AUTH_TOKEN` 只能保存在 Railway Variables 中，不能进入浏览器、日志或仓库。支付宝周期订阅使用生产网关 `https://openapi.alipay.com`；本地验证也不能切换到虚构的 Sandbox 网关。新商户必须完成代调用授权，且应用网关和消息订阅缺一不可。

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

### 支付宝订阅上线顺序

1. 完成支付宝商户账号、应用创建与上线，并开通 APP 支付或电脑网站支付能力；提交并通过周期订阅产品准入。新商户同时完成代调用授权。
2. 创建个人订阅商品与月付、12 个月年付价格。个人创建请求不传 `quantity`。创建团队商品时配置 `unit_label`，再创建团队按席位月付/年付价格；团队创建请求的 `quantity` 必须大于 1。
3. 配置 RSA2 密钥。将应用私钥与支付宝公钥仅放在 Railway Variables；代码默认 `PKCS8`，如密钥确为 PKCS1 才修改 `ALIPAY_KEY_TYPE`。
4. 在应用详情 → 开发设置中，把**应用网关**配置为 `https://www.atomflow.cloud/api/billing/webhooks/alipay`，并在消息订阅中勾选 `alipay.trade.subscription.changed` 和退款相关通知。不要把授权回调地址误当成应用网关。
5. 第一次发布与执行 `npm run migrate` 时保持 `BILLING_ENABLED=false`。确认新表、公开套餐页、登录门槛和已有写作数据的只读保护正常。
6. 在 Railway 配置全部支付宝变量与真实法律/联系信息。先使用受控测试客户和明确的小额真实价格完成签约、生效通知、续费查询、周期末取消、退款、账户注销、团队扩容与缩容测试。
7. 验证通知签名失败返回 `fail`，合法重复通知幂等返回 HTTP 200 + `success`；浏览器返回页不得直接开通权益，必须等验签通知或主动查询。
8. 验证团队扩容立即生效、缩容下周期生效，并确认每次变更后的最新 `item_id` 已通过查询/通知保存。完成后再设置 `BILLING_ENABLED=true`。

旧 Paddle 服务端与数据表暂时保留为一个发布周期的只读回滚路径；当 `BILLING_PROVIDER=alipay` 时不会加载 Paddle.js、创建 Paddle 结账或授予 Paddle 新订阅权限。确认支付宝生产闭环稳定后再单独清理旧依赖与历史运维脚本。

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
