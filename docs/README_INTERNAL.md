# AtomFlow（原子流）- 团队内部文档

## 1. 项目定位

AtomFlow 是一个前后端一体化的知识工作台，目标是把内容消费流程转成可复用知识资产流程。

- 输入层：今日推送（RSS 聚合 + 全文抓取）
- 沉淀层：知识库（原子卡片）
- 输出层：写作页（素材召回与生成）

## 2. 技术栈

- 前端：React 18 + Vite + TypeScript + Tailwind 风格类
- 后端：Express（同进程）+ RSS Parser + Readability + JSDOM
- 数据库：PostgreSQL（pg pool，无 ORM）；可选 pgvector 扩展
- AI：OpenAI 兼容 API（qwen3.6-plus）用于卡片提取，失败自动降级为正则提取
- 部署：Railway (Nixpacks) + GitHub 自动部署

## 3. 本地开发

```bash
npm install
npm run dev
```

常用命令：

```bash
npm run lint
npm run build
npm run preview
```

## 4. 目录说明（开发关注）

- `server.ts`：RSS 抓取、全文提取、图片代理、卡片生成与 API
- `src/context/AppContext.tsx`：全局状态与跨页面数据流
- `src/pages/FeedPage.tsx`：推送页
- `src/pages/KnowledgePage.tsx`：知识库页
- `src/pages/WritePage.tsx`：写作页
- `src/components/Nav.tsx`：三栏导航和筛选控制台
- `src/utils/articleDisplay.ts`：来源匹配、来源回溯工具

## 5. 核心业务规则

### 5.1 卡片类型

统一四类：

- 观点
- 数据
- 金句
- 故事

对应定义：

- 类型定义：[types.ts](file:///F:/AI产品经理/AtomFlow/src/types.ts)
- 色彩定义：[constants.ts](file:///F:/AI产品经理/AtomFlow/src/constants.ts)

### 5.2 AI 卡片提取

保存文章时调用 `extractCardsWithAI()`（server.ts），通过 OpenAI 兼容 API 提取最多 3 张卡片。15 秒超时，失败自动降级为 `buildCardsFromArticleContent()` 正则提取。环境变量：`AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`。

### 5.3 来源回溯

知识库来源视图现在直接从 `saved_articles` 表读取（持久化），不再依赖内存中的 articles 数组。卡片通过 `saved_article_id` 强关联原文。

旧的 `articleId` + `articleTitle` 双通道匹配逻辑保留在卡片视图中，用于在内存中查找文章打开阅读器。

### 5.3 三栏可调宽度

- 左中分界：显式拖拽条
- 中右分界：无独立拖拽条元素，采用边缘命中检测
- 鼠标在中右分界附近显示 `col-resize`

实现位置：

- [App.tsx](file:///F:/AI产品经理/AtomFlow/src/App.tsx)

## 6. 发布与版本规范

采用语义化版本：`MAJOR.MINOR.PATCH`

- MAJOR：不兼容变更（类型、数据结构、核心交互模型）
- MINOR：功能增强（新增页面能力、流程能力）
- PATCH：修复（交互细节、兼容问题、样式问题）

建议发布流程：

1. 功能冻结（仅修复）
2. 跑 `npm run lint`
3. 更新 `CHANGELOG.md`
4. 更新 `README.md` 的“当前版本亮点”
5. 打 tag 并发布说明

## 7. 质量基线

- 不引入未验证依赖
- 关键交互改动必须有最小回归验证（至少 lint + 主路径手测）
- 保持失败可回退（尤其未来接入大模型链路）

## 8. 待办建议

- 补充 API 文档（请求/响应样例）
- 将卡片生成策略与提示词管理抽离配置化
- 实现向量语义搜索（pgvector + embedding 生成）
- 实现知识图谱自动发现（card_relations 表已预留）
- 写作页 AI 生成接入真实 LLM（当前为模拟）
