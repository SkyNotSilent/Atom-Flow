import React, { useState, useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { Check, Plus } from 'lucide-react';
import { cn } from '../components/Nav';

interface SourceRecommendation {
  name: string;
  description: string;
  categories: Array<'国内媒体' | '播客' | 'X' | 'YouTube' | '公众号'>;
  url: string;
  color: string;
  icon?: string;
}

const RECOMMENDED_SOURCES: SourceRecommendation[] = [
  // 国内媒体
  { name: '36氪', description: '创投商业资讯', categories: ['国内媒体'], url: 'rsshub://36kr/hot-list', color: '#E53E3E', icon: '📰' },
  { name: '虎嗅', description: '商业深度分析', categories: ['国内媒体'], url: 'https://www.huxiu.com/rss/0.xml', color: '#DD6B20', icon: '🐯' },
  { name: '少数派', description: '科技生活方式', categories: ['国内媒体'], url: 'rsshub://sspai/index', color: '#553C9A', icon: '⚡' },
  { name: '人人都是产品经理', description: '产品运营知识', categories: ['国内媒体'], url: 'https://www.woshipm.com/feed', color: '#2B6CB0', icon: '📱' },
  { name: '极客公园', description: '科技创新资讯', categories: ['国内媒体'], url: 'rsshub://geekpark/breakingnews', color: '#00B96B', icon: '🚀' },
  { name: 'GitHub Blog', description: '技术前沿动态', categories: ['国内媒体'], url: 'https://github.blog/feed/', color: '#24292F', icon: '💻' },
  
  // 播客
  { name: '张小珺商业访谈录', description: '深度商业访谈节目', categories: ['播客'], url: 'https://feed.xyzfm.space/dk4yh3pkpjp3', color: '#FF6B6B', icon: '🎙️' },
  { name: 'Lex Fridman', description: 'AI & 科技深度对话', categories: ['播客', 'YouTube'], url: 'https://api.xgo.ing/rss/user/adf65931519340f795e2336910b4cd15', color: '#000000', icon: '🎧' },
  
  // X (Twitter)
  { name: 'Sam Altman', description: 'OpenAI CEO 推特', categories: ['X'], url: 'rsshub://twitter/user/sama', color: '#1DA1F2', icon: '🐦' },
  
  // YouTube
  { name: 'Y Combinator', description: '创业孵化器官方频道', categories: ['YouTube'], url: 'rsshub://youtube/user/%40ycombinator', color: '#FF0000', icon: '▶️' },
  { name: 'Andrej Karpathy', description: 'AI 研究与教学', categories: ['YouTube'], url: 'rsshub://youtube/user/@AndrejKarpathy', color: '#FF0000', icon: '▶️' },
  
  // 公众号
  { name: '数字生命卡兹克', description: '科技人文思考', categories: ['公众号'], url: 'https://wechat2rss.bestblogs.dev/feed/ff621c3e98d6ae6fceb3397e57441ffc6ea3c17f.xml', color: '#6B46C1', icon: '📮' },
  { name: '新智元', description: 'AI 前沿资讯', categories: ['公众号'], url: 'https://plink.anyfeeder.com/weixin/AI_era', color: '#2F855A', icon: '🤖' },
];

export const DiscoverPage: React.FC = () => {
  const { showToast, reloadArticles } = useAppContext();
  const [selectedCategory, setSelectedCategory] = useState<'全部' | '国内媒体' | '播客' | 'X' | 'YouTube' | '公众号'>('全部');
  const [addedSources, setAddedSources] = useState<Set<string>>(new Set());
  const [loadingSources, setLoadingSources] = useState<Set<string>>(new Set());

  // 从 localStorage 获取已添加的源
  const existingSources = useMemo(() => {
    try {
      const stored = localStorage.getItem('atomflow:source-layout:v1');
      if (!stored) return new Set<string>();
      const parsed = JSON.parse(stored);
      const names = new Set<string>();
      if (Array.isArray(parsed)) {
        parsed.forEach((entry: any) => {
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
          input: source.url 
        })
      });

      if (!response.ok) {
        throw new Error('Failed to add source');
      }

      // 更新 localStorage
      const stored = localStorage.getItem('atomflow:source-layout:v1');
      const parsed = stored ? JSON.parse(stored) : [];
      const newSource = {
        id: `source:${source.name}`,
        type: 'source',
        name: source.name,
        color: source.color,
        rssUrl: source.url
      };
      parsed.unshift(newSource);
      localStorage.setItem('atomflow:source-layout:v1', JSON.stringify(parsed));

      setAddedSources(prev => new Set(prev).add(source.name));
      await reloadArticles();
      showToast(`已添加 ${source.name}`);
      
      // 触发页面刷新以更新导航栏
      window.location.reload();
    } catch (error) {
      console.error('Failed to add source:', error);
      showToast('添加失败，请稍后重试');
    } finally {
      setLoadingSources(prev => {
        const next = new Set(prev);
        next.delete(source.name);
        return next;
      });
    }
  };

  const categories: Array<'全部' | '国内媒体' | '播客' | 'X' | 'YouTube' | '公众号'> = ['全部', '国内媒体', '播客', 'X', 'YouTube', '公众号'];

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 w-full">
      <div className="mb-6">
        <h1 className="font-serif text-[18px] sm:text-[20px] font-bold text-text-main mb-2">发现订阅源</h1>
        <p className="text-[12px] sm:text-[13px] text-text3">精选优质信息源，一键添加到你的订阅列表</p>
      </div>

      {/* 分类筛选 */}
      <div className="mb-6">
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
                  className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shrink-0"
                  style={{ backgroundColor: `${source.color}20` }}
                >
                  {source.icon || '📡'}
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
