import React, { useEffect, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { Check, X, Bookmark, Share, MoreHorizontal, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

export const ReaderPane: React.FC = () => {
  const { readingArticle, setReadingArticle, saveArticle } = useAppContext();
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current && readingArticle) {
      const links = contentRef.current.querySelectorAll('a');
      links.forEach(link => {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      });
    }
  }, [readingArticle]);

  if (!readingArticle) return (
    <div className="flex-1 hidden lg:flex flex-col items-center justify-center bg-surface border-l border-border">
      <div className="w-24 h-24 mb-6 opacity-20">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
        </svg>
      </div>
      <p className="text-text3 text-[15px]">选择一篇文章开始阅读</p>
    </div>
  );

  const handleClose = () => setReadingArticle(null);

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
          <button className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface2 text-text2 transition-colors">
            <Share size={16} />
          </button>
          <button className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface2 text-text2 transition-colors">
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
              {readingArticle.title}
            </h1>
            <div className="flex items-center gap-2 mb-8 text-[13px] text-text3">
              <span className="font-medium text-accent">{readingArticle.source}</span>
              <span>·</span>
              <span>{readingArticle.time}</span>
            </div>

            {/* AI Summary Box */}
            <div className="p-5 bg-accent-light/30 rounded-2xl border border-accent/10 mb-10">
              <div className="flex items-center gap-2 mb-3 text-accent font-medium text-[14px]">
                <span>✦</span> AI 总结
              </div>
              <div className="text-[14px] text-text2 leading-relaxed">
                {readingArticle.excerpt}
              </div>
              {!readingArticle.saved ? (
                <button 
                  onClick={() => saveArticle(readingArticle.id)}
                  className="mt-4 px-4 py-2 rounded-xl text-[13px] font-medium bg-accent text-white hover:bg-opacity-90 transition-colors flex items-center gap-1.5 shadow-sm"
                >
                  <span>✦</span> 一键存入知识库
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
          </div>

          {!readingArticle.fullFetched ? (
            <div className="flex flex-col items-center justify-center py-20 text-text3">
              <Loader2 className="w-8 h-8 animate-spin mb-4 text-accent" />
              <p className="text-[14px]">正在通过 Jina Reader 提取全文...</p>
            </div>
          ) : (
            <div 
              ref={contentRef}
              className="text-[15px] sm:text-[16px] leading-[1.8] sm:leading-[2] text-text-main prose prose-p:mb-6 prose-a:text-accent prose-a:no-underline hover:prose-a:underline prose-img:rounded-xl prose-img:my-8 max-w-none pb-20 [&_section[data-footnotes]]:hidden [&_.footnotes]:hidden"
            >
              {readingArticle.markdownContent ? (
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
                    img: ({node, src, ...props}) => {
                      // Use our own backend proxy to bypass strict CSP (img-src 'self') and hotlink protection
                      const proxySrc = src?.startsWith('http') 
                        ? `/api/image-proxy?url=${encodeURIComponent(src)}` 
                        : src;
                      return (
                        <img 
                          {...props} 
                          src={proxySrc} 
                          referrerPolicy="no-referrer" 
                          className="w-full rounded-xl my-8 object-cover bg-surface2 min-h-[100px]" 
                          loading="lazy"
                        />
                      );
                    }
                  }}
                >
                  {readingArticle.markdownContent}
                </ReactMarkdown>
              ) : (
                <div dangerouslySetInnerHTML={{ __html: readingArticle.content }} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
