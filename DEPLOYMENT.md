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
ALIPAY_SELLER_ID=...
ALIPAY_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
ALIPAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
ALIPAY_KEY_TYPE=PKCS8
ALIPAY_APP_AUTH_TOKEN=...
ALIPAY_NOTIFY_URL=https://www.atomflow.cloud/api/billing/webhooks/alipay
ALIPAY_RETURN_URL=https://www.atomflow.cloud/?view=write&billing_return=alipay
REFUND_CONTACT_EMAIL=refunds@your-domain.example
```

应用私钥、支付宝公钥和可选的 `ALIPAY_APP_AUTH_TOKEN` 只能保存在 Railway Variables 中，不能进入浏览器、日志或仓库。支付宝电脑网站支付使用生产网关 `https://openapi.alipay.com`。AtomFlow 不创建自动扣款协议：月包或年包均为一次付款、固定使用期，到期后由用户手动续费。

### 可选
```env
PORT=1000
RSSHUB_BASE=https://rsshub.app
RSS_REFRESH_INTERVAL_MINUTES=30
RSS_MAX_CONCURRENCY=4
RSS_MEMORY_WARNING_MB=600
RSS_MEMORY_PAUSE_MB=700
RSS_MEMORY_RESUME_MB=550
DB_PROBE_INTERVAL_SECONDS=30
ERROR_RATE_THRESHOLD_PERCENT=10
ERROR_RATE_MIN_REQUESTS=20
ALERT_MAX_PER_HOUR=10
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

### 监控与告警

全部运维告警都发往 `SECURITY_CONTACT_EMAIL`，先尝试 Resend，失败或超时后自动改用 Gmail SMTP。投递失败或被小时上限压制的告警会进入一个上限 5 条的积压队列，随下一封成功送达的邮件补报，所以告警内容不会因为一次投递失败而丢失。

| 监控 | 触发条件 | 检出时延 |
|---|---|---|
| RSS 内存 | 连续三次采样 ≥ 600 MB 告警；首次 ≥ 700 MB 暂停刷新 | 约 15 分钟 |
| 数据库连通性 | 连续 3 次 `SELECT 1` 探针失败（含 5 秒超时） | 约 90 秒 |
| 5xx 错误率 | 5 分钟窗口内 `/api/` 请求数 ≥ `ERROR_RATE_MIN_REQUESTS` 且 5xx 占比 ≥ `ERROR_RATE_THRESHOLD_PERCENT` | 约 30 秒 |

`/api/health` 会返回 `alerting.healthy`，用于确认告警链路本身是通的。**它在告警投递失败时仍然返回 200** —— Railway 用这个路径做部署门禁，让通知故障改变状态码会导致容器被杀，把通知问题升级成服务中断。

每次告警链路或邮件凭据变更后，应使用 Railway 注入的目标环境变量真实发送一封受控测试邮件：

```bash
ALLOW_LIVE_ALERT_TEST=true railway run --service atomflow --environment production npm run alert:test
```

脚本只向 `SECURITY_CONTACT_EMAIL` 发送一封主题为「告警链路真实测试」的邮件，并复用生产的 Resend → SMTP 通道；缺少显式开关时会拒绝执行，避免误发。

#### Railway 平台侧能做什么，不能做什么

Railway 没有基于日志的告警功能（任何套餐都没有），所以「告警投递失败」这类只体现在日志里的信号，平台侧无法直接推送。Observability 的 Monitors 只覆盖 CPU / RAM / 磁盘 / 出网流量的阈值告警，且**需要 Pro 套餐**，Hobby 用不了。

平台侧唯一可用的机制是**项目 Webhook**（项目 → Settings → Webhooks），它在部署状态变化时 POST 一个 JSON 到指定 URL，事件类型包括 `Deployment.failed`（构建或部署失败）和 `Deployment.crashed`（运行中的部署异常退出）。它**不发邮件**——只有 Slack 和 Discord 的 webhook URL 会被 Railway 自动转换成对应格式（Muxer）。

因此「进程没了要收到邮件」这一层，必须由 webhook 接收方把事件转成邮件，可选：

- 把 webhook 指向 AtomFlow 自身的接收端点，复用现有的告警发信通道。能完整覆盖 `Deployment.failed`（此时旧部署仍在服务，进程活着，收得到也发得出），部分覆盖 `Deployment.crashed`（重启后的实例可能收到）。
- 指向 Discord 或 Slack 的 incoming webhook，零代码，但通知落在聊天软件而不是邮箱。
- 部署一个独立的接收服务（官方建议放在另一个项目，以免被监控项目自身的故障拖垮）。

已知盲区：容器彻底消失且不再拉起、或进程存活但 Railway 边缘/DNS 层不可达时，任何自托管方案都无法自我上报——这一类只有进程外的独立探测能覆盖，本项目已明确不引入。

数据库探针刻意不做 `pg_try_advisory_xact_lock` 选主 —— 拿锁本身要走数据库，不可达时会永久静默，恰好废掉这个监控；重复告警由 `ALERT_MAX_PER_HOUR` 封顶。

### 支付宝单笔使用期上线顺序

1. 完成支付宝商户账号、网页应用创建与上线，并通过“AI 网页应用收款/电脑网站支付”线上验证；无需申请 AI 自动续费订阅准入。
2. 配置 RSA2 密钥。将应用私钥与支付宝公钥仅放在 Railway Variables；代码默认 `PKCS8`，如密钥确为 PKCS1 才修改 `ALIPAY_KEY_TYPE`。同时配置并核对真实 `ALIPAY_SELLER_ID`。
3. 在应用详情 → 开发设置中，把应用网关配置为 `https://www.atomflow.cloud/api/billing/webhooks/alipay`，确保电脑网站支付异步通知可以到达。不要把同步回跳地址当作应用网关。
4. 第一次发布与执行 `npm run migrate` 时保持 `BILLING_ENABLED=false`。此状态仅用于安全发布代码、迁移数据库和检查公开页面；它会旁路付费门槛，不能用于验证付费墙或到期只读。确认 `alipay_one_time_orders`、`alipay_one_time_entitlements` 和 `alipay_payment_notifications` 已建立后，再进入受控真实付款测试。
5. 在 Railway 配置全部支付宝变量与真实法律/联系信息。以受控账号分别完成月包、年包及提前续费的小额真实测试，确认金额、商户、应用、订单号和交易号全部匹配。
6. 验证通知签名失败返回 `fail`，合法重复通知幂等返回 HTTP 200 + `success`；浏览器回跳不得直接开通权益，必须等验签通知或 `alipay.trade.query` 主动查询确认。
7. 验证提前续费从已有到期时间向后顺延，过期后进入只读、手动续费恢复、账户注销和退款流程。完成后再设置 `BILLING_ENABLED=true`。

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
