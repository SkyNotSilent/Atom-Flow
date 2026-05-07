import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("");
globalThis.window = window as unknown as Window & typeof globalThis;

import { prepareAgentDraftForNote } from "../src/utils/agentDraftExport";

const rawDraft = `标题建议：
主标题：**AI 产品经理正在被工作流重塑**
副标题：**从任务执行到流程重组的一次转向**

正文章稿：
## 开场

- 第一个变化是任务被拆成可复用的原子能力
- 第二个变化是写作过程可以被持续追踪

**这不是工具替代人，而是流程被重新组织。**

<script>alert('xss')</script>`;

const note = prepareAgentDraftForNote(rawDraft);

assert.equal(note.title, "AI 产品经理正在被工作流重塑");
assert.match(note.content, /<blockquote>\s*<p>从任务执行到流程重组的一次转向<\/p>\s*<\/blockquote>/);
assert.match(note.content, /<h2[^>]*>开场<\/h2>/);
assert.match(note.content, /<ul>/);
assert.match(note.content, /<strong>这不是工具替代人，而是流程被重新组织。<\/strong>/);
assert.doesNotMatch(note.content, /<script>/);
assert.doesNotMatch(note.content, /## 开场/);
assert.doesNotMatch(note.content, /主标题|副标题|标题建议/);

const subtitleAfterMainTitle = prepareAgentDraftForNote(`主标题：**主标题示例**

## 引入

副标题：**这是稍后出现的副标题**

正文段落。`);

assert.equal(subtitleAfterMainTitle.title, "主标题示例");
assert.match(subtitleAfterMainTitle.content, /<blockquote>\s*<p>这是稍后出现的副标题<\/p>\s*<\/blockquote>/);
assert.equal((subtitleAfterMainTitle.content.match(/这是稍后出现的副标题/g) || []).length, 1);

const sectionLabelDraft = prepareAgentDraftForNote(`## 正文草稿

这是一篇关于知识工作流如何重塑产品经理写作的文章。

正文内容。`);

assert.equal(sectionLabelDraft.title, "这是一篇关于知识工作流如何重塑产品经理写作的文章。");
assert.notEqual(sectionLabelDraft.title, "正文草稿");

const inlineTitleDraft = prepareAgentDraftForNote(`主标题：AI 不想再陪你聊天了  副标题：从豆包收费到 Moonix 眼镜，智能正在逃离屏幕

如果你最近打开豆包，发现它开始向你伸手要钱，请不要惊讶。

正文内容。`);

assert.equal(inlineTitleDraft.title, "AI 不想再陪你聊天了");
assert.match(inlineTitleDraft.content, /<blockquote>\s*<p>从豆包收费到 Moonix 眼镜，智能正在逃离屏幕<\/p>\s*<\/blockquote>/);
assert.doesNotMatch(inlineTitleDraft.title, /副标题/);

console.log("PASS: agent draft export preserves title and renders markdown");
