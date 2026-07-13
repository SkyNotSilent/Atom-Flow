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

type HtmlNode = HtmlTextNode | HtmlElementNode;

interface HtmlTextNode {
  type: 'text';
  value: string;
}

interface HtmlElementNode {
  type: 'element';
  tag: string;
  attributes: Record<string, string>;
  children: HtmlNode[];
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  bull: '•',
  copy: '©',
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
};

const decodeHtmlEntities = (value: string) => value.replace(
  /&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/gi,
  (entity, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isInteger(codePoint)
        || codePoint <= 0
        || codePoint > 0x10FFFF
        || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
        return '�';
      }
      return String.fromCodePoint(codePoint);
    }
    return NAMED_HTML_ENTITIES[body.toLowerCase()] ?? entity;
  },
);

const VOID_HTML_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK_HTML_TAGS = new Set(['article', 'blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ol', 'p', 'pre', 'section', 'ul']);
const OMITTED_HTML_TAGS = new Set(['head', 'noscript', 'script', 'style', 'template']);

const findTagEnd = (html: string, start: number) => {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
};

const parseOpeningTag = (source: string) => {
  let index = 0;
  while (/\s/.test(source[index] || '')) index += 1;
  const tagStart = index;
  while (/[\w:-]/.test(source[index] || '')) index += 1;
  const tag = source.slice(tagStart, index).toLowerCase();
  if (!tag) return null;

  const attributes: Record<string, string> = {};
  while (index < source.length) {
    while (/\s/.test(source[index] || '')) index += 1;
    if (source[index] === '/' || index >= source.length) break;

    const nameStart = index;
    while (/[^\s=/>]/.test(source[index] || '')) index += 1;
    const name = source.slice(nameStart, index).toLowerCase();
    if (!name) {
      index += 1;
      continue;
    }

    while (/\s/.test(source[index] || '')) index += 1;
    let value = '';
    if (source[index] === '=') {
      index += 1;
      while (/\s/.test(source[index] || '')) index += 1;
      const quote = source[index] === '"' || source[index] === "'" ? source[index] : '';
      if (quote) {
        index += 1;
        const valueStart = index;
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (/[^\s>]/.test(source[index] || '')) index += 1;
        value = source.slice(valueStart, index);
      }
    }
    attributes[name] = decodeHtmlEntities(value);
  }

  return { tag, attributes };
};

const parseHtmlFragment = (html: string): HtmlElementNode => {
  const root: HtmlElementNode = { type: 'element', tag: 'root', attributes: {}, children: [] };
  const stack = [root];
  let index = 0;

  while (index < html.length) {
    if (html[index] !== '<') {
      const nextTag = html.indexOf('<', index);
      const end = nextTag === -1 ? html.length : nextTag;
      stack[stack.length - 1].children.push({ type: 'text', value: html.slice(index, end) });
      index = end;
      continue;
    }

    if (html.startsWith('<!--', index)) {
      const commentEnd = html.indexOf('-->', index + 4);
      index = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(html, index + 1);
    if (tagEnd === -1) {
      stack[stack.length - 1].children.push({ type: 'text', value: html.slice(index) });
      break;
    }

    const source = html.slice(index + 1, tagEnd).trim();
    index = tagEnd + 1;
    if (!source || source.startsWith('!') || source.startsWith('?')) continue;

    if (source.startsWith('/')) {
      const closingTag = source.slice(1).trim().split(/\s/, 1)[0]?.toLowerCase();
      for (let stackIndex = stack.length - 1; stackIndex > 0; stackIndex -= 1) {
        if (stack[stackIndex].tag === closingTag) {
          stack.length = stackIndex;
          break;
        }
      }
      continue;
    }

    const parsed = parseOpeningTag(source);
    if (!parsed) {
      stack[stack.length - 1].children.push({ type: 'text', value: `<${source}>` });
      continue;
    }
    const element: HtmlElementNode = { type: 'element', ...parsed, children: [] };
    stack[stack.length - 1].children.push(element);
    if (!source.endsWith('/') && !VOID_HTML_TAGS.has(element.tag)) stack.push(element);
  }

  return root;
};

const escapeMarkdownText = (value: string) => value
  .replace(/\\/g, '\\\\')
  .replace(/([`*_\[\]])/g, '\\$1')
  .replace(/</g, '\\<')
  .replace(/>/g, '\\>')
  .replace(/^(\s*)(#{1,6}|>|[-+])(?=\s)/gm, '$1\\$2')
  .replace(/^(\s*)(\d+)\.(?=\s)/gm, '$1$2\\.');

const normalizeInlineWhitespace = (value: string) => value.replace(/\s+/g, ' ');

const getRawText = (node: HtmlNode): string => node.type === 'text'
  ? decodeHtmlEntities(node.value)
  : node.children.map(getRawText).join('');

const safeMarkdownUrl = (value: string) => {
  const decoded = value.trim();
  if (!decoded || /[\u0000-\u001F\u007F]/.test(decoded)) return '';
  const scheme = decoded.match(/^([a-z][\w+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && !['http', 'https', 'mailto', 'tel'].includes(scheme)) return '';
  try {
    return encodeURI(decoded)
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/</g, '%3C')
      .replace(/>/g, '%3E');
  } catch {
    return '';
  }
};

const codeFence = (value: string, minimum = 1) => {
  const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length));
  return '`'.repeat(Math.max(minimum, longestRun + 1));
};

const renderInlineNodes = (nodes: HtmlNode[]): string => nodes.map(node => {
  if (node.type === 'text') return escapeMarkdownText(normalizeInlineWhitespace(decodeHtmlEntities(node.value)));
  if (OMITTED_HTML_TAGS.has(node.tag)) return '';

  const content = () => renderInlineNodes(node.children);
  if (node.tag === 'br') return '  \n';
  if (node.tag === 'strong' || node.tag === 'b') {
    const inner = content().trim();
    return inner ? `**${inner}**` : '';
  }
  if (node.tag === 'em' || node.tag === 'i') {
    const inner = content().trim();
    return inner ? `*${inner}*` : '';
  }
  if (node.tag === 'code') {
    const raw = getRawText(node).replace(/\s*\n\s*/g, ' ');
    if (!raw) return '';
    const fence = codeFence(raw);
    const padded = /^\s|\s$|^`|`$/.test(raw) ? ` ${raw} ` : raw;
    return `${fence}${padded}${fence}`;
  }
  if (node.tag === 'a') {
    const label = content().trim() || escapeMarkdownText(node.attributes.href || '');
    const href = safeMarkdownUrl(node.attributes.href || '');
    return href ? `[${label}](${href})` : label;
  }
  if (node.tag === 'del' || node.tag === 's') {
    const inner = content().trim();
    return inner ? `~~${inner}~~` : '';
  }
  return content();
}).join('');

const normalizeMarkdown = (value: string) => value
  .replace(/\r\n?/g, '\n')
  .split('\n')
  .map(line => {
    if (!line.trim()) return '';
    return line.endsWith('  ') ? `${line.trimEnd()}  ` : line.trimEnd();
  })
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const renderBlocks = (nodes: HtmlNode[], depth = 0): string => {
  const blocks: string[] = [];
  let inlineBuffer = '';

  const flushInline = () => {
    const rendered = inlineBuffer.trim();
    if (rendered) blocks.push(rendered);
    inlineBuffer = '';
  };

  nodes.forEach(node => {
    if (node.type === 'element' && BLOCK_HTML_TAGS.has(node.tag)) {
      flushInline();
      const rendered = renderBlockNode(node, depth).trim();
      if (rendered) blocks.push(rendered);
      return;
    }
    inlineBuffer += renderInlineNodes([node]);
  });
  flushInline();

  return blocks.join('\n\n');
};

const renderList = (node: HtmlElementNode, depth: number) => {
  const ordered = node.tag === 'ol';
  let counter = ordered ? Number.parseInt(node.attributes.start || '1', 10) : 1;
  if (!Number.isFinite(counter)) counter = 1;
  const lines: string[] = [];

  node.children.filter((child): child is HtmlElementNode => child.type === 'element' && child.tag === 'li').forEach(item => {
    const explicitValue = Number.parseInt(item.attributes.value || '', 10);
    if (ordered && Number.isFinite(explicitValue)) counter = explicitValue;
    const marker = ordered ? `${counter}.` : '-';
    const nestedLists = item.children.filter((child): child is HtmlElementNode => child.type === 'element' && (child.tag === 'ol' || child.tag === 'ul'));
    const contentNodes = item.children.filter(child => !(child.type === 'element' && (child.tag === 'ol' || child.tag === 'ul')));
    const contentLines = normalizeMarkdown(renderBlocks(contentNodes, depth + 1) || '').split('\n');
    const indentation = '  '.repeat(depth);
    lines.push(`${indentation}${marker} ${contentLines[0] || ''}`.trimEnd());
    contentLines.slice(1).forEach(line => {
      lines.push(line ? `${indentation}${' '.repeat(marker.length + 1)}${line}` : '');
    });
    nestedLists.forEach(nested => lines.push(renderList(nested, depth + 1)));
    if (ordered) counter += 1;
  });

  return lines.join('\n');
};

function renderBlockNode(node: HtmlElementNode, depth: number): string {
  if (OMITTED_HTML_TAGS.has(node.tag)) return '';
  if (/^h[1-6]$/.test(node.tag)) {
    const level = Number.parseInt(node.tag[1], 10);
    const heading = renderInlineNodes(node.children).trim();
    return heading ? `${'#'.repeat(level)} ${heading}` : '';
  }
  if (node.tag === 'p') return renderInlineNodes(node.children).trim();
  if (node.tag === 'blockquote') {
    const quote = normalizeMarkdown(renderBlocks(node.children, depth));
    return quote.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
  }
  if (node.tag === 'ol' || node.tag === 'ul') return renderList(node, depth);
  if (node.tag === 'pre') {
    const raw = getRawText(node).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (!raw) return '';
    const fence = codeFence(raw, 3);
    return `${fence}\n${raw}\n${fence}`;
  }
  if (node.tag === 'hr') return '---';
  return renderBlocks(node.children, depth);
}

export const htmlToMarkdown = (html: string) => normalizeMarkdown(renderBlocks(parseHtmlFragment(html).children));

// Kept for callers that imported the previous helper; export now preserves rich semantics.
export const htmlToPlainText = htmlToMarkdown;

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
    const body = htmlToMarkdown(section.body);
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
