import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const server = readFileSync(path.join(root, "server.ts"), "utf-8");
const types = readFileSync(path.join(root, "src", "types.ts"), "utf-8");

assert.match(server, /app\.post\("\/api\/write\/agent\/chat\/stream", requireAuth/, "stream route must require auth");
assert.match(server, /app\.post\("\/api\/write\/agent\/chat", requireAuth/, "non-stream route must require auth");
assert.match(server, /Writing agent model is not configured/, "routes must return a clear model configuration error");
assert.match(server, /app\.post\("\/api\/write\/agent\/chat\/stream"[\s\S]*const runId = randomUUID\(\);/, "stream route should create a runId");
assert.match(server, /send\('error', \{[\s\S]*runId,[\s\S]*message:/, "stream errors should include runId");
assert.match(server, /send\('final', buildWriteAgentResponse\(graphState\)\)/, "stream route should use shared final payload builder");
assert.match(server, /return res\.json\(buildWriteAgentResponse\(graphState\)\)/, "non-stream route should use shared payload builder");
assert.match(server, /persistAgentRunEvent\(pool, \{[\s\S]*status: "completed"/, "successful runs should persist run-level events");
assert.match(server, /intent: intent\.intent/, "toolResult should expose classified intent");
assert.match(types, /runId\?: string;/, "WriteAgentToolResult should type runId");
assert.match(types, /intent\?: string;/, "WriteAgentToolResult should type intent");
assert.match(types, /effectiveSkillSnapshots\?:/, "WriteAgentToolResult should type effectiveSkillSnapshots");

if (process.env.RUN_REAL_WRITE_AGENT_TESTS === "true") {
  const base = process.env.API_BASE || "http://localhost:1000";
  const email = process.env.TEST_EMAIL || "test@atomflow.local";
  const password = process.env.TEST_PASSWORD || "test123456";
  let cookie = "";

  const request = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };

  const unauthorized = await request("POST", "/api/write/agent/chat", { message: "你好" });
  assert.equal(unauthorized.status, 401, "unauthenticated write agent requests should return 401");

  const login = await request("POST", "/api/auth/login-password", { email, password });
  assert.equal(login.status, 200, "test account login should succeed");

  const chat = await request("POST", "/api/write/agent/chat", { message: "你好，简单聊两句" });
  assert.equal(chat.status, 200, "chat request should succeed");
  assert.ok((chat.json as any)?.runId, "chat response should include runId");
  assert.equal((chat.json as any)?.toolResult?.intent, "chat", "plain chat should stay chat");
}

console.log("PASS: write agent API contract");
