const ARTICLE_HTML_TAG_PATTERN = /<\/?(?:article|section|div|span|p|br|hr|h[1-6]|blockquote|pre|code|ul|ol|li|dl|dt|dd|strong|em|b|i|u|s|del|mark|small|sub|sup|a|img|figure|figcaption|table|caption|colgroup|col|thead|tbody|tfoot|tr|th|td|time|script|style|iframe|form|input|button|select|textarea|object|embed|meta|link)\b[^>]*>/i;

export function stripMarkdownCodeExamples(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]+`/g, '');
}

export function detectArticleContentFormat(content: string): 'html' | 'text' {
  return ARTICLE_HTML_TAG_PATTERN.test(stripMarkdownCodeExamples(content)) ? 'html' : 'text';
}
