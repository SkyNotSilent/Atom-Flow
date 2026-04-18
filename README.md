# AtomFlow（原子流）

**让每一篇看过的知识，都成为复利资产**

AtomFlow 是一款面向内容创作者与 AI 从业者的信息聚合与创作辅助工具，打通「信息消费 → 知识沉淀 → 内容创作」的完整闭环。

---

## 我们解决什么问题

AI 领域信息迭代极快，每天都有新模型、新论文、新产品发布。内容创作者需要持续输出有质量的内容。两类用户面临同一个核心问题：**信息太多太快，看不完、记不住、用不上**。

### 核心矛盾

1. **信息分散与 FOMO 焦虑**  
   优质内容散落在微信、知乎、Twitter、YouTube 等十几个平台，每天要花大量时间逐一刷取，生怕错过重要信息。  
   → AtomFlow 基于 RSS 技术将所有优质信息源聚合到一处，一个界面掌握全局，彻底告别信息焦虑。

2. **看完即忘**  
   没有有效的沉淀机制，好内容看过就消失。

3. **收藏夹焦虑**  
   收藏了大量文章，写作时想不起、找不到、用不上。

4. **AI 腔困境**  
   现有 AI 写作工具输出千篇一律，无法体现个人风格。

### 我们的解法

将阅读过的内容自动拆解为「原子知识卡片」，按主题沉淀到个人知识库，写作时根据主题智能召回相关卡片，辅助生成有个人风格的文章。

---

## 当前版本说明

### 已完成
- ✅ RSS 订阅聚合 — 支持多个中文科技/产品媒体源
- ✅ 全文阅读 — 自动提取文章完整内容，解决摘要截断问题
- ✅ 图片代理 — 解决防盗链导致图片无法显示的问题
- ✅ 来源管理 — 按来源浏览和筛选文章
- ✅ 用户自定义订阅源 — 支持添加 RSS / RSSHub 链接
- ✅ 信息源分类合集 — 按主题组织订阅源
- ✅ 知识库界面 — 卡片网格展示，支持类型筛选和关键词搜索
- ✅ AI 知识卡片自动拆分 — 接入 LLM（qwen3.6-plus），将文章拆解为观点/数据/金句/故事四类卡片
- ✅ 原文持久化 — 用户收藏的文章原文保存到数据库，重启不丢失
- ✅ 数据库持久化 — PostgreSQL 存储用户数据、卡片、文章

### 开发中
- ⏳ 向量语义搜索 — 基于 pgvector 的卡片语义检索
- ⏳ 知识图谱 — 卡片间关联关系自动发现
- ⏳ 智能召回 — 输入写作主题，自动聚合相关卡片
- ⏳ 写作辅助 — 基于卡片生成有个人风格的文章草稿

---

## 内置订阅源

AtomFlow 的信息源覆盖中英文双语，打通国内媒体、海外科技博客、X（Twitter）、YouTube 和播客，让你在一个地方同时掌握中文创作者圈子和英文科技前沿的动态。

### 🇨🇳 国内媒体
- **36氪** — 创投商业资讯
- **虎嗅** — 商业深度分析
- **少数派** — 科技生活方式
- **人人都是产品经理** — 产品运营知识
- **即刻话题** — 热门话题讨论

### 🎙️ 播客
- **张小珺商业访谈录** — 深度商业访谈节目

### 🐦 X（Twitter）
- **Sam Altman** — OpenAI CEO

### 🎥 YouTube
- **Y Combinator** — 创业孵化器官方频道
- **Andrej Karpathy** — AI 研究与教学
- **Lex Fridman** — AI & 科技深度对话

### 📮 公众号
- **数字生命卡兹克** — 科技人文思考
- **新智元** — AI 前沿资讯

### 💻 其他
- **GitHub Blog** — 技术前沿动态

---

## 快速开始

### 环境要求
- Node.js 20+
- npm 9+

### 本地运行

```bash
# 1. 克隆项目
git clone https://github.com/SkyNotSilent/Atom-Flow.git
cd Atom-Flow

# 2. 安装依赖
npm install

# 3. 启动开发服务器
npm run dev
```

访问 `http://localhost:3002` 即可使用（默认端口 3002，可通过 `.env` 文件修改）。

---

## 部署

AtomFlow 是全栈应用（前端 + 后端），需要支持 Node.js 的平台，不支持 Vercel / Netlify 纯静态托管。

### Railway（推荐）
1. 访问 [Railway.app](https://railway.app)
2. 连接 GitHub 仓库
3. 自动部署（已配置 `railway.json`）

### Render
1. 访问 [Render.com](https://render.com)
2. 创建 Web Service，连接仓库（已配置 `render.yaml`）

### Docker
```bash
docker build -t atomflow .
docker run -d -p 3002:3002 atomflow
```

详细部署说明请查看 [DEPLOYMENT.md](DEPLOYMENT.md)

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
├── server.ts            # Express 后端服务
├── package.json
└── README.md
```

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS |
| 后端 | Express + Node.js |
| 数据库 | PostgreSQL（pg pool，无 ORM） |
| AI 卡片提取 | OpenAI 兼容 API（qwen3.6-plus） |
| RSS 解析 | rss-parser |
| 全文提取 | @mozilla/readability + jsdom + Jina Reader |
| 部署 | Railway (Nixpacks) + GitHub 自动部署 |

---

## 常用命令

```bash
npm run dev     # 开发模式（前后端一体）
npm run build   # 构建前端
npm run lint    # TypeScript 类型检查
```

---

## 常见问题

**Q: 部署后只有前端页面，RSS 不显示？**  
需确保后端服务正常运行。请使用 Railway / Render 等支持 Node.js 的平台，不要用纯静态托管。

**Q: 如何添加自定义 RSS 源？**  
点击左侧导航栏的"发现订阅源"按钮，可以浏览推荐源或手动添加 RSS / RSSHub 链接。

**Q: 数据存储在哪里？**  
使用 PostgreSQL 数据库存储用户数据、知识卡片、收藏原文等。部署时需配置 `DATABASE_URL` 环境变量。

**Q: 如何修改默认端口？**  
在项目根目录创建 `.env` 文件，添加 `PORT=你的端口号`。

---

## 开发路线图

- [x] RSS 订阅聚合
- [x] 全文阅读
- [x] 来源管理
- [x] 用户自定义订阅源
- [x] 信息源分类合集
- [x] 数据库持久化（PostgreSQL）
- [x] 知识卡片 AI 自动拆分（LLM）
- [x] 原文持久化收藏
- [ ] 向量语义搜索（pgvector）
- [ ] 知识图谱（卡片关联）
- [ ] 写作主题智能召回
- [ ] 写作辅助生成

---

## License

本项目采用 MIT License。详见 [LICENSE](LICENSE)。

---

## 贡献

欢迎提交 Issue 和 Pull Request！

---

**AtomFlow v0.5 · 2026年4月**
