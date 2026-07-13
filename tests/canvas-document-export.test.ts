import assert from 'node:assert/strict';
import { buildCanvasDocumentHtml, buildCanvasDocumentMarkdown, createScenarioSections } from '../src/utils/canvasDocumentExport';
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
  sections: [{ key: 'one', heading: '第一节', body: '<p>正文<strong>重点</strong></p>', level: 1, meta: {} }],
  createdAt: '',
  updatedAt: '',
};

assert.match(buildCanvasDocumentMarkdown(document), /^# 测试文章/m);
assert.match(buildCanvasDocumentMarkdown(document), /正文重点/);
assert.match(buildCanvasDocumentHtml(document), /<article>/);
assert.match(buildCanvasDocumentHtml(document), /<h2>第一节<\/h2>/);

console.log('PASS: canvas document scenarios and exports');
