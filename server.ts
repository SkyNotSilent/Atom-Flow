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
import pg from "pg";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import { Resend } from "resend";
import nodemailer from "nodemailer";
import sharp from "sharp";
import { createServer, type IncomingMessage } from "http";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { gzipSync, gunzipSync } from "zlib";
import { randomUUID } from "crypto";
import { URL } from "url";
import pino from "pino";
import pinoHttp from "pino-http";

dotenv.config();

const isProduction = process.env.NODE_ENV === "production";
const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  base: {
    service: "atomflow",
    env: process.env.NODE_ENV || "development",
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers.set-cookie",
      "password",
      "passwordHash",
      "password_hash",
      "token",
      "secret",
    ],
    censor: "[redacted]",
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
});

const formatOtpForLog = (code: string) => {
  return isProduction ? `${code.slice(0, 2)}****` : code;
};

const logOtpEvent = (event: "login" | "registration", email: string, code: string) => {
  const payload = { authEvent: event, email, otp: formatOtpForLog(code) };
  if (isProduction) {
    logger.info(payload, "Verification code generated");
  } else {
    logger.debug(payload, "Verification code generated");
  }
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
};

const sanitizeClientLogValue = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return "[truncated]";
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeClientLogValue(item, depth + 1));
  if (!isPlainRecord(value)) {
    if (typeof value === "string") return value.slice(0, 2000);
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).slice(0, 50).map(([key, item]) => {
      const sensitiveKey = /password|token|secret|authorization|cookie|code/i.test(key);
      return [key, sensitiveKey ? "[redacted]" : sanitizeClientLogValue(item, depth + 1)];
    })
  );
};

const shouldSkipRequestLog = (req: IncomingMessage) => {
  const pathname = (req.url || "").split("?")[0];
  return (
    pathname.startsWith("/@vite") ||
    pathname.startsWith("/@react-refresh") ||
    pathname.startsWith("/src/") ||
    pathname.startsWith("/node_modules/") ||
    pathname.startsWith("/assets/") ||
    pathname === "/favicon.ico" ||
    /\.(?:js|mjs|css|map|ico|png|jpe?g|gif|svg|webp|woff2?|ttf)$/i.test(pathname)
  );
};

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception");
  process.exit(1);
});

// Parse BIGINT as number instead of string
pg.types.setTypeParser(20, v => v === null ? null : Number(v));

// Extend express-session types
declare module "express-session" {
  interface SessionData {
    userId?: number;
    email?: string;
  }
}

// Wrap async Express handlers to catch rejections (Express 4 doesn't do this automatically)
const asyncHandler = (fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<any>): express.RequestHandler =>
  (req, res, next) => fn(req, res, next).catch(next);

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

// Built-in source names — these are globally shared and never stored per-user
const BUILTIN_SOURCE_NAMES = new Set([
  '少数派', '人人都是产品经理', '36氪', '虎嗅', '数字生命卡兹克',
  '新智元', '即刻话题', 'GitHub Blog', 'Sam Altman',
  '张小珺商业访谈录', 'Lex Fridman', 'Y Combinator', 'Andrej Karpathy'
]);

async function loadUserArticlesAsArticles(userId: number, pool: pg.Pool): Promise<Article[]> {
  const rows = (await pool.query(
    `SELECT id, source, source_icon, topic, title, excerpt, content, url,
            audio_url, audio_duration, published_at, time_str, saved,
            full_fetched, markdown_content
     FROM user_articles
     WHERE user_id = $1
     ORDER BY published_at DESC NULLS LAST
     LIMIT 500`,
    [userId]
  )).rows;

  return rows.map(row => ({
    id: Number(row.id),
    saved: row.saved as boolean,
    source: row.source as string,
    sourceIcon: row.source_icon ?? undefined,
    topic: row.topic as string,
    time: row.time_str as string,
    publishedAt: row.published_at ? Number(row.published_at) : undefined,
    title: row.title as string,
    excerpt: row.excerpt as string,
    content: row.content as string,
    markdownContent: row.markdown_content ?? undefined,
    url: row.url ?? undefined,
    audioUrl: row.audio_url ?? undefined,
    audioDuration: row.audio_duration ?? undefined,
    fullFetched: row.full_fetched as boolean,
    cards: []
  }));
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

type WritingCardInput = {
  id?: string;
  type: AtomCard["type"];
  content: string;
  tags?: string[];
  articleTitle?: string;
  articleId?: number;
  savedArticleId?: number;
};

type WritingOutlineSection = {
  heading: string;
  goal: string;
};

type WritingPlanResult = {
  title: string;
  angle: string;
  style: string;
  outline: WritingOutlineSection[];
};

type WritingEvidenceMapItem = {
  section: string;
  nodeIds: string[];
  note: string;
};

type WriteAgentState = {
  focusedTopic?: string;
  activatedNodeIds?: string[];
  activationSummary?: string[];
  latestOutline?: WritingOutlineSection[];
  latestAngle?: string;
  lastGeneratedNoteId?: number;
  lastGeneratedNoteTitle?: string;
};

const sanitizeWritingCards = (cards: unknown[]): WritingCardInput[] => {
  const normalizedCards: WritingCardInput[] = [];
  for (const item of cards) {
    const card = item as Record<string, unknown>;
    if (
      typeof card?.type !== "string" ||
      !VALID_WRITING_CARD_TYPES.has(card.type) ||
      typeof card?.content !== "string" ||
      card.content.trim().length < 2
    ) {
      continue;
    }
    normalizedCards.push({
      id: typeof card.id === "string" ? card.id : undefined,
      type: card.type as AtomCard["type"],
      content: card.content.trim().slice(0, 220),
      tags: Array.isArray(card.tags) ? card.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 6) : [],
      articleTitle: typeof card.articleTitle === "string" ? card.articleTitle : undefined,
      articleId: typeof card.articleId === "number" ? card.articleId : undefined,
      savedArticleId: typeof card.savedArticleId === "number" ? card.savedArticleId : undefined
    });
  }
  return normalizedCards;
};

const summarizeWritingCards = (cards: WritingCardInput[]) => {
  const tagCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  cards.forEach(card => {
    typeCounts.set(card.type, (typeCounts.get(card.type) || 0) + 1);
    (card.tags || []).forEach(tag => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1));
  });
  const topTags = Array.from(tagCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([tag]) => tag);
  const typeSummary = Array.from(typeCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([type, count]) => `${type} x${count}`)
    .join("、");
  return { topTags, typeSummary };
};

const buildFallbackDraft = (topic: string, cards: WritingCardInput[]) => {
  const { topTags } = summarizeWritingCards(cards);
  const viewpoints = cards.filter(card => card.type === "观点" || card.type === "灵感");
  const evidence = cards.filter(card => card.type === "数据" || card.type === "金句");
  const stories = cards.filter(card => card.type === "故事");
  const opening = viewpoints[0]?.content || cards[0]?.content || "这组素材里最重要的，不是信息本身，而是它们之间的关系。";
  const secondPoint = viewpoints[1]?.content || evidence[0]?.content || cards[1]?.content || "";
  const quote = evidence.find(card => card.type === "金句")?.content || "";
  const dataPoint = evidence.find(card => card.type === "数据")?.content || "";
  const story = stories[0]?.content || cards.find(card => card.articleTitle)?.content || "";

  return [
    `# ${topic}`,
    "",
    `${opening}${secondPoint ? ` 更进一步看，${secondPoint}` : ""}`,
    "",
    "## 为什么这件事值得写",
    "",
    `${cards.slice(0, 3).map(card => card.content).join("；")}。这些节点放在一起看，说明问题并不只是表层现象，而是已经形成了可被复用的判断框架。`,
    "",
    "## 这组知识之间真正的连接",
    "",
    dataPoint ? `${dataPoint}。这让判断不再停留在感受层面。` : "仅靠单个观点很难成立，但当这些节点彼此支撑时，文章就有了骨架。",
    quote ? `${quote}。这句话适合作为文章里的情绪锚点。` : "",
    story ? `${story}。案例的价值不在热闹，而在于把抽象判断落到具体场景。` : "",
    "",
    "## 可以如何落成一篇完整文章",
    "",
    `如果把这篇文章继续往下写，可以围绕“${topic}”展开三步：先把问题讲透，再把判断立住，最后把方法或启发交代清楚。${topTags.length ? ` 目前最值得继续补强的标签是：${topTags.join("、")}。` : ""}`,
    "",
    "## 可继续补强",
    "",
    "- 补 1 个更具体的数据或样本",
    "- 补 1 个反例，让观点更稳",
    "- 补 1 个来自原文的细节场景",
    "- 再压缩一次开头，让判断更快出现"
  ].filter(Boolean).join("\n");
};

const buildWritingUserPrompt = (topic: string, activeCards: WritingCardInput[], extraCards: WritingCardInput[]) => {
  const cardBlock = activeCards
    .map((card, index) => `${index + 1}. [${card.type}] ${card.content}${card.tags?.length ? ` | tags: ${card.tags.join("、")}` : ""}${card.articleTitle ? ` | source: ${card.articleTitle}` : ""}`)
    .join("\n");
  const extraBlock = extraCards.length > 0
    ? extraCards
      .map((card, index) => `${index + 1}. [${card.type}] ${card.content}${card.tags?.length ? ` | tags: ${card.tags.join("、")}` : ""}`)
      .join("\n")
    : "无";
  const { topTags, typeSummary } = summarizeWritingCards(activeCards);

  return `写作主题：${topic}

参考素材概览（${activeCards.length} 条，类型分布：${typeSummary || "未统计"}，高频标签：${topTags.join("、") || "无"}）：

核心参考素材：
${cardBlock}

补充参考素材：
${extraBlock}

重要提醒：以上素材仅供参考和启发，不要逐条搬运或罗列。请用自己的语言写一篇有独立观点、叙事连贯的原创文章。素材是背景知识，不是文章骨架。`;
};

const WRITING_PLAN_SYSTEM_PROMPT = `你是一位资深内容策划师。你的目标是设计一篇有独立观点、叙事连贯的原创文章结构，而不是对素材做分类整理。

你必须输出严格 JSON，字段如下：
{
  "title": "文章标题",
  "angle": "一句话说明文章的核心判断——必须是作者自己的立场，不是对素材的总结",
  "style": "评论型|分析型|叙事型|方法型 中的一个",
  "outline": [
    { "heading": "二级标题", "goal": "这一节要完成什么论证" }
  ]
}

规则：
1. 提纲控制在 3 到 4 个 section，每个 section 要有自己的论点推进，不是按素材分类。
2. 标题要像专栏作家写的，有锐度，不要空泛模板。
3. angle 必须是可落地的判断，不是主题复述，不是"从多个角度看XXX"。
4. outline 的结构应该是：提出问题 → 给出判断 → 展开论证 → 收束结论，而不是按素材类型罗列。
5. 素材只是背景知识和灵感来源，文章结构要围绕作者自己的观点展开。
6. 严格只输出 JSON。`;

const WRITING_POLISH_SYSTEM_PROMPT = `你是中文写作润色 Agent。你的任务是让草稿更像真人写的，而不是改换观点。

要求：
1. 保留原有结构、结论和论证顺序。
2. 删除套话、空话、AI 腔。
3. 让句子更自然、更有推进感，但不要堆修辞。
4. 输出纯 Markdown，不要解释。`;

const AI_REQUEST_TIMEOUT_MS = 120000;
const AI_DRAFT_MAX_TOKENS = 2400;
const AI_POLISH_MAX_TOKENS = 2400;

const safeJsonParse = <T>(raw: string): T | null => {
  try {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
};

const sanitizeWritingPlan = (plan: WritingPlanResult | null, topic: string): WritingPlanResult => {
  const fallbackOutline: WritingOutlineSection[] = [
    { heading: "为什么这件事值得写", goal: "把问题和判断先立住" },
    { heading: "这组素材真正说明了什么", goal: "把核心论证讲透" },
    { heading: "可以怎样继续展开", goal: "把行动建议或后续写法收束出来" }
  ];
  if (!plan) {
    return {
      title: topic,
      angle: `围绕“${topic}”提炼出一个更扎实的判断`,
      style: "分析型",
      outline: fallbackOutline
    };
  }
  const title = typeof plan.title === "string" && plan.title.trim() ? plan.title.trim().slice(0, 40) : topic;
  const angle = typeof plan.angle === "string" && plan.angle.trim()
    ? plan.angle.trim().slice(0, 120)
    : `围绕“${topic}”提炼出一个更扎实的判断`;
  const style = typeof plan.style === "string" && ["评论型", "分析型", "叙事型", "方法型"].includes(plan.style)
    ? plan.style
    : "分析型";
  const outline = Array.isArray(plan.outline)
    ? plan.outline
      .map(item => ({
        heading: typeof item?.heading === "string" ? item.heading.trim().slice(0, 24) : "",
        goal: typeof item?.goal === "string" ? item.goal.trim().slice(0, 80) : ""
      }))
      .filter(item => item.heading && item.goal)
      .slice(0, 4)
    : [];

  return {
    title,
    angle,
    style,
    outline: outline.length >= 2 ? outline : fallbackOutline
  };
};

const buildWritingPlanPrompt = (topic: string, activeCards: WritingCardInput[], extraCards: WritingCardInput[]) => {
  return `${buildWritingUserPrompt(topic, activeCards, extraCards)}

现在不要写正文，只做写作策划。`;
};

const buildDraftPrompt = (topic: string, plan: WritingPlanResult, activeCards: WritingCardInput[], extraCards: WritingCardInput[]) => {
  const outlineText = plan.outline.map((item, index) => `${index + 1}. ${item.heading} - ${item.goal}`).join("\n");
  const cardLookup = activeCards
    .map((card, index) => `A${index + 1} [${card.type}] ${card.content}${card.tags?.length ? ` | ${card.tags.join("、")}` : ""}`)
    .join("\n");
  const extraLookup = extraCards
    .map((card, index) => `B${index + 1} [${card.type}] ${card.content}${card.tags?.length ? ` | ${card.tags.join("、")}` : ""}`)
    .join("\n") || "无";
  return `主题：${topic}
写作风格：${plan.style}
核心判断：${plan.angle}
文章标题：${plan.title}

提纲：
${outlineText}

参考素材（仅供参考，不要逐条搬运）：
${cardLookup}

补充素材：
${extraLookup}

请按以上提纲写出完整 Markdown 正文。要求：
1. 标题使用「# ${plan.title}」
2. 二级标题严格对应提纲
3. 这是一篇原创文章，不是素材汇编。用自己的语言写作，素材只是背景知识
4. 不要逐条引用素材，不要出现”某某卡片提到””根据资料显示””从这些观点可以看出”
5. 文章要有明确的叙事推进：提出问题 → 给出判断 → 展开论证 → 收束结论
6. 写法像一个有见解的专栏作家，不是在做读书笔记
7. 不要输出解释`;
};

const buildEvidenceMap = (plan: WritingPlanResult, activeCards: WritingCardInput[]): WritingEvidenceMapItem[] => {
  const groupedCards = activeCards.map(card => ({
    id: card.id || `${card.type}-${card.content.slice(0, 12)}`,
    text: `${card.content} ${(card.tags || []).join(" ")} ${(card.articleTitle || "")}`.toLowerCase()
  }));
  return plan.outline.map(section => {
    const sectionText = `${section.heading} ${section.goal}`.toLowerCase();
    const matched = groupedCards
      .filter(card => {
        const tokens = sectionText.split(/[\s，。.!?！？、;；:：]+/).filter(Boolean);
        return tokens.some(token => token.length >= 2 && card.text.includes(token));
      })
      .slice(0, 3)
      .map(card => card.id);
    return {
      section: section.heading,
      nodeIds: matched.length > 0 ? matched : groupedCards.slice(0, 2).map(card => card.id),
      note: section.goal
    };
  });
};

const summarizeAgentMessages = (messages: Array<{ role: string; content: string }>) => {
  const compact = messages
    .slice(-10)
    .map(message => `${message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : '工具'}：${normalizePlainText(message.content).slice(0, 120)}`)
    .join(' | ');
  return compact.slice(0, 1200);
};

const inferThreadTitle = (input: string) => normalizePlainText(input).slice(0, 24) || '新的写作会话';

const getRecentThreadMessages = async (pool: pg.Pool, threadId: number, limit = 16) => {
  const rows = (await pool.query(
    `SELECT id, role, content, meta, created_at
     FROM write_agent_messages
     WHERE thread_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [threadId, limit]
  )).rows;
  return rows.reverse().map(row => ({
    id: Number(row.id),
    role: row.role as 'user' | 'assistant' | 'tool',
    content: row.content as string,
    meta: row.meta || {},
    created_at: row.created_at
  }));
};

const upsertThreadState = async (
  pool: pg.Pool,
  threadId: number,
  summary: string,
  state: WriteAgentState,
  title?: string
) => {
  await pool.query(
    `UPDATE write_agent_threads
     SET summary = $1,
         state = $2,
         title = COALESCE($3, title),
         updated_at = NOW()
     WHERE id = $4`,
    [summary, JSON.stringify(state || {}), title ?? null, threadId]
  );
};

const fetchUserSavedCards = async (pool: pg.Pool, userId: number) => {
  return (await pool.query(
    `SELECT id, type, content, tags, article_title AS "articleTitle", article_id AS "articleId", saved_article_id AS "savedArticleId"
     FROM saved_cards WHERE user_id = $1`,
    [userId]
  )).rows.map(row => ({
    ...row,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags
  }));
};

const toolRecallCards = (topic: string, cards: any[], excludeIds: string[] = []) => {
  const normalizedTopic = (topic || '').trim().toLowerCase();
  if (!normalizedTopic) return [];
  const keywords = normalizedTopic.split(/[\s,，。.!?！？、;；:：]+/).filter(keyword => keyword.length >= 2);
  const excludeSet = new Set(excludeIds);
  return cards.filter(card => {
    if (excludeSet.has(card.id)) return false;
    const text = `${card.content} ${(card.tags || []).join(' ')} ${card.articleTitle || ''}`.toLowerCase();
    return keywords.some(keyword => text.includes(keyword));
  }).slice(0, 8);
};

const toolGetActiveNetwork = (cards: any[], activatedNodeIds: string[] = []) => {
  const activatedSet = new Set(activatedNodeIds);
  return cards.filter(card => activatedSet.has(card.id));
};

const toolListRecentNotes = async (pool: pg.Pool, userId: number, limit = 4) => {
  return (await pool.query(
    `SELECT id, title, content, meta, updated_at
     FROM notes
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT $2`,
    [userId, limit]
  )).rows;
};

const buildNoteActivatedNodes = (cards: WritingCardInput[]) => {
  return cards.map(card => ({
    id: card.id || `${card.type}-${normalizePlainText(card.content).slice(0, 24)}`,
    type: card.type,
    content: card.content,
    articleTitle: card.articleTitle || '未命名文章',
    articleId: card.articleId,
    tags: card.tags || []
  }));
};

const buildNoteSourceArticles = (cards: WritingCardInput[]) => {
  const unique = new Map<string, {
    savedArticleId?: number;
    articleId?: number;
    title: string;
    source: string;
    excerpt?: string;
  }>();
  cards.forEach(card => {
    const key = card.savedArticleId
      ? `saved-${card.savedArticleId}`
      : `article-${card.articleId ?? card.articleTitle ?? card.content.slice(0, 20)}`;
    if (unique.has(key)) return;
    unique.set(key, {
      savedArticleId: card.savedArticleId,
      articleId: card.articleId,
      title: card.articleTitle || '未命名文章',
      source: '知识库文章',
      excerpt: card.content.slice(0, 140)
    });
  });
  return Array.from(unique.values());
};

// 从写作卡片中提取唯一来源文章列表
const buildSourceArticlesFromCards = (cardsForWriting: any[], dbCards: any[]) => {
  const articleMap = new Map<string, { articleId?: number; articleTitle: string; url?: string; cardIds: number[] }>();
  const allCards = dbCards.length > 0 ? dbCards : cardsForWriting;
  for (const card of allCards) {
    const key = card.saved_article_id ? `article_${card.saved_article_id}` : `title_${card.article_title || card.context_title || '未知来源'}`;
    if (!articleMap.has(key)) {
      articleMap.set(key, {
        articleId: card.saved_article_id || undefined,
        articleTitle: card.article_title || card.context_title || '未知来源',
        url: card.article_url || undefined,
        cardIds: [],
      });
    }
    articleMap.get(key)!.cardIds.push(card.id);
  }
  return Array.from(articleMap.values());
};

const createAgentDraftNote = async (
  pool: pg.Pool,
  userId: number,
  input: {
    title: string;
    content: string;
    topic: string;
    style: string;
    outline: WritingOutlineSection[];
    evidenceMap: WritingEvidenceMapItem[];
    activeCards: WritingCardInput[];
    activationSummary: string[];
    sourceArticles?: Array<{ articleId?: number; articleTitle: string; url?: string; cardIds: number[] }>;
  }
) => {
  const tags = Array.from(new Set(input.activeCards.flatMap(card => card.tags || []))).slice(0, 10);
  const meta = {
    topic: input.topic,
    style: input.style,
    outline: input.outline,
    activationSummary: input.activationSummary,
    activatedNodes: buildNoteActivatedNodes(input.activeCards),
    evidenceMap: input.evidenceMap,
    sourceArticles: input.sourceArticles || buildNoteSourceArticles(input.activeCards)
  };
  const row = (await pool.query(
    `INSERT INTO notes (user_id, title, content, tags, meta)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, content, tags, meta, created_at, updated_at`,
    [userId, input.title, input.content, JSON.stringify(tags), JSON.stringify(meta)]
  )).rows[0];
  return row;
};

// --- AI-powered card extraction (with fallback to regex) ---
const AI_SYSTEM_PROMPT = `你是一个知识提炼助手。请从文章中提取最多3张知识卡片。
类型：观点、数据、金句、故事
- 观点：文章核心主张，用自己的话提炼，最多100字
- 数据：含具体数字/百分比/研究结论，原文摘录，最多100字
- 金句：表达精炼值得收藏的原话，直接引用，最多100字
- 故事：具体案例或叙事片段，最多100字
规则：
1. 优先提取有信息量的类型，没有就不硬凑
2. tags 给2-5个语义标签
3. 严格只输出JSON数组，不要输出任何其他内容
格式：[{"type":"观点","content":"...","tags":["标签1","标签2"]}]`;
const WRITING_AGENT_SYSTEM_PROMPT = `你是一位优秀的中文专栏作家。你的任务是写原创文章，不是做素材汇编。

核心原则：
1. 你拿到的”素材”只是背景知识和灵感来源。你要基于这些素材形成自己的观点，用自己的语言写作。
2. 绝对不要逐条搬运素材内容。不要出现”某某观点认为””某某数据表明”这种罗列式写法。
3. 文章要有明确的叙事推进关系：提出问题 → 给出判断 → 展开论证 → 收束结论。
4. 写法像一个有独立见解的作者在表达自己的思考，而不是在整理别人的观点。
5. 开头不要套话，不要”在当今时代””众所周知””让我们来看看”。
6. 如果素材里有冲突观点，要写出冲突和你的判断，而不是抹平它。
7. 如果素材不足，就写一篇更短但更扎实的文章，不要注水。
8. 不要 AI 腔，不要假装引用不存在的数据。
9. 输出必须是纯 Markdown，不要输出解释，不要输出 JSON，不要使用 HTML。

格式要求：
- 第一行直接是标题
- 正文用短段落推进
- 使用 2-4 个二级标题（##）
- 段落之间要有逻辑推进，不是并列罗列`;

const VALID_CARD_TYPES = new Set(["观点", "数据", "金句", "故事", "灵感"]);
const VALID_WRITING_CARD_TYPES = new Set(["观点", "数据", "金句", "故事", "灵感"]);

const extractCardsWithAI = async (
  article: Article
): Promise<Omit<AtomCard, "id" | "articleTitle" | "articleId">[]> => {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL;
  if (!apiKey || !baseUrl || !model) return [];

  try {
    const plainContent = normalizePlainText(
      article.markdownContent || article.content || article.excerpt
    ).slice(0, 3000);

    if (plainContent.length < 30) return [];

    const userPrompt = `标题：${article.title}\n来源：${article.source}\n话题：${article.topic}\n\n正文：${plainContent}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'user', content: `${AI_SYSTEM_PROMPT}\n\n===文章===\n${userPrompt}` }
        ],
        max_tokens: 1000,
        temperature: 0.3
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const responseBody = await response.text();
      logger.error({
        module: "ai",
        status: response.status,
        responseBody: responseBody.slice(0, 1000),
      }, "AI API request failed");
      return [];
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return [];

    // Strip markdown code fences if present
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const parsed: unknown = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    // Validate and sanitize each card
    const validCards: Omit<AtomCard, "id" | "articleTitle" | "articleId">[] = [];
    for (const item of parsed.slice(0, 3)) {
      const card = item as Record<string, unknown>;
      if (
        typeof card.type === 'string' &&
        VALID_CARD_TYPES.has(card.type) &&
        typeof card.content === 'string' &&
        card.content.trim().length > 0 &&
        Array.isArray(card.tags) &&
        card.tags.every((t: unknown) => typeof t === 'string')
      ) {
        validCards.push({
          type: card.type as AtomCard['type'],
          content: card.content.trim().slice(0, 100),
          tags: (card.tags as string[]).slice(0, 5)
        });
      }
    }

    if (validCards.length > 0) {
      logger.info({
        module: "ai",
        cardCount: validCards.length,
        articleTitle: article.title.slice(0, 80),
      }, "AI cards extracted");
    }
    return validCards;
  } catch (err) {
    logger.error({ err, module: "ai", articleTitle: article.title.slice(0, 80) }, "AI card extraction failed");
    return [];
  }
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
    logger.info({
      module: "rss",
      counts: {
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
      }
    }, "RSS feed counts");
    const feedNames = [
      'sspai',
      'woshipm',
      '36kr',
      'huxiu',
      'zslren',
      'xzy',
      'jike topic',
      'GitHub Blog',
      'Sam Altman Twitter',
      '张小珺商业访谈录',
      'Lex Fridman',
      'Y Combinator',
      'Andrej Karpathy',
    ];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error({ err: result.reason, module: "rss", feed: feedNames[index] }, "Failed to fetch RSS feed");
      }
    });
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
    logger.error({ err: error, module: "rss" }, "Failed to fetch RSS, falling back to mock data");
    return [...MOCK_ARTICLES];
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3001);

  // --- Database init (PostgreSQL) ---
  // Note: rejectUnauthorized: false is required for Railway's self-signed PG certs.
  // If migrating to another platform (Supabase, Neon, etc.), review this setting.
  let pool: pg.Pool | null = null;
  let dbAvailable = false;
  try {
    const _pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
      max: 10,
    });
    // Test connection
    await _pool.query('SELECT 1');
    pool = _pool;
    dbAvailable = true;
    logger.info({ module: "db" }, "Database connected successfully");
  } catch (err) {
    logger.warn({ err, module: "db" }, "Database unavailable; server will start without auth/persistence features");
  }

  if (pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      email        TEXT NOT NULL UNIQUE,
      nickname     TEXT,
      avatar_url   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verification_codes (
      id           SERIAL PRIMARY KEY,
      email        TEXT NOT NULL,
      code         TEXT NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      used         BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vc_email ON verification_codes(email, used, expires_at)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_cards (
      id             TEXT PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type           TEXT NOT NULL,
      content        TEXT NOT NULL,
      tags           JSONB NOT NULL DEFAULT '[]'::jsonb,
      article_title  TEXT NOT NULL DEFAULT '',
      article_id     BIGINT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_cards_user ON saved_cards(user_id)`);

  // --- Schema migrations for password auth, preferences, notes ---
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await pool.query(`ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      source_layout JSONB,
      theme        TEXT DEFAULT 'light',
      view_mode    TEXT DEFAULT 'card',
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title        TEXT NOT NULL DEFAULT '',
      content      TEXT NOT NULL DEFAULT '',
      tags         JSONB NOT NULL DEFAULT '[]'::jsonb,
      meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, updated_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_agent_threads (
      id           BIGSERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title        TEXT NOT NULL DEFAULT '新的写作会话',
      summary      TEXT NOT NULL DEFAULT '',
      state        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_threads_user ON write_agent_threads(user_id, updated_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_agent_messages (
      id           BIGSERIAL PRIMARY KEY,
      thread_id    BIGINT NOT NULL REFERENCES write_agent_threads(id) ON DELETE CASCADE,
      role         TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
      content      TEXT NOT NULL DEFAULT '',
      meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_messages_thread ON write_agent_messages(thread_id, created_at ASC)`);

  // User custom subscriptions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      rss_url     TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#718096',
      icon        TEXT,
      topic       TEXT NOT NULL DEFAULT '自定义订阅',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, name)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user ON user_subscriptions(user_id)`);

  // Articles from user custom subscriptions (permanently stored, per-user)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_articles (
      id              BIGSERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id INTEGER NOT NULL REFERENCES user_subscriptions(id) ON DELETE CASCADE,
      source          TEXT NOT NULL,
      source_icon     TEXT,
      topic           TEXT NOT NULL DEFAULT '自定义订阅',
      title           TEXT NOT NULL,
      excerpt         TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL DEFAULT '',
      url             TEXT,
      audio_url       TEXT,
      audio_duration  TEXT,
      published_at    BIGINT,
      time_str        TEXT NOT NULL DEFAULT '',
      saved           BOOLEAN NOT NULL DEFAULT FALSE,
      full_fetched    BOOLEAN NOT NULL DEFAULT FALSE,
      markdown_content TEXT,
      fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_articles_unique_url ON user_articles(user_id, url) WHERE url IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_articles_user_source ON user_articles(user_id, source)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_articles_published ON user_articles(user_id, published_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_articles_subscription ON user_articles(subscription_id)`);

  // --- saved_articles: persisted original articles when user saves to knowledge base ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_articles (
      id            BIGSERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title         TEXT NOT NULL DEFAULT '',
      url           TEXT,
      source        TEXT NOT NULL DEFAULT '',
      source_icon   TEXT,
      topic         TEXT NOT NULL DEFAULT '',
      excerpt       TEXT NOT NULL DEFAULT '',
      content       TEXT NOT NULL DEFAULT '',
      published_at  BIGINT,
      saved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_articles_user ON saved_articles(user_id, saved_at DESC)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_articles_unique ON saved_articles(user_id, url) WHERE url IS NOT NULL`);

  // --- saved_cards: add origin and saved_article_id columns ---
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT 'manual'`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS saved_article_id BIGINT REFERENCES saved_articles(id) ON DELETE SET NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_cards_saved_article ON saved_cards(saved_article_id)`);

  // --- card_relations: knowledge graph (reserved for future use) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS card_relations (
      id              SERIAL PRIMARY KEY,
      card_a          TEXT NOT NULL REFERENCES saved_cards(id) ON DELETE CASCADE,
      card_b          TEXT NOT NULL REFERENCES saved_cards(id) ON DELETE CASCADE,
      relation_type   TEXT NOT NULL CHECK (relation_type IN ('supports','conflicts','extends')),
      confidence      REAL DEFAULT 0.5,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (card_a, card_b, relation_type)
    )
  `);

  // --- pgvector: optional semantic search extension ---
  let pgvectorAvailable = false;
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    pgvectorAvailable = true;
    await pool.query('ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS embedding vector(1536)');
    logger.info({ module: "db" }, "pgvector extension enabled");
  } catch {
    logger.info({ module: "db" }, "pgvector not available, semantic search disabled");
  }

  // Backfill: set default nickname for existing users who don't have one
  await pool.query("UPDATE users SET nickname = split_part(email, '@', 1) WHERE nickname IS NULL");
  } // end if (pool)

  const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

  // Gmail SMTP transporter (preferred over Resend for free usage)
  const smtpTransporter = process.env.SMTP_USER && process.env.SMTP_PASS
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      })
    : null;

  // Avatar upload setup (memory storage → compress → base64 data URL stored in DB)
  const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2MB threshold for compression
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // accept up to 10MB, compress if > 2MB
    fileFilter: (_req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      cb(null, allowed.includes(file.mimetype));
    }
  });

  app.use(express.json());
  app.use(pinoHttp({
    logger,
    autoLogging: {
      ignore: shouldSkipRequestLog,
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage: (req, res, responseTime) => `${req.method} ${req.url} ${res.statusCode} ${Math.round(responseTime)}ms`,
    customErrorMessage: (req, res, err) => `${req.method} ${req.url} ${res.statusCode} ${err.message}`,
  }));

  app.post("/api/log", (req, res) => {
    const { level, message, context } = req.body || {};
    if (level !== "error" && level !== "warn") {
      return res.status(400).json({ error: "unsupported log level" });
    }

    const logPayload = {
      module: "client",
      client: sanitizeClientLogValue(isPlainRecord(context) ? context : {}),
    };
    const logMessage = `[CLIENT] ${typeof message === "string" ? message.slice(0, 500) : "Client log"}`;
    if (level === "error") {
      logger.error(logPayload, logMessage);
    } else {
      logger.warn(logPayload, logMessage);
    }
    return res.json({ success: true });
  });

  // --- Session middleware (PostgreSQL) ---
  if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET environment variable must be set in production');
  }
  app.set('trust proxy', 1);
  if (pool) {
    const PgSession = connectPgSimple(session);
    app.use(session({
      store: new PgSession({ pool, createTableIfMissing: true }),
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
  } else {
    app.use(session({
      secret: process.env.SESSION_SECRET || 'atomflow-dev-secret-change-in-prod',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
    }));
  }

  // In-memory database for prototype
  let articles: Article[] = [];
  const cachedArticles = await loadArticlesCache();
  if (cachedArticles.length > 0) {
    articles = cachedArticles;
  }

  // Load RSS feeds on startup
  logger.info({ module: "rss" }, "Fetching RSS feeds");
  const refreshFeeds = async () => {
    try {
      const fresh = await fetchRSSFeeds();
      logger.info({ module: "rss", freshCount: fresh.length }, "Fetched fresh articles");

      // 只有当新数据不为空时才合并
      if (fresh.length > 0) {
        const withFallback = mergeWithSourceFallback(articles, fresh);
        articles = mergeArticles(articles, rankArticles(withFallback));
        await saveArticlesCache(articles);
        logger.info({ module: "rss", articleCount: articles.length }, "Loaded articles");
      } else {
        logger.info({ module: "rss" }, "No fresh articles fetched, keeping existing data");
      }
    } catch (error) {
      logger.error({ err: error, module: "rss" }, "Failed to refresh feeds, keeping existing data");
    }
  };
  // 如果有缓存数据，不阻塞启动，后台异步刷新
  if (articles.length > 0) {
    logger.info({ module: "rss", articleCount: articles.length }, "Using cached articles, refreshing in background");
    refreshFeeds();
  } else {
    await refreshFeeds();
  }
  setInterval(() => {
    refreshFeeds().catch(error => logger.error({ err: error, module: "rss" }, "Failed to refresh feeds"));
  }, 10 * 60 * 1000);

  // --- Auth Routes ---

  app.post("/api/auth/send-code", asyncHandler(async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }
    if (!smtpTransporter && !resend) {
      return res.status(500).json({ error: '邮件服务未配置' });
    }

    const recent = (await pool.query(
      "SELECT id FROM verification_codes WHERE email = $1 AND created_at > NOW() - INTERVAL '60 seconds' AND used = FALSE",
      [email]
    )).rows[0];
    if (recent) {
      return res.status(429).json({ error: '发送过于频繁，请 60 秒后再试' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await pool.query('INSERT INTO verification_codes (email, code, expires_at) VALUES ($1, $2, $3)', [email, code, expiresAt]);

    logOtpEvent("login", email, code);

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
      logger.error({ err: error, module: "auth", email }, "Failed to send verification code");
      return res.status(500).json({ error: '发送验证码失败，请稍后再试' });
    }
  }));

  app.post("/api/auth/verify", asyncHandler(async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const code = (req.body?.code || '').trim();
    if (!email || !code) {
      return res.status(400).json({ error: '请输入邮箱和验证码' });
    }

    const record = (await pool.query(
      'SELECT id FROM verification_codes WHERE email = $1 AND code = $2 AND used = FALSE AND expires_at > NOW()',
      [email, code]
    )).rows[0];
    if (!record) {
      return res.status(400).json({ error: '验证码无效或已过期' });
    }

    await pool.query('UPDATE verification_codes SET used = TRUE WHERE id = $1', [record.id]);

    let user = (await pool.query('SELECT id, email, nickname, avatar_url, password_hash FROM users WHERE email = $1', [email])).rows[0];
    if (!user) {
      const nickname = email.split('@')[0];
      const result = await pool.query('INSERT INTO users (email, nickname) VALUES ($1, $2) RETURNING id', [email, nickname]);
      user = { id: result.rows[0].id, email, nickname, avatar_url: null, password_hash: null };
    }

    req.session.userId = user.id as number;
    req.session.email = user.email as string;
    return res.json({ success: true, user: { id: user.id, email: user.email, nickname: user.nickname, avatar_url: user.avatar_url, has_password: Boolean(user.password_hash) } });
  }));

  app.get("/api/auth/me", asyncHandler(async (req, res) => {
    if (!req.session.userId) {
      return res.json({ user: null });
    }
    const user = (await pool.query('SELECT id, email, nickname, avatar_url, password_hash FROM users WHERE id = $1', [req.session.userId])).rows[0];
    if (!user) {
      return res.json({ user: null });
    }
    return res.json({ user: { id: user.id, email: user.email, nickname: user.nickname, avatar_url: user.avatar_url, has_password: Boolean(user.password_hash) } });
  }));

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: '登出失败' });
      res.clearCookie('connect.sid');
      return res.json({ success: true });
    });
  });

  // --- Password Registration ---
  app.post("/api/auth/register", asyncHandler(async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: '密码至少 8 个字符' });
    }
    if (!smtpTransporter && !resend) {
      return res.status(500).json({ error: '邮件服务未配置' });
    }

    const existing = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
    if (existing) {
      return res.status(409).json({ error: '该邮箱已注册，请直接登录' });
    }

    const recent = (await pool.query(
      "SELECT id FROM verification_codes WHERE email = $1 AND created_at > NOW() - INTERVAL '60 seconds' AND used = FALSE",
      [email]
    )).rows[0];
    if (recent) {
      return res.status(429).json({ error: '发送过于频繁，请 60 秒后再试' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await pool.query(
      'INSERT INTO verification_codes (email, code, expires_at, password_hash) VALUES ($1, $2, $3, $4)',
      [email, code, expiresAt, passwordHash]
    );

    logOtpEvent("registration", email, code);

    const htmlContent = `
      <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1C1916;">AtomFlow 注册验证码</h2>
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
          subject: '你的 AtomFlow 注册验证码',
          html: htmlContent
        });
      } else if (smtpTransporter) {
        await smtpTransporter.sendMail({
          from: `AtomFlow <${process.env.SMTP_USER}>`,
          to: email,
          subject: '你的 AtomFlow 注册验证码',
          html: htmlContent
        });
      }
      return res.json({ success: true });
    } catch (error) {
      logger.error({ err: error, module: "auth", email }, "Failed to send registration code");
      return res.status(500).json({ error: '发送验证码失败，请稍后再试' });
    }
  }));

  app.post("/api/auth/register/verify", asyncHandler(async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const code = (req.body?.code || '').trim();
    if (!email || !code) {
      return res.status(400).json({ error: '请输入邮箱和验证码' });
    }

    const record = (await pool.query(
      'SELECT id, password_hash FROM verification_codes WHERE email = $1 AND code = $2 AND used = FALSE AND expires_at > NOW() AND password_hash IS NOT NULL',
      [email, code]
    )).rows[0];
    if (!record) {
      return res.status(400).json({ error: '验证码无效或已过期' });
    }

    await pool.query('UPDATE verification_codes SET used = TRUE WHERE id = $1', [record.id]);

    const existing = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
    if (existing) {
      return res.status(409).json({ error: '该邮箱已注册' });
    }

    const nickname = email.split('@')[0];
    const result = await pool.query(
      'INSERT INTO users (email, nickname, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [email, nickname, record.password_hash]
    );
    const user = { id: result.rows[0].id, email, nickname, avatar_url: null, has_password: true };

    req.session.userId = user.id;
    req.session.email = user.email;
    return res.json({ success: true, user });
  }));

  app.post("/api/auth/login-password", asyncHandler(async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';
    if (!email || !password) {
      return res.status(400).json({ error: '请输入邮箱和密码' });
    }

    const user = (await pool.query('SELECT id, email, nickname, avatar_url, password_hash FROM users WHERE email = $1', [email])).rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    req.session.userId = user.id;
    req.session.email = user.email;
    return res.json({ success: true, user: { id: user.id, email: user.email, nickname: user.nickname, avatar_url: user.avatar_url, has_password: true } });
  }));

  // --- Auth middleware ---
  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: '请先登录' });
    }
    next();
  };

  // --- Set/Change password (requires auth) ---
  app.put("/api/auth/set-password", requireAuth, asyncHandler(async (req, res) => {
    const password = req.body?.password || '';
    if (!password || password.length < 8) {
      return res.status(400).json({ error: '密码至少 8 个字符' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, req.session.userId]);
    return res.json({ success: true });
  }));

  // --- Reset password (forgot password: verify code + set new password, no auth) ---
  app.post("/api/auth/reset-password", asyncHandler(async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const code = (req.body?.code || '').trim();
    const password = req.body?.password || '';
    if (!email || !code) {
      return res.status(400).json({ error: '请输入邮箱和验证码' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: '密码至少 8 个字符' });
    }

    const record = (await pool.query(
      'SELECT id FROM verification_codes WHERE email = $1 AND code = $2 AND used = FALSE AND expires_at > NOW() AND password_hash IS NULL',
      [email, code]
    )).rows[0];
    if (!record) {
      return res.status(400).json({ error: '验证码无效或已过期' });
    }

    await pool.query('UPDATE verification_codes SET used = TRUE WHERE id = $1', [record.id]);

    const user = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
    if (!user) {
      return res.status(404).json({ error: '该邮箱未注册' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);

    // Auto login after reset
    req.session.userId = user.id;
    req.session.email = email;
    const updated = (await pool.query('SELECT id, email, nickname, avatar_url, password_hash FROM users WHERE id = $1', [user.id])).rows[0];
    return res.json({ success: true, user: { id: updated.id, email: updated.email, nickname: updated.nickname, avatar_url: updated.avatar_url, has_password: true } });
  }));

  // --- Profile routes ---

  app.put("/api/auth/profile", requireAuth, asyncHandler(async (req, res) => {
    const nickname = (req.body?.nickname || '').trim();
    if (!nickname || nickname.length > 30) {
      return res.status(400).json({ error: '昵称不能为空且不超过30个字符' });
    }
    const user = (await pool.query(
      'UPDATE users SET nickname = $1 WHERE id = $2 RETURNING id, email, nickname, avatar_url, password_hash',
      [nickname, req.session.userId]
    )).rows[0];
    if (!user) return res.status(404).json({ error: '用户不存在' });
    return res.json({ success: true, user: { id: user.id, email: user.email, nickname: user.nickname, avatar_url: user.avatar_url, has_password: Boolean(user.password_hash) } });
  }));

  app.post("/api/auth/avatar", requireAuth, avatarUpload.single('avatar'), asyncHandler(async (req: any, res) => {
    if (!req.file) {
      return res.status(400).json({ error: '请上传有效的图片文件（JPG/PNG/GIF/WebP，最大10MB）' });
    }

    let buffer: Buffer = req.file.buffer;
    let mimetype: string = req.file.mimetype;

    // Compress if larger than 2MB: resize to 256x256 and convert to JPEG
    if (buffer.length > AVATAR_MAX_BYTES) {
      buffer = await sharp(buffer)
        .resize(256, 256, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toBuffer();
      mimetype = 'image/jpeg';
    }

    const dataUrl = `data:${mimetype};base64,${buffer.toString('base64')}`;

    const user = (await pool.query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING id, email, nickname, avatar_url, password_hash',
      [dataUrl, req.session.userId]
    )).rows[0];
    if (!user) return res.status(404).json({ error: '用户不存在' });
    return res.json({ success: true, user: { id: user.id, email: user.email, nickname: user.nickname, avatar_url: user.avatar_url, has_password: Boolean(user.password_hash) } });
  }));

  // --- Preferences routes ---
  app.get("/api/preferences", requireAuth, asyncHandler(async (req, res) => {
    const row = (await pool.query(
      'SELECT source_layout, theme, view_mode FROM user_preferences WHERE user_id = $1',
      [req.session.userId]
    )).rows[0];
    return res.json(row || { source_layout: null, theme: null, view_mode: null });
  }));

  app.put("/api/preferences", requireAuth, asyncHandler(async (req, res) => {
    const { source_layout, theme, view_mode } = req.body;
    await pool.query(
      `INSERT INTO user_preferences (user_id, source_layout, theme, view_mode, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         source_layout = COALESCE($2, user_preferences.source_layout),
         theme = COALESCE($3, user_preferences.theme),
         view_mode = COALESCE($4, user_preferences.view_mode),
         updated_at = NOW()`,
      [req.session.userId, source_layout ? JSON.stringify(source_layout) : null, theme ?? null, view_mode ?? null]
    );
    return res.json({ success: true });
  }));

  // --- Notes routes ---
  app.get("/api/notes", requireAuth, asyncHandler(async (req, res) => {
    const rows = (await pool.query(
      'SELECT id, title, content, tags, meta, created_at, updated_at FROM notes WHERE user_id = $1 ORDER BY updated_at DESC',
      [req.session.userId]
    )).rows;
    return res.json(rows);
  }));

  app.post("/api/notes", requireAuth, asyncHandler(async (req, res) => {
    const { title, content, tags, meta } = req.body;
    const row = (await pool.query(
      'INSERT INTO notes (user_id, title, content, tags, meta) VALUES ($1, $2, $3, $4, $5) RETURNING id, title, content, tags, meta, created_at, updated_at',
      [req.session.userId, title || '', content || '', tags ? JSON.stringify(tags) : '[]', meta ? JSON.stringify(meta) : '{}']
    )).rows[0];
    return res.json(row);
  }));

  app.put("/api/notes/:id", requireAuth, asyncHandler(async (req, res) => {
    const { title, content, tags, meta } = req.body;
    const row = (await pool.query(
      `UPDATE notes SET
        title = COALESCE($1, title),
        content = COALESCE($2, content),
        tags = COALESCE($3, tags),
        meta = COALESCE($4, meta),
        updated_at = NOW()
      WHERE id = $5 AND user_id = $6
      RETURNING id, title, content, tags, meta, created_at, updated_at`,
      [title ?? null, content ?? null, tags ? JSON.stringify(tags) : null, meta ? JSON.stringify(meta) : null, req.params.id, req.session.userId]
    )).rows[0];
    if (!row) return res.status(404).json({ error: '笔记不存在' });
    return res.json(row);
  }));

  app.delete("/api/notes/:id", requireAuth, asyncHandler(async (req, res) => {
    const result = await pool.query('DELETE FROM notes WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    if (result.rowCount === 0) return res.status(404).json({ error: '笔记不存在' });
    return res.json({ success: true });
  }));

  // API Routes
  
  // Get all articles (global + user's private articles when logged in)
  app.get("/api/articles", asyncHandler(async (req, res) => {
    if (!req.session.userId) {
      return res.json(articles);
    }
    const userArticles = await loadUserArticlesAsArticles(req.session.userId, pool);
    if (userArticles.length === 0) {
      return res.json(articles);
    }
    // Deduplicate: skip user articles whose URL already exists in global store
    const globalUrls = new Set(articles.filter(a => a.url).map(a => a.url as string));
    const uniqueUserArticles = userArticles.filter(a => !a.url || !globalUrls.has(a.url));
    return res.json(rankArticles([...articles, ...uniqueUserArticles]));
  }));

  app.post("/api/sources/fetch", asyncHandler(async (req, res) => {
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
    if (!source || !input) {
      return res.status(400).json({ error: "source and input are required" });
    }
    const isBuiltin = BUILTIN_SOURCE_NAMES.has(source);
    const userId = req.session.userId;
    try {
      const parsed = await parseWithRetry([input], 15000, 2);
      const feedIcon = extractFeedIcon(parsed);
      const fetched = normalizeFeedItems(parsed.items || [], source, '自定义订阅', 900000, feedIcon);

      // Anonymous user OR fetching a built-in source → global in-memory store
      if (!userId || isBuiltin) {
        const combined = [...fetched, ...articles];
        const dedup = new Map<string, Article>();
        for (const article of combined) {
          const key = article.url ? `url:${article.url}` : `st:${article.source}:${article.title}`;
          if (!dedup.has(key)) dedup.set(key, article);
        }
        articles = rankArticles(Array.from(dedup.values()));
        await saveArticlesCache(articles);
        return res.json({ success: true, added: fetched.length });
      }

      // Logged-in user + custom source → persist to DB
      const subResult = await pool.query(
        `INSERT INTO user_subscriptions (user_id, name, rss_url, color, icon, topic)
         VALUES ($1, $2, $3, $4, $5, '自定义订阅')
         ON CONFLICT (user_id, name) DO UPDATE SET
           rss_url    = EXCLUDED.rss_url,
           icon       = COALESCE(EXCLUDED.icon, user_subscriptions.icon),
           updated_at = NOW()
         RETURNING id`,
        [userId, source, input, req.body?.color ?? '#718096', feedIcon ?? null]
      );
      const subscriptionId = subResult.rows[0].id as number;

      let added = 0;
      for (const article of fetched) {
        if (!article.url) continue;
        await pool.query(
          `INSERT INTO user_articles
             (user_id, subscription_id, source, source_icon, topic, title, excerpt,
              content, url, audio_url, audio_duration, published_at, time_str)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT DO NOTHING`,
          [
            userId, subscriptionId, article.source, article.sourceIcon ?? null,
            article.topic, article.title, article.excerpt, article.content,
            article.url, article.audioUrl ?? null, article.audioDuration ?? null,
            article.publishedAt ?? null, article.time
          ]
        );
        added++;
      }
      return res.json({ success: true, added });
    } catch (error) {
      return res.status(502).json({ error: "failed to fetch source" });
    }
  }));

  app.post("/api/sources/retry", asyncHandler(async (req, res) => {
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
    if (!source || !input) {
      return res.status(400).json({ error: "source and input are required" });
    }
    const isBuiltin = BUILTIN_SOURCE_NAMES.has(source);
    const userId = req.session.userId;
    try {
      const parsed = await parseWithRetry([input], 60000, 1);
      const feedIcon = extractFeedIcon(parsed);
      const fetched = normalizeFeedItems(parsed.items || [], source, '自定义订阅', 900000, feedIcon);

      if (!userId || isBuiltin) {
        const combined = [...fetched, ...articles];
        const dedup = new Map<string, Article>();
        for (const article of combined) {
          const key = article.url ? `url:${article.url}` : `st:${article.source}:${article.title}`;
          if (!dedup.has(key)) dedup.set(key, article);
        }
        articles = rankArticles(Array.from(dedup.values()));
        await saveArticlesCache(articles);
        return res.json({ success: true, added: fetched.length });
      }

      // Logged-in user + custom source → persist to DB
      const subResult = await pool.query(
        `INSERT INTO user_subscriptions (user_id, name, rss_url, color, icon, topic)
         VALUES ($1, $2, $3, $4, $5, '自定义订阅')
         ON CONFLICT (user_id, name) DO UPDATE SET
           rss_url    = EXCLUDED.rss_url,
           icon       = COALESCE(EXCLUDED.icon, user_subscriptions.icon),
           updated_at = NOW()
         RETURNING id`,
        [userId, source, input, req.body?.color ?? '#718096', feedIcon ?? null]
      );
      const subscriptionId = subResult.rows[0].id as number;

      let added = 0;
      for (const article of fetched) {
        if (!article.url) continue;
        await pool.query(
          `INSERT INTO user_articles
             (user_id, subscription_id, source, source_icon, topic, title, excerpt,
              content, url, audio_url, audio_duration, published_at, time_str)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT DO NOTHING`,
          [
            userId, subscriptionId, article.source, article.sourceIcon ?? null,
            article.topic, article.title, article.excerpt, article.content,
            article.url, article.audioUrl ?? null, article.audioDuration ?? null,
            article.publishedAt ?? null, article.time
          ]
        );
        added++;
      }
      return res.json({ success: true, added });
    } catch (error: any) {
      logger.error({ err: error, module: "rss", source }, "Failed to retry source");
      return res.status(502).json({ error: "获取失败", details: error?.message || '未知错误' });
    }
  }));

  app.delete("/api/sources/:source", asyncHandler(async (req, res) => {
    const source = decodeURIComponent(req.params.source || '').trim();
    if (!source) return res.status(400).json({ error: "source is required" });
    const isBuiltin = BUILTIN_SOURCE_NAMES.has(source);
    const userId = req.session.userId;

    let removed = 0;
    // For built-in sources (or anonymous), remove from global in-memory store
    if (isBuiltin || !userId) {
      const before = articles.length;
      articles = articles.filter(article => article.source !== source);
      await saveArticlesCache(articles);
      removed = before - articles.length;
    }
    // For logged-in users with custom sources, delete from DB (user_articles cascade)
    if (userId && !isBuiltin) {
      const result = await pool.query(
        'DELETE FROM user_subscriptions WHERE user_id = $1 AND name = $2',
        [userId, source]
      );
      removed += result.rowCount ?? 0;
    }
    return res.json({ success: true, removed });
  }));

  app.patch("/api/sources/rename", asyncHandler(async (req, res) => {
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
    // For logged-in users with custom sources, also rename in DB
    const userId = req.session.userId;
    if (userId && !BUILTIN_SOURCE_NAMES.has(from)) {
      await pool.query(
        `UPDATE user_subscriptions SET name = $1, updated_at = NOW() WHERE user_id = $2 AND name = $3`,
        [to, userId, from]
      );
      await pool.query(
        `UPDATE user_articles SET source = $1 WHERE user_id = $2 AND source = $3`,
        [to, userId, from]
      );
    }
    return res.json({ success: true, renamed });
  }));

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
  app.post("/api/articles/:id/save", requireAuth, asyncHandler(async (req, res) => {
    const articleId = parseInt(req.params.id);
    let article = articles.find(a => a.id === articleId);
    let isUserArticle = false;

    // If not in global store, check user_articles DB
    if (!article && req.session.userId) {
      const row = (await pool.query(
        `SELECT id, source, source_icon, topic, title, excerpt, content, url,
                audio_url, audio_duration, published_at, time_str, saved,
                full_fetched, markdown_content
         FROM user_articles WHERE id = $1 AND user_id = $2`,
        [articleId, req.session.userId]
      )).rows[0];
      if (row) {
        isUserArticle = true;
        article = {
          id: Number(row.id), saved: row.saved, source: row.source,
          sourceIcon: row.source_icon ?? undefined, topic: row.topic,
          time: row.time_str, publishedAt: row.published_at ? Number(row.published_at) : undefined,
          title: row.title, excerpt: row.excerpt, content: row.content,
          markdownContent: row.markdown_content ?? undefined, url: row.url ?? undefined,
          audioUrl: row.audio_url ?? undefined, audioDuration: row.audio_duration ?? undefined,
          fullFetched: row.full_fetched, cards: []
        } as Article;
      }
    }

    if (!article) {
      return res.status(404).json({ error: "Article not found" });
    }

    // Check if this user already saved cards for this article
    const existingCard = (await pool.query('SELECT id FROM saved_cards WHERE user_id = $1 AND article_id = $2', [req.session.userId, articleId])).rows[0];
    if (!existingCard) {
      article.saved = true;

      // AI extraction BEFORE transaction (may take up to 15s, don't hold DB conn)
      let cardsToSave = article.cards;
      let origin: 'ai' | 'manual' = 'manual';
      if (!cardsToSave || cardsToSave.length === 0) {
        const aiCards = await extractCardsWithAI(article);
        if (aiCards.length > 0) {
          cardsToSave = aiCards;
          origin = 'ai';
        } else {
          cardsToSave = buildCardsFromArticleContent(article);
        }
        article.cards = cardsToSave;
      }

      const newCards: AtomCard[] = cardsToSave.map(c => ({
        ...c,
        id: Math.random().toString(36).substr(2, 9),
        articleTitle: article.title,
        articleId: article.id
      }));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Persist original article to saved_articles
        let savedArticleId: number | null = null;
        if (article.url) {
          // URL exists: upsert using unique index
          const savedArticleResult = await client.query(
            `INSERT INTO saved_articles (user_id, title, url, source, source_icon, topic, excerpt, content, published_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (user_id, url) WHERE url IS NOT NULL
             DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, excerpt = EXCLUDED.excerpt, source_icon = EXCLUDED.source_icon
             RETURNING id`,
            [
              req.session.userId, article.title, article.url,
              article.source, article.sourceIcon || null, article.topic,
              article.excerpt, article.markdownContent || article.content || article.excerpt,
              article.publishedAt || null
            ]
          );
          savedArticleId = savedArticleResult.rows[0]?.id ?? null;
        } else {
          // No URL: check by title to avoid duplicates, then insert if not found
          const existing = await client.query(
            `SELECT id FROM saved_articles WHERE user_id = $1 AND url IS NULL AND title = $2 LIMIT 1`,
            [req.session.userId, article.title]
          );
          if (existing.rows[0]) {
            savedArticleId = existing.rows[0].id;
          } else {
            const insertResult = await client.query(
              `INSERT INTO saved_articles (user_id, title, url, source, source_icon, topic, excerpt, content, published_at)
               VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8)
               RETURNING id`,
              [
                req.session.userId, article.title,
                article.source, article.sourceIcon || null, article.topic,
                article.excerpt, article.markdownContent || article.content || article.excerpt,
                article.publishedAt || null
              ]
            );
            savedArticleId = insertResult.rows[0]?.id ?? null;
          }
        }

        for (const card of newCards) {
          await client.query(
            `INSERT INTO saved_cards (id, user_id, type, content, tags, article_title, article_id, origin, saved_article_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [card.id, req.session.userId, card.type, card.content, JSON.stringify(card.tags),
             card.articleTitle, card.articleId || null, origin, savedArticleId || null]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // Also update saved flag in user_articles if this is a user article
    if (isUserArticle) {
      await pool.query(
        'UPDATE user_articles SET saved = TRUE WHERE id = $1 AND user_id = $2',
        [articleId, req.session.userId]
      );
    }

    res.json({ success: true, article });
  }));

  // Fetch full content for an article
  app.get("/api/articles/:id/full", asyncHandler(async (req, res) => {
    const articleId = parseInt(req.params.id);
    let article: Article | undefined = articles.find(a => a.id === articleId);

    // If not in global store, check user_articles DB
    if (!article && req.session.userId) {
      const row = (await pool.query(
        `SELECT id, source, source_icon, topic, title, excerpt, content, url,
                audio_url, audio_duration, published_at, time_str, saved,
                full_fetched, markdown_content
         FROM user_articles WHERE id = $1 AND user_id = $2`,
        [articleId, req.session.userId]
      )).rows[0];
      if (row) {
        article = {
          id: Number(row.id), saved: row.saved, source: row.source,
          sourceIcon: row.source_icon ?? undefined, topic: row.topic,
          time: row.time_str, publishedAt: row.published_at ? Number(row.published_at) : undefined,
          title: row.title, excerpt: row.excerpt, content: row.content,
          markdownContent: row.markdown_content ?? undefined, url: row.url ?? undefined,
          audioUrl: row.audio_url ?? undefined, audioDuration: row.audio_duration ?? undefined,
          fullFetched: row.full_fetched, cards: []
        } as Article;
      }
    }

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
      logger.error({ err: error, module: "articles", articleId }, "Failed to process article content");
      article.markdownContent = article.content || article.excerpt || '暂无内容';
      article.readabilityUsed = false;
      article.fullFetched = true;
      return res.json({ success: true, article });
    }
  }));

  // Image proxy to bypass CSP and hotlink protection
  app.get("/api/image-proxy", asyncHandler(async (req, res) => {
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
      logger.error({ err: error, module: "image-proxy", imageUrl }, "Image proxy error");
      res.status(500).send("Failed to load image");
    }
  }));

  // Get user's custom subscriptions (for cross-device restore)
  app.get("/api/subscriptions", requireAuth, asyncHandler(async (req, res) => {
    const rows = (await pool.query(
      `SELECT id, name, rss_url AS "rssUrl", color, icon, topic, created_at AS "createdAt"
       FROM user_subscriptions WHERE user_id = $1 ORDER BY created_at ASC`,
      [req.session.userId]
    )).rows;
    return res.json(rows);
  }));

  // Get all saved cards
  app.get("/api/cards", requireAuth, asyncHandler(async (req, res) => {
    const rows = (await pool.query(
      `SELECT id, type, content, tags, article_title AS "articleTitle", article_id AS "articleId",
              origin, saved_article_id AS "savedArticleId"
       FROM saved_cards WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.session.userId]
    )).rows;
    res.json(rows);
  }));

  // Add a new manual card
  app.post("/api/cards", requireAuth, asyncHandler(async (req, res) => {
    const newCard: AtomCard = {
      ...req.body,
      id: Math.random().toString(36).substr(2, 9),
      articleTitle: req.body.articleTitle || "手动录入"
    };
    if (!VALID_CARD_TYPES.has(newCard.type)) {
      return res.status(400).json({ error: '无效的卡片类型' });
    }
    await pool.query(
      'INSERT INTO saved_cards (id, user_id, type, content, tags, article_title, article_id, origin, saved_article_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [newCard.id, req.session.userId, newCard.type, newCard.content, JSON.stringify(newCard.tags), newCard.articleTitle, newCard.articleId || null, req.body.origin || 'manual', req.body.savedArticleId || null]
    );
    res.json(newCard);
  }));

  // Update a card (single atomic UPDATE)
  app.put("/api/cards/:id", requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { type, content, tags } = req.body;

    const row = (await pool.query(
      `UPDATE saved_cards SET
        type = COALESCE($1, type),
        content = COALESCE($2, content),
        tags = COALESCE($3, tags)
      WHERE id = $4 AND user_id = $5
      RETURNING id, type, content, tags, article_title AS "articleTitle", article_id AS "articleId"`,
      [type ?? null, content ?? null, tags ? JSON.stringify(tags) : null, id, req.session.userId]
    )).rows[0];
    if (!row) return res.status(404).json({ error: "Card not found" });
    res.json(row);
  }));

  // Delete a card
  app.delete("/api/cards/:id", requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM saved_cards WHERE id = $1 AND user_id = $2', [id, req.session.userId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Card not found" });
    }
    res.json({ success: true });
  }));

  // --- Saved Articles (persisted originals) ---

  // List all saved articles (without full content to reduce payload)
  app.get("/api/saved-articles", requireAuth, asyncHandler(async (req, res) => {
    const rows = (await pool.query(
      `SELECT id, title, url, source, source_icon AS "sourceIcon", topic, excerpt,
              published_at AS "publishedAt", saved_at AS "savedAt"
       FROM saved_articles WHERE user_id = $1 ORDER BY saved_at DESC`,
      [req.session.userId]
    )).rows;
    res.json(rows);
  }));

  // Get a single saved article (with full content)
  app.get("/api/saved-articles/:id", requireAuth, asyncHandler(async (req, res) => {
    const row = (await pool.query(
      `SELECT id, title, url, source, source_icon AS "sourceIcon", topic, excerpt, content,
              published_at AS "publishedAt", saved_at AS "savedAt"
       FROM saved_articles WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.userId]
    )).rows[0];
    if (!row) return res.status(404).json({ error: "Saved article not found" });
    res.json(row);
  }));

  // Translate article content (Baidu Translate API)
  // Supports both single string (content) and array of strings (segments) for paragraph-level translation
  app.post("/api/translate", requireAuth, asyncHandler(async (req, res) => {
    const { content, segments, targetLang = 'zh' } = req.body;

    const appid = process.env.BAIDU_TRANSLATE_APPID;
    const key = process.env.BAIDU_TRANSLATE_KEY;

    if (!appid || !key) {
      return res.status(500).json({ error: "Translation service not configured" });
    }

    const toLang = targetLang === 'zh-CN' ? 'zh' : targetLang;
    const crypto = await import('crypto');

    // Strip HTML and Markdown, returning plain text only
    const HTML_TAGS_RE = '(?:p|div|span|li|ul|ol|br|hr|h[1-6]|em|strong|code|pre|blockquote|details|summary|figure|video|iframe|script|style|a|img|table|t[rdh]|thead|tbody|tfoot|section|article|header|footer|nav|aside|main)';
    const stripMarkdown = (md: string): string => {
      return md
        .replace(/<!--[\s\S]*?-->/g, '')           // HTML comments
        .replace(/<(script|style|iframe|figure|video|details|summary)[^>]*>[\s\S]*?<\/\1>/gi, '')  // block elements with content
        .replace(/<[^>]*>/g, ' ')                  // remaining HTML tags (including CJK tag names like <详情>)
        .replace(/&[a-zA-Z#\d]+;/g, ' ')          // HTML entities (&nbsp; &hellip; &amp; &rsquo; etc.)
        // Bare tag remnants: "。p" "！p" ".p" at end of line, or "p" alone on a line
        .replace(new RegExp(`(?<=[。！？.!?\\s])\\/?${HTML_TAGS_RE}\\s*$`, 'gmi'), '')
        .replace(new RegExp(`^\\/?${HTML_TAGS_RE}\\s*$`, 'gmi'), '')
        .replace(/!\[.*?\]\(.*?\)/g, '')           // MD images
        .replace(/\[([^\]]*)\]\(.*?\)/g, '$1')    // MD links → label only
        .replace(/```[\s\S]*?```/g, '')            // fenced code blocks
        .replace(/`[^`]*`/g, '')                   // inline code
        .replace(/^#{1,6}\s+/gm, '')               // headings
        .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, '$2') // bold / italic
        .replace(/~~(.*?)~~/g, '$1')               // strikethrough
        .replace(/^\s*[-*+>]\s+/gm, '')            // list bullets / blockquotes
        .replace(/^\s*\d+\.\s+/gm, '')             // ordered list numbers
        .replace(/\|/g, ' ')                       // table pipes
        .replace(/\[[\d]+\]/g, '')                 // footnote refs
        .replace(/[ \t]{2,}/g, ' ')               // collapse spaces
        .replace(/\n[ \t]*\n/g, '\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    };

    // Helper: call Baidu API for a single text
    const baiduTranslate = async (text: string): Promise<string> => {
      const salt = Date.now().toString() + Math.random();
      const sign = crypto.createHash('md5').update(appid + text + salt + key).digest('hex');
      const params = new URLSearchParams({ q: text, from: 'auto', to: toLang, appid, salt, sign });
      const response = await fetch(`https://fanyi-api.baidu.com/api/trans/vip/translate?${params}`);
      const data = await response.json() as any;
      if (data.error_code) throw new Error(`百度翻译错误 ${data.error_code}: ${data.error_msg}`);
      return (data.trans_result as Array<{ dst: string }>).map(r => r.dst).join('\n');
    };

    // Clean artifacts that Baidu introduces in translated output
    const cleanTranslation = (t: string): string => {
      return t
        // Remove stray ；between Chinese words (from apostrophes like we're → 我们；重新)
        .replace(/(?<=[\u4e00-\u9fa5\w])；(?=[\u4e00-\u9fa5\w])/g, '')
        // Remove leftover HTML/Markdown that Baidu left untouched
        .replace(/<[^>]{0,60}>/g, '')
        .replace(/&[a-zA-Z#\d]+;/g, '')
        // Remove bare URLs in parentheses: （https://...） or (https://...)
        .replace(/[（(]\s*https?:\/\/[^\s）)]+\s*[）)]/g, '')
        // Remove standalone URLs
        .replace(/https?:\/\/\S+/g, '')
        // Remove leftover markdown link syntax残留
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // Remove lines that are purely punctuation/symbols with no CJK or Latin content
        .replace(/^[^\u4e00-\u9fa5a-zA-Z0-9]+$/gm, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    };

    try {
      // Segment mode: translate in parallel batches of 5
      if (Array.isArray(segments) && segments.length > 0) {
        const results: string[] = new Array(segments.length).fill('');
        const BATCH = 5;
        for (let i = 0; i < segments.length; i += BATCH) {
          const batch = segments.slice(i, i + BATCH) as string[];
          const batchResults = await Promise.all(batch.map(async (seg) => {
            if (!seg.trim()) return '';
            const plain = stripMarkdown(seg);
            if (!plain) return '';
            const encoded = encodeURIComponent(plain);
            const text = encoded.length > 5000 ? plain.slice(0, 1000) : plain;
            const translated = await baiduTranslate(text);
            return cleanTranslation(translated);
          }));
          batchResults.forEach((r, j) => { results[i + j] = r; });
        }
        return res.json({ success: true, segments: results });
      }

      // Single content mode
      if (!content) return res.status(400).json({ error: "Content is required" });
      const translatedText = cleanTranslation(await baiduTranslate(content));
      res.json({ success: true, translatedContent: translatedText });
    } catch (error: any) {
      logger.error({ err: error, module: "translate" }, "Translation error");
      res.status(500).json({ error: "Translation failed", details: error?.message });
    }
  }));

  // --- Writing: keyword recall ---
  app.post("/api/write/recall", requireAuth, asyncHandler(async (req, res) => {
    const { topic } = req.body;
    if (!topic || typeof topic !== 'string') return res.status(400).json({ error: "topic is required" });

    // Get user's saved cards
    const cardRows = (await pool.query(
      `SELECT id, type, content, tags, article_title AS "articleTitle", article_id AS "articleId"
       FROM saved_cards WHERE user_id = $1`,
      [req.session.userId]
    )).rows.map(r => ({ ...r, tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags }));

    if (cardRows.length === 0) return res.json({ cards: [] });

    const keywords = topic.split(/[\s,、]+/).filter(Boolean);
    const matched = cardRows.filter(c => {
      const text = `${c.content} ${(c.tags || []).join(' ')} ${c.articleTitle || ''}`.toLowerCase();
      return keywords.some((k: string) => text.includes(k.toLowerCase()));
    });

    res.json({ cards: matched.length >= 2 ? matched : cardRows.slice(0, 10) });
  }));

  app.get("/api/write/agent/threads", requireAuth, asyncHandler(async (req, res) => {
    const rows = (await pool.query(
      `SELECT id, title, summary, state, created_at, updated_at
       FROM write_agent_threads
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 30`,
      [req.session.userId]
    )).rows;
    res.json(rows);
  }));

  app.post("/api/write/agent/threads", requireAuth, asyncHandler(async (req, res) => {
    const { title } = req.body || {};
    const row = (await pool.query(
      `INSERT INTO write_agent_threads (user_id, title)
       VALUES ($1, $2)
       RETURNING id, title, summary, state, created_at, updated_at`,
      [req.session.userId, typeof title === 'string' && title.trim() ? title.trim() : '新的写作会话']
    )).rows[0];
    res.json(row);
  }));

  app.get("/api/write/agent/threads/:id/messages", requireAuth, asyncHandler(async (req, res) => {
    const thread = (await pool.query(
      `SELECT id, title, summary, state, created_at, updated_at
       FROM write_agent_threads
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.userId]
    )).rows[0];
    if (!thread) return res.status(404).json({ error: 'thread not found' });
    const messages = await getRecentThreadMessages(pool, Number(req.params.id), 60);
    res.json({ thread, messages });
  }));

  app.post("/api/write/agent/chat", requireAuth, asyncHandler(async (req, res) => {
    const { threadId, message, focusedTopic, activatedNodeIds, activationSummary, action } = req.body || {};
    const isCreateArticle = action === 'create_article';
    if (!isCreateArticle && (!message || typeof message !== 'string' || !message.trim())) {
      return res.status(400).json({ error: 'message is required' });
    }
    const normalizedMessage = isCreateArticle
      ? (typeof message === 'string' && message.trim() ? message.trim() : '请根据当前对话和激活网络创建一篇文章')
      : message.trim();

    let thread = threadId
      ? (await pool.query(
        `SELECT id, title, summary, state, created_at, updated_at
         FROM write_agent_threads
         WHERE id = $1 AND user_id = $2`,
        [threadId, req.session.userId]
      )).rows[0]
      : null;

    if (!thread) {
      thread = (await pool.query(
        `INSERT INTO write_agent_threads (user_id, title, state)
         VALUES ($1, $2, $3)
         RETURNING id, title, summary, state, created_at, updated_at`,
        [req.session.userId, inferThreadTitle(normalizedMessage), JSON.stringify({})]
      )).rows[0];
    }

    const normalizedThreadId = Number(thread.id);
    const userState: WriteAgentState = {
      focusedTopic: typeof focusedTopic === 'string' ? focusedTopic : undefined,
      activatedNodeIds: Array.isArray(activatedNodeIds) ? activatedNodeIds.filter((id): id is string => typeof id === 'string') : undefined,
      activationSummary: Array.isArray(activationSummary) ? activationSummary.filter((item): item is string => typeof item === 'string') : undefined
    };

    await pool.query(
      `INSERT INTO write_agent_messages (thread_id, role, content, meta)
       VALUES ($1, 'user', $2, $3)`,
      [normalizedThreadId, normalizedMessage, JSON.stringify({ state: userState, action: isCreateArticle ? 'create_article' : undefined })]
    );

    const dbCards = await fetchUserSavedCards(pool, req.session.userId);

    const previousMessages = await getRecentThreadMessages(pool, normalizedThreadId, 14);
    const threadState = (thread.state || {}) as WriteAgentState;
    const mergedState: WriteAgentState = {
      focusedTopic: userState.focusedTopic || threadState.focusedTopic,
      activatedNodeIds: userState.activatedNodeIds || threadState.activatedNodeIds || [],
      activationSummary: userState.activationSummary || threadState.activationSummary || [],
      latestOutline: Array.isArray(threadState.latestOutline) ? threadState.latestOutline : [],
      latestAngle: typeof threadState.latestAngle === 'string' ? threadState.latestAngle : undefined,
      lastGeneratedNoteId: threadState.lastGeneratedNoteId,
      lastGeneratedNoteTitle: typeof threadState.lastGeneratedNoteTitle === 'string' ? threadState.lastGeneratedNoteTitle : undefined
    };

    const activeCardRows = toolGetActiveNetwork(dbCards, mergedState.activatedNodeIds || []);
    const intentPrompt = `你是 AtomFlow 写作助手的路由器。请判断用户这句最新输入最需要哪些工具。

可选工具：
- recall_cards：当用户在找主题、补素材、想激活节点时
- get_active_network：当用户在问当前网络、当前节点、围绕当前激活内容展开时
- list_recent_notes：当用户提到最近文章、之前草稿、继续改写时
- generate_outline：当用户要提纲、结构、章节安排时
- generate_draft：当用户明确要生成、写正文、出草稿时
- just_chat：当用户只是在对话、讨论、闲聊、提问、思考方向时，不需要任何工具

严格输出 JSON：
{
  "tools": ["tool_a", "tool_b"],
  "reason": "一句简短理由"
}

注意：大部分日常对话应该返回 ["just_chat"]，只有明确涉及上述操作才使用对应工具。`;

    const apiKey = process.env.AI_API_KEY;
    const baseUrl = process.env.AI_BASE_URL;
    const model = process.env.AI_MODEL;
    if (!apiKey || !baseUrl || !model) {
      return res.status(500).json({ error: 'AI service not configured' });
    }

    const requestChat = async (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, temperature: number, maxTokens: number) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature
        })
      });
      if (!response.ok) {
        const errorText = await response.text();
        logger.error({
          module: "ai",
          status: response.status,
          responseBody: errorText.slice(0, 1000),
        }, "AI chat request failed");
        throw new Error(`chat failed ${response.status}: ${errorText}`);
      }
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return (data.choices?.[0]?.message?.content || '').trim();
    };

    let rawIntent = '';
    let parsedIntent: { tools?: string[]; reason?: string } | null = null;
    let requestedTools: string[] = [];

    if (isCreateArticle) {
      requestedTools = ['recall_cards', 'generate_outline', 'generate_draft'];
      parsedIntent = { tools: requestedTools, reason: 'user explicitly requested create_article' };
    } else {
      rawIntent = await requestChat([
        { role: 'system', content: intentPrompt },
        { role: 'user', content: `当前状态：topic=${mergedState.focusedTopic || '无'}; activeNodes=${(mergedState.activatedNodeIds || []).length}; latestMessage=${normalizedMessage}` }
      ], 0.1, 300);
      parsedIntent = safeJsonParse<{ tools?: string[]; reason?: string }>(rawIntent);
      requestedTools = Array.isArray(parsedIntent?.tools)
        ? parsedIntent!.tools.filter(tool => ['recall_cards', 'get_active_network', 'list_recent_notes', 'generate_outline', 'generate_draft', 'just_chat'].includes(tool))
        : [];
      // If just_chat or no real tools, clear the tool list so we skip all tool pipelines
      if (requestedTools.length === 0 || (requestedTools.length === 1 && requestedTools[0] === 'just_chat')) {
        requestedTools = [];
      }
    }

    const recalledCards = requestedTools.includes('recall_cards')
      ? toolRecallCards(`${normalizedMessage} ${mergedState.focusedTopic || ''}`, dbCards, activeCardRows.map(card => card.id))
      : [];

    const recentNotes = requestedTools.includes('list_recent_notes') || requestedTools.includes('generate_draft')
      ? await toolListRecentNotes(pool, req.session.userId, 4)
      : [];

    const systemPrompt = `你是 AtomFlow 的写作助手 Agent。你不是普通闲聊助手，而是帮助用户围绕知识库、激活网络和文章草稿持续推进写作。

你的行为规则：
1. 先结合线程上下文、当前状态、激活网络，再回答。
2. 如果用户在讨论写作方向、提纲、段落、改写，优先围绕写作任务推进，不跑题。
3. 回答要短、具体、可执行，不说空话。
4. 如果当前激活网络不足以支撑结论，要明确指出还缺什么。
5. 你可以引用”当前激活节点””补充召回节点””最近文章草稿”，但不要伪造来源。
6. 如果工具结果里已经包含提纲或草稿，就优先基于它们回答。
7. 除非用户明确要求长文，否则默认回答简洁。
8. 当引用知识节点时，用「来自《文章标题》」或节点编号标注来源，不要笼统地说”根据资料”。
9. 如果已生成文章草稿，在回复中简要说明引用了哪些节点和原文。`;

    let generatedOutlineText = '';
    let generatedDraftText = '';
    let generatedPlan: WritingPlanResult | null = null;
    let persistedDraftNote: any = null;
    const shouldGenerateDraft = isCreateArticle || requestedTools.includes('generate_draft');
    const shouldGenerateOutline = isCreateArticle || requestedTools.includes('generate_outline') || shouldGenerateDraft;
    if (shouldGenerateOutline) {
      const cardsForWriting = sanitizeWritingCards(activeCardRows.length > 0 ? activeCardRows : recalledCards);
      if (cardsForWriting.length > 0) {
        const topicForWriting = mergedState.focusedTopic || normalizedMessage;
        const planRaw = await requestChat([
          { role: 'system', content: WRITING_PLAN_SYSTEM_PROMPT },
          { role: 'user', content: buildWritingPlanPrompt(topicForWriting, cardsForWriting, sanitizeWritingCards(recalledCards)) }
        ], 0.25, 1200);
        generatedPlan = sanitizeWritingPlan(safeJsonParse<WritingPlanResult>(planRaw), topicForWriting);
        generatedOutlineText = generatedPlan.outline.map(item => `- ${item.heading}：${item.goal}`).join('\n');

        if (shouldGenerateDraft) {
          generatedDraftText = await requestChat([
            { role: 'system', content: WRITING_AGENT_SYSTEM_PROMPT },
            { role: 'user', content: buildDraftPrompt(topicForWriting, generatedPlan, cardsForWriting, sanitizeWritingCards(recalledCards)) }
          ], 0.68, 2200);

          if (generatedDraftText.trim()) {
            const activationSummaryForNote = (mergedState.activationSummary || []).length > 0
              ? (mergedState.activationSummary || [])
              : cardsForWriting.slice(0, 5).map(card => `${card.type} · ${card.content.slice(0, 20)}`);
            const evidenceMap = buildEvidenceMap(generatedPlan, cardsForWriting);
            const sourceArticles = buildSourceArticlesFromCards(cardsForWriting, dbCards);
            persistedDraftNote = await createAgentDraftNote(pool, req.session.userId, {
              title: generatedPlan.title,
              content: generatedDraftText.trim(),
              topic: topicForWriting,
              style: generatedPlan.style,
              outline: generatedPlan.outline,
              evidenceMap,
              activeCards: cardsForWriting,
              activationSummary: activationSummaryForNote,
              sourceArticles
            });
          }
        }
      } else if (isCreateArticle) {
        return res.status(400).json({ error: '知识库中没有可用的卡片，请先收藏一些文章并提取知识卡片' });
      }
    }

    const toolPayload = {
      requestedTools,
      reason: parsedIntent?.reason || '',
      activeCardIds: activeCardRows.map(card => card.id),
      recalledCardIds: recalledCards.map(card => card.id),
      outline: generatedPlan?.outline || [],
      draftPreview: generatedDraftText.slice(0, 400),
      noteId: persistedDraftNote ? Number(persistedDraftNote.id) : undefined,
      noteTitle: persistedDraftNote?.title,
      noteSaved: Boolean(persistedDraftNote),
      noteTopic: mergedState.focusedTopic || normalizedMessage
    };

    if (requestedTools.length > 0) {
      await pool.query(
        `INSERT INTO write_agent_messages (thread_id, role, content, meta)
         VALUES ($1, 'tool', $2, $3)`,
        [
          normalizedThreadId,
          [
            `tools: ${requestedTools.join(', ')}`,
            generatedOutlineText ? `outline:\n${generatedOutlineText}` : '',
            generatedDraftText ? `draft:\n${generatedDraftText.slice(0, 600)}` : ''
          ].filter(Boolean).join('\n\n'),
          JSON.stringify(toolPayload)
        ]
      );
    }

    const userContextPrompt = `当前线程摘要：
${typeof thread.summary === 'string' && thread.summary.trim() ? thread.summary : '暂无摘要'}

当前状态：
- focusedTopic: ${mergedState.focusedTopic || '无'}
- activatedNodeIds: ${(mergedState.activatedNodeIds || []).join('、') || '无'}
- activationSummary: ${(mergedState.activationSummary || []).join(' | ') || '无'}

当前激活节点：
${activeCardRows.length > 0 ? activeCardRows.map((card, index) => `${index + 1}. [${card.type}] ${card.content}`).join('\n') : '无'}

补充召回节点：
${recalledCards.length > 0 ? recalledCards.map((card, index) => `${index + 1}. [${card.type}] ${card.content}`).join('\n') : '无'}

最近文章草稿：
${recentNotes.length > 0 ? recentNotes.map((note, index) => `${index + 1}. ${note.title}\n${normalizePlainText(note.content).slice(0, 180)}`).join('\n\n') : '无'}

工具路由：
- selectedTools: ${requestedTools.join('、') || '无'}
- toolReason: ${parsedIntent?.reason || '无'}

提纲工具结果：
${generatedOutlineText || '无'}

正文工具结果：
${generatedDraftText ? generatedDraftText.slice(0, 1200) : '无'}

用户最新消息：
${normalizedMessage}`;

    const assistantContent = await requestChat([
      { role: 'system', content: systemPrompt },
      ...previousMessages
        .filter((item): item is typeof item & { role: 'user' | 'assistant' } => item.role === 'user' || item.role === 'assistant')
        .map(item => ({ role: item.role, content: item.content }))
        .slice(-10),
      { role: 'user', content: userContextPrompt }
    ], 0.55, 1200);
    if (!assistantContent) {
      return res.status(500).json({ error: 'agent returned empty message' });
    }

    await pool.query(
      `INSERT INTO write_agent_messages (thread_id, role, content, meta)
       VALUES ($1, 'assistant', $2, $3)`,
      [normalizedThreadId, assistantContent, JSON.stringify(toolPayload)]
    );

    const nextState: WriteAgentState = {
      ...mergedState,
      latestOutline: generatedPlan?.outline || mergedState.latestOutline || [],
      latestAngle: generatedPlan?.angle || mergedState.latestAngle,
      lastGeneratedNoteId: persistedDraftNote ? Number(persistedDraftNote.id) : mergedState.lastGeneratedNoteId,
      lastGeneratedNoteTitle: persistedDraftNote?.title || mergedState.lastGeneratedNoteTitle
    };

    const finalMessages = await getRecentThreadMessages(pool, normalizedThreadId, 14);
    const summary = summarizeAgentMessages(finalMessages.map(item => ({ role: item.role, content: item.content })));
    await upsertThreadState(pool, normalizedThreadId, summary, nextState, thread.title || inferThreadTitle(normalizedMessage));

    res.json({
      threadId: normalizedThreadId,
      threadState: nextState,
      assistant: {
        role: 'assistant',
        content: assistantContent
      },
      toolResult: toolPayload,
      note: persistedDraftNote
        ? {
          id: Number(persistedDraftNote.id),
          title: persistedDraftNote.title,
          created_at: persistedDraftNote.created_at,
          updated_at: persistedDraftNote.updated_at
        }
        : null,
      context: {
        activeCards: activeCardRows.length,
        recalledCards: recalledCards.length
      }
    });
  }));

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

  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    logger.error({
      err,
      module: "express",
      method: req.method,
      path: req.path,
      requestId: req.id,
    }, "Unhandled Express error");
    res.status(500).json({ error: "Internal server error" });
  });

  const httpServer = createServer(app);

  // ── Volcengine ASR WebSocket Proxy ──────────────────────────
  const ASR_APPID = process.env.VOLCENGINE_ASR_APPID || "";
  const ASR_TOKEN = process.env.VOLCENGINE_ASR_TOKEN || "";
  const ASR_CLUSTER = process.env.VOLCENGINE_ASR_CLUSTER || "volcengine_streaming_common";
  const ASR_WS_URL = "wss://openspeech.bytedance.com/api/v2/asr";

  function buildAsrHeader(messageType: number, flags: number, serialization: number, compression: number): Buffer {
    const header = Buffer.alloc(4);
    header[0] = (0x01 << 4) | 0x01; // version 1, header size 1
    header[1] = (messageType << 4) | flags;
    header[2] = (serialization << 4) | compression;
    header[3] = 0x00;
    return header;
  }

  function buildFullClientRequest(reqid: string): Buffer {
    const payload = JSON.stringify({
      app: { appid: ASR_APPID, cluster: ASR_CLUSTER, token: ASR_TOKEN },
      user: { uid: "atomflow-user" },
      audio: { format: "raw", codec: "raw", rate: 16000, bits: 16, channel: 1, language: "zh-CN" },
      request: {
        reqid,
        nbest: 1,
        workflow: "audio_in,resample,partition,vad,fe,decode,itn,nlu_punctuate",
        show_utterances: true,
        result_type: "single",
        sequence: 1,
      },
    });
    const compressed = gzipSync(Buffer.from(payload, "utf-8"));
    const header = buildAsrHeader(0x01, 0x00, 0x01, 0x01); // full client request, JSON, gzip
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32BE(compressed.length);
    return Buffer.concat([header, sizeBuf, compressed]);
  }

  function buildAudioRequest(audioData: Buffer, isLast: boolean): Buffer {
    const compressed = gzipSync(audioData);
    const header = buildAsrHeader(0x02, isLast ? 0x02 : 0x00, 0x00, 0x01); // audio only, no serialization, gzip
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32BE(compressed.length);
    return Buffer.concat([header, sizeBuf, compressed]);
  }

  function parseAsrResponse(data: Buffer): { code?: number; text?: string; utterances?: Array<{ text: string; definite: boolean }> } | null {
    if (data.length < 4) return null;
    const messageType = data[1] >> 4;
    const compression = data[2] & 0x0f;
    const headerSize = (data[0] & 0x0f) * 4;

    if (messageType === 0x0f) {
      // Error response
      const code = data.readUInt32BE(headerSize);
      const msgSize = data.readUInt32BE(headerSize + 4);
      const msg = data.subarray(headerSize + 8, headerSize + 8 + msgSize).toString("utf-8");
      logger.error({ module: "asr", code, upstreamMessage: msg }, "ASR upstream returned error response");
      return { code };
    }

    if (messageType === 0x09) {
      // Full server response
      const payloadSize = data.readUInt32BE(headerSize);
      let payload = data.subarray(headerSize + 4, headerSize + 4 + payloadSize);
      if (compression === 0x01) {
        payload = gunzipSync(payload);
      }
      const json = JSON.parse(payload.toString("utf-8"));
      const result: { code?: number; text?: string; utterances?: Array<{ text: string; definite: boolean }> } = { code: json.code };
      if (json.result && json.result.length > 0) {
        result.text = json.result[0].text || "";
        if (json.result[0].utterances) {
          result.utterances = json.result[0].utterances;
        }
      }
      return result;
    }

    return null;
  }

  const wss = new WebSocketServer({ server: httpServer, path: "/api/asr" });

  wss.on("connection", (clientWs) => {
    if (!ASR_APPID || !ASR_TOKEN) {
      clientWs.send(JSON.stringify({ error: "ASR credentials not configured" }));
      clientWs.close();
      return;
    }

    const reqid = randomUUID();
    let upstreamWs: WsWebSocket | null = null;
    let upstreamReady = false;
    const pendingAudio: Buffer[] = [];

    const upstream = new WsWebSocket(ASR_WS_URL, {
      headers: { Authorization: `Bearer; ${ASR_TOKEN}` },
    });

    upstream.on("open", () => {
      upstreamWs = upstream;
      // Send full client request
      upstream.send(buildFullClientRequest(reqid));
    });

    upstream.on("message", (rawData) => {
      const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData as ArrayBuffer);
      const parsed = parseAsrResponse(data);
      if (!parsed) return;

      if (parsed.code === 1000) {
        if (!upstreamReady) {
          upstreamReady = true;
          // Flush pending audio
          for (const chunk of pendingAudio) {
            upstream.send(buildAudioRequest(chunk, false));
          }
          pendingAudio.length = 0;
        }
        // Send transcript to client
        if (parsed.text !== undefined) {
          clientWs.send(JSON.stringify({ text: parsed.text, utterances: parsed.utterances }));
        }
      } else {
        clientWs.send(JSON.stringify({ error: `ASR error code: ${parsed.code}` }));
      }
    });

    upstream.on("error", (err) => {
      logger.error({ err, module: "asr" }, "ASR upstream error");
      clientWs.send(JSON.stringify({ error: "ASR connection error" }));
    });

    upstream.on("close", () => {
      upstreamWs = null;
      upstreamReady = false;
    });

    clientWs.on("message", (rawData) => {
      const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData as ArrayBuffer);

      // Check if it's a text control message
      if (typeof rawData === "string") {
        try {
          const msg = JSON.parse(rawData);
          if (msg.type === "stop") {
            // Send last audio packet (empty)
            if (upstreamWs && upstreamWs.readyState === WsWebSocket.OPEN) {
              upstreamWs.send(buildAudioRequest(Buffer.alloc(0), true));
            }
            return;
          }
        } catch { /* not JSON, treat as binary */ }
      }

      // Binary audio data
      if (upstreamReady && upstreamWs && upstreamWs.readyState === WsWebSocket.OPEN) {
        upstreamWs.send(buildAudioRequest(data, false));
      } else {
        pendingAudio.push(data);
      }
    });

    clientWs.on("close", () => {
      if (upstreamWs && upstreamWs.readyState === WsWebSocket.OPEN) {
        try {
          upstreamWs.send(buildAudioRequest(Buffer.alloc(0), true));
        } catch { /* ignore */ }
        upstreamWs.close();
      }
    });
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    logger.info({ module: "server", port: PORT }, `Server running on http://localhost:${PORT}`);
  });
}

startServer();
