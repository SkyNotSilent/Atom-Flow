import assert from "node:assert/strict";
import { getWriteAgentRunPhase, parseWriteAgentSseChunk } from "../src/utils/writeAgentRun";

const partial = parseWriteAgentSseChunk('event: partial_status\ndata: {"message":"基础规范已加载，用户增强 Skills 1 个已启用"}\n\n');
assert.equal(partial?.event, "partial_status");
assert.equal(getWriteAgentRunPhase(String(partial?.payload.node || ""), String(partial?.payload.message || "")), "理解需求");

const retrieve = parseWriteAgentSseChunk('event: step_start\ndata: {"node":"retrieve_knowledge","message":"从知识库里寻找相关素材"}\n\n');
assert.equal(retrieve?.event, "step_start");
assert.equal(getWriteAgentRunPhase(String(retrieve?.payload.node), String(retrieve?.payload.message)), "查找素材");

const draft = parseWriteAgentSseChunk('event: step_end\ndata: {"node":"generate_answer_or_draft","durationMs":1234}\n\n');
assert.equal(draft?.event, "step_end");
assert.equal(draft?.payload.durationMs, 1234);
assert.equal(getWriteAgentRunPhase(String(draft?.payload.node), ""), "生成内容");

const activation = parseWriteAgentSseChunk('event: activation\ndata: {"activatedNodeIds":["card-1"],"activationSummary":["观点 · test"]}\n\n');
assert.deepEqual(activation?.payload.activatedNodeIds, ["card-1"]);

const final = parseWriteAgentSseChunk('event: final\ndata: {"runId":"run-1","threadId":1,"toolResult":{"intent":"draft"}}\n\n');
assert.equal(final?.payload.runId, "run-1");

const error = parseWriteAgentSseChunk('event: error\ndata: {"runId":"run-2","message":"failed"}\n\n');
assert.equal(error?.payload.runId, "run-2");
assert.equal(error?.payload.message, "failed");

assert.equal(parseWriteAgentSseChunk("data: {}\n\n"), null);

console.log("PASS: write agent SSE compatibility");
