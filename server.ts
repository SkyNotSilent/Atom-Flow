import express, { Request, Response } from "express";
import { createServer as createViteServer } from "vite";
import { MOCK_ARTICLES } from "./src/data/mock.js";
import { AtomCard, Article } from "./src/types.js";
import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";
import crypto from "crypto";
import Database from "better-sqlite3";

dotenv.config();

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
const DB_FILE = path.join(process.cwd(), ".cache", "atomflow.db");
const SESSION_COOKIE_NAME = "atomflow_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

interface AuthUser {
  id: string;
  email: string;
}

interface CardRow {
  id: string;
  type: "观点" | "数据" | "金句" | "故事";
  content: string;
  tags_json: string;
  article_title: string;
  article_id: number | null;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const parseCookies = (cookieHeader?: string) => {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
};

const hashPassword = (password: string) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
};

const verifyPassword = (password: string, storedHash: string) => {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  const hashBuf = Buffer.from(hash, "hex");
  const candidateBuf = Buffer.from(candidate, "hex");
  if (hashBuf.length !== candidateBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, candidateBuf);
};

const toCard = (row: CardRow): AtomCard => ({
  id: row.id,
  type: row.type,
  content: row.content,
  tags: (() => {
    try {
      const parsed = JSON.parse(row.tags_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })(),
  articleTitle: row.article_title,
  articleId: row.article_id ?? undefined
});

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
      parser.parseURL('https://www.woshipm.com/feed'),
      parseWithRetry([
          'rsshub://36kr/hot-list',
          'https://36kr.com/feed',
          'rsshub://36kr/news'
        ], 20000, 2),
      parser.parseURL('https://www.huxiu.com/rss/0.xml'),
      parser.parseURL('https://wechat2rss.bestblogs.dev/feed/ff621c3e98d6ae6fceb3397e57441ffc6ea3c17f.xml'),
      parseWithRetry([
          'https://plink.anyfeeder.com/weixin/AI_era'
        ], 20000, 2),
      parseWithRetry([
          'rsshub://jike/topic/63579abb6724cc583b9bba9a'
        ], 20000, 2),
      parser.parseURL('https://github.blog/feed/'),
      parseWithRetry([
          'rsshub://twitter/user/sama'
        ], 20000, 2),
      parser.parseURL('https://feed.xyzfm.space/dk4yh3pkpjp3'),
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

  app.use(express.json());

  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  const db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      article_title TEXT NOT NULL,
      article_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS article_saves (
      user_id TEXT NOT NULL,
      article_id INTEGER NOT NULL,
      saved_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, article_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  const setSessionCookie = (res: Response, token: string) => {
    const secure = process.env.NODE_ENV === "production";
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`
    );
  };

  const clearSessionCookie = (res: Response) => {
    const secure = process.env.NODE_ENV === "production";
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`
    );
  };

  const getAuthUser = (req: Request): AuthUser | null => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (!token) return null;
    const now = Date.now();
    const row = db.prepare(`
      SELECT users.id as id, users.email as email
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token = ? AND sessions.expires_at > ?
      LIMIT 1
    `).get(token, now) as AuthUser | undefined;
    if (!row) {
      db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
      return null;
    }
    return row;
  };

  const requireAuthUser = (req: Request, res: Response) => {
    const user = getAuthUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    return user;
  };

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
  await refreshFeeds();
  setInterval(() => {
    refreshFeeds().catch(error => console.error('Failed to refresh feeds:', error));
  }, 10 * 60 * 1000);

  // API Routes
  app.get("/api/auth/me", (req, res) => {
    const user = getAuthUser(req);
    if (!user) return res.json({ user: null });
    return res.json({ user });
  });

  app.post("/api/auth/register", (req, res) => {
    const emailRaw = typeof req.body?.email === "string" ? req.body.email : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const email = normalizeEmail(emailRaw);
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "邮箱格式不正确" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "密码至少 8 位" });
    }
    const existed = db.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").get(email) as { id: string } | undefined;
    if (existed) {
      return res.status(409).json({ error: "邮箱已注册" });
    }
    const now = Date.now();
    const userId = crypto.randomUUID();
    const passwordHash = hashPassword(password);
    db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)").run(userId, email, passwordHash, now);
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
      token,
      userId,
      now + SESSION_TTL_MS,
      now
    );
    setSessionCookie(res, token);
    return res.json({ user: { id: userId, email } });
  });

  app.post("/api/auth/login", (req, res) => {
    const emailRaw = typeof req.body?.email === "string" ? req.body.email : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const email = normalizeEmail(emailRaw);
    if (!email || !password) {
      return res.status(400).json({ error: "请输入邮箱和密码" });
    }
    const user = db.prepare("SELECT id, email, password_hash FROM users WHERE email = ? LIMIT 1").get(email) as {
      id: string;
      email: string;
      password_hash: string;
    } | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "邮箱或密码错误" });
    }
    const now = Date.now();
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
      token,
      user.id,
      now + SESSION_TTL_MS,
      now
    );
    setSessionCookie(res, token);
    return res.json({ user: { id: user.id, email: user.email } });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (token) {
      db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    }
    clearSessionCookie(res);
    return res.json({ success: true });
  });

  // Get all articles
  app.get("/api/articles", async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      const anonymous = articles.map(article => ({ ...article, saved: false }));
      return res.json(anonymous);
    }
    const rows = db.prepare("SELECT article_id FROM article_saves WHERE user_id = ?").all(user.id) as Array<{ article_id: number }>;
    const savedIds = new Set(rows.map(item => item.article_id));
    const mapped = articles.map(article => ({ ...article, saved: savedIds.has(article.id) }));
    return res.json(mapped);
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
  app.post("/api/articles/:id/save", (req, res) => {
    const user = requireAuthUser(req, res);
    if (!user) return;
    const articleId = parseInt(req.params.id);
    const article = articles.find(a => a.id === articleId);
    
    if (!article) {
      return res.status(404).json({ error: "Article not found" });
    }

    const existed = db.prepare("SELECT 1 FROM article_saves WHERE user_id = ? AND article_id = ? LIMIT 1").get(user.id, articleId);
    if (!existed) {
      let cardsToSave = article.cards;
      if (!cardsToSave || cardsToSave.length === 0) {
        cardsToSave = buildCardsFromArticleContent(article);
        article.cards = cardsToSave;
      }

      const now = Date.now();
      db.prepare("INSERT INTO article_saves (user_id, article_id, saved_at) VALUES (?, ?, ?)").run(user.id, articleId, now);
      const insertCardStmt = db.prepare(`
        INSERT INTO cards (id, user_id, type, content, tags_json, article_title, article_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const card of cardsToSave) {
        insertCardStmt.run(
          crypto.randomUUID(),
          user.id,
          card.type,
          card.content,
          JSON.stringify(card.tags || []),
          article.title,
          article.id,
          now,
          now
        );
      }
    }

    res.json({ success: true, article: { ...article, saved: true } });
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
  app.get("/api/cards", (req, res) => {
    const user = requireAuthUser(req, res);
    if (!user) return;
    const rows = db.prepare(`
      SELECT id, type, content, tags_json, article_title, article_id
      FROM cards
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(user.id) as CardRow[];
    res.json(rows.map(toCard));
  });

  // Add a new manual card
  app.post("/api/cards", (req, res) => {
    const user = requireAuthUser(req, res);
    if (!user) return;
    const now = Date.now();
    const type = req.body?.type as AtomCard["type"];
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.filter((tag: unknown) => typeof tag === "string") as string[] : [];
    const articleTitle = typeof req.body?.articleTitle === "string" && req.body.articleTitle.trim()
      ? req.body.articleTitle.trim()
      : "手动录入";
    const articleId = Number.isFinite(Number(req.body?.articleId)) ? Number(req.body.articleId) : null;
    if (!content || !["观点", "数据", "金句", "故事"].includes(type)) {
      return res.status(400).json({ error: "Invalid card payload" });
    }
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO cards (id, user_id, type, content, tags_json, article_title, article_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, type, content, JSON.stringify(tags), articleTitle, articleId, now, now);
    const newCard: AtomCard = {
      id,
      type,
      content,
      tags,
      articleTitle,
      articleId: articleId ?? undefined
    };
    res.json(newCard);
  });

  // Update a card
  app.put("/api/cards/:id", (req, res) => {
    const user = requireAuthUser(req, res);
    if (!user) return;
    const { id } = req.params;
    const existing = db.prepare(`
      SELECT id, type, content, tags_json, article_title, article_id
      FROM cards
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).get(id, user.id) as CardRow | undefined;
    if (!existing) {
      return res.status(404).json({ error: "Card not found" });
    }
    const nextType = req.body?.type && ["观点", "数据", "金句", "故事"].includes(req.body.type) ? req.body.type : existing.type;
    const nextContent = typeof req.body?.content === "string" ? req.body.content : existing.content;
    const nextTags = Array.isArray(req.body?.tags)
      ? req.body.tags.filter((tag: unknown) => typeof tag === "string") as string[]
      : (() => {
          try {
            const parsed = JSON.parse(existing.tags_json);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })();
    const nextArticleTitle = typeof req.body?.articleTitle === "string" && req.body.articleTitle.trim()
      ? req.body.articleTitle.trim()
      : existing.article_title;
    const nextArticleId = req.body?.articleId === undefined
      ? existing.article_id
      : Number.isFinite(Number(req.body.articleId))
        ? Number(req.body.articleId)
        : null;
    db.prepare(`
      UPDATE cards
      SET type = ?, content = ?, tags_json = ?, article_title = ?, article_id = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(nextType, nextContent, JSON.stringify(nextTags), nextArticleTitle, nextArticleId, Date.now(), id, user.id);
    res.json({
      id,
      type: nextType,
      content: nextContent,
      tags: nextTags,
      articleTitle: nextArticleTitle,
      articleId: nextArticleId ?? undefined
    } as AtomCard);
  });

  // Delete a card
  app.delete("/api/cards/:id", (req, res) => {
    const user = requireAuthUser(req, res);
    if (!user) return;
    const { id } = req.params;
    db.prepare("DELETE FROM cards WHERE id = ? AND user_id = ?").run(id, user.id);
    res.json({ success: true });
  });

  // Translate article content
  app.post("/api/translate", async (req, res) => {
    const { content, targetLang = 'zh-CN' } = req.body;
    
    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }

    try {
      const decodeHtmlEntities = (text: string) => text
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");

      const googleTranslateUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(content)}`;
      const googleTranslateResponse = await fetch(googleTranslateUrl);
      if (!googleTranslateResponse.ok) {
        return res.status(502).json({
          error: "Translation failed",
          details: "Google Translate request failed"
        });
      }
      const googleTranslateData = await googleTranslateResponse.json() as unknown;
      const translatedText = Array.isArray(googleTranslateData) && Array.isArray(googleTranslateData[0])
        ? (googleTranslateData[0] as unknown[])
            .map(part => Array.isArray(part) ? String(part[0] || '') : '')
            .join('')
        : '';
      if (!translatedText.trim()) {
        return res.status(502).json({
          error: "Translation failed",
          details: "Google Translate returned empty content"
        });
      }
      res.json({
        success: true,
        translatedContent: decodeHtmlEntities(translatedText),
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
