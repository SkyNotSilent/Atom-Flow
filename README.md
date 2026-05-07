# AtomFlow（原子流）

**让每一篇看过的知识，都成为复利资产**

AtomFlow 是一款面向内容创作者与 AI 从业者的信息聚合与创作辅助工具，打通「信息消费 → 知识沉淀 → 内容创作」的完整闭环。

---

## 核心价值

AI 领域信息迭代极快，内容创作者需要持续输出有质量的内容。我们解决的核心问题是：**信息太多太快，看不完、记不住、用不上**。

### 我们的解法

将阅读过的内容自动拆解为「原子知识卡片」，按主题沉淀到个人知识库，写作时根据主题智能召回相关卡片，辅助生成有个人风格的文章。

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
- **保留上下文**：每张卡片记录原文出处，点击可回溯完整语境
- **去重机制**：相似卡片自动合并，避免知识库冗余

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
- **智能召回**：根据写作主题从知识库检索相关卡片（支持关键词 + 未来支持向量语义搜索）
- **原文引用**：生成内容时保留卡片来源，用户可追溯到原始文章
- **对话记忆**：支持多轮对话，理解「再详细点」「换个角度」等指令

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
- RSS 订阅聚合与全文阅读
- 用户自定义订阅源
- AI 知识卡片自动拆分（Agent 1）
- 写作助手 LangGraph 架构（Agent 2）
- 风格定制 AI 助手（Agent 3）
- PostgreSQL 数据持久化

### 开发中 ⏳
- 向量语义搜索（pgvector）
- 知识图谱（卡片关联关系）
- 多模态支持（图片、视频内容提取）

---

## 常见问题

**Q: 为什么选择 LangGraph 而不是简单的 Prompt Chain？**  
LangGraph 提供状态管理、条件分支、循环控制等能力，适合复杂的多步骤 Agent。例如写作助手需要根据意图分类决定是否检索知识库，这种条件逻辑用 Prompt Chain 难以实现。

**Q: 三个 Agent 是并行运行还是串行？**  
Agent 1 和 Agent 3 是用户主动触发的独立任务，Agent 2 在运行时会读取前两者的产出（卡片和 Skill），但不会调用它们。

**Q: 如何保证 AI 生成内容的质量？**  
- Agent 1 有 fallback 机制：AI 失败时使用规则提取
- Agent 2 有验证节点：检查生成内容是否引用了知识库
- Agent 3 有字段校验：确保生成的 Skill 符合长度和格式要求

**Q: 数据存储在哪里？**  
使用 PostgreSQL 数据库存储用户数据、知识卡片、收藏原文等。部署时需配置 `DATABASE_URL` 环境变量。

---

## License

本项目采用 MIT License。

---

**AtomFlow v0.6 · 2026年5月**
