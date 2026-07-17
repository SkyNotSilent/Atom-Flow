# AtomFlow（原子流）

**让每一篇看过的知识，都成为可复用的创作资产。**

AtomFlow 是一个前后端一体的知识工作台，把 RSS 阅读、原文保存、原子卡片和 AI 辅助创作连接起来。当前写作体验是基于 tldraw 的**魔法写作无限画布**：用户把文章、卡片、笔记、文本、文件和图片放到画布上，通过连线明确授权给写作 Agent 的上下文，并自行决定哪些输出保存为新的画布资产。

## 核心链路

1. **输入**：聚合内置或自定义 RSS，抓取并阅读正文。
2. **沉淀**：保存原文，通过 AI 或规则回退拆解为观点、数据、金句和故事卡片。
3. **创作**：在无限画布中组合可见素材，连接写作 Agent，生成并保存可继续编辑的结果。

## 主要能力

### 今日推送

- RSS 聚合、来源筛选和自定义订阅
- Readability + JSDOM 全文提取
- 文章、图片、音频来源信息和发布时间解析
- 稳定文章标识、去重和按用户持久化

### 知识库

- 保存原文、引用上下文和来源图片
- 观点、数据、金句、故事四类原子卡片
- AI 原子化失败时可回退到规则提取
- 手动创建、编辑、删除和来源回溯
- 为未来知识关系保留 `supports`、`conflicts`、`extends` 边

### 魔法写作无限画布

- 基于 tldraw 的缩放、平移和节点布局
- 画布节点支持收藏文章、原子卡、笔记、粘贴文本、文件、图片、Agent 和结果
- 通过连线控制某个 Agent 可读取的上下文，而不是默认提交整个知识库
- Agent 模板支持模型、系统提示词、`temperature`、`top_p` 和 `max_tokens`
- 支持文本和可选视觉上下文；模型不支持图片时使用提取文本/用户说明回退
- Agent 对话结果由用户手动保存回画布
- 项目、节点、连线、视口、资产、Agent 配置和消息持久化到 PostgreSQL

> 生产环境启用无限画布必须遵守 tldraw 许可证并提供适当、有效的 `VITE_TLDRAW_LICENSE_KEY`。AtomFlow 的 MIT License 不会把 tldraw 重新许可为 MIT。参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [`LICENSES/TLDRAW_LICENSE.md`](LICENSES/TLDRAW_LICENSE.md)。

### 用户和辅助服务

- 邮箱验证码、密码登录、找回密码和 PostgreSQL Session
- 昵称、头像、主题、视图和来源布局偏好
- 可选百度翻译
- 可选火山引擎 ASR 实时语音转文字
- Resend 或 SMTP 验证码邮件

## 技术栈

- Frontend：React、Vite、TypeScript、Tailwind、tldraw
- Backend：Express、Node.js 22+、RSS Parser、Readability、JSDOM
- Database：PostgreSQL（`pg` 参数化查询，无 ORM）；可选 pgvector
- AI：MiMo Token Plan 的 OpenAI-compatible API；写作运行时使用 OpenAI Agents SDK，并可覆盖为官方 OpenAI 配置
- Auth：`express-session`、`connect-pg-simple`、`bcryptjs`
- Email：Resend 或 SMTP
- Deploy：Railway + PostgreSQL

## 数据流概览

```text
RSS / 网页
    -> 今日推送与全文提取
    -> 保存原文
    -> AI 原子化或规则回退
    -> 原子卡片 / 笔记
    -> 魔法写作无限画布
    -> 连接到写作 Agent
    -> 用户确认后保存结果
```

AI、翻译、语音和邮件功能会向部署实例配置的第三方供应商发送完成请求所需的数据。公开部署必须披露实际供应商并在功能发生前提供就地告知，详见 [PRIVACY.md](PRIVACY.md)。

## 快速开始

### 环境要求

- Node.js 22+
- PostgreSQL 14+

### 安装

```bash
git clone https://github.com/SkyNotSilent/Atom-Flow.git
cd Atom-Flow
npm ci
cp .env.example .env
```

至少配置：

```env
DATABASE_URL=postgresql://user:password@localhost:5432/atomflow
SESSION_SECRET=replace-with-a-random-secret
AI_API_KEY=your-api-key
AI_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1
AI_MODEL=mimo-v2.5-pro
```

本地启动：

```bash
npm run dev
```

本地固定访问 `http://localhost:1000`。如果端口被占用，先确认并停止旧的 AtomFlow 进程，不要临时修改项目端口。

## AI 配置

知识原子化默认读取：

```env
AI_API_KEY
AI_BASE_URL
AI_MODEL
```

写作 Agent 默认复用以上 OpenAI-compatible 配置。要覆盖为官方 OpenAI，可设置：

```env
OPENAI_API_KEY
OPENAI_MODEL
```

MiMo 模型 ID 会在请求前规范为小写。调试真实 AI 原子化时可临时设置 `DISABLE_AI_FALLBACK=true`；此时远端调用失败会返回 `502`，不会创建规则回退卡片。

## 可选服务

```env
# 邮件（二选一）
RESEND_API_KEY=...
SMTP_USER=...
SMTP_PASS=...

# 翻译
BAIDU_TRANSLATE_APPID=...
BAIDU_TRANSLATE_KEY=...

# 实时语音识别
VOLCENGINE_ASR_APPID=...
VOLCENGINE_ASR_TOKEN=...
VOLCENGINE_ASR_CLUSTER=volcengine_streaming_common

# 自定义 RSSHub
RSSHUB_BASE=https://rsshub.app

# 生产无限画布
VITE_TLDRAW_LICENSE_KEY=...
```

不要把真实密钥提交到仓库。

## 数据库

核心表包括：

| 表 | 用途 |
| --- | --- |
| `users` / `verification_codes` / `session` | 账号、验证和登录会话 |
| `user_subscriptions` / `user_articles` | 自定义 RSS 与用户文章 |
| `saved_articles` / `saved_cards` | 保存原文与原子卡片 |
| `notes` / `user_preferences` | 笔记与用户偏好 |
| `write_style_skills` | 可复用写作/提取指令 |
| `write_canvas_projects` / `write_canvas_nodes` / `write_canvas_edges` | 无限画布结构 |
| `write_canvas_assets` | 画布文本、文件、图片和提取文本 |
| `write_agent_templates` / `write_agent_instances` / `write_canvas_agent_messages` | 画布 Agent 配置与对话 |

数据库查询直接使用 `pool.query`，写入必须参数化并按 `user_id` 隔离。

## 验证命令

```bash
npx tsc --noEmit
npm run lint
npm run build
npx tsx tests/subscriptions.test.ts
```

涉及安全、上传、认证或部署的修改还应运行对应的定向测试。

## Railway 部署

1. 从 GitHub 创建 Railway 服务并添加 PostgreSQL。
2. 在 Railway Variables 中配置 `DATABASE_URL`、强随机 `SESSION_SECRET`、AI 配置、`APP_URL` 和精确的 `ALLOWED_ORIGINS`。
3. 如启用魔法写作画布，配置与实际授权匹配的 `VITE_TLDRAW_LICENSE_KEY`。
4. 使用 `railway.json` 的 `/api/health` 健康检查，并等待部署和 CI 通过。
5. 公共发布前完成 WAF/边缘限流、监控告警、数据库备份恢复演练和供应商审查。

当前进程内 RSS 状态、限流和任务协调不适合多副本共享。完成 Redis/队列/共享对象存储迁移和负载测试前，保持单 Web 副本。

## 公开部署前必做

- 替换 [SECURITY.md](SECURITY.md)、[PRIVACY.md](PRIVACY.md) 和 [TERMS.md](TERMS.md) 中的运营者、联系人、地区和保留期占位符。
- 在 AI、翻译、语音、上传、邮件和自定义 RSS 操作前提供清晰的就地告知。
- 只披露实际启用的供应商，并核对其数据保留、地区、子处理方和合同。
- 建立账号删除/导出人工流程；当前代码没有完整自助账号注销入口。
- 验证日志不会记录密钥、完整验证码、正文、音频或不必要的个人信息。
- 取得适当的 tldraw 生产许可证密钥，不绕过其技术措施。

本项目不声称通过任何安全、隐私或合规认证。部署运营者应根据服务地区、用户和数据类型取得独立专业意见。

## 安全、隐私与条款

- [安全政策](SECURITY.md)
- [隐私说明](PRIVACY.md)
- [服务条款](TERMS.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [对外发布说明](docs/README_PUBLIC.md)

## 许可证

AtomFlow 项目自有代码默认按根目录 [LICENSE](LICENSE) 的 MIT License 提供，**明确标注为其他许可证的组件、文件和第三方依赖除外**。

尤其是，魔法写作无限画布所用的 tldraw 受 tldraw 自有许可证约束；生产使用需要适当、有效的许可证密钥。AtomFlow 的 MIT License 不覆盖或重新许可 tldraw。完整信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [`LICENSES/TLDRAW_LICENSE.md`](LICENSES/TLDRAW_LICENSE.md)。
