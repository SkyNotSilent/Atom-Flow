import React, { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { Check, X, Bookmark, Share, MoreHorizontal, Loader2, ExternalLink, Languages, Play, Pause } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { cn } from './Nav';
import { getDisplaySource } from '../utils/articleDisplay';
import { logger } from '../utils/logger';
import { AtomFlowGalaxyIcon } from './AtomFlowGalaxyIcon';

const LANG_OPTIONS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
];

// Split text content into translatable segments (paragraphs / headings)
function splitIntoSegments(text: string): string[] {
  return text.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
}

export const ReaderPane: React.FC<{ onClose?: () => void }> = () => {
  const { readingArticle, setReadingArticle, saveArticle, showToast, isSavingArticle, getSavingStageText, articles } = useAppContext();
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translateActive, setTranslateActive] = useState(false);
  const [translatedTitle, setTranslatedTitle] = useState<string | null>(null);
  const [translatedSegments, setTranslatedSegments] = useState<string[] | null>(null);
  const [originalSegments, setOriginalSegments] = useState<string[] | null>(null);
  const [targetLang, setTargetLang] = useState('zh');
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const currentArticle = readingArticle ? (articles.find(article => article.id === readingArticle.id) || readingArticle) : null;
  const displaySource = currentArticle ? getDisplaySource(currentArticle) : '未知来源';
  const shouldShowLoading = Boolean(currentArticle && !currentArticle.fullFetched && !currentArticle.content && !currentArticle.markdownContent);
  const isPodcast = currentArticle?.source === '张小珺商业访谈录' && currentArticle?.audioUrl;

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

  // Audio player effects
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !isPodcast) return;

    const updateTime = () => setCurrentTime(audio.currentTime);
    const updateDuration = () => setDuration(audio.duration);
    const handleEnded = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', updateTime);
    audio.addEventListener('loadedmetadata', updateDuration);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', updateTime);
      audio.removeEventListener('loadedmetadata', updateDuration);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [isPodcast, currentArticle?.audioUrl]);

  // Reset scroll position, audio state, and translation state when article changes
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setTranslateActive(false);
    setTranslatedTitle(null);
    setTranslatedSegments(null);
    setOriginalSegments(null);
  }, [currentArticle?.id]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch(error => logger.error('Failed to play article audio', { error, articleId: currentArticle?.id }));
    }
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;

    const newTime = parseFloat(e.target.value);
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const formatTime = (time: number) => {
    if (!time || isNaN(time)) return '00:00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  if (!currentArticle) return (
    <div className="flex-1 hidden lg:flex flex-col items-center justify-center bg-surface border-l border-border">
      <div className="w-24 h-24 mb-6 opacity-20">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
        </svg>
      </div>
      <p className="text-text3 text-[15px]">选择一篇文章开始阅读</p>
    </div>
  );

  const handleClose = () => {
    setReadingArticle(null);
    setTranslateActive(false);
    setTranslatedTitle(null);
    setTranslatedSegments(null);
    setOriginalSegments(null);
  };

  const handleTranslate = async () => {
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
        body: JSON.stringify({ segments: allSegments, targetLang })
      });
      const data = await response.json();

      if (!response.ok) {
        showToast(`翻译失败: ${data.details || data.error || '未知错误'}`);
        setTranslateActive(false);
        return;
      }

      const [transTitle, ...transSegs] = data.segments as string[];
      setTranslatedTitle(transTitle);
      setOriginalSegments(segs);
      setTranslatedSegments(transSegs);
      showToast('翻译完成');
    } catch (error) {
      logger.error('Translation error', { error, articleId: currentArticle.id, targetLang });
      showToast('翻译失败，请稍后重试');
      setTranslateActive(false);
    } finally {
      setIsTranslating(false);
    }
  };

  const handleLangChange = (lang: string) => {
    setTargetLang(lang);
    // Clear existing translation so next toggle re-translates in new lang
    setTranslatedTitle(null);
    setTranslatedSegments(null);
    setOriginalSegments(null);
    setTranslateActive(false);
    setShowMoreMenu(false);
  };

  const handleBookmark = async () => {
    if (!currentArticle) return;
    if (currentArticle.saved) {
      showToast('已收藏');
      return;
    }
    await saveArticle(currentArticle.id);
  };

  const handleShare = async () => {
    if (!currentArticle?.url) {
      showToast('暂无原文链接');
      return;
    }
    const shareData = { title: currentArticle.title, url: currentArticle.url };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        showToast('已唤起分享');
        return;
      } catch {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(currentArticle.url);
          showToast('已复制链接');
          return;
        }
      }
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(currentArticle.url);
      showToast('已复制链接');
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-surface border-l border-border h-full overflow-hidden relative z-50">
      {/* Header */}
      <div className="h-14 border-b border-border flex items-center justify-between px-4 shrink-0 bg-surface/80 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <button 
            onClick={handleClose}
            className="w-8 h-8 flex lg:hidden items-center justify-center rounded-full hover:bg-surface2 text-text2 transition-colors"
          >
            <X size={20} />
          </button>
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
          <button onClick={handleShare} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface2 text-text2 transition-colors">
            <Share size={16} />
          </button>
          <button onClick={handleBookmark} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface2 text-text2 transition-colors">
            <Bookmark size={16} />
          </button>
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-surface">
        <div className="max-w-3xl mx-auto py-10 px-6 sm:px-12 min-h-full">
          <div className="mb-8">
            <h1 className="font-serif text-2xl sm:text-[32px] font-bold text-text-main leading-[1.4] mb-1">
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
              {!currentArticle.saved ? (
                <button 
                  onClick={() => void saveArticle(currentArticle.id)}
                  disabled={isSavingArticle(currentArticle.id)}
                  className="mt-4 px-4 py-2 rounded-xl text-[13px] font-medium bg-accent text-white hover:bg-opacity-90 transition-colors flex items-center gap-1.5 shadow-sm disabled:cursor-wait"
                >
                  <AtomFlowGalaxyIcon size={14} className={cn(isSavingArticle(currentArticle.id) && "animate-spin")} />
                  {isSavingArticle(currentArticle.id) ? getSavingStageText(currentArticle.id) || '处理中...' : '一键存入知识库'}
                </button>
              ) : (
                <button 
                  disabled
                  className="mt-4 px-4 py-2 rounded-xl text-[13px] font-medium bg-accent2-light text-accent2 border border-accent2-light flex items-center gap-1.5 opacity-80 cursor-not-allowed"
                >
                  <Check size={14} /> 已存入知识库
                </button>
              )}
            </div>

            {/* Audio Player for Podcast */}
            {isPodcast && (
              <div className="mb-10 p-5 bg-surface2 rounded-2xl border border-border">
                <audio ref={audioRef} src={currentArticle.audioUrl} preload="metadata" />
                <div className="flex items-center gap-4">
                  <button
                    onClick={togglePlay}
                    className="w-12 h-12 flex items-center justify-center rounded-full bg-accent text-white hover:bg-accent/90 transition-colors shadow-sm"
                  >
                    {isPlaying ? <Pause size={20} /> : <Play size={20} className="ml-0.5" />}
                  </button>
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-2 text-[12px] text-text3">
                      <span>{formatTime(currentTime)}</span>
                      <span>{formatTime(duration)}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={duration || 0}
                      value={currentTime}
                      onChange={handleSeek}
                      className="w-full h-1.5 bg-border rounded-full appearance-none cursor-pointer accent-accent hover:accent-accent/80"
                      style={{
                        background: `linear-gradient(to right, #0ea5e9 0%, #0ea5e9 ${(currentTime / (duration || 1)) * 100}%, #e2e8f0 ${(currentTime / (duration || 1)) * 100}%, #e2e8f0 100%)`
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
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
              className="text-[15px] sm:text-[16px] leading-[1.8] sm:leading-[2] text-text-main prose prose-p:mb-6 prose-a:text-accent prose-a:no-underline hover:prose-a:underline prose-img:rounded-xl prose-img:my-8 max-w-none pb-20 [&_section[data-footnotes]]:hidden [&_.footnotes]:hidden"
            >
              {translateActive && originalSegments && translatedSegments ? (
                // Paragraph-interleaved translation view
                <div>
                  {originalSegments.map((seg, i) => (
                    <div key={i} className="mb-6">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}
                        components={{
                          a: ({node, href, children, ...props}) => (
                            <a {...props} href={href} className="text-accent hover:underline break-all" target="_blank" rel="noreferrer">{children}</a>
                          ),
                          img: ({node, src, onError, ...props}) => {
                            let normalizedSrc = src || '';
                            if (normalizedSrc.startsWith('//')) normalizedSrc = `https:${normalizedSrc}`;
                            else if (normalizedSrc.startsWith('/')) {
                              const articleHost = currentArticle?.url ? new URL(currentArticle.url).origin : '';
                              normalizedSrc = articleHost ? `${articleHost}${normalizedSrc}` : normalizedSrc;
                            }
                            const proxySrc = normalizedSrc.startsWith('http')
                              ? `/api/image-proxy?url=${encodeURIComponent(normalizedSrc)}&referer=${encodeURIComponent(currentArticle?.url || '')}`
                              : normalizedSrc;
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
              ) : currentArticle.markdownContent ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw]}
                  components={{
                    a: ({node, href, children, ...props}) => {
                      // Helper to extract text from React children
                      const extractText = (childArray: any): string => {
                        if (!childArray) return '';
                        if (typeof childArray === 'string') return childArray;
                        if (Array.isArray(childArray)) return childArray.map(extractText).join('');
                        if (childArray.props && childArray.props.children) return extractText(childArray.props.children);
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
                      let normalizedSrc = src || '';
                      if (normalizedSrc.startsWith('//')) {
                        normalizedSrc = `https:${normalizedSrc}`;
                      } else if (normalizedSrc.startsWith('/')) {
                        const articleHost = currentArticle?.url ? new URL(currentArticle.url).origin : '';
                        normalizedSrc = articleHost ? `${articleHost}${normalizedSrc}` : normalizedSrc;
                      }
                      const proxySrc = normalizedSrc.startsWith('http')
                        ? `/api/image-proxy?url=${encodeURIComponent(normalizedSrc)}&referer=${encodeURIComponent(currentArticle?.url || '')}`
                        : normalizedSrc;
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
                <div dangerouslySetInnerHTML={{ __html: currentArticle.content }} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
