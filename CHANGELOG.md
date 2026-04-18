# Changelog

本项目采用语义化版本（SemVer）：`MAJOR.MINOR.PATCH`。

## [0.5.0] - 2026-04-19

### Added
- AI 卡片提取 — 接入 qwen3.6-plus（OpenAI 兼容 API），替代纯正则提取，支持自动降级
- `saved_articles` 表 — 用户收藏文章时持久化原文到数据库，重启不丢失
- `saved_cards` 新增 `origin`（ai/manual）和 `saved_article_id` 字段
- `card_relations` 表 — 知识图谱预留（supports/conflicts/extends）
- pgvector 可选启用 — 为未来向量语义搜索预留 embedding 列
- `GET /api/saved-articles` 和 `GET /api/saved-articles/:id` 接口
- 环境变量 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`

### Changed
- 知识库来源视图改用 `savedArticles` 数据源（持久化，不依赖内存）
- 侧边栏统计数据改用 `savedArticles` 计数
- `GET /api/cards` 返回新增 `origin` 和 `savedArticleId` 字段
- 保存流程：先存原文 → AI 提取卡片 → 事务写入

### Fixed
- 修复无 URL 文章重复保存时创建多条 `saved_articles` 记录的问题
- 修复保存后 fetch 响应缺少 `.ok` 检查可能导致白屏的问题

---

## [0.4.0] - 2026-03-09

### Added
- 三栏布局支持拖拽调整宽度
- 知识库卡片支持引用回溯（回看推送原文/原文链接）
- 新增来源匹配兼容逻辑（按 `articleId` + `articleTitle` 双通道）
- 新增对外发布文档与内部协作文档

### Changed
- 卡片类型统一为：观点 / 数据 / 金句 / 故事
- 知识库来源模式与原子卡片模式交互优化
- README 重写为面向国内用户的产品文档

### Fixed
- 修复“来源文章数量不为空但来源视图空白”的问题
- 修复中右分界拖拽感知不足（鼠标样式与命中区域）

---

## 记录规范

- 每次发版前新增一个版本块
- 每个版本按 `Added / Changed / Fixed` 归类
- 日期使用 `YYYY-MM-DD`
