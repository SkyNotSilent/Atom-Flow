import assert from 'node:assert/strict';
import {
  buildCanvasDocumentHtml,
  buildCanvasDocumentMarkdown,
  createScenarioSections,
  htmlToMarkdown,
  sanitizeCanvasDocumentHtml,
} from '../src/utils/canvasDocumentExport';
import type { WriteCanvasDocument } from '../src/types';

const sections = createScenarioSections('wechat-depth');
assert.equal(sections.length, 5);
assert.equal(sections[0].heading, '开场钩子');

const document: WriteCanvasDocument = {
  id: 1,
  projectId: 1,
  nodeId: 1,
  title: '测试文章',
  summary: '这是摘要',
  scenario: 'wechat-depth',
  status: 'editing',
  sections: [{
    key: 'one',
    heading: '第一节',
    body: [
      '<h3>段内标题</h3>',
      '<p>正文<strong>重点</strong>和<em>斜体</em>，参考<a href="https://example.com/source?a=1&amp;b=2">来源</a>。</p>',
      '<blockquote><p>引用 &amp; 判断</p></blockquote>',
      '<ol start="3"><li>第三项</li><li>第四项含 <code>x &lt; y</code></li></ol>',
      '<ul><li>无序项</li></ul>',
      '<pre><code>const ok = 1 &lt; 2;\nnext();</code></pre>',
      '<p>第一行<br>第二行</p>',
    ].join(''),
    level: 1,
    meta: {},
  }],
  createdAt: '',
  updatedAt: '',
};

const markdown = buildCanvasDocumentMarkdown(document);
assert.match(markdown, /^# 测试文章/m);
assert.match(markdown, /### 段内标题/);
assert.match(markdown, /正文\*\*重点\*\*和\*斜体\*/);
assert.match(markdown, /\[来源\]\(https:\/\/example\.com\/source\?a=1&b=2\)/);
assert.match(markdown, /^> 引用 & 判断$/m);
assert.match(markdown, /^3\. 第三项$/m);
assert.match(markdown, /^4\. 第四项含 `x < y`$/m);
assert.match(markdown, /^- 无序项$/m);
assert.match(markdown, /```\nconst ok = 1 < 2;\nnext\(\);\n```/);
assert.match(markdown, /第一行 {2}\n第二行/);
assert.match(buildCanvasDocumentHtml(document), /<article>/);
assert.match(buildCanvasDocumentHtml(document), /<h2>第一节<\/h2>/);
assert.match(buildCanvasDocumentHtml(document), /<strong>重点<\/strong>/);
assert.equal(htmlToMarkdown('<p><b>粗体</b>和<i>斜体</i> &#20013; &lt;safe&gt;</p>'), '**粗体**和*斜体* 中 \\<safe\\>');
assert.equal(htmlToMarkdown('<p><a href="jav&#x61;script:alert(1)">不安全链接</a></p>'), '不安全链接');

const hostile = [
  '<script>alert(1)</script>',
  '<style>body{display:none}</style>',
  '<p onclick="alert(2)" style="background:url(javascript:alert(3))">安全正文',
  '<img src=x onerror="alert(4)">',
  '<a href="jav&#x61;script:alert(5)" onmouseover="alert(6)">危险链接</a>',
  '<a href="https://example.com/safe?a=1&amp;b=2" target="_blank" onclick="alert(7)">安全链接</a>',
  '</p><iframe srcdoc="<script>alert(8)</script>"></iframe>',
].join('');
const sanitized = sanitizeCanvasDocumentHtml(hostile);
assert.doesNotMatch(sanitized, /script|style=|onclick|onerror|onmouseover|javascript:|<img|<iframe/i);
assert.match(sanitized, /<p>安全正文危险链接<a href="https:\/\/example\.com\/safe\?a=1&amp;b=2">安全链接<\/a><\/p>/);

const hostileDocument = {
  ...document,
  sections: [{ ...document.sections[0], body: hostile }],
};
const exportedHtml = buildCanvasDocumentHtml(hostileDocument);
assert.doesNotMatch(exportedHtml, /script|style=|onclick|onerror|onmouseover|javascript:|<img|<iframe/i);
assert.match(exportedHtml, /安全正文/);

const hostileMetadataMarkdown = buildCanvasDocumentMarkdown({
  ...document,
  title: '<img src=x onerror=alert(1)>',
  summary: '<script>alert(2)</script>',
  sections: [{ ...document.sections[0], heading: '<svg onload=alert(3)>' }],
});
assert.doesNotMatch(hostileMetadataMarkdown, /(^|[^\\])<(?:img|script|svg)\b/i, 'Markdown metadata must not preserve executable raw HTML');
assert.match(hostileMetadataMarkdown, /\\<img src=x onerror=alert\(1\)\\>/, 'hostile title markup must be emitted as escaped text');

console.log('PASS: canvas document scenarios and exports');
