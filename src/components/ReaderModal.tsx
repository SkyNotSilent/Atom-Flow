import React, { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { Check, X, Bookmark, Share, MoreHorizontal, Loader2, ExternalLink, Sparkles, Languages } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { cn } from './Nav';
import { getDisplaySource } from '../utils/articleDisplay';

export const ReaderPane: React.FC = () => {
  const { readingArticle, setReadingArticle, saveArticle, showToast, isSavingArticle, getSavingStageText, articles } = useAppContext();
  const contentRef = useRef<HTMLDivElement>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translatedContent, setTranslatedContent] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const currentArticle = readingArticle ? (articles.find(article => article.id === readingArticle.id) || readingArticle) : null;
  const displaySource = currentArticle ? getDisplaySource(currentArticle) : '未知来源';
  const shouldShowLoading = Boolean(currentArticle && !currentArticle.fullFetched && !currentArticle.content && !currentArticle.markdownContent);

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
    setTranslatedContent(null);
    setShowOriginal(false);
  };

  const handleTranslate = async () => {
    if (!currentArticle) return;
    
    if (translatedContent) {
      setShowOriginal(!showOriginal);
      return;
    }

    setIsTranslating(true);
    try {
      const contentToTranslate = currentArticle.markdownContent || currentArticle.content;
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: contentToTranslate, targetLang: 'zh-CN' })
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('Translation API error:', data);
        if (data.details?.includes('GEMINI_API_KEY')) {
          showToast('翻译服务未配置，请联系管理员');
        } else {
          showToast(`翻译失败: ${data.details || data.error || '未知错误'}`);
        }
        return;
      }

      setTranslatedContent(data.translatedContent);
      setShowOriginal(false);
      showToast('翻译完成');
    } catch (error) {
      console.error('Translation error:', error);
      showToast('翻译失败，请稍后重试');
    } finally {
      setIsTranslating(false);
    }
  };

  const handleBookmark = async () => {
    if (!currentArticle) return;
    if (currentArticle.saved) {
      showToast('已收藏');
      return;
    }
    await saveArticle(currentArticle.id);
    showToast('已收藏');
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
            className={cn(
              "px-2.5 h-8 rounded-full border flex items-center gap-1 text-[12px] transition-colors",
              translatedContent 
                ? "border-accent bg-accent-light text-accent hover:bg-accent hover:text-white" 
                : "border-border text-text2 hover:bg-surface2",
              isTranslating && "cursor-wait opacity-70"
            )}
          >
            <Languages size={14} className={cn(isTranslating && "animate-pulse")} />
            <span className="hidden sm:inline">
              {isTranslating ? '翻译中...' : translatedContent ? (showOriginal ? '查看译文' : '查看原文') : '翻译'}
            </span>
          </button>
          <button onClick={handleShare} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface2 text-text2 transition-colors">
            <Share size={16} />
          </button>
          <button onClick={handleBookmark} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface2 text-text2 transition-colors">
            <Bookmark size={16} />
          </button>
          <button className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface2 text-text2 transition-colors">
            <MoreHorizontal size={16} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto bg-surface">
        <div className="max-w-3xl mx-auto py-10 px-6 sm:px-12 min-h-full">
          <div className="mb-8">
            <h1 className="font-serif text-2xl sm:text-[32px] font-bold text-text-main leading-[1.4] mb-4">
              {currentArticle.title}
            </h1>
            <div className="flex items-center gap-2 mb-8 text-[13px] text-text3">
              <span className="font-medium text-accent">{displaySource}</span>
              <span>·</span>
              <span>{currentArticle.time}</span>
              {currentArticle.audioDuration && (
                <>
                  <span>·</span>
                  <span>🎙️ {currentArticle.audioDuration}</span>
                </>
              )}
            </div>

            {currentArticle.audioUrl && (
              <div className="mb-8 p-4 bg-surface2 rounded-2xl border border-border">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-accent-light flex items-center justify-center text-accent">
                    🎙️
                  </div>
                  <div className="flex-1">
                    <div className="text-[13px] font-medium text-text-main">播客音频</div>
                    <div className="text-[12px] text-text3">
                      {currentArticle.audioDuration || '点击播放'}
                    </div>
                  </div>
                </div>
                <audio 
                  controls 
                  className="w-full"
                  preload="metadata"
                  style={{
                    height: '40px',
                    borderRadius: '8px'
                  }}
                >
                  <source src={currentArticle.audioUrl} type="audio/mpeg" />
                  您的浏览器不支持音频播放
                </audio>
              </div>
            )}

            <div className="p-5 bg-accent-light/30 rounded-2xl border border-accent/10 mb-10">
              <div className="flex items-center gap-2 mb-3 text-accent font-medium text-[14px]">
                <span>✦</span> AI 总结
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
                  <Sparkles size={14} className={cn(isSavingArticle(currentArticle.id) && "animate-spin")} />
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
              {translatedContent && !showOriginal ? (
                <div>
                  <div className="mb-6 p-3 bg-accent-light/30 rounded-xl border border-accent/20 text-[13px] text-accent flex items-center gap-2">
                    <Languages size={16} />
                    <span>以下为 AI 翻译内容</span>
                  </div>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeRaw]}
                  >
                    {translatedContent}
                  </ReactMarkdown>
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
