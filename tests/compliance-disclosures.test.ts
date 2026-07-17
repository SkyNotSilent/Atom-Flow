import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const server = read("server.ts");
const login = read("src/components/LoginModal.tsx");
const canvasDrawer = read("src/components/write-canvas/CanvasAddDrawer.tsx");
const canvasInspector = read("src/components/write-canvas/CanvasInspector.tsx");
const discover = read("src/pages/DiscoverPage.tsx");
const reader = read("src/components/ReaderModal.tsx");
const inspiration = read("src/components/InspirationButton.tsx");

assert.match(server, /app\.get\("\/legal\/:document"/, "The deployed instance must serve its own legal documents");
assert.match(server, /DEPLOYMENT_OPERATOR_NAME/, "Production legal documents must use deployment identity variables");
assert.match(server, /DATA_HOSTING_REGION/, "Production legal documents must identify their storage region");
assert.match(server, /LEGAL_PLACEHOLDER_PATTERN/, "Production must reject unresolved legal placeholders");
assert.match(server, /your-domain\\\.example\|replace-/, "Production must reject example public origins");
assert.doesNotMatch(login, /github\.com\/SkyNotSilent\/Atom-Flow\/blob\/main\/(PRIVACY|TERMS)\.md/, "Login legal links must be instance-owned");
assert.match(login, /href="\/legal\/privacy"/);
assert.match(login, /href="\/legal\/terms"/);
assert.match(canvasInspector, /href="\/legal\/privacy"/);
assert.match(canvasDrawer, /上传后将保存在当前实例/);
assert.match(discover, /服务器将访问此地址/);
assert.match(reader, /文本将发送给当前实例配置的翻译服务/);
assert.match(inspiration, /音频将实时发送给当前实例配置的语音识别服务/);

console.log("PASS: deployment-owned legal notices and just-in-time disclosures");
