# AtomFlow（原子流）

**让每一篇看过的知识，都成为复利资产**

AtomFlow 是一款面向内容创作者与 AI 从业者的**知识工作台**，通过 AI Agent 编排打通「信息消费 → 知识沉淀 → 内容创作」的完整闭环。

---

## 核心价值

AI 领域信息迭代极快，内容创作者需要持续输出有质量的内容。我们解决的核心问题是：**信息太多太快，看不完、记不住、用不上**。

### 我们的解法

- **输入层**：RSS 聚合 + 全文抓取，一站式阅读体验
- **沉淀层**：AI 自动拆解为原子卡片（观点/数据/金句/故事），按主题沉淀到知识库
- **输出层**：写作助手根据主题智能召回相关卡片，辅助生成有个人风格的文章

### 技术特色

- ✅ **真实可用的 AI 原子化**：已接入生产环境 AI API，实现文章到卡片的自动拆解
- ✅ **完整的数据持久化**：PostgreSQL 存储原文、卡片、用户偏好、对话历史
- ✅ **LangGraph 多 Agent 编排**：知识原子化、写作助手、风格定制三个 Agent 协同工作
- ✅ **对话历史管理**：支持多线程对话，Chat 和 Skills 独立历史记录
- ✅ **结构化日志**：Pino 日志系统，便于生产环境调试

---

## AI Agent 架构设计

AtomFlow 的核心竞争力在于三个协同工作的 AI Agent，它们分别负责知识原子化、写作辅助和风格定制，形成完整的知识工作流。

### 🧩 Agent 1: 知识原子化 Agent（Knowledge Atomization Agent）

**职责**：将长文章拆解为可复用的原子卡片

**工作流程**：
```
用户点击「原子化存入知识库」
    ↓
全文内容提取（Readability + JSDOM）
    ↓
AI 分析文章结构与语义
    ↓
智能拆分为四类卡片：
    • 观点卡片 — 核心论点与判断
    • 数据卡片 — 数字、统计、研究结果
    • 金句卡片 — 可直接引用的精彩表达
    • 故事卡片 — 案例、场景、叙事片段
    ↓
保存到知识库（PostgreSQL）
```

**设计亮点**：
- **语义理解**：不是简单的段落切分，而是理解内容类型和价值
- **保留上下文**：每张卡片记录原文出处（`saved_article_id`），点击可回溯完整语境
- **去重机制**：相似卡片自动合并，避免知识库冗余
- **Fallback 机制**：AI 失败时自动降级到规则提取，确保功能可用性
- **真实生产环境**：已接入 OpenAI-compatible API（qwen3.6-plus），实测可用

**数据库设计**：
```sql
-- 原文存储
saved_articles (id, title, url, content, citation_context, saved_at)

-- 卡片存储
saved_cards (
  id, type, content, summary, tags,
  saved_article_id,  -- 外键关联原文
  origin             -- 'ai' | 'manual'
)
```

---

### ✍️ Agent 2: 写作助手 Agent（Writing Assistant Agent）

**职责**：基于知识库素材辅助用户创作

**LangGraph 架构**（8 个节点的状态图）：

```
START
  ↓
hydrate_context（加载用户上下文）
  ↓
load_effective_skills（加载生效的写作风格）
  ↓
classify_intent（分类用户意图：写作 / 问答 / 修改）
  ↓
retrieve_knowledge（从知识库检索相关卡片）
  ↓
enrich_sources（补充卡片的原文语境）
  ↓
decide_next（决策：生成内容 / 追问澄清）
  ↓
generate_answer_or_draft（生成回复或文章草稿）
  ↓
persist_memory（保存对话记忆）
  ↓
respond（流式返回给用户）
  ↓
END
```

**设计亮点**：
- **意图分类**：区分「写一篇文章」vs「这段话怎么改」vs「解释一个概念」
- **智能召回**：根据写作主题从知识库检索相关卡片（关键词匹配 + 未来支持向量语义搜索）
- **原文引用**：生成内容时保留卡片来源，用户可追溯到原始文章
- **对话记忆**：支持多轮对话，理解「再详细点」「换个角度」等指令
- **Thread 管理**：每个对话独立存储（`write_agent_threads` 表），支持历史对话切换
- **流式输出**：60 秒超时保护，实时返回生成进度

**数据库设计**：
```sql
-- 对话线程
write_agent_threads (
  id, user_id, title, state, thread_type,  -- 'chat' | 'skill'
  created_at, updated_at
)

-- 对话消息
write_agent_messages (
  id, thread_id, role, content, meta,  -- meta 存储工具调用结果
  created_at
)
```

**技术实现**：
- LangGraph 状态图管理复杂流程
- PostgreSQL 持久化对话历史
- 左侧边栏 + 右侧面板双重历史对话入口
- 对话标题自动使用用户首条消息命名

**协作机制**：
- 与 Agent 1 协作：读取知识库中的原子卡片
- 与 Agent 3 协作：应用用户自定义的写作风格

---

### 🎨 Agent 3: 风格定制 Agent（Style Customization Agent）

**职责**：将用户的风格描述转化为可执行的写作指令

**LangGraph 架构**（5 个节点的顺序流）：

```
START
  ↓
analyze_user_input（分析输入类型：描述 / 样本 / 混合）
  ↓
extract_style_features（提取风格特征）
  • 语气特点（专业 / 轻松 / 严谨 / 幽默）
  • 结构偏好（总分总 / 场景开头 / 数据驱动）
  • 引用风格（学术引用 / 口语化 / 不引用）
  • 约束规则（必须有数据 / 不用排比 / 讲机制和取舍）
  ↓
generate_skill_draft（生成结构化 Skill 定义）
  • name: 风格名称（如「产品经理面试体」）
  • description: 适用场景说明
  • prompt: 详细的写作指令
  • constraints: 3-5 条具体约束
  • examples: 1-3 个表达示例
  ↓
validate_and_format（校验字段长度与质量）
  ↓
respond_with_preview（返回草案供用户确认）
  ↓
END
```

**设计亮点**：
- **自然语言理解**：用户只需描述「像产品经理面试复盘，必须讲机制和取舍」，AI 自动生成结构化指令
- **样本分析**：支持粘贴一段文字，AI 分析其风格特征并生成 Skill
- **即时生效**：确认后立即保存到数据库，写作助手 Agent 下次调用时自动应用
- **独立对话历史**：Skills 助手有独立的 thread 管理，与 Chat 助手分离
- **结构化存储**：Skill 包含 name、description、prompt、constraints、examples 五个字段

**数据库设计**：
```sql
write_style_skills (
  id, user_id, name, type, description,
  prompt,        -- 详细的写作指令
  constraints,   -- 3-5 条具体约束（JSON 数组）
  examples,      -- 1-3 个表达示例（JSON 数组）
  visibility,    -- 'system' | 'user'
  is_default,    -- 是否默认启用
  created_at, updated_at
)
```

**UI 设计**：
- 左侧边栏：Skills 工作区切换 + 历史对话列表
- 右侧面板：Skills 助手对话 + 草案预览 + 一键创建
- 中间区域：风格库管理 + 示例 Prompt 轮播

**协作机制**：
- 生成的 Skill 存入 `write_style_skills` 表
- Agent 2 在 `load_effective_skills` 节点读取并注入到生成指令中

---

### 三个 Agent 的协作流程

```
┌─────────────────────────────────────────────────────────────┐
│                     用户工作流                                │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Agent 1     │    │  Agent 3     │    │  Agent 2     │
│  知识原子化   │    │  风格定制     │    │  写作助手     │
└──────────────┘    └──────────────┘    └──────────────┘
        │                   │                   │
        │ 生成卡片           │ 生成 Skill         │ 读取卡片
        ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                    PostgreSQL 数据库                          │
│  • saved_cards（原子卡片）                                     │
│  • write_style_skills（写作风格）                              │
│  • saved_articles（原文存档）                                  │
└─────────────────────────────────────────────────────────────┘
```

**典型使用场景**：

1. **信息消费阶段**：用户在「今日推送」看到一篇文章 → 点击「原子化存入知识库」→ **Agent 1** 拆解为卡片
2. **风格定制阶段**：用户在「写作页」点击「Skills 助手」→ 描述「像产品经理面试复盘，必须讲机制和取舍」→ **Agent 3** 生成风格 Skill
3. **内容创作阶段**：用户在「写作页」输入「写一篇关于知识管理的文章」→ **Agent 2** 从知识库召回相关卡片 → 应用用户的风格 Skill → 生成草稿

---

## 技术架构

### 前端
- **React 18 + TypeScript + Vite**：现代化前端工具链
- **Tailwind CSS**：原子化 CSS，快速构建 UI
- **Context API**：全局状态管理（用户、订阅源、知识库）

### 后端
- **Express + Node.js**：轻量级 API 服务
- **PostgreSQL**：关系型数据库，直接使用 `pg` pool（无 ORM）
- **LangGraph**：AI Agent 状态图编排框架（来自 LangChain 生态）
- **RSS Parser + Readability**：RSS 订阅聚合 + 全文提取

### AI 能力
- **OpenAI 兼容 API**：支持任何兼容 OpenAI 格式的 LLM 服务
- **流式输出**：Server-Sent Events (SSE) 实现打字机效果
- **未来扩展**：pgvector 向量搜索（语义检索卡片）

---

## 内置订阅源

AtomFlow 的信息源覆盖中英文双语，打通国内媒体、海外科技博客、X（Twitter）、YouTube 和播客。

### 🇨🇳 国内媒体
- **36氪** — 创投商业资讯
- **虎嗅** — 商业深度分析
- **少数派** — 科技生活方式
- **人人都是产品经理** — 产品运营知识

### 🐦 X（Twitter）
- **Sam Altman** — OpenAI CEO

### 🎥 YouTube
- **Y Combinator** — 创业孵化器官方频道
- **Andrej Karpathy** — AI 研究与教学
- **Lex Fridman** — AI & 科技深度对话

### 🎙️ 播客
- **张小珺商业访谈录** — 深度商业访谈节目

### 📮 公众号
- **数字生命卡兹克** — 科技人文思考
- **新智元** — AI 前沿资讯

### 💻 其他
- **GitHub Blog** — 技术前沿动态

---

## 核心功能

### 📰 今日推送（信息聚合层）

**RSS 订阅聚合**
- 内置 20+ 优质信息源（36氪、虎嗅、少数派、GitHub Blog、Y Combinator 等）
- 支持用户自定义 RSS 订阅源（`user_subscriptions` 表持久化）
- 全文抓取（Readability + JSDOM）：自动提取正文、图片、发布时间
- 播客支持：YouTube、播客 RSS 自动解析音频链接和时长
- 智能去重：基于 URL 和标题的文章去重机制

**阅读体验**
- 双栏布局：左侧文章列表 + 右侧全文阅读
- Markdown 渲染：支持代码高亮、表格、引用块
- 图片懒加载：优化长文章加载性能
- 收藏标记：一键保存感兴趣的文章到知识库

---

### 🧠 知识库（知识沉淀层）

**AI 原子化（Agent 1）**
- **真实生产环境 AI**：接入 OpenAI-compatible API（qwen3.6-plus），实测可用
- **智能拆解**：将长文章自动拆分为四类原子卡片
  - 观点卡片 — 核心论点与判断
  - 数据卡片 — 数字、统计、研究结果
  - 金句卡片 — 可直接引用的精彩表达
  - 故事卡片 — 案例、场景、叙事片段
- **语义理解**：不是简单段落切分，而是理解内容类型和价值
- **原文关联**：每张卡片记录 `saved_article_id`，点击可回溯完整语境
- **Fallback 机制**：AI 失败时自动降级到规则提取，确保功能可用性
- **去重机制**：相似卡片自动合并，避免知识库冗余

**卡片管理**
- **横向布局**：圆点 + 类型标识替代竖条，视觉更清爽
- **多维筛选**：按类型（观点/数据/金句/故事）、标签、来源文章筛选
- **原文追溯**：点击卡片可跳转到原始文章的完整上下文
- **手动编辑**：支持手动创建、编辑、删除卡片
- **数据持久化**：`saved_cards` 表存储，`origin` 字段区分 AI 生成 vs 手动创建

**原文存档**
- **完整保存**：`saved_articles` 表存储原文标题、URL、正文、引用上下文
- **引用追溯**：卡片通过 `saved_article_id` 外键关联原文
- **图片保留**：`sourceImages` 字段保存原文配图 URL

**知识图谱**
- **卡片关联**：`card_relations` 表存储卡片之间的关系
- **关系类型**：
  - `supports` — 卡片 A 支持卡片 B 的观点
  - `conflicts` — 卡片 A 与卡片 B 的观点冲突
  - `extends` — 卡片 A 扩展了卡片 B 的内容
- **置信度**：`confidence` 字段（0-1）表示关系的可信度
- **级联删除**：卡片删除时自动清理相关的关联关系
- **唯一约束**：同一对卡片的同一类型关系只能存在一次

---

### ✍️ 写作页（内容创作层）

**Chat 助手（Agent 2）**
- **LangGraph 编排**：8 个节点的状态图（意图分类 → 知识召回 → 生成回复）
- **智能召回**：根据写作主题从知识库检索相关卡片（关键词匹配）
- **原文引用**：生成内容时保留卡片来源，用户可追溯到原始文章
- **对话记忆**：支持多轮对话，理解「再详细点」「换个角度」等指令
- **Thread 管理**：
  - 每个对话独立存储（`write_agent_threads` 表，`thread_type = 'chat'`）
  - 左侧边栏 + 右侧面板双重历史对话入口
  - 对话标题自动使用用户首条消息命名
  - 支持历史对话切换，刷新页面后自动加载最近对话
- **流式输出**：Server-Sent Events (SSE) 实现打字机效果，60 秒超时保护

**Skills 助手（Agent 3）**
- **风格定制**：将用户的风格描述转化为可执行的写作指令
- **自然语言理解**：用户只需描述「像产品经理面试复盘，必须讲机制和取舍」，AI 自动生成结构化指令
- **样本分析**：支持粘贴一段文字，AI 分析其风格特征并生成 Skill
- **即时生效**：确认后立即保存到 `write_style_skills` 表，写作助手下次调用时自动应用
- **独立对话历史**：
  - Skills 助手有独立的 thread 管理（`thread_type = 'skill'`）
  - 左侧边栏根据工作区模式（Chat / Skills）动态切换历史对话列表
  - 右侧面板显示 Skills 助手对话 + 草案预览 + 一键创建
- **结构化存储**：Skill 包含 name、description、prompt、constraints、examples 五个字段

**工作区切换**
- **双模式**：Chat 工作区（写作助手）+ Skills 工作区（风格定制）
- **独立历史**：左侧边栏历史对话列表根据当前工作区模式动态过滤
- **状态隔离**：Chat 和 Skills 的对话历史、消息记录完全独立

---

### 👤 用户系统

**认证方式**
- **邮箱验证码登录**：Resend API / Gmail SMTP 发送 OTP
- **密码登录**：bcrypt 加密存储，支持忘记密码功能
- **Session 管理**：express-session + connect-pg-simple（PostgreSQL 存储）

**个人设置**
- **头像管理**：base64 存储到数据库，解决部署后头像丢失问题
- **昵称修改**：支持自定义昵称
- **偏好同步**：主题（亮色/暗色）、视图模式、订阅源布局等偏好存储到 `user_preferences` 表

**数据隔离**
- 用户自定义订阅源（`user_subscriptions`）与内置订阅源隔离
- 用户文章（`user_articles`）与全局文章缓存隔离
- 知识库卡片（`saved_cards`）按用户 ID 隔离

---

## 快速开始

### 环境要求
- Node.js 20+
- PostgreSQL 14+

### 本地运行

```bash
# 1. 克隆项目
git clone https://github.com/SkyNotSilent/Atom-Flow.git
cd Atom-Flow

# 2. 安装依赖
npm install

# 3. 配置环境变量（创建 .env 文件）
DATABASE_URL=postgresql://user:password@localhost:5432/atomflow
AI_API_KEY=your_api_key
AI_BASE_URL=https://api.openai.com
AI_MODEL=gpt-4

# 4. 启动开发服务器
npm run dev
```

访问 `http://localhost:3002` 即可使用。

---

## 部署

AtomFlow 是全栈应用（前端 + 后端），需要支持 Node.js 的平台。

### Railway（推荐）
1. 访问 [Railway.app](https://railway.app)
2. 连接 GitHub 仓库
3. 添加 PostgreSQL 插件
4. 配置环境变量（已配置 `railway.json`）

### Render
1. 访问 [Render.com](https://render.com)
2. 创建 Web Service，连接仓库（已配置 `render.yaml`）

---

## 项目结构

```text
AtomFlow/
├── src/
│   ├── components/      # React 组件
│   ├── pages/           # 页面（推送、知识库、写作）
│   ├── context/         # 全局状态
│   ├── utils/           # 工具函数
│   └── types.ts         # 类型定义
├── server.ts            # Express 后端 + AI Agent 实现
├── tests/               # 测试文件
├── package.json
└── README.md
```

---

## 开发路线图

### 已完成 ✅

**核心功能**
- ✅ RSS 订阅聚合与全文阅读（Readability + JSDOM）
- ✅ 用户自定义订阅源（`user_subscriptions` 表持久化）
- ✅ 播客支持（YouTube、播客 RSS 音频解析）
- ✅ AI 知识卡片自动拆分（Agent 1 + Fallback 机制）
- ✅ 原文存档与引用追溯（`saved_articles` 表 + `saved_article_id` 外键）
- ✅ 卡片横向布局优化（圆点 + 类型标识）
- ✅ 写作助手 LangGraph 架构（Agent 2，8 个节点状态图）
- ✅ 风格定制 AI 助手（Agent 3，LangGraph 5 个节点）
- ✅ PostgreSQL 数据持久化（10+ 张表）

**对话历史管理**
- ✅ Chat 助手 Thread 管理（`write_agent_threads` 表，`thread_type = 'chat'`）
- ✅ Skills 助手 Thread 管理（`thread_type = 'skill'`）
- ✅ 左侧边栏历史对话列表（根据工作区模式动态过滤）
- ✅ 右侧面板历史对话入口（Chat / Skills 独立）
- ✅ 对话标题自动命名（用户首条消息前 24 字符）
- ✅ 历史对话切换与持久化（刷新页面后自动加载）

**用户系统**
- ✅ 邮箱验证码登录（Resend API / Gmail SMTP）
- ✅ 密码登录 + 忘记密码功能（bcrypt 加密）
- ✅ 头像 base64 存储（解决部署后头像丢失）
- ✅ 用户偏好同步（主题、视图模式、订阅源布局）
- ✅ Session 管理（express-session + connect-pg-simple）

**工程化**
- ✅ 结构化日志（Pino）
- ✅ 集成测试（存入知识库流程、订阅源管理）
- ✅ SEO 优化（meta 标签、favicon）
- ✅ Railway 部署配置（`railway.json` + PostgreSQL 插件）

**知识图谱**
- ✅ `card_relations` 表（supports/conflicts/extends 关系类型）
- ✅ 卡片关联关系存储（card_a、card_b、relation_type、confidence）
- ✅ 级联删除（卡片删除时自动清理关联关系）

**Skills 系统**
- ✅ Skills 助手完整实现（Agent 3 + LangGraph 编排）
- ✅ Skills CRUD API（`/api/write/agent/skills`）
- ✅ Skills Thread 管理（`thread_type = 'skill'`）
- ✅ 独立对话历史（左侧边栏 + 右侧面板）
- ✅ 风格 Skill 生成与应用（`write_style_skills` 表）

### 开发中 ⏳
- ⏳ 向量语义搜索（pgvector + OpenAI Embeddings）
- ⏳ 知识图谱可视化（卡片关联关系图）
- ⏳ 多模态支持（图片、视频内容提取）
- ⏳ 笔记模块完善（Markdown 编辑器 + 卡片引用）

---

## 常见问题

### 技术架构

**Q: 为什么选择 LangGraph 而不是简单的 Prompt Chain？**  
LangGraph 提供状态管理、条件分支、循环控制等能力，适合复杂的多步骤 Agent。例如写作助手需要根据意图分类决定是否检索知识库，这种条件逻辑用 Prompt Chain 难以实现。

具体优势：
- **状态持久化**：每个节点的输出可以保存到 `state` 对象，后续节点可以读取
- **条件路由**：`decide_next` 节点根据意图分类结果决定下一步是生成内容还是追问澄清
- **循环控制**：支持多轮对话，`persist_memory` 节点保存对话历史到数据库
- **可观测性**：每个节点的执行时间、输入输出都可以记录到 `graphTrace`，便于调试

**Q: 三个 Agent 是并行运行还是串行？**  
Agent 1 和 Agent 3 是用户主动触发的独立任务，Agent 2 在运行时会读取前两者的产出（卡片和 Skill），但不会调用它们。

协作机制：
- **Agent 1 → Agent 2**：Agent 1 生成的卡片存入 `saved_cards` 表，Agent 2 的 `retrieve_knowledge` 节点通过关键词匹配从该表检索相关卡片
- **Agent 3 → Agent 2**：Agent 3 生成的 Skill 存入 `write_style_skills` 表，Agent 2 的 `load_effective_skills` 节点读取并注入到生成指令中
- **数据库作为中介**：三个 Agent 通过 PostgreSQL 表进行数据交换，而非直接调用

**Q: 如何保证 AI 生成内容的质量？**  
- **Agent 1 有 fallback 机制**：AI 失败时使用规则提取（正则匹配观点、数据、金句、故事）
- **Agent 2 有验证节点**：`enrich_sources` 节点检查生成内容是否引用了知识库，未引用时会追问用户
- **Agent 3 有字段校验**：`validate_and_format` 节点确保生成的 Skill 符合长度和格式要求（name ≤ 50 字符，constraints 3-5 条）
- **流式输出 + 超时保护**：Agent 2 使用 SSE 流式返回，60 秒超时防止长时间等待

**Q: Thread 管理是如何实现的？**  
使用 `write_agent_threads` 表存储对话线程，`thread_type` 字段区分 Chat 和 Skills：

```sql
CREATE TABLE write_agent_threads (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  state JSONB DEFAULT '{}',
  thread_type TEXT DEFAULT 'chat' CHECK (thread_type IN ('chat', 'skill')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

前端根据 `writeWorkspaceMode` 动态过滤：
- Chat 工作区：只显示 `thread_type = 'chat'` 的历史对话
- Skills 工作区：只显示 `thread_type = 'skill'` 的历史对话

左侧边栏和右侧面板都有历史对话入口，切换对话时调用 `hydrateThreadMessages` 从 `write_agent_messages` 表加载历史消息。

### 数据存储

**Q: 数据存储在哪里？**  
使用 PostgreSQL 数据库存储用户数据、知识卡片、收藏原文等。部署时需配置 `DATABASE_URL` 环境变量。

核心表结构：
- `users` — 用户账号（email、nickname、avatar_url、password_hash）
- `saved_articles` — 原文存档（title、url、content、citation_context、source_images）
- `saved_cards` — 原子卡片（type、content、summary、tags、saved_article_id、origin）
- `card_relations` — 卡片关联（card_a、card_b、relation_type、confidence）
- `write_agent_threads` — 对话线程（title、state、thread_type）
- `write_agent_messages` — 对话消息（thread_id、role、content、meta）
- `write_style_skills` — 风格 Skill（name、description、prompt、constraints、examples）
- `user_subscriptions` — 自定义订阅源（feed_url、title、category）
- `user_preferences` — 用户偏好（theme、view_mode、source_layout）

**Q: 知识图谱是如何实现的？**  
使用 `card_relations` 表存储卡片之间的关系：

```sql
CREATE TABLE card_relations (
  id              SERIAL PRIMARY KEY,
  card_a          TEXT NOT NULL REFERENCES saved_cards(id) ON DELETE CASCADE,
  card_b          TEXT NOT NULL REFERENCES saved_cards(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL CHECK (relation_type IN ('supports','conflicts','extends')),
  confidence      REAL DEFAULT 0.5,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (card_a, card_b, relation_type)
);
```

**关系类型说明**：
- `supports`：卡片 A 的观点支持卡片 B（例如：数据卡片支持观点卡片）
- `conflicts`：卡片 A 与卡片 B 的观点冲突（例如：两个相反的观点）
- `extends`：卡片 A 扩展了卡片 B 的内容（例如：故事卡片扩展观点卡片）

**设计亮点**：
- **外键约束**：`card_a` 和 `card_b` 都引用 `saved_cards(id)`，确保数据完整性
- **级联删除**：卡片删除时自动清理相关的关联关系
- **唯一约束**：防止重复创建相同的关系
- **置信度**：`confidence` 字段支持未来的 AI 自动关联（0-1 表示可信度）

**Q: 为什么不用 ORM？**  
直接使用 `pg` pool 的原因：
- **性能**：避免 ORM 的查询构建开销，直接执行 SQL
- **灵活性**：复杂查询（JOIN、子查询、聚合）用原生 SQL 更清晰
- **透明性**：SQL 语句可见，便于调试和优化
- **类型安全**：TypeScript 类型定义在 `src/types.ts`，手动维护但更可控

所有查询都使用参数化查询防止 SQL 注入：
```typescript
const result = await pool.query(
  'SELECT * FROM saved_cards WHERE user_id = $1 AND type = $2',
  [userId, cardType]
);
```

### AI 集成

**Q: AI 原子化是如何工作的？**  
点击「原子化存入知识库」后：

1. **全文提取**：`GET /api/articles/:id/full` 调用 Readability 提取正文
2. **AI 拆解**：`POST /api/articles/:id/save` 调用 `extractCardsWithAI` 函数
3. **Prompt 构造**：将文章标题、正文、来源信息拼接成 Prompt，要求 AI 返回 JSON 格式的卡片数组
4. **结果解析**：解析 AI 返回的 JSON，提取 type、content、summary、tags 等字段
5. **Fallback**：AI 失败时调用 `buildCardsFromArticleContent` 使用正则匹配
6. **数据持久化**：
   - 原文存入 `saved_articles` 表
   - 卡片存入 `saved_cards` 表，`saved_article_id` 外键关联原文
   - `origin` 字段标记为 `'ai'` 或 `'manual'`

**Q: 如何验证 AI 原子化是否真实调用了 API？**  
设置环境变量 `DISABLE_AI_FALLBACK=true`，此时 AI 失败会直接返回 `502` 错误，而非降级到规则提取。用于本地调试或临时验证 AI 提供商是否可用。

---

## License

本项目采用 MIT License。

---

**AtomFlow v0.6 · 2026年5月**
