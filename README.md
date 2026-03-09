# AtomFlow（原子流）

AtomFlow 是一款轻量级的 RSS 订阅聚合工具，帮助你高效获取和阅读来自多个信息源的优质内容。

## 当前版本说明

这是 AtomFlow 的早期版本，专注于核心的信息聚合功能：

- ✅ RSS 订阅聚合 - 支持多个中文科技/产品媒体源
- ✅ 全文阅读 - 自动提取文章完整内容
- ✅ 来源管理 - 按来源浏览和筛选文章
- ⏳ 知识卡片功能 - 开发中
- ⏳ 写作辅助功能 - 规划中

---

## 功能特性

### RSS 订阅源

内置优质中文信息源：
- 36氪 - 创投商业资讯
- 少数派 - 科技生活方式
- 人人都是产品经理 - 产品运营
- 虎嗅 - 商业深度分析
- 即刻话题 - 社区热门讨论
- 公众号订阅（通过 RSS 服务）

### 阅读体验

- 三栏布局：导航 / 文章列表 / 阅读区
- 智能全文提取（支持 Readability）
- 图片代理加载（解决防盗链问题）
- 按来源筛选和排序

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

访问 http://localhost:3001 即可使用。

---

## 部署到线上

AtomFlow 是一个全栈应用（前端 + 后端），需要部署到支持 Node.js 的平台。

### 推荐平台

**Railway（推荐）**
1. 访问 [Railway.app](https://railway.app)
2. 连接 GitHub 仓库
3. 自动部署（已配置 railway.json）

**Render**
1. 访问 [Render.com](https://render.com)
2. 创建 Web Service
3. 连接仓库（已配置 render.yaml）

**Docker 部署**
```bash
docker build -t atomflow .
docker run -d -p 3001:3001 atomflow
```

详细部署说明请查看 [DEPLOYMENT.md](DEPLOYMENT.md)

---

## 项目结构

```text
AtomFlow/
├─ src/
│  ├─ components/      # React 组件
│  ├─ pages/           # 页面（推送、知识库、写作）
│  ├─ context/         # 全局状态
│  ├─ utils/           # 工具函数
│  └─ types.ts         # 类型定义
├─ server.ts           # Express 后端服务
├─ package.json
└─ README.md
```

---

## 技术栈

- **前端**: React 19 + TypeScript + Vite + Tailwind CSS
- **后端**: Express + Node.js
- **RSS 解析**: rss-parser
- **全文提取**: @mozilla/readability + jsdom
- **数据存储**: 本地 JSON 缓存（.cache/articles.json）

---

## 常用命令

```bash
npm run dev       # 开发模式（前后端一体）
npm run build     # 构建前端
npm run lint      # TypeScript 类型检查
```

---

## 常见问题

### Q: 为什么部署后只有前端页面，RSS 不显示？
A: 需要确保后端服务正常运行。静态托管平台（如 Vercel/Netlify）不支持，请使用 Railway/Render 等支持 Node.js 的平台。

### Q: 如何添加自定义 RSS 源？
A: 当前版本暂不支持前端添加，可以修改 `server.ts` 中的 `fetchRSSFeeds()` 函数添加新的订阅源。

### Q: 数据存储在哪里？
A: 当前版本使用本地 JSON 文件缓存（`.cache/articles.json`），重启服务不会丢失数据。

---

## 开发路线图

- [x] RSS 订阅聚合
- [x] 全文阅读
- [x] 来源管理
- [ ] 知识卡片自动提取
- [ ] 卡片标签系统
- [ ] 写作辅助功能
- [ ] 数据库持久化
- [ ] 用户自定义订阅源

---

## License

本项目采用 MIT License。详见 [LICENSE](LICENSE)。

---

## 贡献

欢迎提交 Issue 和 Pull Request！
