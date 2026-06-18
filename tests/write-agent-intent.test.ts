import assert from "node:assert/strict";
import {
  classifyWriteAgentIntent,
  mergeWriteAgentModelRouterResult,
} from "../src/utils/writeAgentIntent";

const cases = [
  {
    name: "plain chat stays chat",
    message: "今天状态怎么样？",
    intent: "chat",
    tools: [],
  },
  {
    name: "negated draft stays chat",
    message: "你好，简单聊两句，不要创建文章",
    intent: "chat",
    tools: [],
  },
  {
    name: "material recall",
    message: "帮我找一下 AI Agent 沙箱相关素材和来源",
    intent: "select_material",
    tools: ["recall_cards"],
  },
  {
    name: "outline generation",
    message: "基于知识库给我一个 AI Agent 沙箱文章提纲",
    intent: "outline",
    tools: ["recall_cards", "generate_outline"],
  },
  {
    name: "full draft",
    message: "直接写一篇符合 Scratch 标准的完整文章",
    intent: "draft",
    tools: ["recall_cards", "generate_outline", "generate_draft"],
  },
  {
    name: "continue recent note",
    message: "继续改我的文章里面上次写的那篇",
    intent: "revise",
    tools: ["list_recent_notes", "revise_note"],
  },
  {
    name: "style change is revise",
    message: "把这篇换个风格，更像产品经理复盘",
    intent: "revise",
    tools: ["list_recent_notes", "revise_note"],
  },
  {
    name: "mixed intent prioritizes draft",
    message: "找些素材，给我结构，然后直接生成文章",
    intent: "draft",
    tools: ["recall_cards", "generate_outline", "generate_draft"],
  },
] as const;

for (const item of cases) {
  const result = classifyWriteAgentIntent(item.message, false);
  assert.equal(result.intent.intent, item.intent, item.name);
  assert.deepEqual(result.requestedTools, item.tools, item.name);
}

const createArticle = classifyWriteAgentIntent("", true);
assert.equal(createArticle.intent.intent, "draft");
assert.deepEqual(createArticle.requestedTools, ["recall_cards", "generate_outline", "generate_draft"]);

const local = classifyWriteAgentIntent("帮我处理一下这篇", false);
const merged = mergeWriteAgentModelRouterResult(local, {
  intent: "continue_note",
  tools: ["list_recent_notes"],
  reason: "model detected continuation",
});
assert.equal(merged.intent.intent, "continue_note");
assert.deepEqual(merged.requestedTools, ["list_recent_notes"]);

console.log("PASS: write agent intent matrix");
