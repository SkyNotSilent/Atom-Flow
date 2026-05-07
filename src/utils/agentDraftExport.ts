import { marked } from 'marked';
import createDOMPurify from 'dompurify';

interface PreparedAgentDraftNote {
  title: string;
  content: string;
}

const FALLBACK_TITLE = '未命名文章';
const META_KEYWORDS = [
  '我们保留了',
  '我保留了',
  '标题建议',
  '风格模拟',
  '风格仿写',
  '核心逻辑',
  '事件报道',
  '转折为对',
  '深度复盘',
  '--- ###',
  '正文草稿',
];
const STRUCTURED_TAG_PATTERN = /^(?:标题建议|主标题|副标题|正文章稿|正文草稿)[:：]/;
const MAIN_TITLE_PATTERN = /^主标题[:：]\s*(.+)$/;
const SUBTITLE_PATTERN = /^副标题[:：]\s*(.+)$/;
const INLINE_SUBTITLE_PATTERN = /(?:^|\s)(?:副标题|小标题)[:：]\s*/;
let domPurifyInstance: ReturnType<typeof createDOMPurify> | null = null;

const getDOMPurify = (): ReturnType<typeof createDOMPurify> => {
  if (domPurifyInstance) {
    return domPurifyInstance;
  }

  if (typeof window !== 'undefined') {
    domPurifyInstance = createDOMPurify(window);
    return domPurifyInstance;
  }

  throw new Error('DOMPurify requires a browser window');
};

const isMetaLine = (line: string): boolean => {
  const trimmed = line.trim();
  return META_KEYWORDS.some(keyword => trimmed.includes(keyword));
};

const isStructuredTagLine = (line: string): boolean => STRUCTURED_TAG_PATTERN.test(line.trim());

const normalizeTitle = (title: string): string => title
  .replace(INLINE_SUBTITLE_PATTERN, ' 副标题：')
  .split(' 副标题：')[0]
  .replace(/^[#*\-\s]+/, '')
  .replace(/[#*\-]+$/, '')
  .replace(/\*\*/g, '')
  .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
  .replace(/[:：]\s*$/, '')
  .trim()
  .slice(0, 50);

const extractStructuredValue = (value: string): string => normalizeTitle(value);

const extractInlineSubtitle = (line: string): string => {
  const match = line.match(INLINE_SUBTITLE_PATTERN);
  if (!match?.index && match?.index !== 0) return '';
  return extractStructuredValue(line.slice(match.index + match[0].length));
};

const renderMarkdownToSafeHtml = (markdown: string): string => {
  const rawHtml = marked.parse(markdown, { async: false, gfm: true, breaks: false });
  return getDOMPurify().sanitize(rawHtml);
};

const formatSubtitleMarkdown = (subtitle: string): string => {
  const normalizedSubtitle = normalizeTitle(subtitle);
  return normalizedSubtitle ? `> ${normalizedSubtitle}` : '';
};

const extractTitleAndCleanMarkdown = (rawContent: string): { title: string; markdown: string } => {
  if (!rawContent.trim()) {
    return { title: FALLBACK_TITLE, markdown: '' };
  }

  const lines = rawContent.split('\n');
  let title = FALLBACK_TITLE;
  let subtitle = '';
  let contentStartIndex = 0;

  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i].trim();
    const subtitleMatch = line.match(SUBTITLE_PATTERN);
    if (subtitleMatch?.[1]) {
      subtitle = extractStructuredValue(subtitleMatch[1]);
      continue;
    }
    if (line.match(MAIN_TITLE_PATTERN)) {
      const inlineSubtitle = extractInlineSubtitle(line);
      if (inlineSubtitle) subtitle = inlineSubtitle;
    }
  }

  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i].trim();
    const titleMatch = line.match(MAIN_TITLE_PATTERN);
    if (titleMatch?.[1]) {
      title = extractStructuredValue(titleMatch[1]);
      contentStartIndex = i + 1;
      break;
    }
  }

  if (title === FALLBACK_TITLE) {
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
      const line = lines[i].trim();
      const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
      const headingTitle = headingMatch?.[1]?.trim() || '';
      if (headingTitle && !isMetaLine(headingTitle) && !isStructuredTagLine(headingTitle)) {
        title = headingTitle;
        contentStartIndex = i + 1;
        break;
      }
    }
  }

  if (title === FALLBACK_TITLE) {
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
      const line = lines[i].trim();
      const boldMatch = line.match(/^\*\*(.+?)\*\*$/);
      if (boldMatch?.[1] && !isMetaLine(line) && !isStructuredTagLine(line)) {
        title = boldMatch[1].trim();
        contentStartIndex = i + 1;
        break;
      }
    }
  }

  if (title === FALLBACK_TITLE) {
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
      const line = lines[i].trim();
      if (line.length > 10 && !line.startsWith('---') && !line.startsWith('###') && !isMetaLine(line) && !isStructuredTagLine(line)) {
        title = line.replace(/^[#*\-\s]+/, '').slice(0, 50);
        contentStartIndex = i + 1;
        break;
      }
    }
  }

  const cleanedLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines.slice(contentStartIndex)) {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      cleanedLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      cleanedLines.push(line);
      continue;
    }

    if (trimmed.match(/^[-*_]{3,}$/) || isMetaLine(line) || isStructuredTagLine(line)) {
      continue;
    }

    cleanedLines.push(line);
  }

  const markdown = [formatSubtitleMarkdown(subtitle), cleanedLines.join('\n')]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    title: normalizeTitle(title) || FALLBACK_TITLE,
    markdown: markdown || rawContent.trim(),
  };
};

export const prepareAgentDraftForNote = (rawContent: string): PreparedAgentDraftNote => {
  const { title, markdown } = extractTitleAndCleanMarkdown(rawContent);

  return {
    title,
    content: renderMarkdownToSafeHtml(markdown),
  };
};
