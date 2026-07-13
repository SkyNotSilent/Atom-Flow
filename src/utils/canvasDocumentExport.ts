import type { WriteCanvasDocument, WriteCanvasDocumentSection } from '../types';

export const CANVAS_DOCUMENT_SCENARIOS = [
  { value: 'wechat-depth', label: '公众号深度文章', headings: ['开场钩子', '问题与背景', '核心分析', '案例与证据', '结论与行动'] },
  { value: 'hotspot-analysis', label: '热点解析', headings: ['事件概述', '关键事实', '争议与影响', '我的判断', '结尾互动'] },
  { value: 'product-analysis', label: '产品分析', headings: ['产品与用户', '核心体验', '能力与差异', '问题与机会', '结论'] },
  { value: 'tutorial', label: '教程', headings: ['目标与准备', '操作步骤', '关键说明', '常见问题', '总结'] },
  { value: 'short-video-script', label: '短视频口播', headings: ['开头钩子', '核心信息', '案例或反转', '结论', '行动引导'] },
  { value: 'custom-longform', label: '自定义长文', headings: ['开场', '第一部分', '第二部分', '结论'] },
] as const;

export type CanvasDocumentScenario = typeof CANVAS_DOCUMENT_SCENARIOS[number]['value'];

const decodeHtml = (value: string) => value
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");

export const htmlToPlainText = (html: string) => decodeHtml(html
  .replace(/<br\s*\/?\s*>/gi, '\n')
  .replace(/<\/p\s*>/gi, '\n\n')
  .replace(/<\/h[1-6]\s*>/gi, '\n\n')
  .replace(/<li[^>]*>/gi, '- ')
  .replace(/<\/li\s*>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim());

export const createScenarioSections = (scenario: string): WriteCanvasDocumentSection[] => {
  const preset = CANVAS_DOCUMENT_SCENARIOS.find(item => item.value === scenario) || CANVAS_DOCUMENT_SCENARIOS[5];
  const stamp = Date.now();
  return preset.headings.map((heading, index) => ({
    key: `section-${stamp}-${index + 1}`,
    heading,
    body: '',
    level: 1,
    meta: {},
  }));
};

export const buildCanvasDocumentMarkdown = (document: WriteCanvasDocument) => {
  const blocks = [`# ${document.title || '未命名作品'}`];
  if (document.summary.trim()) blocks.push(document.summary.trim());
  document.sections.forEach(section => {
    const level = Math.min(6, Math.max(2, section.level + 1));
    blocks.push(`${'#'.repeat(level)} ${section.heading || '未命名段落'}`);
    const body = htmlToPlainText(section.body);
    if (body) blocks.push(body);
  });
  return `${blocks.join('\n\n').trim()}\n`;
};

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export const buildCanvasDocumentHtml = (document: WriteCanvasDocument) => {
  const sections = document.sections.map(section => {
    const level = Math.min(6, Math.max(2, section.level + 1));
    return `<section><h${level}>${escapeHtml(section.heading || '未命名段落')}</h${level}>${section.body || '<p></p>'}</section>`;
  }).join('\n');
  return `<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(document.title || '未命名作品')}</title></head>\n<body><article><h1>${escapeHtml(document.title || '未命名作品')}</h1>${document.summary ? `<p>${escapeHtml(document.summary)}</p>` : ''}${sections}</article></body>\n</html>\n`;
};

export const downloadCanvasDocument = (document: WriteCanvasDocument, format: 'markdown' | 'html') => {
  const content = format === 'markdown' ? buildCanvasDocumentMarkdown(document) : buildCanvasDocumentHtml(document);
  const extension = format === 'markdown' ? 'md' : 'html';
  const mimeType = format === 'markdown' ? 'text/markdown;charset=utf-8' : 'text/html;charset=utf-8';
  const safeTitle = (document.title || '未命名作品').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80);
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = window.document.createElement('a');
  link.href = url;
  link.download = `${safeTitle}.${extension}`;
  link.click();
  URL.revokeObjectURL(url);
};
