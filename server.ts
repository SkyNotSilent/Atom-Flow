import express from "express";
import { createServer as createViteServer } from "vite";
import { MOCK_ARTICLES } from "./src/data/mock.js";
import { AtomCard, Article } from "./src/types.js";
import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { promises as fs } from "fs";
import path from "path";

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
});

const RSSHUB_BASES = Array.from(new Set([
  process.env.RSSHUB_BASE,
  'https://rsshub.umzzz.com',
  'https://rsshub.rssforever.com',
  'https://hub.slarker.me',
  'https://rsshub.pseudoyu.com',
  'https://rsshub.ktachibana.party',
  'https://rsshub.isrss.com',
  'https://rss.shab.fun',
  'https://rsshub.app'
].filter(Boolean))) as string[];
const CACHE_FILE = path.join(process.cwd(), ".cache", "articles.json");

function expandFeedUrls(url: string) {
  if (url.startsWith('rsshub://')) {
    const path = url.replace('rsshub://', '');
    return RSSHUB_BASES.map(base => `${base}/${path}`);
  }
  return [url];
}

async function parseFirstAvailable(urls: string[]) {
  let lastError: unknown;
  for (const url of urls) {
    const expanded = expandFeedUrls(url);
    for (const candidate of expanded) {
      try {
        const parsed = await parser.parseURL(candidate);
        const itemCount = parsed.items?.length ?? 0;
        if (itemCount > 0) {
          return parsed;
        }
        lastError = new Error(`Feed has 0 items: ${candidate}`);
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError;
}

async function parseFreshestAvailable(urls: string[]) {
  let latest: { parsed: Parser.Output<any>, newestAt: number, itemCount: number } | null = null;
  let lastError: unknown;
  for (const url of urls) {
    const expanded = expandFeedUrls(url);
    for (const candidate of expanded) {
      try {
        const parsed = await withTimeout(parser.parseURL(candidate), 2500);
        const items = parsed.items || [];
        const itemCount = items.length;
        if (itemCount === 0) continue;
        const newestAt = items.reduce((max, item) => {
          const t = item.pubDate ? new Date(item.pubDate).getTime() : 0;
          return Number.isFinite(t) && t > max ? t : max;
        }, 0);
        if (!latest || newestAt > latest.newestAt || (newestAt === latest.newestAt && itemCount > latest.itemCount)) {
          latest = { parsed, newestAt, itemCount };
        }
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (latest) return latest.parsed;
  throw lastError || new Error('No feed available');
}

async function parseWithRetry(urls: string[], timeoutMs: number, retries: number) {
  let lastError: unknown;
  for (let i = 0; i < retries; i += 1) {
    try {
      return await withTimeout(parseFirstAvailable(urls), timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise
      .then(result => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

const ALLOWED_IMAGE_HOST_SUFFIXES = [
  "sspai.com",
  "woshipm.com",
  "36kr.com",
  "36krcdn.com",
  "huxiu.com",
  "huxiucdn.com",
  "geekpark.net",
  "geekpark.com",
  "zslren.com",
  "image-proxy.zslren.com",
  "jintiankansha.me",
  "img2.jintiankansha.me",
  "mmbiz.qpic.cn",
  "twimg.com",
  "twitter.com",
  "x.com"
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergeArticles(previous: Article[], next: Article[]): Article[] {
  const prevByUrl = new Map(previous.filter(a => a.url).map(a => [a.url as string, a]));
  return next.map(article => {
    const prev = article.url ? prevByUrl.get(article.url) : undefined;
    if (!prev) return article;
    return {
      ...article,
      saved: prev.saved,
      cards: prev.cards,
      fullFetched: prev.fullFetched,
      markdownContent: prev.markdownContent,
      readabilityUsed: prev.readabilityUsed
    };
  });
}

function mergeWithSourceFallback(previous: Article[], next: Article[]) {
  const sourceKey = (item: Article) => {
    if (item.url?.includes('36kr.com')) return '36氪';
    if (item.url?.includes('woshipm.com')) return '人人都是产品经理';
    if (item.url?.includes('sspai.com')) return '少数派';
    if (item.url?.includes('huxiu.com')) return '虎嗅';
    return item.source;
  };
  const nextSources = new Set(next.map(sourceKey));
  const fallback = previous.filter(item => !nextSources.has(sourceKey(item)));
  const combined = [...next, ...fallback];
  const unique = new Map<string, Article>();
  for (const article of combined) {
    const key = article.url ? `url:${article.url}` : `st:${article.source}:${article.title}`;
    if (!unique.has(key)) {
      unique.set(key, article);
    }
  }
  return Array.from(unique.values());
}

async function loadArticlesCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as Article[];
    }
    return [];
  } catch {
    return [];
  }
}

async function saveArticlesCache(articles: Article[]) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(articles), "utf-8");
}

const SOURCE_PRIORITY: Record<string, number> = {
  '虎嗅': 4,
  '即刻话题': 3.6,
  '数字生命卡兹克': 3.6,
  '新智元': 3.6,
  '36氪': 3.5,
  'GitHub Blog': 3.0,
  '少数派': 1.6,
  '人人都是产品经理': 1.5
};

const LOW_PRIORITY_SOURCES = new Set(['少数派', '人人都是产品经理']);

function getPriority(article: Article) {
  if (SOURCE_PRIORITY[article.source] !== undefined) return SOURCE_PRIORITY[article.source];
  if (article.topic === '公众号') return 3.4;
  return 2.5;
}

function rankArticles(articles: Article[]) {
  const sorted = [...articles].sort((a, b) => {
    const pa = getPriority(a);
    const pb = getPriority(b);
    if (pb !== pa) return pb - pa;
    return (b.publishedAt ?? 0) - (a.publishedAt ?? 0);
  });
  const low = sorted.filter(item => LOW_PRIORITY_SOURCES.has(item.source));
  const rest = sorted.filter(item => !LOW_PRIORITY_SOURCES.has(item.source));
  const promotedLow = low.slice(0, 2);
  const remainingLow = low.slice(2);
  const positions = [2, 7];
  const limit = Math.min(promotedLow.length, positions.length);
  for (let i = 0; i < limit; i += 1) {
    const pos = Math.min(positions[i], rest.length);
    rest.splice(pos, 0, promotedLow[i]);
  }
  return [...rest, ...remainingLow];
}

function normalizeFeedItems(items: Parser.Item[], source: string, defaultTopic: string, idOffset: number) {
  const maxItems = source === '36氪' || source === '虎嗅' ? 8 : 12;
  return items.slice(0, maxItems).map((item, index) => {
    const rawContent = item['content:encoded'] || item.content || item.contentSnippet || '';
    const formattedContent = source === '即刻话题' ? formatJikeContent(rawContent) : rawContent;
    const excerpt = formattedContent.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').substring(0, 120) + '...';
    const topic = (item.categories && item.categories.length > 0) ? item.categories[0] : defaultTopic;
    let timeStr = '刚刚';
    const date = item.pubDate ? new Date(item.pubDate) : null;
    if (date) {
      const now = new Date();
      if (date.toDateString() === now.toDateString()) {
        timeStr = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      } else {
        timeStr = `${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
      }
    }
    const publishedAt = date ? date.getTime() : Date.now() - index;
    return {
      id: Date.now() + idOffset + index,
      saved: false,
      source,
      topic,
      time: timeStr,
      publishedAt,
      title: item.title || '无标题',
      excerpt,
      content: rawContent,
      url: item.link,
      cards: []
    };
  });
}

const formatJikeContent = (rawContent: string) => {
  const text = rawContent
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text.includes('热门评论')) return rawContent;

  const parts = text.split('热门评论');
  const before = parts[0]?.trim();
  const after = parts.slice(1).join('热门评论').trim();

  let commentSection = after;
  let tail = '';
  const tailSplit = commentSection.split(/查看更多/);
  if (tailSplit.length > 1) {
    commentSection = tailSplit[0].trim();
    tail = `查看更多${tailSplit.slice(1).join('查看更多').trim()}`;
  }

  const normalized = commentSection
    .replace(/\s*(\d{2}:\d{2})\s+(\d+)\s+/g, ' $1 👍$2\n')
    .replace(/([^\n])([^\s]{1,16})\s(\d{2}:\d{2})\s👍(\d+)/g, '$1\n$2 $3 👍$4\n')
    .replace(/([^\n])([^\s]{1,16}):\s/g, '$1\n$2: ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
  const commentLines: string[] = [];
  let current = '';
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) commentLines.push(trimmed);
    current = '';
  };
  lines.forEach(line => {
    if (/^.{1,16}\s\d{2}:\d{2}\s👍\d+/.test(line) || /^.{1,16}:\s/.test(line)) {
      flush();
      current = line;
    } else {
      current = current ? `${current} ${line}` : line;
    }
  });
  flush();

  const blocks = commentLines.map(line => {
    const metaMatch = line.match(/^(.{1,16})\s(\d{2}:\d{2})\s👍(\d+)\s?(.*)$/);
    if (metaMatch) {
      const [, name, time, likes, rest] = metaMatch;
      const body = rest ? `\n> ${rest}` : '';
      return `- **${name}** · ${time} · 👍${likes}${body}`;
    }
    const nameMatch = line.match(/^(.{1,16}):\s?(.*)$/);
    if (nameMatch) {
      const [, name, rest] = nameMatch;
      const body = rest ? `\n> ${rest}` : '';
      return `- **${name}**${body}`;
    }
    return `- ${line}`;
  }).join('\n\n');
  const beforeBlock = before ? `${before}\n\n` : '';
  const tailBlock = tail ? `\n\n${tail}` : '';

  return `${beforeBlock}### 热门评论\n${blocks}${tailBlock}`.trim();
};

const clean36KrTail = (content: string) => {
  return (content || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/^Published Time:.*$/gm, '')
    .replace(/^\s*Image\s*\d+(?::.*)?\s*$/gm, '')
    .replace(/^\s*.+?-36氪\s*$/gm, '')
    .replace(/^\s*\[\s*$/gm, '')
    .replace(/\n(?:账号设置我的关注我的收藏申请的报道退出登录|企业号\s+企服点评.*|核心服务\s+城市之窗.*|创投发布\s+LP源计划.*|36氪Auto.*媒体品牌)\s*\n/g, '\n')
    .replace(/\n(?:登录|搜索)\s*\n/g, '\n')
    .replace(/阅读更多内容，狠戳这里[\s\S]*$/m, '')
    .replace(/下一篇[\s\S]*$/m, '')
    .replace(/关于36氪[\s\S]*$/m, '')
    .replace(/城市合作[\s\S]*$/m, '')
    .replace(/寻求报道[\s\S]*$/m, '')
    .replace(/我要入驻[\s\S]*$/m, '')
    .replace(/投资者关系[\s\S]*$/m, '')
    .replace(/商务合作[\s\S]*$/m, '')
    .replace(/热门推荐[\s\S]*$/m, '')
    .replace(/36氪APP下载[\s\S]*$/m, '')
    .replace(/网络谣言信息举报入口[\s\S]*$/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const format36KrContent = (rawContent: string) => clean36KrTail(rawContent);

const buildExcerptFromContent = (content: string, maxLength = 180) => {
  const plain = (content || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  if (plain.length <= maxLength) return plain;
  return `${plain.slice(0, maxLength)}...`;
};

const normalizePlainText = (content: string) => {
  return (content || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const buildCardsFromArticleContent = (article: Article): Omit<AtomCard, "id" | "articleTitle" | "articleId">[] => {
  const contentPool = article.markdownContent || article.content || article.excerpt;
  const plain = normalizePlainText(contentPool);
  const normalizedExcerpt = normalizePlainText(article.excerpt);
  const sentences = plain
    .split(/[。！？；.!?;\n]/)
    .map(item => item.trim())
    .filter(item => item.length >= 14);
  const cards: Omit<AtomCard, "id" | "articleTitle" | "articleId">[] = [];
  const pushCard = (type: "观点" | "数据" | "金句" | "故事", content: string, tags: string[]) => {
    const safe = content.trim();
    if (!safe) return;
    if (cards.some(card => card.content === safe)) return;
    cards.push({ type, content: safe, tags });
  };
  const coreView = sentences[0] || normalizedExcerpt || plain.slice(0, 120);
  pushCard("观点", `核心观点：${coreView.slice(0, 120)}`, [article.topic, article.source]);
  const quoteSource = sentences.find(item => item.length >= 24) || normalizedExcerpt || plain;
  pushCard("金句", quoteSource.slice(0, 88), ["摘录", article.source]);
  const evidence = sentences.find(item => /(\d+%|\d+亿|\d+万|同比|环比|增长|下降|数据|报告)/.test(item))
    || sentences[1]
    || normalizedExcerpt;
  pushCard("数据", evidence.slice(0, 110), [article.topic, "支撑"]);
  const story = sentences.find(item => /(例如|比如|曾经|一次|后来|当时|这个团队|这个作者|这个品牌)/.test(item))
    || sentences[2];
  if (story) {
    pushCard("故事", story.slice(0, 110), [article.topic, "叙事"]);
  }
  return cards.length > 0
    ? cards.slice(0, 3)
    : [
        { type: "观点", content: `关于「${article.title}」的核心观点：${normalizedExcerpt.slice(0, 40)}...`, tags: [article.topic, "自动提取"] },
        { type: "故事", content: `${normalizedExcerpt.slice(0, 50)}...`, tags: ["叙事"] }
      ];
};

const isBlockedPageContent = (content: string) => {
  const plain = (content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return /requiring captcha|weixin official accounts platform|当前环境异常|环境异常|去验证|轻点两下取消赞|轻点两下取消在看|video mini program like/i.test(plain);
};

const cleanBlockedNoiseLines = (content: string) => {
  return (content || '')
    .replace(/^Warning: This page maybe requiring CAPTCHA.*$/gim, '')
    .replace(/^Weixin Official Accounts Platform.*$/gim, '')
    .replace(/^当前环境异常.*$/gim, '')
    .replace(/^环境异常.*$/gim, '')
    .replace(/^去验证.*$/gim, '')
    .replace(/^.*Video Mini Program Like.*$/gim, '')
    .replace(/^.*轻点两下取消赞.*$/gim, '')
    .replace(/^.*轻点两下取消在看.*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const cleanWoshipmContent = (markdown: string, title: string) => {
  let cleaned = (markdown || '');
  cleaned = cleaned.replace(/^Published Time:.*$/gm, '');
  cleaned = cleaned.replace(/^\s*Image\s*\d+(?::.*)?\s*$/gm, '');
  cleaned = cleaned.replace(/搜索起点课堂会员权益[\s\S]*?点我注册/g, '');
  cleaned = cleaned.replace(/\n(?:开通会员|注册\s*\|\s*登录)\s*\n/g, '\n');
  cleaned = cleaned.replace(/^\s*[^|\n]+\|\s*人人都是产品经理\s*$/gm, '');
  cleaned = cleaned.replace(/\n(?:搜索|APP|发布|注册\s*\|\s*登录|登录人人都是产品经理即可获得以下权益|关注优质作者|收藏优质内容|查阅浏览足迹|免费发布作品|参与提问答疑|交流互动学习|立即登录|首次使用？|点我注册)\s*\n/g, '\n');
  cleaned = cleaned.replace(/^\s*\[[^\]]*\]\s*(?:!\[[^\]]*\]\([^)]+\)\s*){1,6}\s*$/gm, '');
  cleaned = cleaned.replace(/(\[[^\]]+\]\([^)]+\))\s*(?:!\[[^\]]*\]\([^)]+\)\s*)+/g, '$1');
  cleaned = cleaned.replace(/^\s*\d+\s*评论\s*\d+\s*浏览\s*\d+\s*收藏.*$/gm, '');
  cleaned = cleaned.replace(/<div class="js-star[^>]*><\/div>/g, '');
  const escapedTitle = escapeRegExp(title);
  const duplicateTitleRegex = new RegExp(`(${escapedTitle}\\s*\\n)${escapedTitle}(\\s*\\n)`, 'g');
  cleaned = cleaned.replace(duplicateTitleRegex, '$1');
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

const score36KrCandidate = (content: string) => {
  const plain = (content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  let penalty = 0;
  if (plain.includes('关于36氪')) penalty += 3000;
  if (plain.includes('热门推荐')) penalty += 3000;
  if (plain.includes('36氪APP下载')) penalty += 3000;
  if (plain.includes('网络谣言信息举报入口')) penalty += 3000;
  if (plain.includes('账号设置我的关注我的收藏申请的报道退出登录')) penalty += 15000;
  if (plain.includes('核心服务 城市之窗 政府服务')) penalty += 15000;
  if (plain.includes('创投发布 LP源计划')) penalty += 15000;
  if (plain.includes('36氪Auto 数字时氪 未来消费')) penalty += 15000;
  return plain.length - penalty;
};

const is36KrArticle = (article: Article) => {
  return article.source.includes('36') || Boolean(article.url && article.url.includes('36kr.com'));
};

const get36KrArticleId = (url?: string) => {
  if (!url) return null;
  const match = url.match(/\/p\/(\d+)/);
  return match?.[1] || null;
};

async function fetchRSSFeeds(): Promise<Article[]> {
  try {
    const results = await Promise.allSettled([
      withTimeout(
        parseFirstAvailable([
          'rsshub://sspai/index'
        ]),
        8000
      ),
      parser.parseURL('https://www.woshipm.com/feed'),
      parseWithRetry([
          'rsshub://36kr/hot-list',
          'https://36kr.com/feed',
          'rsshub://36kr/news'
        ], 15000, 2),
      parser.parseURL('https://www.huxiu.com/rss/0.xml'),
      parser.parseURL('https://wechat2rss.bestblogs.dev/feed/ff621c3e98d6ae6fceb3397e57441ffc6ea3c17f.xml'),
      withTimeout(
        parseFirstAvailable([
          'https://plink.anyfeeder.com/weixin/AI_era'
        ]),
        8000
      ),
      withTimeout(
        parseFirstAvailable([
          'rsshub://jike/topic/63579abb6724cc583b9bba9a'
        ]),
        8000
      ),
      parser.parseURL('https://github.blog/feed/')
    ]);
    const sspaiArticles = results[0].status === 'fulfilled'
      ? normalizeFeedItems(results[0].value.items, '少数派', '科技资讯', 0)
      : [];
    const woshipmArticles = results[1].status === 'fulfilled'
      ? normalizeFeedItems(results[1].value.items, '人人都是产品经理', '产品运营', 1000)
      : [];
    const krArticles = results[2].status === 'fulfilled'
      ? normalizeFeedItems(results[2].value.items, '36氪', '创投商业', 2000)
      : [];
    const huxiuArticles = results[3].status === 'fulfilled'
      ? normalizeFeedItems(results[3].value.items, '虎嗅', '商业资讯', 3000)
      : [];
    const zslrenArticles = results[4].status === 'fulfilled'
      ? normalizeFeedItems(results[4].value.items, '数字生命卡兹克', '公众号', 4000)
      : [];
    const xzyArticles = results[5].status === 'fulfilled'
      ? normalizeFeedItems(results[5].value.items, '新智元', '公众号', 4500)
      : [];
    const jikeArticles = results[6].status === 'fulfilled'
      ? normalizeFeedItems(results[6].value.items, '即刻话题', 'Jike', 6000)
      : [];
    const githubArticles = results[7].status === 'fulfilled'
      ? normalizeFeedItems(results[7].value.items, 'GitHub Blog', 'Tech', 7000)
      : [];
    console.log('RSS counts:', {
      sspai: sspaiArticles.length,
      woshipm: woshipmArticles.length,
      kr36: krArticles.length,
      huxiu: huxiuArticles.length,
      zslren: zslrenArticles.length,
      xzy: xzyArticles.length,
      jike: jikeArticles.length,
      github: githubArticles.length
    });
    if (results[0].status === 'rejected') {
      console.error('Failed to fetch RSS from sspai:', results[0].reason);
    }
    if (results[1].status === 'rejected') {
      console.error('Failed to fetch RSS from woshipm:', results[1].reason);
    }
    if (results[2].status === 'rejected') {
      console.error('Failed to fetch RSS from 36kr:', results[2].reason);
    }
    if (results[3].status === 'rejected') {
      console.error('Failed to fetch RSS from huxiu:', results[3].reason);
    }
    if (results[4].status === 'rejected') {
      console.error('Failed to fetch RSS from zslren:', results[4].reason);
    }
    if (results[5].status === 'rejected') {
      console.error('Failed to fetch RSS from xzy:', results[5].reason);
    }
    if (results[6].status === 'rejected') {
      console.error('Failed to fetch RSS from jike topic:', results[6].reason);
    }
    if (results[7].status === 'rejected') {
      console.error('Failed to fetch RSS from GitHub Blog:', results[7].reason);
    }
    const merged = [
      ...sspaiArticles,
      ...woshipmArticles,
      ...krArticles,
      ...huxiuArticles,
      ...zslrenArticles,
      ...xzyArticles,
      ...jikeArticles,
      ...githubArticles
    ];
    const ordered = rankArticles(merged);
    return ordered.length > 0 ? ordered : [...MOCK_ARTICLES];
  } catch (error) {
    console.error('Failed to fetch RSS, falling back to mock data:', error);
    return [...MOCK_ARTICLES];
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3001);

  app.use(express.json());

  // In-memory database for prototype
  let articles: Article[] = [];
  let savedCards: AtomCard[] = [];
  const cachedArticles = await loadArticlesCache();
  if (cachedArticles.length > 0) {
    articles = cachedArticles;
  }

  // Load RSS feeds on startup
  console.log('Fetching RSS feeds...');
  const refreshFeeds = async () => {
    const fresh = await fetchRSSFeeds();
    const withFallback = mergeWithSourceFallback(articles, fresh);
    articles = mergeArticles(articles, rankArticles(withFallback));
    await saveArticlesCache(articles);
    console.log(`Loaded ${articles.length} articles.`);
  };
  await refreshFeeds();
  setInterval(() => {
    refreshFeeds().catch(error => console.error('Failed to refresh feeds:', error));
  }, 10 * 60 * 1000);

  // API Routes
  
  // Get all articles
  app.get("/api/articles", async (req, res) => {
    // Optional: Refresh feeds periodically or on request
    // if (articles.length === 0) articles = await fetchRSSFeeds();
    res.json(articles);
  });

  app.post("/api/sources/fetch", async (req, res) => {
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
    if (!source || !input) {
      return res.status(400).json({ error: "source and input are required" });
    }
    try {
      const parsed = await parseWithRetry([input], 15000, 2);
      const fetched = normalizeFeedItems(parsed.items || [], source, '自定义订阅', 900000);
      const combined = [...fetched, ...articles];
      const dedup = new Map<string, Article>();
      for (const article of combined) {
        const key = article.url ? `url:${article.url}` : `st:${article.source}:${article.title}`;
        if (!dedup.has(key)) dedup.set(key, article);
      }
      articles = rankArticles(Array.from(dedup.values()));
      await saveArticlesCache(articles);
      return res.json({ success: true, added: fetched.length });
    } catch (error) {
      return res.status(502).json({ error: "failed to fetch source" });
    }
  });

  app.delete("/api/sources/:source", async (req, res) => {
    const source = decodeURIComponent(req.params.source || '').trim();
    if (!source) return res.status(400).json({ error: "source is required" });
    const before = articles.length;
    articles = articles.filter(article => article.source !== source);
    await saveArticlesCache(articles);
    return res.json({ success: true, removed: before - articles.length });
  });

  app.patch("/api/sources/rename", async (req, res) => {
    const from = typeof req.body?.from === 'string' ? req.body.from.trim() : '';
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (!from || !to) return res.status(400).json({ error: "from and to are required" });
    if (from === to) return res.json({ success: true, renamed: 0 });
    let renamed = 0;
    articles = articles.map(article => {
      if (article.source !== from) return article;
      renamed += 1;
      return { ...article, source: to };
    });
    await saveArticlesCache(articles);
    return res.json({ success: true, renamed });
  });

  app.post("/api/articles/refresh-cache", (req, res) => {
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const titleIncludes = typeof req.body?.titleIncludes === 'string' ? req.body.titleIncludes.trim() : '';
    const urlIncludes = typeof req.body?.urlIncludes === 'string' ? req.body.urlIncludes.trim() : '';
    let refreshed = 0;
    articles = articles.map(article => {
      const bySource = source ? article.source === source : true;
      const byTitle = titleIncludes ? article.title.includes(titleIncludes) : true;
      const byUrl = urlIncludes ? Boolean(article.url && article.url.includes(urlIncludes)) : true;
      if (!(bySource && byTitle && byUrl)) {
        return article;
      }
      refreshed += 1;
      return {
        ...article,
        fullFetched: false,
        markdownContent: undefined,
        readabilityUsed: undefined
      };
    });
    res.json({ success: true, refreshed, total: articles.length });
  });

  // Save an article (mark as saved and extract cards)
  app.post("/api/articles/:id/save", (req, res) => {
    const articleId = parseInt(req.params.id);
    const article = articles.find(a => a.id === articleId);
    
    if (!article) {
      return res.status(404).json({ error: "Article not found" });
    }

    if (!article.saved) {
      article.saved = true;
      
      let cardsToSave = article.cards;
      if (!cardsToSave || cardsToSave.length === 0) {
        cardsToSave = buildCardsFromArticleContent(article);
        article.cards = cardsToSave;
      }

      const newCards: AtomCard[] = cardsToSave.map(c => ({
        ...c,
        id: Math.random().toString(36).substr(2, 9),
        articleTitle: article.title,
        articleId: article.id
      }));
      
      savedCards = [...newCards, ...savedCards];
    }

    res.json({ success: true, article });
  });

  // Fetch full content for an article
  app.get("/api/articles/:id/full", async (req, res) => {
    const articleId = parseInt(req.params.id);
    const article = articles.find(a => a.id === articleId);
    
    if (!article) {
      return res.status(404).json({ error: "Article not found" });
    }

    try {
      if (article.source === '即刻话题') {
        article.markdownContent = formatJikeContent(article.content);
        article.readabilityUsed = false;
        article.fullFetched = true;
        return res.json({ success: true, article });
      }
      if (article.url) {
        const preferJina = article.source === '数字生命卡兹克' || article.source === '新智元';
        if (preferJina) {
          const rssSnapshot = cleanBlockedNoiseLines(article.content || '');
          if (!isBlockedPageContent(rssSnapshot) && rssSnapshot.replace(/\s+/g, '').length > 120) {
            article.markdownContent = rssSnapshot;
            article.readabilityUsed = false;
            article.fullFetched = true;
            return res.json({ success: true, article });
          }
          const jinaResponse = await fetch(`https://r.jina.ai/${article.url}`, {
            headers: {
              'X-Remove-Selector': '.comment-list, .comments, footer, nav, .related-posts, .article-related, .user-card, .author-info, .footnotes, #footnotes, .article-footnotes, .reference',
              'X-Return-Format': 'markdown',
            }
          });
          if (jinaResponse.ok) {
            let markdown = await jinaResponse.text();
            markdown = markdown.replace(/!\[.*?\]\([^)]*\/community\/[^)]*\)/gi, '');
            markdown = markdown.replace(/\n发表首评\n/g, '\n');
            markdown = markdown.replace(/\n发表评论\n/g, '\n');
            markdown = markdown.replace(/\n全部讨论[\s\S]*?(?=\n\* \* \*|\n*$)/g, '');
            markdown = markdown.replace(/\n{3,}/g, '\n\n');
            markdown = cleanBlockedNoiseLines(markdown);
            if (!isBlockedPageContent(markdown) && markdown.trim()) {
              article.markdownContent = markdown.trim();
              article.readabilityUsed = false;
              article.fullFetched = true;
              return res.json({ success: true, article });
            }
          }
        }
        const response = await fetch(article.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        if (response.ok) {
          const html = await response.text();
          const dom = new JSDOM(html, { url: article.url });
          const reader = new Readability(dom.window.document);
          const parsed = reader.parse();
          let markdown = parsed?.content || article.content;
          markdown = cleanBlockedNoiseLines(markdown);
          const blockedByCaptcha = isBlockedPageContent(markdown);
          const isWoshipm = article.url.includes('woshipm.com');
          if (isWoshipm) {
            markdown = cleanWoshipmContent(markdown, article.title);
          }
          if (is36KrArticle(article)) {
            markdown = clean36KrTail(markdown);
          }
          article.markdownContent = markdown.trim();
          if (isWoshipm) {
            const updatedExcerpt = buildExcerptFromContent(article.markdownContent, 200);
            if (updatedExcerpt) {
              article.excerpt = updatedExcerpt;
            }
          }
          article.readabilityUsed = !blockedByCaptcha;
          if (blockedByCaptcha) {
            article.markdownContent = article.content;
          }
        } else {
          article.markdownContent = article.content;
          article.readabilityUsed = false;
        }
      } else {
        await new Promise(resolve => setTimeout(resolve, 1500));
        article.markdownContent = `## 时代变化太快...\n\n(此为无链接文章的模拟内容)`;
        article.readabilityUsed = false;
      }
    } catch (error) {
      console.error('Failed to fetch full content:', error);
      article.markdownContent = article.content;
      article.readabilityUsed = false;
    }

    article.fullFetched = true;
    res.json({ success: true, article });
  });

  // Image proxy to bypass CSP and hotlink protection
  app.get("/api/image-proxy", async (req, res) => {
    const imageUrl = req.query.url as string;
    const referer = (req.query.referer as string) || '';
    if (!imageUrl) {
      return res.status(400).send("Missing url parameter");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      return res.status(400).send("Invalid url parameter");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).send("Invalid url protocol");
    }
    const hostname = parsedUrl.hostname.toLowerCase();
    const isAllowedHost = ALLOWED_IMAGE_HOST_SUFFIXES.some(
      suffix => hostname === suffix || hostname.endsWith(`.${suffix}`)
    );
    if (!isAllowedHost) {
      return res.status(403).send("Host not allowed");
    }
    try {
      let refererHeader = parsedUrl.origin;
      if (referer) {
        try {
          const parsedReferer = new URL(referer);
          if (["http:", "https:"].includes(parsedReferer.protocol)) {
            refererHeader = parsedReferer.origin;
          }
        } catch {
          refererHeader = parsedUrl.origin;
        }
      }
      const response = await fetch(parsedUrl.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': refererHeader
        }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }
      
      const contentType = response.headers.get('content-type');
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }
      
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      
      const arrayBuffer = await response.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
    } catch (error) {
      console.error('Image proxy error:', error);
      res.status(500).send("Failed to load image");
    }
  });

  // Get all saved cards
  app.get("/api/cards", (req, res) => {
    res.json(savedCards);
  });

  // Add a new manual card
  app.post("/api/cards", (req, res) => {
    const newCard: AtomCard = {
      ...req.body,
      id: Math.random().toString(36).substr(2, 9),
      articleTitle: req.body.articleTitle || "手动录入"
    };
    savedCards = [newCard, ...savedCards];
    res.json(newCard);
  });

  // Update a card
  app.put("/api/cards/:id", (req, res) => {
    const { id } = req.params;
    const index = savedCards.findIndex(c => c.id === id);
    
    if (index === -1) {
      return res.status(404).json({ error: "Card not found" });
    }

    savedCards[index] = { ...savedCards[index], ...req.body };
    res.json(savedCards[index]);
  });

  // Delete a card
  app.delete("/api/cards/:id", (req, res) => {
    const { id } = req.params;
    savedCards = savedCards.filter(c => c.id !== id);
    res.json({ success: true });
  });

  // Translate article content
  app.post("/api/translate", async (req, res) => {
    const { content, targetLang = 'zh-CN' } = req.body;
    
    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }

    try {
      const { GoogleGenerativeAI } = await import('@google/genai');
      const apiKey = process.env.GEMINI_API_KEY;
      
      if (!apiKey) {
        console.error('Translation failed: GEMINI_API_KEY not configured');
        return res.status(500).json({ 
          error: "Translation service not configured",
          details: "GEMINI_API_KEY environment variable is missing"
        });
      }

      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

      const prompt = `请将以下内容翻译成${targetLang === 'zh-CN' ? '简体中文' : targetLang}。保持原文的格式和结构，只翻译文字内容。如果是Markdown格式，保留所有Markdown标记。

内容：
${content}`;

      const result = await model.generateContent(prompt);
      const translatedText = result.response.text();

      res.json({ 
        success: true, 
        translatedContent: translatedText,
        originalLength: content.length,
        translatedLength: translatedText.length
      });
    } catch (error: any) {
      console.error('Translation error:', error);
      const errorMessage = error?.message || 'Unknown error';
      const errorDetails = error?.response?.data || error?.toString() || '';
      
      res.status(500).json({ 
        error: "Translation failed",
        details: errorMessage,
        debug: errorDetails
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
