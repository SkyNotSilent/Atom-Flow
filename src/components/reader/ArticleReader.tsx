import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X, Bookmark, Share, MoreHorizontal, Loader2, ExternalLink, Languages } from 'lucide-react';
import createDOMPurify, { type Config } from 'dompurify';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../Nav';
import { getDisplaySource } from '../../utils/articleDisplay';
import { logger } from '../../utils/logger';
import { AtomFlowGalaxyIcon } from '../AtomFlowGalaxyIcon';
import type { Article } from '../../types';
import { articleIdentityKey } from '../../utils/articleIdentity';

export type CitationAction = 'add-to-canvas' | 'add-and-connect';

export type CitationActionAvailability = Partial<Record<CitationAction, {
  disabled?: boolean;
  reason?: string;
}>>;

export interface CitationCapture {
  exact: string;
  prefix: string;
  suffix: string;
  paragraph: string;
  heading: string | null;
  articleId: number;
  articleTitle: string;
  source: string;
  sourceUrl?: string;
}

export interface ArticleReaderAudioRenderProps {
  article: Article;
}

export type ArticleReaderAudioRenderer = (props: ArticleReaderAudioRenderProps) => React.ReactNode;

export interface ArticleReaderProps {
  article: Article | null;
  onClose?: () => void;
  onSaveArticle?: (article: Article) => void | Promise<void>;
  onToast?: (message: string) => void;
  isSaving?: boolean;
  savingStageText?: string;
  onCitationCapture?: (capture: CitationCapture, action: CitationAction) => void | Promise<void>;
  citationActionAvailability?: CitationActionAvailability;
  audio?: 'default' | false | ArticleReaderAudioRenderer;
  variant?: 'pane' | 'embedded' | 'compact';
  className?: string;
}

type CitationToolbarState = {
  capture: CitationCapture;
  left: number;
  top: number;
};

const ARTICLE_PARAGRAPH_SELECTOR = 'p, li, blockquote, pre, figcaption, td, th, dd, dt';
const ARTICLE_HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const CITATION_CONTEXT_LENGTH = 120;
const MAX_CITATION_LENGTH = 2000;

export function getCitationToolbarPosition(
  rect: Pick<DOMRect, 'left' | 'top' | 'width'>,
  viewportWidth: number,
): Pick<CitationToolbarState, 'left' | 'top'> {
  const safeViewportWidth = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 1024;
  const toolbarHalfWidth = Math.min(180, Math.max(0, (safeViewportWidth - 16) / 2));
  return {
    left: Math.min(
      Math.max(rect.left + rect.width / 2, toolbarHalfWidth),
      Math.max(toolbarHalfWidth, safeViewportWidth - toolbarHalfWidth),
    ),
    top: Math.max(8, rect.top - 46),
  };
}

function isNodeInside(container: HTMLElement, node: Node | null): node is Node {
  return Boolean(node && (node === container || container.contains(node)));
}

/**
 * Build a stable text quote from a live DOM selection. The range must start and
 * end inside the rendered article body; title, summary, and reader chrome are
 * deliberately excluded.
 */
export function buildCitationCapture(
  articleBody: HTMLElement,
  selection: Selection | null,
  article: Article,
): CitationCapture | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  if (!isNodeInside(articleBody, selection.anchorNode) || !isNodeInside(articleBody, selection.focusNode)) return null;

  const range = selection.getRangeAt(0);
  if (!isNodeInside(articleBody, range.startContainer) || !isNodeInside(articleBody, range.endContainer)) return null;

  const exact = range.toString();
  if (!exact.trim() || exact.length < 1 || exact.length > MAX_CITATION_LENGTH) return null;

  const document = articleBody.ownerDocument;
  const articleRange = document.createRange();
  articleRange.selectNodeContents(articleBody);
  const articleText = articleRange.toString();

  const precedingRange = document.createRange();
  precedingRange.selectNodeContents(articleBody);
  precedingRange.setEnd(range.startContainer, range.startOffset);
  const startOffset = precedingRange.toString().length;
  const endOffset = startOffset + exact.length;

  const startElement = range.startContainer.nodeType === 1
    ? range.startContainer as Element
    : range.startContainer.parentElement;
  const paragraphElement = startElement?.closest(ARTICLE_PARAGRAPH_SELECTOR);
  const paragraph = paragraphElement && articleBody.contains(paragraphElement)
    ? paragraphElement.textContent?.trim() || exact
    : exact;

  let nearestHeading: Element | null = null;
  const headings = articleBody.querySelectorAll(ARTICLE_HEADING_SELECTOR);
  for (const heading of headings) {
    if (heading.contains(range.startContainer)) {
      nearestHeading = heading;
      break;
    }
    // DOCUMENT_POSITION_FOLLOWING means the selection starts after this heading.
    if ((heading.compareDocumentPosition(range.startContainer) & 4) !== 0) {
      nearestHeading = heading;
      continue;
    }
    break;
  }

  return {
    exact,
    prefix: articleText.slice(Math.max(0, startOffset - CITATION_CONTEXT_LENGTH), startOffset),
    suffix: articleText.slice(endOffset, endOffset + CITATION_CONTEXT_LENGTH),
    paragraph,
    heading: nearestHeading?.textContent?.trim() || null,
    articleId: article.id,
    articleTitle: article.title,
    source: article.source,
    sourceUrl: article.url,
  };
}

const LANG_OPTIONS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
];

const ARTICLE_HTML_SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    'article', 'section', 'div', 'span', 'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'mark', 'small', 'sub', 'sup',
    'a', 'img', 'figure', 'figcaption',
    'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'time',
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'target', 'rel',
    'width', 'height', 'loading', 'decoding', 'referrerpolicy',
    'colspan', 'rowspan', 'scope', 'datetime', 'dir', 'lang',
  ],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):[^\s]*|(?:\/{1,2}|\.\.?\/|#|\?)[^\s]*|[^\s:/?#]+(?:[/?#][^\s]*)?)$/i,
  FORBID_TAGS: [
    'style', 'form', 'input', 'button', 'select', 'textarea', 'option',
    'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
    'script', 'noscript', 'template', 'svg', 'math',
    'meta', 'link', 'base', 'title', 'head',
  ],
  FORBID_CONTENTS: [
    'style', 'form', 'input', 'button', 'select', 'textarea', 'option',
    'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
    'script', 'noscript', 'template', 'svg', 'math',
    'meta', 'link', 'base', 'title', 'head',
  ],
  FORBID_ATTR: ['style', 'srcdoc', 'formaction', 'xlink:href'],
};

let articleDOMPurify: ReturnType<typeof createDOMPurify> | null = null;

function isSafeArticleUrl(rawUrl: string): boolean {
  const url = rawUrl.trim();
  return /^(?:(?:https?|mailto|tel):[^\s]*|(?:\/{1,2}|\.\.?\/|#|\?)[^\s]*|[^\s:/?#]+(?:[/?#][^\s]*)?)$/i.test(url);
}

/**
 * Resolve article image URLs without letting malformed source metadata break the
 * reader render. Relative URLs are resolved only against a valid HTTP(S)
 * article URL; otherwise the original value is retained for graceful failure.
 */
export function resolveArticleImageSrc(rawSrc?: string, articleUrl?: string): string {
  let normalizedSrc = rawSrc?.trim() || '';
  if (!normalizedSrc) return '';

  let baseUrl: URL | undefined;
  try {
    const candidateBase = articleUrl ? new URL(articleUrl) : undefined;
    if (candidateBase && (candidateBase.protocol === 'http:' || candidateBase.protocol === 'https:')) {
      baseUrl = candidateBase;
    }
  } catch {
    baseUrl = undefined;
  }
  try {
    if (normalizedSrc.startsWith('//')) {
      normalizedSrc = new URL(normalizedSrc, baseUrl || new URL('https://atomflow.invalid')).href;
    } else if (/^https?:/i.test(normalizedSrc)) {
      normalizedSrc = new URL(normalizedSrc).href;
    } else if (!/^[a-z][a-z\d+.-]*:/i.test(normalizedSrc) && baseUrl) {
      normalizedSrc = new URL(normalizedSrc, baseUrl).href;
    }
  } catch {
    // Keep the original source for graceful failure if it cannot be safely
    // normalized. It will never be sent to the proxy unless it is HTTP(S).
  }

  if (!/^https?:\/\//i.test(normalizedSrc)) return normalizedSrc;
  try {
    return `/api/image-proxy?url=${encodeURIComponent(normalizedSrc)}&referer=${encodeURIComponent(articleUrl || '')}`;
  } catch {
    return '';
  }
}

export function sanitizeArticleHtml(rawHtml: string, articleUrl?: string): string {
  if (typeof window === 'undefined') return '';
  if (!articleDOMPurify) {
    articleDOMPurify = createDOMPurify(window);
    articleDOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
      if ((data.attrName === 'href' || data.attrName === 'src') && !isSafeArticleUrl(data.attrValue)) {
        data.keepAttr = false;
      }
    });
  }
  const sanitized = String(articleDOMPurify.sanitize(rawHtml, ARTICLE_HTML_SANITIZE_CONFIG));
  const template = window.document.createElement('template');
  template.innerHTML = sanitized;
  template.content.querySelectorAll<HTMLImageElement>('img[src]').forEach(image => {
    const proxied = resolveArticleImageSrc(image.getAttribute('src') || '', articleUrl);
    if (proxied) image.setAttribute('src', proxied);
    else image.removeAttribute('src');
    image.setAttribute('referrerpolicy', 'no-referrer');
  });
  return template.innerHTML;
}

export function looksLikeArticleHtml(content?: string): boolean {
  return /^\s*<\/?(?:article|section|div|span|p|br|hr|h[1-6]|blockquote|pre|code|ul|ol|li|dl|dt|dd|strong|em|b|i|u|s|del|mark|small|sub|sup|a|img|figure|figcaption|table|caption|colgroup|col|thead|tbody|tfoot|tr|th|td|time)\b[^>]*>/i.test(content || '');
}

// Split text content into translatable segments (paragraphs / headings)
function splitIntoSegments(text: string): string[] {
  return text.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
}

export const ArticleReader: React.FC<ArticleReaderProps> = ({
  article: currentArticle,
  onClose,
  onSaveArticle,
  onToast,
  isSaving = false,
  savingStageText,
  onCitationCapture,
  citationActionAvailability,
  audio = 'default',
  variant = 'pane',
  className,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translateActive, setTranslateActive] = useState(false);
  const [translatedTitle, setTranslatedTitle] = useState<string | null>(null);
  const [translatedSegments, setTranslatedSegments] = useState<string[] | null>(null);
  const [originalSegments, setOriginalSegments] = useState<string[] | null>(null);
  const [targetLang, setTargetLang] = useState('zh');
  const [showTranslationNotice, setShowTranslationNotice] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [citationToolbar, setCitationToolbar] = useState<CitationToolbarState | null>(null);
  const currentArticleIdentityKey = articleIdentityKey(currentArticle);
  const currentArticleIdentityRef = useRef(currentArticleIdentityKey);
  const targetLangRef = useRef(targetLang);
  const translationSequenceRef = useRef(0);
  const translationRequestRef = useRef<AbortController | null>(null);
  const displaySource = currentArticle ? getDisplaySource(currentArticle) : '未知来源';
  const shouldShowLoading = Boolean(currentArticle && !currentArticle.fullFetched && !currentArticle.content && !currentArticle.markdownContent);
  const markdownIsHtml = looksLikeArticleHtml(currentArticle?.markdownContent);
  const sanitizedArticleContent = useMemo(
    () => sanitizeArticleHtml(markdownIsHtml
      ? currentArticle?.markdownContent || ''
      : currentArticle?.content || '', currentArticle?.url),
    [currentArticle?.content, currentArticle?.markdownContent, currentArticle?.url, markdownIsHtml],
  );

  const updateCitationToolbar = useCallback(() => {
    const articleBody = contentRef.current;
    if (!articleBody || !currentArticle || !onCitationCapture) {
      setCitationToolbar(null);
      return;
    }

    const selection = articleBody.ownerDocument.defaultView?.getSelection() || null;
    const capture = buildCitationCapture(articleBody, selection, currentArticle);
    if (!capture || !selection || selection.rangeCount !== 1) {
      setCitationToolbar(null);
      return;
    }

    const range = selection.getRangeAt(0);
    if (typeof range.getBoundingClientRect !== 'function') {
      setCitationToolbar(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) {
      setCitationToolbar(null);
      return;
    }

    const viewportWidth = articleBody.ownerDocument.defaultView?.innerWidth || 1024;
    setCitationToolbar({
      capture,
      ...getCitationToolbarPosition(rect, viewportWidth),
    });
  }, [currentArticle, onCitationCapture]);

  const scheduleCitationToolbarUpdate = useCallback(() => {
    const view = contentRef.current?.ownerDocument.defaultView;
    if (view?.requestAnimationFrame) {
      view.requestAnimationFrame(updateCitationToolbar);
      return;
    }
    updateCitationToolbar();
  }, [updateCitationToolbar]);

  useEffect(() => {
    if (!onCitationCapture) return;
    const document = contentRef.current?.ownerDocument;
    if (!document) return;
    document.addEventListener('selectionchange', scheduleCitationToolbarUpdate);
    return () => document.removeEventListener('selectionchange', scheduleCitationToolbarUpdate);
  }, [onCitationCapture, scheduleCitationToolbarUpdate]);

  useEffect(() => {
    if (contentRef.current && currentArticle) {
      const links = contentRef.current.querySelectorAll('a');
      links.forEach(link => {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      });
      const handleImageError = (event: Event) => {
        const img = event.currentTarget as HTMLImageElement;
        img.style.display = 'none';
      };
      const images = contentRef.current.querySelectorAll('img');
      images.forEach(image => {
        image.addEventListener('error', handleImageError);
        if (image.complete && image.naturalWidth === 0) {
          image.style.display = 'none';
        }
      });
      return () => {
        images.forEach(image => image.removeEventListener('error', handleImageError));
      };
    }
  }, [currentArticle]);

  // Close more menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Reset scroll position and translation state when article changes.
  useEffect(() => {
    currentArticleIdentityRef.current = currentArticleIdentityKey;
    translationSequenceRef.current += 1;
    translationRequestRef.current?.abort();
    translationRequestRef.current = null;
    scrollRef.current?.scrollTo(0, 0);
    setIsTranslating(false);
    setTranslateActive(false);
    setTranslatedTitle(null);
    setTranslatedSegments(null);
    setOriginalSegments(null);
    setCitationToolbar(null);
  }, [currentArticleIdentityKey]);

  useEffect(() => () => {
    translationSequenceRef.current += 1;
    translationRequestRef.current?.abort();
  }, []);

  if (!currentArticle) return (
    <div className={cn(
      "flex-1 hidden lg:flex flex-col items-center justify-center bg-surface",
      variant === 'pane' && "border-l border-border",
      className,
    )}>
      <div className="w-24 h-24 mb-6 opacity-20">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
        </svg>
      </div>
      <p className="text-text3 text-[15px]">选择一篇文章开始阅读</p>
    </div>
  );

  const handleClose = () => {
    setTranslateActive(false);
    setTranslatedTitle(null);
    setTranslatedSegments(null);
    setOriginalSegments(null);
    setShowTranslationNotice(false);
    setCitationToolbar(null);
    onClose?.();
  };

  const performTranslate = async () => {
    if (!currentArticle) return;

    // Toggle off: clear translation
    if (translateActive) {
      setTranslateActive(false);
      return;
    }

    // Toggle on: if already translated, just activate
    if (translatedSegments) {
      setTranslateActive(true);
      return;
    }

    translationRequestRef.current?.abort();
    const requestController = new AbortController();
    const requestSequence = ++translationSequenceRef.current;
    const requestArticleIdentity = currentArticleIdentityKey;
    const requestTargetLang = targetLang;
    translationRequestRef.current = requestController;
    setIsTranslating(true);
    setTranslateActive(true);
    try {
      const rawContent = currentArticle.markdownContent || currentArticle.content || '';
      const segs = splitIntoSegments(rawContent);
      const titleText = currentArticle.title || '';

      // Translate title + segments together
      const allSegments = [titleText, ...segs];
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: allSegments, targetLang: requestTargetLang }),
        signal: requestController.signal,
      });
      const data = await response.json();

      if (
        requestSequence !== translationSequenceRef.current
        || requestArticleIdentity !== currentArticleIdentityRef.current
        || requestTargetLang !== targetLangRef.current
      ) return;

      if (!response.ok) {
        onToast?.(`翻译失败: ${data.details || data.error || '未知错误'}`);
        setTranslateActive(false);
        return;
      }

      const [transTitle, ...transSegs] = data.segments as string[];
      setTranslatedTitle(transTitle);
      setOriginalSegments(segs);
      setTranslatedSegments(transSegs);
      onToast?.('翻译完成');
    } catch (error) {
      if (requestController.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      if (
        requestSequence !== translationSequenceRef.current
        || requestArticleIdentity !== currentArticleIdentityRef.current
        || requestTargetLang !== targetLangRef.current
      ) return;
      logger.error('Translation error', { error, articleId: currentArticle.id, targetLang: requestTargetLang });
      onToast?.('翻译失败，请稍后重试');
      setTranslateActive(false);
    } finally {
      if (requestSequence === translationSequenceRef.current) {
        translationRequestRef.current = null;
        setIsTranslating(false);
      }
    }
  };

  const handleTranslate = () => {
    if (translateActive || translatedSegments) {
      void performTranslate();
      return;
    }
    setShowTranslationNotice(true);
  };

  const handleLangChange = (lang: string) => {
    targetLangRef.current = lang;
    translationSequenceRef.current += 1;
    translationRequestRef.current?.abort();
    translationRequestRef.current = null;
    setIsTranslating(false);
    setTargetLang(lang);
    // Clear existing translation so next toggle re-translates in new lang
    setTranslatedTitle(null);
    setTranslatedSegments(null);
    setOriginalSegments(null);
    setTranslateActive(false);
    setShowMoreMenu(false);
  };

  const handleBookmark = async () => {
    if (currentArticle.saved) {
      onToast?.('已收藏');
      return;
    }
    await onSaveArticle?.(currentArticle);
  };

  const handleShare = async () => {
    if (!currentArticle?.url) {
      onToast?.('暂无原文链接');
      return;
    }
    const shareData = { title: currentArticle.title, url: currentArticle.url };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        onToast?.('已唤起分享');
        return;
      } catch {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(currentArticle.url);
          onToast?.('已复制链接');
          return;
        }
      }
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(currentArticle.url);
      onToast?.('已复制链接');
    }
  };

  const handleCitationAction = (action: CitationAction) => {
    if (!citationToolbar || !onCitationCapture) return;
    const availability = citationActionAvailability?.[action];
    if (availability?.disabled) {
      onToast?.(availability.reason || '当前无法执行此操作');
      return;
    }
    const capture = citationToolbar.capture;
    setCitationToolbar(null);
    contentRef.current?.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
    Promise.resolve(onCitationCapture(capture, action)).catch(error => {
      logger.error('Failed to add article citation to canvas', {
        error,
        action,
        articleId: currentArticle.id,
      });
    });
  };

  const citationGuidance = Array.from(new Set(
    Object.values(citationActionAvailability || {})
      .filter(item => item?.disabled && item.reason)
      .map(item => item?.reason),
  )).filter((reason): reason is string => Boolean(reason));

  return (
    <div className={cn(
      "flex-1 flex flex-col bg-surface h-full overflow-hidden relative",
      variant === 'pane' ? "border-l border-border z-50" : "z-0",
      className,
    )}>
      {/* Header */}
      <div className={cn(
        "border-b border-border flex items-center justify-between shrink-0 bg-surface/80 backdrop-blur-md sticky top-0 z-10",
        variant === 'compact' ? "h-12 px-3" : "h-14 px-4",
      )}>
        <div className="flex items-center gap-2">
          {onClose && (
            <button
              type="button"
              onClick={handleClose}
              aria-label="关闭阅读器"
              className={cn(
                "w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface2 text-text2 transition-colors",
                variant === 'pane' && "lg:hidden",
              )}
            >
              <X size={20} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          {currentArticle.url && (
            <a
              href={currentArticle.url}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 h-8 rounded-full border border-border flex items-center gap-1 text-[12px] text-text2 hover:bg-surface2 transition-colors"
            >
              原文 <ExternalLink size={12} />
            </a>
          )}
          <div className="relative">
            <button
              onClick={handleTranslate}
              disabled={isTranslating}
              title="翻译"
              className={cn(
                "w-8 h-8 flex items-center justify-center rounded-full border transition-colors",
                translateActive
                  ? "border-accent bg-accent text-white"
                  : "border-border text-text2 hover:bg-surface2",
                isTranslating && "cursor-wait opacity-70"
              )}
            >
              {isTranslating
                ? <Loader2 size={15} className="animate-spin" />
                : <Languages size={15} />
              }
            </button>
            {showTranslationNotice && (
              <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-border bg-surface p-3 text-[11px] leading-5 text-text2 shadow-lg">
                <p>继续后，文章标题和正文文本将发送给当前实例配置的翻译服务。请勿翻译无权处理的敏感内容。</p>
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" onClick={() => setShowTranslationNotice(false)} className="px-2 py-1 text-text3 hover:text-text-main">取消</button>
                  <button type="button" onClick={() => { setShowTranslationNotice(false); void performTranslate(); }} className="rounded-md bg-accent px-2 py-1 font-medium text-white">继续翻译</button>
                </div>
              </div>
            )}
          </div>
          <button onClick={handleShare} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface2 text-text2 transition-colors">
            <Share size={16} />
          </button>
          {onSaveArticle && (
            <button type="button" onClick={() => void handleBookmark()} aria-label="收藏文章" className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface2 text-text2 transition-colors">
              <Bookmark size={16} />
            </button>
          )}
          {/* More menu */}
          <div ref={moreMenuRef} className="relative">
            <button
              onClick={() => setShowMoreMenu(v => !v)}
              className={cn("w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface2 text-text2 transition-colors", showMoreMenu && "bg-surface2")}
            >
              <MoreHorizontal size={16} />
            </button>
            {showMoreMenu && (
              <div className="absolute right-0 top-full mt-1.5 w-44 bg-surface border border-border rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.15)] z-50 overflow-hidden py-1">
                <div className="px-3 py-1.5 text-[11px] text-text3 font-medium uppercase tracking-wide">翻译语言</div>
                {LANG_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => handleLangChange(opt.value)}
                    className={cn(
                      "w-full text-left px-3 py-2 text-[13px] flex items-center justify-between hover:bg-surface2 transition-colors",
                      targetLang === opt.value ? "text-accent font-medium" : "text-text-main"
                    )}
                  >
                    {opt.label}
                    {targetLang === opt.value && <Check size={13} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div ref={scrollRef} onScroll={() => setCitationToolbar(null)} className="flex-1 overflow-y-auto bg-surface">
        <div className={cn(
          "mx-auto min-h-full",
          variant === 'compact' ? "max-w-none py-6 px-4" : "max-w-3xl py-10 px-6 sm:px-12",
        )}>
          <div className="mb-8">
            <h1 className={cn(
              "font-serif font-bold text-text-main leading-[1.4] mb-1",
              variant === 'compact' ? "text-xl" : "text-2xl sm:text-[32px]",
            )}>
              {currentArticle.title}
            </h1>
            {translateActive && translatedTitle && (
              <p className="text-xl sm:text-2xl font-serif text-text2 leading-[1.4] mb-4 border-l-2 border-accent/40 pl-3">
                {translatedTitle}
              </p>
            )}
            {!(translateActive && translatedTitle) && <div className="mb-4" />}
            <div className="flex items-center gap-2 mb-8 text-[13px] text-text3">
              <span className="font-medium text-accent">{displaySource}</span>
              <span>·</span>
              <span>{currentArticle.time}</span>
            </div>

            <div className="p-5 bg-accent-light/30 rounded-2xl border border-accent/10 mb-6">
              <div className="flex items-center gap-2 mb-3 text-accent font-medium text-[14px]">
                <AtomFlowGalaxyIcon size={14} /> AI 总结
              </div>
              <div className="text-[14px] text-text2 leading-relaxed">
                {currentArticle.excerpt}
              </div>
              {!currentArticle.saved && onSaveArticle ? (
                <button
                  onClick={() => void onSaveArticle(currentArticle)}
                  disabled={isSaving}
                  className="mt-4 px-4 py-2 rounded-xl text-[13px] font-medium bg-accent text-white hover:bg-opacity-90 transition-colors flex items-center gap-1.5 shadow-sm disabled:cursor-wait"
                >
                  <AtomFlowGalaxyIcon size={14} animated={isSaving} />
                  {isSaving ? savingStageText || '处理中...' : '一键存入知识库'}
                </button>
              ) : currentArticle.saved ? (
                <button
                  disabled
                  className="mt-4 px-4 py-2 rounded-xl text-[13px] font-medium bg-accent2-light text-accent2 border border-accent2-light flex items-center gap-1.5 opacity-80 cursor-not-allowed"
                >
                  <Check size={14} /> 已存入知识库
                </button>
              ) : null}
            </div>

            {typeof audio === 'function' && currentArticle.audioUrl ? audio({ article: currentArticle }) : null}
            {currentArticle.readabilityUsed && (
              <div className="mb-8 rounded-xl border border-border bg-surface2 px-4 py-3 text-[12px] text-text3 leading-relaxed">
                此内容由 Readability 提供。如果你发现排版异常，请访问源站查看原始内容。
              </div>
            )}
          </div>

          {shouldShowLoading ? (
            <div className="flex flex-col items-center justify-center py-20 text-text3">
              <Loader2 className="w-8 h-8 animate-spin mb-4 text-accent" />
              <p className="text-[14px]">正在提取全文...</p>
            </div>
          ) : (
            <div
              ref={contentRef}
              data-article-reader-body="true"
              onMouseUp={scheduleCitationToolbarUpdate}
              onKeyUp={scheduleCitationToolbarUpdate}
              className="text-[15px] sm:text-[16px] leading-[1.8] sm:leading-[2] text-text-main prose prose-p:mb-6 prose-a:text-accent prose-a:no-underline hover:prose-a:underline prose-img:rounded-xl prose-img:my-8 max-w-none pb-20 [&_section[data-footnotes]]:hidden [&_.footnotes]:hidden"
            >
              {translateActive && originalSegments && translatedSegments ? (
                // Paragraph-interleaved translation view
                <div>
                  {originalSegments.map((seg, i) => (
                    <div key={i} className="mb-6">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}
                        components={{
                          a: ({node, href, children, ...props}) => (
                            <a {...props} href={href} className="text-accent hover:underline break-all" target="_blank" rel="noreferrer">{children}</a>
                          ),
                          img: ({node, src, onError, ...props}) => {
                            const proxySrc = resolveArticleImageSrc(src, currentArticle?.url);
                            return <img {...props} src={proxySrc} referrerPolicy="no-referrer" className="w-full rounded-xl my-4 object-cover bg-surface2" loading="lazy" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />;
                          }
                        }}
                      >{seg}</ReactMarkdown>
                      {translatedSegments[i] && (
                        <p className="mt-1 text-text2 text-[14px] sm:text-[15px] leading-[1.8]">
                          {translatedSegments[i]}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : currentArticle.markdownContent && !markdownIsHtml ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({node, href, children, ...props}) => {
                      // Helper to extract text from React children
                      const extractText = (child: React.ReactNode): string => {
                        if (child === null || child === undefined || typeof child === 'boolean') return '';
                        if (typeof child === 'string' || typeof child === 'number') return String(child);
                        if (Array.isArray(child)) return child.map(extractText).join('');
                        if (React.isValidElement<{ children?: React.ReactNode }>(child)) {
                          return extractText(child.props.children);
                        }
                        return '';
                      };

                      const textContent = extractText(children).trim();
                      // Match [1], 1, [23], etc.
                      const isFootnote = /^\[?\d+\]?$/.test(textContent);

                      if (isFootnote && href) {
                        const num = textContent.replace(/\[|\]/g, '');
                        return (
                          <span className="relative group inline-block mx-0.5 align-super">
                            <a
                              {...props}
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center justify-center bg-text-main text-surface text-[10px] min-w-[16px] h-[16px] px-1 rounded-[3px] no-underline font-mono cursor-pointer transition-transform hover:scale-110 !text-surface"
                            >
                              {num}
                            </a>
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-max max-w-[280px] sm:max-w-[320px] bg-surface p-3 rounded-xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] border border-border z-[100]">
                              <div className="text-[12px] font-medium text-text3 mb-1">数据来源：</div>
                              <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline text-[13px] break-all whitespace-normal leading-tight block">
                                {href}
                              </a>
                              {/* Triangle pointer */}
                              <div className="absolute top-full left-1/2 -translate-x-1/2 border-[6px] border-transparent border-t-border">
                                <div className="absolute -top-[7px] -left-[5px] border-[5px] border-transparent border-t-surface"></div>
                              </div>
                            </div>
                          </span>
                        );
                      }

                      // Default link rendering
                      return (
                        <a {...props} href={href} className="text-accent hover:underline break-all" target="_blank" rel="noreferrer">
                          {children}
                        </a>
                      );
                    },
                    sup: ({node, children, ...props}) => {
                      // remark-gfm wraps footnotes in <sup>. We handle the superscript styling in our custom <a> component.
                      // To prevent double-superscripting, we just render the children directly.
                      return <>{children}</>;
                    },
                    img: ({node, src, onError, ...props}) => {
                      // Use our own backend proxy to bypass strict CSP (img-src 'self') and hotlink protection
                      const proxySrc = resolveArticleImageSrc(src, currentArticle?.url);
                      return (
                        <img
                          {...props}
                          src={proxySrc}
                          referrerPolicy="no-referrer"
                          className="w-full rounded-xl my-8 object-cover bg-surface2 min-h-[100px]"
                          loading="lazy"
                          onError={(event) => {
                            const target = event.currentTarget as HTMLImageElement;
                            target.style.display = 'none';
                            if (typeof onError === 'function') {
                              onError(event);
                            }
                          }}
                        />
                      );
                    }
                  }}
                >
                  {currentArticle.markdownContent}
                </ReactMarkdown>
              ) : (
                <div dangerouslySetInnerHTML={{ __html: sanitizedArticleContent }} />
              )}
            </div>
          )}
        </div>
      </div>
      {citationToolbar && onCitationCapture && typeof document !== 'undefined'
        ? createPortal(
          <div
            role="toolbar"
            aria-label="引用所选正文"
            data-reader-citation-toolbar="true"
            className="fixed z-[260] flex max-w-[calc(100vw-16px)] flex-col rounded-xl border border-border bg-surface p-1 shadow-[0_10px_35px_rgba(0,0,0,0.2)] sm:max-w-[360px]"
            style={{ left: citationToolbar.left, top: citationToolbar.top, transform: 'translateX(-50%)' }}
            onMouseDown={event => event.preventDefault()}
          >
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-text-main transition-colors hover:bg-surface2 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                onClick={() => handleCitationAction('add-to-canvas')}
                disabled={citationActionAvailability?.['add-to-canvas']?.disabled}
                title={citationActionAvailability?.['add-to-canvas']?.reason}
              >
                加入画布
              </button>
              <div className="h-5 w-px bg-border" aria-hidden="true" />
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                onClick={() => handleCitationAction('add-and-connect')}
                disabled={citationActionAvailability?.['add-and-connect']?.disabled}
                title={citationActionAvailability?.['add-and-connect']?.reason}
              >
                加入并连接当前 Agent
              </button>
            </div>
            {citationGuidance.length > 0 ? (
              <div data-reader-citation-guidance="true" className="border-t border-border px-2.5 py-1.5 text-[10px] leading-4 text-text3">
                {citationGuidance.join('；')}
              </div>
            ) : null}
          </div>,
          document.body,
        )
        : null}
    </div>
  );
};
