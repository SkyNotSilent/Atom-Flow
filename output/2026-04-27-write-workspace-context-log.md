# AtomFlow 写作工作区上下文记录

更新时间：2026-04-27
记录位置：`D:\AI产品经理\Atom-flow\output`

## 用户原始目标与反馈

用户围绕写作页中间画布、激活网络、写作生成、Chat 助手、文章落库与 agent 架构，连续给出了以下明确反馈与要求：

- 不要 3D，画布只要平面 2D，拖动必须更丝滑、更像真实受力系统。
- 不要一张张重卡片式展示，节点展示要轻量化，尽量不要堆文字。
- 圆点节点太丑，文章节点应该是黄色或橘色的圆点，其他观点/数据等节点用不同颜色的星形。
- 删除蓝色系，整体视觉改为更暖、更协调的色系。
- 节点不需要全部连上，只保留真实关系。
- 一篇文章应该拆成多个原子节点，这些节点天然有父子连接；剩余连接来自关键词、正则、语义匹配。
- “我的文章”里也要保留激活网络，文章生成后应能看到这篇文章激活过哪些节点、哪些元信息、以及原文来源。
- “按当前激活生成我文章”当时不可用，点击生成没有实际产出。
- 生成逻辑不能只是简单调一次 API，需要认真设计写作 agent 的系统提示词、工具调用、上下文管理和 memory。
- Chat 助手不该是假的聊天层，而要成为真正有 memory、有 context 管理、能调用知识库工具、能推进写作的 agent。
- 用户明确要求“继续”，并要求助手自己验证完整链路，不只是说代码已经写好。
- 用户要求把本次上下文、反馈、实现和验证结果如实记录到 `output` 文件夹。

## 已完成的主要实现

### 1. 写作页关系图改为 2D 受力系统

文件：`src/pages/WritePage.tsx`

已实现：

- 中间画布从 3D 风格收敛为平面 2D 关系图。
- 文章节点为暖黄色/橘色圆点。
- 原子节点改为彩色星形节点，不再是圆点。
- 只保留三类关系：
  - 文章 -> 原子节点的天然父子连接
  - 跨文章原子节点之间的稀疏语义连接
  - 文章与文章之间的稀疏主题连接
- 拖动采用本地力学模拟：
  - 排斥力
  - 弹簧力
  - 锚点回拉
  - 阻尼与速度衰减
  - 拖动惯性释放
- 颜色改成暖色系，移除蓝色主视觉。

### 2. 我的文章支持保存激活网络与来源

涉及文件：

- `src/types.ts`
- `src/context/AppContext.tsx`
- `src/components/NotesPanel.tsx`
- `server.ts`

已实现：

- `notes.meta` 新增结构化字段：
  - `topic`
  - `style`
  - `outline`
  - `activationSummary`
  - `activatedNodes`
  - `evidenceMap`
  - `sourceArticles`
- “我的文章”面板可看到：
  - 写作风格
  - 提纲
  - evidence map
  - 激活网络摘要
  - 激活节点
  - 原文来源跳转

### 3. 写作生成接口升级为多阶段写作流

文件：`server.ts`

接口：`POST /api/write/generate`

已实现：

- 写作流程拆为三段：
  - 写作策划（plan）
  - 正文起草（draft）
  - 润色（polish）
- 如果 AI 阶段失败，返回 fallback 草稿，不至于完全空白。
- 输出包含：
  - `title`
  - `style`
  - `angle`
  - `outline`
  - `evidenceMap`
  - `content`

### 4. Chat 助手升级为真正的写作 agent

文件：`server.ts`、`src/pages/WritePage.tsx`

已实现：

- 数据表：
  - `write_agent_threads`
  - `write_agent_messages`
- API：
  - `GET /api/write/agent/threads`
  - `POST /api/write/agent/threads`
  - `GET /api/write/agent/threads/:id/messages`
  - `POST /api/write/agent/chat`
- memory 分层：
  - 线程最近消息
  - 线程 state
  - 最近文章草稿
  - 当前激活网络
  - 知识库召回卡片
- agent 路由工具：
  - `recall_cards`
  - `get_active_network`
  - `list_recent_notes`
  - `generate_outline`
  - `generate_draft`
- 前端聊天面板支持：
  - 加载真实线程历史
  - 展示 `tool` 消息时间线
  - 展示提纲预览
  - 展示草稿预览
  - 展示 agent 是否已落成文章

### 5. Chat 内生成草稿后可直接落成文章

文件：`server.ts`

已实现：

- 当 agent 路由命中 `generate_draft` 时：
  - 会真正创建 note
  - 将 note id / title 写回 thread state
  - 返回 `note` 结果给前端
- thread state 扩展为：
  - `focusedTopic`
  - `activatedNodeIds`
  - `activationSummary`
  - `latestOutline`
  - `latestAngle`
  - `lastGeneratedNoteId`
  - `lastGeneratedNoteTitle`

### 6. 生成失败提示改为明确错误原因

文件：`src/pages/WritePage.tsx`

已实现：

- 生成和聊天调用不再统一显示“请稍后重试”。
- 会优先读取后端返回的 `error` / `message`。
- 针对 `401` 明确提示：
  - “请先登录后再生成文章”
  - “请先登录后再使用写作助手”

### 7. 未登录时直接引导登录

文件：`src/pages/WritePage.tsx`

已实现：

- 点击“发送并激活节点”时，如果未登录，直接打开登录弹窗。
- 点击“按当前激活网络生成文章”时，如果未登录，直接打开登录弹窗。
- 按钮文案会根据登录状态变化：
  - 已登录：正常写作/生成文案
  - 未登录：显示“登录后使用写作助手”与“登录后生成文章”

## 关键问题排查过程

本次过程中实际发现了两个关键运行问题：

### 1. 用户当前在用的 `3001` 服务不是当前代码版本

现象：

- 用户页面里点生成仍然失败。
- 我对 `http://localhost:3001` 自测时，`/api/write/generate` 返回：
  - `500`
  - `{"error":"AI generation failed"}`

进一步排查后确认：

- 本机 `3001` 上原先跑的是旧进程，不是当前工作区最新代码。
- 所以即使工作区代码已修复，页面仍然连到了旧服务。

处理：

- 将当前工作区服务先启动到 `3101` 进行隔离验证。
- 验证通过后，替换正式 `3001` 服务为当前代码版本。

### 2. 当前代码版最初也会 fallback，因为 AI 请求超时

在 `3101` 上跑当前代码时，服务日志中出现：

- `[AI] Generate failed: This operation was aborted`

说明：

- 写作接口是三段 AI 串行调用。
- 之前单次超时为 `60000ms`。
- 模型为 `qwen3.6-plus`，在当前 `AI_BASE_URL` 下正文/润色阶段容易超时。

处理：

- 新增并启用：
  - `AI_REQUEST_TIMEOUT_MS = 120000`
  - `AI_DRAFT_MAX_TOKENS = 2400`
  - `AI_POLISH_MAX_TOKENS = 2400`
- 目标是先提高成功率，减少串行长文本调用超时。

## 我自己跑过的真实验证

### 验证 1：旧服务 `3001`

结果：

- 登录成功
- 召回成功
- `/api/write/generate` 返回 `500`
- 不可用

### 验证 2：当前代码服务 `3101`，超时优化前

结果：

- 登录成功
- 生成接口返回 `200`
- 但 `fallback = true`
- 文章能保存到 notes
- 说明链路通，但 AI 草稿阶段被中断，内容质量不理想

### 验证 3：当前代码服务 `3101`，超时优化后

结果：

- 登录成功
- `/api/write/generate` 返回 `200`
- `fallback = false`
- 有真实 AI 生成正文
- 说明 AI 写作链路恢复正常

示例标题：

- `在“幽灵模型”与公关战之间，创作者如何用 RSS 夺回写作节奏`

### 验证 4：正式服务 `3001` 替换后

结果：

- 当前正式端口 `3001` 已替换成当前工作区代码
- 登录成功
- 生成接口返回 `200`
- `fallback = false`
- 保存文章成功
- note 数量增长
- “我的文章”可看到新文章

最终一次真实验证结果：

- `loginStatus = 200`
- `generateStatus = 200`
- `fallback = false`
- `saveNoteStatus = 200`
- `saveNoteId = 6`
- `afterNotesCount = 4`
- `latestNoteTitle = 别把RSS当阅读器：它是创作者对抗信息熵的写作系统`

## 本次实际修改文件

- `server.ts`
- `src/pages/WritePage.tsx`
- `src/context/AppContext.tsx`
- `src/types.ts`

## 当前状态总结

当前写作页状态：

- 关系图是平面 2D 受力系统。
- Chat 助手已是线程化 agent，不再是假聊天。
- 生成链路已可用。
- 正式 `3001` 端口已切换到当前工作区版本。
- 生成出的文章可落到“我的文章”。
- 文章可保留激活网络与来源元信息。
- 未登录时会直接引导登录。

## 仍可继续优化的点

- 登录前禁用态和引导可再做得更明显，例如按钮 hover 提示。
- Chat agent 的 memory summary 目前仍偏轻，可进一步做结构化摘要压缩。
- 写作阶段可以进一步减少无关节点混入，提升草稿一致性。
- 目前 WebSocket 日志里仍有 `24678` 端口占用告警，但不影响写作主链路。
- 前端可增加线程列表切换，而不只是恢复最近线程。

## 备注

本记录力求如实保留：

- 用户原始反馈
- 已做修改
- 运行中发现的问题
- 我本人执行过的真实验证结果

本文件创建于用户明确要求“把整个上下文、用户反馈、已做内容如实记录到 output 文件夹”之后。
