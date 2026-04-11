import express from "express";
import { createServer as createViteServer } from "vite";
import { MOCK_ARTICLES } from "./src/data/mock.js";
import { AtomCard, Article, User } from "./src/types.js";
import multer from "multer";
import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import session from "express-session";
import { Store } from "express-session";
import { Resend } from "resend";
import nodemailer from "nodemailer";

dotenv.config();

// Extend express-session types
declare module "express-session" {
  interface SessionData {
    userId?: number;
    email?: string;
  }
}

// --- Inline SQLite Session Store ---
class SqliteSessionStore extends Store {
  private db: Database.Database;
  constructor(db: Database.Database) {
    super();
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
    `);
    this.db.prepare('DELETE FROM sessions WHERE expired < datetime(?)').run(new Date().toISOString());
  }
  get(sid: string, callback: (err: any, session?: session.SessionData | null) => void) {
    try {
      const row = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > datetime(?)').get(sid, new Date().toISOString()) as any;
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (err) { callback(err); }
  }
  set(sid: string, sess: session.SessionData, callback?: (err?: any) => void) {
    try {
      const maxAge = sess.cookie?.maxAge || 86400000 * 7;
      const expired = new Date(Date.now() + maxAge).toISOString();
      this.db.prepare('REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, datetime(?))').run(sid, JSON.stringify(sess), expired);
      callback?.();
    } catch (err) { callback?.(err); }
  }
  destroy(sid: string, callback?: (err?: any) => void) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback?.();
    } catch (err) { callback?.(err); }
  }
}

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
    // RSSHub 镜像多，每个给 5s；直连源只有 1 个 URL，给 10s
    const perCandidateTimeout = expanded.length > 1 ? 5000 : 10000;
    for (const candidate of expanded) {
      try {
        const parsed = await withTimeout(parser.parseURL(candidate), perCandidateTimeout);
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
  '36氪': 5,
  'Lex Fridman': 4.8,
  'Y Combinator': 4.6,
  'Andrej Karpathy': 4.4,
  'GitHub Blog': 4.2,
  'Sam Altman': 4.0,
  '张小珺商业访谈录': 3.8,
  '数字生命卡兹克': 3.8,
  '新智元': 3.8,
  '人人都是产品经理': 2.5,
  '即刻话题': 1.5,
  '少数派': 1.2,
  '虎嗅': 0
};

const LOW_PRIORITY_SOURCES = new Set(['少数派', '即刻话题']);

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
  const combined = [...rest, ...remainingLow];
  
  // 增加随机性：一半文章按优先级排序，一半随机打乱
  const halfPoint = Math.floor(combined.length / 2);
  const prioritized = combined.slice(0, halfPoint);
  const randomized = combined.slice(halfPoint);
  
  // Fisher-Yates 洗牌算法
  for (let i = randomized.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [randomized[i], randomized[j]] = [randomized[j], randomized[i]];
  }
  
  return [...prioritized, ...randomized];
}

function extractFeedIcon(parsed: Parser.Output<any>): string | undefined {
  // 尝试从多个可能的字段提取图标
  const feed = parsed as any;
  
  // iTunes podcast image
  if (feed.itunes?.image) return feed.itunes.image;
  
  // Standard RSS image
  if (feed.image?.url) return feed.image.url;
  
  // Atom feed icon
  if (feed.icon) return feed.icon;
  
  // Feed logo
  if (feed.logo) return feed.logo;
  
  // 从link提取favicon
  if (feed.link) {
    try {
      const url = new URL(feed.link);
      return `${url.origin}/favicon.ico`;
    } catch {
      // ignore
    }
  }
  
  return undefined;
}

function normalizeFeedItems(items: Parser.Item[], source: string, defaultTopic: string, idOffset: number, feedIcon?: string) {
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
    
    // 提取音频信息（播客）
    const enclosure = item.enclosure;
    const audioUrl = enclosure?.url;
    const audioDuration = (item as any).itunes?.duration;
    
    return {
      id: Date.now() + idOffset + index,
      saved: false,
      source,
      sourceIcon: feedIcon,
      topic,
      time: timeStr,
      publishedAt,
      title: item.title || '无标题',
      excerpt,
      content: rawContent,
      url: item.link,
      audioUrl,
      audioDuration,
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
      parseWithRetry([
          'rsshub://sspai/index'
        ], 20000, 2),
      parseWithRetry([
          'https://www.woshipm.com/feed',
          'rsshub://woshipm/popular'
        ], 20000, 2),
      parseWithRetry([
          'rsshub://36kr/hot-list',
          'https://36kr.com/feed',
          'rsshub://36kr/news'
        ], 20000, 2),
      parseWithRetry([
          'https://www.huxiu.com/rss/0.xml',
          'rsshub://huxiu/article'
        ], 20000, 2),
      parseWithRetry([
          'https://wechat2rss.bestblogs.dev/feed/ff621c3e98d6ae6fceb3397e57441ffc6ea3c17f.xml'
        ], 20000, 2),
      parseWithRetry([
          'https://plink.anyfeeder.com/weixin/AI_era'
        ], 20000, 2),
      parseWithRetry([
          'rsshub://jike/topic/63579abb6724cc583b9bba9a'
        ], 20000, 2),
      parseWithRetry([
          'https://github.blog/feed/'
        ], 20000, 2),
      parseWithRetry([
          'rsshub://twitter/user/sama'
        ], 20000, 2),
      parseWithRetry([
          'https://feed.xyzfm.space/dk4yh3pkpjp3'
        ], 20000, 2),
      parseWithRetry([
          'rsshub://youtube/user/%40lexfridman',
          'https://www.youtube.com/feeds/videos.xml?channel_id=UCSHZKyawb77ixDdsGog4iWA'
        ], 20000, 2),
      parseWithRetry([
          'rsshub://youtube/user/%40ycombinator',
          'https://www.youtube.com/feeds/videos.xml?channel_id=UCcefcZRL2oaA_uBNeo5UOWg'
        ], 20000, 2),
      parseWithRetry([
          'rsshub://youtube/user/@AndrejKarpathy',
          'https://www.youtube.com/feeds/videos.xml?channel_id=UCYO_jab_esuFRV4b17AJtAw'
        ], 20000, 2)
    ]);
    const sspaiArticles = results[0].status === 'fulfilled'
      ? normalizeFeedItems(results[0].value.items, '少数派', '科技资讯', 0, extractFeedIcon(results[0].value))
      : [];
    const woshipmArticles = results[1].status === 'fulfilled'
      ? normalizeFeedItems(results[1].value.items, '人人都是产品经理', '产品运营', 1000, extractFeedIcon(results[1].value))
      : [];
    const krArticles = results[2].status === 'fulfilled'
      ? normalizeFeedItems(results[2].value.items, '36氪', '创投商业', 2000, extractFeedIcon(results[2].value))
      : [];
    const huxiuArticles = results[3].status === 'fulfilled'
      ? normalizeFeedItems(results[3].value.items, '虎嗅', '商业资讯', 3000, extractFeedIcon(results[3].value))
      : [];
    const zslrenArticles = results[4].status === 'fulfilled'
      ? normalizeFeedItems(results[4].value.items, '数字生命卡兹克', '公众号', 4000, extractFeedIcon(results[4].value))
      : [];
    const xzyArticles = results[5].status === 'fulfilled'
      ? normalizeFeedItems(results[5].value.items, '新智元', '公众号', 4500, extractFeedIcon(results[5].value))
      : [];
    const jikeArticles = results[6].status === 'fulfilled'
      ? normalizeFeedItems(results[6].value.items, '即刻话题', 'Jike', 6000, extractFeedIcon(results[6].value))
      : [];
    const githubArticles = results[7].status === 'fulfilled'
      ? normalizeFeedItems(results[7].value.items, 'GitHub Blog', 'Tech', 7000, extractFeedIcon(results[7].value))
      : [];
    const samaArticles = results[8].status === 'fulfilled'
      ? normalizeFeedItems(results[8].value.items, 'Sam Altman', 'Twitter', 8000, extractFeedIcon(results[8].value))
      : [];
    const xyzfmArticles = results[9].status === 'fulfilled'
      ? normalizeFeedItems(results[9].value.items, '张小珺商业访谈录', 'Podcast', 9000, extractFeedIcon(results[9].value))
      : [];
    const lexArticles = results[10].status === 'fulfilled'
      ? normalizeFeedItems(results[10].value.items, 'Lex Fridman', 'Podcast', 10000, extractFeedIcon(results[10].value))
      : [];
    const ycArticles = results[11].status === 'fulfilled'
      ? normalizeFeedItems(results[11].value.items, 'Y Combinator', 'YouTube', 11000, extractFeedIcon(results[11].value))
      : [];
    const karpathyArticles = results[12].status === 'fulfilled'
      ? normalizeFeedItems(results[12].value.items, 'Andrej Karpathy', 'YouTube', 12000, extractFeedIcon(results[12].value))
      : [];
    console.log('RSS counts:', {
      sspai: sspaiArticles.length,
      woshipm: woshipmArticles.length,
      kr36: krArticles.length,
      huxiu: huxiuArticles.length,
      zslren: zslrenArticles.length,
      xzy: xzyArticles.length,
      jike: jikeArticles.length,
      github: githubArticles.length,
      sama: samaArticles.length,
      xyzfm: xyzfmArticles.length,
      lex: lexArticles.length,
      yc: ycArticles.length,
      karpathy: karpathyArticles.length
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
    if (results[8].status === 'rejected') {
      console.error('Failed to fetch RSS from Sam Altman Twitter:', results[8].reason);
    }
    if (results[9].status === 'rejected') {
      console.error('Failed to fetch RSS from 张小珺商业访谈录:', results[9].reason);
    }
    if (results[10].status === 'rejected') {
      console.error('Failed to fetch RSS from Lex Fridman:', results[10].reason);
    }
    if (results[11].status === 'rejected') {
      console.error('Failed to fetch RSS from Y Combinator:', results[11].reason);
    }
    if (results[12].status === 'rejected') {
      console.error('Failed to fetch RSS from Andrej Karpathy:', results[12].reason);
    }
    const merged = [
      ...sspaiArticles,
      ...woshipmArticles,
      ...krArticles,
      ...huxiuArticles,
      ...zslrenArticles,
      ...xzyArticles,
      ...jikeArticles,
      ...githubArticles,
      ...samaArticles,
      ...xyzfmArticles,
      ...lexArticles,
      ...ycArticles,
      ...karpathyArticles
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

  // --- Database init ---
  const dbPath = path.join(process.cwd(), ".cache", "atomflow.db");
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vc_email ON verification_codes(email, used, expires_at);
  `);

  // Migrate: add profile columns to users table
  try { db.exec('ALTER TABLE users ADD COLUMN nickname TEXT'); } catch {}
  try { db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT'); } catch {}

  // Backfill: set default nickname for existing users who don't have one
  db.prepare("UPDATE users SET nickname = substr(email, 1, instr(email, '@') - 1) WHERE nickname IS NULL").run();
  // Create saved_cards table for per-user card persistence
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_cards (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      article_title TEXT NOT NULL DEFAULT '',
      article_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_cards_user ON saved_cards(user_id);
  `);

  const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

  // Gmail SMTP transporter (preferred over Resend for free usage)
  const smtpTransporter = process.env.SMTP_USER && process.env.SMTP_PASS
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      })
    : null;

  // Avatar upload setup
  const avatarsDir = path.join(process.cwd(), '.cache', 'avatars');
  await fs.mkdir(avatarsDir, { recursive: true });

  const avatarStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarsDir),
    filename: (req: any, _file, cb) => {
      const ext = path.extname(_file.originalname) || '.jpg';
      cb(null, `${req.session.userId}-${Date.now()}${ext}`);
    }
  });

  const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      cb(null, allowed.includes(file.mimetype));
    }
  });

  app.use(express.json());

  // --- Session middleware ---
  app.use(session({
    store: new SqliteSessionStore(db),
    secret: process.env.SESSION_SECRET || 'atomflow-dev-secret-change-in-prod',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  }));

  // In-memory database for prototype
  let articles: Article[] = [];
  const cachedArticles = await loadArticlesCache();
  if (cachedArticles.length > 0) {
    articles = cachedArticles;
  }

  // Load RSS feeds on startup
  console.log('Fetching RSS feeds...');
  const refreshFeeds = async () => {
    try {
      const fresh = await fetchRSSFeeds();
      console.log(`Fetched ${fresh.length} fresh articles`);

      // 只有当新数据不为空时才合并
      if (fresh.length > 0) {
        const withFallback = mergeWithSourceFallback(articles, fresh);
        articles = mergeArticles(articles, rankArticles(withFallback));
        await saveArticlesCache(articles);
        console.log(`Loaded ${articles.length} articles.`);
      } else {
        console.log('No fresh articles fetched, keeping existing data');
      }
    } catch (error) {
      console.error('Failed to refresh feeds, keeping existing data:', error);
    }
  };
  // 如果有缓存数据，不阻塞启动，后台异步刷新
  if (articles.length > 0) {
    console.log(`Using ${articles.length} cached articles, refreshing in background...`);
    refreshFeeds();
  } else {
    await refreshFeeds();
  }
  setInterval(() => {
    refreshFeeds().catch(error => console.error('Failed to refresh feeds:', error));
  }, 10 * 60 * 1000);

  // --- Auth Routes ---

  app.post("/api/auth/send-code", async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }
    if (!smtpTransporter && !resend) {
      return res.status(500).json({ error: '邮件服务未配置' });
    }

    const now = new Date().toISOString();
    const recent = db.prepare(
      "SELECT id FROM verification_codes WHERE email = ? AND created_at > datetime(?, '-60 seconds') AND used = 0"
    ).get(email, now) as any;
    if (recent) {
      return res.status(429).json({ error: '发送过于频繁，请 60 秒后再试' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO verification_codes (email, code, expires_at) VALUES (?, ?, ?)').run(email, code, expiresAt);

    console.log(`[AUTH] 验证码 → ${email}: ${code}`);

    const htmlContent = `
      <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1C1916;">AtomFlow 验证码</h2>
        <p style="color: #6B6560; font-size: 14px;">你的验证码是：</p>
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2B6CB0; padding: 16px 0;">${code}</div>
        <p style="color: #A09890; font-size: 12px;">验证码有效期 10 分钟，请尽快使用。</p>
      </div>
    `;

    try {
      if (resend) {
        await resend.emails.send({
          from: 'AtomFlow <noreply@atomflow.cloud>',
          to: email,
          subject: '你的 AtomFlow 登录验证码',
          html: htmlContent
        });
      } else if (smtpTransporter) {
        await smtpTransporter.sendMail({
          from: `AtomFlow <${process.env.SMTP_USER}>`,
          to: email,
          subject: '你的 AtomFlow 登录验证码',
          html: htmlContent
        });
      }
      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to send verification code:', error);
      return res.status(500).json({ error: '发送验证码失败，请稍后再试' });
    }
  });

  app.post("/api/auth/verify", (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const code = (req.body?.code || '').trim();
    if (!email || !code) {
      return res.status(400).json({ error: '请输入邮箱和验证码' });
    }

    const now = new Date().toISOString();
    const record = db.prepare(
      'SELECT id FROM verification_codes WHERE email = ? AND code = ? AND used = 0 AND expires_at > datetime(?)'
    ).get(email, code, now) as any;
    if (!record) {
      return res.status(400).json({ error: '验证码无效或已过期' });
    }

    db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(record.id);

    let user = db.prepare('SELECT id, email, nickname, avatar_url FROM users WHERE email = ?').get(email) as any;
    if (!user) {
      const nickname = email.split('@')[0];
      const result = db.prepare('INSERT INTO users (email, nickname) VALUES (?, ?)').run(email, nickname);
      user = { id: result.lastInsertRowid, email, nickname, avatar_url: null };
    }

    req.session.userId = user.id as number;
    req.session.email = user.email as string;
    return res.json({ success: true, user: { id: user.id, email: user.email, nickname: user.nickname, avatar_url: user.avatar_url } });
  });

  app.get("/api/auth/me", (req, res) => {
    if (!req.session.userId) {
      return res.json({ user: null });
    }
    const user = db.prepare('SELECT id, email, nickname, avatar_url FROM users WHERE id = ?').get(req.session.userId) as any;
    if (!user) {
      return res.json({ user: null });
    }
    return res.json({ user: { id: user.id, email: user.email, nickname: user.nickname, avatar_url: user.avatar_url } });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: '登出失败' });
      res.clearCookie('connect.sid');
      return res.json({ success: true });
    });
  });

  // --- Auth middleware ---
  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: '请先登录' });
    }
    next();
  };

  // --- Profile routes ---

  app.put("/api/auth/profile", requireAuth, (req, res) => {
    const nickname = (req.body?.nickname || '').trim();
    if (!nickname || nickname.length > 30) {
      return res.status(400).json({ error: '昵称不能为空且不超过30个字符' });
    }
    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, req.session.userId);
    const user = db.prepare('SELECT id, email, nickname, avatar_url FROM users WHERE id = ?').get(req.session.userId) as any;
    return res.json({ success: true, user: { id: user.id, email: user.email, nickname: user.nickname, avatar_url: user.avatar_url } });
  });

  app.post("/api/auth/avatar", requireAuth, avatarUpload.single('avatar'), async (req: any, res) => {
    if (!req.file) {
      return res.status(400).json({ error: '请上传有效的图片文件（JPG/PNG/GIF/WebP，最大2MB）' });
    }
    const avatarUrl = `/api/avatars/${req.file.filename}`;

    // Delete old avatar file
    const oldUser = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.session.userId) as any;
    if (oldUser?.avatar_url) {
      const oldFilename = oldUser.avatar_url.replace('/api/avatars/', '');
      const oldPath = path.join(avatarsDir, oldFilename);
      await fs.unlink(oldPath).catch(() => {});
    }

    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.session.userId);
    const user = db.prepare('SELECT id, email, nickname, avatar_url FROM users WHERE id = ?').get(req.session.userId) as any;
    return res.json({ success: true, user: { id: user.id, email: user.email, nickname: user.nickname, avatar_url: user.avatar_url } });
  });

  // Serve avatar files
  app.use('/api/avatars', express.static(avatarsDir, { maxAge: '7d' }));

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

  app.post("/api/sources/retry", async (req, res) => {
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
    if (!source || !input) {
      return res.status(400).json({ error: "source and input are required" });
    }
    try {
      // 使用60秒超时重试
      const parsed = await parseWithRetry([input], 60000, 1);
      const fetched = normalizeFeedItems(parsed.items || [], source, '自定义订阅', 900000, extractFeedIcon(parsed));
      const combined = [...fetched, ...articles];
      const dedup = new Map<string, Article>();
      for (const article of combined) {
        const key = article.url ? `url:${article.url}` : `st:${article.source}:${article.title}`;
        if (!dedup.has(key)) dedup.set(key, article);
      }
      articles = rankArticles(Array.from(dedup.values()));
      await saveArticlesCache(articles);
      return res.json({ success: true, added: fetched.length });
    } catch (error: any) {
      console.error(`Failed to retry source ${source}:`, error);
      return res.status(502).json({ 
        error: "获取失败", 
        details: error?.message || '未知错误'
      });
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
  app.post("/api/articles/:id/save", requireAuth, (req, res) => {
    const articleId = parseInt(req.params.id);
    const article = articles.find(a => a.id === articleId);

    if (!article) {
      return res.status(404).json({ error: "Article not found" });
    }

    // Check if this user already saved cards for this article
    const existingCard = db.prepare('SELECT id FROM saved_cards WHERE user_id = ? AND article_id = ?').get(req.session.userId, articleId) as any;
    if (!existingCard) {
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

      const insertStmt = db.prepare('INSERT INTO saved_cards (id, user_id, type, content, tags, article_title, article_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const insertMany = db.transaction((cards: AtomCard[]) => {
        for (const card of cards) {
          insertStmt.run(card.id, req.session.userId, card.type, card.content, JSON.stringify(card.tags), card.articleTitle, card.articleId || null);
        }
      });
      insertMany(newCards);
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
      // 所有源都直接使用RSS内容，不进行网页抓取
      if (article.source === '即刻话题') {
        article.markdownContent = formatJikeContent(article.content);
      } else {
        article.markdownContent = article.content || article.excerpt || '暂无内容';
      }
      
      article.readabilityUsed = false;
      article.fullFetched = true;
      
      return res.json({ success: true, article });
    } catch (error) {
      console.error('Failed to process article content:', error);
      article.markdownContent = article.content || article.excerpt || '暂无内容';
      article.readabilityUsed = false;
      article.fullFetched = true;
      return res.json({ success: true, article });
    }
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
  app.get("/api/cards", requireAuth, (req, res) => {
    const rows = db.prepare('SELECT id, type, content, tags, article_title AS articleTitle, article_id AS articleId FROM saved_cards WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId) as any[];
    const cards = rows.map((r: any) => ({ ...r, tags: JSON.parse(r.tags) }));
    res.json(cards);
  });

  // Add a new manual card
  app.post("/api/cards", requireAuth, (req, res) => {
    const newCard: AtomCard = {
      ...req.body,
      id: Math.random().toString(36).substr(2, 9),
      articleTitle: req.body.articleTitle || "手动录入"
    };
    db.prepare('INSERT INTO saved_cards (id, user_id, type, content, tags, article_title, article_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      newCard.id, req.session.userId, newCard.type, newCard.content,
      JSON.stringify(newCard.tags), newCard.articleTitle, newCard.articleId || null
    );
    res.json(newCard);
  });

  // Update a card
  app.put("/api/cards/:id", requireAuth, (req, res) => {
    const { id } = req.params;
    const existing = db.prepare('SELECT id FROM saved_cards WHERE id = ? AND user_id = ?').get(id, req.session.userId) as any;
    if (!existing) {
      return res.status(404).json({ error: "Card not found" });
    }

    const { type, content, tags } = req.body;
    if (type !== undefined) db.prepare('UPDATE saved_cards SET type = ? WHERE id = ? AND user_id = ?').run(type, id, req.session.userId);
    if (content !== undefined) db.prepare('UPDATE saved_cards SET content = ? WHERE id = ? AND user_id = ?').run(content, id, req.session.userId);
    if (tags !== undefined) db.prepare('UPDATE saved_cards SET tags = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(tags), id, req.session.userId);

    const row = db.prepare('SELECT id, type, content, tags, article_title AS articleTitle, article_id AS articleId FROM saved_cards WHERE id = ? AND user_id = ?').get(id, req.session.userId) as any;
    res.json({ ...row, tags: JSON.parse(row.tags) });
  });

  // Delete a card
  app.delete("/api/cards/:id", requireAuth, (req, res) => {
    const { id } = req.params;
    const result = db.prepare('DELETE FROM saved_cards WHERE id = ? AND user_id = ?').run(id, req.session.userId);
    if (result.changes === 0) {
      return res.status(404).json({ error: "Card not found" });
    }
    res.json({ success: true });
  });

  // Translate article content
  app.post("/api/translate", requireAuth, async (req, res) => {
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
