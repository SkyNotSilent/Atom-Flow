import React, { useState, useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { Check, Plus } from 'lucide-react';
import { cn } from '../components/Nav';
import { logger } from '../utils/logger';

interface SourceRecommendation {
  name: string;
  description: string;
  categories: Array<'国内媒体' | '播客' | 'X' | 'YouTube' | '公众号' | '其他'>;
  url: string;
  color: string;
  icon?: string;
}

const RECOMMENDED_SOURCES: SourceRecommendation[] = [
  // 国内媒体
  { name: '36氪', description: '创投商业资讯', categories: ['国内媒体'], url: 'rsshub://36kr/hot-list', color: '#E53E3E', icon: 'https://36kr.com/favicon.ico' },
  { name: '虎嗅', description: '商业深度分析', categories: ['国内媒体'], url: 'https://www.huxiu.com/rss/0.xml', color: '#DD6B20', icon: 'https://www.huxiu.com/favicon.ico' },
  { name: '少数派', description: '科技生活方式', categories: ['国内媒体'], url: 'rsshub://sspai/index', color: '#553C9A', icon: 'https://cdn.sspai.com/sspai/assets/img/favicon.ico' },
  { name: '人人都是产品经理', description: '产品运营知识', categories: ['国内媒体'], url: 'https://www.woshipm.com/feed', color: '#2B6CB0', icon: 'https://www.woshipm.com/favicon.ico' },
  { name: '即刻话题', description: '热门话题讨论', categories: ['国内媒体'], url: 'rsshub://jike/topic/63579abb6724cc583b9bba9a', color: '#38A169', icon: 'https://web.okjike.com/favicon.ico' },
  
  // 播客
  { name: '张小珺商业访谈录', description: '深度商业访谈节目', categories: ['播客'], url: 'https://feed.xyzfm.space/dk4yh3pkpjp3', color: '#FF6B6B', icon: 'https://xyzfm.space/favicon.ico' },
  { name: 'Lex Fridman', description: 'AI & 科技深度对话', categories: ['播客', 'YouTube'], url: 'rsshub://youtube/user/%40lexfridman', color: '#000000', icon: 'https://www.youtube.com/s/desktop/d743f786/img/favicon_144x144.png' },
  
  // X (Twitter)
  { name: 'Sam Altman', description: 'OpenAI CEO 推特', categories: ['X'], url: 'rsshub://twitter/user/sama', color: '#1DA1F2', icon: 'https://abs.twimg.com/favicons/twitter.3.ico' },
  
  // YouTube
  { name: 'Y Combinator', description: '创业孵化器官方频道', categories: ['YouTube'], url: 'rsshub://youtube/user/%40ycombinator', color: '#FF0000', icon: 'https://www.youtube.com/s/desktop/d743f786/img/favicon_144x144.png' },
  { name: 'Andrej Karpathy', description: 'AI 研究与教学', categories: ['YouTube'], url: 'rsshub://youtube/user/@AndrejKarpathy', color: '#FF0000', icon: 'https://www.youtube.com/s/desktop/d743f786/img/favicon_144x144.png' },
  
  // 公众号
  { name: '数字生命卡兹克', description: '科技人文思考', categories: ['公众号'], url: 'https://wechat2rss.bestblogs.dev/feed/ff621c3e98d6ae6fceb3397e57441ffc6ea3c17f.xml', color: '#6B46C1', icon: 'https://bestblogs.dev/favicon.ico' },
  { name: '新智元', description: 'AI 前沿资讯', categories: ['公众号'], url: 'https://plink.anyfeeder.com/weixin/AI_era', color: '#2F855A', icon: 'https://plink.anyfeeder.com/favicon.ico' },
  
  // 其他
  { name: 'GitHub Blog', description: '技术前沿动态', categories: ['其他'], url: 'https://github.blog/feed/', color: '#24292F', icon: 'https://github.githubassets.com/favicons/favicon.svg' },
];

export const DiscoverPage: React.FC = () => {
  const { showToast, reloadArticles } = useAppContext();
  const [selectedCategory, setSelectedCategory] = useState<'全部' | '国内媒体' | '播客' | 'X' | 'YouTube' | '公众号' | '其他'>('全部');
  const [addedSources, setAddedSources] = useState<Set<string>>(new Set());
  const [loadingSources, setLoadingSources] = useState<Set<string>>(new Set());
  const [customInput, setCustomInput] = useState('');
  const [customAlias, setCustomAlias] = useState('');
  const [isAddingCustom, setIsAddingCustom] = useState(false);

  // 从 localStorage 获取已添加的源
  const existingSources = useMemo(() => {
    try {
      const stored = localStorage.getItem('atomflow:source-layout:v1');
      if (!stored) return new Set<string>();
      const parsed = JSON.parse(stored);
      const names = new Set<string>();
      
      // 处理新版本格式（带version字段）
      const entries = parsed.version ? parsed.entries : parsed;
      
      if (Array.isArray(entries)) {
        entries.forEach((entry: any) => {
          if (entry.type === 'source' && entry.name) {
            names.add(entry.name);
          }
          if (entry.type === 'collection' && Array.isArray(entry.children)) {
            entry.children.forEach((child: any) => {
              if (child.name) names.add(child.name);
            });
          }
        });
      }
      return names;
    } catch {
      return new Set<string>();
    }
  }, [addedSources]);

  const filteredSources = useMemo(() => {
    let sources = RECOMMENDED_SOURCES;
    
    if (selectedCategory !== '全部') {
      sources = sources.filter(s => s.categories.includes(selectedCategory));
    }
    
    return sources;
  }, [selectedCategory]);

  const handleAddSource = async (source: SourceRecommendation) => {
    if (existingSources.has(source.name) || loadingSources.has(source.name)) return;

    setLoadingSources(prev => new Set(prev).add(source.name));
    
    try {
      const response = await fetch('/api/sources/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: source.name,
          input: source.url,
          color: source.color
        })
      });

      if (!response.ok) {
        throw new Error('Failed to add source');
      }

      // 更新 localStorage
      const stored = localStorage.getItem('atomflow:source-layout:v1');
      const parsed = stored ? JSON.parse(stored) : { version: 2, entries: [] };
      
      // 处理新版本格式
      const entries = parsed.version ? parsed.entries : parsed;
      
      const newSource = {
        id: `source:${source.name}`,
        type: 'source',
        name: source.name,
        color: source.color,
        rssUrl: source.url
      };
      
      // 添加到所有合集的下方（末尾）
      entries.push(newSource);
      
      localStorage.setItem('atomflow:source-layout:v1', JSON.stringify({
        version: 2,
        entries: entries
      }));

      setAddedSources(prev => new Set(prev).add(source.name));
      await reloadArticles();
      showToast(`已添加 ${source.name}`);
      
      // 触发页面刷新以更新导航栏
      window.location.reload();
    } catch (error) {
      logger.error('Failed to add source', { error, source: source.name, input: source.url });
      showToast('添加失败，请稍后重试');
    } finally {
      setLoadingSources(prev => {
        const next = new Set(prev);
        next.delete(source.name);
        return next;
      });
    }
  };

  const handleAddCustomSource = async () => {
    const input = customInput.trim();
    const alias = customAlias.trim();
    
    if (!input) {
      showToast('请输入RSS链接或RSSHub路由');
      return;
    }
    
    const sourceName = alias || input;
    
    if (existingSources.has(sourceName)) {
      showToast('该信息源已存在');
      return;
    }
    
    setIsAddingCustom(true);
    
    try {
      const response = await fetch('/api/sources/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: sourceName,
          input: input,
          color: '#718096'
        })
      });

      if (!response.ok) {
        throw new Error('Failed to add source');
      }

      // 更新 localStorage
      const stored = localStorage.getItem('atomflow:source-layout:v1');
      const parsed = stored ? JSON.parse(stored) : { version: 2, entries: [] };
      const entries = parsed.version ? parsed.entries : parsed;
      
      const newSource = {
        id: `source:${sourceName}`,
        type: 'source',
        name: sourceName,
        color: '#718096',
        rssUrl: input
      };
      
      entries.push(newSource);
      
      localStorage.setItem('atomflow:source-layout:v1', JSON.stringify({
        version: 2,
        entries: entries
      }));

      setAddedSources(prev => new Set(prev).add(sourceName));
      await reloadArticles();
      showToast(`已添加 ${sourceName}`);
      setCustomInput('');
      setCustomAlias('');
      
      // 触发页面刷新以更新导航栏
      window.location.reload();
    } catch (error) {
      logger.error('Failed to add custom source', { error, source: sourceName, input });
      showToast('添加失败，请检查链接是否正确');
    } finally {
      setIsAddingCustom(false);
    }
  };

  const categories: Array<'全部' | '国内媒体' | '播客' | 'X' | 'YouTube' | '公众号' | '其他'> = ['全部', '国内媒体', '播客', 'X', 'YouTube', '公众号', '其他'];

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 w-full">
      <div className="mb-6">
        <h1 className="font-serif text-[18px] sm:text-[20px] font-bold text-text-main mb-2">发现订阅源</h1>
        <p className="text-[12px] sm:text-[13px] text-text3">精选优质信息源，一键添加到你的订阅列表</p>
      </div>

      {/* 自定义添加订阅源 */}
      <div className="mb-6 p-4 bg-surface rounded-xl border border-border">
        <h2 className="text-[14px] font-semibold text-text-main mb-3">添加订阅源</h2>
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isAddingCustom) {
                handleAddCustomSource();
              }
            }}
            placeholder="输入 RSS 链接或 RSSHub 路由（如：rsshub://sspai/index）"
            className="w-full px-3 py-2 rounded-lg border border-border bg-bg text-[13px] text-text-main outline-none focus:border-accent transition-colors"
          />
          <div className="flex gap-2">
            <input
              type="text"
              value={customAlias}
              onChange={(e) => setCustomAlias(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isAddingCustom) {
                  handleAddCustomSource();
                }
              }}
              placeholder="自定义名称（可选）"
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-bg text-[13px] text-text-main outline-none focus:border-accent transition-colors"
            />
            <button
              onClick={handleAddCustomSource}
              disabled={isAddingCustom || !customInput.trim()}
              className={cn(
                "px-4 py-2 rounded-lg text-[13px] font-medium transition-colors",
                isAddingCustom || !customInput.trim()
                  ? "bg-surface2 text-text3 cursor-not-allowed"
                  : "bg-accent text-white hover:bg-accent/90"
              )}
            >
              {isAddingCustom ? '添加中...' : '添加'}
            </button>
          </div>
        </div>
      </div>

      {/* 分类筛选 */}
      <div className="mb-6">
        <h2 className="text-[14px] font-semibold text-text-main mb-3">推荐订阅源</h2>
        <div className="flex gap-2 overflow-x-auto pb-2">
          {categories.map(category => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              className={cn(
                "px-4 py-1.5 rounded-full text-[13px] font-medium whitespace-nowrap transition-colors",
                selectedCategory === category
                  ? "bg-accent text-white"
                  : "bg-surface2 text-text2 hover:bg-surface hover:text-text-main"
              )}
            >
              {category}
            </button>
          ))}
        </div>
      </div>

      {/* 订阅源列表 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {filteredSources.map(source => {
          const isAdded = existingSources.has(source.name);
          const isLoading = loadingSources.has(source.name);

          return (
            <div
              key={source.name}
              className={cn(
                "p-4 bg-surface rounded-xl border transition-all",
                isAdded ? "border-accent2" : "border-border hover:border-accent hover:shadow-sm"
              )}
            >
              <div className="flex items-start gap-3">
                <div 
                  className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 overflow-hidden"
                  style={{ backgroundColor: `${source.color}20` }}
                >
                  {source.icon ? (
                    <img 
                      src={source.icon} 
                      alt={source.name}
                      className="w-8 h-8 object-contain"
                      onError={(e) => {
                        // 如果图标加载失败，显示默认emoji
                        e.currentTarget.style.display = 'none';
                        const parent = e.currentTarget.parentElement;
                        if (parent) {
                          parent.innerHTML = '📡';
                          parent.style.fontSize = '24px';
                        }
                      }}
                    />
                  ) : (
                    <span className="text-2xl">📡</span>
                  )}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="font-semibold text-[14px] text-text-main truncate">
                      {source.name}
                    </h3>
                    {source.categories.map(cat => (
                      <span key={cat} className="text-[11px] px-2 py-0.5 rounded bg-surface2 text-text3 shrink-0">
                        {cat}
                      </span>
                    ))}
                  </div>
                  <p className="text-[12px] text-text2 mb-3 line-clamp-2">
                    {source.description}
                  </p>
                  
                  {isAdded ? (
                    <button
                      disabled
                      className="w-full px-3 py-1.5 rounded-lg text-[12px] font-medium bg-accent2-light text-accent2 flex items-center justify-center gap-1 cursor-not-allowed opacity-70"
                    >
                      <Check size={14} />
                      已添加
                    </button>
                  ) : (
                    <button
                      onClick={() => handleAddSource(source)}
                      disabled={isLoading}
                      className={cn(
                        "w-full px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors flex items-center justify-center gap-1",
                        isLoading
                          ? "bg-accent text-white cursor-wait opacity-70"
                          : "bg-accent-light text-accent hover:bg-accent hover:text-white"
                      )}
                    >
                      <Plus size={14} />
                      {isLoading ? '添加中...' : '添加订阅'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {filteredSources.length === 0 && (
        <div className="text-center py-20">
          <div className="text-[48px] mb-4 opacity-20">📭</div>
          <p className="text-text3 text-[14px]">该分类暂无订阅源</p>
        </div>
      )}
    </div>
  );
};
