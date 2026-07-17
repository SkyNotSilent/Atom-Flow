import express from "express";
import compression from "compression";
import helmet from "helmet";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import { AtomCard, Article, User } from "./src/types.js";
import multer from "multer";
import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { promises as fs } from "fs";
import { marked } from "marked";
import path from "path";
import dotenv from "dotenv";
import pg from "pg";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import { Resend } from "resend";
import nodemailer from "nodemailer";
import sharp from "sharp";
import { createServer, ServerResponse, type IncomingMessage } from "http";
import { Worker } from "node:worker_threads";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { gzipSync, gunzipSync } from "zlib";
import { randomUUID, createHash, createHmac, randomInt } from "crypto";
import { URL } from "url";
import pino from "pino";
import pinoHttp from "pino-http";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { Agent, OpenAIProvider, Runner, setTracingDisabled, tool } from "@openai/agents";
import { z } from "zod";
import {
  classifyWriteAgentIntent,
  mergeWriteAgentModelRouterResult,
  type WriteAgentIntentClassification,
} from "./src/utils/writeAgentIntent.js";
import {
  ConcurrencyLimitError,
  ResponseLimitError,
  buildAllowedOrigins,
  createUserConcurrencyGuard,
  fetchBoundedPublicResource,
  isAllowedMutationOrigin,
  isAllowedUploadSignature,
  readBoundedEnvNumber,
  readResponseBuffer,
  validateDocxArchiveBounds,
  validatePublicHttpUrl,
} from "./src/server/security.js";
import {
  BUILTIN_RSS_FEEDS,
  collectSettledFeedArticles,
  createSerializedTaskQueue,
  mergeArticleSourceMemberships,
  mergeWithSourceFallback,
  normalizeArticleUrl,
  sanitizeGlobalArticleCache,
  stableArticleId,
} from "./src/server/rss.js";
import {
  buildFeedExcerpt,
  buildContentSecurityDirectives,
  contentToPlainText,
  contentToPlainTextWithinBudget,
  createPlainTextBudget,
  normalizeEmailAddress,
  normalizeTextExcerpt,
  sanitizeRichHtml,
  stripBareHtmlTagRemnants,
  type PlainTextBudget,
  urlMatchesHostname,
} from "./src/server/contentSecurity.js";

dotenv.config();

const isProduction = process.env.NODE_ENV === "production";
const DEV_SESSION_SECRET = "atomflow-dev-secret-change-in-prod";
const PUBLIC_WEB_PORTS = new Set(["", "80", "443"]);
const PLAIN_TEXT_NORMALIZATION_MAX_SOURCE_CHARS = 250_000;
const RSS_FEED_EXCERPT_SOURCE_BUDGET_CHARS = 64_000;
const LEGAL_PLACEHOLDER_PATTERN = /\[(?:DEPLOYMENT_OPERATOR_NAME|DEPLOYMENT_OPERATOR_ADDRESS|SERVICE_CONTACT_EMAIL|PRIVACY_CONTACT_EMAIL|SECURITY_CONTACT_EMAIL|SERVICE_URL|DATA_HOSTING_REGION|TERMS_EFFECTIVE_DATE|GOVERNING_LAW|DISPUTE_FORUM|LOG_RETENTION_DAYS|BACKUP_RETENTION_DAYS|RIGHTS_REQUEST_RESPONSE_DAYS)\]/g;
const LEGAL_DOCUMENTS = {
  privacy: "PRIVACY.md",
  terms: "TERMS.md",
  security: "SECURITY.md",
} as const;

const legalReplacementValues = (appUrl?: string) => ({
  DEPLOYMENT_OPERATOR_NAME: process.env.DEPLOYMENT_OPERATOR_NAME || "",
  DEPLOYMENT_OPERATOR_ADDRESS: process.env.DEPLOYMENT_OPERATOR_ADDRESS || "",
  SERVICE_CONTACT_EMAIL: process.env.SERVICE_CONTACT_EMAIL || "",
  PRIVACY_CONTACT_EMAIL: process.env.PRIVACY_CONTACT_EMAIL || "",
  SECURITY_CONTACT_EMAIL: process.env.SECURITY_CONTACT_EMAIL || "",
  SERVICE_URL: process.env.SERVICE_URL || appUrl || "",
  DATA_HOSTING_REGION: process.env.DATA_HOSTING_REGION || "",
  TERMS_EFFECTIVE_DATE: process.env.TERMS_EFFECTIVE_DATE || "",
  GOVERNING_LAW: process.env.GOVERNING_LAW || "",
  DISPUTE_FORUM: process.env.DISPUTE_FORUM || "",
  LOG_RETENTION_DAYS: process.env.LOG_RETENTION_DAYS || "",
  BACKUP_RETENTION_DAYS: process.env.BACKUP_RETENTION_DAYS || "",
  RIGHTS_REQUEST_RESPONSE_DAYS: process.env.RIGHTS_REQUEST_RESPONSE_DAYS || "",
});

const validateProductionLegalConfiguration = (appUrl?: string) => {
  if (!isProduction) return;
  const missing = Object.entries(legalReplacementValues(appUrl))
    .filter(([, value]) => !value || /\[|replace-|your-domain\.example|^your\b|^applicable\b|railway deployment/i.test(value))
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Production legal configuration is incomplete: ${missing.join(", ")}`);
  }
};

const renderLegalDocument = async (document: keyof typeof LEGAL_DOCUMENTS, appUrl?: string) => {
  const source = await fs.readFile(path.join(process.cwd(), LEGAL_DOCUMENTS[document]), "utf8");
  const values = legalReplacementValues(appUrl);
  const rendered = source.replace(LEGAL_PLACEHOLDER_PATTERN, placeholder => {
    const key = placeholder.slice(1, -1) as keyof typeof values;
    return values[key] || placeholder;
  });
  if (isProduction && LEGAL_PLACEHOLDER_PATTERN.test(rendered)) {
    LEGAL_PLACEHOLDER_PATTERN.lastIndex = 0;
    throw new Error(`Legal document ${document} contains unresolved deployment placeholders`);
  }
  LEGAL_PLACEHOLDER_PATTERN.lastIndex = 0;
  return rendered;
};
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
      "req.url",
      "req.query",
      "req.body",
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
    err: (error: unknown) => {
      const serialized = pino.stdSerializers.err(error instanceof Error ? error : new Error(String(error)));
      return {
        ...serialized,
        message: typeof serialized?.message === "string" ? sanitizeLogString(serialized.message) : serialized?.message,
        stack: typeof serialized?.stack === "string" ? sanitizeLogString(serialized.stack) : undefined,
      };
    },
  },
});

const logOtpEvent = (event: "login" | "registration", email: string, code: string) => {
  if (isProduction) {
    logger.info({ authEvent: event, emailHash: hashLogIdentifier(email) }, "Verification code generated");
  } else {
    logger.debug({ authEvent: event, email, otp: code }, "Verification code generated");
  }
};

const verificationCodeDigest = (email: string, code: string) => createHmac(
  "sha256",
  process.env.SESSION_SECRET || DEV_SESSION_SECRET,
).update(`${email}\0${code}`).digest("hex");

const hashLogIdentifier = (value: string) => createHmac(
  "sha256",
  process.env.SESSION_SECRET || DEV_SESSION_SECRET,
).update(value).digest("hex").slice(0, 16);

const sanitizeLogString = (value: string) => value
  .replace(/https?:\/\/[^\s"']+/gi, "[url]")
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
  .slice(0, 2000);

const safeRequestPath = (req: IncomingMessage) => {
  try {
    return new URL(req.url || "/", "http://atomflow.local").pathname;
  } catch {
    return "/";
  }
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
};

const sanitizeClientLogValue = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return "[truncated]";
  if (value instanceof Error) return { name: value.name, message: sanitizeLogString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeClientLogValue(item, depth + 1));
  if (!isPlainRecord(value)) {
    if (typeof value === "string") return sanitizeLogString(value);
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).slice(0, 50).map(([key, item]) => {
      const sensitiveKey = /password|token|secret|authorization|cookie|code|email|url|uri|input|content|prompt|query/i.test(key);
      return [key, sensitiveKey ? "[redacted]" : sanitizeClientLogValue(item, depth + 1)];
    })
  );
};

const shouldSkipRequestLog = (req: IncomingMessage) => {
  const pathname = safeRequestPath(req);
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
    reauthenticatedAt?: number;
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
        const parsed = await parseBoundedFeedCandidate(candidate, perCandidateTimeout);
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
        const parsed = await parseBoundedFeedCandidate(candidate, 2500);
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

async function parseBoundedFeedCandidate(candidate: string, timeoutMs: number) {
  const resource = await fetchBoundedPublicResource(candidate, {
    timeoutMs,
    maxBytes: 3 * 1024 * 1024,
    maxRedirects: 3,
    headers: {
      "User-Agent": "AtomFlow/1.0 RSS Reader",
      "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
  });
  if (resource.status < 200 || resource.status >= 300) {
    throw new Error(`RSS source returned ${resource.status}`);
  }
  return parser.parseString(resource.body.toString("utf8"));
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
  const prevByUrl = new Map(previous.flatMap(article => {
    const normalizedUrl = normalizeArticleUrl(article.url);
    return normalizedUrl ? [[normalizedUrl, article] as const] : [];
  }));
  return next.map(article => {
    const normalizedUrl = normalizeArticleUrl(article.url);
    const prev = normalizedUrl ? prevByUrl.get(normalizedUrl) : undefined;
    if (!prev) return article;
    return {
      ...article,
      id: prev.id,
      saved: prev.saved,
      cards: prev.cards,
      fullFetched: prev.fullFetched,
      markdownContent: prev.markdownContent,
      readabilityUsed: prev.readabilityUsed
    };
  });
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

const writeArticleCacheSnapshot = createSerializedTaskQueue<string>(async snapshot => {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  const temporaryPath = `${CACHE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, snapshot, "utf-8");
  await fs.rename(temporaryPath, CACHE_FILE);
});

async function saveArticlesCache(articles: Article[]) {
  await writeArticleCacheSnapshot(JSON.stringify(sanitizeGlobalArticleCache(articles)));
}

// Built-in source names — these are globally shared and never stored per-user
const BUILTIN_SOURCE_NAMES = new Set([
  '少数派', '人人都是产品经理', '36氪', '虎嗅', '数字生命卡兹克',
  '新智元', '即刻话题', 'GitHub Blog', 'Sam Altman',
  '张小珺商业访谈录', 'Lex Fridman', 'Y Combinator', 'Andrej Karpathy',
  'AI HOT 精选', 'AI HOT 全部'
]);

async function loadUserArticlesAsArticles(userId: number, pool: pg.Pool): Promise<Article[]> {
  const rows = (await pool.query(
    `SELECT id, source, source_icon, topic, title, excerpt, url,
            audio_url, audio_duration, published_at, time_str, saved
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
    content: "",
    url: row.url ?? undefined,
    audioUrl: row.audio_url ?? undefined,
    audioDuration: row.audio_duration ?? undefined,
    fullFetched: false,
    cards: []
  }));
}

const toArticleListItem = (article: Article): Article => ({
  ...article,
  content: "",
  markdownContent: undefined,
  fullFetched: false,
  cards: [],
});

async function applyUserSavedStateToArticles(userId: number, articleList: Article[], pool: pg.Pool): Promise<Article[]> {
  if (articleList.length === 0) return articleList;

  const [cardResult, savedArticleResult] = await Promise.all([
    pool.query(
      `SELECT DISTINCT article_id
       FROM saved_cards
       WHERE user_id = $1 AND article_id IS NOT NULL`,
      [userId]
    ),
    pool.query(
      `SELECT url, normalized_url, title, source
       FROM saved_articles
       WHERE user_id = $1`,
      [userId]
    )
  ]);

  const savedArticleIds = new Set(cardResult.rows.map(row => Number(row.article_id)));
  const savedUrls = new Set(
    savedArticleResult.rows
      .map(row => typeof row.normalized_url === "string"
        ? row.normalized_url
        : typeof row.url === "string" ? normalizeArticleUrl(row.url) : undefined)
      .filter((url): url is string => typeof url === "string" && url.length > 0)
  );
  const savedSourceTitles = new Set(
    savedArticleResult.rows.map(row => `${row.source || ""}\t${row.title || ""}`)
  );

  return articleList.map(article => {
    const normalizedArticleUrl = normalizeArticleUrl(article.url);
    const savedByCurrentUser = savedArticleIds.has(article.id)
      || Boolean(normalizedArticleUrl && savedUrls.has(normalizedArticleUrl))
      || (!normalizedArticleUrl && savedSourceTitles.has(`${article.source}\t${article.title}`))
      || (!BUILTIN_SOURCE_NAMES.has(article.source) && article.saved);

    return { ...article, saved: savedByCurrentUser };
  });
}

const SOURCE_PRIORITY: Record<string, number> = {
  '36氪': 5.5,
  'AI HOT 精选': 5.0,
  'AI HOT 全部': 4.9,
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

function getDefaultFeedLimit(source: string) {
  return source === '36氪' || source === '虎嗅' ? 8 : 12;
}

function normalizeFeedItems(
  items: Parser.Item[],
  source: string,
  defaultTopic: string,
  idOffset: number,
  feedIcon?: string,
  options?: { maxItems?: number | null }
) {
  const maxItems = options?.maxItems === undefined ? getDefaultFeedLimit(source) : options.maxItems;
  const normalizedItems = maxItems === null ? items : items.slice(0, maxItems);
  const excerptSourceCharsPerItem = Math.min(
    512,
    Math.max(64, Math.floor(RSS_FEED_EXCERPT_SOURCE_BUDGET_CHARS / Math.max(1, normalizedItems.length))),
  );
  return normalizedItems.map((item, index) => {
    const rawContent = item['content:encoded'] || item.content || item.contentSnippet || '';
    const excerptText = buildFeedExcerpt(
      rawContent,
      item.contentSnippet,
      item.title,
      excerptSourceCharsPerItem,
      120,
    );
    const excerpt = excerptText ? `${excerptText}...` : "";
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
      id: stableArticleId(source, item, idOffset, index),
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
  if (!rawContent.includes('热门评论')) return rawContent;
  const text = contentToPlainText(rawContent.slice(0, PLAIN_TEXT_NORMALIZATION_MAX_SOURCE_CHARS), true);

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
  return contentToPlainText((content || '').slice(0, PLAIN_TEXT_NORMALIZATION_MAX_SOURCE_CHARS), true)
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
  const sourceLimit = Math.min(Math.max(maxLength * 8, 2048), PLAIN_TEXT_NORMALIZATION_MAX_SOURCE_CHARS);
  const plain = contentToPlainText((content || '').slice(0, sourceLimit));
  if (!plain) return '';
  if (plain.length <= maxLength) return plain;
  return `${plain.slice(0, maxLength)}...`;
};

const normalizePlainText = (content: string, maxOutputChars = 12_000) => {
  const boundedOutputChars = Math.max(1, Math.min(maxOutputChars, PLAIN_TEXT_NORMALIZATION_MAX_SOURCE_CHARS));
  const sourceLimit = Math.min(
    Math.max(boundedOutputChars * 2, 2048),
    PLAIN_TEXT_NORMALIZATION_MAX_SOURCE_CHARS,
  );
  return contentToPlainText((content || '').slice(0, sourceLimit)).slice(0, boundedOutputChars);
};

const normalizeImageUrl = (url: string, baseUrl?: string) => {
  const candidate = (url || '').trim();
  if (!candidate || candidate.startsWith('data:') || candidate.startsWith('blob:')) return null;
  try {
    const parsed = baseUrl ? new URL(candidate, baseUrl) : new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const extractImageUrlsFromArticle = (article: Pick<Article, "content" | "markdownContent" | "url">, limit = 12) => {
  const content = `${article.markdownContent || ""}\n${article.content || ""}`;
  const urls = new Set<string>();
  const add = (raw?: string | null) => {
    if (!raw) return;
    const normalized = normalizeImageUrl(raw, article.url);
    if (normalized) urls.add(normalized);
  };

  for (const match of content.matchAll(/!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    add(match[1]);
  }
  for (const match of content.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    add(match[1]);
  }
  for (const match of content.matchAll(/\b(?:src|data-src|data-original)=["']([^"']+)["']/gi)) {
    add(match[1]);
  }

  return Array.from(urls).slice(0, limit);
};

const normalizeJsonStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
};

/**
 * Generate content hash for articles without URL
 * Used to detect duplicates based on title + source + excerpt
 */
const generateContentHash = (title: string, source: string, excerpt: string): string => {
  const content = `${title.trim()}|${source.trim()}|${excerpt.trim().slice(0, 200)}`;
  return createHash('sha256').update(content, 'utf8').digest('hex');
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
  summary?: string;
  originalQuote?: string;
  context?: string;
  citationNote?: string;
  evidenceRole?: string;
  tags?: string[];
  articleTitle?: string;
  articleId?: number;
  savedArticleId?: number;
  sourceName?: string;
  sourceUrl?: string;
  sourceExcerpt?: string;
  sourceContext?: string;
  sourceImages?: string[];
  publishedAt?: number;
  savedAt?: string;
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
  selectedStyleSkillId?: number | string;
  selectedSkillIds?: Array<number | string>;
  effectiveSkillIds?: Array<number | string>;
  writingGoal?: string;
  pendingChoice?: {
    type: "card_selection" | "style_selection" | "draft_confirmation";
    prompt: string;
    cardIds?: string[];
    styleSkillIds?: Array<number | string>;
    createdAt?: string;
  };
  selectedCardIds?: string[];
  sourceImageIds?: string[];
  lastIntent?: string;
  latestOutline?: WritingOutlineSection[];
  latestAngle?: string;
  lastGeneratedNoteId?: number;
  lastGeneratedNoteTitle?: string;
};

const WRITE_CANVAS_NODE_KINDS = [
  "asset_text",
  "asset_file",
  "asset_image",
  "saved_article",
  "atom_card",
  "note",
  "agent",
  "result",
] as const;

type WriteCanvasNodeKind = typeof WRITE_CANVAS_NODE_KINDS[number];

const WRITE_CANVAS_NODE_ROLES = ["material", "insight", "task", "document", "group"] as const;
const WRITE_CANVAS_NODE_ORIGINS = ["existing", "extracted", "manual", "generated"] as const;
const WRITE_CANVAS_NODE_STATUSES = ["parsing", "ready", "running", "pending_review", "adopted", "rejected", "editing", "completed", "failed"] as const;
const WRITE_CANVAS_EDGE_RELATIONS = ["context", "derived_from", "generated", "structure"] as const;

type WriteCanvasNodeRole = typeof WRITE_CANVAS_NODE_ROLES[number];
type WriteCanvasNodeOrigin = typeof WRITE_CANVAS_NODE_ORIGINS[number];
type WriteCanvasNodeStatus = typeof WRITE_CANVAS_NODE_STATUSES[number];
type WriteCanvasEdgeRelation = typeof WRITE_CANVAS_EDGE_RELATIONS[number];

type CanvasContextItem = {
  nodeId: number;
  kind: WriteCanvasNodeKind;
  title: string;
  text: string;
  imageDataUrl?: string;
  mimeType?: string;
  sourceLabel?: string;
};

const WRITE_CANVAS_MAX_NODES_PER_PROJECT = readBoundedEnvNumber(process.env.CANVAS_MAX_NODES_PER_PROJECT, 500, 50, 5000);
const WRITE_CANVAS_MAX_EDGES_PER_PROJECT = readBoundedEnvNumber(process.env.CANVAS_MAX_EDGES_PER_PROJECT, 2000, 100, 20000);
const WRITE_CANVAS_MAX_MESSAGES_PER_AGENT = readBoundedEnvNumber(process.env.CANVAS_MAX_MESSAGES_PER_AGENT, 200, 20, 1000);
const WRITE_CANVAS_MAX_PROJECTS_PER_USER = readBoundedEnvNumber(process.env.CANVAS_MAX_PROJECTS_PER_USER, 50, 5, 500);
const WRITE_CANVAS_MAX_CONTEXT_ITEMS = readBoundedEnvNumber(process.env.CANVAS_MAX_CONTEXT_ITEMS, 30, 5, 100);
const WRITE_CANVAS_MAX_CONTEXT_CHARS = readBoundedEnvNumber(process.env.CANVAS_MAX_CONTEXT_CHARS, 60000, 10000, 250000);
const WRITE_CANVAS_MAX_AGGREGATE_CONTEXT_CHARS = readBoundedEnvNumber(process.env.CANVAS_MAX_AGGREGATE_CONTEXT_CHARS, 120000, 10000, 500000);
const WRITE_CANVAS_MAX_CONTEXT_IMAGE_BYTES = readBoundedEnvNumber(process.env.CANVAS_MAX_CONTEXT_IMAGE_MB, 12, 1, 40) * 1024 * 1024;
const WRITE_CANVAS_MAX_CONTEXT_IMAGES = 4;
const WRITE_CANVAS_ESTIMATED_TOKENS_PER_IMAGE = 2048;
const WRITE_CANVAS_MAX_AGENT_GROUP_MEMBERS = 3;
const WRITE_CANVAS_MAX_EXTRACTION_NODES = 12;
const CANVAS_DOCUMENT_MAX_VERSIONS = readBoundedEnvNumber(process.env.CANVAS_DOCUMENT_MAX_VERSIONS, 50, 5, 500);
type WriteAgentSkillType = "card_storage" | "citation" | "writing" | "style";
type WriteAgentSkillScenario = "storage" | "citation" | "drafting" | "style";

type WriteAgentSkillRecord = {
  id: number | string;
  name: string;
  type: WriteAgentSkillType;
  scenario?: WriteAgentSkillScenario;
  description?: string;
  prompt: string;
  examples?: string[];
  constraints?: string[];
  visibility: "system" | "user";
  isDefault?: boolean;
  isBaseline?: boolean;
  usageCount?: number;
  lastUsedAt?: string;
  recentNotes?: Array<{ id: number; title: string; updatedAt?: string }>;
  recentCards?: Array<{ id: string; content: string; articleTitle?: string; createdAt?: string }>;
  generatedPrompt?: string;
  createdAt?: string;
  updatedAt?: string;
};

type WriteStyleSkillRecord = WriteAgentSkillRecord;

type WriteAgentChoiceRecord = {
  id: string;
  label: string;
  action: "use_cards" | "exclude_card" | "refresh_cards" | "generate_outline" | "generate_draft" | "select_style" | "export_to_draft" | "switch_style" | "smart_reply";
  payload?: Record<string, unknown>;
};

type WriteAgentGraphTraceRecord = {
  node: string;
  durationMs: number;
  inputSummary?: string;
  outputSummary?: string;
  meta?: Record<string, unknown>;
  createdAt?: string;
};

type WriteAgentSourcesRecord = {
  cards: any[];
  articles: Array<{
    id?: number;
    title: string;
    source?: string;
    url?: string;
    citationContext?: string;
    imageUrls?: string[];
  }>;
  quotes: Array<{
    cardId: string;
    articleTitle?: string;
    quote: string;
  }>;
  images: Array<{
    id: string;
    url: string;
    articleTitle?: string;
  }>;
};

const WRITE_AGENT_NODE_LABELS: Record<string, { start: string; end: string }> = {
  hydrate_context: { start: "读取会话与当前写作上下文", end: "上下文已就绪" },
  load_effective_skills: { start: "加载基础规范与增强 Skills", end: "本次生效规范已确定" },
  classify_intent: { start: "判断用户意图与所需工具", end: "意图路由完成" },
  retrieve_knowledge: { start: "召回知识库卡片", end: "知识卡片召回完成" },
  enrich_sources: { start: "补齐来源、原文摘录与图片", end: "来源信息已整理" },
  decide_next: { start: "决定下一步动作", end: "已生成可选动作" },
  human_selection: { start: "同步激活知识节点", end: "节点激活完成" },
  generate_answer_or_draft: { start: "生成回答或文章草稿", end: "生成完成" },
  persist_memory: { start: "保存对话、引用链路与文章元信息", end: "记忆已保存" },
  respond: { start: "整理最终回复", end: "回复完成" }
};

const getWriteAgentNodeLabel = (node: string, phase: "start" | "end") => {
  return WRITE_AGENT_NODE_LABELS[node]?.[phase] || (phase === "start" ? `运行 ${node}` : `${node} 完成`);
};

const SYSTEM_WRITE_AGENT_SKILLS: WriteAgentSkillRecord[] = [
  {
    id: "system-card-storage",
    name: "知识入库基础规范",
    type: "card_storage",
    scenario: "storage",
    description: "拆卡时保留来源、上下文、原文摘录和引用用途，避免没头没尾。",
    prompt: "保存知识卡片时，每张卡必须能脱离原文被理解：保留文章背景、原文摘录、卡片语境、适合引用的位置和来源信息。卡片内容可以精炼，但不要牺牲可引用性。",
    examples: ["把'为什么重要'和'来自哪篇文章的哪个语境'一起存，而不是只存一句孤立观点。"],
    constraints: ["不得丢失来源标题", "优先保留原文摘录", "摘要要说明背景和用途"],
    visibility: "system",
    isDefault: true,
    isBaseline: true
  },
  {
    id: "system-citation",
    name: "引用链路基础规范",
    type: "citation",
    scenario: "citation",
    description: "回答和成文时必须能追溯到卡片、原文、图片和来源文章。",
    prompt: "引用知识库时，优先呈现来源文章、原文摘录、文章背景和图片线索。正文可以不堆满引用，但生成结果的依据必须能在 sources/note meta 中追溯。",
    examples: ["来自《某篇文章》的原文摘录可以支撑这个判断；图片适合放在这一段旁边作为现场证据。"],
    constraints: ["不要伪造来源", "不要把卡片当作无出处常识", "图片只引用已保存 URL"],
    visibility: "system",
    isDefault: true,
    isBaseline: true
  },
  {
    id: "system-writing",
    name: "写作输出基础规范",
    type: "writing",
    scenario: "drafting",
    description: "素材服务观点，文章围绕判断推进，而不是逐条罗列卡片。",
    prompt: "写作时先形成作者自己的判断，再选择素材服务论证。结构应从问题、判断、证据、反思或方法自然推进，避免把知识库内容机械分类。",
    examples: ["先说'这其实不是工具问题，而是流程可解释性问题'，再用素材证明。"],
    constraints: ["不要素材堆砌", "每节要有推进", "结尾要收束到观点或方法"],
    visibility: "system",
    isDefault: true,
    isBaseline: true
  },
  {
    id: "system-deep-analysis",
    name: "深度分析型公众号文章",
    type: "style",
    scenario: "style",
    description: "用事实和逻辑说服，场景开篇，留白收尾，用「我们」不用「你」。适合认知升级、趋势分析、观点输出。",
    prompt: [
      "风格基因：用事实和逻辑说服读者，而不是情绪煽动。开头从一个具体场景切入，结尾留白让读者自己思考。",
      "结构方式：场景引入 → 核心论点 → 多层论证（数据+案例+逻辑推演） → 开放式收束。用「我们」拉近距离，不用「你」说教。",
      "素材搭配：用 @数据 建立事实基础，用 @观点 形成核心判断，用 @故事 让抽象概念落地，用 @金句 做关键转折的记忆锚点。",
      "表达边界：克制、冷静、有分量。不堆感叹号，不用情绪化词汇，让逻辑本身产生说服力。"
    ].join("\n"),
    examples: ["用一个真实场景开篇，再用 @数据 和 @观点 层层推进判断，最后留一个问题让读者自己想。"],
    constraints: ["不要用「你」说教", "不要情绪化煽动", "不要堆砌感叹号", "收尾不要总结陈词，留白"],
    visibility: "system",
    isDefault: true
  },
  {
    id: "system-hot-event",
    name: "热点事件解析型文章",
    type: "style",
    scenario: "style",
    description: "四层递进：事件还原→技术拆解→商业价值→行业意义。强调冲击力和时效感。",
    prompt: [
      "风格基因：不是跟风蹭热点，而是用专业视角拆解一个事件为什么重要、背后发生了什么、对我们意味着什么。",
      "结构方式：四层递进——事件还原（发生了什么）→ 技术拆解（怎么做到的）→ 商业价值（钱在哪里）→ 行业意义（格局怎么变）。",
      "素材搭配：用 @故事 还原事件现场，用 @数据 量化冲击力，用 @观点 给出专业判断，用 @金句 做标题或段落记忆点。",
      "表达边界：可以有兴奋感和紧迫感，但要有事实支撑。时效性要强，判断要快，但不能为了快而粗糙。"
    ].join("\n"),
    examples: ["先用 @故事 还原事件现场，再用 @数据 说明冲击力，最后用 @观点 判断行业影响。"],
    constraints: ["不要空喊「重磅」", "不要只复述新闻不给判断", "推测必须标注", "引用必须能追溯"],
    visibility: "system"
  },
  {
    id: "system-product-analysis",
    name: "产品经理视角·产品分析",
    type: "style",
    scenario: "style",
    description: "面向产品社区，开篇黄金公式（案例→联系→转折→观点），场景化+可落地。适合产品方法论、AI行业分析、ToB实战。",
    prompt: [
      "风格基因：产品经理视角写分析，必须回答「这对产品经理意味着什么」。不是旁观者评论，而是从业者实战复盘。",
      "开篇黄金公式：用一个具体案例开篇 → 和读者建立联系（你可能也遇到过）→ 转折（但真正的问题是…）→ 抛出核心观点。",
      "结构方式：问题定义 → 拆解机制 → 案例验证 → 可执行的产品启示。每一节都要有「所以呢」的落地感。",
      "素材搭配：用 @故事 讲产品案例，用 @数据 佐证判断，用 @观点 给产品启示，用 @金句 做标题或核心论点。",
      "表达边界：允许专业术语但要解释，可以用对比表格和 bullet point，收尾必须有可执行的产品启示。"
    ].join("\n"),
    examples: ["用一个产品决策的 @故事 开篇，用 @数据 和 @观点 拆解决策逻辑，最后给出可复用的产品方法论。"],
    constraints: ["不要旁观者口吻", "收尾必须有产品启示", "不要空泛方法论", "不要堆砌专业术语不解释"],
    visibility: "system"
  },
  {
    id: "system-ai-news",
    name: "量子位·AI新闻报道",
    type: "style",
    scenario: "style",
    description: "感叹号标题、权威背书前置、口语化+网络用语、数据对比密集。适合AI科技新闻、产品发布、技术突破。",
    prompt: [
      "风格基因：科技新闻报道风格，强调信息密度和冲击力。标题要有新闻感，内容要有「刚刚发生」的紧迫感。",
      "结构方式：冲击力标题 → 权威背书或核心数据前置 → 技术细节拆解 → 对比（和上一代/竞品/预期）→ 影响判断。",
      "素材搭配：用 @数据 做对比和量化，用 @观点 引用权威人士判断，用 @故事 讲产品发布现场或技术突破过程，用 @金句 做标题。",
      "表达边界：可以口语化、可以用网络用语、可以用感叹号，但信息必须准确。产品名、模型名、数据必须具体可查证。"
    ].join("\n"),
    examples: ["用 @金句 做标题，开头直接上 @数据 核心对比，再用 @故事 补充技术细节和发布背景。"],
    constraints: ["不要模糊的产品名", "数据必须具体可查证", "不要空喊「颠覆」", "不要把未发布当已发布"],
    visibility: "system"
  },
  {
    id: "system-light-essay",
    name: "朋友圈·轻量思辨文",
    type: "style",
    scenario: "style",
    description: "三层递进（事件→放下争议→时代映射），≤800字，悖论揭示法。适合朋友圈、短视频文案、个人随笔。",
    prompt: [
      "风格基因：不是长篇大论，而是一条让人停下来想一想的朋友圈。用悖论揭示法——表面看是A，其实是B，但更深想是C。",
      "结构方式：三层递进——事件引入（一句话）→ 放下争议看本质 → 时代映射（这个现象说明了什么）。严格控制在800字以内。",
      "素材搭配：用 @故事 一句话带过事件，用 @观点 做悖论揭示，用 @金句 做收尾记忆点。数据慎用，短文里数据容易显得笨重。",
      "表达边界：克制、轻盈、有思辨感。不堆砌论据，不展开论证，像和朋友聊天时随口说的一句有分量的话。"
    ].join("\n"),
    examples: ["一句话用 @故事 带过事件，用 @观点 揭示悖论，用 @金句 收尾——整个过程不超过三段。"],
    constraints: ["不超过800字", "不要展开论证", "不要堆砌数据", "不要说教口吻"],
    visibility: "system"
  },
  {
    id: "system-cold-observation",
    name: "冷观察·纵横分析",
    type: "style",
    scenario: "style",
    description: "纵横双轴法（时间递进×维度拆解），冷静克制，横纵交汇出洞察。适合AI深度分析、商业趋势、产品方法论拆解。",
    prompt: [
      "风格基因：冷静的观察者，不急不躁，用时间和维度两条线把一个现象拆透。不是热点评论，而是事后复盘式的深度分析。",
      "结构方式：纵轴——追踪对象从诞生到当下的完整历程（叙事故事呈现）；横轴——在当下时间截面上与竞品/同类做系统性对比；交汇点——两条轴交叉产出独到洞察。",
      "素材搭配：用 @故事 做纵向叙事的时间节点，用 @数据 做横向对比的事实支撑，用 @观点 在交汇点给出判断，用 @金句 做核心结论的记忆锚点。",
      "表达边界：冷静、克制、有距离感。不用感叹号，不煽情，让分析本身产生力量。可以有小标题帮助导航。"
    ].join("\n"),
    examples: ["用 @故事 串起时间线，用 @数据 做横向对比表，在纵横交汇处用 @观点 给出核心洞察。"],
    constraints: ["不要情绪化表达", "不要急于下结论", "纵横两条线必须清晰", "推测必须标注"],
    visibility: "system"
  },
  {
    id: "system-tutorial",
    name: "教程类·操作指南",
    type: "style",
    scenario: "style",
    description: "「学完就会」导向，每步只做一件事，步骤可验证。适合操作指南、工具教程、实战手册。",
    prompt: [
      "风格基因：不是百科全书式的功能介绍，而是「学完就会」的实战教程。读者跟着做完就能得到一个可验证的结果。",
      "结构方式：开头说清楚「学完你能做到什么」 → 每步只做一件事 → 每步有验证点（你怎么知道自己做对了）→ 最后有一个完整的实战案例。",
      "素材搭配：用 @观点 说明「为什么这么做」，用 @数据 说明工具选择的依据，用 @故事 讲「我踩过的坑」帮读者避雷。",
      "表达边界：步骤编号清晰，截图/代码块/示意图为必备元素。不要假设读者已有背景知识，但也不要啰嗦。"
    ].join("\n"),
    examples: ["用 @观点 说明为什么要用这个工具，列出清晰步骤，最后用 @故事 补充实战经验和踩坑提醒。"],
    constraints: ["每步只做一件事", "必须有验证点", "不要假设背景知识", "不要功能罗列式写法"],
    visibility: "system"
  }
];

const SYSTEM_WRITE_STYLE_SKILLS = SYSTEM_WRITE_AGENT_SKILLS.filter(skill => skill.type === "style");

const normalizeAgentSkillType = (value: unknown): WriteAgentSkillType => (
  value === "card_storage" || value === "citation" || value === "writing" || value === "style"
    ? value
    : "style"
);

const skillScenarioForType = (type: WriteAgentSkillType): WriteAgentSkillScenario => {
  if (type === "card_storage") return "storage";
  if (type === "citation") return "citation";
  if (type === "writing") return "drafting";
  return "style";
};

const BASELINE_SKILL_TYPES = new Set<WriteAgentSkillType>(["card_storage", "citation", "writing"]);

const isBaselineSkill = (skill: WriteAgentSkillRecord) => skill.visibility === "system" && Boolean(skill.isBaseline);

const getBaselineWriteAgentSkills = (types?: WriteAgentSkillType[]) => {
  const allowed = types ? new Set(types) : null;
  return SYSTEM_WRITE_AGENT_SKILLS.filter(skill => skill.isBaseline && (!allowed || allowed.has(skill.type)));
};

const fetchWriteAgentSkills = async (pool: pg.Pool, userId: number, typeFilter?: WriteAgentSkillType): Promise<WriteAgentSkillRecord[]> => {
  const rows = (await pool.query(
    `SELECT id, name, type, description, prompt, examples, constraints, is_default AS "isDefault",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM write_style_skills
     WHERE user_id = $1
       AND ($2::text IS NULL OR type = $2::text)
     ORDER BY is_default DESC, updated_at DESC`,
    [userId, typeFilter || null]
  )).rows.map(row => ({
    id: Number(row.id),
    name: row.name as string,
    type: normalizeAgentSkillType(row.type),
    scenario: skillScenarioForType(normalizeAgentSkillType(row.type)),
    description: row.description as string,
    prompt: row.prompt as string,
    examples: normalizeJsonStringArray(row.examples),
    constraints: normalizeJsonStringArray(row.constraints),
    visibility: "user" as const,
    isBaseline: false,
    generatedPrompt: row.prompt as string,
    isDefault: Boolean(row.isDefault),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }));
  const systemSkills = typeFilter
    ? SYSTEM_WRITE_AGENT_SKILLS.filter(skill => skill.type === typeFilter)
    : SYSTEM_WRITE_AGENT_SKILLS;
  return [...systemSkills, ...rows];
};

const fetchWriteStyleSkills = async (pool: pg.Pool, userId: number): Promise<WriteStyleSkillRecord[]> => {
  return fetchWriteAgentSkills(pool, userId, "style");
};

const resolveWriteStyleSkill = async (
  pool: pg.Pool,
  userId: number,
  styleSkillId?: number | string
): Promise<WriteStyleSkillRecord> => {
  const skills = await fetchWriteStyleSkills(pool, userId);
  if (styleSkillId !== undefined && styleSkillId !== null) {
    const normalized = String(styleSkillId);
    const found = skills.find(skill => String(skill.id) === normalized);
    if (found) return found;
  }
  return skills.find(skill => skill.visibility === "user" && skill.isDefault)
    || skills.find(skill => skill.isDefault)
    || SYSTEM_WRITE_STYLE_SKILLS[0];
};

const resolveWriteAgentSkills = async (
  pool: pg.Pool,
  userId: number,
  selectedSkillIds?: Array<number | string>,
  selectedStyleSkillId?: number | string
): Promise<WriteAgentSkillRecord[]> => {
  const skills = await fetchWriteAgentSkills(pool, userId);
  const selectedSet = new Set((selectedSkillIds || []).map(id => String(id)));
  if (selectedStyleSkillId !== undefined && selectedStyleSkillId !== null) {
    selectedSet.add(String(selectedStyleSkillId));
  }
  const selected = skills.filter(skill => selectedSet.has(String(skill.id)) && !isBaselineSkill(skill));
  const result: WriteAgentSkillRecord[] = [];
  getBaselineWriteAgentSkills().forEach(skill => result.push(skill));
  selected.forEach(skill => {
    if (!result.some(item => String(item.id) === String(skill.id))) result.push(skill);
  });
  const hasStyle = result.some(skill => skill.type === "style");
  const fallbackStyle = skills.find(skill => skill.type === "style" && skill.visibility === "user" && skill.isDefault)
    || skills.find(skill => skill.type === "style" && skill.isDefault)
    || skills.find(skill => skill.type === "style");
  if (!hasStyle && fallbackStyle) result.push(fallbackStyle);
  return result;
};

const buildAgentSkillSnapshot = (skill: WriteAgentSkillRecord) => ({
  id: skill.id,
  name: skill.name,
  type: skill.type,
  scenario: skill.scenario || skillScenarioForType(skill.type),
  description: skill.description,
  prompt: skill.prompt,
  examples: skill.examples || [],
  constraints: skill.constraints || [],
  isBaseline: Boolean(skill.isBaseline)
});

const buildStyleSkillSnapshot = buildAgentSkillSnapshot;

const buildAgentSkillSnapshots = (skills: WriteAgentSkillRecord[]) => skills.map(buildAgentSkillSnapshot);

const formatAgentSkillInstructions = (skills: WriteAgentSkillRecord[], types?: WriteAgentSkillType[]) => {
  const allowed = types ? new Set(types) : null;
  const scoped = skills.filter(skill => !allowed || allowed.has(skill.type));
  if (scoped.length === 0) return "";
  return scoped.map(skill => [
    `Skill「${skill.name}」(${skill.type})：${skill.prompt}`,
    (skill.constraints || []).length ? `约束：${(skill.constraints || []).join("；")}` : "",
    (skill.examples || []).length ? `示例：${(skill.examples || []).join("；")}` : ""
  ].filter(Boolean).join("\n")).join("\n\n");
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
      content: card.content.trim().slice(0, 520),
      summary: typeof card.summary === "string" ? card.summary.trim().slice(0, 180) : undefined,
      originalQuote: typeof card.originalQuote === "string" ? card.originalQuote.trim().slice(0, 260) : undefined,
      context: typeof card.context === "string" ? card.context.trim().slice(0, 360) : undefined,
      citationNote: typeof card.citationNote === "string" ? card.citationNote.trim().slice(0, 220) : undefined,
      evidenceRole: typeof card.evidenceRole === "string" ? card.evidenceRole.trim().slice(0, 40) : undefined,
      tags: Array.isArray(card.tags) ? card.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 6) : [],
      articleTitle: typeof card.articleTitle === "string" ? card.articleTitle : undefined,
      articleId: typeof card.articleId === "number" ? card.articleId : undefined,
      savedArticleId: typeof card.savedArticleId === "number" ? card.savedArticleId : undefined,
      sourceName: typeof card.sourceName === "string" ? card.sourceName : undefined,
      sourceUrl: typeof card.sourceUrl === "string" ? card.sourceUrl : undefined,
      sourceExcerpt: typeof card.sourceExcerpt === "string" ? card.sourceExcerpt.trim().slice(0, 260) : undefined,
      sourceContext: typeof card.sourceContext === "string" ? card.sourceContext.trim().slice(0, 700) : undefined,
      sourceImages: normalizeJsonStringArray(card.sourceImages).slice(0, 8),
      publishedAt: typeof card.publishedAt === "number" ? card.publishedAt : undefined,
      savedAt: typeof card.savedAt === "string" ? card.savedAt : undefined
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

const buildWritingUserPrompt = (
  topic: string,
  activeCards: WritingCardInput[],
  extraCards: WritingCardInput[],
  styleSkill?: WriteStyleSkillRecord,
  agentSkills: WriteAgentSkillRecord[] = []
) => {
  const cardBlock = activeCards
    .map((card, index) => formatCardForWriting(card, index))
    .join("\n");
  const extraBlock = extraCards.length > 0
    ? extraCards
      .map((card, index) => formatCardForWriting(card, index))
      .join("\n")
    : "无";
  const { topTags, typeSummary } = summarizeWritingCards(activeCards);

  return `写作主题：${topic}
${styleSkill ? `
选用风格 Skill：${styleSkill.name}
风格要求：${styleSkill.prompt}
风格约束：${(styleSkill.constraints || []).join("；") || "无"}
` : ""}
${agentSkills.length ? `
本次适用 Skills：
${formatAgentSkillInstructions(agentSkills, ["citation", "writing"])}
` : ""}

参考素材概览（${activeCards.length} 条，类型分布：${typeSummary || "未统计"}，高频标签：${topTags.join("、") || "无"}）：

核心参考素材：
${cardBlock}

补充参考素材：
${extraBlock}

重要提醒：以上素材仅供参考和启发，不要逐条搬运或罗列。请用自己的语言写一篇有独立观点、叙事连贯的原创文章。素材是背景知识，不是文章骨架；需要引用时优先使用“原文摘录/来源/引用建议”，不要伪造来源。`;
};

const formatCardForWriting = (card: WritingCardInput, index: number, prefix = "") => [
  `${prefix}${index + 1}. [${card.type}${card.evidenceRole ? `/${card.evidenceRole}` : ""}] ${card.content}`,
  card.summary ? `   摘要：${card.summary}` : "",
  card.sourceContext ? `   文章背景：${card.sourceContext}` : "",
  card.context ? `   卡片语境：${card.context}` : "",
  card.originalQuote ? `   原文摘录：${card.originalQuote}` : "",
  card.citationNote ? `   引用建议：${card.citationNote}` : "",
  card.sourceImages?.length ? `   原文图片：${card.sourceImages.slice(0, 3).join("、")}` : "",
  card.tags?.length ? `   tags：${card.tags.join("、")}` : "",
  card.articleTitle ? `   来源：${card.sourceName ? `${card.sourceName} · ` : ""}${card.articleTitle}${card.sourceUrl ? ` · ${card.sourceUrl}` : ""}` : ""
].filter(Boolean).join("\n");

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
4. outline 的结构必须符合 Scratch 成稿标准：开场有具体问题或场景，承接作者核心判断，转入矛盾/代价/反常识，再收束到结论或行动。
5. 素材只是背景知识和灵感来源，文章结构要围绕作者自己的观点展开。
6. 不要出现“素材对齐”“观点对齐”“节点映射”“引用映射”等过程性栏目。
7. 严格只输出 JSON。`;

const WRITING_POLISH_SYSTEM_PROMPT = `你是中文写作润色 Agent。你的任务是让草稿更像真人写的，而不是改换观点。

要求：
1. 保留原有结构、结论和论证顺序。
2. 删除套话、空话、AI 腔。
3. 让句子更自然、更有推进感，但不要堆修辞。
4. 输出纯 Markdown，不要解释。`;

const AI_REQUEST_TIMEOUT_MS = readBoundedEnvNumber(process.env.AI_REQUEST_TIMEOUT_MS, 120000, 5000, 300000);
const WRITE_CANVAS_AGENT_BATCH_STALE_MS = Math.max(
  AI_REQUEST_TIMEOUT_MS + 60_000,
  readBoundedEnvNumber(process.env.CANVAS_AGENT_BATCH_STALE_MS, 10 * 60 * 1000, 60_000, 60 * 60 * 1000),
);
const CANVAS_AI_RECOVERY_STALE_MS = Math.max(
  AI_REQUEST_TIMEOUT_MS + 60_000,
  readBoundedEnvNumber(process.env.CANVAS_AI_RECOVERY_STALE_MS, AI_REQUEST_TIMEOUT_MS + 60_000, 60_000, 60 * 60 * 1000),
);
const CANVAS_AI_RECOVERY_INTERVAL_MS = readBoundedEnvNumber(process.env.CANVAS_AI_RECOVERY_INTERVAL_MS, 60_000, 10_000, 5 * 60 * 1000);
const WRITE_AGENT_MAX_MESSAGE_LENGTH = 120000;
const WRITE_CANVAS_MAX_META_BYTES = 32 * 1024;
const WRITE_CANVAS_MAX_VIEWPORT_BYTES = 8 * 1024;
const AI_DRAFT_MAX_TOKENS = 2400;
const AI_POLISH_MAX_TOKENS = 2400;
const MIMO_MIN_STRUCTURED_OUTPUT_TOKENS = 4096;
const DRAFT_META_LINE_PATTERN = /^(?:正文草稿|正文章稿|标题建议|主标题|副标题|核心逻辑|写作思路|写作说明|素材对齐|观点对齐|观点的对齐|引用映射|节点映射|确定性引用映射|使用素材|参考素材|以下是|下面是)[:：\s]/;
const DRAFT_META_HEADING_PATTERN = /^#{1,6}\s*(?:正文草稿|正文章稿|写作思路|写作说明|素材对齐|观点对齐|观点的对齐|引用映射|节点映射|确定性引用映射)\s*$/;

const cleanGeneratedDraftMarkdown = (raw: string): string => {
  const normalized = raw
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/\r\n/g, "\n")
    .trim();
  const lines = normalized.split("\n");
  const cleanedLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      cleanedLines.push(line);
      continue;
    }
    if (DRAFT_META_LINE_PATTERN.test(trimmed) || DRAFT_META_HEADING_PATTERN.test(trimmed)) {
      continue;
    }
    cleanedLines.push(line);
  }

  return cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

const stripLeadingTitleHeading = (markdown: string, title: string): string => {
  const lines = markdown.split("\n");
  const normalizedTitle = normalizePlainText(title).replace(/^#+\s*/, "").trim();
  if (!lines.length || !normalizedTitle) return markdown;
  const firstMeaningfulIndex = lines.findIndex(line => line.trim());
  if (firstMeaningfulIndex < 0) return markdown;
  const firstLine = lines[firstMeaningfulIndex].trim();
  const headingText = firstLine.replace(/^#{1,6}\s*/, "").trim();
  if (firstLine.startsWith("#") && normalizePlainText(headingText) === normalizedTitle) {
    return lines.slice(firstMeaningfulIndex + 1).join("\n").trim();
  }
  return markdown;
};

const renderAgentDraftMarkdownToHtml = (markdown: string): string => {
  const rawHtml = marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
  return sanitizeRichHtml(rawHtml);
};

const prepareAgentDraftForNote = (rawDraft: string, title: string) => {
  const markdown = stripLeadingTitleHeading(cleanGeneratedDraftMarkdown(rawDraft), title);
  return {
    markdown,
    html: renderAgentDraftMarkdownToHtml(markdown)
  };
};

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

const buildWritingPlanPrompt = (topic: string, activeCards: WritingCardInput[], extraCards: WritingCardInput[], styleSkill?: WriteStyleSkillRecord, agentSkills: WriteAgentSkillRecord[] = []) => {
  return `${buildWritingUserPrompt(topic, activeCards, extraCards, styleSkill, agentSkills)}

现在不要写正文，只做写作策划。`;
};

const buildDraftPrompt = (topic: string, plan: WritingPlanResult, activeCards: WritingCardInput[], extraCards: WritingCardInput[], evidenceMap: WritingEvidenceMapItem[] = [], styleSkill?: WriteStyleSkillRecord, agentSkills: WriteAgentSkillRecord[] = []) => {
  const outlineText = plan.outline.map((item, index) => `${index + 1}. ${item.heading} - ${item.goal}`).join("\n");
  const evidenceText = evidenceMap.length
    ? evidenceMap.map((item, index) => `${index + 1}. ${item.section}：只使用节点 ${item.nodeIds.join("、")}；引用目的：${item.note}`).join("\n")
    : "无";
  const cardLookup = activeCards
    .map((card, index) => [
      `A${index + 1} [${card.type}${card.evidenceRole ? `/${card.evidenceRole}` : ""}] ${card.content}`,
      card.sourceContext ? `文章背景：${card.sourceContext}` : "",
      card.context ? `卡片语境：${card.context}` : "",
      card.originalQuote ? `原文摘录：${card.originalQuote}` : "",
      card.citationNote ? `引用建议：${card.citationNote}` : "",
      card.sourceImages?.length ? `原文图片：${card.sourceImages.slice(0, 3).join("、")}` : "",
      card.articleTitle ? `来源：${card.sourceName ? `${card.sourceName} · ` : ""}${card.articleTitle}` : "",
      card.tags?.length ? `标签：${card.tags.join("、")}` : ""
    ].filter(Boolean).join("\n"))
    .join("\n");
  const extraLookup = extraCards
    .map((card, index) => [
      `B${index + 1} [${card.type}${card.evidenceRole ? `/${card.evidenceRole}` : ""}] ${card.content}`,
      card.sourceContext ? `文章背景：${card.sourceContext}` : "",
      card.context ? `卡片语境：${card.context}` : "",
      card.originalQuote ? `原文摘录：${card.originalQuote}` : "",
      card.sourceImages?.length ? `原文图片：${card.sourceImages.slice(0, 2).join("、")}` : "",
      card.articleTitle ? `来源：${card.sourceName ? `${card.sourceName} · ` : ""}${card.articleTitle}` : "",
      card.tags?.length ? `标签：${card.tags.join("、")}` : ""
    ].filter(Boolean).join("\n"))
    .join("\n") || "无";
  return `主题：${topic}
写作风格：${plan.style}
${styleSkill ? `风格 Skill：${styleSkill.name}
风格要求：${styleSkill.prompt}
风格约束：${(styleSkill.constraints || []).join("；") || "无"}
` : ""}
${agentSkills.length ? `适用 Skills：
${formatAgentSkillInstructions(agentSkills, ["citation", "writing", "style"])}
` : ""}
核心判断：${plan.angle}
文章标题：${plan.title}

提纲：
${outlineText}

确定性引用映射：
${evidenceText}

参考素材（仅供参考，不要逐条搬运）：
${cardLookup}

补充素材：
${extraLookup}

请按以上提纲写出一篇可以直接进入「我的文章」编辑器的完整 Markdown 成稿。要求：
1. 第一行使用「# ${plan.title}」，后面直接进入正文，不要写任何说明。
2. 正文必须符合 Scratch 标准：开头抓住具体问题/场景，承接作者核心判断，转入矛盾/代价/反常识，最后收束到结论或行动。
3. 二级标题严格对应提纲，但标题要像文章小标题，不要像工作流标签。
4. 每个 section 只围绕“确定性引用映射”里分配给该 section 的节点写，不要跨 section 随意挪用节点。
5. 每个 section 至少有一个可追踪依据：优先用原文摘录；没有原文摘录时，用卡片语境或文章背景改写支撑。
6. 如果直接引用原文，必须写成「……」（来自《文章标题》）；不要伪造没有出现在原文摘录里的直接引语。
7. 这是一篇原创文章，不是素材汇编。不要出现“某某卡片提到”“根据资料显示”“从这些观点可以看出”。
8. 严禁输出“素材对齐”“观点对齐”“节点映射”“引用映射”“写作思路”“正文草稿”等过程性栏目。
9. 不要改变 section 顺序，不要新增二级标题，不要输出解释。`;
};

const buildEvidenceMap = (plan: WritingPlanResult, activeCards: WritingCardInput[]): WritingEvidenceMapItem[] => {
  const groupedCards = activeCards.map(card => ({
    id: card.id || `${card.type}-${card.content.slice(0, 12)}`,
    text: `${card.content} ${card.summary || ""} ${card.sourceContext || ""} ${card.context || ""} ${card.originalQuote || ""} ${card.citationNote || ""} ${(card.tags || []).join(" ")} ${(card.articleTitle || "")}`.toLowerCase()
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
    meta: {
      ...(row.meta || {}),
      messageId: Number(row.id),
      feedback: row.role === 'assistant' ? (row.meta?.feedback || 'none') : row.meta?.feedback,
      sourceCollapsed: row.role === 'assistant' ? (row.meta?.sourceCollapsed ?? true) : row.meta?.sourceCollapsed
    },
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

const persistAgentGraphEvents = async (
  pool: pg.Pool,
  userId: number,
  threadId: number,
  trace: WriteAgentGraphTraceRecord[],
  runId?: string
) => {
  for (const item of trace) {
    await pool.query(
      `INSERT INTO write_agent_events (thread_id, user_id, node, duration_ms, input_summary, output_summary, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        threadId,
        userId,
        item.node,
        Math.max(0, Math.round(item.durationMs || 0)),
        item.inputSummary || null,
        item.outputSummary || null,
        JSON.stringify({ ...(item.meta || {}), ...(runId ? { runId } : {}) })
      ]
    );
  }
};

const persistAgentRunEvent = async (
  pool: pg.Pool,
  input: {
    userId: number;
    threadId: number;
    runId: string;
    status: "completed" | "error";
    durationMs: number;
    intent?: string;
    requestedTools?: string[];
    provider?: string;
    model?: string;
    noteId?: number;
    error?: string;
  }
) => {
  await pool.query(
    `INSERT INTO write_agent_events (thread_id, user_id, node, duration_ms, input_summary, output_summary, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.threadId,
      input.userId,
      input.status === "completed" ? "run_complete" : "run_error",
      Math.max(0, Math.round(input.durationMs || 0)),
      input.intent || null,
      input.status,
      JSON.stringify({
        runId: input.runId,
        status: input.status,
        intent: input.intent,
        requestedTools: input.requestedTools || [],
        provider: input.provider,
        model: input.model,
        noteId: input.noteId,
        error: input.error
      })
    ]
  );
};

const fetchUserSavedCards = async (pool: pg.Pool, userId: number) => {
  return (await pool.query(
    `SELECT sc.id, sc.type, sc.content, sc.summary,
            sc.original_quote AS "originalQuote",
            sc.context,
            sc.citation_note AS "citationNote",
            sc.evidence_role AS "evidenceRole",
            sc.tags,
            sc.article_title AS "articleTitle",
            sc.article_id AS "articleId",
            sc.saved_article_id AS "savedArticleId",
            sa.source AS "sourceName",
            sa.url AS "sourceUrl",
            sa.excerpt AS "sourceExcerpt",
            sa.citation_context AS "sourceContext",
            sa.image_urls AS "sourceImages",
            sa.published_at AS "publishedAt",
            sa.saved_at AS "savedAt"
     FROM saved_cards sc
     LEFT JOIN saved_articles sa ON sa.id = sc.saved_article_id AND sa.user_id = sc.user_id
     WHERE sc.user_id = $1`,
    [userId]
  )).rows.map(row => ({
    ...row,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
    sourceImages: normalizeJsonStringArray(row.sourceImages)
  }));
};

const tokenizeRecallQuery = (topic: string) => {
  const normalized = (topic || '').trim().toLowerCase();
  const tokens = normalized
    .split(/[\s,，。.!?！？、;；:："'“”‘’()（）[\]【】<>《》/\\|+-]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
  const compactChinese = normalized
    .replace(/[a-z0-9\s,，。.!?！？、;；:："'“”‘’()（）[\]【】<>《》/\\|+-]+/gi, '')
    .trim();
  const phrases = [
    normalized,
    compactChinese,
    ...tokens
  ].filter((token, index, arr) => token.length >= 2 && arr.indexOf(token) === index);
  return { normalized, tokens, phrases };
};

const scoreRecallCard = (card: any, query: ReturnType<typeof tokenizeRecallQuery>) => {
  const title = `${card.articleTitle || ''}`.toLowerCase();
  const tags = `${(card.tags || []).join(' ')}`.toLowerCase();
  const content = `${card.content || ''} ${card.summary || ''}`.toLowerCase();
  const context = `${card.sourceContext || ''} ${card.context || ''} ${card.originalQuote || ''} ${card.citationNote || ''} ${card.sourceExcerpt || ''}`.toLowerCase();
  const source = `${card.sourceName || ''}`.toLowerCase();
  let score = 0;
  const hits: string[] = [];
  for (const phrase of query.phrases) {
    if (!phrase) continue;
    if (title.includes(phrase)) {
      score += 7;
      hits.push(`title:${phrase}`);
    }
    if (tags.includes(phrase)) {
      score += 5;
      hits.push(`tag:${phrase}`);
    }
    if (content.includes(phrase)) {
      score += 4;
      hits.push(`content:${phrase}`);
    }
    if (context.includes(phrase)) {
      score += 2;
      hits.push(`context:${phrase}`);
    }
    if (source.includes(phrase)) {
      score += 1;
      hits.push(`source:${phrase}`);
    }
  }
  const uniqueArticleBoost = card.savedArticleId || card.articleId ? 0.5 : 0;
  return { score: score + uniqueArticleBoost, hits };
};

const toolRecallCards = (topic: string, cards: any[], excludeIds: string[] = []) => {
  const normalizedTopic = (topic || '').trim().toLowerCase();
  if (!normalizedTopic) return [];
  const query = tokenizeRecallQuery(normalizedTopic);
  const excludeSet = new Set(excludeIds);
  return cards
    .filter(card => !excludeSet.has(card.id))
    .map(card => {
      const { score, hits } = scoreRecallCard(card, query);
      return { card, score, hits };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(item => ({
      ...item.card,
      recallScore: item.score,
      recallHits: item.hits
    }));
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

const WriteAgentGraphAnnotation = Annotation.Root({
  userId: Annotation<number>(),
  threadId: Annotation<number | undefined>(),
  thread: Annotation<any>(),
  message: Annotation<string>(),
  isCreateArticle: Annotation<boolean>(),
  userState: Annotation<WriteAgentState>(),
  mergedState: Annotation<WriteAgentState>(),
  previousMessages: Annotation<any[]>({ reducer: (_left, right) => right, default: () => [] }),
  dbCards: Annotation<any[]>({ reducer: (_left, right) => right, default: () => [] }),
  activeCards: Annotation<any[]>({ reducer: (_left, right) => right, default: () => [] }),
  recalledCards: Annotation<any[]>({ reducer: (_left, right) => right, default: () => [] }),
  recentNotes: Annotation<any[]>({ reducer: (_left, right) => right, default: () => [] }),
  intent: Annotation<{ tools?: string[]; reason?: string; intent?: string } | null>(),
  requestedTools: Annotation<string[]>({ reducer: (_left, right) => right, default: () => [] }),
  styleSkill: Annotation<WriteStyleSkillRecord | undefined>(),
  agentSkills: Annotation<WriteAgentSkillRecord[]>({ reducer: (_left, right) => right, default: () => [] }),
  generatedPlan: Annotation<WritingPlanResult | null>(),
  generatedOutlineText: Annotation<string>(),
  generatedDraftText: Annotation<string>(),
  persistedDraftNote: Annotation<any>(),
  assistantContent: Annotation<string>(),
  assistantMessageId: Annotation<number | undefined>(),
  toolPayload: Annotation<any>(),
  sources: Annotation<WriteAgentSourcesRecord | undefined>(),
  choices: Annotation<WriteAgentChoiceRecord[]>({ reducer: (_left, right) => right, default: () => [] }),
  uiBlocks: Annotation<any[]>({ reducer: (_left, right) => right, default: () => [] }),
  graphTrace: Annotation<WriteAgentGraphTraceRecord[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  })
});

type WriteAgentGraphState = typeof WriteAgentGraphAnnotation.State;

const runWriteAgentGraph = async (
  pool: pg.Pool,
  input: {
    userId: number;
    threadId?: number;
    message: string;
    isCreateArticle: boolean;
    userState: WriteAgentState;
    onStep?: (event: { type: string; node?: string; message?: string; data?: unknown }) => void | Promise<void>;
  }
) => {
  const requestChat = async (messages: AiChatMessage[], temperature: number, maxTokens: number) => {
    return requestAiChatCompletion(messages, {
      temperature,
      maxTokens,
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
      logLabel: "write_agent_langgraph",
      disableThinking: true
    });
  };

  const withTrace = (
    node: string,
    handler: (state: WriteAgentGraphState) => Promise<Partial<WriteAgentGraphState>> | Partial<WriteAgentGraphState>,
    summarize?: (state: WriteAgentGraphState, update: Partial<WriteAgentGraphState>) => string
  ) => async (state: WriteAgentGraphState) => {
    const started = Date.now();
    await input.onStep?.({
      type: "step_start",
      node,
      message: getWriteAgentNodeLabel(node, "start")
    });
    const update = await handler(state);
    const traceItem = {
      node,
      durationMs: Date.now() - started,
      inputSummary: normalizePlainText(state.message || "").slice(0, 160),
      outputSummary: summarize ? summarize(state, update) : "",
      meta: {
        requestedTools: update.requestedTools || state.requestedTools || [],
        activeCards: update.activeCards?.length ?? state.activeCards?.length ?? 0,
        recalledCards: update.recalledCards?.length ?? state.recalledCards?.length ?? 0
      },
      createdAt: new Date().toISOString()
    };
    await input.onStep?.({
      type: "step_end",
      node,
      message: getWriteAgentNodeLabel(node, "end"),
      data: traceItem
    });
    const selectedIds = update.mergedState?.selectedCardIds;
    if ((node === "human_selection" || node === "persist_memory") && Array.isArray(selectedIds)) {
      await input.onStep?.({
        type: "activation",
        node,
        message: "已同步激活知识节点",
        data: {
          activatedNodeIds: selectedIds,
          activationSummary: update.mergedState?.activationSummary || []
        }
      });
    }
    return {
      ...update,
      graphTrace: [traceItem]
    };
  };

  const graph = new StateGraph(WriteAgentGraphAnnotation)
    .addNode("hydrate_context", withTrace("hydrate_context", async state => {
      let thread = state.threadId
        ? (await pool.query(
          `SELECT id, title, summary, state, created_at, updated_at
           FROM write_agent_threads
           WHERE id = $1 AND user_id = $2`,
          [state.threadId, state.userId]
        )).rows[0]
        : null;

      if (!thread) {
        thread = (await pool.query(
          `INSERT INTO write_agent_threads (user_id, title, state, thread_type)
           VALUES ($1, $2, $3, $4)
           RETURNING id, title, summary, state, thread_type, created_at, updated_at`,
          [state.userId, inferThreadTitle(state.message), JSON.stringify({}), 'chat']
        )).rows[0];
      }

      const normalizedThreadId = Number(thread.id);
      await pool.query(
        `INSERT INTO write_agent_messages (thread_id, role, content, meta)
         VALUES ($1, 'user', $2, $3)`,
        [normalizedThreadId, state.message, JSON.stringify({ state: state.userState, action: state.isCreateArticle ? "create_article" : undefined })]
      );

      const dbCards = await fetchUserSavedCards(pool, state.userId);
      const previousMessages = await getRecentThreadMessages(pool, normalizedThreadId, 14);
      const threadState = (thread.state || {}) as WriteAgentState;
      const mergedState: WriteAgentState = {
        focusedTopic: state.userState.focusedTopic || threadState.focusedTopic,
        activatedNodeIds: state.userState.activatedNodeIds || threadState.activatedNodeIds || [],
        activationSummary: state.userState.activationSummary || threadState.activationSummary || [],
        selectedStyleSkillId: state.userState.selectedStyleSkillId || threadState.selectedStyleSkillId,
        selectedSkillIds: state.userState.selectedSkillIds || threadState.selectedSkillIds || [],
        effectiveSkillIds: Array.isArray(threadState.effectiveSkillIds) ? threadState.effectiveSkillIds : [],
        writingGoal: state.userState.writingGoal || threadState.writingGoal,
        pendingChoice: state.userState.pendingChoice || threadState.pendingChoice,
        selectedCardIds: state.userState.selectedCardIds || threadState.selectedCardIds || [],
        sourceImageIds: state.userState.sourceImageIds || threadState.sourceImageIds || [],
        lastIntent: threadState.lastIntent,
        latestOutline: Array.isArray(threadState.latestOutline) ? threadState.latestOutline : [],
        latestAngle: typeof threadState.latestAngle === "string" ? threadState.latestAngle : undefined,
        lastGeneratedNoteId: threadState.lastGeneratedNoteId,
        lastGeneratedNoteTitle: typeof threadState.lastGeneratedNoteTitle === "string" ? threadState.lastGeneratedNoteTitle : undefined
      };
      const activeCards = toolGetActiveNetwork(dbCards, mergedState.activatedNodeIds || []);

      return {
        threadId: normalizedThreadId,
        thread,
        dbCards,
        previousMessages,
        mergedState,
        activeCards
      };
    }, (_state, update) => `thread=${update.threadId}; cards=${update.dbCards?.length || 0}`))
    .addNode("load_effective_skills", withTrace("load_effective_skills", async state => {
      const agentSkills = await resolveWriteAgentSkills(pool, state.userId, state.mergedState?.selectedSkillIds, state.mergedState?.selectedStyleSkillId);
      const styleSkill = agentSkills.find(skill => skill.type === "style")
        || await resolveWriteStyleSkill(pool, state.userId, state.mergedState?.selectedStyleSkillId);
      const userCount = agentSkills.filter(skill => skill.visibility === "user").length;
      await input.onStep?.({
        type: "partial_status",
        node: "load_effective_skills",
        message: `基础规范已加载，用户增强 Skills ${userCount} 个已启用`
      });
      return {
        styleSkill,
        agentSkills
      };
    }, (_state, update) => `baseline=${update.agentSkills?.filter(isBaselineSkill).length || 0}; user=${update.agentSkills?.filter(skill => skill.visibility === "user").length || 0}`))
    .addNode("classify_intent", withTrace("classify_intent", async state => {
      if (state.isCreateArticle) {
        return {
          intent: { tools: ["recall_cards", "generate_outline", "generate_draft"], reason: "user explicitly requested create_article", intent: "draft" },
          requestedTools: ["recall_cards", "generate_outline", "generate_draft"]
        };
      }

      const intentPrompt = `你是 AtomFlow 写作助手的路由器。默认优先基于知识库回答，不要把日常知识问题误判成闲聊。

可选工具：
- recall_cards：需要基于知识库回答、找主题、补素材、选择卡片、引用原文或来源
- get_active_network：用户在问当前网络、当前节点、围绕当前激活内容展开
- list_recent_notes：用户提到最近文章、之前草稿、继续改写
- generate_outline：用户要提纲、结构、章节安排
- generate_draft：用户明确要生成、写正文、出草稿
- just_chat：只有用户完全不涉及知识、写作、素材时使用

严格输出 JSON：{"tools":["tool_a"],"reason":"一句简短理由","intent":"knowledge_answer|select_material|outline|draft|revise|chat"}`;

      const rawIntent = await requestChat([
        { role: "system", content: intentPrompt },
        { role: "user", content: `当前状态：topic=${state.mergedState?.focusedTopic || "无"}; activeNodes=${(state.mergedState?.activatedNodeIds || []).length}; latestMessage=${state.message}` }
      ], 0.1, 300);
      const parsedIntent = safeJsonParse<{ tools?: string[]; reason?: string; intent?: string }>(rawIntent) || {};
      let requestedTools = Array.isArray(parsedIntent.tools)
        ? parsedIntent.tools.filter(tool => ["recall_cards", "get_active_network", "list_recent_notes", "generate_outline", "generate_draft", "just_chat"].includes(tool))
        : [];

      if (requestedTools.length === 0 || (requestedTools.length === 1 && requestedTools[0] === "just_chat")) {
        requestedTools = [];
      }
      if (
        requestedTools.length === 0 &&
        /(知识库|素材|节点|卡片|原文|图片|引用|来源|基于|围绕|总结|提炼|写|文章|草稿|选题|观点|证据|资料)/.test(state.message)
      ) {
        requestedTools = ["recall_cards"];
        parsedIntent.reason = "message refers to knowledge-base material";
        parsedIntent.intent = "knowledge_answer";
      }

      return { intent: parsedIntent, requestedTools };
    }, (_state, update) => `${update.requestedTools?.join(",") || "answer"}`))
    .addNode("retrieve_knowledge", withTrace("retrieve_knowledge", async state => {
      const recalledCards = state.requestedTools.includes("recall_cards")
        ? toolRecallCards(`${state.message} ${state.mergedState?.focusedTopic || ""}`, state.dbCards, state.activeCards.map(card => card.id))
        : [];
      const recentNotes = state.requestedTools.includes("list_recent_notes") || state.requestedTools.includes("generate_draft")
        ? await toolListRecentNotes(pool, state.userId, 4)
        : [];
      return { recalledCards, recentNotes };
    }, (_state, update) => `recalled=${update.recalledCards?.length || 0}`))
    .addNode("enrich_sources", withTrace("enrich_sources", state => {
      const cardsForSources = state.activeCards.length > 0
        ? state.activeCards.concat(state.recalledCards)
        : state.recalledCards;
      const sources = buildAgentSources(cardsForSources);
      return { sources };
    }, (_state, update) => `sources=${update.sources?.cards.length || 0}; images=${update.sources?.images.length || 0}`))
    .addNode("decide_next", withTrace("decide_next", state => {
      const intent = state.intent?.intent || (state.isCreateArticle ? "draft" : "knowledge_answer");
      const shouldGenerateDraft = state.isCreateArticle || state.requestedTools.includes("generate_draft");
      const shouldGenerateOutline = state.isCreateArticle || state.requestedTools.includes("generate_outline") || shouldGenerateDraft;
      const choiceCards = state.activeCards.length > 0 ? state.activeCards : state.recalledCards;
      const choices = buildAgentChoices(choiceCards, state.styleSkill);
      const pendingChoice = choiceCards.length > 0 && !shouldGenerateDraft
        ? {
          type: "card_selection" as const,
          prompt: "选择这次要使用的知识卡片，或直接生成提纲/文章。",
          cardIds: choiceCards.map(card => card.id).filter((id): id is string => typeof id === "string"),
          styleSkillIds: state.styleSkill ? [state.styleSkill.id] : [],
          createdAt: new Date().toISOString()
        }
        : undefined;
      return {
        choices,
        mergedState: {
	          ...state.mergedState,
	          lastIntent: intent,
	          pendingChoice,
	          selectedStyleSkillId: state.styleSkill?.id,
	          selectedSkillIds: state.agentSkills.filter(skill => !isBaselineSkill(skill)).map(skill => skill.id),
	          effectiveSkillIds: state.agentSkills.map(skill => skill.id)
	        },
        requestedTools: shouldGenerateOutline && !state.requestedTools.includes("generate_outline")
          ? Array.from(new Set([...state.requestedTools, "generate_outline"]))
          : state.requestedTools
      };
    }, (_state, update) => `choices=${update.choices?.length || 0}`))
    .addNode("human_selection", withTrace("human_selection", state => {
      return {
        mergedState: {
          ...state.mergedState,
          selectedCardIds: (state.activeCards.length > 0 ? state.activeCards : state.recalledCards)
            .map(card => card.id)
            .filter((id): id is string => typeof id === "string")
        }
      };
    }, (_state, update) => `selected=${update.mergedState?.selectedCardIds?.length || 0}`))
    .addNode("generate_answer_or_draft", withTrace("generate_answer_or_draft", async state => {
      let generatedOutlineText = "";
      let generatedDraftText = "";
      let generatedPlan: WritingPlanResult | null = null;
      let persistedDraftNote: any = null;
      const shouldGenerateDraft = state.isCreateArticle || state.requestedTools.includes("generate_draft");
      const shouldGenerateOutline = state.isCreateArticle || state.requestedTools.includes("generate_outline") || shouldGenerateDraft;
      const cardsForWriting = sanitizeWritingCards(state.activeCards.length > 0 ? state.activeCards : state.recalledCards);

    if (shouldGenerateOutline) {
      await input.onStep?.({
        type: "partial_status",
        node: "generate_answer_or_draft",
        message: shouldGenerateDraft ? "正在规划文章结构" : "正在生成提纲"
      });
      if (cardsForWriting.length > 0) {
          const topicForWriting = state.mergedState?.focusedTopic || state.message;
          const planRaw = await requestChat([
            { role: "system", content: WRITING_PLAN_SYSTEM_PROMPT },
	            { role: "user", content: buildWritingPlanPrompt(topicForWriting, cardsForWriting, sanitizeWritingCards(state.recalledCards), state.styleSkill, state.agentSkills) }
          ], 0.25, 1200);
          generatedPlan = sanitizeWritingPlan(safeJsonParse<WritingPlanResult>(planRaw), topicForWriting);
          generatedOutlineText = generatedPlan.outline.map(item => `- ${item.heading}：${item.goal}`).join("\n");
          const evidenceMap = buildEvidenceMap(generatedPlan, cardsForWriting);

          if (shouldGenerateDraft) {
            await input.onStep?.({
              type: "partial_status",
              node: "generate_answer_or_draft",
              message: "正在生成完整文章草稿"
            });
            generatedDraftText = await requestChat([
              { role: "system", content: WRITING_AGENT_SYSTEM_PROMPT },
		              { role: "user", content: buildDraftPrompt(topicForWriting, generatedPlan, cardsForWriting, sanitizeWritingCards(state.recalledCards), evidenceMap, state.styleSkill, state.agentSkills) }
            ], 0.38, 1800);

            if (generatedDraftText.trim()) {
              const preparedDraft = prepareAgentDraftForNote(generatedDraftText, generatedPlan.title);
              await input.onStep?.({
                type: "partial_status",
                node: "persist_memory",
                message: "正在保存文章与引用链路"
              });
              const activationSummaryForNote = (state.mergedState?.activationSummary || []).length > 0
                ? (state.mergedState?.activationSummary || [])
                : cardsForWriting.slice(0, 5).map(card => `${card.type} · ${card.content.slice(0, 20)}`);
              persistedDraftNote = await createAgentDraftNote(pool, state.userId, {
                title: generatedPlan.title,
                content: preparedDraft.html,
		                topic: topicForWriting,
		                style: generatedPlan.style,
		                outline: generatedPlan.outline,
	                evidenceMap,
                activeCards: cardsForWriting,
                activationSummary: activationSummaryForNote,
	                sourceArticles: buildSourceArticlesFromCards(cardsForWriting, state.dbCards),
	                styleSkillSnapshot: state.styleSkill ? buildStyleSkillSnapshot(state.styleSkill) : undefined,
	                skillSnapshots: buildAgentSkillSnapshots(state.agentSkills),
	                effectiveSkillSnapshots: {
	                  baselineSkills: buildAgentSkillSnapshots(state.agentSkills.filter(isBaselineSkill)),
	                  userSelectedSkills: buildAgentSkillSnapshots(state.agentSkills.filter(skill => !isBaselineSkill(skill)))
	                }
	              });
            }
          }
        } else if (state.isCreateArticle) {
          throw new Error("知识库中没有可用的卡片，请先收藏一些文章并提取知识卡片");
        }
      }

      const systemPrompt = `你是 AtomFlow 的写作助手 Agent。默认基于用户知识库回答，不要频繁反问。

规则：
1. 先用知识库、线程上下文和激活网络回答。
2. 回答要短、具体、可执行。
3. 引用知识节点时，用「来自《文章标题》」或节点编号标注来源。
4. 优先使用文章背景、卡片语境、原文摘录、引用建议和原文图片。
5. 如果信息不足，先给出当前可判断的部分，再列出可点击的下一步，而不是空泛追问。
6. 如果已生成文章草稿，简要说明使用了哪些节点和来源。
7. 当前风格 Skill：${state.styleSkill?.name || "默认"}。${state.styleSkill?.prompt || ""}
8. 当前适用 Skills：
${formatAgentSkillInstructions(state.agentSkills, ["citation", "writing", "style"]) || "默认规范"}`;

      const userContextPrompt = `当前线程摘要：
${typeof state.thread?.summary === "string" && state.thread.summary.trim() ? state.thread.summary : "暂无摘要"}

当前状态：
- focusedTopic: ${state.mergedState?.focusedTopic || "无"}
- activatedNodeIds: ${(state.mergedState?.activatedNodeIds || []).join("、") || "无"}
- activationSummary: ${(state.mergedState?.activationSummary || []).join(" | ") || "无"}
- styleSkill: ${state.styleSkill?.name || "默认"}
- skills: ${state.agentSkills.map(skill => `${skill.type}:${skill.name}`).join(" | ") || "默认"}

当前激活节点：
${state.activeCards.length > 0 ? sanitizeWritingCards(state.activeCards).map((card, index) => formatCardForWriting(card, index)).join("\n\n") : "无"}

补充召回节点：
${state.recalledCards.length > 0 ? sanitizeWritingCards(state.recalledCards).map((card, index) => formatCardForWriting(card, index)).join("\n\n") : "无"}

最近文章草稿：
${state.recentNotes.length > 0 ? state.recentNotes.map((note, index) => `${index + 1}. ${note.title}\n${normalizePlainText(note.content).slice(0, 180)}`).join("\n\n") : "无"}

提纲工具结果：
${generatedOutlineText || "无"}

正文工具结果：
${generatedDraftText ? generatedDraftText.slice(0, 5000) : "无"}

用户最新消息：
${state.message}`;

      const assistantContent = state.isCreateArticle && persistedDraftNote
        ? [
          `已基于当前激活网络创建文章《${persistedDraftNote.title || generatedPlan?.title || "未命名文章"}》。`,
          "",
          `这次使用了 ${cardsForWriting.length} 个知识节点，来源文章 ${buildSourceArticlesFromCards(cardsForWriting, state.dbCards).length} 篇。`,
          state.styleSkill ? `写作风格：${state.styleSkill.name}` : "",
          generatedPlan?.angle ? `核心判断：${generatedPlan.angle}` : "",
          "你可以在「我的文章」里继续编辑；知识节点、原文摘录、来源图片和引用映射已经写入文章元信息。"
        ].filter(Boolean).join("\n")
        : await requestChat([
          { role: "system", content: systemPrompt },
          ...state.previousMessages
            .filter((item): item is typeof item & { role: "user" | "assistant" } => item.role === "user" || item.role === "assistant")
            .map(item => ({ role: item.role, content: item.content }))
            .slice(-10),
          { role: "user", content: userContextPrompt }
        ], 0.55, 1200);

      return {
        generatedOutlineText,
        generatedDraftText,
        generatedPlan,
        persistedDraftNote,
        assistantContent
      };
    }, (_state, update) => update.persistedDraftNote ? `note=${update.persistedDraftNote.id}` : `answer=${(update.assistantContent || "").length}`))
    .addNode("persist_memory", withTrace("persist_memory", async state => {
      if (!state.assistantContent) throw new Error("agent returned empty message");

      const cardsForSources = state.activeCards.length > 0
        ? state.activeCards.concat(state.recalledCards)
        : state.recalledCards;
      const sources = state.sources || buildAgentSources(cardsForSources);
      const selectedCardIds = (state.mergedState?.selectedCardIds || []).length > 0
        ? state.mergedState?.selectedCardIds || []
        : sources.cards.map(card => card.id).filter((id): id is string => typeof id === "string");
      const toolPayload = {
        requestedTools: state.requestedTools,
        reason: state.intent?.reason || "",
        activeCardIds: state.activeCards.map(card => card.id),
        recalledCardIds: state.recalledCards.map(card => card.id),
        outline: state.generatedPlan?.outline || [],
        draftPreview: (state.generatedDraftText || "").slice(0, 400),
        noteId: state.persistedDraftNote ? Number(state.persistedDraftNote.id) : undefined,
        noteTitle: state.persistedDraftNote?.title,
        noteSaved: Boolean(state.persistedDraftNote),
        noteTopic: state.mergedState?.focusedTopic || state.message,
        choices: state.choices,
	        sources,
	        graphTrace: state.graphTrace,
	        skillSnapshots: buildAgentSkillSnapshots(state.agentSkills),
	        effectiveSkills: buildAgentSkillSnapshots(state.agentSkills),
	        effectiveSkillSnapshots: {
	          baselineSkills: buildAgentSkillSnapshots(state.agentSkills.filter(isBaselineSkill)),
	          userSelectedSkills: buildAgentSkillSnapshots(state.agentSkills.filter(skill => !isBaselineSkill(skill)))
	        }
	      };

      if (state.requestedTools.length > 0) {
        await pool.query(
          `INSERT INTO write_agent_messages (thread_id, role, content, meta)
           VALUES ($1, 'tool', $2, $3)`,
          [
            state.threadId,
            [
              `tools: ${state.requestedTools.join(", ")}`,
              state.generatedOutlineText ? `outline:\n${state.generatedOutlineText}` : "",
              state.generatedDraftText ? `draft:\n${state.generatedDraftText.slice(0, 600)}` : ""
            ].filter(Boolean).join("\n\n"),
            JSON.stringify(toolPayload)
          ]
        );
      }

      const uiBlocks = buildAgentUiBlocks({
        answer: state.assistantContent,
        sources,
        selectedCardIds,
        choices: state.choices,
        note: state.persistedDraftNote
      });
      const finalPayload: any = { ...toolPayload, uiBlocks, feedback: "none", sourceCollapsed: true };
      const assistantMessageRow = (await pool.query(
        `INSERT INTO write_agent_messages (thread_id, role, content, meta)
         VALUES ($1, 'assistant', $2, $3)
         RETURNING id`,
        [state.threadId, state.assistantContent, JSON.stringify(finalPayload)]
      )).rows[0];
      const assistantMessageId = Number(assistantMessageRow.id);
      finalPayload.messageId = assistantMessageId;

      const nextState: WriteAgentState = {
        ...state.mergedState,
        activatedNodeIds: selectedCardIds.length > 0 ? selectedCardIds : state.mergedState?.activatedNodeIds || [],
        selectedCardIds,
        activationSummary: selectedCardIds.length > 0
          ? sanitizeWritingCards(sources.cards).slice(0, 5).map(card => `${card.type} · ${card.content.slice(0, 20)}`)
          : state.mergedState?.activationSummary || [],
        sourceImageIds: sources.images.map(image => image.id),
        latestOutline: state.generatedPlan?.outline || state.mergedState?.latestOutline || [],
        latestAngle: state.generatedPlan?.angle || state.mergedState?.latestAngle,
	        lastGeneratedNoteId: state.persistedDraftNote ? Number(state.persistedDraftNote.id) : state.mergedState?.lastGeneratedNoteId,
	        lastGeneratedNoteTitle: state.persistedDraftNote?.title || state.mergedState?.lastGeneratedNoteTitle,
	        selectedStyleSkillId: state.styleSkill?.id,
	        selectedSkillIds: state.agentSkills.filter(skill => !isBaselineSkill(skill)).map(skill => skill.id),
	        effectiveSkillIds: state.agentSkills.map(skill => skill.id)
	      };

      const finalMessages = await getRecentThreadMessages(pool, Number(state.threadId), 14);
      const summary = summarizeAgentMessages(finalMessages.map(item => ({ role: item.role, content: item.content })));
      await upsertThreadState(pool, Number(state.threadId), summary, nextState, state.thread?.title || inferThreadTitle(state.message));

      return {
        mergedState: nextState,
        toolPayload: finalPayload,
        assistantMessageId,
        sources,
        uiBlocks
      };
    }, (_state, update) => `uiBlocks=${update.uiBlocks?.length || 0}`))
    .addNode("respond", withTrace("respond", state => state, state => `thread=${state.threadId}`))
    .addEdge(START, "hydrate_context")
    .addEdge("hydrate_context", "load_effective_skills")
    .addEdge("load_effective_skills", "classify_intent")
    .addEdge("classify_intent", "retrieve_knowledge")
    .addEdge("retrieve_knowledge", "enrich_sources")
    .addEdge("enrich_sources", "decide_next")
    .addEdge("decide_next", "human_selection")
    .addEdge("human_selection", "generate_answer_or_draft")
    .addEdge("generate_answer_or_draft", "persist_memory")
    .addEdge("persist_memory", "respond")
    .addEdge("respond", END)
    .compile();

  const finalState = await graph.invoke({
    userId: input.userId,
    threadId: input.threadId,
    message: input.message,
    isCreateArticle: input.isCreateArticle,
    userState: input.userState,
    generatedPlan: null,
    generatedOutlineText: "",
    generatedDraftText: "",
    assistantContent: "",
    assistantMessageId: undefined
  });

  await persistAgentGraphEvents(pool, input.userId, Number(finalState.threadId), finalState.graphTrace || []);
  return finalState;
};

type OpenAIWriteAgentContext = {
  pool: pg.Pool;
  userId: number;
  dbCards: any[];
  activeCards: any[];
  recalledCards: any[];
  recentNotes: any[];
  agentSkills: WriteAgentSkillRecord[];
  styleSkill?: WriteAgentSkillRecord;
};

const formatOpenAIWriteAgentPrompt = (input: {
  thread: any;
  message: string;
  mergedState: WriteAgentState;
  activeCards: any[];
  recalledCards: any[];
  recentNotes: any[];
  generatedOutlineText: string;
  generatedDraftText: string;
  agentSkills: WriteAgentSkillRecord[];
  styleSkill?: WriteAgentSkillRecord;
}) => `当前线程摘要：
${typeof input.thread?.summary === "string" && input.thread.summary.trim() ? input.thread.summary : "暂无摘要"}

当前状态：
- focusedTopic: ${input.mergedState.focusedTopic || "无"}
- activatedNodeIds: ${(input.mergedState.activatedNodeIds || []).join("、") || "无"}
- activationSummary: ${(input.mergedState.activationSummary || []).join(" | ") || "无"}
- styleSkill: ${input.styleSkill?.name || "默认"}
- skills: ${input.agentSkills.map(skill => `${skill.type}:${skill.name}`).join(" | ") || "默认"}

当前激活节点：
${input.activeCards.length > 0 ? sanitizeWritingCards(input.activeCards).map((card, index) => formatCardForWriting(card, index)).join("\n\n") : "无"}

补充召回节点：
${input.recalledCards.length > 0 ? sanitizeWritingCards(input.recalledCards).map((card, index) => formatCardForWriting(card, index)).join("\n\n") : "无"}

最近文章草稿：
${input.recentNotes.length > 0 ? input.recentNotes.map((note, index) => `${index + 1}. ${note.title}\n${normalizePlainText(note.content).slice(0, 180)}`).join("\n\n") : "无"}

提纲工具结果：
${input.generatedOutlineText || "无"}

正文工具结果：
${input.generatedDraftText ? input.generatedDraftText.slice(0, 5000) : "无"}

用户最新消息：
${input.message}`;

const createOpenAIWriteAgentRunner = (config: OpenAIWriteAgentConfig) => {
  const tracingDisabled = config.providerLabel !== "openai";
  setTracingDisabled(tracingDisabled);
  return new Runner({
    model: config.model,
    modelProvider: new OpenAIProvider({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      useResponses: false,
      strictFeatureValidation: false
    }),
    workflowName: "AtomFlow Write Agent",
    tracingDisabled,
    traceIncludeSensitiveData: false
  });
};

const createWriteAgentSdkTools = () => {
  const recallCardsTool = tool({
    name: "recallCardsTool",
    description: "Return already-recalled AtomFlow knowledge cards for the current writing request.",
    parameters: z.object({ reason: z.string().optional() }),
    execute: async (_input: { reason?: string }, runContext: any) => {
      const context = runContext?.context as OpenAIWriteAgentContext | undefined;
      const cards = context?.recalledCards || [];
      return {
        cards: cards.slice(0, 8),
        reason: cards.length > 0 ? "matched local weighted knowledge recall" : "no relevant cards were found",
        confidence: cards.length >= 3 ? "medium" : cards.length > 0 ? "low" : "none"
      };
    }
  });

  const listRecentNotesTool = tool({
    name: "listRecentNotesTool",
    description: "Return recent AtomFlow draft notes for continuation or rewrite tasks.",
    parameters: z.object({ limit: z.number().int().min(1).max(6).optional() }),
    execute: async (input: { limit?: number }, runContext: any) => {
      const context = runContext?.context as OpenAIWriteAgentContext | undefined;
      return (context?.recentNotes || []).slice(0, input.limit || 4);
    }
  });

  const getEffectiveSkillsTool = tool({
    name: "getEffectiveSkillsTool",
    description: "Return baseline writing rules and user-selected style skills active for this run.",
    parameters: z.object({}),
    execute: async (_input: Record<string, never>, runContext: any) => {
      const context = runContext?.context as OpenAIWriteAgentContext | undefined;
      const skills = context?.agentSkills || [];
      return {
        baselineSkills: buildAgentSkillSnapshots(skills.filter(isBaselineSkill)),
        userSelectedSkills: buildAgentSkillSnapshots(skills.filter(skill => !isBaselineSkill(skill)))
      };
    }
  });

  return [recallCardsTool, listRecentNotesTool, getEffectiveSkillsTool];
};

const writeAgentInputGuardrail = {
  name: "write-agent-input-size",
  runInParallel: false,
  execute: async ({ input }) => {
    const text = typeof input === "string" ? input : JSON.stringify(input);
    return {
      tripwireTriggered: text.trim().length === 0 || text.length > WRITE_AGENT_MAX_MESSAGE_LENGTH,
      outputInfo: { length: text.length }
    };
  }
};

const writeAgentOutputGuardrail = {
  name: "write-agent-source-discipline",
  execute: async ({ agentOutput }) => {
    const text = typeof agentOutput === "string" ? agentOutput : JSON.stringify(agentOutput);
    return {
      tripwireTriggered: false,
      outputInfo: {
        mentionsInsufficientInfo: /不足|没有|未召回|缺少/.test(text),
        mentionsSource: /来自《|来源|节点/.test(text)
      }
    };
  }
};

const runOpenAIWriteAgentRuntime = async (
  pool: pg.Pool,
  input: {
    userId: number;
    threadId?: number;
    message: string;
    isCreateArticle: boolean;
    userState: WriteAgentState;
    runId?: string;
    onStep?: (event: { type: string; node?: string; message?: string; data?: unknown }) => void | Promise<void>;
    onProviderStart?: () => void | Promise<void>;
  }
): Promise<WriteAgentGraphState> => {
  const config = getOpenAIWriteAgentConfig();
  if (!config) throw new Error("OpenAI writing agent is not configured: set OPENAI_API_KEY and OPENAI_MODEL");

  const runId = input.runId || randomUUID();
  const runStartedAt = Date.now();
  const runner = createOpenAIWriteAgentRunner(config);
  const sdkTools = createWriteAgentSdkTools();
  const trace: WriteAgentGraphTraceRecord[] = [];
  const withStep = async <T,>(node: string, label: string, fn: () => Promise<{ value: T; summary?: string; meta?: Record<string, unknown> }>) => {
    const started = Date.now();
    await input.onStep?.({ type: "step_start", node, message: getWriteAgentNodeLabel(node, "start") });
    const result = await fn();
    const traceItem: WriteAgentGraphTraceRecord = {
      node,
      durationMs: Date.now() - started,
      inputSummary: normalizePlainText(input.message).slice(0, 160),
      outputSummary: result.summary || label,
      meta: { ...(result.meta || {}), runId },
      createdAt: new Date().toISOString()
    };
    trace.push(traceItem);
    await input.onStep?.({ type: "step_end", node, message: getWriteAgentNodeLabel(node, "end"), data: traceItem });
    return result.value;
  };

  let thread: any;
  let dbCards: any[] = [];
  let previousMessages: any[] = [];
  let mergedState: WriteAgentState = {};
  let activeCards: any[] = [];

  const threadId = await withStep("hydrate_context", "context hydrated", async () => {
    thread = input.threadId
      ? (await pool.query(
        `SELECT id, title, summary, state, created_at, updated_at
         FROM write_agent_threads
         WHERE id = $1 AND user_id = $2`,
        [input.threadId, input.userId]
      )).rows[0]
      : null;
    if (!thread) {
      thread = (await pool.query(
        `INSERT INTO write_agent_threads (user_id, title, state, thread_type)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, summary, state, thread_type, created_at, updated_at`,
        [input.userId, inferThreadTitle(input.message), JSON.stringify({}), "chat"]
      )).rows[0];
    }
    const normalizedThreadId = Number(thread.id);
    await pool.query(
      `INSERT INTO write_agent_messages (thread_id, role, content, meta)
       VALUES ($1, 'user', $2, $3)`,
      [normalizedThreadId, input.message, JSON.stringify({ state: input.userState, action: input.isCreateArticle ? "create_article" : undefined })]
    );
    dbCards = await fetchUserSavedCards(pool, input.userId);
    previousMessages = await getRecentThreadMessages(pool, normalizedThreadId, 14);
    const threadState = (thread.state || {}) as WriteAgentState;
    mergedState = {
      focusedTopic: input.userState.focusedTopic || threadState.focusedTopic,
      activatedNodeIds: input.userState.activatedNodeIds || threadState.activatedNodeIds || [],
      activationSummary: input.userState.activationSummary || threadState.activationSummary || [],
      selectedStyleSkillId: input.userState.selectedStyleSkillId || threadState.selectedStyleSkillId,
      selectedSkillIds: input.userState.selectedSkillIds || threadState.selectedSkillIds || [],
      effectiveSkillIds: Array.isArray(threadState.effectiveSkillIds) ? threadState.effectiveSkillIds : [],
      writingGoal: input.userState.writingGoal || threadState.writingGoal,
      pendingChoice: input.userState.pendingChoice || threadState.pendingChoice,
      selectedCardIds: input.userState.selectedCardIds || threadState.selectedCardIds || [],
      sourceImageIds: threadState.sourceImageIds || [],
      lastIntent: threadState.lastIntent,
      latestOutline: Array.isArray(threadState.latestOutline) ? threadState.latestOutline : [],
      latestAngle: typeof threadState.latestAngle === "string" ? threadState.latestAngle : undefined,
      lastGeneratedNoteId: threadState.lastGeneratedNoteId,
      lastGeneratedNoteTitle: typeof threadState.lastGeneratedNoteTitle === "string" ? threadState.lastGeneratedNoteTitle : undefined
    };
    activeCards = toolGetActiveNetwork(dbCards, mergedState.activatedNodeIds || []);
    return { value: normalizedThreadId, summary: `thread=${normalizedThreadId}; cards=${dbCards.length}` };
  });

  let agentSkills: WriteAgentSkillRecord[] = [];
  let styleSkill: WriteAgentSkillRecord | undefined;
  await withStep("load_effective_skills", "skills loaded", async () => {
    agentSkills = await resolveWriteAgentSkills(pool, input.userId, mergedState.selectedSkillIds, mergedState.selectedStyleSkillId);
    styleSkill = agentSkills.find(skill => skill.type === "style")
      || await resolveWriteStyleSkill(pool, input.userId, mergedState.selectedStyleSkillId);
    await input.onStep?.({
      type: "partial_status",
      node: "load_effective_skills",
      message: `OpenAI Agents SDK 已加载基础规范，用户增强 Skills ${agentSkills.filter(skill => skill.visibility === "user").length} 个已启用`
    });
    return {
      value: null,
      summary: `baseline=${agentSkills.filter(isBaselineSkill).length}; user=${agentSkills.filter(skill => skill.visibility === "user").length}`,
      meta: { sdk: "openai-agents", provider: config.providerLabel, model: config.model }
    };
  });

  const { intent, requestedTools } = await withStep("classify_intent", "intent classified locally", async () => {
    let classified: WriteAgentIntentClassification = classifyWriteAgentIntent(input.message, input.isCreateArticle);
    if (classified.intent.needsModelRouter) {
      await input.onProviderStart?.();
      const rawIntent = await requestAiChatCompletion([
        {
          role: "system",
          content: `你是 AtomFlow 写作助手的轻量路由器。只输出 JSON。
可选 intent: chat, select_material, outline, draft, revise, continue_note。
可选 tools: recall_cards, get_active_network, list_recent_notes, generate_outline, generate_draft, revise_note。
不要把普通闲聊误判为写作任务；但用户提到素材、知识库、来源、文章、草稿、提纲、我的文章时要选择对应工具。`
        },
        { role: "user", content: input.message }
      ], {
        temperature: 0.1,
        maxTokens: 260,
        logLabel: "write_agent_intent_router",
        disableThinking: true,
        config: getWriteAgentAiChatConfig(config),
      });
      classified = mergeWriteAgentModelRouterResult(
        classified,
        safeJsonParse<{ tools?: unknown; intent?: unknown; reason?: unknown }>(rawIntent)
      );
    }
    return {
      value: classified,
      summary: classified.requestedTools.join(",") || "answer",
      meta: {
        router: classified.intent.needsModelRouter ? "local_rules_with_model_fallback" : "local_rules",
        intent: classified.intent.intent,
        requestedTools: classified.requestedTools,
        confidence: classified.intent.confidence
      }
    };
  });

  let recalledCards: any[] = [];
  let recentNotes: any[] = [];
  await withStep("retrieve_knowledge", "knowledge retrieved", async () => {
    recalledCards = requestedTools.includes("recall_cards")
      ? toolRecallCards(`${input.message} ${mergedState.focusedTopic || ""}`, dbCards, activeCards.map(card => card.id))
      : [];
    recentNotes = requestedTools.includes("list_recent_notes") || requestedTools.includes("generate_draft")
      ? await toolListRecentNotes(pool, input.userId, 4)
      : [];
    return {
      value: null,
      summary: `recalled=${recalledCards.length}`,
      meta: { requestedTools, activeCards: activeCards.length, recalledCards: recalledCards.length }
    };
  });

  const sources = await withStep("enrich_sources", "sources enriched", async () => {
    const cardsForSources = activeCards.length > 0 ? activeCards.concat(recalledCards) : recalledCards;
    const built = buildAgentSources(cardsForSources);
    return { value: built, summary: `sources=${built.cards.length}; images=${built.images.length}` };
  });

  let choices: WriteAgentChoiceRecord[] = [];
  await withStep("decide_next", "next actions prepared", async () => {
    const shouldGenerateDraft = input.isCreateArticle || requestedTools.includes("generate_draft");
    const shouldGenerateOutline = input.isCreateArticle || requestedTools.includes("generate_outline") || shouldGenerateDraft;
    const choiceCards = activeCards.length > 0 ? activeCards : recalledCards;
    choices = buildAgentChoices(choiceCards, styleSkill);
    mergedState = {
      ...mergedState,
      lastIntent: intent.intent,
      pendingChoice: choiceCards.length > 0 && !shouldGenerateDraft
        ? {
          type: "card_selection",
          prompt: "选择这次要使用的知识卡片，或直接生成提纲/文章。",
          cardIds: choiceCards.map(card => card.id).filter((id): id is string => typeof id === "string"),
          styleSkillIds: styleSkill ? [styleSkill.id] : [],
          createdAt: new Date().toISOString()
        }
        : undefined,
      selectedStyleSkillId: styleSkill?.id,
      selectedSkillIds: agentSkills.filter(skill => !isBaselineSkill(skill)).map(skill => skill.id),
      effectiveSkillIds: agentSkills.map(skill => skill.id)
    };
    if (shouldGenerateOutline && !requestedTools.includes("generate_outline")) requestedTools.push("generate_outline");
    return { value: null, summary: `choices=${choices.length}`, meta: { requestedTools } };
  });

  await withStep("human_selection", "selection synced", async () => {
    mergedState = {
      ...mergedState,
      selectedCardIds: (activeCards.length > 0 ? activeCards : recalledCards)
        .map(card => card.id)
        .filter((id): id is string => typeof id === "string")
    };
    if ((mergedState.selectedCardIds || []).length > 0) {
      await input.onStep?.({
        type: "activation",
        node: "human_selection",
        message: "已同步激活知识节点",
        data: {
          activatedNodeIds: mergedState.selectedCardIds,
          activationSummary: mergedState.activationSummary || []
        }
      });
    }
    return { value: null, summary: `selected=${mergedState.selectedCardIds?.length || 0}` };
  });

  const sdkContext: OpenAIWriteAgentContext = {
    pool,
    userId: input.userId,
    dbCards,
    activeCards,
    recalledCards,
    recentNotes,
    agentSkills,
    styleSkill
  };
  const materialAgent = new Agent<OpenAIWriteAgentContext>({
    name: "MaterialAgent",
    handoffDescription: "Select and explain relevant AtomFlow knowledge cards for writing tasks.",
    model: config.model,
    modelSettings: { maxTokens: getCanvasAgentMaxOutputTokens() },
    instructions: "你负责判断召回素材是否足以支撑写作任务。必须明确素材不足，不要伪造来源。",
    tools: sdkTools,
    inputGuardrails: [writeAgentInputGuardrail],
    outputGuardrails: [writeAgentOutputGuardrail]
  });
  const outlineAgent = new Agent<OpenAIWriteAgentContext>({
    name: "OutlineAgent",
    handoffDescription: "Generate article angles and outlines from AtomFlow knowledge cards.",
    model: config.model,
    modelSettings: { maxTokens: getCanvasAgentMaxOutputTokens() },
    instructions: WRITING_PLAN_SYSTEM_PROMPT,
    inputGuardrails: [writeAgentInputGuardrail],
    outputGuardrails: [writeAgentOutputGuardrail]
  });
  const draftAgent = new Agent<OpenAIWriteAgentContext>({
    name: "DraftAgent",
    handoffDescription: "Write article drafts from outlines, cards, citations and style skills.",
    model: config.model,
    modelSettings: { maxTokens: getCanvasAgentMaxOutputTokens() },
    instructions: WRITING_AGENT_SYSTEM_PROMPT,
    inputGuardrails: [writeAgentInputGuardrail],
    outputGuardrails: [writeAgentOutputGuardrail]
  });
  const coordinatorAgent = new Agent<OpenAIWriteAgentContext>({
    name: "CoordinatorAgent",
    handoffDescription: "Coordinate AtomFlow writing tasks and produce final user-facing answers.",
    model: config.model,
    modelSettings: { maxTokens: getCanvasAgentMaxOutputTokens() },
    instructions: `你是 AtomFlow 的写作助手 Agent。默认基于用户知识库回答，不要频繁反问。

规则：
1. 先用知识库、线程上下文和激活网络回答。
2. 回答要短、具体、可执行。
3. 引用知识节点时，用「来自《文章标题》」或节点编号标注来源。
4. 如果信息不足，必须明确说「当前素材不足」，再列出下一步。
5. 不要伪造来源、图片、数据或文章。
6. 当前风格 Skill：${styleSkill?.name || "默认"}。${styleSkill?.prompt || ""}
7. 当前适用 Skills：
${formatAgentSkillInstructions(agentSkills, ["citation", "writing", "style"]) || "默认规范"}`,
    tools: sdkTools,
    handoffs: [materialAgent, outlineAgent, draftAgent],
    inputGuardrails: [writeAgentInputGuardrail],
    outputGuardrails: [writeAgentOutputGuardrail]
  });

  let generatedOutlineText = "";
  let generatedDraftText = "";
  let generatedPlan: WritingPlanResult | null = null;
  let persistedDraftNote: any = null;
  let assistantContent = "";
  const cardsForWriting = sanitizeWritingCards(activeCards.length > 0 ? activeCards : recalledCards);
  await withStep("generate_answer_or_draft", "generated via OpenAI Agents SDK", async () => {
    const shouldGenerateDraft = input.isCreateArticle || requestedTools.includes("generate_draft");
    const shouldGenerateOutline = input.isCreateArticle || requestedTools.includes("generate_outline") || shouldGenerateDraft;
    if (shouldGenerateOutline) {
      if (cardsForWriting.length === 0 && input.isCreateArticle) {
        throw new Error("知识库中没有可用的卡片，请先收藏一些文章并提取知识卡片");
      }
      if (cardsForWriting.length > 0) {
        await input.onStep?.({ type: "partial_status", node: "generate_answer_or_draft", message: shouldGenerateDraft ? "正在规划文章结构" : "正在生成提纲" });
        const topicForWriting = mergedState.focusedTopic || input.message;
        await input.onProviderStart?.();
        const planResult = await runner.run(outlineAgent, buildWritingPlanPrompt(topicForWriting, cardsForWriting, sanitizeWritingCards(recalledCards), styleSkill, agentSkills), {
          context: sdkContext,
          maxTurns: 4
        });
        generatedPlan = sanitizeWritingPlan(safeJsonParse<WritingPlanResult>(String(planResult.finalOutput || "")), topicForWriting);
        generatedOutlineText = generatedPlan.outline.map(item => `- ${item.heading}：${item.goal}`).join("\n");
        const evidenceMap = buildEvidenceMap(generatedPlan, cardsForWriting);
        if (shouldGenerateDraft) {
          await input.onStep?.({ type: "partial_status", node: "generate_answer_or_draft", message: "正在生成完整文章草稿" });
          await input.onProviderStart?.();
          const draftResult = await runner.run(draftAgent, buildDraftPrompt(topicForWriting, generatedPlan, cardsForWriting, sanitizeWritingCards(recalledCards), evidenceMap, styleSkill, agentSkills), {
            context: sdkContext,
            maxTurns: 4
          });
          generatedDraftText = String(draftResult.finalOutput || "").trim();
          if (generatedDraftText) {
            const preparedDraft = prepareAgentDraftForNote(generatedDraftText, generatedPlan.title);
            await input.onStep?.({ type: "partial_status", node: "persist_memory", message: "正在保存文章与引用链路" });
            const activationSummaryForNote = (mergedState.activationSummary || []).length > 0
              ? mergedState.activationSummary || []
              : cardsForWriting.slice(0, 5).map(card => `${card.type} · ${card.content.slice(0, 20)}`);
            persistedDraftNote = await createAgentDraftNote(pool, input.userId, {
              title: generatedPlan.title,
              content: preparedDraft.html,
              topic: topicForWriting,
              style: generatedPlan.style,
              outline: generatedPlan.outline,
              evidenceMap,
              activeCards: cardsForWriting,
              activationSummary: activationSummaryForNote,
              sourceArticles: buildSourceArticlesFromCards(cardsForWriting, dbCards),
              styleSkillSnapshot: styleSkill ? buildStyleSkillSnapshot(styleSkill) : undefined,
              skillSnapshots: buildAgentSkillSnapshots(agentSkills),
              effectiveSkillSnapshots: {
                baselineSkills: buildAgentSkillSnapshots(agentSkills.filter(isBaselineSkill)),
                userSelectedSkills: buildAgentSkillSnapshots(agentSkills.filter(skill => !isBaselineSkill(skill)))
              }
            });
          }
        }
      }
    }

    assistantContent = input.isCreateArticle && persistedDraftNote
      ? [
        `已基于当前激活网络创建文章《${persistedDraftNote.title || generatedPlan?.title || "未命名文章"}》。`,
        "",
        `这次使用了 ${cardsForWriting.length} 个知识节点，来源文章 ${buildSourceArticlesFromCards(cardsForWriting, dbCards).length} 篇。`,
        styleSkill ? `写作风格：${styleSkill.name}` : "",
        generatedPlan?.angle ? `核心判断：${generatedPlan.angle}` : "",
        "你可以在「我的文章」里继续编辑；知识节点、原文摘录、来源图片和引用映射已经写入文章元信息。"
      ].filter(Boolean).join("\n")
      : String((await (async () => {
        await input.onProviderStart?.();
        return runner.run(coordinatorAgent, formatOpenAIWriteAgentPrompt({
        thread,
        message: input.message,
        mergedState,
        activeCards,
        recalledCards,
        recentNotes,
        generatedOutlineText,
        generatedDraftText,
        agentSkills,
        styleSkill
        }), {
          context: sdkContext,
          maxTurns: 6
        });
      })()).finalOutput || "").trim();
    return { value: null, summary: persistedDraftNote ? `note=${persistedDraftNote.id}` : `answer=${assistantContent.length}`, meta: { sdk: "openai-agents", provider: config.providerLabel, model: config.model } };
  });

  if (!assistantContent) throw new Error("agent returned empty message");

  let toolPayload: any;
  let assistantMessageId: number | undefined;
  let uiBlocks: any[] = [];
  await withStep("persist_memory", "memory persisted", async () => {
    const selectedCardIds = (mergedState.selectedCardIds || []).length > 0
      ? mergedState.selectedCardIds || []
      : sources.cards.map(card => card.id).filter((id): id is string => typeof id === "string");
    toolPayload = {
      runId,
      requestedTools,
      intent: intent.intent,
      reason: intent.reason || "",
      activeCardIds: activeCards.map(card => card.id),
      recalledCardIds: recalledCards.map(card => card.id),
      outline: generatedPlan?.outline || [],
      draftPreview: (generatedDraftText || "").slice(0, 400),
      noteId: persistedDraftNote ? Number(persistedDraftNote.id) : undefined,
      noteTitle: persistedDraftNote?.title,
      noteSaved: Boolean(persistedDraftNote),
      noteTopic: mergedState.focusedTopic || input.message,
      choices,
      sources,
      graphTrace: trace,
      skillSnapshots: buildAgentSkillSnapshots(agentSkills),
      effectiveSkills: buildAgentSkillSnapshots(agentSkills),
      effectiveSkillSnapshots: {
        baselineSkills: buildAgentSkillSnapshots(agentSkills.filter(isBaselineSkill)),
        userSelectedSkills: buildAgentSkillSnapshots(agentSkills.filter(skill => !isBaselineSkill(skill)))
      },
      runtime: "openai-agents-sdk",
      provider: config.providerLabel,
      model: config.model
    };
    if (requestedTools.length > 0) {
      await pool.query(
        `INSERT INTO write_agent_messages (thread_id, role, content, meta)
         VALUES ($1, 'tool', $2, $3)`,
        [
          threadId,
          [
            `tools: ${requestedTools.join(", ")}`,
            generatedOutlineText ? `outline:\n${generatedOutlineText}` : "",
            generatedDraftText ? `draft:\n${generatedDraftText.slice(0, 600)}` : ""
          ].filter(Boolean).join("\n\n"),
          JSON.stringify(toolPayload)
        ]
      );
    }
    uiBlocks = buildAgentUiBlocks({
      answer: assistantContent,
      sources,
      selectedCardIds,
      choices,
      note: persistedDraftNote
    });
    const finalPayload = { ...toolPayload, uiBlocks, feedback: "none", sourceCollapsed: true };
    const assistantMessageRow = (await pool.query(
      `INSERT INTO write_agent_messages (thread_id, role, content, meta)
       VALUES ($1, 'assistant', $2, $3)
       RETURNING id`,
      [threadId, assistantContent, JSON.stringify(finalPayload)]
    )).rows[0];
    assistantMessageId = Number(assistantMessageRow.id);
    finalPayload.messageId = assistantMessageId;
    toolPayload = finalPayload;
    const nextState: WriteAgentState = {
      ...mergedState,
      activatedNodeIds: selectedCardIds.length > 0 ? selectedCardIds : mergedState.activatedNodeIds || [],
      selectedCardIds,
      activationSummary: selectedCardIds.length > 0
        ? sanitizeWritingCards(sources.cards).slice(0, 5).map(card => `${card.type} · ${card.content.slice(0, 20)}`)
        : mergedState.activationSummary || [],
      sourceImageIds: sources.images.map(image => image.id),
      latestOutline: generatedPlan?.outline || mergedState.latestOutline || [],
      latestAngle: generatedPlan?.angle || mergedState.latestAngle,
      lastGeneratedNoteId: persistedDraftNote ? Number(persistedDraftNote.id) : mergedState.lastGeneratedNoteId,
      lastGeneratedNoteTitle: persistedDraftNote?.title || mergedState.lastGeneratedNoteTitle,
      selectedStyleSkillId: styleSkill?.id,
      selectedSkillIds: agentSkills.filter(skill => !isBaselineSkill(skill)).map(skill => skill.id),
      effectiveSkillIds: agentSkills.map(skill => skill.id)
    };
    const finalMessages = await getRecentThreadMessages(pool, threadId, 14);
    const summary = summarizeAgentMessages(finalMessages.map(item => ({ role: item.role, content: item.content })));
    await upsertThreadState(pool, threadId, summary, nextState, thread?.title || inferThreadTitle(input.message));
    mergedState = nextState;
    if (selectedCardIds.length > 0) {
      await input.onStep?.({
        type: "activation",
        node: "persist_memory",
        message: "已同步激活知识节点",
        data: {
          activatedNodeIds: selectedCardIds,
          activationSummary: nextState.activationSummary || []
        }
      });
    }
    return { value: null, summary: `uiBlocks=${uiBlocks.length}`, meta: { requestedTools, activeCards: activeCards.length, recalledCards: recalledCards.length } };
  });

  await withStep("respond", "response ready", async () => ({ value: null, summary: `thread=${threadId}` }));
  await persistAgentGraphEvents(pool, input.userId, threadId, trace, runId);
  await persistAgentRunEvent(pool, {
    userId: input.userId,
    threadId,
    runId,
    status: "completed",
    durationMs: Date.now() - runStartedAt,
    intent: intent.intent,
    requestedTools,
    provider: config.providerLabel,
    model: config.model,
    noteId: persistedDraftNote ? Number(persistedDraftNote.id) : undefined
  });

  return {
    userId: input.userId,
    threadId,
    thread,
    message: input.message,
    isCreateArticle: input.isCreateArticle,
    userState: input.userState,
    mergedState,
    previousMessages,
    dbCards,
    activeCards,
    recalledCards,
    recentNotes,
    intent,
    requestedTools,
    styleSkill,
    agentSkills,
    generatedPlan,
    generatedOutlineText,
    generatedDraftText,
    persistedDraftNote,
    assistantContent,
    assistantMessageId,
    toolPayload,
    sources,
    choices,
    uiBlocks,
    graphTrace: trace
  } as WriteAgentGraphState;
};

const SkillCreationGraphAnnotation = Annotation.Root({
  userId: Annotation<number>(),
  userInput: Annotation<string>(),
  sampleText: Annotation<string | undefined>(),
  inputType: Annotation<"description" | "sample" | "both">(),
  extractedFeatures: Annotation<{
    tone?: string[];
    structure?: string[];
    citationStyle?: string;
    constraints?: string[];
    examples?: string[];
  }>(),
  generatedSkill: Annotation<{
    name: string;
    description: string;
    prompt: string;
    constraints: string[];
    examples: string[];
  }>(),
  validationErrors: Annotation<string[]>({ reducer: (_left, right) => right, default: () => [] }),
  graphTrace: Annotation<any[]>({ reducer: (left, right) => left.concat(right), default: () => [] })
});

type SkillCreationGraphState = typeof SkillCreationGraphAnnotation.State;

const runSkillCreationGraph = async (
  pool: pg.Pool,
  input: {
    userId: number;
    userInput: string;
    sampleText?: string;
    onStep?: (event: { type: string; node?: string; message?: string; data?: unknown }) => void | Promise<void>;
    onProviderStart?: () => void | Promise<void>;
  }
) => {
  const requestChat = async (messages: AiChatMessage[], temperature: number, maxTokens: number) => {
    await input.onProviderStart?.();
    return requestAiChatCompletion(messages, {
      temperature,
      maxTokens,
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
      logLabel: "skill_creation_graph",
      disableThinking: true
    });
  };

  const withTrace = (
    node: string,
    handler: (state: SkillCreationGraphState) => Promise<Partial<SkillCreationGraphState>> | Partial<SkillCreationGraphState>
  ) => async (state: SkillCreationGraphState) => {
    const started = Date.now();
    await input.onStep?.({ type: "step_start", node, message: `开始 ${node}` });
    const update = await handler(state);
    const traceItem = { node, durationMs: Date.now() - started, createdAt: new Date().toISOString() };
    await input.onStep?.({ type: "step_end", node, message: `完成 ${node}`, data: traceItem });
    return { ...update, graphTrace: [traceItem] };
  };

  const graph = new StateGraph(SkillCreationGraphAnnotation)
    .addNode("analyze_user_input", withTrace("analyze_user_input", async state => {
      const hasSample = Boolean(state.sampleText && state.sampleText.trim().length > 20);
      const hasDescription = Boolean(state.userInput && state.userInput.trim().length > 10);

      let inputType: "description" | "sample" | "both" = "description";
      if (hasSample && hasDescription) inputType = "both";
      else if (hasSample) inputType = "sample";

      await input.onStep?.({ type: "partial_status", node: "analyze_user_input", message: `输入类型: ${inputType}` });
      return { inputType };
    }))
    .addNode("extract_style_features", withTrace("extract_style_features", async state => {
      const systemPrompt = `你是 AtomFlow 写作风格分析专家。分析用户提供的内容，提取写作风格特征。

输出严格 JSON 格式：
{
  "tone": ["特征1", "特征2"],
  "structure": ["特征1", "特征2"],
  "citationStyle": "引用风格描述",
  "constraints": ["约束1", "约束2"],
  "examples": ["示例1", "示例2"]
}`;

      const userPrompt = state.inputType === "sample"
        ? `分析这段样本文本的写作风格：\n\n${state.sampleText}`
        : state.inputType === "both"
        ? `用户描述：${state.userInput}\n\n样本文本：\n${state.sampleText}\n\n综合分析写作风格特征。`
        : `用户描述的写作风格：${state.userInput}`;

      const rawResponse = await requestChat([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ], 0.3, 800);

      const extractedFeatures = safeJsonParse<any>(rawResponse) || {
        tone: ["自定义风格"],
        structure: [],
        citationStyle: "标准引用",
        constraints: [],
        examples: []
      };

      await input.onStep?.({ type: "partial_status", node: "extract_style_features", message: `提取特征: ${extractedFeatures.tone?.join(", ")}` });
      return { extractedFeatures };
    }))
    .addNode("generate_skill_draft", withTrace("generate_skill_draft", async state => {
      const systemPrompt = `你是 AtomFlow 写作 Skill 生成器。基于提取的风格特征，生成一个完整的写作风格 Skill 定义。

输出严格 JSON 格式：
{
  "name": "风格名称",
  "description": "风格描述",
  "prompt": "详细的写作指令",
  "constraints": ["约束1", "约束2"],
  "examples": ["示例1", "示例2"]
}

要求：
1. name 要简洁有辨识度，如"产品经理面试体"、"数据驱动论证"
2. description 说明适用场景和核心特点
3. prompt 要具体可执行，不要空泛的"保持风格"
4. constraints 要具体，如"每个观点必须有数据支撑"而非"注意质量"
5. examples 要真实可参考`;

      const userPrompt = `基于以下风格特征生成 Skill：
语气: ${state.extractedFeatures?.tone?.join(", ") || "未指定"}
结构: ${state.extractedFeatures?.structure?.join(", ") || "未指定"}
引用风格: ${state.extractedFeatures?.citationStyle || "标准引用"}
约束: ${state.extractedFeatures?.constraints?.join("; ") || "无"}
示例: ${state.extractedFeatures?.examples?.join("; ") || "无"}

原始用户输入: ${state.userInput}`;

      const rawResponse = await requestChat([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ], 0.4, 1200);

      const generatedSkill = safeJsonParse<any>(rawResponse) || {
        name: "自定义写作风格",
        description: state.userInput.slice(0, 180),
        prompt: `写作时遵循用户描述的风格：${state.userInput}`,
        constraints: ["保持风格一致性"],
        examples: []
      };

      await input.onStep?.({ type: "partial_status", node: "generate_skill_draft", message: `生成 Skill: ${generatedSkill.name}` });
      return { generatedSkill };
    }))
    .addNode("validate_and_format", withTrace("validate_and_format", state => {
      const errors: string[] = [];
      const skill = state.generatedSkill!;

      if (skill.name.length > 40) {
        skill.name = skill.name.slice(0, 40);
        errors.push("名称过长，已截断至40字符");
      }
      if (skill.description.length > 180) {
        skill.description = skill.description.slice(0, 180);
        errors.push("描述过长，已截断至180字符");
      }

      if (skill.name.length < 2) {
        skill.name = "自定义写作风格";
        errors.push("名称过短，使用默认名称");
      }
      if (skill.constraints.length === 0) {
        skill.constraints = ["保持风格一致性", "不编造来源"];
      }

      return { generatedSkill: skill, validationErrors: errors };
    }))
    .addNode("respond_with_preview", withTrace("respond_with_preview", state => state))
    .addEdge(START, "analyze_user_input")
    .addEdge("analyze_user_input", "extract_style_features")
    .addEdge("extract_style_features", "generate_skill_draft")
    .addEdge("generate_skill_draft", "validate_and_format")
    .addEdge("validate_and_format", "respond_with_preview")
    .addEdge("respond_with_preview", END)
    .compile();

  const result = await graph.invoke({
    userId: input.userId,
    userInput: input.userInput,
    sampleText: input.sampleText
  });

  return result;
};

const buildNoteActivatedNodes = (cards: WritingCardInput[]) => {
  return cards.map(card => ({
    id: card.id || `${card.type}-${normalizePlainText(card.content).slice(0, 24)}`,
    type: card.type,
    content: card.content,
    summary: card.summary,
    originalQuote: card.originalQuote,
    context: card.context,
    citationNote: card.citationNote,
    evidenceRole: card.evidenceRole,
    articleTitle: card.articleTitle || '未命名文章',
    articleId: card.articleId,
    savedArticleId: card.savedArticleId,
    sourceName: card.sourceName,
    sourceUrl: card.sourceUrl,
    sourceContext: card.sourceContext,
    sourceImages: card.sourceImages || [],
    tags: card.tags || []
  }));
};

const buildNoteSourceArticles = (cards: WritingCardInput[]) => {
  const unique = new Map<string, {
    savedArticleId?: number;
    articleId?: number;
    title: string;
              source: string;
              url?: string;
              excerpt?: string;
              citationContext?: string;
              sourceImages?: string[];
              savedAt?: string;
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
      source: card.sourceName || '知识库文章',
      url: card.sourceUrl,
      excerpt: card.sourceExcerpt || card.sourceContext || card.context || card.content.slice(0, 140),
      citationContext: card.sourceContext,
      sourceImages: card.sourceImages || [],
      savedAt: card.savedAt
    });
  });
  return Array.from(unique.values());
};

// 从写作卡片中提取唯一来源文章列表
const buildSourceArticlesFromCards = (cardsForWriting: any[], _dbCards: any[]) => {
  const articleMap = new Map<string, { articleId?: number; articleTitle: string; url?: string; cardIds: string[]; imageUrls?: string[] }>();
  for (const card of cardsForWriting) {
    const savedArticleId = card.savedArticleId ?? card.saved_article_id;
    const articleTitle = card.articleTitle ?? card.article_title ?? card.context_title ?? '未知来源';
    const sourceUrl = card.sourceUrl ?? card.article_url;
    const key = savedArticleId ? `article_${savedArticleId}` : `title_${articleTitle}`;
    if (!articleMap.has(key)) {
      articleMap.set(key, {
        articleId: savedArticleId || undefined,
        articleTitle,
        url: sourceUrl || undefined,
        cardIds: [],
        imageUrls: normalizeJsonStringArray(card.sourceImages),
      });
    }
    if (typeof card.id === "string") {
      articleMap.get(key)!.cardIds.push(card.id);
    }
  }
  return Array.from(articleMap.values());
};

const buildAgentSources = (cards: any[]): WriteAgentSourcesRecord => {
  const safeCards = sanitizeWritingCards(cards);
  const articles = new Map<string, WriteAgentSourcesRecord["articles"][number]>();
  const quotes: WriteAgentSourcesRecord["quotes"] = [];
  const images = new Map<string, WriteAgentSourcesRecord["images"][number]>();

  safeCards.forEach(card => {
    const articleKey = card.savedArticleId
      ? `saved-${card.savedArticleId}`
      : `${card.articleTitle || "unknown"}-${card.sourceUrl || ""}`;
    if (!articles.has(articleKey)) {
      articles.set(articleKey, {
        id: card.savedArticleId || card.articleId,
        title: card.articleTitle || "未命名文章",
        source: card.sourceName,
        url: card.sourceUrl,
        citationContext: card.sourceContext,
        imageUrls: card.sourceImages || []
      });
    }
    if (card.originalQuote && card.id) {
      quotes.push({
        cardId: card.id,
        articleTitle: card.articleTitle,
        quote: card.originalQuote
      });
    }
    (card.sourceImages || []).slice(0, 4).forEach((url, index) => {
      const imageId = `${articleKey}-${index}`;
      if (!images.has(imageId)) {
        images.set(imageId, {
          id: imageId,
          url,
          articleTitle: card.articleTitle
        });
      }
    });
  });

  return {
    cards,
    articles: Array.from(articles.values()),
    quotes: quotes.slice(0, 8),
    images: Array.from(images.values()).slice(0, 12)
  };
};

const buildAgentChoices = (cards: any[], styleSkill?: WriteStyleSkillRecord): WriteAgentChoiceRecord[] => {
  const cardIds = cards.map(card => card.id).filter((id): id is string => typeof id === "string");
  const choices: Array<WriteAgentChoiceRecord | null> = [
    cardIds.length > 0 ? {
      id: "use-recalled-cards",
      label: `使用这 ${cardIds.length} 张卡片`,
      action: "use_cards",
      payload: { cardIds }
    } : null,
    {
      id: "refresh-cards",
      label: "换一组素材",
      action: "refresh_cards",
      payload: {}
    },
    {
      id: "generate-outline",
      label: "生成提纲",
      action: "generate_outline",
      payload: { cardIds }
    },
    {
      id: "generate-draft",
      label: styleSkill ? `用「${styleSkill.name}」创建文章` : "创建文章",
      action: "generate_draft",
      payload: { cardIds, styleSkillId: styleSkill?.id }
    }
  ];
  return choices.filter((item): item is WriteAgentChoiceRecord => Boolean(item));
};

const buildAgentUiBlocks = (input: {
  answer: string;
  sources: WriteAgentSourcesRecord;
  selectedCardIds: string[];
  choices: WriteAgentChoiceRecord[];
  note?: any;
}) => [
  { type: "answer" as const, markdown: input.answer },
  input.sources.images.length > 0 ? { type: "source_gallery" as const, images: input.sources.images } : null,
  input.sources.cards.length > 0 ? {
    type: "card_selector" as const,
    cards: input.sources.cards,
    selectedCardIds: input.selectedCardIds
  } : null,
  input.choices.length > 0 ? { type: "action_bar" as const, choices: input.choices } : null,
  input.note ? {
    type: "draft_created" as const,
    noteId: Number(input.note.id),
    noteTitle: input.note.title || "未命名文章"
  } : null
].filter(Boolean);

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
    sourceArticles?: Array<{ articleId?: number; articleTitle: string; url?: string; cardIds: string[]; imageUrls?: string[] }>;
	    styleSkillSnapshot?: {
	      id?: number | string;
	      name: string;
	      type?: WriteAgentSkillType;
	      description?: string;
	      prompt: string;
	      examples?: string[];
	      constraints?: string[];
	    };
	    skillSnapshots?: Array<{
	      id?: number | string;
	      name: string;
	      type?: WriteAgentSkillType;
	      description?: string;
	      prompt: string;
	      examples?: string[];
	      constraints?: string[];
	      isBaseline?: boolean;
	    }>;
	    effectiveSkillSnapshots?: {
	      baselineSkills: Array<{
	        id?: number | string;
	        name: string;
	        type?: WriteAgentSkillType;
	        description?: string;
	        prompt: string;
	        examples?: string[];
	        constraints?: string[];
	        isBaseline?: boolean;
	      }>;
	      userSelectedSkills: Array<{
	        id?: number | string;
	        name: string;
	        type?: WriteAgentSkillType;
	        description?: string;
	        prompt: string;
	        examples?: string[];
	        constraints?: string[];
	        isBaseline?: boolean;
	      }>;
	    };
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
	    sourceArticles: input.sourceArticles || buildNoteSourceArticles(input.activeCards),
	    styleSkillSnapshot: input.styleSkillSnapshot,
	    skillSnapshots: input.skillSnapshots || (input.styleSkillSnapshot ? [input.styleSkillSnapshot] : []),
	    effectiveSkillSnapshots: input.effectiveSkillSnapshots || {
	      baselineSkills: (input.skillSnapshots || []).filter(skill => skill.isBaseline),
	      userSelectedSkills: (input.skillSnapshots || []).filter(skill => !skill.isBaseline)
	    }
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
const AI_SYSTEM_PROMPT = `你是一个面向后续写作引用的知识提炼助手。请先为整篇文章生成一个统一引用背景，再提取最多4张知识卡片。
类型：观点、数据、金句、故事
- 观点：文章核心判断或机制解释，用自己的话提炼
- 数据：具体数字、比例、报告结论、市场信号，尽量保留原文数字
- 金句：可直接引用的原话，必须来自原文
- 故事：案例、场景、人物、公司、事件或叙事片段

必须先生成 articleCitationContext：
- 这是这篇文章统一复用的引用背景，所有卡片都共用它
- 180-360字，尽量全面但不啰嗦
- 必须交代：文章讨论对象、来源/场景、关键时间或地域、主要问题、核心矛盾、作者结论、重要边界
- 不要只复述标题，不要没头没尾；读者没看过原文，也应能理解卡片为什么成立

每张卡片不是越短越好，而是要能在未来写作时被引用。必须包含：
- content：这张卡的可复用知识点，120-220字，写成完整判断
- summary：一句话说明它解决什么问题，40-80字
- originalQuote：原文中最关键的一句或一小段；如果不是原文摘录，填空字符串
- context：只写这张卡独有的局部语境，60-140字；不要重复 articleCitationContext
- citationNote：未来写作中适合怎么引用它，例如“可用于说明……”“可作为……的例子”
- evidenceRole：claim|data|example|quote|counterpoint|definition|trend 中选一个
- tags：3-6个语义标签

规则：
1. 优先提取有信息密度、能支撑写作论证的内容，没有就不硬凑
2. 不要只做标题复述，要保留对象、时间、场景、因果、边界条件
3. 严格只输出JSON对象，不要输出任何其他内容
格式：{"articleCitationContext":"...","cards":[{"type":"观点","content":"...","summary":"...","originalQuote":"...","context":"...","citationNote":"...","evidenceRole":"claim","tags":["标签1","标签2"]}]}`;
const WRITING_AGENT_SYSTEM_PROMPT = `你是一位优秀的中文专栏作家。你的任务是写原创文章，不是做素材汇编。

核心原则：
1. 你拿到的”素材”只是背景知识和灵感来源。你要基于这些素材形成自己的观点，用自己的语言写作。
2. 绝对不要逐条搬运素材内容。不要出现”某某观点认为””某某数据表明”这种罗列式写法。
3. 文章要符合 Scratch 成稿标准：开场抓住具体问题/场景，承接作者核心判断，转入矛盾/代价/反常识，最后收束到结论或行动。
4. 写法像一个有独立见解的作者在表达自己的思考，而不是在整理别人的观点。
5. 开头不要套话，不要”在当今时代””众所周知””让我们来看看”。
6. 如果素材里有冲突观点，要写出冲突和你的判断，而不是抹平它。
7. 如果素材不足，就写一篇更短但更扎实的文章，不要注水。
8. 不要 AI 腔，不要假装引用不存在的数据。
9. 输出必须是纯 Markdown，不要输出解释，不要输出 JSON，不要使用 HTML。
10. 严禁输出“素材对齐”“观点对齐”“节点映射”“引用映射”“写作思路”“正文草稿”等过程性栏目；这些信息只属于系统 meta，不属于文章。

格式要求：
- 第一行直接是标题
- 正文用短段落推进
- 使用 2-4 个二级标题（##）
- 段落之间要有逻辑推进，不是并列罗列`;

const VALID_CARD_TYPES = new Set(["观点", "数据", "金句", "故事", "灵感"]);
const VALID_WRITING_CARD_TYPES = new Set(["观点", "数据", "金句", "故事", "灵感"]);

type AiChatMessage = { role: "system" | "user" | "assistant"; content: string };

type AiChatConfig = {
  apiKey: string;
  baseUrl: string;
  chatCompletionsUrl: string;
  model: string;
};

const buildOpenAiCompatibleChatCompletionsUrl = (baseUrl: string) => {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
};

const normalizeAiModelName = (model: string) => {
  const trimmed = model.trim();
  return trimmed.toLowerCase().startsWith("mimo-")
    ? trimmed.toLowerCase()
    : trimmed;
};

const isPlaceholderAiApiKey = (apiKey: string) => {
  return [
    "your-ai-api-key",
    "your-mimo-token-plan-api-key",
    "your_api_key",
    "your-openai-compatible-api-key",
  ].includes(apiKey.trim().toLowerCase());
};

const getEffectiveAiMaxTokens = (model: string, requestedMaxTokens: number, disableThinking?: boolean) => {
  if (disableThinking && model.toLowerCase().startsWith("mimo-")) {
    return Math.max(requestedMaxTokens, MIMO_MIN_STRUCTURED_OUTPUT_TOKENS);
  }
  return requestedMaxTokens;
};

const getAiChatConfig = (): AiChatConfig | null => {
  const apiKey = process.env.AI_API_KEY?.trim();
  const baseUrl = process.env.AI_BASE_URL?.trim().replace(/\/+$/, "");
  const model = process.env.AI_MODEL?.trim();
  if (!apiKey || !baseUrl || !model || isPlaceholderAiApiKey(apiKey)) {
    return null;
  }
  return {
    apiKey,
    baseUrl,
    chatCompletionsUrl: buildOpenAiCompatibleChatCompletionsUrl(baseUrl),
    model: normalizeAiModelName(model),
  };
};

type OpenAIWriteAgentConfig = {
  apiKey: string;
  model: string;
  baseURL?: string;
  providerLabel: "openai" | "mimo-token-plan";
};

const getOpenAIWriteAgentConfig = (): OpenAIWriteAgentConfig | null => {
  const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
  const openAiModel = process.env.OPENAI_MODEL?.trim();
  if (openAiApiKey && openAiModel && !isPlaceholderAiApiKey(openAiApiKey)) {
    return { apiKey: openAiApiKey, model: openAiModel, providerLabel: "openai" };
  }

  const aiConfig = getAiChatConfig();
  if (!aiConfig) return null;
  return {
    apiKey: aiConfig.apiKey,
    baseURL: aiConfig.baseUrl,
    model: aiConfig.model,
    providerLabel: "mimo-token-plan"
  };
};

const getWriteAgentAiChatConfig = (config: OpenAIWriteAgentConfig): AiChatConfig => {
  const baseUrl = config.providerLabel === "openai" ? "https://api.openai.com" : (config.baseURL || "");
  return {
    apiKey: config.apiKey,
    baseUrl,
    chatCompletionsUrl: config.providerLabel === "openai"
      ? "https://api.openai.com/v1/chat/completions"
      : buildOpenAiCompatibleChatCompletionsUrl(baseUrl),
    model: normalizeAiModelName(config.model),
  };
};

const getAllowedCanvasAgentModels = () => {
  const configuredModel = getOpenAIWriteAgentConfig()?.model;
  const explicitlyAllowed = (process.env.WRITE_AGENT_ALLOWED_MODELS || "")
    .split(",")
    .map(model => normalizeAiModelName(model))
    .filter(Boolean);
  return new Set(
    [configuredModel ? normalizeAiModelName(configuredModel) : "", ...explicitlyAllowed].filter(Boolean),
  );
};

const isAllowedCanvasAgentModel = (model: string) => getAllowedCanvasAgentModels().has(normalizeAiModelName(model));

const resolveAllowedCanvasAgentModel = (requestedModel: unknown, fallbackModel: string) => {
  const candidate = typeof requestedModel === "string" && requestedModel.trim()
    ? normalizeAiModelName(requestedModel)
    : normalizeAiModelName(fallbackModel);
  return isAllowedCanvasAgentModel(candidate) ? candidate : null;
};

const getCanvasAgentMaxOutputTokens = () => readBoundedEnvNumber(
  process.env.WRITE_AGENT_MAX_OUTPUT_TOKENS,
  2000,
  128,
  8000,
);

const isAiFallbackDisabled = () => process.env.DISABLE_AI_FALLBACK === "true";

const requestAiChatCompletion = async (
  messages: AiChatMessage[],
  options: {
    temperature: number;
    maxTokens: number;
    timeoutMs?: number;
    logLabel: string;
    disableThinking?: boolean;
    config?: AiChatConfig;
  }
) => {
  const config = options.config || getAiChatConfig();
  if (!config) {
    throw new Error("AI service not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? AI_REQUEST_TIMEOUT_MS);

  try {
    const maxTokens = getEffectiveAiMaxTokens(config.model, options.maxTokens, options.disableThinking);
    const response = await fetch(config.chatCompletionsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: maxTokens,
        temperature: options.temperature,
        ...(options.disableThinking && config.model.toLowerCase().startsWith("qwen")
          ? { enable_thinking: false }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseBody = await response.text();
      logger.error({
        module: "ai",
        status: response.status,
        responseBody: responseBody.slice(0, 1000),
        operation: options.logLabel,
      }, "AI API request failed");
      throw new Error(`AI request failed ${response.status}: ${responseBody}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content || "").trim();
  } finally {
    clearTimeout(timeout);
  }
};

const normalizeCanvasNodeKind = (value: unknown): WriteCanvasNodeKind | null => {
  return typeof value === "string" && (WRITE_CANVAS_NODE_KINDS as readonly string[]).includes(value)
    ? value as WriteCanvasNodeKind
    : null;
};

const normalizeCanvasNodeRole = (value: unknown): WriteCanvasNodeRole | null => (
  typeof value === "string" && (WRITE_CANVAS_NODE_ROLES as readonly string[]).includes(value)
    ? value as WriteCanvasNodeRole
    : null
);

const normalizeCanvasNodeOrigin = (value: unknown): WriteCanvasNodeOrigin | null => (
  typeof value === "string" && (WRITE_CANVAS_NODE_ORIGINS as readonly string[]).includes(value)
    ? value as WriteCanvasNodeOrigin
    : null
);

const normalizeCanvasNodeStatus = (value: unknown): WriteCanvasNodeStatus | null => (
  typeof value === "string" && (WRITE_CANVAS_NODE_STATUSES as readonly string[]).includes(value)
    ? value as WriteCanvasNodeStatus
    : null
);

const normalizeCanvasEdgeRelation = (value: unknown): WriteCanvasEdgeRelation | null => (
  typeof value === "string" && (WRITE_CANVAS_EDGE_RELATIONS as readonly string[]).includes(value)
    ? value as WriteCanvasEdgeRelation
    : null
);

const getCanvasNodeRole = (kind: WriteCanvasNodeKind): WriteCanvasNodeRole => {
  if (["asset_text", "asset_file", "asset_image", "saved_article", "atom_card"].includes(kind)) return "material";
  if (kind === "agent") return "task";
  if (kind === "result") return "document";
  return "insight";
};

const getCanvasContentType = (kind: WriteCanvasNodeKind) => ({
  asset_text: "text", asset_file: "file", asset_image: "image", saved_article: "article",
  atom_card: "atom_card", note: "note", agent: "agent", result: "result",
}[kind]);

const getCanvasNodeOrigin = (kind: WriteCanvasNodeKind): WriteCanvasNodeOrigin => (
  ["asset_text", "asset_file", "asset_image", "saved_article", "atom_card"].includes(kind) ? "existing"
    : kind === "result" ? "generated" : "manual"
);

const getCanvasNodeStatus = (kind: WriteCanvasNodeKind): WriteCanvasNodeStatus => (
  kind === "agent" ? "ready" : kind === "result" ? "pending_review" : "ready"
);

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
};

const normalizeJsonObject = (value: unknown) => (
  isPlainRecord(value) ? value : {}
);

const getJsonByteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

const normalizeBoundedJsonObject = (value: unknown, maxBytes = WRITE_CANVAS_MAX_META_BYTES) => {
  const normalized = normalizeJsonObject(value);
  return getJsonByteLength(normalized) <= maxBytes ? normalized : null;
};

const getDefaultCanvasAgentConfig = () => {
  const config = getOpenAIWriteAgentConfig();
  return {
    name: "写作 Agent",
    model: config?.model || process.env.AI_MODEL || process.env.OPENAI_MODEL || "mimo-v2.5-pro",
    systemPrompt: "你是 AtomFlow 魔法写作画布里的写作 Agent。只基于用户连接到你的上下文回答；如果上下文不足，明确说明缺口。",
    temperature: 0.55,
    topP: 1,
    maxTokens: 1200
  };
};

const mapCanvasProjectRow = (row: any) => ({
  id: Number(row.id),
  name: row.name as string,
  viewport: row.viewport || {},
  createdAt: row.createdAt || row.created_at,
  updatedAt: row.updatedAt || row.updated_at,
  lastOpenedAt: row.lastOpenedAt || row.last_opened_at
});

const mapCanvasAssetRow = (row: any) => row ? ({
  id: Number(row.id),
  type: row.type as "text" | "file" | "image",
  title: row.title as string,
  contentText: row.contentText ?? row.content_text ?? "",
  extractedText: row.extractedText ?? row.extracted_text ?? "",
  fileName: row.fileName ?? row.file_name ?? undefined,
  mimeType: row.mimeType ?? row.mime_type ?? undefined,
  dataUrl: row.dataUrl ?? row.data_url ?? undefined,
  meta: row.meta || {},
  createdAt: row.createdAt || row.created_at
}) : null;

const mapCanvasAgentRow = (row: any) => row ? ({
  id: Number(row.id),
  projectId: Number(row.projectId ?? row.project_id),
  templateId: row.templateId ?? row.template_id ? Number(row.templateId ?? row.template_id) : null,
  name: row.name as string,
  model: row.model as string,
  systemPrompt: row.systemPrompt ?? row.system_prompt ?? "",
  temperature: Number(row.temperature ?? 0.55),
  topP: Number(row.topP ?? row.top_p ?? 1),
  maxTokens: Number(row.maxTokens ?? row.max_tokens ?? 1200),
  createdAt: row.createdAt || row.created_at,
  updatedAt: row.updatedAt || row.updated_at
}) : null;

const mapCanvasDocumentSectionRow = (row: any) => ({
  key: row.key ?? row.stable_key,
  heading: row.heading || "",
  body: row.body || "",
  level: Number(row.level || 1),
  meta: row.meta || {},
});

const mapCanvasDocumentRow = (row: any) => row ? ({
  id: Number(row.id),
  projectId: Number(row.projectId ?? row.project_id),
  nodeId: Number(row.nodeId ?? row.node_id),
  title: row.title || "",
  summary: row.summary || "",
  scenario: row.scenario || "",
  status: row.status as WriteCanvasNodeStatus,
  currentVersionId: row.currentVersionId ?? row.current_version_id ? Number(row.currentVersionId ?? row.current_version_id) : null,
  sections: Array.isArray(row.sections) ? row.sections.map(mapCanvasDocumentSectionRow) : [],
  createdAt: row.createdAt || row.created_at,
  updatedAt: row.updatedAt || row.updated_at,
}) : null;

const mapCanvasNodeRow = (row: any) => ({
  id: Number(row.id),
  projectId: Number(row.projectId ?? row.project_id),
  kind: row.kind as WriteCanvasNodeKind,
  role: row.role ?? row.node_role ?? getCanvasNodeRole(row.kind as WriteCanvasNodeKind),
  contentType: row.contentType ?? row.content_type ?? getCanvasContentType(row.kind as WriteCanvasNodeKind),
  origin: row.origin ?? getCanvasNodeOrigin(row.kind as WriteCanvasNodeKind),
  status: row.status ?? getCanvasNodeStatus(row.kind as WriteCanvasNodeKind),
  businessRef: row.businessRef ?? row.business_ref ?? null,
  title: row.title as string,
  summary: row.summary || "",
  refId: row.refId ?? row.ref_id ?? null,
  asset: mapCanvasAssetRow(row.asset || null),
  agent: mapCanvasAgentRow(row.agent || null),
  document: mapCanvasDocumentRow(row.document || null),
  meta: row.meta || {},
  x: Number(row.x),
  y: Number(row.y),
  width: Number(row.width),
  height: Number(row.height),
  createdAt: row.createdAt || row.created_at,
  updatedAt: row.updatedAt || row.updated_at
});

const mapCanvasEdgeRow = (row: any) => ({
  id: Number(row.id),
  projectId: Number(row.projectId ?? row.project_id),
  sourceNodeId: Number(row.sourceNodeId ?? row.source_node_id),
  targetNodeId: Number(row.targetNodeId ?? row.target_node_id),
  relation: row.relation as WriteCanvasEdgeRelation,
  createdAt: row.createdAt || row.created_at
});

const mapAgentTemplateRow = (row: any) => ({
  id: Number(row.id),
  name: row.name as string,
  model: row.model as string,
  systemPrompt: row.systemPrompt ?? row.system_prompt ?? "",
  temperature: Number(row.temperature ?? 0.55),
  topP: Number(row.topP ?? row.top_p ?? 1),
  maxTokens: Number(row.maxTokens ?? row.max_tokens ?? 1200),
  createdAt: row.createdAt || row.created_at,
  updatedAt: row.updatedAt || row.updated_at
});

const mapCanvasMessageRow = (row: any) => ({
  id: Number(row.id),
  agentId: Number(row.agentId ?? row.agent_id),
  role: row.role as "user" | "assistant",
  content: row.content as string,
  meta: row.meta || {},
  createdAt: row.createdAt || row.created_at
});

const WRITE_CANVAS_QUICK_ACTIONS = [
  "summarize", "extract_insights", "extract_data", "extract_quotes",
  "extract_stories", "extract_cases", "extract_questions", "generate_outline",
] as const;
type WriteCanvasQuickAction = typeof WRITE_CANVAS_QUICK_ACTIONS[number];

const normalizeCanvasQuickAction = (value: unknown): WriteCanvasQuickAction | null => (
  typeof value === "string" && (WRITE_CANVAS_QUICK_ACTIONS as readonly string[]).includes(value)
    ? value as WriteCanvasQuickAction
    : null
);

const isCanvasExtractionAction = (action: WriteCanvasQuickAction) => action.startsWith("extract_");

class CanvasInputLimitError extends Error {}
class CanvasStorageLimitError extends Error {}
class CanvasAgentBatchLeaseLostError extends Error {}
class CanvasAiActiveError extends Error {}

const getCanvasAggregateContextChars = (
  contexts: CanvasContextItem[],
  message: string,
  systemPrompt = "",
  previousMessages: Array<{ content: string }> = [],
) => contexts.reduce((total, item) => total + item.title.length + item.text.length + (item.sourceLabel?.length || 0), 0)
  + message.length
  + systemPrompt.length
  + previousMessages.reduce((total, item) => total + item.content.length, 0);

const assertCanvasAggregateContextWithinLimit = (
  contexts: CanvasContextItem[],
  message: string,
  systemPrompt = "",
  previousMessages: Array<{ content: string }> = [],
) => {
  const aggregateChars = getCanvasAggregateContextChars(contexts, message, systemPrompt, previousMessages);
  if (aggregateChars > WRITE_CANVAS_MAX_AGGREGATE_CONTEXT_CHARS) {
    throw new CanvasInputLimitError(`画布上下文超过 ${WRITE_CANVAS_MAX_AGGREGATE_CONTEXT_CHARS} 字符上限`);
  }
  return aggregateChars;
};

const createCanvasContextPlainTextBudget = (maxOutputChars: number) => createPlainTextBudget(
  maxOutputChars,
  Math.min(maxOutputChars * 2, PLAIN_TEXT_NORMALIZATION_MAX_SOURCE_CHARS),
);

const normalizeCanvasContextText = (
  content: string,
  budget: PlainTextBudget,
  maxOutputChars: number,
) => contentToPlainTextWithinBudget(content || "", budget, maxOutputChars);

const estimateCanvasInputTokens = (
  contexts: CanvasContextItem[],
  message: string,
  systemPrompt = "",
  previousMessages: Array<{ content: string }> = [],
) => {
  const textTokens = Math.ceil(getCanvasAggregateContextChars(contexts, message, systemPrompt, previousMessages) / 4);
  const imageTokens = contexts
    .filter(context => Boolean(context.imageDataUrl))
    .slice(0, WRITE_CANVAS_MAX_CONTEXT_IMAGES)
    .length * WRITE_CANVAS_ESTIMATED_TOKENS_PER_IMAGE;
  return textTokens + imageTokens;
};

const requireCanvasCompletionContent = (content: string) => {
  const normalized = content.trim();
  if (!normalized) throw new Error("AI provider returned empty content");
  return normalized;
};

const getCanvasQuickActionPrompt = (action: WriteCanvasQuickAction) => {
  const prompts: Record<WriteCanvasQuickAction, string> = {
    summarize: "请只基于提供的单个画布节点，给出简洁、准确的中文摘要。",
    extract_insights: "请只基于提供的单个画布节点，提炼可复用洞察。只返回 JSON 数组，每项为 {title, content}。",
    extract_data: "请只基于提供的单个画布节点，提取明确的数据、指标或事实。只返回 JSON 数组，每项为 {title, content}。",
    extract_quotes: "请只基于提供的单个画布节点，提取值得引用的原句，并保留必要上下文。只返回 JSON 数组，每项为 {title, content}。",
    extract_stories: "请只基于提供的单个画布节点，提炼故事、经历或叙事片段。只返回 JSON 数组，每项为 {title, content}。",
    extract_cases: "请只基于提供的单个画布节点，提炼案例及其关键做法或结果。只返回 JSON 数组，每项为 {title, content}。",
    extract_questions: "请只基于提供的单个画布节点，提出有助于继续研究或写作的问题。只返回 JSON 数组，每项为 {title, content}。",
    generate_outline: "请只基于提供的单个画布节点，生成层次清晰、可直接写作的中文大纲。",
  };
  return prompts[action];
};

const mapCanvasAgentGroupMemberRow = (row: any) => ({
  id: Number(row.id),
  projectId: Number(row.projectId ?? row.project_id),
  name: row.name || "Agent",
  model: row.model,
  systemPrompt: row.systemPrompt ?? row.system_prompt ?? "",
  temperature: Number(row.temperature ?? 0.55),
  topP: Number(row.topP ?? row.top_p ?? 1),
  maxTokens: Number(row.maxTokens ?? row.max_tokens ?? 1200),
  createdAt: row.createdAt || row.created_at,
  updatedAt: row.updatedAt || row.updated_at,
});

type CanvasAgentGroupMemberRecord = {
  id: number;
  name: string;
  model: string;
  system_prompt: string;
  temperature: number;
  top_p: number;
  max_tokens: number;
};

const mapCanvasAgentGroupRow = (row: any) => ({
  id: Number(row.id),
  projectId: Number(row.projectId ?? row.project_id),
  nodeId: Number(row.nodeId ?? row.node_id),
  name: row.name,
  sharedPrompt: row.sharedPrompt ?? row.shared_prompt ?? "",
  status: row.status,
  configSnapshot: row.configSnapshot ?? row.config_snapshot ?? {},
  members: Array.isArray(row.members) ? row.members.map(mapCanvasAgentGroupMemberRow) : [],
  createdAt: row.createdAt || row.created_at,
  updatedAt: row.updatedAt || row.updated_at,
});

const mapCanvasAgentRunRow = (row: any) => ({
  id: Number(row.id),
  projectId: Number(row.projectId ?? row.project_id),
  groupId: row.groupId ?? row.group_id ? Number(row.groupId ?? row.group_id) : null,
  groupMemberId: row.groupMemberId ?? row.group_member_id ? Number(row.groupMemberId ?? row.group_member_id) : null,
  batchId: row.batchId ?? row.batch_id ? Number(row.batchId ?? row.batch_id) : null,
  sourceNodeId: row.sourceNodeId ?? row.source_node_id ? Number(row.sourceNodeId ?? row.source_node_id) : null,
  action: row.action,
  status: row.status,
  contextSnapshot: row.contextSnapshot ?? row.context_snapshot ?? {},
  configSnapshot: row.configSnapshot ?? row.config_snapshot ?? {},
  output: row.output || "",
  error: row.error || null,
  startedAt: row.startedAt || row.started_at || null,
  completedAt: row.completedAt || row.completed_at || null,
  createdAt: row.createdAt || row.created_at,
  updatedAt: row.updatedAt || row.updated_at,
});

const mapCanvasAgentBatchRow = (row: Record<string, unknown>) => ({
  id: Number(row.id),
  projectId: Number(row.projectId ?? row.project_id),
  groupId: Number(row.groupId ?? row.group_id),
  message: row.message || "",
  contextNodeIds: Array.isArray(row.contextNodeIds ?? row.context_node_ids) ? row.contextNodeIds ?? row.context_node_ids : [],
  status: row.status,
  contextSnapshot: row.contextSnapshot ?? row.context_snapshot ?? {},
  configSnapshot: row.configSnapshot ?? row.config_snapshot ?? {},
  output: row.output || {},
  error: row.error || null,
  startedAt: row.startedAt || row.started_at || null,
  completedAt: row.completedAt || row.completed_at || null,
  createdAt: row.createdAt || row.created_at,
  updatedAt: row.updatedAt || row.updated_at,
});

const resolveCanvasOwnedNodeContext = async (
  pool: pg.Pool,
  userId: number,
  projectId: number,
  nodeId: number,
  textBudget = createCanvasContextPlainTextBudget(WRITE_CANVAS_MAX_CONTEXT_CHARS),
): Promise<CanvasContextItem | null> => {
  const node = (await pool.query(
    `SELECT n.id, n.kind, n.title, n.summary, n.ref_id, n.document_id, n.content_type, n.meta,
            a.content_text, a.extracted_text,
            CASE WHEN a.type = 'image' THEN a.data_url ELSE NULL END AS data_url,
            a.mime_type
     FROM write_canvas_nodes n
     LEFT JOIN write_canvas_assets a ON a.id = n.asset_id AND a.user_id = n.user_id
     WHERE n.id = $1 AND n.user_id = $2 AND n.project_id = $3`,
    [nodeId, userId, projectId],
  )).rows[0];
  const kind = normalizeCanvasNodeKind(node?.kind);
  if (!node || !kind) return null;
  if (node.document_id) {
    const documentContext = await resolveCanvasDocumentContext(pool, userId, Number(node.document_id), undefined, textBudget);
    if (documentContext) {
      return { nodeId: Number(node.id), kind, title: documentContext.title || node.title, text: documentContext.text };
    }
  }
  if (node.content_type === "document_section") {
    const documentId = Number(node.meta?.documentId);
    const sectionKey = typeof node.meta?.sectionKey === "string" ? node.meta.sectionKey : "";
    if (Number.isSafeInteger(documentId) && documentId > 0 && sectionKey) {
      const sectionContext = await resolveCanvasDocumentContext(pool, userId, documentId, sectionKey, textBudget);
      if (sectionContext) {
        return { nodeId: Number(node.id), kind, title: sectionContext.title || node.title, text: sectionContext.text };
      }
    }
  }
  if (["asset_text", "asset_file", "asset_image", "result"].includes(kind)) {
    return {
      nodeId: Number(node.id), kind, title: node.title || "画布资料",
      text: normalizeCanvasContextText(
        [node.summary, node.content_text, node.extracted_text].filter(Boolean).join("\n"),
        textBudget,
        WRITE_CANVAS_MAX_CONTEXT_CHARS,
      ),
      imageDataUrl: kind === "asset_image" && typeof node.data_url === "string" ? node.data_url : undefined,
      mimeType: node.mime_type || undefined,
    };
  }
  if (kind === "saved_article" && node.ref_id) {
    const article = (await pool.query(
      `SELECT title, source, url, citation_context, excerpt, content FROM saved_articles WHERE id = $1 AND user_id = $2`,
      [Number(node.ref_id), userId],
    )).rows[0];
    if (article) return { nodeId: Number(node.id), kind, title: article.title || node.title, sourceLabel: article.source || article.url || undefined, text: normalizeCanvasContextText([article.citation_context, article.excerpt, article.content].filter(Boolean).join("\n"), textBudget, WRITE_CANVAS_MAX_CONTEXT_CHARS) };
  }
  if (kind === "atom_card" && node.ref_id) {
    const card = (await pool.query(
      `SELECT type, content, summary, context, original_quote, article_title FROM saved_cards WHERE id = $1 AND user_id = $2`,
      [node.ref_id, userId],
    )).rows[0];
    if (card) return { nodeId: Number(node.id), kind, title: card.article_title || node.title || "原子卡", text: normalizeCanvasContextText([card.type, card.content, card.summary, card.context, card.original_quote].filter(Boolean).join("\n"), textBudget, WRITE_CANVAS_MAX_CONTEXT_CHARS) };
  }
  if (kind === "note" && node.ref_id) {
    const note = (await pool.query(`SELECT title, content FROM notes WHERE id = $1 AND user_id = $2`, [Number(node.ref_id), userId])).rows[0];
    if (note) return { nodeId: Number(node.id), kind, title: note.title || node.title || "笔记", text: normalizeCanvasContextText(note.content || "", textBudget, WRITE_CANVAS_MAX_CONTEXT_CHARS) };
  }
  return { nodeId: Number(node.id), kind, title: node.title || "画布节点", text: normalizeCanvasContextText(node.summary || "", textBudget, WRITE_CANVAS_MAX_CONTEXT_CHARS) };
};

const parseCanvasExtractionItems = (output: string) => {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || output;
  const candidate = fenced.trim().startsWith("[")
    ? fenced.trim()
    : fenced.slice(fenced.indexOf("["), fenced.lastIndexOf("]") + 1);
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, WRITE_CANVAS_MAX_EXTRACTION_NODES).flatMap(item => {
      if (typeof item === "string" && item.trim()) return [{ title: "提取内容", content: item.trim().slice(0, 12000) }];
      if (!isPlainRecord(item)) return [];
      const content = typeof item.content === "string" ? item.content.trim() : typeof item.text === "string" ? item.text.trim() : "";
      if (!content) return [];
      const title = typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 120) : normalizePlainText(content).slice(0, 32) || "提取内容";
      return [{ title, content: content.slice(0, 12000) }];
    });
  } catch {
    return [];
  }
};

type CanvasGeneratedNodeInput = { title: string; content: string; role: WriteCanvasNodeRole; origin: WriteCanvasNodeOrigin; status: WriteCanvasNodeStatus; relation: WriteCanvasEdgeRelation; x: number; y: number; meta: Record<string, unknown> };

const assertCanvasEdgeCapacity = async (
  client: pg.PoolClient,
  userId: number,
  projectId: number,
  additionalEdges = 1,
) => {
  if (additionalEdges <= 0) return;
  const edgeCount = Number((await client.query(
    `SELECT COUNT(*)::int AS count FROM write_canvas_edges WHERE user_id = $1 AND project_id = $2`,
    [userId, projectId],
  )).rows[0]?.count || 0);
  if (edgeCount + additionalEdges > WRITE_CANVAS_MAX_EDGES_PER_PROJECT) {
    throw new CanvasStorageLimitError("项目连线数量已达到上限");
  }
};

const createCanvasGeneratedNodes = async (
  client: pg.PoolClient,
  userId: number,
  projectId: number,
  sourceNodeId: number | null,
  inputs: CanvasGeneratedNodeInput[],
  additionalStorageBytes = 0,
) => {
  if (inputs.length === 0) return [] as number[];
  const project = (await client.query(`SELECT id FROM write_canvas_projects WHERE id = $1 AND user_id = $2 FOR UPDATE`, [projectId, userId])).rows[0];
  if (!project) throw new Error("project not found");
  if (sourceNodeId) {
    const source = (await client.query(`SELECT id FROM write_canvas_nodes WHERE id = $1 AND user_id = $2 AND project_id = $3 FOR SHARE`, [sourceNodeId, userId, projectId])).rows[0];
    if (!source) throw new Error("source node not found");
  }
  const nodeCount = Number((await client.query(`SELECT COUNT(*)::int AS count FROM write_canvas_nodes WHERE user_id = $1 AND project_id = $2`, [userId, projectId])).rows[0]?.count || 0);
  if (nodeCount + inputs.length > WRITE_CANVAS_MAX_NODES_PER_PROJECT) throw new Error("项目节点数量已达到上限");
  if (sourceNodeId) await assertCanvasEdgeCapacity(client, userId, projectId, inputs.length);
  const addedBytes = inputs.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8") * 2, 0);
  await assertCanvasStorageQuota(client, userId, addedBytes + additionalStorageBytes);
  const nodeIds: number[] = [];
  for (const item of inputs) {
    const asset = (await client.query(
      `INSERT INTO write_canvas_assets (user_id, project_id, type, title, content_text, extracted_text, meta)
       VALUES ($1, $2, 'text', $3, $4, $4, $5::jsonb) RETURNING id`,
      [userId, projectId, item.title, item.content, JSON.stringify(item.meta)],
    )).rows[0];
    const node = (await client.query(
      `INSERT INTO write_canvas_nodes
         (user_id, project_id, kind, node_role, content_type, origin, status, title, summary, asset_id, meta, x, y, width, height)
       VALUES ($1, $2, 'result', $3, 'result', $4, $5, $6, $7, $8, $9::jsonb, $10, $11, 320, 220)
       RETURNING id`,
      [userId, projectId, item.role, item.origin, item.status, item.title, normalizePlainText(item.content).slice(0, 180), Number(asset.id), JSON.stringify(item.meta), item.x, item.y],
    )).rows[0];
    nodeIds.push(Number(node.id));
    if (sourceNodeId) {
      await client.query(
        `INSERT INTO write_canvas_edges (user_id, project_id, source_node_id, target_node_id, relation)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, source_node_id, target_node_id, relation) DO NOTHING`,
        [userId, projectId, sourceNodeId, Number(node.id), item.relation],
      );
    }
  }
  return nodeIds;
};

const extractCanvasFileText = async (file: Express.Multer.File) => {
  const mime = file.mimetype || "";
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (mime.startsWith("text/") || [".txt", ".md", ".markdown", ".csv"].includes(ext)) {
    return file.buffer.toString("utf8").slice(0, WRITE_AGENT_MAX_MESSAGE_LENGTH);
  }
  if (mime === "application/pdf" || ext === ".pdf") {
    return runDocumentParserWorker("pdf", file.buffer);
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  ) {
    return runDocumentParserWorker("docx", file.buffer);
  }
  return "";
};

const DOCUMENT_PARSER_WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  (async () => {
    const buffer = Buffer.from(workerData.bytes);
    let text = "";
    if (workerData.kind === "pdf") {
      const pdfParse = require("pdf-parse/lib/pdf-parse.js");
      const parsed = await pdfParse(buffer, { max: workerData.maxPages });
      if (Number(parsed.numpages || 0) > workerData.maxPages) throw new Error("PDF page limit exceeded");
      text = parsed.text || "";
    } else if (workerData.kind === "docx") {
      const mammoth = require("mammoth");
      const parsed = await mammoth.extractRawText({ buffer });
      text = parsed.value || "";
    } else {
      throw new Error("Unsupported document type");
    }
    parentPort.postMessage({ ok: true, text: text.slice(0, workerData.maxChars) });
  })().catch(error => parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : "Document parsing failed" }));
`;

const runDocumentParserWorker = (kind: "pdf" | "docx", buffer: Buffer) => new Promise<string>((resolve, reject) => {
  const worker = new Worker(DOCUMENT_PARSER_WORKER_SOURCE, {
    eval: true,
    workerData: {
      kind,
      bytes: buffer,
      maxPages: readBoundedEnvNumber(process.env.CANVAS_PDF_MAX_PAGES, 100, 1, 500),
      maxChars: WRITE_AGENT_MAX_MESSAGE_LENGTH,
    },
    resourceLimits: {
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    },
  });
  let settled = false;
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    void worker.terminate();
    callback();
  };
  const timer = setTimeout(() => finish(() => reject(new Error("Document parsing timed out"))), 15_000);
  timer.unref();
  worker.once("message", (message: { ok?: boolean; text?: string; error?: string }) => {
    if (message.ok) finish(() => resolve(normalizePlainText(message.text || "", WRITE_AGENT_MAX_MESSAGE_LENGTH)));
    else finish(() => reject(new Error(message.error || "Document parsing failed")));
  });
  worker.once("error", error => finish(() => reject(error)));
  worker.once("exit", code => {
    if (!settled && code !== 0) finish(() => reject(new Error(`Document parser exited with code ${code}`)));
  });
});

const lockCanvasUser = async (client: pg.PoolClient, userId: number) => {
  const user = (await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId])).rows[0];
  if (!user) throw new Error("Canvas user no longer exists");
};

const assertNoActiveCanvasAiWork = async (client: pg.PoolClient, userId: number, projectId: number) => {
  const active = Boolean((await client.query(
    `SELECT 1 FROM write_canvas_agent_runs
     WHERE user_id = $1 AND project_id = $2 AND status IN ('queued','running')
     UNION ALL
     SELECT 1
     FROM write_canvas_agent_messages message
     JOIN write_agent_instances agent ON agent.id = message.agent_id AND agent.user_id = message.user_id
     WHERE message.user_id = $1 AND agent.project_id = $2 AND message.meta->>'status' = 'pending'
     UNION ALL
     SELECT 1 FROM write_canvas_agent_batches
     WHERE user_id = $1 AND project_id = $2 AND status = 'running'
     LIMIT 1`,
    [userId, projectId],
  )).rows[0]);
  if (active) throw new CanvasAiActiveError("项目中仍有 AI 任务运行，请等待完成后再删除");
};

const getCanvasStoredBytes = async (client: pg.PoolClient, userId: number) => Number((await client.query(
  `SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (
     SELECT octet_length(COALESCE(title, '')) + octet_length(COALESCE(content_text, ''))
          + octet_length(COALESCE(extracted_text, '')) + octet_length(COALESCE(file_name, ''))
          + octet_length(COALESCE(mime_type, '')) + octet_length(COALESCE(data_url, ''))
          + octet_length(meta::text) AS bytes
     FROM write_canvas_assets WHERE user_id = $1
     UNION ALL SELECT octet_length(name) + octet_length(viewport::text)
     FROM write_canvas_projects WHERE user_id = $1
     UNION ALL SELECT octet_length(name) + octet_length(model) + octet_length(system_prompt)
     FROM write_agent_templates WHERE user_id = $1
     UNION ALL SELECT octet_length(name) + octet_length(model) + octet_length(system_prompt)
     FROM write_agent_instances WHERE user_id = $1
     UNION ALL SELECT octet_length(title) + octet_length(summary) + octet_length(COALESCE(business_ref, '')) + octet_length(meta::text)
     FROM write_canvas_nodes WHERE user_id = $1
     UNION ALL SELECT octet_length(relation)
     FROM write_canvas_edges WHERE user_id = $1
     UNION ALL SELECT octet_length(content) + octet_length(meta::text)
     FROM write_canvas_agent_messages WHERE user_id = $1
     UNION ALL SELECT octet_length(title) + octet_length(summary) + octet_length(scenario)
     FROM write_canvas_documents WHERE user_id = $1
     UNION ALL SELECT octet_length(stable_key) + octet_length(heading) + octet_length(body) + octet_length(meta::text)
     FROM write_canvas_document_sections WHERE user_id = $1
     UNION ALL SELECT octet_length(snapshot::text)
     FROM write_canvas_document_versions WHERE user_id = $1
     UNION ALL SELECT octet_length(row_to_json(t)::text)
     FROM write_canvas_agent_groups t WHERE user_id = $1
     UNION ALL SELECT octet_length(row_to_json(t)::text)
     FROM write_canvas_agent_group_members t WHERE user_id = $1
     UNION ALL SELECT octet_length(row_to_json(t)::text)
     FROM write_canvas_agent_runs t WHERE user_id = $1
     UNION ALL SELECT octet_length(row_to_json(t)::text)
     FROM write_canvas_agent_batches t WHERE user_id = $1
   ) stored`,
  [userId],
)).rows[0]?.bytes || 0);

const estimateCanvasStorageBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8") + 512;

const assertCanvasStorageQuota = async (client: pg.PoolClient, userId: number, additionalBytes: number) => {
  const storedBytes = await getCanvasStoredBytes(client, userId);
  const maxStoredBytes = readBoundedEnvNumber(process.env.CANVAS_USER_STORAGE_MAX_MB, 100, 20, 2048) * 1024 * 1024;
  if (storedBytes + Math.max(0, additionalBytes) > maxStoredBytes) {
    throw new CanvasStorageLimitError("画布资料存储额度已用完，请删除旧资料后重试");
  }
};

const ensureCanvasProject = async (pool: pg.Pool, userId: number) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockCanvasUser(client, userId);
    const existing = (await client.query(
      `SELECT id, name, viewport, created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"
       FROM write_canvas_projects
       WHERE user_id = $1
       ORDER BY last_opened_at DESC
       LIMIT 1`,
      [userId]
    )).rows[0];
    if (existing) {
      await client.query("COMMIT");
      return mapCanvasProjectRow(existing);
    }

    const created = (await client.query(
      `INSERT INTO write_canvas_projects (user_id, name)
       VALUES ($1, '我的魔法写作项目')
       RETURNING id, name, viewport, created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"`,
      [userId]
    )).rows[0];
    await client.query("COMMIT");
    return mapCanvasProjectRow(created);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const fetchCanvasProjectDetail = async (pool: pg.Pool, userId: number, projectId: number) => {
  const projectRow = (await pool.query(
    `UPDATE write_canvas_projects
     SET last_opened_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING id, name, viewport, created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"`,
    [projectId, userId]
  )).rows[0];
  if (!projectRow) return null;

  const nodeRows = (await pool.query(
    `SELECT n.id, n.project_id AS "projectId", n.kind, n.node_role AS role, n.content_type AS "contentType",
            n.origin, n.status, n.business_ref AS "businessRef", n.title, n.summary, n.ref_id AS "refId",
            n.meta, n.x, n.y, n.width, n.height, n.created_at AS "createdAt", n.updated_at AS "updatedAt",
            CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', a.id, 'type', a.type, 'title', a.title,
              'contentText', a.content_text, 'extractedText', a.extracted_text,
              'fileName', a.file_name, 'mimeType', a.mime_type,
              'dataUrl', CASE WHEN a.type = 'image' THEN '/api/write/canvas/assets/' || a.id || '/original' ELSE NULL END,
              'meta', a.meta, 'createdAt', a.created_at
            ) END AS asset,
            CASE WHEN ai.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', ai.id, 'projectId', ai.project_id, 'templateId', ai.template_id,
              'name', ai.name, 'model', ai.model, 'systemPrompt', ai.system_prompt,
              'temperature', ai.temperature, 'topP', ai.top_p, 'maxTokens', ai.max_tokens,
              'createdAt', ai.created_at, 'updatedAt', ai.updated_at
            ) END AS agent,
            CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', d.id, 'projectId', d.project_id, 'nodeId', d.node_id,
              'title', d.title, 'summary', d.summary, 'scenario', d.scenario, 'status', d.status,
              'currentVersionId', d.current_version_id, 'createdAt', d.created_at, 'updatedAt', d.updated_at,
              'sections', COALESCE((
                SELECT jsonb_agg(jsonb_build_object('key', ds.stable_key, 'heading', ds.heading, 'body', ds.body, 'level', ds.level, 'meta', ds.meta) ORDER BY ds.sort_order)
                FROM write_canvas_document_sections ds WHERE ds.document_id = d.id
              ), '[]'::jsonb)
            ) END AS document
     FROM write_canvas_nodes n
     LEFT JOIN write_canvas_assets a ON a.id = n.asset_id AND a.user_id = n.user_id
     LEFT JOIN write_agent_instances ai ON ai.id = n.agent_id AND ai.user_id = n.user_id
     LEFT JOIN write_canvas_documents d ON d.id = n.document_id AND d.user_id = n.user_id
     WHERE n.user_id = $1 AND n.project_id = $2
     ORDER BY n.created_at ASC`,
    [userId, projectId]
  )).rows.map(mapCanvasNodeRow);

  const edgeRows = (await pool.query(
    `SELECT id, project_id AS "projectId", source_node_id AS "sourceNodeId",
            target_node_id AS "targetNodeId", relation, created_at AS "createdAt"
     FROM write_canvas_edges
     WHERE user_id = $1 AND project_id = $2
     ORDER BY created_at ASC`,
    [userId, projectId]
  )).rows.map(mapCanvasEdgeRow);

  const agentIds = nodeRows.map(node => node.agent?.id).filter((id): id is number => typeof id === "number");
  const messages: Record<number, ReturnType<typeof mapCanvasMessageRow>[]> = {};
  if (agentIds.length > 0) {
    const messageRows = (await pool.query(
      `SELECT id, agent_id AS "agentId", role, content, meta, created_at AS "createdAt"
       FROM (
         SELECT id, agent_id, role, content, meta, created_at,
                ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY created_at DESC, id DESC) AS message_rank
         FROM write_canvas_agent_messages
         WHERE user_id = $1 AND agent_id = ANY($2::bigint[])
           AND COALESCE(meta->>'status', 'completed') = 'completed'
       ) ranked
       WHERE message_rank <= $3
       ORDER BY "agentId", "createdAt" ASC`,
      [userId, agentIds, WRITE_CANVAS_MAX_MESSAGES_PER_AGENT]
    )).rows.map(mapCanvasMessageRow);
    for (const message of messageRows) {
      if (!messages[message.agentId]) messages[message.agentId] = [];
      messages[message.agentId].push(message);
    }
  }

  return {
    project: mapCanvasProjectRow(projectRow),
    nodes: nodeRows,
    edges: edgeRows,
    messages
  };
};

type CanvasDocumentSectionInput = {
  key: string;
  heading: string;
  body: string;
  level: number;
  meta: Record<string, unknown>;
};

const normalizeCanvasDocumentSections = (value: unknown): CanvasDocumentSectionInput[] | null => {
  if (!Array.isArray(value)) return null;
  const keys = new Set<string>();
  const sections: CanvasDocumentSectionInput[] = [];
  for (const item of value) {
    if (!isPlainRecord(item)) return null;
    const key = typeof item.key === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(item.key)
      ? item.key : randomUUID();
    if (keys.has(key)) return null;
    keys.add(key);
    sections.push({
      key,
      heading: typeof item.heading === "string" ? item.heading.trim().slice(0, 240) : "",
      body: typeof item.body === "string" ? item.body.slice(0, WRITE_AGENT_MAX_MESSAGE_LENGTH) : "",
      level: Math.round(clampNumber(item.level, 1, 1, 6)),
      meta: normalizeJsonObject(item.meta),
    });
  }
  return sections;
};

const getCanvasDocumentMutableBytes = (document: { title: string; summary: string; scenario: string }, sections: CanvasDocumentSectionInput[]) =>
  Buffer.byteLength(document.title + document.summary + document.scenario, "utf8")
    + sections.reduce((total, section) => total + Buffer.byteLength(section.key + section.heading + section.body + JSON.stringify(section.meta), "utf8"), 0);

const getCanvasDocumentSnapshotBytes = (document: { title: string; summary: string; scenario: string; status: string }, sections: CanvasDocumentSectionInput[]) =>
  Buffer.byteLength(JSON.stringify({ ...document, sections }), "utf8");

const getCanvasDocumentBytes = (document: { title: string; summary: string; scenario: string; status: string }, sections: CanvasDocumentSectionInput[]) =>
  getCanvasDocumentMutableBytes(document, sections) + getCanvasDocumentSnapshotBytes(document, sections);

const getCanvasDocumentUpdateAdditionalBytes = (
  currentDocument: { title: string; summary: string; scenario: string; status: string },
  currentSections: CanvasDocumentSectionInput[],
  nextDocument: { title: string; summary: string; scenario: string; status: string },
  nextSections: CanvasDocumentSectionInput[],
) => getCanvasDocumentSnapshotBytes(nextDocument, nextSections)
  + Math.max(0, getCanvasDocumentMutableBytes(nextDocument, nextSections) - getCanvasDocumentMutableBytes(currentDocument, currentSections));

const pruneCanvasDocumentVersions = async (
  client: pg.PoolClient,
  userId: number,
  documentId: number,
  keepCount = CANVAS_DOCUMENT_MAX_VERSIONS,
) => {
  await client.query(
    `DELETE FROM write_canvas_document_versions
     WHERE id IN (
       SELECT id FROM write_canvas_document_versions
       WHERE user_id = $1 AND document_id = $2
       ORDER BY version_number DESC
       OFFSET $3
     )`,
    [userId, documentId, Math.max(0, keepCount)],
  );
};

const writeCanvasDocumentSnapshot = async (
  client: pg.PoolClient,
  userId: number,
  documentId: number,
  document: { title: string; summary: string; scenario: string; status: WriteCanvasNodeStatus },
  sections: CanvasDocumentSectionInput[],
) => {
  const snapshot = { ...document, sections };
  const version = (await client.query(
    `INSERT INTO write_canvas_document_versions (user_id, document_id, version_number, snapshot)
     SELECT $1, $2, COALESCE(MAX(version_number), 0) + 1, $3::jsonb
     FROM write_canvas_document_versions
     WHERE document_id = $2
     RETURNING id`,
    [userId, documentId, JSON.stringify(snapshot)],
  )).rows[0];
  await client.query(`DELETE FROM write_canvas_document_sections WHERE document_id = $1 AND user_id = $2`, [documentId, userId]);
  for (const [index, section] of sections.entries()) {
    await client.query(
      `INSERT INTO write_canvas_document_sections (user_id, document_id, stable_key, sort_order, heading, body, level, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [userId, documentId, section.key, index, section.heading, section.body, section.level, JSON.stringify(section.meta)],
    );
  }
  await client.query(
    `UPDATE write_canvas_documents
     SET title = $1, summary = $2, scenario = $3, status = $4, current_version_id = $5, updated_at = NOW()
     WHERE id = $6 AND user_id = $7`,
    [document.title, document.summary, document.scenario, document.status, Number(version.id), documentId, userId],
  );
  await pruneCanvasDocumentVersions(client, userId, documentId);
  return Number(version.id);
};

const fetchCanvasDocument = async (pool: pg.Pool, userId: number, documentId: number) => {
  const document = (await pool.query(
    `SELECT d.id, d.project_id AS "projectId", d.node_id AS "nodeId", d.title, d.summary, d.scenario, d.status,
            d.current_version_id AS "currentVersionId", d.created_at AS "createdAt", d.updated_at AS "updatedAt",
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('key', s.stable_key, 'heading', s.heading, 'body', s.body, 'level', s.level, 'meta', s.meta) ORDER BY s.sort_order)
              FROM write_canvas_document_sections s WHERE s.document_id = d.id
            ), '[]'::jsonb) AS sections
     FROM write_canvas_documents d
     WHERE d.id = $1 AND d.user_id = $2`,
    [documentId, userId],
  )).rows[0];
  return mapCanvasDocumentRow(document);
};

const resolveCanvasDocumentContext = async (
  pool: pg.Pool,
  userId: number,
  documentId: number,
  sectionKey?: string,
  textBudget = createCanvasContextPlainTextBudget(WRITE_CANVAS_MAX_CONTEXT_CHARS),
) => {
  const row = (await pool.query(
    `SELECT d.title, d.summary,
            COALESCE(jsonb_agg(
              jsonb_build_object('heading', s.heading, 'body', s.body)
              ORDER BY s.sort_order
            ) FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb) AS sections
     FROM write_canvas_documents d
     LEFT JOIN write_canvas_document_sections s
       ON s.document_id = d.id AND s.user_id = d.user_id
      AND ($3::text IS NULL OR s.stable_key = $3)
     WHERE d.id = $1 AND d.user_id = $2
     GROUP BY d.id, d.title, d.summary`,
    [documentId, userId, sectionKey || null],
  )).rows[0];
  if (!row) return null;
  const sections = Array.isArray(row.sections) ? row.sections : [];
  const sectionText = sections.map((section: Record<string, unknown>) => (
    [section.heading, section.body].filter(value => typeof value === "string" && value).join("\n")
  )).join("\n\n");
  return {
    title: sectionKey && typeof sections[0]?.heading === "string" ? sections[0].heading : row.title,
    text: normalizeCanvasContextText(
      [row.title, row.summary, sectionText].filter(Boolean).join("\n\n"),
      textBudget,
      WRITE_CANVAS_MAX_CONTEXT_CHARS,
    ),
  };
};

const getCanvasAgentNode = async (pool: pg.Pool, userId: number, agentId: number) => {
  return (await pool.query(
    `SELECT n.id AS node_id, n.project_id, ai.*
     FROM write_agent_instances ai
     JOIN write_canvas_nodes n ON n.agent_id = ai.id AND n.user_id = ai.user_id
     WHERE ai.id = $1 AND ai.user_id = $2 AND n.kind = 'agent'`,
    [agentId, userId]
  )).rows[0];
};

const resolveCanvasContextItems = async (pool: pg.Pool, userId: number, agentNodeId: number, projectId: number): Promise<CanvasContextItem[]> => {
  const sourceRows = (await pool.query(
    `SELECT n.id, n.kind, n.title, n.summary, n.ref_id, n.document_id, n.content_type, n.meta,
            a.id AS asset_id, a.type AS asset_type, a.title AS asset_title, a.content_text,
            a.extracted_text, a.file_name, a.mime_type,
            CASE WHEN a.type = 'image' THEN a.data_url ELSE NULL END AS data_url
     FROM write_canvas_edges e
     JOIN write_canvas_nodes n ON n.id = e.source_node_id AND n.user_id = e.user_id
     LEFT JOIN write_canvas_assets a ON a.id = n.asset_id AND a.user_id = n.user_id
     WHERE e.user_id = $1 AND e.project_id = $2 AND e.target_node_id = $3 AND e.relation = 'context'
       AND n.status <> 'rejected' AND n.node_role <> 'task'
     ORDER BY e.created_at ASC
     LIMIT $4`,
    [userId, projectId, agentNodeId, WRITE_CANVAS_MAX_CONTEXT_ITEMS]
  )).rows;

  const items: CanvasContextItem[] = [];
  const textBudget = createCanvasContextPlainTextBudget(WRITE_CANVAS_MAX_CONTEXT_CHARS);
  for (const row of sourceRows) {
    const kind = normalizeCanvasNodeKind(row.kind);
    if (!kind) continue;
    if (row.document_id) {
      const documentContext = await resolveCanvasDocumentContext(pool, userId, Number(row.document_id), undefined, textBudget);
      if (documentContext) {
        items.push({ nodeId: Number(row.id), kind, title: documentContext.title || row.title, text: documentContext.text });
      }
      continue;
    }
    if (row.content_type === "document_section") {
      const documentId = Number(row.meta?.documentId);
      const sectionKey = typeof row.meta?.sectionKey === "string" ? row.meta.sectionKey : "";
      if (Number.isSafeInteger(documentId) && documentId > 0 && sectionKey) {
        const sectionContext = await resolveCanvasDocumentContext(pool, userId, documentId, sectionKey, textBudget);
        if (sectionContext) {
          items.push({ nodeId: Number(row.id), kind, title: sectionContext.title || row.title, text: sectionContext.text });
        }
      }
      continue;
    }
    if (["asset_text", "asset_file", "asset_image", "result"].includes(kind)) {
      const text = normalizeCanvasContextText([
        row.content_text,
        row.extracted_text,
        row.summary,
        row.meta?.note,
      ].filter(Boolean).join("\n"), textBudget, 12000);
      items.push({
        nodeId: Number(row.id),
        kind,
        title: row.title || row.asset_title || row.file_name || "资料",
        text,
        imageDataUrl: kind === "asset_image" ? row.data_url || undefined : undefined,
        mimeType: row.mime_type || undefined,
        sourceLabel: row.file_name || undefined
      });
      continue;
    }
    if (kind === "saved_article" && row.ref_id) {
      const article = (await pool.query(
        `SELECT id, title, source, url, excerpt, content, citation_context, image_urls
         FROM saved_articles
         WHERE id = $1 AND user_id = $2`,
        [Number(row.ref_id), userId]
      )).rows[0];
      if (article) {
        items.push({
          nodeId: Number(row.id),
          kind,
          title: article.title,
          text: normalizeCanvasContextText([article.citation_context, article.excerpt, article.content].filter(Boolean).join("\n"), textBudget, 12000),
          sourceLabel: article.source || article.url || undefined
        });
      }
      continue;
    }
    if (kind === "atom_card" && row.ref_id) {
      const card = (await pool.query(
        `SELECT sc.id, sc.type, sc.content, sc.summary, sc.original_quote, sc.context,
                sc.citation_note, sc.tags, sc.article_title, sa.source, sa.url
         FROM saved_cards sc
         LEFT JOIN saved_articles sa ON sa.id = sc.saved_article_id AND sa.user_id = sc.user_id
         WHERE sc.id = $1 AND sc.user_id = $2`,
        [row.ref_id, userId]
      )).rows[0];
      if (card) {
        items.push({
          nodeId: Number(row.id),
          kind,
          title: `${card.type} · ${card.article_title || row.title || "原子卡"}`,
          text: normalizeCanvasContextText([
            `[${card.type}] ${card.content}`,
            card.summary,
            card.context,
            card.original_quote ? `原文摘录：${card.original_quote}` : "",
            card.citation_note ? `引用建议：${card.citation_note}` : "",
            card.tags ? `tags：${(typeof card.tags === "string" ? JSON.parse(card.tags) : card.tags).join("、")}` : "",
          ].filter(Boolean).join("\n"), textBudget, 6000),
          sourceLabel: card.source || card.url || undefined
        });
      }
      continue;
    }
    if (kind === "note" && row.ref_id) {
      const note = (await pool.query(
        `SELECT id, title, content, tags
         FROM notes
         WHERE id = $1 AND user_id = $2`,
        [Number(row.ref_id), userId]
      )).rows[0];
      if (note) {
        items.push({
          nodeId: Number(row.id),
          kind,
          title: note.title || row.title || "文章草稿",
          text: normalizeCanvasContextText(note.content || "", textBudget, 12000),
          sourceLabel: "我的文章"
        });
      }
    }
  }
  return items;
};

const canvasModelSupportsImages = (model: string) => {
  const normalized = model.toLowerCase();
  return /(vision|vl|gpt-4o|gpt-4\.1|gpt-5|o3|o4|gemini|claude-3|mimo-vl)/.test(normalized);
};

const requestCanvasAgentCompletion = async (input: {
  model: string;
  systemPrompt: string;
  message: string;
  contexts: CanvasContextItem[];
  previousMessages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature: number;
  topP: number;
  maxTokens: number;
}) => {
  assertCanvasAggregateContextWithinLimit(input.contexts, input.message, input.systemPrompt, input.previousMessages);
  const config = getOpenAIWriteAgentConfig();
  if (!config) {
    throw new Error("Writing agent model is not configured: set OPENAI_API_KEY/OPENAI_MODEL or AI_API_KEY/AI_BASE_URL/AI_MODEL");
  }
  const model = normalizeAiModelName(input.model || config.model);
  if (!isAllowedCanvasAgentModel(model)) {
    throw new Error("Canvas Agent model is not allowed by the server configuration");
  }
  const chatCompletionsUrl = config.providerLabel === "openai"
    ? "https://api.openai.com/v1/chat/completions"
    : buildOpenAiCompatibleChatCompletionsUrl(config.baseURL || "");
  const contextText = input.contexts.length
    ? input.contexts.map((item, index) => [
      `#${index + 1} ${item.title}`,
      `类型：${item.kind}`,
      item.sourceLabel ? `来源：${item.sourceLabel}` : "",
      item.text || "(无可读文本)",
    ].filter(Boolean).join("\n")).join("\n\n---\n\n")
    : "无连接上下文。";

  const supportsImages = canvasModelSupportsImages(model);
  const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
  if (supportsImages) {
    let imageBytes = 0;
    for (const item of input.contexts) {
      if (!item.imageDataUrl || imageParts.length >= WRITE_CANVAS_MAX_CONTEXT_IMAGES) continue;
      const estimatedBytes = Math.ceil(item.imageDataUrl.length * 0.75);
      if (imageBytes + estimatedBytes > WRITE_CANVAS_MAX_CONTEXT_IMAGE_BYTES) continue;
      imageBytes += estimatedBytes;
      imageParts.push({ type: "image_url", image_url: { url: item.imageDataUrl } });
    }
  }
  const userContent = [
    `用户最新消息：${input.message}`,
    "",
    "以下是本次画布连线授权的上下文。不要使用未连接的资料；如果上下文不足，直接说明缺口。",
    "",
    contextText
  ].join("\n");
  const messages: any[] = [
    { role: "system", content: input.systemPrompt || getDefaultCanvasAgentConfig().systemPrompt },
    ...input.previousMessages.slice(-8).map(message => ({ role: message.role, content: message.content })),
    imageParts.length > 0
      ? { role: "user", content: [{ type: "text", text: userContent }, ...imageParts] }
      : { role: "user", content: userContent }
  ];

  const response = await fetch(chatCompletionsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: clampNumber(input.temperature, 0.55, 0, 2),
      top_p: clampNumber(input.topP, 1, 0.01, 1),
      max_tokens: Math.round(clampNumber(input.maxTokens, 1200, 128, getCanvasAgentMaxOutputTokens())),
    }),
    signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const responseBody = await response.text();
    logger.error({ module: "canvas-agent", status: response.status, responseBody: responseBody.slice(0, 1000) }, "Canvas agent request failed");
    throw new Error(`AI request failed ${response.status}: ${responseBody}`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return {
    content: requireCanvasCompletionContent(data.choices?.[0]?.message?.content || ""),
    model,
    provider: config.providerLabel,
    usedImages: imageParts.length
  };
};

type ExtractedKnowledge = {
  cards: Omit<AtomCard, "id" | "articleTitle" | "articleId">[];
  articleCitationContext?: string;
};

const buildDefaultArticleCitationContext = (article: Article) => {
  const parts = [
    `来源：${article.source || "未知来源"}`,
    article.topic ? `话题：${article.topic}` : "",
    article.title ? `标题：${article.title}` : "",
    article.publishedAt ? `发布时间：${new Date(article.publishedAt).toLocaleDateString("zh-CN")}` : "",
    article.excerpt ? `摘要：${normalizePlainText(article.excerpt).slice(0, 220)}` : ""
  ].filter(Boolean);
  return parts.join("；").slice(0, 700);
};

const extractKnowledgeWithAI = async (
  article: Article,
  storageSkills: WriteAgentSkillRecord[] = [],
  onProviderStart?: () => void | Promise<void>,
): Promise<ExtractedKnowledge> => {
  if (!getAiChatConfig()) return { cards: [] };

  try {
    const plainContent = normalizePlainText(
      article.markdownContent || article.content || article.excerpt,
      5200,
    );

    if (plainContent.length < 30) return { cards: [] };

    const skillPrompt = formatAgentSkillInstructions(storageSkills, ["card_storage", "citation"]);
    const userPrompt = `标题：${article.title}\n来源：${article.source}\n话题：${article.topic}
${skillPrompt ? `\n本次入库必须遵循的 Skills：\n${skillPrompt}` : ""}

正文：${plainContent}`;

    await onProviderStart?.();
    const raw = await requestAiChatCompletion([
      { role: 'user', content: `${AI_SYSTEM_PROMPT}\n\n===文章===\n${userPrompt}` }
    ], {
      maxTokens: 1800,
      temperature: 0.3,
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
      logLabel: "card_extraction",
      disableThinking: true
    });
    if (!raw) return { cards: [] };

    // Strip markdown code fences if present
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const parsed: unknown = JSON.parse(cleaned);
    const parsedRecord = isPlainRecord(parsed) ? parsed : null;
    const rawCards = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsedRecord?.cards)
        ? parsedRecord.cards
        : [];
    const articleCitationContext = typeof parsedRecord?.articleCitationContext === 'string'
      ? parsedRecord.articleCitationContext.trim().slice(0, 700)
      : undefined;

    if (!Array.isArray(rawCards)) return { cards: [], articleCitationContext };

    // Validate and sanitize each card
    const validCards: Omit<AtomCard, "id" | "articleTitle" | "articleId">[] = [];
    for (const item of rawCards.slice(0, 4)) {
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
          content: card.content.trim().slice(0, 520),
          summary: typeof card.summary === 'string' ? card.summary.trim().slice(0, 180) : undefined,
          originalQuote: typeof card.originalQuote === 'string' ? card.originalQuote.trim().slice(0, 260) : undefined,
          context: typeof card.context === 'string' ? card.context.trim().slice(0, 360) : undefined,
          citationNote: typeof card.citationNote === 'string' ? card.citationNote.trim().slice(0, 220) : undefined,
          evidenceRole: typeof card.evidenceRole === 'string' ? card.evidenceRole.trim().slice(0, 40) : undefined,
          tags: (card.tags as string[]).slice(0, 6)
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
    return { cards: validCards, articleCitationContext };
  } catch (err) {
    logger.error({ err, module: "ai", articleTitle: article.title.slice(0, 80) }, "AI card extraction failed");
    return { cards: [] };
  }
};

const isBlockedPageContent = (content: string) => {
  const plain = normalizePlainText(content || '');
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
  const plain = normalizePlainText(content || '');
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
  return article.source.includes('36') || urlMatchesHostname(article.url, '36kr.com');
};

const get36KrArticleId = (url?: string) => {
  if (!url) return null;
  const match = url.match(/\/p\/(\d+)/);
  return match?.[1] || null;
};

async function fetchRSSFeeds(maxItems: number): Promise<{
  timelineArticles: Article[];
  fullArticles: Article[];
  refreshedSources: string[];
}> {
  try {
    const results = await Promise.allSettled(
      BUILTIN_RSS_FEEDS.map(feed => parseWithRetry([...feed.urls], 20000, 2)),
    );
    const collected = collectSettledFeedArticles(
      BUILTIN_RSS_FEEDS,
      results,
      (parsed, feed) => normalizeFeedItems(
        parsed.items,
        feed.source,
        feed.topic,
        feed.idOffset,
        extractFeedIcon(parsed),
        { maxItems },
      ),
    );
    logger.info({ module: "rss", counts: collected.counts }, "RSS feed counts");
    collected.failures.forEach(({ definition, error }) => {
      logger.error({ err: error, module: "rss", feed: definition.logName }, "Failed to fetch RSS feed");
    });
    const timelineArticles = buildHomepageTimeline(collected.articles);
    return {
      timelineArticles: rankArticles(timelineArticles),
      fullArticles: collected.articles,
      refreshedSources: BUILTIN_RSS_FEEDS
        .filter(feed => (collected.articlesBySource[feed.key]?.length ?? 0) > 0)
        .map(feed => feed.source),
    };
  } catch (error) {
    logger.error({ err: error, module: "rss" }, "Failed to fetch RSS, keeping cached data");
    return { timelineArticles: [], fullArticles: [], refreshedSources: [] };
  }
}

function buildHomepageTimeline(fullArticles: Article[]): Article[] {
  const selected = BUILTIN_RSS_FEEDS.flatMap(feed => fullArticles
    .filter(article => article.source === feed.source || article.sourceAliases?.includes(feed.source))
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    .slice(0, getDefaultFeedLimit(feed.source)));
  return rankArticles(mergeArticleSourceMemberships(selected));
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 1000);
  const appUrl = process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  if (isProduction && (!appUrl || /your-domain\.example|replace-/i.test(appUrl))) {
    throw new Error("APP_URL or RAILWAY_PUBLIC_DOMAIN must identify the real production origin");
  }
  validateProductionLegalConfiguration(appUrl);
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  const dbPoolMax = readBoundedEnvNumber(process.env.DB_POOL_MAX, 10, 2, 50);
  const dbConnectionTimeoutMs = readBoundedEnvNumber(process.env.DB_CONNECTION_TIMEOUT_MS, 5000, 1000, 30000);
  const dbIdleTimeoutMs = readBoundedEnvNumber(process.env.DB_IDLE_TIMEOUT_MS, 30000, 5000, 120000);
  const dbStatementTimeoutMs = readBoundedEnvNumber(process.env.DB_STATEMENT_TIMEOUT_MS, 30000, 1000, 120000);
  if (isProduction && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable must be set in production");
  }

  // --- Database init (PostgreSQL) ---
  // Note: rejectUnauthorized: false is required for Railway's self-signed PG certs.
  // If migrating to another platform (Supabase, Neon, etc.), review this setting.
  let pool: pg.Pool | null = null;
  let dbAvailable = false;
  let schemaReady = false;
  try {
    const _pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
      max: dbPoolMax,
      connectionTimeoutMillis: dbConnectionTimeoutMs,
      idleTimeoutMillis: dbIdleTimeoutMs,
      statement_timeout: dbStatementTimeoutMs,
      query_timeout: dbStatementTimeoutMs + 1000,
    });
    _pool.on("error", error => {
      logger.error({ err: error, module: "db" }, "Unexpected PostgreSQL pool error");
    });
    // Test connection
    await _pool.query('SELECT 1');
    pool = _pool;
    dbAvailable = true;
    logger.info({ module: "db" }, "Database connected successfully");
  } catch (err) {
    if (isProduction) throw err;
    logger.warn({ err, module: "db" }, "Database unavailable; server will start without auth/persistence features");
  }

  if (pool) {
  const schemaLockClient = await pool.connect();
  let schemaLockReleased = false;
  try {
  await schemaLockClient.query(`SELECT pg_advisory_lock(hashtext('atomflow-schema-migration'))`);
  const runSchemaTransaction = async (operation: (client: pg.PoolClient) => Promise<void>) => {
    await schemaLockClient.query("BEGIN");
    try {
      await operation(schemaLockClient);
      await schemaLockClient.query("COMMIT");
    } catch (error) {
      await schemaLockClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  };
  try {
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
    CREATE TABLE IF NOT EXISTS user_ai_usage_daily (
      user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      usage_date            DATE NOT NULL DEFAULT CURRENT_DATE,
      operation_count       INTEGER NOT NULL DEFAULT 0 CHECK (operation_count >= 0),
      reserved_output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_output_tokens >= 0),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, usage_date)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_budget_reservations (
      id              BIGSERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      usage_date      DATE NOT NULL,
      reserved_tokens BIGINT NOT NULL CHECK (reserved_tokens > 0),
      operation_count INTEGER NOT NULL DEFAULT 1 CHECK (operation_count > 0),
      route            TEXT NOT NULL DEFAULT '',
      state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','provider_started','refunded')),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_budget_reservations_pending ON ai_budget_reservations(updated_at) WHERE state = 'pending'`);
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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vc_expires_at ON verification_codes(expires_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vc_used_created_at ON verification_codes(created_at) WHERE used = TRUE`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON session(expire)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_user_id ON session ((sess ->> 'userId'))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_cards (
      id             TEXT PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type           TEXT NOT NULL,
      content        TEXT NOT NULL,
      tags           JSONB NOT NULL DEFAULT '[]'::jsonb,
      article_title  TEXT NOT NULL DEFAULT '',
      article_id     BIGINT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_cards_user ON saved_cards(user_id)`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_cards_updated ON saved_cards(user_id, updated_at DESC)`);

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
      thread_type  TEXT NOT NULL DEFAULT 'chat' CHECK (thread_type IN ('chat', 'skill')),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_threads_user ON write_agent_threads(user_id, updated_at DESC)`);
  await pool.query(`ALTER TABLE write_agent_threads ADD COLUMN IF NOT EXISTS thread_type TEXT NOT NULL DEFAULT 'chat'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_threads_type ON write_agent_threads(user_id, thread_type, updated_at DESC)`);
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
      citation_context TEXT,
      image_urls    JSONB NOT NULL DEFAULT '[]'::jsonb,
      published_at  BIGINT,
      saved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE saved_articles ADD COLUMN IF NOT EXISTS citation_context TEXT`);
  await pool.query(`ALTER TABLE saved_articles ADD COLUMN IF NOT EXISTS image_urls JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE saved_articles ADD COLUMN IF NOT EXISTS content_hash TEXT`);
  await pool.query(`ALTER TABLE saved_articles ADD COLUMN IF NOT EXISTS normalized_url TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_articles_user ON saved_articles(user_id, saved_at DESC)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_articles_unique ON saved_articles(user_id, url) WHERE url IS NOT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_agent_events (
      id           BIGSERIAL PRIMARY KEY,
      thread_id    BIGINT NOT NULL REFERENCES write_agent_threads(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      node         TEXT NOT NULL,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      input_summary TEXT,
      output_summary TEXT,
      meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_events_thread ON write_agent_events(thread_id, created_at ASC)`);

	  await pool.query(`
	    CREATE TABLE IF NOT EXISTS write_style_skills (
      id           BIGSERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      prompt       TEXT NOT NULL,
      examples     JSONB NOT NULL DEFAULT '[]'::jsonb,
      constraints  JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_default   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
	  `);
	  await pool.query(`ALTER TABLE write_style_skills ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'style'`);
	  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_style_skills_user ON write_style_skills(user_id, updated_at DESC)`);
	  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_style_skills_user_type ON write_style_skills(user_id, type, updated_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_projects (
      id             BIGSERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name           TEXT NOT NULL DEFAULT '新的魔法写作项目',
      viewport       JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (id, user_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_projects_user ON write_canvas_projects(user_id, last_opened_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_assets (
      id             BIGSERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id     BIGINT REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
      type           TEXT NOT NULL CHECK (type IN ('text','file','image')),
      title          TEXT NOT NULL DEFAULT '',
      content_text   TEXT NOT NULL DEFAULT '',
      extracted_text TEXT NOT NULL DEFAULT '',
      file_name      TEXT,
      mime_type      TEXT,
      data_url       TEXT,
      meta           JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_assets_user ON write_canvas_assets(user_id, created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_agent_templates (
      id            BIGSERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      model         TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      temperature   REAL NOT NULL DEFAULT 0.55,
      top_p         REAL NOT NULL DEFAULT 1,
      max_tokens    INTEGER NOT NULL DEFAULT 1200,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_templates_user ON write_agent_templates(user_id, updated_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_agent_instances (
      id            BIGSERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id    BIGINT NOT NULL REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
      template_id   BIGINT REFERENCES write_agent_templates(id) ON DELETE SET NULL,
      name          TEXT NOT NULL DEFAULT '写作 Agent',
      model         TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      temperature   REAL NOT NULL DEFAULT 0.55,
      top_p         REAL NOT NULL DEFAULT 1,
      max_tokens    INTEGER NOT NULL DEFAULT 1200,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_instances_project ON write_agent_instances(project_id, updated_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_nodes (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id  BIGINT NOT NULL REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN ('asset_text','asset_file','asset_image','saved_article','atom_card','note','agent','result')),
      title       TEXT NOT NULL DEFAULT '',
      summary     TEXT NOT NULL DEFAULT '',
      ref_id      TEXT,
      asset_id    BIGINT REFERENCES write_canvas_assets(id) ON DELETE SET NULL,
      agent_id    BIGINT REFERENCES write_agent_instances(id) ON DELETE CASCADE,
      meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
      x           REAL NOT NULL DEFAULT 0,
      y           REAL NOT NULL DEFAULT 0,
      width       REAL NOT NULL DEFAULT 280,
      height      REAL NOT NULL DEFAULT 180,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (id, user_id, project_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_nodes_project ON write_canvas_nodes(project_id, updated_at DESC)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_nodes_tenant_project_unique ON write_canvas_nodes(id, user_id, project_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_edges (
      id             BIGSERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id     BIGINT NOT NULL REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
      source_node_id BIGINT NOT NULL REFERENCES write_canvas_nodes(id) ON DELETE CASCADE,
      target_node_id BIGINT NOT NULL REFERENCES write_canvas_nodes(id) ON DELETE CASCADE,
      relation       TEXT NOT NULL DEFAULT 'context' CHECK (relation IN ('context')),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, source_node_id, target_node_id, relation)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_edges_target ON write_canvas_edges(project_id, target_node_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_agent_messages (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id   BIGINT NOT NULL REFERENCES write_agent_instances(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content    TEXT NOT NULL DEFAULT '',
      meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_messages_agent ON write_canvas_agent_messages(agent_id, created_at ASC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_agent_groups (
      id              BIGSERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id      BIGINT NOT NULL REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
      node_id         BIGINT,
      current_batch_id BIGINT,
      name            TEXT NOT NULL,
      shared_prompt   TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','running','completed','partial','failed','cancelled')),
      config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (id, user_id, project_id),
      FOREIGN KEY (node_id, user_id, project_id) REFERENCES write_canvas_nodes(id, user_id, project_id) ON DELETE CASCADE
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_groups_project ON write_canvas_agent_groups(user_id, project_id, updated_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_agent_group_members (
      id              BIGSERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id      BIGINT NOT NULL,
      group_id        BIGINT NOT NULL,
      name            TEXT NOT NULL,
      model           TEXT NOT NULL,
      system_prompt   TEXT NOT NULL DEFAULT '',
      temperature     REAL NOT NULL DEFAULT 0.55,
      top_p           REAL NOT NULL DEFAULT 1,
      max_tokens      INTEGER NOT NULL DEFAULT 1200,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (id, user_id, project_id, group_id),
      FOREIGN KEY (group_id, user_id, project_id) REFERENCES write_canvas_agent_groups(id, user_id, project_id) ON DELETE CASCADE
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_group_members_group ON write_canvas_agent_group_members(user_id, group_id, id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_agent_batches (
      id               BIGSERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id       BIGINT NOT NULL REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
      group_id         BIGINT NOT NULL,
      message          TEXT NOT NULL DEFAULT '',
      context_node_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
      context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      config_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
      output           JSONB NOT NULL DEFAULT '{}'::jsonb,
      error            TEXT,
      started_at       TIMESTAMPTZ,
      completed_at     TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (id, user_id, project_id, group_id),
      FOREIGN KEY (group_id, user_id, project_id) REFERENCES write_canvas_agent_groups(id, user_id, project_id) ON DELETE CASCADE
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_batches_group ON write_canvas_agent_batches(user_id, group_id, created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_agent_runs (
      id               BIGSERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id       BIGINT NOT NULL,
      group_id         BIGINT,
      group_member_id  BIGINT,
      batch_id         BIGINT,
      source_node_id   BIGINT,
      action           TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
      context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      config_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
      output           TEXT NOT NULL DEFAULT '',
      error            TEXT,
      reserved_tokens  BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
      reservation_date DATE,
      provider_started BOOLEAN NOT NULL DEFAULT FALSE,
      started_at       TIMESTAMPTZ,
      completed_at     TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (id, user_id, project_id),
      CONSTRAINT write_canvas_agent_runs_project_owner_fkey FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE,
      CONSTRAINT write_canvas_agent_runs_group_owner_fkey FOREIGN KEY (group_id, user_id, project_id) REFERENCES write_canvas_agent_groups(id, user_id, project_id) ON DELETE CASCADE,
      CONSTRAINT write_canvas_agent_runs_group_member_owner_fkey FOREIGN KEY (group_member_id, user_id, project_id, group_id) REFERENCES write_canvas_agent_group_members(id, user_id, project_id, group_id) ON DELETE SET NULL (group_member_id),
      CONSTRAINT write_canvas_agent_runs_batch_owner_fkey FOREIGN KEY (batch_id, user_id, project_id, group_id) REFERENCES write_canvas_agent_batches(id, user_id, project_id, group_id) ON DELETE CASCADE,
      CONSTRAINT write_canvas_agent_runs_source_owner_fkey FOREIGN KEY (source_node_id, user_id, project_id) REFERENCES write_canvas_nodes(id, user_id, project_id) ON DELETE SET NULL (source_node_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_runs_user ON write_canvas_agent_runs(user_id, project_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_runs_batch ON write_canvas_agent_runs(batch_id, created_at ASC) WHERE batch_id IS NOT NULL`);
  await pool.query(`ALTER TABLE write_canvas_agent_runs ADD COLUMN IF NOT EXISTS reserved_tokens BIGINT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE write_canvas_agent_runs ADD COLUMN IF NOT EXISTS reservation_date DATE`);
  await pool.query(`ALTER TABLE write_canvas_agent_runs ADD COLUMN IF NOT EXISTS provider_started BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_runs_reserved_tokens_check') THEN
        ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_reserved_tokens_check CHECK (reserved_tokens >= 0);
      END IF;
    END $$
  `);

  await runSchemaTransaction(async client => {
  await client.query(`ALTER TABLE write_canvas_agent_groups ADD COLUMN IF NOT EXISTS node_id BIGINT`);
  await client.query(`ALTER TABLE write_canvas_agent_groups ADD COLUMN IF NOT EXISTS current_batch_id BIGINT`);
  await client.query(`
    UPDATE write_canvas_agent_groups g
    SET current_batch_id = active.id
    FROM (
      SELECT DISTINCT ON (group_id, user_id) id, group_id, user_id
      FROM write_canvas_agent_batches
      WHERE status = 'running'
      ORDER BY group_id, user_id, started_at DESC NULLS LAST, id DESC
    ) active
    WHERE g.id = active.group_id AND g.user_id = active.user_id AND g.current_batch_id IS NULL
  `);
  await client.query(`ALTER TABLE write_canvas_agent_group_members ADD COLUMN IF NOT EXISTS project_id BIGINT`);
  await client.query(`
    UPDATE write_canvas_agent_group_members m
    SET project_id = g.project_id
    FROM write_canvas_agent_groups g
    WHERE m.group_id = g.id AND m.user_id = g.user_id AND m.project_id IS NULL
  `);
  await client.query(`ALTER TABLE write_canvas_agent_group_members ALTER COLUMN project_id SET NOT NULL`);
  await client.query(`
    DO $$ DECLARE constraint_definition TEXT; BEGIN
      SELECT pg_get_constraintdef(oid) INTO constraint_definition
      FROM pg_constraint WHERE conname = 'write_canvas_agent_groups_status_check';
      IF constraint_definition IS NULL THEN
        ALTER TABLE write_canvas_agent_groups ADD CONSTRAINT write_canvas_agent_groups_status_check
          CHECK (status IN ('ready','running','completed','partial','failed','cancelled'));
      ELSIF POSITION('partial' IN constraint_definition) = 0 OR POSITION('cancelled' IN constraint_definition) = 0 THEN
        ALTER TABLE write_canvas_agent_groups DROP CONSTRAINT write_canvas_agent_groups_status_check;
        ALTER TABLE write_canvas_agent_groups ADD CONSTRAINT write_canvas_agent_groups_status_check
          CHECK (status IN ('ready','running','completed','partial','failed','cancelled'));
      END IF;

      SELECT pg_get_constraintdef(oid) INTO constraint_definition
      FROM pg_constraint WHERE conname = 'write_canvas_agent_batches_status_check';
      IF constraint_definition IS NULL THEN
        ALTER TABLE write_canvas_agent_batches ADD CONSTRAINT write_canvas_agent_batches_status_check
          CHECK (status IN ('queued','running','completed','partial','failed','cancelled'));
      ELSIF POSITION('partial' IN constraint_definition) = 0 OR POSITION('cancelled' IN constraint_definition) = 0 THEN
        ALTER TABLE write_canvas_agent_batches DROP CONSTRAINT write_canvas_agent_batches_status_check;
        ALTER TABLE write_canvas_agent_batches ADD CONSTRAINT write_canvas_agent_batches_status_check
          CHECK (status IN ('queued','running','completed','partial','failed','cancelled'));
      END IF;

      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_runs_project_id_fkey') THEN
        ALTER TABLE write_canvas_agent_runs DROP CONSTRAINT write_canvas_agent_runs_project_id_fkey;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_runs_group_id_fkey') THEN
        ALTER TABLE write_canvas_agent_runs DROP CONSTRAINT write_canvas_agent_runs_group_id_fkey;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_runs_group_member_id_fkey') THEN
        ALTER TABLE write_canvas_agent_runs DROP CONSTRAINT write_canvas_agent_runs_group_member_id_fkey;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_runs_batch_id_fkey') THEN
        ALTER TABLE write_canvas_agent_runs DROP CONSTRAINT write_canvas_agent_runs_batch_id_fkey;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_runs_source_node_id_fkey') THEN
        ALTER TABLE write_canvas_agent_runs DROP CONSTRAINT write_canvas_agent_runs_source_node_id_fkey;
      END IF;
    END $$
  `);
  await client.query(`
    UPDATE write_canvas_agent_groups g
    SET current_batch_id = NULL, status = CASE WHEN status = 'running' THEN 'failed' ELSE status END, updated_at = NOW()
    WHERE current_batch_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM write_canvas_agent_batches b
        WHERE b.id = g.current_batch_id AND b.user_id = g.user_id
          AND b.project_id = g.project_id AND b.group_id = g.id
      )
  `);
  await client.query(`
    DELETE FROM write_canvas_agent_runs
    WHERE NOT (
      (group_id IS NULL AND group_member_id IS NULL AND batch_id IS NULL)
      OR (group_id IS NOT NULL AND batch_id IS NOT NULL)
    )
  `);
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_projects_tenant_key') THEN
        ALTER TABLE write_canvas_projects ADD CONSTRAINT write_canvas_projects_tenant_key UNIQUE (id, user_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_nodes_tenant_project_key') THEN
        ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_tenant_project_key UNIQUE (id, user_id, project_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_groups_tenant_project_key') THEN
        ALTER TABLE write_canvas_agent_groups ADD CONSTRAINT write_canvas_agent_groups_tenant_project_key UNIQUE (id, user_id, project_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_group_members_tenant_group_key') THEN
        ALTER TABLE write_canvas_agent_group_members ADD CONSTRAINT write_canvas_agent_group_members_tenant_group_key UNIQUE (id, user_id, project_id, group_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_batches_tenant_group_key') THEN
        ALTER TABLE write_canvas_agent_batches ADD CONSTRAINT write_canvas_agent_batches_tenant_group_key UNIQUE (id, user_id, project_id, group_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_groups_project_owner_fkey') THEN
        ALTER TABLE write_canvas_agent_groups ADD CONSTRAINT write_canvas_agent_groups_project_owner_fkey FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_group_members_group_owner_fkey') THEN
        ALTER TABLE write_canvas_agent_group_members ADD CONSTRAINT write_canvas_agent_group_members_group_owner_fkey FOREIGN KEY (group_id, user_id, project_id) REFERENCES write_canvas_agent_groups(id, user_id, project_id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_batches_group_owner_fkey') THEN
        ALTER TABLE write_canvas_agent_batches ADD CONSTRAINT write_canvas_agent_batches_group_owner_fkey FOREIGN KEY (group_id, user_id, project_id) REFERENCES write_canvas_agent_groups(id, user_id, project_id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_groups_current_batch_owner_fkey') THEN
        ALTER TABLE write_canvas_agent_groups ADD CONSTRAINT write_canvas_agent_groups_current_batch_owner_fkey
          FOREIGN KEY (current_batch_id, user_id, project_id, id)
          REFERENCES write_canvas_agent_batches(id, user_id, project_id, group_id)
          ON DELETE SET NULL (current_batch_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_runs_group_owner_fkey') THEN
        ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_group_owner_fkey FOREIGN KEY (group_id, user_id, project_id) REFERENCES write_canvas_agent_groups(id, user_id, project_id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_runs_project_owner_fkey') THEN
        ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_project_owner_fkey FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_runs_group_member_owner_fkey') THEN
        ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_group_member_owner_fkey FOREIGN KEY (group_member_id, user_id, project_id, group_id) REFERENCES write_canvas_agent_group_members(id, user_id, project_id, group_id) ON DELETE SET NULL (group_member_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_runs_batch_owner_fkey') THEN
        ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_batch_owner_fkey FOREIGN KEY (batch_id, user_id, project_id, group_id) REFERENCES write_canvas_agent_batches(id, user_id, project_id, group_id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_runs_source_owner_fkey') THEN
        ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_source_owner_fkey FOREIGN KEY (source_node_id, user_id, project_id) REFERENCES write_canvas_nodes(id, user_id, project_id) ON DELETE SET NULL (source_node_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_runs_group_fields_check') THEN
        ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_group_fields_check
          CHECK (
            (group_id IS NULL AND group_member_id IS NULL AND batch_id IS NULL)
            OR (group_id IS NOT NULL AND batch_id IS NOT NULL)
          );
      END IF;
    END $$
  `);
  });

  await pool.query(`ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS node_role TEXT`);
  await pool.query(`ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS content_type TEXT`);
  await pool.query(`ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS origin TEXT`);
  await pool.query(`ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS status TEXT`);
  await pool.query(`ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS business_ref TEXT`);
  await pool.query(`ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS document_id BIGINT`);
  await pool.query(`
    UPDATE write_canvas_nodes
    SET node_role = CASE kind
      WHEN 'asset_text' THEN 'material' WHEN 'asset_file' THEN 'material' WHEN 'asset_image' THEN 'material'
      WHEN 'saved_article' THEN 'material' WHEN 'atom_card' THEN 'material'
      WHEN 'agent' THEN 'task' WHEN 'result' THEN 'document' ELSE 'insight' END,
        content_type = CASE kind
      WHEN 'asset_text' THEN 'text' WHEN 'asset_file' THEN 'file' WHEN 'asset_image' THEN 'image'
      WHEN 'saved_article' THEN 'article' WHEN 'atom_card' THEN 'atom_card' WHEN 'agent' THEN 'agent'
      WHEN 'result' THEN 'result' ELSE 'note' END,
        origin = CASE WHEN kind IN ('asset_text', 'asset_file', 'asset_image', 'saved_article', 'atom_card') THEN 'existing'
                      WHEN kind = 'result' THEN 'generated' ELSE 'manual' END,
        status = CASE WHEN kind = 'result' THEN 'pending_review' ELSE 'ready' END
    WHERE node_role IS NULL OR content_type IS NULL OR origin IS NULL OR status IS NULL
  `);
  // Keep these columns nullable during rolling deploys so an older instance can still insert nodes.
  await pool.query(`ALTER TABLE write_canvas_nodes ALTER COLUMN node_role DROP NOT NULL`);
  await pool.query(`ALTER TABLE write_canvas_nodes ALTER COLUMN content_type DROP NOT NULL`);
  await pool.query(`ALTER TABLE write_canvas_nodes ALTER COLUMN origin DROP NOT NULL`);
  await pool.query(`ALTER TABLE write_canvas_nodes ALTER COLUMN status DROP NOT NULL`);
  await runSchemaTransaction(async client => {
  await client.query(`
    WITH ranked AS (
      SELECT n.id,
             ROW_NUMBER() OVER (
               PARTITION BY n.user_id, n.project_id, n.content_type, n.business_ref
               ORDER BY CASE WHEN g.node_id = n.id THEN 0 ELSE 1 END, n.id
             ) AS duplicate_rank
      FROM write_canvas_nodes n
      LEFT JOIN write_canvas_agent_groups g
        ON g.user_id = n.user_id AND g.project_id = n.project_id AND g.id::text = n.business_ref
      WHERE n.content_type = 'agent_group' AND n.business_ref IS NOT NULL
    )
    DELETE FROM write_canvas_nodes n
    USING ranked
    WHERE n.id = ranked.id AND ranked.duplicate_rank > 1
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_agent_group_business_ref_unique
    ON write_canvas_nodes(user_id, project_id, content_type, business_ref)
    WHERE content_type = 'agent_group' AND business_ref IS NOT NULL
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_document_section_business_ref_unique
    ON write_canvas_nodes(user_id, project_id, content_type, business_ref)
    WHERE content_type = 'document_section' AND business_ref IS NOT NULL
  `);
  await client.query(`
    INSERT INTO write_canvas_nodes
      (user_id, project_id, kind, node_role, content_type, origin, status, business_ref, title, summary, meta, x, y, width, height)
    SELECT g.user_id, g.project_id, 'result', 'task', 'agent_group', 'manual', 'ready', g.id::text,
           g.name, LEFT(g.shared_prompt, 500), jsonb_build_object('groupId', g.id), 360, 180, 340, 220
    FROM write_canvas_agent_groups g
    WHERE g.node_id IS NULL
    ON CONFLICT (user_id, project_id, content_type, business_ref)
      WHERE content_type = 'agent_group' AND business_ref IS NOT NULL
      DO NOTHING
  `);
  await client.query(`
    UPDATE write_canvas_agent_groups g
    SET node_id = n.id
    FROM write_canvas_nodes n
    WHERE g.node_id IS NULL
      AND n.user_id = g.user_id AND n.project_id = g.project_id
      AND n.content_type = 'agent_group' AND n.business_ref = g.id::text
  `);
  await client.query(`ALTER TABLE write_canvas_agent_groups ALTER COLUMN node_id SET NOT NULL`);
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_groups_node_owner_fkey') THEN
        ALTER TABLE write_canvas_agent_groups ADD CONSTRAINT write_canvas_agent_groups_node_owner_fkey FOREIGN KEY (node_id, user_id, project_id) REFERENCES write_canvas_nodes(id, user_id, project_id) ON DELETE CASCADE;
      END IF;
    END $$
  `);
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_documents (
      id                 BIGSERIAL PRIMARY KEY,
      user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id         BIGINT NOT NULL REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
      node_id            BIGINT UNIQUE,
      title              TEXT NOT NULL DEFAULT '',
      summary            TEXT NOT NULL DEFAULT '',
      scenario           TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL CHECK (status IN ('parsing','ready','running','pending_review','adopted','rejected','editing','completed','failed')),
      current_version_id BIGINT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_documents_project ON write_canvas_documents(user_id, project_id, updated_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_document_versions (
      id              BIGSERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_id     BIGINT NOT NULL REFERENCES write_canvas_documents(id) ON DELETE CASCADE,
      version_number  INTEGER NOT NULL,
      snapshot        JSONB NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (document_id, version_number)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_document_versions_document ON write_canvas_document_versions(document_id, version_number DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_document_sections (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_id BIGINT NOT NULL REFERENCES write_canvas_documents(id) ON DELETE CASCADE,
      stable_key  TEXT NOT NULL,
      sort_order  INTEGER NOT NULL,
      heading     TEXT NOT NULL DEFAULT '',
      body        TEXT NOT NULL DEFAULT '',
      level       INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 6),
      meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE (document_id, stable_key),
      UNIQUE (document_id, sort_order)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_document_sections_document ON write_canvas_document_sections(document_id, sort_order)`);
  await runSchemaTransaction(async client => {
    await client.query(`
      UPDATE write_canvas_assets asset
      SET project_id = node.project_id
      FROM write_canvas_nodes node
      WHERE node.asset_id = asset.id AND node.user_id = asset.user_id AND asset.project_id IS NULL
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_assets_tenant_project_key ON write_canvas_assets(id, user_id, project_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_agent_templates_tenant_key ON write_agent_templates(id, user_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_agent_instances_tenant_project_key ON write_agent_instances(id, user_id, project_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_agent_instances_tenant_key ON write_agent_instances(id, user_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_documents_tenant_project_key ON write_canvas_documents(id, user_id, project_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_documents_tenant_key ON write_canvas_documents(id, user_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_document_versions_tenant_document_key ON write_canvas_document_versions(id, user_id, document_id)`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_assets_project_owner_fkey') THEN
          ALTER TABLE write_canvas_assets ADD CONSTRAINT write_canvas_assets_project_owner_fkey
            FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_agent_instances_project_owner_fkey') THEN
          ALTER TABLE write_agent_instances ADD CONSTRAINT write_agent_instances_project_owner_fkey
            FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_agent_instances_template_owner_fkey') THEN
          ALTER TABLE write_agent_instances ADD CONSTRAINT write_agent_instances_template_owner_fkey
            FOREIGN KEY (template_id, user_id) REFERENCES write_agent_templates(id, user_id) ON DELETE SET NULL (template_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_nodes_project_owner_fkey') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_project_owner_fkey
            FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_nodes_asset_owner_fkey') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_asset_owner_fkey
            FOREIGN KEY (asset_id, user_id, project_id) REFERENCES write_canvas_assets(id, user_id, project_id) ON DELETE SET NULL (asset_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_nodes_agent_owner_fkey') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_agent_owner_fkey
            FOREIGN KEY (agent_id, user_id, project_id) REFERENCES write_agent_instances(id, user_id, project_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_edges_project_owner_fkey') THEN
          ALTER TABLE write_canvas_edges ADD CONSTRAINT write_canvas_edges_project_owner_fkey
            FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_edges_source_owner_fkey') THEN
          ALTER TABLE write_canvas_edges ADD CONSTRAINT write_canvas_edges_source_owner_fkey
            FOREIGN KEY (source_node_id, user_id, project_id) REFERENCES write_canvas_nodes(id, user_id, project_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_edges_target_owner_fkey') THEN
          ALTER TABLE write_canvas_edges ADD CONSTRAINT write_canvas_edges_target_owner_fkey
            FOREIGN KEY (target_node_id, user_id, project_id) REFERENCES write_canvas_nodes(id, user_id, project_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_agent_messages_agent_owner_fkey') THEN
          ALTER TABLE write_canvas_agent_messages ADD CONSTRAINT write_canvas_agent_messages_agent_owner_fkey
            FOREIGN KEY (agent_id, user_id) REFERENCES write_agent_instances(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_documents_project_owner_fkey') THEN
          ALTER TABLE write_canvas_documents ADD CONSTRAINT write_canvas_documents_project_owner_fkey
            FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_documents_node_owner_fkey') THEN
          ALTER TABLE write_canvas_documents ADD CONSTRAINT write_canvas_documents_node_owner_fkey
            FOREIGN KEY (node_id, user_id, project_id) REFERENCES write_canvas_nodes(id, user_id, project_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_nodes_document_owner_fkey') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_document_owner_fkey
            FOREIGN KEY (document_id, user_id, project_id) REFERENCES write_canvas_documents(id, user_id, project_id) ON DELETE SET NULL (document_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_document_versions_document_owner_fkey') THEN
          ALTER TABLE write_canvas_document_versions ADD CONSTRAINT write_canvas_document_versions_document_owner_fkey
            FOREIGN KEY (document_id, user_id) REFERENCES write_canvas_documents(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_document_sections_document_owner_fkey') THEN
          ALTER TABLE write_canvas_document_sections ADD CONSTRAINT write_canvas_document_sections_document_owner_fkey
            FOREIGN KEY (document_id, user_id) REFERENCES write_canvas_documents(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_documents_current_version_owner_fkey') THEN
          ALTER TABLE write_canvas_documents ADD CONSTRAINT write_canvas_documents_current_version_owner_fkey
            FOREIGN KEY (current_version_id, user_id, id) REFERENCES write_canvas_document_versions(id, user_id, document_id) ON DELETE SET NULL (current_version_id);
        END IF;
      END $$
    `);
  });
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_nodes_role_check') THEN
        ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_role_check CHECK (node_role IN ('material','insight','task','document','group'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_nodes_origin_check') THEN
        ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_origin_check CHECK (origin IN ('existing','extracted','manual','generated'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_nodes_status_check') THEN
        ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_status_check CHECK (status IN ('parsing','ready','running','pending_review','adopted','rejected','editing','completed','failed'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_nodes_document_id_fkey') THEN
        ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_document_id_fkey FOREIGN KEY (document_id) REFERENCES write_canvas_documents(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_documents_node_id_fkey') THEN
        ALTER TABLE write_canvas_documents ADD CONSTRAINT write_canvas_documents_node_id_fkey FOREIGN KEY (node_id) REFERENCES write_canvas_nodes(id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_canvas_documents_current_version_id_fkey') THEN
        ALTER TABLE write_canvas_documents ADD CONSTRAINT write_canvas_documents_current_version_id_fkey FOREIGN KEY (current_version_id) REFERENCES write_canvas_document_versions(id) ON DELETE SET NULL;
      END IF;
    END $$
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_nodes_document ON write_canvas_nodes(document_id) WHERE document_id IS NOT NULL`);
  await pool.query(`
    DO $$ DECLARE constraint_definition TEXT; BEGIN
      SELECT pg_get_constraintdef(oid) INTO constraint_definition
      FROM pg_constraint WHERE conname = 'write_canvas_edges_relation_check';
      IF constraint_definition IS NULL THEN
        ALTER TABLE write_canvas_edges ADD CONSTRAINT write_canvas_edges_relation_check
          CHECK (relation IN ('context', 'derived_from', 'generated', 'structure'));
      ELSIF POSITION('derived_from' IN constraint_definition) = 0
         OR POSITION('generated' IN constraint_definition) = 0
         OR POSITION('structure' IN constraint_definition) = 0 THEN
        ALTER TABLE write_canvas_edges DROP CONSTRAINT write_canvas_edges_relation_check;
        ALTER TABLE write_canvas_edges ADD CONSTRAINT write_canvas_edges_relation_check
          CHECK (relation IN ('context', 'derived_from', 'generated', 'structure'));
      END IF;
    END $$
  `);
  await pool.query(`
    DELETE FROM write_canvas_edges edge
    USING write_canvas_nodes target_node
    WHERE edge.relation = 'derived_from'
      AND target_node.id = edge.target_node_id
      AND target_node.node_role = 'task'
      AND target_node.content_type = 'agent_group'
      AND EXISTS (
        SELECT 1 FROM write_canvas_edges duplicate
        WHERE duplicate.project_id = edge.project_id
          AND duplicate.source_node_id = edge.source_node_id
          AND duplicate.target_node_id = edge.target_node_id
          AND duplicate.relation = 'context'
      )
  `);
  await pool.query(`
    UPDATE write_canvas_edges edge
    SET relation = 'context'
    FROM write_canvas_nodes source_node, write_canvas_nodes target_node
    WHERE edge.relation = 'derived_from'
      AND source_node.id = edge.source_node_id
      AND target_node.id = edge.target_node_id
      AND target_node.node_role = 'task'
      AND target_node.content_type = 'agent_group'
      AND source_node.kind <> 'agent'
      AND NOT (source_node.node_role = 'task' AND source_node.content_type = 'agent_group')
      AND NOT EXISTS (
        SELECT 1 FROM write_canvas_edges duplicate
        WHERE duplicate.project_id = edge.project_id
          AND duplicate.source_node_id = edge.source_node_id
          AND duplicate.target_node_id = edge.target_node_id
          AND duplicate.relation = 'context'
      )
  `);
  await pool.query(`
    DELETE FROM write_canvas_edges edge
    USING write_canvas_nodes source_node, write_canvas_nodes target_node
    WHERE edge.relation = 'context'
      AND source_node.id = edge.source_node_id
      AND target_node.id = edge.target_node_id
      AND (
        source_node.kind = 'agent'
        OR (source_node.node_role = 'task' AND source_node.content_type = 'agent_group')
        OR (target_node.kind <> 'agent' AND NOT (target_node.node_role = 'task' AND target_node.content_type = 'agent_group'))
      )
      AND EXISTS (
        SELECT 1 FROM write_canvas_edges duplicate
        WHERE duplicate.project_id = edge.project_id
          AND duplicate.source_node_id = edge.source_node_id
          AND duplicate.target_node_id = edge.target_node_id
          AND duplicate.relation = 'derived_from'
      )
  `);
  await pool.query(`
    UPDATE write_canvas_edges edge
    SET relation = 'derived_from'
    FROM write_canvas_nodes source_node, write_canvas_nodes target_node
    WHERE edge.relation = 'context'
      AND source_node.id = edge.source_node_id
      AND target_node.id = edge.target_node_id
      AND (
        source_node.kind = 'agent'
        OR (source_node.node_role = 'task' AND source_node.content_type = 'agent_group')
        OR (target_node.kind <> 'agent' AND NOT (target_node.node_role = 'task' AND target_node.content_type = 'agent_group'))
      )
  `);
  // --- saved_cards: add origin and saved_article_id columns ---
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT 'manual'`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS saved_article_id BIGINT REFERENCES saved_articles(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS summary TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS original_quote TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS context TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS citation_note TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS evidence_role TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS raw_card_meta JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_cards_saved_article ON saved_cards(saved_article_id)`);
  const normalizedUrlIndexIsUnique = Boolean((await pool.query(
    `SELECT i.indisunique AS "isUnique"
     FROM pg_class c
     JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'idx_saved_articles_normalized_url_unique' AND pg_table_is_visible(c.oid)`,
  )).rows[0]?.isUnique);
  const savedArticleUrlsNeedBackfill = Boolean((await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM saved_articles
       WHERE url IS NOT NULL AND normalized_url IS NULL
     ) AS needed`,
  )).rows[0]?.needed);
  const normalizedUrlConstraintExists = Boolean((await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'saved_articles_normalized_url_required'
         AND conrelid = 'saved_articles'::regclass
     ) AS present`,
  )).rows[0]?.present);
  if (!normalizedUrlIndexIsUnique || savedArticleUrlsNeedBackfill || !normalizedUrlConstraintExists) {
    await runSchemaTransaction(async client => {
      await client.query(`LOCK TABLE saved_articles IN SHARE ROW EXCLUSIVE MODE`);
      await client.query(`DROP INDEX IF EXISTS idx_saved_articles_normalized_url_unique`);
      const savedArticleUrlRows = (await client.query(
        `SELECT id, url FROM saved_articles WHERE url IS NOT NULL`,
      )).rows as Array<{ id: number; url: string }>;
      const normalizedRows = savedArticleUrlRows
        .map(row => ({ id: row.id, normalizedUrl: normalizeArticleUrl(row.url) }))
        .filter((row): row is { id: number; normalizedUrl: string } => Boolean(row.normalizedUrl));
      for (let offset = 0; offset < normalizedRows.length; offset += 500) {
        const batch = normalizedRows.slice(offset, offset + 500);
        await client.query(
        `UPDATE saved_articles article
         SET normalized_url = normalized.normalized_url
         FROM UNNEST($1::bigint[], $2::text[]) AS normalized(id, normalized_url)
         WHERE article.id = normalized.id`,
        [batch.map(row => row.id), batch.map(row => row.normalizedUrl)],
        );
      }
      await client.query(`
      WITH ranked AS (
        SELECT *, FIRST_VALUE(id) OVER (
          PARTITION BY user_id, normalized_url ORDER BY saved_at DESC, id DESC
        ) AS keep_id
        FROM saved_articles
        WHERE normalized_url IS NOT NULL
      ), merged AS (
        SELECT keep_id,
               (array_agg(NULLIF(content, '') ORDER BY length(content) DESC, saved_at DESC)
                 FILTER (WHERE content <> ''))[1] AS content,
               (array_agg(NULLIF(excerpt, '') ORDER BY length(excerpt) DESC, saved_at DESC)
                 FILTER (WHERE excerpt <> ''))[1] AS excerpt,
               (array_agg(NULLIF(citation_context, '') ORDER BY length(citation_context) DESC, saved_at DESC)
                 FILTER (WHERE citation_context IS NOT NULL AND citation_context <> ''))[1] AS citation_context,
               (array_agg(image_urls ORDER BY jsonb_array_length(image_urls) DESC, saved_at DESC)
                 FILTER (WHERE jsonb_typeof(image_urls) = 'array' AND jsonb_array_length(image_urls) > 0))[1] AS image_urls,
               (array_agg(source_icon ORDER BY saved_at DESC)
                 FILTER (WHERE source_icon IS NOT NULL))[1] AS source_icon,
               MAX(published_at) AS published_at
        FROM ranked
        GROUP BY keep_id
        HAVING COUNT(*) > 1
      )
      UPDATE saved_articles keep
      SET content = COALESCE(merged.content, keep.content),
          excerpt = COALESCE(merged.excerpt, keep.excerpt),
          citation_context = COALESCE(merged.citation_context, keep.citation_context),
          image_urls = COALESCE(merged.image_urls, keep.image_urls),
          source_icon = COALESCE(keep.source_icon, merged.source_icon),
          published_at = COALESCE(keep.published_at, merged.published_at)
      FROM merged
      WHERE keep.id = merged.keep_id
    `);
      await client.query(`
      WITH duplicates AS (
        SELECT id, FIRST_VALUE(id) OVER (
          PARTITION BY user_id, normalized_url ORDER BY saved_at DESC, id DESC
        ) AS keep_id
        FROM saved_articles
        WHERE normalized_url IS NOT NULL
      )
      UPDATE saved_cards card
      SET saved_article_id = duplicates.keep_id
      FROM duplicates
      WHERE card.saved_article_id = duplicates.id AND duplicates.id <> duplicates.keep_id
    `);
      await client.query(`
      WITH duplicates AS (
        SELECT id, user_id, FIRST_VALUE(id) OVER (
          PARTITION BY user_id, normalized_url ORDER BY saved_at DESC, id DESC
        ) AS keep_id
        FROM saved_articles
        WHERE normalized_url IS NOT NULL
      )
      UPDATE write_canvas_nodes node
      SET ref_id = duplicates.keep_id::text, updated_at = NOW()
      FROM duplicates
      WHERE node.kind = 'saved_article'
        AND node.user_id = duplicates.user_id
        AND node.ref_id = duplicates.id::text
        AND duplicates.id <> duplicates.keep_id
    `);
      await client.query(`
      WITH duplicates AS (
        SELECT id, FIRST_VALUE(id) OVER (
          PARTITION BY user_id, normalized_url ORDER BY saved_at DESC, id DESC
        ) AS keep_id
        FROM saved_articles
        WHERE normalized_url IS NOT NULL
      )
      DELETE FROM saved_articles article
      USING duplicates
      WHERE article.id = duplicates.id AND duplicates.id <> duplicates.keep_id
    `);
      await client.query(`CREATE UNIQUE INDEX idx_saved_articles_normalized_url_unique ON saved_articles(user_id, normalized_url) WHERE normalized_url IS NOT NULL`);
      await client.query(`ALTER TABLE saved_articles DROP CONSTRAINT IF EXISTS saved_articles_normalized_url_required`);
      await client.query(`ALTER TABLE saved_articles ADD CONSTRAINT saved_articles_normalized_url_required CHECK (url IS NULL OR normalized_url IS NOT NULL)`);
    });
  }
  const contentHashIndexIsUnique = Boolean((await pool.query(
    `SELECT i.indisunique AS "isUnique"
     FROM pg_class c
     JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'idx_saved_articles_content_hash_unique_v2' AND pg_table_is_visible(c.oid)`,
  )).rows[0]?.isUnique);
  if (!contentHashIndexIsUnique) {
    await pool.query(`
      WITH ranked AS (
        SELECT *, FIRST_VALUE(id) OVER (
          PARTITION BY user_id, content_hash ORDER BY saved_at DESC, id DESC
        ) AS keep_id
        FROM saved_articles
        WHERE content_hash IS NOT NULL
      ), merged AS (
        SELECT keep_id,
               (array_agg(NULLIF(content, '') ORDER BY length(content) DESC, saved_at DESC)
                 FILTER (WHERE content <> ''))[1] AS content,
               (array_agg(NULLIF(excerpt, '') ORDER BY length(excerpt) DESC, saved_at DESC)
                 FILTER (WHERE excerpt <> ''))[1] AS excerpt,
               (array_agg(NULLIF(citation_context, '') ORDER BY length(citation_context) DESC, saved_at DESC)
                 FILTER (WHERE citation_context IS NOT NULL AND citation_context <> ''))[1] AS citation_context,
               (array_agg(image_urls ORDER BY jsonb_array_length(image_urls) DESC, saved_at DESC)
                 FILTER (WHERE jsonb_typeof(image_urls) = 'array' AND jsonb_array_length(image_urls) > 0))[1] AS image_urls,
               (array_agg(source_icon ORDER BY saved_at DESC)
                 FILTER (WHERE source_icon IS NOT NULL))[1] AS source_icon,
               MAX(published_at) AS published_at
        FROM ranked
        GROUP BY keep_id
        HAVING COUNT(*) > 1
      )
      UPDATE saved_articles keep
      SET content = COALESCE(merged.content, keep.content),
          excerpt = COALESCE(merged.excerpt, keep.excerpt),
          citation_context = COALESCE(merged.citation_context, keep.citation_context),
          image_urls = COALESCE(merged.image_urls, keep.image_urls),
          source_icon = COALESCE(keep.source_icon, merged.source_icon),
          published_at = COALESCE(keep.published_at, merged.published_at)
      FROM merged
      WHERE keep.id = merged.keep_id
    `);
    await pool.query(`
      WITH duplicates AS (
        SELECT id, user_id, FIRST_VALUE(id) OVER (
          PARTITION BY user_id, content_hash ORDER BY saved_at DESC, id DESC
        ) AS keep_id
        FROM saved_articles
        WHERE content_hash IS NOT NULL
      )
      UPDATE saved_cards sc
      SET saved_article_id = duplicates.keep_id
      FROM duplicates
      WHERE sc.saved_article_id = duplicates.id AND duplicates.id <> duplicates.keep_id
    `);
    await pool.query(`
      WITH duplicates AS (
        SELECT id, user_id, FIRST_VALUE(id) OVER (
          PARTITION BY user_id, content_hash ORDER BY saved_at DESC, id DESC
        ) AS keep_id
        FROM saved_articles
        WHERE content_hash IS NOT NULL
      )
      UPDATE write_canvas_nodes n
      SET ref_id = duplicates.keep_id::text, updated_at = NOW()
      FROM duplicates
      WHERE n.kind = 'saved_article'
        AND n.user_id = duplicates.user_id
        AND n.ref_id = duplicates.id::text
        AND duplicates.id <> duplicates.keep_id
    `);
    await pool.query(`
      WITH duplicates AS (
        SELECT id, FIRST_VALUE(id) OVER (
          PARTITION BY user_id, content_hash ORDER BY saved_at DESC, id DESC
        ) AS keep_id
        FROM saved_articles
        WHERE content_hash IS NOT NULL
      )
      DELETE FROM saved_articles sa
      USING duplicates
      WHERE sa.id = duplicates.id AND duplicates.id <> duplicates.keep_id
    `);
    await pool.query(`DROP INDEX IF EXISTS idx_saved_articles_content_hash`);
    await pool.query(`CREATE UNIQUE INDEX idx_saved_articles_content_hash_unique_v2 ON saved_articles(user_id, content_hash) WHERE content_hash IS NOT NULL`);
  }

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
  schemaReady = true;
  } finally {
    try {
      const unlocked = (await schemaLockClient.query(
        `SELECT pg_advisory_unlock(hashtext('atomflow-schema-migration')) AS unlocked`,
      )).rows[0]?.unlocked === true;
      schemaLockReleased = unlocked;
    } catch (error) {
      logger.error({ err: error, module: "db" }, "Failed to release schema migration lock");
    }
  }
  } catch (err) {
    if (isProduction) throw err;
    logger.error({ err, module: "db" }, "Database schema migration failed; some features may be unavailable");
  } finally {
    schemaLockClient.release(schemaLockReleased ? undefined : true);
  }
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
  const avatarUploadMaxBytes = readBoundedEnvNumber(process.env.AVATAR_UPLOAD_MAX_MB, 5, 1, 10) * 1024 * 1024;
  const canvasUploadMaxBytes = readBoundedEnvNumber(process.env.CANVAS_UPLOAD_MAX_MB, 10, 1, 20) * 1024 * 1024;
  const canvasUserStorageMaxBytes = readBoundedEnvNumber(process.env.CANVAS_USER_STORAGE_MAX_MB, 100, 20, 2048) * 1024 * 1024;
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: avatarUploadMaxBytes, files: 1, fields: 5, parts: 6, fieldNameSize: 100, fieldSize: 16 * 1024 },
    fileFilter: (_req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      cb(null, allowed.includes(file.mimetype));
    }
  });
  const canvasAssetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: canvasUploadMaxBytes, files: 1, fields: 10, parts: 11, fieldNameSize: 100, fieldSize: 64 * 1024 },
    fileFilter: (_req, file, cb) => {
      const allowed = [
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp"
      ];
      cb(null, allowed.includes(file.mimetype));
    }
  });

  const apiLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: readBoundedEnvNumber(process.env.API_RATE_LIMIT, 300, 30, 3000),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "api",
    skip: req => req.path === "/health",
    message: { error: "请求过于频繁，请稍后再试" },
  });
  const requestIpKey = (req: express.Request) => ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown");
  const normalizedEmailKey = (req: express.Request) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 320) : "";
    return email ? `email:${email}` : `ip:${requestIpKey(req)}`;
  };
  const authenticatedUserKey = (req: express.Request) => req.session?.userId
    ? `user:${req.session.userId}`
    : `ip:${requestIpKey(req)}`;
  const passwordLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: readBoundedEnvNumber(process.env.AUTH_LOGIN_RATE_LIMIT, 10, 3, 100),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "password-login-ip",
    keyGenerator: requestIpKey,
    skipSuccessfulRequests: true,
    message: { error: "登录尝试过多，请稍后再试" },
  });
  const passwordEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: readBoundedEnvNumber(process.env.AUTH_LOGIN_RATE_LIMIT, 10, 3, 100),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "password-login-email",
    keyGenerator: normalizedEmailKey,
    skipSuccessfulRequests: true,
    message: { error: "该账号登录尝试过多，请稍后再试" },
  });
  const accountActionLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "account-action",
    keyGenerator: authenticatedUserKey,
    message: { error: "账户操作过于频繁，请稍后再试" },
  });
  const verificationSendLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: readBoundedEnvNumber(process.env.AUTH_CODE_IP_RATE_LIMIT, 5, 2, 100),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "verification-send-ip",
    keyGenerator: requestIpKey,
    message: { error: "验证码发送请求过多，请稍后再试" },
  });
  const verificationEmailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: readBoundedEnvNumber(process.env.AUTH_CODE_EMAIL_RATE_LIMIT, 3, 1, 20),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "verification-send-email",
    keyGenerator: normalizedEmailKey,
    message: { error: "该邮箱验证码发送过多，请稍后再试" },
  });
  const verificationCheckLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: readBoundedEnvNumber(process.env.AUTH_VERIFY_RATE_LIMIT, 10, 3, 100),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "verification-check",
    keyGenerator: normalizedEmailKey,
    skipSuccessfulRequests: true,
    message: { error: "验证码尝试过多，请稍后再试" },
  });
  const verificationCheckIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: readBoundedEnvNumber(process.env.AUTH_VERIFY_IP_RATE_LIMIT, 30, 5, 300),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "verification-check-ip",
    keyGenerator: requestIpKey,
    skipSuccessfulRequests: true,
    message: { error: "验证码尝试过多，请稍后再试" },
  });
  const paidOperationLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: readBoundedEnvNumber(process.env.PAID_OPERATION_RATE_LIMIT, 20, 2, 500),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "paid-operation",
    keyGenerator: authenticatedUserKey,
    message: { error: "AI 或翻译请求过于频繁，请稍后再试" },
  });
  const remoteFetchLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: readBoundedEnvNumber(process.env.REMOTE_FETCH_RATE_LIMIT, 30, 3, 300),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "remote-fetch",
    keyGenerator: authenticatedUserKey,
    message: { error: "远程抓取请求过于频繁，请稍后再试" },
  });
  const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: readBoundedEnvNumber(process.env.UPLOAD_RATE_LIMIT, 20, 2, 200),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "upload",
    keyGenerator: authenticatedUserKey,
    message: { error: "上传过于频繁，请稍后再试" },
  });
  const clientLogLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "client-log",
    keyGenerator: requestIpKey,
    message: { error: "日志请求过于频繁" },
  });
  const remoteRssMaxBytes = readBoundedEnvNumber(process.env.REMOTE_RSS_MAX_MB, 5, 1, 10) * 1024 * 1024;
  const remoteRssMaxItems = readBoundedEnvNumber(process.env.REMOTE_RSS_MAX_ITEMS, 500, 20, 1000);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: buildContentSecurityDirectives(isProduction),
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: isProduction ? undefined : false,
  }));
  app.use(compression({
    threshold: 1024,
    filter: (req, res) => {
      if (req.path.endsWith("/stream") || req.get("accept")?.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  }));
  const jsonBodyLimitKb = readBoundedEnvNumber(process.env.JSON_BODY_LIMIT_KB, 256, 64, 1024);
  app.use(express.json({ limit: `${jsonBodyLimitKb}kb`, strict: true }));
  app.use(express.urlencoded({ extended: false, limit: "64kb", parameterLimit: 50 }));
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
    customSuccessMessage: (req, res, responseTime) => `${req.method} ${safeRequestPath(req)} ${res.statusCode} ${Math.round(responseTime)}ms`,
    customErrorMessage: (req, res, err) => `${req.method} ${safeRequestPath(req)} ${res.statusCode} ${sanitizeLogString(err.message)}`,
  }));

  app.post("/api/log", clientLogLimiter, (req, res) => {
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
  const configuredSessionSecret = process.env.SESSION_SECRET?.trim();
  if (isProduction && (!process.env.SESSION_SECRET || !configuredSessionSecret || configuredSessionSecret === DEV_SESSION_SECRET || configuredSessionSecret.startsWith("replace-") || configuredSessionSecret.length < 32)) {
    throw new Error("SESSION_SECRET must be explicitly configured with at least 32 non-placeholder characters in production");
  }
  const sessionSecret = configuredSessionSecret || DEV_SESSION_SECRET;
  const PgSession = connectPgSimple(session);
  // Exact Origin/Referer validation below is the CSRF control for every mutating API request.
  // codeql[js/missing-token-validation]
  const sessionMiddleware = session({
    name: "atomflow.sid",
    store: pool ? new PgSession({ pool, createTableIfMissing: true }) : undefined,
    secret: sessionSecret,
    proxy: isProduction,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
  app.use(sessionMiddleware);
  app.use("/api", apiLimiter);

  const allowedOrigins = buildAllowedOrigins(appUrl, process.env.ALLOWED_ORIGINS);
  if (isProduction && allowedOrigins.size === 0) {
    throw new Error("APP_URL or RAILWAY_PUBLIC_DOMAIN must be configured in production");
  }
  const mutationOriginGuard: express.RequestHandler = (req, res, next) => {
    if (!isProduction || isAllowedMutationOrigin({
      method: req.method,
      path: req.path,
      origin: req.get("origin") || undefined,
      referer: req.get("referer") || undefined,
      isAuthenticated: Boolean(req.session.userId),
    }, allowedOrigins)) {
      next();
      return;
    }
    res.status(403).json({ error: "请求来源不受信任" });
  };
  app.use("/api", mutationOriginGuard);

  app.get("/legal/:document", asyncHandler(async (req, res) => {
    const document = req.params.document as keyof typeof LEGAL_DOCUMENTS;
    if (!(document in LEGAL_DOCUMENTS)) return res.status(404).type("text/plain").send("Legal document not found");
    const rendered = await renderLegalDocument(document, appUrl);
    res.setHeader("Cache-Control", isProduction ? "public, max-age=300" : "no-store");
    return res.type("text/markdown; charset=utf-8").send(rendered);
  }));

  const paidConcurrencyGuard = createUserConcurrencyGuard(
    readBoundedEnvNumber(process.env.PAID_OPERATION_CONCURRENCY, 2, 1, 10),
  );
  const paidGlobalConcurrencyGuard = createUserConcurrencyGuard(
    readBoundedEnvNumber(process.env.PAID_OPERATION_GLOBAL_CONCURRENCY, 8, 2, 100),
  );
  const paidOperationLeaseMs = readBoundedEnvNumber(process.env.PAID_OPERATION_LEASE_MS, 180000, 30000, 600000);
  const uploadConcurrencyGuard = createUserConcurrencyGuard(
    readBoundedEnvNumber(process.env.CANVAS_UPLOAD_GLOBAL_CONCURRENCY, 4, 1, 20),
  );
  const remoteFetchGlobalConcurrencyGuard = createUserConcurrencyGuard(
    readBoundedEnvNumber(process.env.REMOTE_FETCH_GLOBAL_CONCURRENCY, 2, 1, 10),
  );
  const remoteFetchUserConcurrencyGuard = createUserConcurrencyGuard(1);
  const articleSaveConcurrencyGuard = createUserConcurrencyGuard(1);
  const canvasAgentConcurrencyGuard = createUserConcurrencyGuard(1);
  const paidConcurrencyMiddleware: express.RequestHandler = (req, res, next) => {
    let releaseGlobal: (() => void) | undefined;
    let releaseUser: (() => void) | undefined;
    try {
      releaseGlobal = paidGlobalConcurrencyGuard.acquire("global");
      releaseUser = paidConcurrencyGuard.acquire(authenticatedUserKey(req));
    } catch (error) {
      releaseGlobal?.();
      if (error instanceof ConcurrencyLimitError) {
        res.setHeader("Retry-After", "5");
        res.status(429).json({ error: "已有任务正在运行，请等待完成后再试" });
        return;
      }
      next(error);
      return;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseUser?.();
      releaseGlobal?.();
    };
    res.locals.releasePaidConcurrency = release;
    res.once("finish", release);
    res.once("close", () => {
      if (res.writableFinished) {
        release();
        return;
      }
      const leaseTimer = setTimeout(release, paidOperationLeaseMs);
      leaseTimer.unref();
    });
    next();
  };
  const remoteFetchConcurrencyMiddleware: express.RequestHandler = (req, res, next) => {
    let releaseGlobal: (() => void) | undefined;
    let releaseUser: (() => void) | undefined;
    try {
      releaseGlobal = remoteFetchGlobalConcurrencyGuard.acquire("global");
      releaseUser = remoteFetchUserConcurrencyGuard.acquire(authenticatedUserKey(req));
    } catch (error) {
      releaseGlobal?.();
      if (error instanceof ConcurrencyLimitError) {
        res.setHeader("Retry-After", "5");
        res.status(429).json({ error: "订阅源正在抓取，请稍后再试" });
        return;
      }
      next(error);
      return;
    }
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      releaseUser?.();
      releaseGlobal?.();
    };
    let processingStarted = false;
    res.locals.beginRemoteFetchProcessing = () => {
      processingStarted = true;
      return releaseOnce;
    };
    res.once("finish", releaseOnce);
    res.once("close", () => {
      if (res.writableFinished || !processingStarted) releaseOnce();
    });
    next();
  };
  const canvasAgentConcurrencyMiddleware: express.RequestHandler = (req, res, next) => {
    const agentId = Number(req.params.id);
    if (!Number.isSafeInteger(agentId) || agentId <= 0) {
      res.status(400).json({ error: "invalid agent id" });
      return;
    }
    let release: () => void;
    try {
      release = canvasAgentConcurrencyGuard.acquire(`${authenticatedUserKey(req)}:${agentId}`);
    } catch (error) {
      if (error instanceof ConcurrencyLimitError) {
        res.setHeader("Retry-After", "5");
        res.status(429).json({ error: "这个 Agent 正在生成，请等待完成后再试" });
        return;
      }
      next(error);
      return;
    }
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    res.locals.releaseCanvasAgentConcurrency = releaseOnce;
    res.once("finish", releaseOnce);
    res.once("close", () => {
      if (res.writableFinished) {
        releaseOnce();
        return;
      }
      const leaseTimer = setTimeout(releaseOnce, paidOperationLeaseMs);
      leaseTimer.unref();
    });
    next();
  };
  const uploadConcurrencyMiddleware: express.RequestHandler = (_req, res, next) => {
    let release: () => void;
    try {
      release = uploadConcurrencyGuard.acquire("global");
    } catch (error) {
      if (error instanceof ConcurrencyLimitError) {
        res.setHeader("Retry-After", "5");
        res.status(429).json({ error: "上传处理繁忙，请稍后再试" });
        return;
      }
      next(error);
      return;
    }
    let released = false;
    let processingStarted = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    res.locals.beginCanvasUploadProcessing = () => {
      processingStarted = true;
      return releaseOnce;
    };
    res.once("finish", releaseOnce);
    res.once("close", () => {
      if (res.writableFinished || !processingStarted) releaseOnce();
    });
    next();
  };
  const articleSaveConcurrencyMiddleware: express.RequestHandler = (req, res, next) => {
    const articleId = Number(req.params.id);
    if (!Number.isSafeInteger(articleId) || articleId <= 0) {
      res.status(400).json({ error: "invalid article id" });
      return;
    }
    let release: () => void;
    try {
      release = articleSaveConcurrencyGuard.acquire(authenticatedUserKey(req));
    } catch (error) {
      if (error instanceof ConcurrencyLimitError) {
        res.setHeader("Retry-After", "5");
        res.status(429).json({ error: "这篇文章正在保存，请等待完成后再试" });
        return;
      }
      next(error);
      return;
    }
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    res.once("finish", releaseOnce);
    res.once("close", () => {
      if (res.writableFinished) {
        releaseOnce();
        return;
      }
      const leaseTimer = setTimeout(releaseOnce, paidOperationLeaseMs);
      leaseTimer.unref();
    });
    next();
  };

  const establishAuthenticatedSession = (req: express.Request, userId: number, email: string) => new Promise<void>((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) {
        reject(error);
        return;
      }
      req.session.userId = userId;
      req.session.email = email;
      req.session.reauthenticatedAt = Date.now();
      resolve();
    });
  });

  const invalidateUserSessions = async (userId: number, client: pg.Pool | pg.PoolClient = pool) => {
    await client.query(
      `DELETE FROM session WHERE sess ->> 'userId' = $1`,
      [String(userId)],
    );
  };

  const updatePasswordAndInvalidateSessions = async (userId: number, passwordHash: string) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const user = (await client.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, email',
        [passwordHash, userId],
      )).rows[0];
      if (!user) {
        await client.query("ROLLBACK");
        return null;
      }
      await invalidateUserSessions(Number(user.id), client);
      await client.query("COMMIT");
      return user;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  app.get("/api/health", asyncHandler(async (_req, res) => {
    if (!pool || !schemaReady) return res.status(503).json({ status: "unhealthy", database: pool ? "schema-unavailable" : "unavailable" });
    await pool.query("SELECT 1 FROM users LIMIT 0");
    res.setHeader("Cache-Control", "no-store");
    return res.json({ status: "ok", database: "connected" });
  }));

  // In-memory article cache, refreshed independently per source.
  const cachedArticles = await loadArticlesCache();
  let fullBuiltInArticles = sanitizeGlobalArticleCache(cachedArticles);
  let articles = buildHomepageTimeline(fullBuiltInArticles);
  let lastSuccessfulFeedRefreshSources = new Set<string>();

  // Load RSS feeds on startup
  logger.info({ module: "rss" }, "Fetching RSS feeds");
  let initialFeedRefreshPending = true;
  const refreshFeeds = async () => {
    try {
      const fresh = await fetchRSSFeeds(remoteRssMaxItems);
      logger.info({
        module: "rss",
        timelineCount: fresh.timelineArticles.length,
        fullCount: fresh.fullArticles.length,
      }, "Fetched fresh articles");
      lastSuccessfulFeedRefreshSources = new Set(fresh.refreshedSources);

      if (fresh.fullArticles.length > 0) {
        const fullWithFallback = mergeWithSourceFallback(fullBuiltInArticles, fresh.fullArticles);
        fullBuiltInArticles = mergeArticles(fullBuiltInArticles, fullWithFallback);
        articles = mergeArticles(articles, buildHomepageTimeline(fullBuiltInArticles));
        await saveArticlesCache(fullBuiltInArticles);
        logger.info({
          module: "rss",
          articleCount: articles.length,
          fullArticleCount: fullBuiltInArticles.length,
        }, "Loaded articles");
      } else {
        logger.info({ module: "rss" }, "No fresh articles fetched, keeping existing data");
      }
    } catch (error) {
      lastSuccessfulFeedRefreshSources = new Set();
      logger.error({ err: error, module: "rss" }, "Failed to refresh feeds, keeping existing data");
    }
  };
  let activeFeedRefresh: Promise<void> | null = null;
  let lastFeedRefreshAt = 0;
  const runFeedRefresh = () => {
    if (activeFeedRefresh) return activeFeedRefresh;
    activeFeedRefresh = refreshFeeds().finally(() => {
      lastFeedRefreshAt = Date.now();
      activeFeedRefresh = null;
    });
    return activeFeedRefresh;
  };
  logger.info({ module: "rss", articleCount: articles.length }, "Using cached or fallback articles, refreshing in background");
  runFeedRefresh()
    .catch(error => logger.error({ err: error, module: "rss" }, "Failed to refresh feeds in background"))
    .finally(() => { initialFeedRefreshPending = false; });
  const feedRefreshTimer = setInterval(() => {
    runFeedRefresh().catch(error => logger.error({ err: error, module: "rss" }, "Failed to refresh feeds"));
  }, 10 * 60 * 1000);
  feedRefreshTimer.unref();

  const cleanupExpiredVerificationCodes = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const elected = (await client.query(
        `SELECT pg_try_advisory_xact_lock(hashtext('atomflow-verification-cleanup')) AS acquired`,
      )).rows[0]?.acquired === true;
      if (!elected) {
        await client.query("ROLLBACK");
        return;
      }
      const result = await client.query(
        `DELETE FROM verification_codes
         WHERE id IN (
           SELECT id FROM verification_codes
           WHERE expires_at < NOW() - INTERVAL '24 hours'
              OR (used = TRUE AND created_at < NOW() - INTERVAL '24 hours')
           ORDER BY id
           LIMIT 5000
         )`,
      );
      await client.query("COMMIT");
      if (result.rowCount) logger.info({ module: "auth", deleted: result.rowCount }, "Expired verification records removed");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  cleanupExpiredVerificationCodes().catch(error => logger.warn({ err: error, module: "auth" }, "Verification record cleanup failed"));
  const verificationCleanupTimer = setInterval(() => {
    cleanupExpiredVerificationCodes().catch(error => logger.warn({ err: error, module: "auth" }, "Verification record cleanup failed"));
  }, 60 * 60 * 1000);
  verificationCleanupTimer.unref();

  // --- Auth Routes ---

  app.post("/api/auth/send-code", verificationSendLimiter, verificationEmailLimiter, asyncHandler(async (req, res) => {
    const email = normalizeEmailAddress(req.body?.email);
    if (!email) {
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

    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await pool.query('INSERT INTO verification_codes (email, code, expires_at) VALUES ($1, $2, $3)', [email, verificationCodeDigest(email, code), expiresAt]);

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
      logger.error({ err: error, module: "auth", emailHash: hashLogIdentifier(email) }, "Failed to send verification code");
      return res.status(500).json({ error: '发送验证码失败，请稍后再试' });
    }
  }));

  app.post("/api/auth/verify", verificationCheckIpLimiter, verificationCheckLimiter, asyncHandler(async (req, res) => {
    const email = normalizeEmailAddress(req.body?.email);
    const code = (req.body?.code || '').trim();
    if (!email || !code) {
      return res.status(400).json({ error: '请输入邮箱和验证码' });
    }

    const record = (await pool.query(
      `UPDATE verification_codes
       SET used = TRUE
       WHERE id = (
         SELECT id FROM verification_codes
         WHERE email = $1 AND code = $2 AND used = FALSE AND expires_at > NOW() AND password_hash IS NULL
         ORDER BY created_at DESC LIMIT 1
       ) AND used = FALSE
       RETURNING id`,
      [email, verificationCodeDigest(email, code)]
    )).rows[0];
    if (!record) {
      return res.status(400).json({ error: '验证码无效或已过期' });
    }

    let user = (await pool.query('SELECT id, email, nickname, avatar_url, password_hash FROM users WHERE email = $1', [email])).rows[0];
    if (!user) {
      const nickname = email.split('@')[0];
      const result = await pool.query('INSERT INTO users (email, nickname) VALUES ($1, $2) RETURNING id', [email, nickname]);
      user = { id: result.rows[0].id, email, nickname, avatar_url: null, password_hash: null };
    }

    await establishAuthenticatedSession(req, Number(user.id), String(user.email));
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
      res.clearCookie("atomflow.sid", { httpOnly: true, secure: isProduction, sameSite: "lax" });
      return res.json({ success: true });
    });
  });

  // --- Password Registration ---
  app.post("/api/auth/register", verificationSendLimiter, verificationEmailLimiter, asyncHandler(async (req, res) => {
    const email = normalizeEmailAddress(req.body?.email);
    const password = req.body?.password || '';
    if (!email) {
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
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await pool.query(
      'INSERT INTO verification_codes (email, code, expires_at, password_hash) VALUES ($1, $2, $3, $4)',
      [email, verificationCodeDigest(email, code), expiresAt, passwordHash]
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
      logger.error({ err: error, module: "auth", emailHash: hashLogIdentifier(email) }, "Failed to send registration code");
      return res.status(500).json({ error: '发送验证码失败，请稍后再试' });
    }
  }));

  app.post("/api/auth/register/verify", verificationCheckIpLimiter, verificationCheckLimiter, asyncHandler(async (req, res) => {
    const email = normalizeEmailAddress(req.body?.email);
    const code = (req.body?.code || '').trim();
    if (!email || !code) {
      return res.status(400).json({ error: '请输入邮箱和验证码' });
    }

    const record = (await pool.query(
      `UPDATE verification_codes
       SET used = TRUE
       WHERE id = (
         SELECT id FROM verification_codes
         WHERE email = $1 AND code = $2 AND used = FALSE AND expires_at > NOW() AND password_hash IS NOT NULL
         ORDER BY created_at DESC LIMIT 1
       ) AND used = FALSE
       RETURNING id, password_hash`,
      [email, verificationCodeDigest(email, code)]
    )).rows[0];
    if (!record) {
      return res.status(400).json({ error: '验证码无效或已过期' });
    }

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

    await establishAuthenticatedSession(req, Number(user.id), String(user.email));
    return res.json({ success: true, user });
  }));

  app.post("/api/auth/login-password", passwordLoginLimiter, passwordEmailLimiter, asyncHandler(async (req, res) => {
    const email = normalizeEmailAddress(req.body?.email);
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

    await establishAuthenticatedSession(req, Number(user.id), String(user.email));
    return res.json({ success: true, user: { id: user.id, email: user.email, nickname: user.nickname, avatar_url: user.avatar_url, has_password: true } });
  }));

  // --- Auth middleware ---
  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: '请先登录' });
    }
    next();
  };

  const hasRecentAuthentication = (req: express.Request) => (
    typeof req.session.reauthenticatedAt === "number" &&
    Date.now() - req.session.reauthenticatedAt <= 15 * 60 * 1000
  );

  const requireRecentAuthentication: express.RequestHandler = (req, res, next) => {
    if (!hasRecentAuthentication(req)) {
      return res.status(403).json({ code: "REAUTH_REQUIRED", error: "请重新登录后再执行此账户操作" });
    }
    next();
  };

  const getDailyAiBudgetReservationTokens = (reservedOutputTokens: number, estimatedInputTokens = 0) => (
    Math.max(0, Math.ceil(reservedOutputTokens)) + Math.max(0, Math.ceil(estimatedInputTokens))
  );

  type AiBudgetQueryable = pg.Pool | pg.PoolClient;
  const normalizeAiBudgetDate = (value: unknown) => {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      const year = value.getFullYear();
      const month = String(value.getMonth() + 1).padStart(2, "0");
      const day = String(value.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    if (typeof value === "string") {
      const match = value.match(/^\d{4}-\d{2}-\d{2}/);
      if (match) return match[0];
    }
    return null;
  };

  const reserveDailyAiBudget = async (
    userId: number,
    reservedOutputTokens: number,
    estimatedInputTokens = 0,
    queryable: AiBudgetQueryable = pool,
  ) => {
    const maxOperations = readBoundedEnvNumber(process.env.PAID_OPERATION_DAILY_LIMIT, 100, 1, 10000);
    const maxOutputTokens = readBoundedEnvNumber(process.env.PAID_OUTPUT_TOKENS_DAILY_LIMIT, 200_000, 1000, 10_000_000);
    const reservedTokens = getDailyAiBudgetReservationTokens(reservedOutputTokens, estimatedInputTokens);
    return (await queryable.query(
      `INSERT INTO user_ai_usage_daily (user_id, usage_date, operation_count, reserved_output_tokens)
       SELECT $1::integer, CURRENT_DATE, 1, $2::bigint
       WHERE $2::bigint <= $4::bigint
       ON CONFLICT (user_id, usage_date) DO UPDATE
       SET operation_count = user_ai_usage_daily.operation_count + 1,
           reserved_output_tokens = user_ai_usage_daily.reserved_output_tokens + EXCLUDED.reserved_output_tokens,
           updated_at = NOW()
       WHERE user_ai_usage_daily.operation_count < $3::integer
         AND user_ai_usage_daily.reserved_output_tokens + EXCLUDED.reserved_output_tokens <= $4::bigint
       RETURNING usage_date::text AS usage_date, operation_count, reserved_output_tokens`,
      [userId, reservedTokens, maxOperations, maxOutputTokens],
    )).rows[0] || null;
  };

  const releaseDailyAiBudget = async (
    userId: number,
    reservedTokens: number,
    usageDate: string | null = null,
    queryable: AiBudgetQueryable = pool,
    operationCount = 1,
  ) => {
    if (reservedTokens <= 0) return;
    await queryable.query(
      `UPDATE user_ai_usage_daily
       SET operation_count = GREATEST(0, operation_count - $4::integer),
           reserved_output_tokens = GREATEST(0, reserved_output_tokens - $2::bigint),
           updated_at = NOW()
       WHERE user_id = $1 AND usage_date = COALESCE($3::date, CURRENT_DATE)`,
      [userId, reservedTokens, usageDate, operationCount],
    );
  };

  const reserveDurableDailyAiBudget = async (userId: number, reservedTokens: number, route: string) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, userId);
      const reservation = await reserveDailyAiBudget(userId, reservedTokens, 0, client);
      if (!reservation) {
        await client.query("ROLLBACK");
        return null;
      }
      const row = (await client.query(
        `INSERT INTO ai_budget_reservations (user_id, usage_date, reserved_tokens, route)
         VALUES ($1, $2::date, $3, $4)
         RETURNING id, usage_date::text AS usage_date, reserved_tokens`,
        [userId, reservation.usage_date, reservedTokens, route.slice(0, 240)],
      )).rows[0];
      await client.query("COMMIT");
      return row;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  const refundDailyAiBudgetReservation = async (userId: number, res: express.Response) => {
    const reservationId = Number(res.locals.dailyAiBudgetReservationId || 0);
    if (!Number.isSafeInteger(reservationId) || reservationId <= 0) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, userId);
      const reservation = (await client.query(
        `SELECT id, reserved_tokens, operation_count, usage_date::text AS usage_date, state
         FROM ai_budget_reservations
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [reservationId, userId],
      )).rows[0];
      if (!reservation || reservation.state !== "pending") {
        await client.query("COMMIT");
        return;
      }
      await releaseDailyAiBudget(
        userId,
        Number(reservation.reserved_tokens),
        normalizeAiBudgetDate(reservation.usage_date),
        client,
        Number(reservation.operation_count),
      );
      await client.query(
        `UPDATE ai_budget_reservations SET state = 'refunded', updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND state = 'pending'`,
        [reservationId, userId],
      );
      await client.query("COMMIT");
      res.locals.dailyAiBudgetReservationTokens = 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  const markDailyAiBudgetProviderStarted = async (res: express.Response) => {
    if (res.locals.dailyAiBudgetProviderStarted === true) return;
    const currentPromise = res.locals.dailyAiBudgetProviderStartPromise as Promise<void> | undefined;
    if (currentPromise) return currentPromise;
    const reservationId = Number(res.locals.dailyAiBudgetReservationId || 0);
    const userId = Number(res.locals.dailyAiBudgetUserId || 0);
    if (!Number.isSafeInteger(reservationId) || reservationId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
      throw new Error("AI budget reservation is unavailable");
    }
    const startPromise = (async () => {
      const updated = await pool.query(
        `UPDATE ai_budget_reservations
         SET state = 'provider_started', updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND state = 'pending'
         RETURNING id`,
        [reservationId, userId],
      );
      if (updated.rowCount !== 1) {
        const state = (await pool.query(
          `SELECT state FROM ai_budget_reservations WHERE id = $1 AND user_id = $2`,
          [reservationId, userId],
        )).rows[0]?.state;
        if (state !== "provider_started") throw new Error("AI budget reservation is no longer active");
      }
      res.locals.dailyAiBudgetProviderStarted = true;
    })();
    res.locals.dailyAiBudgetProviderStartPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (res.locals.dailyAiBudgetProviderStartPromise === startPromise) {
        res.locals.dailyAiBudgetProviderStartPromise = null;
      }
    }
  };

  const reserveCanvasAgentRunBudget = async (
    userId: number,
    runId: number,
    reservedOutputTokens: number,
    estimatedInputTokens: number,
  ) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, userId);
      const reservation = await reserveDailyAiBudget(userId, reservedOutputTokens, estimatedInputTokens, client);
      if (!reservation) {
        await client.query("ROLLBACK");
        return null;
      }
      const reservedTokens = getDailyAiBudgetReservationTokens(reservedOutputTokens, estimatedInputTokens);
      const updated = await client.query(
        `UPDATE write_canvas_agent_runs
         SET reserved_tokens = $1, reservation_date = $2::date, updated_at = NOW()
         WHERE id = $3 AND user_id = $4 AND status IN ('queued','running')`,
        [reservedTokens, reservation.usage_date, runId, userId],
      );
      if (updated.rowCount !== 1) throw new Error("AI run is no longer active");
      await client.query("COMMIT");
      return { reservedTokens, reservationDate: normalizeAiBudgetDate(reservation.usage_date) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  const markCanvasAgentRunProviderStarted = async (userId: number, runId: number) => {
    const result = await pool.query(
      `UPDATE write_canvas_agent_runs
       SET provider_started = TRUE, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'running' AND provider_started = FALSE`,
      [runId, userId],
    );
    if (result.rowCount !== 1) throw new Error("AI run is no longer active");
  };

  const failStandaloneCanvasAgentRun = async (
    userId: number,
    runId: number,
    status: "failed" | "cancelled",
    error: string,
  ) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, userId);
      const run = (await client.query(
        `SELECT reserved_tokens, reservation_date::text AS reservation_date, provider_started
         FROM write_canvas_agent_runs
         WHERE id = $1 AND user_id = $2 AND status IN ('queued','running')
         FOR UPDATE`,
        [runId, userId],
      )).rows[0];
      if (!run) {
        await client.query("ROLLBACK");
        return false;
      }
      if (!run.provider_started && Number(run.reserved_tokens) > 0) {
        await releaseDailyAiBudget(userId, Number(run.reserved_tokens), normalizeAiBudgetDate(run.reservation_date), client);
      }
      await client.query(
        `UPDATE write_canvas_agent_runs
         SET status = $1, error = $2,
             reserved_tokens = CASE WHEN provider_started THEN reserved_tokens ELSE 0 END,
             completed_at = NOW(), updated_at = NOW()
         WHERE id = $3 AND user_id = $4`,
        [status, error, runId, userId],
      );
      await client.query("COMMIT");
      return true;
    } catch (failure) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw failure;
    } finally {
      client.release();
    }
  };

  const cancelPendingCanvasAgentMessage = async (userId: number, agentId: number, messageId: number) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, userId);
      const message = (await client.query(
        `SELECT meta FROM write_canvas_agent_messages
         WHERE id = $1 AND user_id = $2 AND agent_id = $3 AND meta->>'status' = 'pending'
         FOR UPDATE`,
        [messageId, userId, agentId],
      )).rows[0];
      if (!message) {
        await client.query("ROLLBACK");
        return false;
      }
      const meta = isPlainRecord(message.meta) ? message.meta : {};
      if (meta.providerStarted !== true) {
        await releaseDailyAiBudget(
          userId,
          Number(meta.budgetReservedTokens || 0),
          typeof meta.budgetReservationDate === "string" ? meta.budgetReservationDate.slice(0, 10) : null,
          client,
        );
      }
      await client.query(
        `DELETE FROM write_canvas_agent_messages WHERE id = $1 AND user_id = $2 AND agent_id = $3`,
        [messageId, userId, agentId],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  const recoverStaleCanvasAiWork = async () => {
    const client = await pool.connect();
    const staleBefore = new Date(Date.now() - CANVAS_AI_RECOVERY_STALE_MS);
    const interruptedError = "运行超时或服务中断";
    const refundReservations = async (reservations: Array<{ userId: number; reservedTokens: number; reservationDate: string | null }>) => {
      const grouped = new Map<string, { userId: number; reservedTokens: number; reservationDate: string | null; operationCount: number }>();
      for (const reservation of reservations) {
        if (reservation.reservedTokens <= 0) continue;
        const key = `${reservation.userId}:${reservation.reservationDate || "current"}`;
        const current = grouped.get(key);
        if (current) {
          current.reservedTokens += reservation.reservedTokens;
          current.operationCount += 1;
        } else grouped.set(key, { ...reservation, operationCount: 1 });
      }
      for (const reservation of grouped.values()) {
        await releaseDailyAiBudget(
          reservation.userId,
          reservation.reservedTokens,
          reservation.reservationDate,
          client,
          reservation.operationCount,
        );
      }
    };
    try {
      await client.query("BEGIN");
      const elected = (await client.query(
        `SELECT pg_try_advisory_xact_lock(hashtext('atomflow-canvas-ai-recovery')) AS acquired`,
      )).rows[0]?.acquired === true;
      if (!elected) {
        await client.query("ROLLBACK");
        return;
      }

      const candidateUserIds = (await client.query(
        `SELECT DISTINCT user_id FROM (
           SELECT user_id FROM write_canvas_agent_runs
           WHERE status IN ('queued','running') AND updated_at < $1
           UNION
           SELECT user_id FROM write_canvas_agent_messages
           WHERE meta->>'status' = 'pending' AND created_at < $1
           UNION
           SELECT user_id FROM ai_budget_reservations
           WHERE state = 'pending' AND updated_at < $1
         ) candidates
         ORDER BY user_id`,
        [staleBefore],
      )).rows.map(row => Number(row.user_id));
      for (const userId of candidateUserIds) await lockCanvasUser(client, userId);

      const staleRuns = (await client.query(
        `SELECT id, user_id, reserved_tokens, reservation_date::text AS reservation_date, provider_started
         FROM write_canvas_agent_runs
         WHERE status IN ('queued','running') AND updated_at < $1
         FOR UPDATE`,
        [staleBefore],
      )).rows;
      await refundReservations(staleRuns
        .filter(run => !run.provider_started)
        .map(run => ({
          userId: Number(run.user_id),
          reservedTokens: Number(run.reserved_tokens),
          reservationDate: normalizeAiBudgetDate(run.reservation_date),
        })));
      if (staleRuns.length > 0) {
        await client.query(
          `UPDATE write_canvas_agent_runs
           SET status = 'failed', error = $1,
               reserved_tokens = CASE WHEN provider_started THEN reserved_tokens ELSE 0 END,
               completed_at = NOW(), updated_at = NOW()
           WHERE id = ANY($2::bigint[])`,
          [interruptedError, staleRuns.map(run => Number(run.id))],
        );
      }

      const staleMessages = (await client.query(
        `SELECT id, user_id, meta
         FROM write_canvas_agent_messages
         WHERE meta->>'status' = 'pending' AND created_at < $1
         FOR UPDATE`,
        [staleBefore],
      )).rows;
      await refundReservations(staleMessages.flatMap(message => {
        const meta = isPlainRecord(message.meta) ? message.meta : {};
        if (meta.providerStarted === true) return [];
        return [{
          userId: Number(message.user_id),
          reservedTokens: Number(meta.budgetReservedTokens || 0),
          reservationDate: typeof meta.budgetReservationDate === "string" ? meta.budgetReservationDate.slice(0, 10) : null,
        }];
      }));
      if (staleMessages.length > 0) {
        await client.query(`DELETE FROM write_canvas_agent_messages WHERE id = ANY($1::bigint[])`, [staleMessages.map(message => Number(message.id))]);
      }
      const staleGenericReservations = (await client.query(
        `SELECT id, user_id, reserved_tokens, usage_date::text AS usage_date
         FROM ai_budget_reservations
         WHERE state = 'pending' AND updated_at < $1
         FOR UPDATE`,
        [staleBefore],
      )).rows;
      await refundReservations(staleGenericReservations.map(reservation => ({
        userId: Number(reservation.user_id),
        reservedTokens: Number(reservation.reserved_tokens),
        reservationDate: normalizeAiBudgetDate(reservation.usage_date),
      })));
      if (staleGenericReservations.length > 0) {
        await client.query(
          `UPDATE ai_budget_reservations
           SET state = 'refunded', updated_at = NOW()
           WHERE id = ANY($1::bigint[]) AND state = 'pending'`,
          [staleGenericReservations.map(reservation => Number(reservation.id))],
        );
      }
      await client.query(
        `DELETE FROM write_canvas_agent_messages
         WHERE COALESCE(meta->>'status', 'completed') IN ('failed','cancelled')`,
      );

      await client.query(
        `UPDATE write_canvas_agent_batches b
         SET status = CASE
               WHEN EXISTS (SELECT 1 FROM write_canvas_agent_runs r WHERE r.batch_id = b.id AND r.status = 'completed')
                 THEN CASE WHEN EXISTS (SELECT 1 FROM write_canvas_agent_runs r WHERE r.batch_id = b.id AND r.status IN ('failed','cancelled')) THEN 'partial' ELSE 'completed' END
               ELSE 'failed'
             END,
             error = CASE WHEN EXISTS (SELECT 1 FROM write_canvas_agent_runs r WHERE r.batch_id = b.id AND r.status = 'completed') THEN b.error ELSE $1 END,
             completed_at = NOW(), updated_at = NOW()
         WHERE b.status = 'running' AND b.updated_at < $2
           AND NOT EXISTS (SELECT 1 FROM write_canvas_agent_runs r WHERE r.batch_id = b.id AND r.status IN ('queued','running'))`,
        [interruptedError, staleBefore],
      );
      await client.query(
        `UPDATE write_canvas_agent_groups g
         SET status = b.status, current_batch_id = NULL, updated_at = NOW()
         FROM write_canvas_agent_batches b
         WHERE g.current_batch_id = b.id AND b.status IN ('completed','partial','failed','cancelled')`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  let canvasAiRecoveryTimer: NodeJS.Timeout | null = null;
  if (pool) {
    recoverStaleCanvasAiWork().catch(error => logger.warn({ err: error, module: "canvas-ai" }, "Canvas AI recovery failed"));
    canvasAiRecoveryTimer = setInterval(() => {
      recoverStaleCanvasAiWork().catch(error => logger.warn({ err: error, module: "canvas-ai" }, "Canvas AI recovery failed"));
    }, CANVAS_AI_RECOVERY_INTERVAL_MS);
    canvasAiRecoveryTimer.unref();
  }

  const assertCurrentCanvasAgentBatchLease = async (
    client: pg.PoolClient,
    userId: number,
    groupId: number,
    batchId: number,
  ) => {
    const lease = (await client.query(
      `SELECT b.id
       FROM write_canvas_agent_batches b
       JOIN write_canvas_agent_groups g
         ON g.id = b.group_id AND g.user_id = b.user_id AND g.project_id = b.project_id
       WHERE b.id = $1 AND b.group_id = $2 AND b.user_id = $3
         AND b.status = 'running' AND g.current_batch_id = b.id
       FOR UPDATE OF b, g`,
      [batchId, groupId, userId],
    )).rows[0];
    if (!lease) throw new CanvasAgentBatchLeaseLostError("Agent batch was superseded by a newer run");
  };

  const failCanvasAgentRunIfLeaseCurrent = async (input: {
    userId: number;
    groupId: number;
    batchId: number;
    runId: number;
    status: "failed" | "cancelled";
    error: string;
  }) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, input.userId);
      await assertCurrentCanvasAgentBatchLease(client, input.userId, input.groupId, input.batchId);
      const run = (await client.query(
        `SELECT reserved_tokens, reservation_date::text AS reservation_date, provider_started
         FROM write_canvas_agent_runs
         WHERE id = $1 AND batch_id = $2 AND user_id = $3 AND status IN ('queued','running')
         FOR UPDATE`,
        [input.runId, input.batchId, input.userId],
      )).rows[0];
      if (!run) {
        await client.query("ROLLBACK");
        return false;
      }
      if (!run.provider_started && Number(run.reserved_tokens) > 0) {
        await releaseDailyAiBudget(
          input.userId,
          Number(run.reserved_tokens),
          normalizeAiBudgetDate(run.reservation_date),
          client,
        );
      }
      const result = await client.query(
        `UPDATE write_canvas_agent_runs
         SET status = $1, error = $2,
             reserved_tokens = CASE WHEN provider_started THEN reserved_tokens ELSE 0 END,
             completed_at = NOW(), updated_at = NOW()
         WHERE id = $3 AND batch_id = $4 AND user_id = $5 AND status IN ('queued','running')`,
        [input.status, input.error, input.runId, input.batchId, input.userId],
      );
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof CanvasAgentBatchLeaseLostError) return false;
      throw error;
    } finally {
      client.release();
    }
  };

  const finishCanvasAgentBatch = async (input: {
    userId: number;
    batchId: number;
    groupId: number;
    status: "completed" | "partial" | "failed" | "cancelled";
    output: Record<string, unknown>;
    error: string | null;
  }) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, input.userId);
      await assertCurrentCanvasAgentBatchLease(client, input.userId, input.groupId, input.batchId);
      const batchResult = await client.query(
        `UPDATE write_canvas_agent_batches
         SET status = $1, output = $2::jsonb, error = $3, completed_at = NOW(), updated_at = NOW()
         WHERE id = $4 AND group_id = $5 AND user_id = $6 AND status = 'running'`,
        [input.status, JSON.stringify(input.output), input.error, input.batchId, input.groupId, input.userId],
      );
      const groupResult = await client.query(
        `UPDATE write_canvas_agent_groups
         SET status = $1, current_batch_id = NULL, updated_at = NOW()
         WHERE id = $2 AND user_id = $3 AND current_batch_id = $4`,
        [input.status, input.groupId, input.userId, input.batchId],
      );
      if (batchResult.rowCount !== 1 || groupResult.rowCount !== 1) {
        throw new CanvasAgentBatchLeaseLostError("Agent batch lease changed during finalization");
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof CanvasAgentBatchLeaseLostError) return false;
      throw error;
    } finally {
      client.release();
    }
  };

  const createDailyPaidOperationBudgetMiddleware = (
    resolveReservedTokens: (req: express.Request) => number,
  ): express.RequestHandler => asyncHandler(async (req, res, next) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: "请先登录" });
    const reservedTokens = Math.max(1, Math.ceil(resolveReservedTokens(req)));
    const reservation = await reserveDurableDailyAiBudget(userId, reservedTokens, req.path);
    if (!reservation) {
      res.setHeader("Retry-After", "3600");
      return res.status(429).json({ error: "今日 AI 使用额度已达到上限，请稍后再试" });
    }
    res.locals.dailyAiBudgetReservationTokens = reservedTokens;
    res.locals.dailyAiBudgetReservationDate = normalizeAiBudgetDate(reservation.usage_date);
    res.locals.dailyAiBudgetReservationId = Number(reservation.id);
    res.locals.dailyAiBudgetUserId = userId;
    res.locals.dailyAiBudgetProviderStarted = false;
    let refundPromise: Promise<void> | null = null;
    const refundIfUnused = () => {
      if (res.locals.dailyAiBudgetProviderStarted === true) return;
      if (!refundPromise) {
        refundPromise = refundDailyAiBudgetReservation(userId, res).catch(error => {
          refundPromise = null;
          logger.error({ err: error, module: "ai-budget", userId }, "Failed to refund unused AI budget reservation");
        });
      }
    };
    res.once("finish", refundIfUnused);
    res.once("close", refundIfUnused);
    next();
  });

  const WRITE_AGENT_MAX_PROVIDER_CALLS = 15;
  const dailyPaidOperationBudgetMiddleware = createDailyPaidOperationBudgetMiddleware(() => getCanvasAgentMaxOutputTokens());
  const skillCreationDailyPaidOperationBudgetMiddleware = createDailyPaidOperationBudgetMiddleware(() => 2000);
  const writeAgentDailyPaidOperationBudgetMiddleware = createDailyPaidOperationBudgetMiddleware(
    () => getCanvasAgentMaxOutputTokens() * WRITE_AGENT_MAX_PROVIDER_CALLS,
  );
  const translationDailyPaidOperationBudgetMiddleware = createDailyPaidOperationBudgetMiddleware(req => {
    const segments = Array.isArray(req.body?.segments) ? req.body.segments : null;
    const providerCalls = segments
      ? Math.max(1, Math.min(50, segments.filter((segment: unknown) => typeof segment === "string" && segment.trim()).length))
      : 1;
    return getCanvasAgentMaxOutputTokens() * providerCalls;
  });

  // --- Set/Change password (requires recent proof of account ownership) ---
  app.put("/api/auth/set-password", requireAuth, accountActionLimiter, asyncHandler(async (req, res) => {
    const password = req.body?.password || '';
    if (!password || password.length < 8) {
      return res.status(400).json({ error: '密码至少 8 个字符' });
    }
    const user = (await pool.query(
      `SELECT id, password_hash FROM users WHERE id = $1`,
      [req.session.userId],
    )).rows[0];
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.password_hash) {
      const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
      if (!currentPassword || !(await bcrypt.compare(currentPassword, user.password_hash))) {
        return res.status(401).json({ error: "当前密码错误" });
      }
    } else if (!hasRecentAuthentication(req)) {
      return res.status(403).json({ code: "REAUTH_REQUIRED", error: "请使用邮箱验证码重新登录后再设置密码" });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const updatedUser = await updatePasswordAndInvalidateSessions(req.session.userId, passwordHash);
    if (!updatedUser) return res.status(404).json({ error: '用户不存在' });
    await establishAuthenticatedSession(req, Number(updatedUser.id), String(updatedUser.email));
    return res.json({ success: true });
  }));

  // --- Reset password (forgot password: verify code + set new password, no auth) ---
  app.post("/api/auth/reset-password", verificationCheckIpLimiter, verificationCheckLimiter, asyncHandler(async (req, res) => {
    const email = normalizeEmailAddress(req.body?.email);
    const code = (req.body?.code || '').trim();
    const password = req.body?.password || '';
    if (!email || !code) {
      return res.status(400).json({ error: '请输入邮箱和验证码' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: '密码至少 8 个字符' });
    }

    const client = await pool.connect();
    let user: { id: number } | null = null;
    try {
      await client.query("BEGIN");
      const record = (await client.query(
        `UPDATE verification_codes
         SET used = TRUE
         WHERE id = (
           SELECT id FROM verification_codes
           WHERE email = $1 AND code = $2 AND used = FALSE AND expires_at > NOW() AND password_hash IS NULL
           ORDER BY created_at DESC LIMIT 1
           FOR UPDATE
         ) AND used = FALSE
         RETURNING id`,
        [email, verificationCodeDigest(email, code)]
      )).rows[0];
      if (!record) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: '验证码无效或已过期' });
      }
      user = (await client.query('SELECT id FROM users WHERE email = $1 FOR UPDATE', [email])).rows[0] || null;
      if (!user) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: '该邮箱未注册' });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);
      await invalidateUserSessions(Number(user.id), client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    // Auto login after reset
    await establishAuthenticatedSession(req, Number(user!.id), email);
    const updated = (await pool.query('SELECT id, email, nickname, avatar_url, password_hash FROM users WHERE id = $1', [user!.id])).rows[0];
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

  const estimateAccountExportBytes = async (client: pg.PoolClient, userId: number) => {
    const row = (await client.query(
      `SELECT COALESCE(SUM(bytes), 0)::bigint AS bytes
       FROM (
         SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint AS bytes FROM users t WHERE id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM user_preferences t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM user_subscriptions t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM user_articles t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM saved_articles t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM saved_cards t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(cr)::text)), 0)::bigint FROM card_relations cr JOIN saved_cards sc ON sc.id = cr.card_a WHERE sc.user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM notes t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_agent_threads t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(m)::text)), 0)::bigint FROM write_agent_messages m JOIN write_agent_threads w ON w.id = m.thread_id WHERE w.user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_agent_events t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_style_skills t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_projects t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_assets t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_agent_templates t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_agent_instances t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_nodes t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_edges t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_agent_messages t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_documents t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_document_versions t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_document_sections t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_agent_groups t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_agent_group_members t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_agent_batches t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_agent_runs t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM user_ai_usage_daily t WHERE user_id = $1
       ) estimates`,
      [userId],
    )).rows[0];
    return Math.ceil(Number(row?.bytes || 0) * 4) + 1024 * 1024;
  };

  app.get("/api/account/export", requireAuth, requireRecentAuthentication, accountActionLimiter, asyncHandler(async (req, res) => {
    const userId = req.session.userId;
    const client = await pool.connect();
    try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const exportMaxBytes = readBoundedEnvNumber(process.env.ACCOUNT_EXPORT_MAX_MB, 16, 1, 32) * 1024 * 1024;
    const estimatedExportBytes = await estimateAccountExportBytes(client, userId);
    if (estimatedExportBytes > exportMaxBytes) {
      await client.query("ROLLBACK");
      return res.status(413).json({ error: "账户数据导出超过当前实例上限，请联系运营者协助导出" });
    }
    const rows = async (query: string) => (await client.query(query, [userId])).rows;
    const [
      profile,
      preferences,
      subscriptions,
      articles,
      savedArticles,
      savedCards,
      cardRelations,
      notes,
      writeThreads,
      writeMessages,
      writeEvents,
      writeSkills,
      canvasProjects,
      canvasAssets,
      agentTemplates,
      agentInstances,
      canvasNodes,
      canvasEdges,
      canvasMessages,
      canvasDocuments,
      canvasDocumentVersions,
      canvasDocumentSections,
      canvasAgentGroups,
      canvasAgentGroupMembers,
      canvasAgentBatches,
      canvasAgentRuns,
      aiUsage,
    ] = await Promise.all([
      rows(`SELECT id, email, nickname, avatar_url, created_at, (password_hash IS NOT NULL) AS has_password FROM users WHERE id = $1`),
      rows(`SELECT source_layout, theme, view_mode, updated_at FROM user_preferences WHERE user_id = $1`),
      rows(`SELECT id, name, rss_url, color, icon, topic, created_at, updated_at FROM user_subscriptions WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM user_articles WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM saved_articles WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT id, type, content, tags, article_title, article_id, created_at, updated_at, origin, saved_article_id, summary, original_quote, context, citation_note, evidence_role, raw_card_meta FROM saved_cards WHERE user_id = $1 ORDER BY created_at`),
      rows(`SELECT cr.* FROM card_relations cr JOIN saved_cards sc ON sc.id = cr.card_a WHERE sc.user_id = $1 ORDER BY cr.id`),
      rows(`SELECT * FROM notes WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_agent_threads WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT m.* FROM write_agent_messages m JOIN write_agent_threads t ON t.id = m.thread_id WHERE t.user_id = $1 ORDER BY m.id`),
      rows(`SELECT * FROM write_agent_events WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_style_skills WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_canvas_projects WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_canvas_assets WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_agent_templates WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_agent_instances WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_canvas_nodes WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_canvas_edges WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_canvas_agent_messages WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_canvas_documents WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_canvas_document_versions WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_canvas_document_sections WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_canvas_agent_groups WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_canvas_agent_group_members WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_canvas_agent_batches WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT * FROM write_canvas_agent_runs WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT usage_date, operation_count, reserved_output_tokens, updated_at FROM user_ai_usage_daily WHERE user_id = $1 ORDER BY usage_date`),
    ]);
    const payload = {
      format: "atomflow-account-export-v1",
      exportedAt: new Date().toISOString(),
      profile: profile[0] || null,
      preferences: preferences[0] || null,
      subscriptions,
      articles,
      savedArticles,
      savedCards,
      cardRelations,
      notes,
      writing: { threads: writeThreads, messages: writeMessages, events: writeEvents, skills: writeSkills },
      canvas: {
        projects: canvasProjects,
        assets: canvasAssets,
        templates: agentTemplates,
        agents: agentInstances,
        nodes: canvasNodes,
        edges: canvasEdges,
        messages: canvasMessages,
        documents: canvasDocuments,
        documentVersions: canvasDocumentVersions,
        documentSections: canvasDocumentSections,
        agentGroups: canvasAgentGroups,
        agentGroupMembers: canvasAgentGroupMembers,
        agentBatches: canvasAgentBatches,
        agentRuns: canvasAgentRuns,
      },
      aiUsage,
    };
    await client.query("COMMIT");
    const exportBody = JSON.stringify(payload);
    if (Buffer.byteLength(exportBody, "utf8") > exportMaxBytes) {
      return res.status(413).json({ error: "账户数据导出超过当前实例上限，请联系运营者协助导出" });
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="atomflow-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.type("application/json");
    return res.send(exportBody);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  app.delete("/api/account", requireAuth, accountActionLimiter, asyncHandler(async (req, res) => {
    const userId = req.session.userId;
    const user = (await pool.query(
      `SELECT id, email, password_hash FROM users WHERE id = $1`,
      [userId],
    )).rows[0];
    if (!user) return res.status(404).json({ error: "用户不存在" });
    const confirmation = typeof req.body?.confirmation === "string" ? req.body.confirmation.trim().toLowerCase() : "";
    if (confirmation !== String(user.email).toLowerCase()) {
      return res.status(400).json({ error: "请输入当前账户邮箱以确认注销" });
    }
    if (user.password_hash) {
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!password || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: "密码错误" });
      }
    } else if (!hasRecentAuthentication(req)) {
      return res.status(403).json({ code: "REAUTH_REQUIRED", error: "请使用邮箱验证码重新登录后再注销账户" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM verification_codes WHERE email = $1`, [user.email]);
      await client.query(`DELETE FROM session WHERE sess ->> 'userId' = $1`, [String(userId)]);
      const deleted = await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
      if (deleted.rowCount !== 1) throw new Error("Account deletion did not remove exactly one user");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await new Promise<void>((resolve, reject) => {
      req.session.destroy(error => error ? reject(error) : resolve());
    });
    res.clearCookie("atomflow.sid", { httpOnly: true, secure: isProduction, sameSite: "lax" });
    return res.json({ success: true });
  }));

  app.post("/api/auth/avatar", requireAuth, avatarUpload.single('avatar'), asyncHandler(async (req: any, res) => {
    if (!req.file) {
      return res.status(400).json({ error: '请上传有效的图片文件（JPG/PNG/GIF/WebP）' });
    }
    if (!isAllowedUploadSignature(req.file.buffer, req.file.mimetype, req.file.originalname)) {
      return res.status(400).json({ error: "图片内容与文件类型不匹配" });
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
      'SELECT id, title, content, tags, meta, created_at, updated_at FROM notes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 500',
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
    res.setHeader("X-AtomFlow-RSS-Refreshing", initialFeedRefreshPending ? "true" : "false");
    const requestedSource = typeof req.query.source === "string" ? req.query.source.trim() : "";
    if (requestedSource && BUILTIN_SOURCE_NAMES.has(requestedSource)) {
      const sourceArticles = fullBuiltInArticles
        .filter(article => article.source === requestedSource || article.sourceAliases?.includes(requestedSource))
        .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
      if (!req.session.userId) {
        return res.json(sourceArticles.map(toArticleListItem));
      }
      const withSavedState = await applyUserSavedStateToArticles(req.session.userId, sourceArticles, pool);
      return res.json(withSavedState.map(toArticleListItem));
    }
    if (!req.session.userId) {
      return res.json(articles.map(toArticleListItem));
    }
    const userArticles = await loadUserArticlesAsArticles(req.session.userId, pool);
    if (userArticles.length === 0) {
      const withSavedState = await applyUserSavedStateToArticles(req.session.userId, articles, pool);
      return res.json(withSavedState.map(toArticleListItem));
    }
    // Deduplicate: skip user articles whose URL already exists in global store
    const globalUrls = new Set(articles.flatMap(article => {
      const normalizedUrl = normalizeArticleUrl(article.url);
      return normalizedUrl ? [normalizedUrl] : [];
    }));
    const uniqueUserArticles = userArticles.filter(article => {
      const normalizedUrl = normalizeArticleUrl(article.url);
      return !normalizedUrl || !globalUrls.has(normalizedUrl);
    });
    const rankedArticles = rankArticles([...articles, ...uniqueUserArticles]);
    const withSavedState = await applyUserSavedStateToArticles(req.session.userId, rankedArticles, pool);
    return res.json(withSavedState.map(toArticleListItem));
  }));

  app.post("/api/sources/fetch", requireAuth, remoteFetchLimiter, remoteFetchConcurrencyMiddleware, asyncHandler(async (req, res) => {
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
    const fullFeed = req.body?.full === true;
    const isBuiltin = BUILTIN_SOURCE_NAMES.has(source);
    if (!source || (!isBuiltin && !input)) {
      return res.status(400).json({ error: "source and input are required" });
    }
    const userId = req.session.userId;
    if (isBuiltin) {
      return res.status(403).json({ error: "内置订阅源由服务器统一刷新" });
    }
    const releaseRemoteFetchConcurrency = typeof res.locals.beginRemoteFetchProcessing === "function"
      ? res.locals.beginRemoteFetchProcessing()
      : () => undefined;
    try {
      await validatePublicHttpUrl(input, { allowedPorts: PUBLIC_WEB_PORTS });
      const resource = await fetchBoundedPublicResource(input, {
        timeoutMs: 15000,
        maxBytes: remoteRssMaxBytes,
        maxRedirects: 3,
        allowedPorts: PUBLIC_WEB_PORTS,
        headers: { "User-Agent": "AtomFlow/1.0 RSS Reader", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
      });
      if (resource.status < 200 || resource.status >= 300) throw new Error(`RSS source returned ${resource.status}`);
      const parsed = await parser.parseString(resource.body.toString("utf8"));
      const feedIcon = extractFeedIcon(parsed);
      const fetched = normalizeFeedItems(parsed.items || [], source, '自定义订阅', 900000, feedIcon, {
        maxItems: fullFeed ? remoteRssMaxItems : undefined
      });

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
        const insertResult = await pool.query(
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
        added += insertResult.rowCount ?? 0;
      }
      return res.json({ success: true, added });
    } catch (error) {
      return res.status(502).json({ error: "failed to fetch source" });
    } finally {
      releaseRemoteFetchConcurrency();
    }
  }));

  app.post("/api/sources/retry", requireAuth, remoteFetchLimiter, remoteFetchConcurrencyMiddleware, asyncHandler(async (req, res) => {
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
    const fullFeed = req.body?.full === true;
    const isBuiltin = BUILTIN_SOURCE_NAMES.has(source);
    if (!source || (!isBuiltin && !input)) {
      return res.status(400).json({ error: "source and input are required" });
    }
    const userId = req.session.userId;
    const releaseRemoteFetchConcurrency = typeof res.locals.beginRemoteFetchProcessing === "function"
      ? res.locals.beginRemoteFetchProcessing()
      : () => undefined;
    if (isBuiltin) {
      try {
        const refreshCooldownMs = 60_000;
        const retryAfterMs = Math.max(0, refreshCooldownMs - (Date.now() - lastFeedRefreshAt));
        if (!activeFeedRefresh && retryAfterMs > 0) {
          return res.status(202).json({
            success: true,
            refreshed: false,
            retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
          });
        }
        await runFeedRefresh();
        const refreshed = lastSuccessfulFeedRefreshSources.has(source);
        const articleCount = fullBuiltInArticles.filter(
          article => article.source === source || article.sourceAliases?.includes(source),
        ).length;
        return res.json({ success: true, refreshed, articleCount });
      } finally {
        releaseRemoteFetchConcurrency();
      }
    }
    try {
      await validatePublicHttpUrl(input, { allowedPorts: PUBLIC_WEB_PORTS });
      const resource = await fetchBoundedPublicResource(input, {
        timeoutMs: 30000,
        maxBytes: remoteRssMaxBytes,
        maxRedirects: 3,
        allowedPorts: PUBLIC_WEB_PORTS,
        headers: { "User-Agent": "AtomFlow/1.0 RSS Reader", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
      });
      if (resource.status < 200 || resource.status >= 300) throw new Error(`RSS source returned ${resource.status}`);
      const parsed = await parser.parseString(resource.body.toString("utf8"));
      const feedIcon = extractFeedIcon(parsed);
      const fetched = normalizeFeedItems(parsed.items || [], source, '自定义订阅', 900000, feedIcon, {
        maxItems: fullFeed ? remoteRssMaxItems : undefined
      });

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
        const insertResult = await pool.query(
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
        added += insertResult.rowCount ?? 0;
      }
      return res.json({ success: true, added });
    } catch (error: any) {
      logger.error({ err: error, module: "rss", source }, "Failed to retry source");
      return res.status(502).json({ error: "获取失败", details: error?.message || '未知错误' });
    } finally {
      releaseRemoteFetchConcurrency();
    }
  }));

  app.delete("/api/sources/:source", requireAuth, asyncHandler(async (req, res) => {
    const source = decodeURIComponent(req.params.source || '').trim();
    if (!source) return res.status(400).json({ error: "source is required" });
    const isBuiltin = BUILTIN_SOURCE_NAMES.has(source);
    if (isBuiltin) return res.status(403).json({ error: "内置订阅源不能通过用户接口删除" });
    const result = await pool.query(
      'DELETE FROM user_subscriptions WHERE user_id = $1 AND name = $2',
      [req.session.userId, source]
    );
    const removed = result.rowCount ?? 0;
    return res.json({ success: true, removed });
  }));

  app.patch("/api/sources/rename", requireAuth, asyncHandler(async (req, res) => {
    const from = typeof req.body?.from === 'string' ? req.body.from.trim() : '';
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (!from || !to) return res.status(400).json({ error: "from and to are required" });
    if (from === to) return res.json({ success: true, renamed: 0 });
    if (BUILTIN_SOURCE_NAMES.has(from) || BUILTIN_SOURCE_NAMES.has(to)) {
      return res.status(403).json({ error: "内置订阅源不能通过用户接口重命名" });
    }
    const userId = req.session.userId;
    const result = await pool.query(
      `UPDATE user_subscriptions SET name = $1, updated_at = NOW() WHERE user_id = $2 AND name = $3`,
      [to, userId, from]
    );
    await pool.query(
      `UPDATE user_articles SET source = $1 WHERE user_id = $2 AND source = $3`,
      [to, userId, from]
    );
    const renamed = result.rowCount ?? 0;
    return res.json({ success: true, renamed });
  }));

  // Save an article (mark as saved and extract cards)
  app.post("/api/articles/:id/save", requireAuth, paidOperationLimiter, paidConcurrencyMiddleware, dailyPaidOperationBudgetMiddleware, articleSaveConcurrencyMiddleware, asyncHandler(async (req, res) => {
    const articleId = parseInt(req.params.id);
    let article = articles.find(a => a.id === articleId) || fullBuiltInArticles.find(a => a.id === articleId);
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

    // First, we need to determine the saved_article_id to check for duplicates properly
    // This is a pre-check to see if we've already saved this article
    const normalizedUrl = normalizeArticleUrl(article.url);
    const contentHash = normalizedUrl ? null : generateContentHash(article.title, article.source, article.excerpt);

    let existingSavedArticleId: number | null = null;
    if (normalizedUrl) {
      const existingSavedArticle = await pool.query(
        `SELECT id
         FROM saved_articles
         WHERE user_id = $1 AND normalized_url = $2
         LIMIT 1`,
        [req.session.userId, normalizedUrl]
      );
      existingSavedArticleId = existingSavedArticle.rows[0]?.id ?? null;
    } else if (contentHash) {
      const existingSavedArticle = await pool.query(
        'SELECT id FROM saved_articles WHERE user_id = $1 AND content_hash = $2',
        [req.session.userId, contentHash]
      );
      existingSavedArticleId = existingSavedArticle.rows[0]?.id ?? null;
    }

    // Check if this user already saved cards for this article (using saved_article_id, not article_id)
    const existingCard = existingSavedArticleId
      ? (await pool.query('SELECT id FROM saved_cards WHERE user_id = $1 AND saved_article_id = $2', [req.session.userId, existingSavedArticleId])).rows[0]
      : null;

    if (!existingCard) {
      // AI extraction BEFORE transaction (may take up to 45s, don't hold DB conn)
      let cardsToSave: Array<Omit<AtomCard, 'id' | 'articleTitle' | 'articleId'>>;
	      let articleCitationContext = buildDefaultArticleCitationContext(article);
	      let origin: 'ai' | 'manual' = 'manual';
	      const extractionSkills = (await resolveWriteAgentSkills(pool, req.session.userId)).filter(skill => skill.type === "card_storage" || skill.type === "citation");
	      const extracted = await extractKnowledgeWithAI(article, extractionSkills, () => markDailyAiBudgetProviderStarted(res));
      const aiCards = extracted.cards;
      if (extracted.articleCitationContext) {
        articleCitationContext = extracted.articleCitationContext;
      }
      if (aiCards.length > 0) {
        cardsToSave = aiCards;
        origin = 'ai';
      } else if (isAiFallbackDisabled()) {
        return res.status(502).json({ error: "AI extraction failed", fallbackDisabled: true });
      } else {
        cardsToSave = buildCardsFromArticleContent(article);
        // Mark fallback cards with a tag so users know they're lower quality
        cardsToSave = cardsToSave.map(card => ({
          ...card,
          tags: [...(card.tags || []), '自动提取']
        }));
      }

      const newCards: AtomCard[] = cardsToSave.map(c => ({
        ...c,
        id: randomUUID(),
        articleTitle: article.title,
        articleId: article.id
      }));
      const articleImageUrls = extractImageUrlsFromArticle(article);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Persist original article to saved_articles
        let savedArticleId: number | null = null;
        const normalizedUrl = normalizeArticleUrl(article.url);
        if (normalizedUrl) {
          const savedArticleResult = existingSavedArticleId
            ? await client.query(
              `UPDATE saved_articles
               SET title = $1, url = $2, normalized_url = $2, source = $3, source_icon = $4, topic = $5,
                   excerpt = $6, content = $7, citation_context = $8, image_urls = $9, published_at = $10
               WHERE id = $11 AND user_id = $12
               RETURNING id`,
              [
                article.title, normalizedUrl, article.source, article.sourceIcon || null, article.topic,
                article.excerpt, article.markdownContent || article.content || article.excerpt,
                articleCitationContext, JSON.stringify(articleImageUrls), article.publishedAt || null,
                existingSavedArticleId, req.session.userId,
              ],
            )
            : await client.query(
              `INSERT INTO saved_articles (user_id, title, url, normalized_url, source, source_icon, topic, excerpt, content, citation_context, image_urls, published_at)
               VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (user_id, normalized_url) WHERE normalized_url IS NOT NULL
               DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, excerpt = EXCLUDED.excerpt, source_icon = EXCLUDED.source_icon, citation_context = EXCLUDED.citation_context, image_urls = EXCLUDED.image_urls
               RETURNING id`,
              [
                req.session.userId, article.title, normalizedUrl,
                article.source, article.sourceIcon || null, article.topic,
                article.excerpt, article.markdownContent || article.content || article.excerpt,
                articleCitationContext,
                JSON.stringify(articleImageUrls),
                article.publishedAt || null
              ],
            );
          savedArticleId = savedArticleResult.rows[0]?.id ?? null;
        } else {
          // No URL: use content hash to detect duplicates
          const contentHash = generateContentHash(article.title, article.source, article.excerpt);
          const existing = await client.query(
            `SELECT id FROM saved_articles WHERE user_id = $1 AND content_hash = $2 LIMIT 1`,
            [req.session.userId, contentHash]
          );
          if (existing.rows[0]) {
            savedArticleId = existing.rows[0].id;
            await client.query(
              `UPDATE saved_articles
               SET title = $1, content = $2, excerpt = $3, source_icon = $4, citation_context = $5, image_urls = $6
               WHERE id = $7 AND user_id = $8`,
              [
                article.title,
                article.markdownContent || article.content || article.excerpt,
                article.excerpt,
                article.sourceIcon || null,
                articleCitationContext,
                JSON.stringify(articleImageUrls),
                savedArticleId,
                req.session.userId
              ]
            );
          } else {
            const insertResult = await client.query(
              `INSERT INTO saved_articles (user_id, title, url, source, source_icon, topic, excerpt, content, citation_context, image_urls, published_at, content_hash)
               VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (user_id, content_hash) WHERE content_hash IS NOT NULL
               DO UPDATE SET title = EXCLUDED.title,
                             content = EXCLUDED.content,
                             excerpt = EXCLUDED.excerpt,
                             source_icon = EXCLUDED.source_icon,
                             citation_context = EXCLUDED.citation_context,
                             image_urls = EXCLUDED.image_urls
               RETURNING id`,
              [
                req.session.userId, article.title,
                article.source, article.sourceIcon || null, article.topic,
                article.excerpt, article.markdownContent || article.content || article.excerpt,
                articleCitationContext,
                JSON.stringify(articleImageUrls),
                article.publishedAt || null,
                contentHash
              ]
            );
            savedArticleId = insertResult.rows[0]?.id ?? null;
          }
        }

        const cardsAlreadyStored = savedArticleId
          ? (await client.query(
              `SELECT id FROM saved_cards WHERE user_id = $1 AND saved_article_id = $2 LIMIT 1`,
              [req.session.userId, savedArticleId],
            )).rows[0]
          : null;
        if (!cardsAlreadyStored) {
          for (const card of newCards) {
            await client.query(
            `INSERT INTO saved_cards (
               id, user_id, type, content, summary, original_quote, context,
               citation_note, evidence_role, tags, article_title, article_id,
               origin, saved_article_id, raw_card_meta
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [card.id, req.session.userId, card.type, card.content,
             card.summary || null, card.originalQuote || null, card.context || null,
             card.citationNote || null, card.evidenceRole || null, JSON.stringify(card.tags || []),
             card.articleTitle, card.articleId || null, origin, savedArticleId || null,
             JSON.stringify({
               extractionModel: getAiChatConfig()?.model || null,
               extractedAt: new Date().toISOString(),
               articleSource: article.source,
               articleTopic: article.topic,
               effectiveSkillSnapshots: {
                 baselineSkills: buildAgentSkillSnapshots(extractionSkills.filter(isBaselineSkill)),
                 userSelectedSkills: buildAgentSkillSnapshots(extractionSkills.filter(skill => !isBaselineSkill(skill)))
               }
             })]
            );
          }
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

    res.json({ success: true, article: { ...article, saved: true } });
  }));

  // Fetch full content for an article
  app.get("/api/articles/:id/full", asyncHandler(async (req, res) => {
    const articleId = parseInt(req.params.id);
    const builtInArticle = articles.find(a => a.id === articleId) || fullBuiltInArticles.find(a => a.id === articleId);
    let article: Article | undefined = builtInArticle ? { ...builtInArticle } : undefined;

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
      
      const responseArticle = req.session.userId
        ? (await applyUserSavedStateToArticles(req.session.userId, [article], pool))[0]
        : article;
      return res.json({ success: true, article: responseArticle });
    } catch (error) {
      logger.error({ err: error, module: "articles", articleId }, "Failed to process article content");
      article.markdownContent = article.content || article.excerpt || '暂无内容';
      article.readabilityUsed = false;
      article.fullFetched = true;
      const responseArticle = req.session.userId
        ? (await applyUserSavedStateToArticles(req.session.userId, [article], pool))[0]
        : article;
      return res.json({ success: true, article: responseArticle });
    }
  }));

  // Image proxy to bypass CSP and hotlink protection
  app.get("/api/image-proxy", remoteFetchLimiter, asyncHandler(async (req, res) => {
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
    const imageProxyMaxBytes = readBoundedEnvNumber(process.env.IMAGE_PROXY_MAX_MB, 8, 1, 16) * 1024 * 1024;
    const imageProxyTimeoutMs = readBoundedEnvNumber(process.env.IMAGE_PROXY_TIMEOUT_MS, 8000, 1000, 20000);
    const assertAllowedImageHost = (url: URL) => {
      const candidateHost = url.hostname.toLowerCase();
      if (!ALLOWED_IMAGE_HOST_SUFFIXES.some(suffix => candidateHost === suffix || candidateHost.endsWith(`.${suffix}`))) {
        throw new Error("Image host not allowed");
      }
    };
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
      const resource = await fetchBoundedPublicResource(parsedUrl.toString(), {
        timeoutMs: imageProxyTimeoutMs,
        maxBytes: imageProxyMaxBytes,
        maxRedirects: 2,
        validateUrl: assertAllowedImageHost,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': refererHeader,
          'Accept': 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,image/*;q=0.8'
        },
      });
      if (resource.status < 200 || resource.status >= 300) throw new Error(`Image source returned ${resource.status}`);
      const contentType = (resource.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!/^image\/(?:png|jpe?g|gif|webp|avif|x-icon|vnd\.microsoft\.icon)$/.test(contentType)) {
        return res.status(415).send("Remote content is not a supported image");
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      res.send(resource.body);
    } catch (error) {
      logger.error({ err: error, module: "image-proxy", imageHost: parsedUrl.hostname }, "Image proxy error");
      if (error instanceof ResponseLimitError) return res.status(413).send("Remote image is too large");
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return res.status(504).send("Remote image timed out");
      res.status(502).send("Failed to load image");
    }
  }));

  // Favicon proxy for RSS source icons. Unlike article images, source icons can
  // come from arbitrary subscription domains, so keep the response small.
  app.get("/api/favicon-proxy", requireAuth, remoteFetchLimiter, asyncHandler(async (req, res) => {
    const targetUrl = req.query.url as string;
    if (!targetUrl) {
      return res.status(400).send("Missing url parameter");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      return res.status(400).send("Invalid url parameter");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).send("Invalid url protocol");
    }
    if (parsedUrl.port && !["80", "443"].includes(parsedUrl.port)) {
      return res.status(400).send("Invalid url port");
    }
    const authorizedIcon = (await pool.query(
      `SELECT 1
       FROM (
         SELECT icon AS url FROM user_subscriptions WHERE user_id = $1
         UNION ALL
         SELECT source_icon AS url FROM user_articles WHERE user_id = $1
       ) owned_icons
       WHERE url = ANY($2::text[])
       LIMIT 1`,
      [req.session.userId, [targetUrl, parsedUrl.toString()]],
    )).rows[0];
    if (!authorizedIcon) return res.status(403).send("Favicon target is not an owned subscription icon");
    const hasImageFileExtension = /\.(?:ico|png|jpe?g|gif|webp|avif)$/i.test(parsedUrl.pathname);
    const fallbackUrls = hasImageFileExtension ? [] : [
      `${parsedUrl.origin}/favicon.ico`,
      `${parsedUrl.origin}/favicon.png`,
      `${parsedUrl.origin}/apple-touch-icon.png`,
      `${parsedUrl.origin}/apple-touch-icon-precomposed.png`
    ];
    const faviconUrls = Array.from(new Set([
      parsedUrl.toString(),
      ...fallbackUrls
    ]));

    for (const faviconUrl of faviconUrls) {
      try {
        const resource = await fetchBoundedPublicResource(faviconUrl, {
          timeoutMs: 3000,
          maxBytes: 1024 * 1024,
          maxRedirects: 2,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,image/x-icon,image/*;q=0.8'
          }
        });
        if (resource.status < 200 || resource.status >= 300) continue;
        const contentType = (resource.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!/^image\/(?:png|jpe?g|gif|webp|avif|x-icon|vnd\.microsoft\.icon)$/.test(contentType)) continue;
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.send(resource.body);
        return;
      } catch (error) {
        logger.debug({ err: error, module: "favicon-proxy", faviconHost: new URL(faviconUrl).hostname }, "Favicon candidate failed");
      }
    }

    res.status(404).send("Favicon not found");
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
      `SELECT sc.id, sc.type, sc.content, sc.summary,
              sc.original_quote AS "originalQuote",
              sc.context,
              sc.citation_note AS "citationNote",
              sc.evidence_role AS "evidenceRole",
              sc.tags,
              sc.article_title AS "articleTitle",
              sc.article_id AS "articleId",
              sc.origin,
              sc.saved_article_id AS "savedArticleId",
              sa.source AS "sourceName",
              sa.url AS "sourceUrl",
              sa.excerpt AS "sourceExcerpt",
              sa.citation_context AS "sourceContext",
              sa.image_urls AS "sourceImages",
              sa.published_at AS "publishedAt",
              sa.saved_at AS "savedAt"
       FROM saved_cards sc
       LEFT JOIN saved_articles sa ON sa.id = sc.saved_article_id AND sa.user_id = sc.user_id
       WHERE sc.user_id = $1
       ORDER BY sc.created_at DESC
       LIMIT 500`,
      [req.session.userId]
    )).rows;
    res.json(rows.map(row => ({ ...row, sourceImages: normalizeJsonStringArray(row.sourceImages) })));
  }));

  // Add a new manual card
  app.post("/api/cards", requireAuth, asyncHandler(async (req, res) => {
    const requestedSavedArticleId = req.body?.savedArticleId === undefined || req.body?.savedArticleId === null
      ? null
      : Number(req.body.savedArticleId);
    if (requestedSavedArticleId !== null && (!Number.isSafeInteger(requestedSavedArticleId) || requestedSavedArticleId <= 0)) {
      return res.status(400).json({ error: "无效的文章来源" });
    }
    const newCard: AtomCard = {
      ...req.body,
      id: randomUUID(),
      articleTitle: req.body.articleTitle || "手动录入"
    };
    if (!VALID_CARD_TYPES.has(newCard.type)) {
      return res.status(400).json({ error: '无效的卡片类型' });
    }
    const result = await pool.query(
      `INSERT INTO saved_cards (
         id, user_id, type, content, summary, original_quote, context,
         citation_note, evidence_role, tags, article_title, article_id,
         origin, saved_article_id, raw_card_meta
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
       WHERE $14::bigint IS NULL OR EXISTS (
         SELECT 1 FROM saved_articles WHERE id = $14 AND user_id = $2
       )
       RETURNING id`,
      [
        newCard.id, req.session.userId, newCard.type, newCard.content,
        newCard.summary || null, newCard.originalQuote || null, newCard.context || null,
        newCard.citationNote || null, newCard.evidenceRole || null,
        JSON.stringify(newCard.tags || []), newCard.articleTitle, newCard.articleId || null,
        req.body.origin || 'manual', requestedSavedArticleId,
        JSON.stringify({ createdBy: 'manual', createdAt: new Date().toISOString() })
      ]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "文章来源不存在" });
    res.json(newCard);
  }));

  // Update a card (single atomic UPDATE)
  app.put("/api/cards/:id", requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { type, content, tags, summary, originalQuote, context, citationNote, evidenceRole } = req.body;

    const row = (await pool.query(
      `UPDATE saved_cards SET
        type = COALESCE($1, type),
        content = COALESCE($2, content),
        tags = COALESCE($3, tags),
        summary = COALESCE($4, summary),
        original_quote = COALESCE($5, original_quote),
        context = COALESCE($6, context),
        citation_note = COALESCE($7, citation_note),
        evidence_role = COALESCE($8, evidence_role),
        updated_at = NOW()
      WHERE id = $9 AND user_id = $10
      RETURNING id, type, content, summary,
                original_quote AS "originalQuote",
                context,
                citation_note AS "citationNote",
                evidence_role AS "evidenceRole",
                tags, article_title AS "articleTitle", article_id AS "articleId"`,
      [
        type ?? null,
        content ?? null,
        tags ? JSON.stringify(tags) : null,
        summary ?? null,
        originalQuote ?? null,
        context ?? null,
        citationNote ?? null,
        evidenceRole ?? null,
        id,
        req.session.userId
      ]
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
              citation_context AS "citationContext",
              image_urls AS "sourceImages",
              published_at AS "publishedAt", saved_at AS "savedAt"
       FROM saved_articles WHERE user_id = $1 ORDER BY saved_at DESC LIMIT 500`,
      [req.session.userId]
    )).rows;
    res.json(rows.map(row => ({ ...row, sourceImages: normalizeJsonStringArray(row.sourceImages) })));
  }));

  // Get a single saved article (with full content)
  app.get("/api/saved-articles/:id", requireAuth, asyncHandler(async (req, res) => {
    const row = (await pool.query(
      `SELECT id, title, url, source, source_icon AS "sourceIcon", topic, excerpt, content,
              citation_context AS "citationContext",
              image_urls AS "sourceImages",
              published_at AS "publishedAt", saved_at AS "savedAt"
       FROM saved_articles WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.userId]
    )).rows[0];
    if (!row) return res.status(404).json({ error: "Saved article not found" });
    res.json({ ...row, sourceImages: normalizeJsonStringArray(row.sourceImages) });
  }));

  app.delete("/api/saved-articles/:id", requireAuth, asyncHandler(async (req, res) => {
    const articleId = Number(req.params.id);
    if (!Number.isSafeInteger(articleId) || articleId <= 0) return res.status(400).json({ error: "invalid saved article id" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const referencedProjects = (await client.query(
        `SELECT DISTINCT project_id
         FROM write_canvas_nodes
         WHERE user_id = $1 AND kind = 'saved_article' AND ref_id = $2
         ORDER BY project_id`,
        [req.session.userId, String(articleId)],
      )).rows;
      for (const project of referencedProjects) {
        await assertNoActiveCanvasAiWork(client, req.session.userId, Number(project.project_id));
      }
      await client.query(
        `DELETE FROM write_canvas_nodes
         WHERE user_id = $1 AND kind = 'saved_article' AND ref_id = $2`,
        [req.session.userId, String(articleId)],
      );
      const result = await client.query(
        `DELETE FROM saved_articles WHERE id = $1 AND user_id = $2`,
        [articleId, req.session.userId],
      );
      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Saved article not found" });
      }
      await client.query("COMMIT");
      return res.json({ success: true });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CanvasAiActiveError) return res.status(409).json({ code: "CANVAS_AI_ACTIVE", error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }));

  // Translate article content (Baidu Translate API)
  // Supports both single string (content) and array of strings (segments) for paragraph-level translation
  app.post("/api/translate", requireAuth, paidOperationLimiter, paidConcurrencyMiddleware, translationDailyPaidOperationBudgetMiddleware, asyncHandler(async (req, res) => {
    const { content, segments, targetLang = 'zh' } = req.body;
    const maxTranslationSegments = 50;
    const maxTranslationCharacters = 50_000;

    if (segments !== undefined && (!Array.isArray(segments) || segments.some(segment => typeof segment !== "string"))) {
      return res.status(400).json({ error: "segments must be an array of strings" });
    }
    if (Array.isArray(segments) && segments.length > maxTranslationSegments) {
      return res.status(413).json({ error: `最多支持 ${maxTranslationSegments} 个翻译段落` });
    }
    const translationCharacters = Array.isArray(segments)
      ? segments.reduce((total, segment) => total + segment.length, 0)
      : typeof content === "string" ? content.length : 0;
    if (translationCharacters > maxTranslationCharacters) {
      return res.status(413).json({ error: `单次翻译内容不能超过 ${maxTranslationCharacters} 个字符` });
    }
    if (!Array.isArray(segments) && content !== undefined && typeof content !== "string") {
      return res.status(400).json({ error: "content must be a string" });
    }

    const appid = process.env.BAIDU_TRANSLATE_APPID;
    const key = process.env.BAIDU_TRANSLATE_KEY;

    if (!appid || !key) {
      return res.status(500).json({ error: "Translation service not configured" });
    }

    const toLang = targetLang === 'zh-CN' ? 'zh' : targetLang;
    const crypto = await import('crypto');

    // Parse untrusted HTML/Markdown structurally before sending plain text upstream.
    const stripMarkdown = (md: string): string => stripBareHtmlTagRemnants(
      contentToPlainText(md, {
        preserveLineBreaks: true,
        dropContentTags: ["figure", "video", "details", "summary", "pre", "code"],
      }),
    );

    // Helper: call Baidu API for a single text
    const baiduTranslate = async (text: string): Promise<string> => {
      const salt = Date.now().toString() + Math.random();
      const sign = crypto.createHash('md5').update(appid + text + salt + key).digest('hex');
      const params = new URLSearchParams({ q: text, from: 'auto', to: toLang, appid, salt, sign });
      await markDailyAiBudgetProviderStarted(res);
      const response = await fetch(`https://fanyi-api.baidu.com/api/trans/vip/translate?${params}`, {
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json() as any;
      if (data.error_code) throw new Error(`百度翻译错误 ${data.error_code}: ${data.error_msg}`);
      return (data.trans_result as Array<{ dst: string }>).map(r => r.dst).join('\n');
    };

    // Clean artifacts that Baidu introduces in translated output
    const cleanTranslation = (t: string): string => {
      return contentToPlainText(t, true)
        // Remove stray ；between Chinese words (from apostrophes like we're → 我们；重新)
        .replace(/(?<=[\u4e00-\u9fa5\w])；(?=[\u4e00-\u9fa5\w])/g, '')
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
      `SELECT sc.id, sc.type, sc.content, sc.summary,
              sc.original_quote AS "originalQuote",
              sc.context,
              sc.citation_note AS "citationNote",
              sc.evidence_role AS "evidenceRole",
              sc.tags,
              sc.article_title AS "articleTitle",
              sc.article_id AS "articleId",
              sc.saved_article_id AS "savedArticleId",
              sa.source AS "sourceName",
              sa.url AS "sourceUrl",
              sa.excerpt AS "sourceExcerpt",
              sa.citation_context AS "sourceContext",
              sa.image_urls AS "sourceImages",
              sa.published_at AS "publishedAt",
              sa.saved_at AS "savedAt"
       FROM saved_cards sc
       LEFT JOIN saved_articles sa ON sa.id = sc.saved_article_id AND sa.user_id = sc.user_id
       WHERE sc.user_id = $1`,
      [req.session.userId]
    )).rows.map(r => ({
      ...r,
      tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags,
      sourceImages: normalizeJsonStringArray(r.sourceImages)
    }));

    if (cardRows.length === 0) return res.json({ cards: [] });

    const keywords = topic.split(/[\s,、]+/).filter(Boolean);
    const matched = cardRows.filter(c => {
      const text = `${c.content} ${c.summary || ''} ${c.sourceContext || ''} ${c.context || ''} ${c.originalQuote || ''} ${c.citationNote || ''} ${(c.tags || []).join(' ')} ${c.articleTitle || ''} ${c.sourceName || ''}`.toLowerCase();
      return keywords.some((k: string) => text.includes(k.toLowerCase()));
    });

    res.json({ cards: matched.length >= 2 ? matched : cardRows.slice(0, 10) });
  }));

  app.get("/api/write/canvas/projects", requireAuth, asyncHandler(async (req, res) => {
    await ensureCanvasProject(pool, req.session.userId);
    const rows = (await pool.query(
      `SELECT id, name, viewport, created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"
       FROM write_canvas_projects
       WHERE user_id = $1
       ORDER BY last_opened_at DESC
       LIMIT $2`,
      [req.session.userId, WRITE_CANVAS_MAX_PROJECTS_PER_USER]
    )).rows.map(mapCanvasProjectRow);
    res.json({ projects: rows });
  }));

  app.post("/api/write/canvas/projects", requireAuth, asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === "string" && req.body.name.trim()
      ? req.body.name.trim().slice(0, 80)
      : "新的魔法写作项目";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const row = (await client.query(
        `INSERT INTO write_canvas_projects (user_id, name)
         SELECT $1, $2
         WHERE (SELECT COUNT(*) FROM write_canvas_projects WHERE user_id = $1) < $3
         RETURNING id, name, viewport, created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"`,
        [req.session.userId, name, WRITE_CANVAS_MAX_PROJECTS_PER_USER]
      )).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "画布项目数量已达到上限" });
      }
      await client.query("COMMIT");
      res.json({ project: mapCanvasProjectRow(row) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/api/write/canvas/projects/:id", requireAuth, asyncHandler(async (req, res) => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: "invalid project id" });
    const detail = await fetchCanvasProjectDetail(pool, req.session.userId, projectId);
    if (!detail) return res.status(404).json({ error: "project not found" });
    res.json(detail);
  }));

  app.put("/api/write/canvas/projects/:id", requireAuth, asyncHandler(async (req, res) => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: "invalid project id" });
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : null;
    const viewport = req.body?.viewport === undefined
      ? null
      : normalizeBoundedJsonObject(req.body.viewport, WRITE_CANVAS_MAX_VIEWPORT_BYTES);
    if (req.body?.viewport !== undefined && !viewport) {
      return res.status(413).json({ error: "viewport payload is too large" });
    }
    const row = (await pool.query(
      `UPDATE write_canvas_projects
       SET name = COALESCE($1, name),
           viewport = COALESCE($2, viewport),
           updated_at = NOW(),
           last_opened_at = NOW()
       WHERE id = $3 AND user_id = $4
       RETURNING id, name, viewport, created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"`,
      [name || null, viewport ? JSON.stringify(viewport) : null, projectId, req.session.userId]
    )).rows[0];
    if (!row) return res.status(404).json({ error: "project not found" });
    res.json({ project: mapCanvasProjectRow(row) });
  }));

  app.delete("/api/write/canvas/projects/:id", requireAuth, asyncHandler(async (req, res) => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: "invalid project id" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const project = (await client.query(
        `SELECT id FROM write_canvas_projects WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [projectId, req.session.userId],
      )).rows[0];
      if (!project) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      await assertNoActiveCanvasAiWork(client, req.session.userId, projectId);
      const result = await client.query(
        `DELETE FROM write_canvas_projects WHERE id = $1 AND user_id = $2`,
        [projectId, req.session.userId]
      );
      if (result.rowCount !== 1) throw new Error("Canvas project deletion lost its ownership lock");
      const remaining = (await client.query(
        `SELECT id FROM write_canvas_projects WHERE user_id = $1 LIMIT 1`,
        [req.session.userId]
      )).rows[0];
      if (!remaining) {
        await client.query(
          `INSERT INTO write_canvas_projects (user_id, name) VALUES ($1, '我的魔法写作项目')`,
          [req.session.userId]
        );
      }
      await client.query("COMMIT");
      res.json({ success: true });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CanvasAiActiveError) return res.status(409).json({ code: "CANVAS_AI_ACTIVE", error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/write/canvas/projects/:id/nodes", requireAuth, asyncHandler(async (req, res) => {
    const projectId = Number(req.params.id);
    const kind = normalizeCanvasNodeKind(req.body?.kind);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: "invalid project id" });
    if (!kind) return res.status(400).json({ error: "invalid node kind" });
    if (req.body?.documentId !== undefined) return res.status(400).json({ error: "documentId is managed by document APIs" });
    const role = req.body?.role === undefined ? getCanvasNodeRole(kind) : normalizeCanvasNodeRole(req.body.role);
    const origin = req.body?.origin === undefined ? getCanvasNodeOrigin(kind) : normalizeCanvasNodeOrigin(req.body.origin);
    const status = req.body?.status === undefined ? getCanvasNodeStatus(kind) : normalizeCanvasNodeStatus(req.body.status);
    if (!role || !origin || !status) return res.status(400).json({ error: "invalid node role, origin or status" });
    const contentType = typeof req.body?.contentType === "string" && req.body.contentType.trim()
      ? req.body.contentType.trim().slice(0, 80) : getCanvasContentType(kind);
    const businessRef = typeof req.body?.businessRef === "string" ? req.body.businessRef.trim().slice(0, 500) : null;
    const x = clampNumber(req.body?.x, 120, -100000, 100000);
    const y = clampNumber(req.body?.y, 120, -100000, 100000);
    const width = clampNumber(req.body?.width, kind === "agent" ? 360 : 280, 160, 1200);
    const height = clampNumber(req.body?.height, kind === "agent" ? 260 : 180, 120, 1000);
    const meta = normalizeBoundedJsonObject(req.body?.meta);
    if (!meta) return res.status(413).json({ error: "node metadata is too large" });
    let title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 120) : "";
    let summary = typeof req.body?.summary === "string" ? req.body.summary.trim().slice(0, 500) : "";
    let refId: string | null = typeof req.body?.refId === "string" || typeof req.body?.refId === "number" ? String(req.body.refId) : null;
    const hasAssetId = req.body?.assetId !== undefined && req.body?.assetId !== null && req.body?.assetId !== "";
    const requestedAssetId = hasAssetId ? Number(req.body.assetId) : null;
    let assetId: number | null = null;
    let agentId: number | null = null;

    if (hasAssetId && kind !== "asset_file" && kind !== "asset_image") {
      return res.status(400).json({ error: "assetId is only valid for uploaded file or image nodes" });
    }
    if ((kind === "asset_file" || kind === "asset_image") && (!Number.isSafeInteger(requestedAssetId) || Number(requestedAssetId) <= 0)) {
      return res.status(400).json({ error: "assetId is required for uploaded file or image nodes" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fail = async (status: number, error: string) => {
        await client.query("ROLLBACK");
        return res.status(status).json({ error });
      };
      await lockCanvasUser(client, req.session.userId);
      const project = (await client.query(
        `SELECT id FROM write_canvas_projects WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [projectId, req.session.userId]
      )).rows[0];
      if (!project) return await fail(404, "project not found");
      const nodeCount = Number((await client.query(
        `SELECT COUNT(*)::int AS count FROM write_canvas_nodes WHERE project_id = $1 AND user_id = $2`,
        [projectId, req.session.userId],
      )).rows[0]?.count || 0);
      if (nodeCount >= WRITE_CANVAS_MAX_NODES_PER_PROJECT) return await fail(413, "项目节点数量已达到上限");
      if (kind === "agent") {
      const defaults = getDefaultCanvasAgentConfig();
      const templateId = Number.isFinite(Number(req.body?.templateId)) ? Number(req.body.templateId) : null;
      const template = templateId
        ? (await client.query(`SELECT * FROM write_agent_templates WHERE id = $1 AND user_id = $2`, [templateId, req.session.userId])).rows[0]
        : null;
      if (templateId && !template) return await fail(404, "template not found");
      const agentName = title || template?.name || defaults.name;
      const agentModel = resolveAllowedCanvasAgentModel(req.body?.model, template?.model || defaults.model);
      if (!agentModel) return await fail(400, "该模型未被服务器允许");
      const row = (await client.query(
        `INSERT INTO write_agent_instances
           (user_id, project_id, template_id, name, model, system_prompt, temperature, top_p, max_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          req.session.userId,
          projectId,
          template?.id || null,
          agentName,
          agentModel,
          req.body?.systemPrompt || template?.system_prompt || defaults.systemPrompt,
          clampNumber(req.body?.temperature ?? template?.temperature, defaults.temperature, 0, 2),
          clampNumber(req.body?.topP ?? template?.top_p, defaults.topP, 0.01, 1),
          Math.round(clampNumber(req.body?.maxTokens ?? template?.max_tokens, defaults.maxTokens, 128, getCanvasAgentMaxOutputTokens()))
        ]
      )).rows[0];
      agentId = Number(row.id);
      refId = String(agentId);
      title = agentName;
      summary = summary || "连接资料后发送消息，只会使用已连接上下文。";
      } else if (kind === "asset_text" || kind === "result") {
      const content = typeof req.body?.content === "string" ? req.body.content.slice(0, WRITE_AGENT_MAX_MESSAGE_LENGTH) : "";
      title = title || (kind === "result" ? "Agent 输出" : "粘贴文本");
      const newAssetBytes = Buffer.byteLength(content, "utf8") * 2;
      const storedBytes = await getCanvasStoredBytes(client, req.session.userId);
      if (storedBytes + newAssetBytes > canvasUserStorageMaxBytes) {
        return await fail(413, "画布资料存储额度已用完，请删除旧资料后重试");
      }
      const asset = (await client.query(
        `INSERT INTO write_canvas_assets (user_id, project_id, type, title, content_text, extracted_text, meta)
         VALUES ($1, $2, 'text', $3, $4, $4, $5)
         RETURNING id`,
        [req.session.userId, projectId, title, content, JSON.stringify(meta)]
      )).rows[0];
      assetId = Number(asset.id);
      summary = summary || normalizePlainText(content).slice(0, 180);
      } else if (kind === "asset_file" || kind === "asset_image") {
      assetId = Number(requestedAssetId);
      const asset = (await client.query(
        `SELECT id, title, extracted_text FROM write_canvas_assets
         WHERE id = $1 AND user_id = $2 AND project_id = $3
         FOR SHARE`,
        [assetId, req.session.userId, projectId]
      )).rows[0];
      if (!asset) return await fail(404, "asset not found");
      title = title || asset.title || "上传资料";
      summary = summary || normalizePlainText(asset.extracted_text || "").slice(0, 180);
      } else if (["saved_article", "atom_card", "note"].includes(kind)) {
      const referenceId = kind === "atom_card" ? String(refId || "").trim() : Number(refId);
      if (kind === "atom_card") {
        if (!referenceId || String(referenceId).length > 128) return await fail(400, "valid refId is required");
      } else if (!Number.isSafeInteger(referenceId) || Number(referenceId) <= 0) {
        return await fail(400, "valid refId is required");
      }
      const table = kind === "saved_article" ? "saved_articles" : kind === "atom_card" ? "saved_cards" : "notes";
      const reference = (await client.query(
        `SELECT id FROM ${table} WHERE id = $1 AND user_id = $2`,
        [referenceId, req.session.userId]
      )).rows[0];
      if (!reference) return await fail(404, "referenced item not found");
      refId = String(referenceId);
      }

      await assertCanvasStorageQuota(client, req.session.userId, estimateCanvasStorageBytes({
        title: title || "未命名节点",
        summary,
        businessRef,
        meta,
      }));
      const nodeRow = (await client.query(
      `INSERT INTO write_canvas_nodes
         (user_id, project_id, kind, node_role, content_type, origin, status, business_ref, title, summary, ref_id, asset_id, agent_id, meta, x, y, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING id`,
      [
        req.session.userId,
        projectId,
        kind,
        role,
        contentType,
        origin,
        status,
        businessRef,
        title || "未命名节点",
        summary,
        refId,
        assetId,
        agentId,
        JSON.stringify(meta),
        x,
        y,
        width,
        height
      ]
      )).rows[0];
      await client.query("COMMIT");
    const detail = await fetchCanvasProjectDetail(pool, req.session.userId, projectId);
    const node = detail?.nodes.find(item => item.id === Number(nodeRow.id));
    res.json({ node });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.put("/api/write/canvas/nodes/:id", requireAuth, asyncHandler(async (req, res) => {
    const nodeId = Number(req.params.id);
    if (!Number.isFinite(nodeId)) return res.status(400).json({ error: "invalid node id" });
    const hasGeometryUpdate = ["x", "y", "width", "height"].some(field => req.body?.[field] !== undefined);
    const expectedUpdatedAt = typeof req.body?.expectedUpdatedAt === "string" ? req.body.expectedUpdatedAt : "";
    if (hasGeometryUpdate && (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt)))) {
      return res.status(428).json({ code: "GEOMETRY_VERSION_REQUIRED", error: "node geometry updates require expectedUpdatedAt" });
    }
    const current = (await pool.query(
      `SELECT id, project_id, agent_id, document_id FROM write_canvas_nodes WHERE id = $1 AND user_id = $2`,
      [nodeId, req.session.userId]
    )).rows[0];
    if (!current) return res.status(404).json({ error: "node not found" });
    if (current.document_id && (req.body?.title !== undefined || req.body?.summary !== undefined || req.body?.status !== undefined)) {
      return res.status(400).json({ error: "document title, summary and status must be updated through the document API" });
    }
    if (req.body?.documentId !== undefined) return res.status(400).json({ error: "documentId is managed by document APIs" });
    const requestedAgentModel = current.agent_id && typeof req.body?.model === "string" && req.body.model.trim()
      ? resolveAllowedCanvasAgentModel(req.body.model, req.body.model)
      : null;
    if (current.agent_id && typeof req.body?.model === "string" && req.body.model.trim() && !requestedAgentModel) {
      return res.status(400).json({ error: "该模型未被服务器允许" });
    }
    const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 120) : null;
    const summary = typeof req.body?.summary === "string" ? req.body.summary.trim().slice(0, 500) : null;
    const meta = req.body?.meta === undefined ? null : normalizeBoundedJsonObject(req.body.meta);
    if (req.body?.meta !== undefined && !meta) return res.status(413).json({ error: "node metadata is too large" });
    const role = req.body?.role === undefined ? null : normalizeCanvasNodeRole(req.body.role);
    const origin = req.body?.origin === undefined ? null : normalizeCanvasNodeOrigin(req.body.origin);
    const status = req.body?.status === undefined ? null : normalizeCanvasNodeStatus(req.body.status);
    if ((req.body?.role !== undefined && !role) || (req.body?.origin !== undefined && !origin) || (req.body?.status !== undefined && !status)) {
      return res.status(400).json({ error: "invalid node role, origin or status" });
    }
    const contentType = typeof req.body?.contentType === "string" ? req.body.contentType.trim().slice(0, 80) : null;
    const businessRef = typeof req.body?.businessRef === "string" ? req.body.businessRef.trim().slice(0, 500) : null;
    const defaults = getDefaultCanvasAgentConfig();
    const nextSystemPrompt = typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt.slice(0, 8000) : null;
    const nextTemperature = req.body?.temperature === undefined ? null : clampNumber(req.body.temperature, defaults.temperature, 0, 2);
    const nextTopP = req.body?.topP === undefined ? null : clampNumber(req.body.topP, defaults.topP, 0.01, 1);
    const nextMaxTokens = req.body?.maxTokens === undefined
      ? null
      : Math.round(clampNumber(req.body.maxTokens, defaults.maxTokens, 128, getCanvasAgentMaxOutputTokens()));
    const updateClient = await pool.connect();
    try {
      await updateClient.query("BEGIN");
      await lockCanvasUser(updateClient, req.session.userId);
      const fresh = (await updateClient.query(
        `SELECT n.id, n.project_id, n.agent_id, n.title, n.summary, n.meta, n.business_ref,
                n.x, n.y, n.width, n.height, n.updated_at,
                ai.name AS agent_name, ai.model AS agent_model, ai.system_prompt,
                ai.temperature, ai.top_p, ai.max_tokens
         FROM write_canvas_nodes n
         LEFT JOIN write_agent_instances ai ON ai.id = n.agent_id AND ai.user_id = n.user_id
         WHERE n.id = $1 AND n.user_id = $2
         FOR UPDATE OF n`,
        [nodeId, req.session.userId],
      )).rows[0];
      if (!fresh) {
        await updateClient.query("ROLLBACK");
        return res.status(404).json({ error: "node not found" });
      }
      if (hasGeometryUpdate && new Date(fresh.updated_at).toISOString() !== expectedUpdatedAt) {
        await updateClient.query("ROLLBACK");
        return res.status(409).json({
          code: "NODE_VERSION_CONFLICT",
          error: "节点已在其他窗口更新",
          node: {
            id: Number(fresh.id),
            x: Number(fresh.x),
            y: Number(fresh.y),
            width: Number(fresh.width),
            height: Number(fresh.height),
            updatedAt: new Date(fresh.updated_at).toISOString(),
          },
        });
      }
      const currentNodeBytes = getJsonByteLength({
        title: fresh.title,
        summary: fresh.summary,
        meta: fresh.meta,
        businessRef: fresh.business_ref,
      });
      const nextNodeBytes = getJsonByteLength({
        title: title ?? fresh.title,
        summary: summary ?? fresh.summary,
        meta: meta ?? fresh.meta,
        businessRef: businessRef ?? fresh.business_ref,
      });
      const currentAgentBytes = fresh.agent_id ? getJsonByteLength({
        name: fresh.agent_name,
        model: fresh.agent_model,
        systemPrompt: fresh.system_prompt,
      }) : 0;
      const nextAgentBytes = fresh.agent_id ? getJsonByteLength({
        name: title ?? fresh.agent_name,
        model: requestedAgentModel ?? fresh.agent_model,
        systemPrompt: nextSystemPrompt ?? fresh.system_prompt,
      }) : 0;
      await assertCanvasStorageQuota(
        updateClient,
        req.session.userId,
        Math.max(0, nextNodeBytes - currentNodeBytes) + Math.max(0, nextAgentBytes - currentAgentBytes),
      );
      await updateClient.query(
        `UPDATE write_canvas_nodes
         SET title = COALESCE($1, title),
             summary = COALESCE($2, summary),
             meta = COALESCE($3, meta),
             x = COALESCE($4, x),
             y = COALESCE($5, y),
             width = COALESCE($6, width),
             height = COALESCE($7, height),
             node_role = COALESCE($8, node_role),
             content_type = COALESCE($9, content_type),
             origin = COALESCE($10, origin),
             status = COALESCE($11, status),
             business_ref = COALESCE($12, business_ref),
             updated_at = NOW()
         WHERE id = $13 AND user_id = $14`,
        [
          title,
          summary,
          meta ? JSON.stringify(meta) : null,
          req.body?.x === undefined ? null : clampNumber(req.body.x, 0, -100000, 100000),
          req.body?.y === undefined ? null : clampNumber(req.body.y, 0, -100000, 100000),
          req.body?.width === undefined ? null : clampNumber(req.body.width, 280, 160, 1200),
          req.body?.height === undefined ? null : clampNumber(req.body.height, 180, 120, 1000),
          role,
          contentType,
          origin,
          status,
          businessRef,
          nodeId,
          req.session.userId,
        ],
      );
      if (fresh.agent_id) {
        await updateClient.query(
          `UPDATE write_agent_instances
           SET name = COALESCE($1, name),
               model = COALESCE($2, model),
               system_prompt = COALESCE($3, system_prompt),
               temperature = COALESCE($4, temperature),
               top_p = COALESCE($5, top_p),
               max_tokens = COALESCE($6, max_tokens),
               updated_at = NOW()
           WHERE id = $7 AND user_id = $8`,
          [title, requestedAgentModel, nextSystemPrompt, nextTemperature, nextTopP, nextMaxTokens, fresh.agent_id, req.session.userId],
        );
      }
      await updateClient.query("COMMIT");
    } catch (error) {
      await updateClient.query("ROLLBACK");
      if (error instanceof CanvasStorageLimitError) return res.status(413).json({ error: error.message });
      throw error;
    } finally {
      updateClient.release();
    }
    const detail = await fetchCanvasProjectDetail(pool, req.session.userId, Number(current.project_id));
    const node = detail?.nodes.find(item => item.id === nodeId);
    res.json({ node });
  }));

  app.delete("/api/write/canvas/nodes/:id", requireAuth, asyncHandler(async (req, res) => {
    const nodeId = Number(req.params.id);
    if (!Number.isFinite(nodeId)) return res.status(400).json({ error: "invalid node id" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const current = (await client.query(
        `SELECT id, project_id, agent_id, asset_id, document_id
         FROM write_canvas_nodes
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [nodeId, req.session.userId]
      )).rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "node not found" });
      }
      await assertNoActiveCanvasAiWork(client, req.session.userId, Number(current.project_id));
      if (current.asset_id) {
        await client.query(
          `SELECT id FROM write_canvas_assets WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [current.asset_id, req.session.userId]
        );
      }

      if (current.document_id) {
        await client.query(
          `DELETE FROM write_canvas_nodes
           WHERE user_id = $1 AND content_type = 'document_section'
             AND meta->>'documentId' = $2`,
          [req.session.userId, String(current.document_id)],
        );
      }

      await client.query(
        `DELETE FROM write_canvas_nodes WHERE id = $1 AND user_id = $2`,
        [nodeId, req.session.userId]
      );
      if (current.agent_id) {
        await client.query(
          `DELETE FROM write_agent_instances ai
           WHERE ai.id = $1 AND ai.user_id = $2
             AND NOT EXISTS (
               SELECT 1 FROM write_canvas_nodes n
               WHERE n.agent_id = ai.id AND n.user_id = ai.user_id
             )`,
          [current.agent_id, req.session.userId]
        );
      }
      if (current.asset_id) {
        await client.query(
          `DELETE FROM write_canvas_assets a
           WHERE a.id = $1 AND a.user_id = $2
             AND NOT EXISTS (
               SELECT 1 FROM write_canvas_nodes n
               WHERE n.asset_id = a.id AND n.user_id = a.user_id
             )`,
          [current.asset_id, req.session.userId]
        );
      }
      await client.query("COMMIT");
      res.json({ success: true });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CanvasAiActiveError) return res.status(409).json({ code: "CANVAS_AI_ACTIVE", error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/write/canvas/edges", requireAuth, asyncHandler(async (req, res) => {
    const projectId = Number(req.body?.projectId);
    const sourceNodeId = Number(req.body?.sourceNodeId);
    const targetNodeId = Number(req.body?.targetNodeId);
    const relation = req.body?.relation === undefined ? "context" : normalizeCanvasEdgeRelation(req.body.relation);
    if (![projectId, sourceNodeId, targetNodeId].every(Number.isFinite)) {
      return res.status(400).json({ error: "projectId, sourceNodeId and targetNodeId are required" });
    }
    if (!relation) return res.status(400).json({ error: "invalid edge relation" });
    if (relation !== "context" && relation !== "structure") return res.status(400).json({ error: "business lineage edges are managed by canvas operations" });
    if (sourceNodeId === targetNodeId) return res.status(400).json({ error: "cannot connect node to itself" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const project = (await client.query(
        `SELECT id FROM write_canvas_projects WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [projectId, req.session.userId],
      )).rows[0];
      if (!project) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      const nodes = (await client.query(
        `SELECT id, kind, node_role, content_type, status FROM write_canvas_nodes
         WHERE user_id = $1 AND project_id = $2 AND id = ANY($3::bigint[])
         FOR SHARE`,
        [req.session.userId, projectId, [sourceNodeId, targetNodeId]],
      )).rows;
      if (nodes.length !== 2) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "nodes not found" });
      }
      const source = nodes.find(node => Number(node.id) === sourceNodeId);
      const target = nodes.find(node => Number(node.id) === targetNodeId);
      const targetAcceptsContext = target?.kind === "agent"
        || (target?.node_role === "task" && target?.content_type === "agent_group");
      const sourceAcceptsContext = source?.kind !== "agent"
        && source?.status !== "rejected"
        && source?.node_role !== "task";
      if (relation === "context" && (!targetAcceptsContext || !sourceAcceptsContext)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "context edges must connect an active material, insight or document source to an Agent task" });
      }
      const sourceAcceptsStructure = source?.kind !== "agent"
        && source?.node_role !== "task"
        && source?.node_role !== "group"
        && source?.status !== "rejected";
      const targetAcceptsStructure = target?.kind !== "agent"
        && target?.node_role !== "task"
        && target?.node_role !== "group"
        && target?.status !== "rejected";
      if (relation === "structure" && (!sourceAcceptsStructure || !targetAcceptsStructure)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "structure edges must connect active non-task content nodes" });
      }
      const existing = (await client.query(
        `SELECT id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                target_node_id AS "targetNodeId", relation, created_at AS "createdAt"
         FROM write_canvas_edges
         WHERE user_id = $1 AND project_id = $2 AND source_node_id = $3 AND target_node_id = $4 AND relation = $5
         FOR UPDATE`,
        [req.session.userId, projectId, sourceNodeId, targetNodeId, relation],
      )).rows[0];
      if (existing) {
        await client.query("COMMIT");
        return res.json({ edge: mapCanvasEdgeRow(existing) });
      }
      if (relation === "structure") {
        const createsCycle = Boolean((await client.query(
          `WITH RECURSIVE descendants(node_id) AS (
             SELECT target_node_id FROM write_canvas_edges
             WHERE user_id = $1 AND project_id = $2 AND source_node_id = $3 AND relation = 'structure'
             UNION
             SELECT edge.target_node_id
             FROM write_canvas_edges edge
             JOIN descendants ON edge.source_node_id = descendants.node_id
             WHERE edge.user_id = $1 AND edge.project_id = $2 AND edge.relation = 'structure'
           )
           SELECT 1 FROM descendants WHERE node_id = $4 LIMIT 1`,
          [req.session.userId, projectId, targetNodeId, sourceNodeId],
        )).rows[0]);
        if (createsCycle) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "structure edge would create a cycle" });
        }
      }
      const edgeCount = Number((await client.query(
        `SELECT COUNT(*)::int AS count FROM write_canvas_edges WHERE user_id = $1 AND project_id = $2`,
        [req.session.userId, projectId],
      )).rows[0]?.count || 0);
      if (edgeCount >= WRITE_CANVAS_MAX_EDGES_PER_PROJECT) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目连线数量已达到上限" });
      }
      await assertCanvasStorageQuota(client, req.session.userId, estimateCanvasStorageBytes({ relation }));
      const row = (await client.query(
        `INSERT INTO write_canvas_edges (user_id, project_id, source_node_id, target_node_id, relation)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                   target_node_id AS "targetNodeId", relation, created_at AS "createdAt"`,
        [req.session.userId, projectId, sourceNodeId, targetNodeId, relation],
      )).rows[0];
      await client.query("COMMIT");
      return res.json({ edge: mapCanvasEdgeRow(row) });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CanvasStorageLimitError) return res.status(413).json({ error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/write/canvas/edges/replace", requireAuth, asyncHandler(async (req, res) => {
    const edgeId = Number(req.body?.edgeId);
    const sourceNodeId = Number(req.body?.sourceNodeId);
    const targetNodeId = Number(req.body?.targetNodeId);
    if (![edgeId, sourceNodeId, targetNodeId].every(value => Number.isSafeInteger(value) && value > 0)) {
      return res.status(400).json({ error: "edgeId, sourceNodeId and targetNodeId are required" });
    }
    if (sourceNodeId === targetNodeId) return res.status(400).json({ error: "cannot connect node to itself" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const edge = (await client.query(
        `SELECT id, project_id, relation FROM write_canvas_edges
         WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [edgeId, req.session.userId],
      )).rows[0];
      if (!edge) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "edge not found" });
      }
      if (edge.relation !== "context") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "only context edges can be replaced" });
      }
      const projectId = Number(edge.project_id);
      const nodes = (await client.query(
        `SELECT id, kind, node_role, content_type, status FROM write_canvas_nodes
         WHERE user_id = $1 AND project_id = $2 AND id = ANY($3::bigint[])
         FOR SHARE`,
        [req.session.userId, projectId, [sourceNodeId, targetNodeId]],
      )).rows;
      if (nodes.length !== 2) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "nodes not found" });
      }
      const source = nodes.find(node => Number(node.id) === sourceNodeId);
      const target = nodes.find(node => Number(node.id) === targetNodeId);
      const targetAcceptsContext = target?.kind === "agent"
        || (target?.node_role === "task" && target?.content_type === "agent_group");
      const sourceAcceptsContext = source?.kind !== "agent"
        && source?.status !== "rejected"
        && source?.node_role !== "task";
      if (!targetAcceptsContext || !sourceAcceptsContext) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "context edges must connect an active material, insight or document source to an Agent task" });
      }
      const duplicate = (await client.query(
        `SELECT id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                target_node_id AS "targetNodeId", relation, created_at AS "createdAt"
         FROM write_canvas_edges
         WHERE user_id = $1 AND project_id = $2 AND source_node_id = $3 AND target_node_id = $4
           AND relation = 'context' AND id <> $5
         FOR UPDATE`,
        [req.session.userId, projectId, sourceNodeId, targetNodeId, edgeId],
      )).rows[0];
      let row: Record<string, unknown>;
      if (duplicate) {
        await client.query(`DELETE FROM write_canvas_edges WHERE id = $1 AND user_id = $2`, [edgeId, req.session.userId]);
        row = duplicate;
      } else {
        row = (await client.query(
          `UPDATE write_canvas_edges
           SET source_node_id = $1, target_node_id = $2
           WHERE id = $3 AND user_id = $4
           RETURNING id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                     target_node_id AS "targetNodeId", relation, created_at AS "createdAt"`,
          [sourceNodeId, targetNodeId, edgeId, req.session.userId],
        )).rows[0];
      }
      await client.query("COMMIT");
      return res.json({ edge: mapCanvasEdgeRow(row) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.delete("/api/write/canvas/edges", requireAuth, asyncHandler(async (req, res) => {
    const edgeId = Number(req.body?.id || req.query.id);
    const projectId = Number(req.body?.projectId);
    const sourceNodeId = Number(req.body?.sourceNodeId);
    const targetNodeId = Number(req.body?.targetNodeId);
    let result: pg.QueryResult;
    if (Number.isFinite(edgeId)) {
      result = await pool.query(`DELETE FROM write_canvas_edges WHERE id = $1 AND user_id = $2`, [edgeId, req.session.userId]);
    } else if ([projectId, sourceNodeId, targetNodeId].every(Number.isFinite)) {
      result = await pool.query(
        `DELETE FROM write_canvas_edges
         WHERE user_id = $1 AND project_id = $2 AND source_node_id = $3 AND target_node_id = $4`,
        [req.session.userId, projectId, sourceNodeId, targetNodeId]
      );
    } else {
      return res.status(400).json({ error: "edge id or edge endpoints are required" });
    }
    res.json({ success: result.rowCount > 0 });
  }));

  app.post("/api/write/canvas/projects/:projectId/documents", requireAuth, asyncHandler(async (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return res.status(400).json({ error: "invalid project id" });
    const sourceNodeId = req.body?.sourceNodeId === undefined ? null : Number(req.body.sourceNodeId);
    if (sourceNodeId !== null && (!Number.isSafeInteger(sourceNodeId) || sourceNodeId <= 0)) {
      return res.status(400).json({ error: "invalid source node id" });
    }
    const title = typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim().slice(0, 240) : "未命名文档";
    const summary = typeof req.body?.summary === "string" ? req.body.summary.trim().slice(0, 1000) : "";
    const scenario = typeof req.body?.scenario === "string" ? req.body.scenario.trim().slice(0, 240) : "";
    const status = req.body?.status === undefined ? "editing" : normalizeCanvasNodeStatus(req.body.status);
    const sections = normalizeCanvasDocumentSections(req.body?.sections ?? []);
    if (!status || !sections) return res.status(400).json({ error: "invalid document status or sections" });
    const x = clampNumber(req.body?.x, 180, -100000, 100000);
    const y = clampNumber(req.body?.y, 180, -100000, 100000);
    const width = clampNumber(req.body?.width, 420, 160, 1200);
    const height = clampNumber(req.body?.height, 320, 120, 1000);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const project = (await client.query(
        `SELECT id FROM write_canvas_projects WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [projectId, req.session.userId],
      )).rows[0];
      if (!project) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      const sourceNode = sourceNodeId === null ? null : (await client.query(
        `SELECT id FROM write_canvas_nodes WHERE id = $1 AND user_id = $2 AND project_id = $3 FOR SHARE`,
        [sourceNodeId, req.session.userId, projectId],
      )).rows[0];
      if (sourceNodeId !== null && !sourceNode) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "source node not found" });
      }
      const nodeCount = Number((await client.query(
        `SELECT COUNT(*)::int AS count FROM write_canvas_nodes WHERE project_id = $1 AND user_id = $2`,
        [projectId, req.session.userId],
      )).rows[0]?.count || 0);
      if (nodeCount >= WRITE_CANVAS_MAX_NODES_PER_PROJECT) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目节点数量已达到上限" });
      }
      if (sourceNodeId !== null) await assertCanvasEdgeCapacity(client, req.session.userId, projectId);
      const storedBytes = await getCanvasStoredBytes(client, req.session.userId);
      const documentValues = { title, summary, scenario, status };
      if (storedBytes + getCanvasDocumentBytes(documentValues, sections) > canvasUserStorageMaxBytes) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "画布资料存储额度已用完，请删除旧资料后重试" });
      }
      const documentRow = (await client.query(
        `INSERT INTO write_canvas_documents (user_id, project_id, title, summary, scenario, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.session.userId, projectId, title, summary, scenario, status],
      )).rows[0];
      const documentId = Number(documentRow.id);
      const nodeRow = (await client.query(
        `INSERT INTO write_canvas_nodes
           (user_id, project_id, kind, node_role, content_type, origin, status, document_id, title, summary, meta, x, y, width, height)
         VALUES ($1, $2, 'note', 'document', 'document', 'manual', $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
         RETURNING id`,
        [req.session.userId, projectId, status, documentId, title, summary, JSON.stringify({ scenario }), x, y, width, height],
      )).rows[0];
      if (sourceNodeId !== null) {
        await client.query(
          `INSERT INTO write_canvas_edges (user_id, project_id, source_node_id, target_node_id, relation)
           VALUES ($1, $2, $3, $4, 'generated')
           ON CONFLICT (project_id, source_node_id, target_node_id, relation) DO NOTHING`,
          [req.session.userId, projectId, sourceNodeId, Number(nodeRow.id)],
        );
      }
      await client.query(`UPDATE write_canvas_documents SET node_id = $1 WHERE id = $2 AND user_id = $3`, [Number(nodeRow.id), documentId, req.session.userId]);
      await writeCanvasDocumentSnapshot(client, req.session.userId, documentId, documentValues, sections);
      await client.query("COMMIT");
      const document = await fetchCanvasDocument(pool, req.session.userId, documentId);
      return res.json({ document });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CanvasStorageLimitError) return res.status(413).json({ error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/api/write/canvas/documents/:id", requireAuth, asyncHandler(async (req, res) => {
    const documentId = Number(req.params.id);
    if (!Number.isSafeInteger(documentId) || documentId <= 0) return res.status(400).json({ error: "invalid document id" });
    const document = await fetchCanvasDocument(pool, req.session.userId, documentId);
    if (!document) return res.status(404).json({ error: "document not found" });
    return res.json({ document });
  }));

  app.put("/api/write/canvas/documents/:id", requireAuth, asyncHandler(async (req, res) => {
    const documentId = Number(req.params.id);
    if (!Number.isSafeInteger(documentId) || documentId <= 0) return res.status(400).json({ error: "invalid document id" });
    const rawCurrentVersionId = req.body?.currentVersionId;
    const expectedCurrentVersionId = rawCurrentVersionId === null ? null : Number(rawCurrentVersionId);
    if (rawCurrentVersionId === undefined || (expectedCurrentVersionId !== null && (!Number.isSafeInteger(expectedCurrentVersionId) || expectedCurrentVersionId <= 0))) {
      return res.status(400).json({ error: "currentVersionId is required" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const current = (await client.query(
        `SELECT id, project_id, node_id, title, summary, scenario, status, current_version_id
         FROM write_canvas_documents WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [documentId, req.session.userId],
      )).rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "document not found" });
      }
      const currentVersionId = current.current_version_id === null ? null : Number(current.current_version_id);
      if (currentVersionId !== expectedCurrentVersionId) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          code: "DOCUMENT_VERSION_CONFLICT",
          error: "作品已在其他窗口更新，请刷新后合并修改",
          currentVersionId,
        });
      }
      const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 240) : current.title;
      const summary = typeof req.body?.summary === "string" ? req.body.summary.trim().slice(0, 1000) : current.summary;
      const scenario = typeof req.body?.scenario === "string" ? req.body.scenario.trim().slice(0, 240) : current.scenario;
      const status = req.body?.status === undefined ? normalizeCanvasNodeStatus(current.status) : normalizeCanvasNodeStatus(req.body.status);
      if (!status) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "invalid document status" });
      }
      const existingSections = (await client.query(
        `SELECT stable_key AS key, heading, body, level, meta
         FROM write_canvas_document_sections WHERE document_id = $1 AND user_id = $2 ORDER BY sort_order`,
        [documentId, req.session.userId],
      )).rows.map(mapCanvasDocumentSectionRow) as CanvasDocumentSectionInput[];
      const sections = req.body?.sections === undefined ? existingSections : normalizeCanvasDocumentSections(req.body.sections);
      if (!sections) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "invalid document sections" });
      }
      const documentValues = { title, summary, scenario, status };
      await pruneCanvasDocumentVersions(client, req.session.userId, documentId, CANVAS_DOCUMENT_MAX_VERSIONS - 1);
      const storedBytes = await getCanvasStoredBytes(client, req.session.userId);
      const additionalBytes = getCanvasDocumentUpdateAdditionalBytes(
        { title: current.title, summary: current.summary, scenario: current.scenario, status: current.status },
        existingSections,
        documentValues,
        sections,
      );
      if (storedBytes + additionalBytes > canvasUserStorageMaxBytes) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "画布资料存储额度已用完，请删除旧资料后重试" });
      }
      await client.query(
        `DELETE FROM write_canvas_nodes
         WHERE user_id = $1 AND project_id = $2 AND content_type = 'document_section'
           AND meta->>'documentId' = $3
           AND NOT (COALESCE(meta->>'sectionKey', '') = ANY($4::text[]))`,
        [req.session.userId, Number(current.project_id), String(documentId), sections.map(section => section.key)],
      );
      await writeCanvasDocumentSnapshot(client, req.session.userId, documentId, documentValues, sections);
      await client.query(
        `UPDATE write_canvas_nodes SET title = $1, summary = $2, status = $3, meta = jsonb_set(meta, '{scenario}', to_jsonb($4::text), true), updated_at = NOW()
         WHERE id = $5 AND user_id = $6`,
        [title, summary, status, scenario, current.node_id, req.session.userId],
      );
      await client.query("COMMIT");
      const document = await fetchCanvasDocument(pool, req.session.userId, documentId);
      return res.json({ document });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/api/write/canvas/documents/:id/versions", requireAuth, asyncHandler(async (req, res) => {
    const documentId = Number(req.params.id);
    if (!Number.isSafeInteger(documentId) || documentId <= 0) return res.status(400).json({ error: "invalid document id" });
    const document = (await pool.query(
      `SELECT id FROM write_canvas_documents WHERE id = $1 AND user_id = $2`,
      [documentId, req.session.userId],
    )).rows[0];
    if (!document) return res.status(404).json({ error: "document not found" });
    const versions = (await pool.query(
      `SELECT id, version_number AS "versionNumber", snapshot, created_at AS "createdAt"
       FROM write_canvas_document_versions WHERE document_id = $1 AND user_id = $2 ORDER BY version_number DESC`,
      [documentId, req.session.userId],
    )).rows.map(row => ({ ...row, id: Number(row.id), versionNumber: Number(row.versionNumber) }));
    return res.json({ versions });
  }));

  app.post("/api/write/canvas/documents/:id/sections/:sectionKey/project", requireAuth, asyncHandler(async (req, res) => {
    const documentId = Number(req.params.id);
    const sectionKey = req.params.sectionKey;
    if (!Number.isSafeInteger(documentId) || documentId <= 0 || !/^[a-zA-Z0-9_-]{1,120}$/.test(sectionKey)) {
      return res.status(400).json({ error: "invalid document section" });
    }
    const client = await pool.connect();
    let projectId = 0;
    let nodeId = 0;
    let edgeRow: Record<string, unknown> | null = null;
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const section = (await client.query(
        `SELECT d.project_id, d.node_id AS document_node_id, d.status,
                s.stable_key, s.sort_order, s.heading, s.body,
                n.x AS document_x, n.y AS document_y
         FROM write_canvas_documents d
         JOIN write_canvas_document_sections s ON s.document_id = d.id AND s.user_id = d.user_id
         JOIN write_canvas_nodes n ON n.id = d.node_id AND n.user_id = d.user_id AND n.project_id = d.project_id
         WHERE d.id = $1 AND d.user_id = $2 AND s.stable_key = $3
         FOR UPDATE OF d, s, n`,
        [documentId, req.session.userId, sectionKey],
      )).rows[0];
      if (!section) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "document section not found" });
      }
      projectId = Number(section.project_id);
      const businessRef = `${documentId}:${sectionKey}`;
      const existing = (await client.query(
        `SELECT id FROM write_canvas_nodes
         WHERE user_id = $1 AND project_id = $2 AND content_type = 'document_section' AND business_ref = $3
         FOR UPDATE`,
        [req.session.userId, projectId, businessRef],
      )).rows[0];
      if (!existing) {
        const nodeCount = Number((await client.query(
          `SELECT COUNT(*)::int AS count FROM write_canvas_nodes WHERE project_id = $1 AND user_id = $2`,
          [projectId, req.session.userId],
        )).rows[0]?.count || 0);
        if (nodeCount >= WRITE_CANVAS_MAX_NODES_PER_PROJECT) {
          await client.query("ROLLBACK");
          return res.status(413).json({ error: "项目节点数量已达到上限" });
        }
      }
      const title = section.heading || `段落 ${Number(section.sort_order) + 1}`;
      const summary = normalizePlainText(section.body || "").slice(0, 500);
      const meta = { documentId, sectionKey };
      await assertCanvasStorageQuota(client, req.session.userId, estimateCanvasStorageBytes({ title, summary, businessRef, meta }));
      const node = (await client.query(
        `INSERT INTO write_canvas_nodes
           (user_id, project_id, kind, node_role, content_type, origin, status, business_ref, title, summary, meta, x, y, width, height)
         VALUES ($1, $2, 'note', 'document', 'document_section', 'manual', $3, $4, $5, $6, $7::jsonb, $8, $9, 340, 220)
         ON CONFLICT (user_id, project_id, content_type, business_ref)
           WHERE content_type = 'document_section' AND business_ref IS NOT NULL
         DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, status = EXCLUDED.status,
                       meta = EXCLUDED.meta, updated_at = NOW()
         RETURNING id`,
        [
          req.session.userId,
          projectId,
          section.status,
          businessRef,
          title,
          summary,
          JSON.stringify(meta),
          Number(section.document_x) + 420,
          Number(section.document_y) + Number(section.sort_order) * 240,
        ],
      )).rows[0];
      nodeId = Number(node.id);
      const existingEdge = (await client.query(
        `SELECT id FROM write_canvas_edges
         WHERE user_id = $1 AND project_id = $2 AND source_node_id = $3 AND target_node_id = $4 AND relation = 'structure'
         FOR UPDATE`,
        [req.session.userId, projectId, Number(section.document_node_id), nodeId],
      )).rows[0];
      if (!existingEdge) await assertCanvasEdgeCapacity(client, req.session.userId, projectId);
      edgeRow = (await client.query(
        `INSERT INTO write_canvas_edges (user_id, project_id, source_node_id, target_node_id, relation)
         VALUES ($1, $2, $3, $4, 'structure')
         ON CONFLICT (project_id, source_node_id, target_node_id, relation) DO UPDATE SET relation = EXCLUDED.relation
         RETURNING id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                   target_node_id AS "targetNodeId", relation, created_at AS "createdAt"`,
        [req.session.userId, projectId, Number(section.document_node_id), nodeId],
      )).rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CanvasStorageLimitError) return res.status(413).json({ error: error.message });
      throw error;
    } finally {
      client.release();
    }
    const detail = await fetchCanvasProjectDetail(pool, req.session.userId, projectId);
    return res.json({
      node: detail?.nodes.find(item => item.id === nodeId),
      edge: edgeRow ? mapCanvasEdgeRow(edgeRow) : null,
    });
  }));

  app.post("/api/write/canvas/assets/upload", requireAuth, uploadLimiter, uploadConcurrencyMiddleware, canvasAssetUpload.single("file"), asyncHandler(async (req, res) => {
    const releaseCanvasUploadConcurrency = typeof res.locals.beginCanvasUploadProcessing === "function"
      ? res.locals.beginCanvasUploadProcessing()
      : () => undefined;
    try {
    const projectId = Number(req.body?.projectId);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: "projectId is required" });
    if (!req.file) return res.status(400).json({ error: "file is required" });
    if (!isAllowedUploadSignature(req.file.buffer, req.file.mimetype, req.file.originalname)) {
      return res.status(400).json({ error: "文件内容与声明类型不匹配" });
    }
    if (
      req.file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
      !(await validateDocxArchiveBounds(req.file.buffer).catch(() => false))
    ) {
      return res.status(400).json({ error: "Word 文件结构无效或解压后内容过大" });
    }
    const project = (await pool.query(`SELECT id FROM write_canvas_projects WHERE id = $1 AND user_id = $2`, [projectId, req.session.userId])).rows[0];
    if (!project) return res.status(404).json({ error: "project not found" });
    const isImage = req.file.mimetype.startsWith("image/");
    let extractionError: string | null = null;
    const extractedText = isImage ? "" : await extractCanvasFileText(req.file).catch(error => {
      logger.warn({ err: error, module: "canvas-upload", fileName: req.file?.originalname }, "Canvas file text extraction failed");
      extractionError = error instanceof Error ? error.message.slice(0, 500) : "文件文本提取失败";
      return "";
    });
    const title = (typeof req.body?.title === "string" && req.body.title.trim())
      ? req.body.title.trim().slice(0, 120)
      : req.file.originalname || "上传资料";
    // Preserve the original for retry, download and future parsers even when extraction fails.
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    const assetType = isImage ? "image" : "file";
    const client = await pool.connect();
    let nodeId: number;
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const lockedProject = (await client.query(
        `SELECT id FROM write_canvas_projects WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [projectId, req.session.userId]
      )).rows[0];
      if (!lockedProject) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      const nodeCount = Number((await client.query(
        `SELECT COUNT(*)::int AS count FROM write_canvas_nodes WHERE project_id = $1 AND user_id = $2`,
        [projectId, req.session.userId],
      )).rows[0]?.count || 0);
      if (nodeCount >= WRITE_CANVAS_MAX_NODES_PER_PROJECT) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目节点数量已达到上限" });
      }
      const uploadMeta = { size: req.file.size, extractionError };
      const newAssetBytes = Buffer.byteLength(dataUrl, "utf8")
        + Buffer.byteLength(extractedText, "utf8")
        + Buffer.byteLength(JSON.stringify(uploadMeta), "utf8");
      const storedBytes = await getCanvasStoredBytes(client, req.session.userId);
      if (storedBytes + newAssetBytes > canvasUserStorageMaxBytes) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "画布资料存储额度已用完，请删除旧资料后重试" });
      }
      const assetRow = (await client.query(
        `INSERT INTO write_canvas_assets
           (user_id, project_id, type, title, content_text, extracted_text, file_name, mime_type, data_url, meta)
         VALUES ($1, $2, $3, $4, '', $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          req.session.userId,
          projectId,
          assetType,
          title,
          extractedText,
          req.file.originalname,
          req.file.mimetype,
          dataUrl,
          JSON.stringify(uploadMeta)
        ]
      )).rows[0];
      const nodeKind = isImage ? "asset_image" : "asset_file";
      const nodeResponse = await client.query(
        `INSERT INTO write_canvas_nodes
           (user_id, project_id, kind, node_role, content_type, origin, status, title, summary, asset_id, meta, x, y, width, height)
         VALUES ($1, $2, $3, 'material', $4, 'existing', $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
         RETURNING id`,
        [
          req.session.userId,
          projectId,
          nodeKind,
          isImage ? "image" : "file",
          extractionError ? "failed" : "ready",
          title,
          isImage ? "图片资料" : normalizeTextExcerpt(extractedText, 180),
          Number(assetRow.id),
          JSON.stringify(extractionError ? { extractionError } : {}),
          clampNumber(req.body?.x, 180, -100000, 100000),
          clampNumber(req.body?.y, 180, -100000, 100000),
          isImage ? 280 : 300,
          isImage ? 220 : 190
        ]
      );
      nodeId = Number(nodeResponse.rows[0].id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CanvasStorageLimitError) return res.status(413).json({ error: error.message });
      throw error;
    } finally {
      client.release();
    }
    const detail = await fetchCanvasProjectDetail(pool, req.session.userId, projectId);
    const node = detail?.nodes.find(item => item.id === nodeId);
    res.json({ node });
    } finally {
      releaseCanvasUploadConcurrency();
    }
  }));

  app.get("/api/write/canvas/assets/:id/original", requireAuth, asyncHandler(async (req, res) => {
    const assetId = Number(req.params.id);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) return res.status(400).json({ error: "invalid asset id" });
    const asset = (await pool.query(
      `SELECT file_name, mime_type, data_url
       FROM write_canvas_assets
       WHERE id = $1 AND user_id = $2`,
      [assetId, req.session.userId],
    )).rows[0];
    if (!asset?.data_url) return res.status(404).json({ error: "original asset not found" });
    const match = String(asset.data_url).match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.status(500).json({ error: "stored asset is invalid" });
    const bytes = Buffer.from(match[2], "base64");
    res.setHeader("Content-Type", asset.mime_type || match[1] || "application/octet-stream");
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(asset.file_name || "canvas-asset")}`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(bytes);
  }));

  app.get("/api/write/agent/templates", requireAuth, asyncHandler(async (req, res) => {
    const rows = (await pool.query(
      `SELECT id, name, model, system_prompt AS "systemPrompt", temperature, top_p AS "topP",
              max_tokens AS "maxTokens", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM write_agent_templates
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 100`,
      [req.session.userId]
    )).rows.map(mapAgentTemplateRow);
    res.json({ templates: rows });
  }));

  app.post("/api/write/agent/templates", requireAuth, asyncHandler(async (req, res) => {
    const defaults = getDefaultCanvasAgentConfig();
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 60) : "写作 Agent 模板";
    const templateModel = resolveAllowedCanvasAgentModel(req.body?.model, defaults.model);
    if (!templateModel) return res.status(400).json({ error: "该模型未被服务器允许" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const row = (await client.query(
        `INSERT INTO write_agent_templates (user_id, name, model, system_prompt, temperature, top_p, max_tokens)
         SELECT $1, $2, $3, $4, $5, $6, $7
         WHERE (SELECT COUNT(*) FROM write_agent_templates WHERE user_id = $1) < 100
         RETURNING id, name, model, system_prompt AS "systemPrompt", temperature, top_p AS "topP",
                   max_tokens AS "maxTokens", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          req.session.userId,
          name,
          templateModel,
          typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt.slice(0, 8000) : defaults.systemPrompt,
          clampNumber(req.body?.temperature, defaults.temperature, 0, 2),
          clampNumber(req.body?.topP, defaults.topP, 0.01, 1),
          Math.round(clampNumber(req.body?.maxTokens, defaults.maxTokens, 128, getCanvasAgentMaxOutputTokens()))
        ]
      )).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "Agent 模板数量已达到上限" });
      }
      await client.query("COMMIT");
      res.json({ template: mapAgentTemplateRow(row) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/api/write/canvas/runs/:id", requireAuth, asyncHandler(async (req, res) => {
    const runId = Number(req.params.id);
    if (!Number.isSafeInteger(runId) || runId <= 0) return res.status(400).json({ error: "invalid run id" });
    const row = (await pool.query(
      `SELECT * FROM write_canvas_agent_runs WHERE id = $1 AND user_id = $2`,
      [runId, req.session.userId],
    )).rows[0];
    if (!row) return res.status(404).json({ error: "run not found" });
    return res.json({ run: mapCanvasAgentRunRow(row) });
  }));

  app.get("/api/write/canvas/projects/:projectId/runs", requireAuth, asyncHandler(async (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return res.status(400).json({ error: "invalid project id" });
    const project = (await pool.query(`SELECT id FROM write_canvas_projects WHERE id = $1 AND user_id = $2`, [projectId, req.session.userId])).rows[0];
    if (!project) return res.status(404).json({ error: "project not found" });
    const runs = (await pool.query(
      `SELECT * FROM write_canvas_agent_runs WHERE project_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 100`,
      [projectId, req.session.userId],
    )).rows.map(mapCanvasAgentRunRow);
    return res.json({ runs });
  }));

  app.get("/api/write/canvas/agent-groups/:id/batches", requireAuth, asyncHandler(async (req, res) => {
    const groupId = Number(req.params.id);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) return res.status(400).json({ error: "invalid group id" });
    const group = (await pool.query(`SELECT id FROM write_canvas_agent_groups WHERE id = $1 AND user_id = $2`, [groupId, req.session.userId])).rows[0];
    if (!group) return res.status(404).json({ error: "group not found" });
    const batches = (await pool.query(
      `SELECT * FROM write_canvas_agent_batches WHERE group_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 100`,
      [groupId, req.session.userId],
    )).rows.map(mapCanvasAgentBatchRow);
    const runs = (await pool.query(
      `SELECT * FROM write_canvas_agent_runs WHERE group_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 300`,
      [groupId, req.session.userId],
    )).rows.map(mapCanvasAgentRunRow);
    return res.json({ batches, runs });
  }));

  app.get("/api/write/canvas/projects/:projectId/agent-groups", requireAuth, asyncHandler(async (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return res.status(400).json({ error: "invalid project id" });
    const project = (await pool.query(`SELECT id FROM write_canvas_projects WHERE id = $1 AND user_id = $2`, [projectId, req.session.userId])).rows[0];
    if (!project) return res.status(404).json({ error: "project not found" });
    const groups = (await pool.query(
      `SELECT g.*, COALESCE(jsonb_agg(jsonb_build_object(
          'id', m.id, 'projectId', m.project_id, 'name', m.name, 'model', m.model, 'systemPrompt', m.system_prompt,
          'temperature', m.temperature, 'topP', m.top_p, 'maxTokens', m.max_tokens,
          'createdAt', m.created_at, 'updatedAt', m.updated_at
        ) ORDER BY m.id) FILTER (WHERE m.id IS NOT NULL), '[]'::jsonb) AS members
       FROM write_canvas_agent_groups g
       LEFT JOIN write_canvas_agent_group_members m ON m.group_id = g.id AND m.user_id = g.user_id
       WHERE g.user_id = $1 AND g.project_id = $2
       GROUP BY g.id ORDER BY g.updated_at DESC`,
      [req.session.userId, projectId],
    )).rows.map(mapCanvasAgentGroupRow);
    return res.json({ groups });
  }));

  app.post("/api/write/canvas/projects/:projectId/agent-groups", requireAuth, asyncHandler(async (req, res) => {
    const projectId = Number(req.params.projectId);
    const defaults = getDefaultCanvasAgentConfig();
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
    const sharedPrompt = typeof req.body?.sharedPrompt === "string" ? req.body.sharedPrompt.trim().slice(0, 8000) : "";
    const rawMembers = req.body?.members;
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return res.status(400).json({ error: "invalid project id" });
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!Array.isArray(rawMembers) || rawMembers.length < 1 || rawMembers.length > WRITE_CANVAS_MAX_AGENT_GROUP_MEMBERS) {
      return res.status(400).json({ error: `members must contain 1-${WRITE_CANVAS_MAX_AGENT_GROUP_MEMBERS} items` });
    }
    const members = rawMembers.flatMap((item, index) => {
      if (!isPlainRecord(item) || typeof item.model !== "string" || !item.model.trim()) return [];
      const model = resolveAllowedCanvasAgentModel(item.model, "");
      if (!model) return [];
      return [{
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 120) : `Agent ${index + 1}`,
        model,
        systemPrompt: typeof item.systemPrompt === "string" ? item.systemPrompt.slice(0, 8000) : defaults.systemPrompt,
        temperature: clampNumber(item.temperature, defaults.temperature, 0, 2),
        topP: clampNumber(item.topP, defaults.topP, 0.01, 1),
        maxTokens: Math.round(clampNumber(item.maxTokens, defaults.maxTokens, 128, getCanvasAgentMaxOutputTokens())),
      }];
    });
    if (members.length !== rawMembers.length) return res.status(400).json({ error: "every member must provide an allowed model" });

    const client = await pool.connect();
    let groupId: number;
    let nodeId: number;
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const project = (await client.query(`SELECT id FROM write_canvas_projects WHERE id = $1 AND user_id = $2 FOR UPDATE`, [projectId, req.session.userId])).rows[0];
      if (!project) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      const nodeCount = Number((await client.query(
        `SELECT COUNT(*)::int AS count FROM write_canvas_nodes WHERE user_id = $1 AND project_id = $2`,
        [req.session.userId, projectId],
      )).rows[0]?.count || 0);
      if (nodeCount >= WRITE_CANVAS_MAX_NODES_PER_PROJECT) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目节点数量已达到上限" });
      }
      const configSnapshot = { sharedPrompt, members };
      await assertCanvasStorageQuota(client, req.session.userId, estimateCanvasStorageBytes({ group: { name, sharedPrompt, configSnapshot }, members, node: { name, sharedPrompt } }));
      groupId = Number((await client.query(`SELECT nextval(pg_get_serial_sequence('write_canvas_agent_groups', 'id')) AS id`)).rows[0].id);
      const node = (await client.query(
        `INSERT INTO write_canvas_nodes
           (user_id, project_id, kind, node_role, content_type, origin, status, business_ref, title, summary, meta, x, y, width, height)
         VALUES ($1, $2, 'result', 'task', 'agent_group', 'manual', 'ready', $3, $4, $5, $6::jsonb, $7, $8, 340, 220)
         RETURNING id`,
        [req.session.userId, projectId, String(groupId), name, sharedPrompt.slice(0, 500), JSON.stringify({ groupId }), clampNumber(req.body?.x, 360, -100000, 100000), clampNumber(req.body?.y, 180, -100000, 100000)],
      )).rows[0];
      nodeId = Number(node.id);
      await client.query(
        `INSERT INTO write_canvas_agent_groups (id, user_id, project_id, node_id, name, shared_prompt, config_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [groupId, req.session.userId, projectId, nodeId, name, sharedPrompt, JSON.stringify(configSnapshot)],
      );
      for (const member of members) {
        await client.query(
          `INSERT INTO write_canvas_agent_group_members (user_id, project_id, group_id, name, model, system_prompt, temperature, top_p, max_tokens)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [req.session.userId, projectId, groupId, member.name, member.model, member.systemPrompt, member.temperature, member.topP, member.maxTokens],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CanvasStorageLimitError) return res.status(413).json({ error: error.message });
      throw error;
    } finally {
      client.release();
    }
    const group = (await pool.query(
      `SELECT g.*, COALESCE(jsonb_agg(jsonb_build_object(
          'id', m.id, 'projectId', m.project_id, 'name', m.name, 'model', m.model, 'systemPrompt', m.system_prompt,
          'temperature', m.temperature, 'topP', m.top_p, 'maxTokens', m.max_tokens,
          'createdAt', m.created_at, 'updatedAt', m.updated_at
        ) ORDER BY m.id) FILTER (WHERE m.id IS NOT NULL), '[]'::jsonb) AS members
       FROM write_canvas_agent_groups g LEFT JOIN write_canvas_agent_group_members m ON m.group_id = g.id AND m.user_id = g.user_id
       WHERE g.id = $1 AND g.user_id = $2 GROUP BY g.id`,
      [groupId, req.session.userId],
    )).rows[0];
    return res.json({ group: mapCanvasAgentGroupRow(group), nodeId });
  }));

  app.post("/api/write/canvas/nodes/:id/actions/stream", requireAuth, paidOperationLimiter, paidConcurrencyMiddleware, asyncHandler(async (req, res) => {
    const nodeId = Number(req.params.id);
    const action = normalizeCanvasQuickAction(req.body?.action);
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return res.status(400).json({ error: "invalid node id" });
    if (!action) return res.status(400).json({ error: "unsupported canvas action" });
    const requestAbortController = new AbortController();
    const abortRequest = () => requestAbortController.abort(new Error("Client disconnected"));
    req.once("aborted", abortRequest);
    res.once("close", () => { if (!res.writableFinished) abortRequest(); });
    requestAbortController.signal.throwIfAborted();
    const source = (await pool.query(`SELECT id, project_id, x, y FROM write_canvas_nodes WHERE id = $1 AND user_id = $2`, [nodeId, req.session.userId])).rows[0];
    if (!source) return res.status(404).json({ error: "node not found" });
    requestAbortController.signal.throwIfAborted();
    const context = await resolveCanvasOwnedNodeContext(pool, req.session.userId, Number(source.project_id), nodeId);
    if (!context) return res.status(404).json({ error: "node content not found" });
    const defaults = getDefaultCanvasAgentConfig();
    if (!getOpenAIWriteAgentConfig() || !isAllowedCanvasAgentModel(defaults.model)) return res.status(500).json({ error: "Writing agent model is not configured or allowed" });
    const prompt = getCanvasQuickActionPrompt(action);
    const systemPrompt = `${defaults.systemPrompt}\n\n${prompt}`;
    try {
      assertCanvasAggregateContextWithinLimit([context], prompt, systemPrompt);
    } catch (error) {
      if (error instanceof CanvasInputLimitError) return res.status(413).json({ error: error.message });
      throw error;
    }
    const estimatedInputTokens = estimateCanvasInputTokens([context], prompt, systemPrompt);
    const contextSnapshot = { nodes: [{ nodeId: context.nodeId, kind: context.kind, title: context.title, text: context.text }] };
    const configSnapshot = { model: defaults.model, systemPrompt: defaults.systemPrompt, temperature: defaults.temperature, topP: defaults.topP, maxTokens: defaults.maxTokens, estimatedInputTokens };
    const runClient = await pool.connect();
    let runId: number;
    try {
      await runClient.query("BEGIN");
      await lockCanvasUser(runClient, req.session.userId);
      requestAbortController.signal.throwIfAborted();
      await assertCanvasStorageQuota(runClient, req.session.userId, estimateCanvasStorageBytes({ action, contextSnapshot, configSnapshot }));
      requestAbortController.signal.throwIfAborted();
      const run = (await runClient.query(
        `INSERT INTO write_canvas_agent_runs (user_id, project_id, source_node_id, action, context_snapshot, config_snapshot)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb) RETURNING id`,
        [req.session.userId, Number(source.project_id), nodeId, action, JSON.stringify(contextSnapshot), JSON.stringify(configSnapshot)],
      )).rows[0];
      runId = Number(run.id);
      await runClient.query("COMMIT");
    } catch (error) {
      await runClient.query("ROLLBACK");
      if (error instanceof CanvasStorageLimitError) return res.status(413).json({ error: error.message });
      throw error;
    } finally {
      runClient.release();
    }
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (type: string, data: unknown) => { res.write(`event: ${type}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); };
    let reservedBudgetTokens = 0;
    let providerStarted = false;
    try {
      await pool.query(`UPDATE write_canvas_agent_runs SET status = 'running', started_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2`, [runId, req.session.userId]);
      send("partial_status", { runId, message: "已读取选中节点" });
      requestAbortController.signal.throwIfAborted();
      const reservation = await reserveCanvasAgentRunBudget(req.session.userId, runId, defaults.maxTokens, estimatedInputTokens);
      if (!reservation) throw new Error("今日 AI 使用额度已达到上限，请稍后再试");
      reservedBudgetTokens = reservation.reservedTokens;
      send("partial_status", { runId, message: "正在生成" });
      requestAbortController.signal.throwIfAborted();
      await markCanvasAgentRunProviderStarted(req.session.userId, runId);
      providerStarted = true;
      const completion = await requestCanvasAgentCompletion({ model: defaults.model, systemPrompt, message: prompt, contexts: [context], previousMessages: [], temperature: defaults.temperature, topP: defaults.topP, maxTokens: defaults.maxTokens });
      const extractionItems = isCanvasExtractionAction(action) ? parseCanvasExtractionItems(completion.content) : [];
      const outputs = isCanvasExtractionAction(action)
        ? (extractionItems.length ? extractionItems : [{ title: "提取内容", content: completion.content.slice(0, 12000) }]).map((item, index) => ({ title: item.title, content: item.content, role: "insight" as const, origin: "extracted" as const, status: "pending_review" as const, relation: "derived_from" as const, x: Number(source.x) + 420, y: Number(source.y) + index * 250, meta: { runId, action } }))
        : [{ title: action === "summarize" ? "AI 摘要" : "AI 大纲", content: completion.content, role: "insight" as const, origin: "generated" as const, status: "pending_review" as const, relation: "generated" as const, x: Number(source.x) + 420, y: Number(source.y), meta: { runId, action } }];
      const client = await pool.connect();
      let outputNodeIds: number[];
      try {
        await client.query("BEGIN");
        await lockCanvasUser(client, req.session.userId);
        outputNodeIds = await createCanvasGeneratedNodes(client, req.session.userId, Number(source.project_id), nodeId, outputs, Buffer.byteLength(completion.content, "utf8"));
        await client.query(`UPDATE write_canvas_agent_runs SET status = 'completed', output = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2 AND user_id = $3`, [completion.content, runId, req.session.userId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      send("final", { runId, output: completion.content, outputNodeIds });
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "画布 AI 操作失败";
      const runStatus = requestAbortController.signal.aborted ? "cancelled" : "failed";
      await failStandaloneCanvasAgentRun(
        req.session.userId,
        runId,
        runStatus,
        message.slice(0, 2000),
      ).catch(refundError => {
        logger.error({ err: refundError, module: "canvas-quick-ai", runId, providerStarted, reservedBudgetTokens }, "Failed to finalize canvas quick AI budget");
      });
      if (!res.destroyed && !res.writableEnded) { send("error", { runId, message }); res.end(); }
    } finally {
      if (typeof res.locals.releasePaidConcurrency === "function") res.locals.releasePaidConcurrency();
    }
  }));

  app.post("/api/write/canvas/agent-groups/:id/batches/stream", requireAuth, paidOperationLimiter, paidConcurrencyMiddleware, asyncHandler(async (req, res) => {
    const groupId = Number(req.params.id);
    const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, WRITE_AGENT_MAX_MESSAGE_LENGTH) : "";
    if (!Number.isSafeInteger(groupId) || groupId <= 0) return res.status(400).json({ error: "invalid group id" });
    if (!message) return res.status(400).json({ error: "message is required" });
    const rawContextNodeIds = req.body?.contextNodeIds === undefined ? [] : req.body.contextNodeIds;
    if (!Array.isArray(rawContextNodeIds) || rawContextNodeIds.length > WRITE_CANVAS_MAX_CONTEXT_ITEMS) return res.status(400).json({ error: "invalid contextNodeIds" });
    const contextNodeIds = Array.from(new Set(rawContextNodeIds.map(Number)));
    if (contextNodeIds.some(id => !Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ error: "invalid contextNodeIds" });
    const requestAbortController = new AbortController();
    const abortRequest = () => requestAbortController.abort(new Error("Client disconnected"));
    req.once("aborted", abortRequest);
    res.once("close", () => { if (!res.writableFinished) abortRequest(); });
    requestAbortController.signal.throwIfAborted();
    const group = (await pool.query(
      `SELECT g.*, n.x AS node_x, n.y AS node_y
       FROM write_canvas_agent_groups g
       JOIN write_canvas_nodes n ON n.id = g.node_id AND n.user_id = g.user_id AND n.project_id = g.project_id
       WHERE g.id = $1 AND g.user_id = $2`,
      [groupId, req.session.userId],
    )).rows[0];
    if (!group) return res.status(404).json({ error: "group not found" });
    const members = (await pool.query(
      `SELECT * FROM write_canvas_agent_group_members WHERE group_id = $1 AND user_id = $2 AND project_id = $3 ORDER BY id LIMIT $4`,
      [groupId, req.session.userId, Number(group.project_id), WRITE_CANVAS_MAX_AGENT_GROUP_MEMBERS],
    )).rows as CanvasAgentGroupMemberRecord[];
    if (members.length < 1 || members.length > WRITE_CANVAS_MAX_AGENT_GROUP_MEMBERS || members.some(member => !isAllowedCanvasAgentModel(member.model))) return res.status(400).json({ error: "group member configuration is invalid" });
    if (!getOpenAIWriteAgentConfig()) return res.status(500).json({ error: "Writing agent model is not configured" });
    requestAbortController.signal.throwIfAborted();
    const contextNodes = contextNodeIds.length === 0 ? [] : (await pool.query(
      `SELECT id, kind, node_role, content_type, status
       FROM write_canvas_nodes
       WHERE user_id = $1 AND project_id = $2 AND id = ANY($3::bigint[])`,
      [req.session.userId, Number(group.project_id), contextNodeIds],
    )).rows;
    const invalidContextNode = contextNodes.find(node => (
      node.kind === "agent" || node.node_role === "task" || node.status === "rejected"
    ));
    if (contextNodes.length !== contextNodeIds.length || invalidContextNode) {
      return res.status(400).json({ error: "contextNodeIds must reference active material, insight or document nodes in this project" });
    }
    const largestSystemPromptChars = members.reduce((largest, member) => Math.max(
      largest,
      [member.system_prompt, group.shared_prompt].filter(Boolean).join("\n\n").length,
    ), 0);
    const contextTextBudget = createCanvasContextPlainTextBudget(Math.max(
      0,
      WRITE_CANVAS_MAX_AGGREGATE_CONTEXT_CHARS - message.length - largestSystemPromptChars,
    ));
    const contexts: Array<CanvasContextItem | null> = [];
    for (const nodeId of contextNodeIds) {
      contexts.push(await resolveCanvasOwnedNodeContext(
        pool,
        req.session.userId,
        Number(group.project_id),
        nodeId,
        contextTextBudget,
      ));
    }
    if (contexts.some(context => !context)) return res.status(404).json({ error: "context node not found in this project" });
    const resolvedContexts = contexts.filter((context): context is CanvasContextItem => Boolean(context));
    try {
      for (const member of members) {
        assertCanvasAggregateContextWithinLimit(resolvedContexts, message, [member.system_prompt, group.shared_prompt].filter(Boolean).join("\n\n"));
      }
    } catch (error) {
      if (error instanceof CanvasInputLimitError) return res.status(413).json({ error: error.message });
      throw error;
    }
    const estimatedInputTokensByMember = new Map(members.map(member => [
      Number(member.id),
      estimateCanvasInputTokens(resolvedContexts, message, [member.system_prompt, group.shared_prompt].filter(Boolean).join("\n\n")),
    ]));
    const contextSnapshot = { nodes: resolvedContexts.map(context => ({ nodeId: context.nodeId, kind: context.kind, title: context.title, text: context.text })) };
    const configSnapshot = { sharedPrompt: group.shared_prompt, members: members.map(member => ({ id: member.id, name: member.name, model: member.model, systemPrompt: member.system_prompt, temperature: member.temperature, topP: member.top_p, maxTokens: member.max_tokens, estimatedInputTokens: estimatedInputTokensByMember.get(Number(member.id)) })) };
    const client = await pool.connect();
    let batchId: number;
    const runs: Array<{ id: number; member: CanvasAgentGroupMemberRecord }> = [];
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const lockedGroup = (await client.query(
        `SELECT id, project_id, node_id, current_batch_id FROM write_canvas_agent_groups WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [groupId, req.session.userId],
      )).rows[0];
      if (!lockedGroup) { await client.query("ROLLBACK"); return res.status(404).json({ error: "group not found" }); }
      const activeBatch = (await client.query(
        `SELECT id, started_at FROM write_canvas_agent_batches
         WHERE group_id = $1 AND user_id = $2 AND status = 'running'
         ORDER BY (id = $3) DESC NULLS LAST, started_at DESC NULLS LAST, id DESC LIMIT 1 FOR UPDATE`,
        [groupId, req.session.userId, lockedGroup.current_batch_id],
      )).rows[0];
      if (activeBatch && Date.now() - new Date(activeBatch.started_at).getTime() <= WRITE_CANVAS_AGENT_BATCH_STALE_MS) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "已有批次正在运行，请等待完成后再试" });
      }
      if (activeBatch) {
        const staleError = "运行超时，已由后续请求恢复";
        const staleRuns = (await client.query(
          `SELECT id, reserved_tokens, reservation_date::text AS reservation_date, provider_started
           FROM write_canvas_agent_runs
           WHERE batch_id = $1 AND user_id = $2 AND status IN ('queued','running')
           FOR UPDATE`,
          [Number(activeBatch.id), req.session.userId],
        )).rows;
        for (const run of staleRuns) {
          if (run.provider_started || Number(run.reserved_tokens) <= 0) continue;
          await releaseDailyAiBudget(
            req.session.userId,
            Number(run.reserved_tokens),
            normalizeAiBudgetDate(run.reservation_date),
            client,
          );
        }
        await client.query(
          `UPDATE write_canvas_agent_batches
           SET status = CASE
             WHEN EXISTS (
               SELECT 1 FROM write_canvas_agent_runs
               WHERE batch_id = $2 AND user_id = $3 AND status = 'completed'
             ) THEN CASE WHEN EXISTS (
               SELECT 1 FROM write_canvas_agent_runs
               WHERE batch_id = $2 AND user_id = $3 AND status <> 'completed'
             ) THEN 'partial' ELSE 'completed' END
             ELSE 'failed' END,
             error = CASE WHEN NOT EXISTS (
               SELECT 1 FROM write_canvas_agent_runs
               WHERE batch_id = $2 AND user_id = $3 AND status <> 'completed'
             ) THEN NULL ELSE $1 END,
             completed_at = NOW(), updated_at = NOW()
           WHERE id = $2 AND user_id = $3 AND status = 'running'`,
          [staleError, Number(activeBatch.id), req.session.userId],
        );
        await client.query(
          `UPDATE write_canvas_agent_runs
           SET status = 'failed', error = $1,
               reserved_tokens = CASE WHEN provider_started THEN reserved_tokens ELSE 0 END,
               completed_at = NOW(), updated_at = NOW()
           WHERE batch_id = $2 AND user_id = $3 AND status IN ('queued','running')`,
          [staleError, Number(activeBatch.id), req.session.userId],
        );
      }
      requestAbortController.signal.throwIfAborted();
      const edgeCounts = (await client.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE target_node_id = $3 AND relation = 'context')::int AS current_group_context
         FROM write_canvas_edges WHERE user_id = $1 AND project_id = $2`,
        [req.session.userId, Number(group.project_id), Number(group.node_id)],
      )).rows[0];
      const additionalEdges = Math.max(0, contextNodeIds.length - Number(edgeCounts?.current_group_context || 0));
      if (Number(edgeCounts?.total || 0) + additionalEdges > WRITE_CANVAS_MAX_EDGES_PER_PROJECT) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目连线数量已达到上限" });
      }
      const persistenceEstimate = estimateCanvasStorageBytes({ batch: { message, contextNodeIds, contextSnapshot, configSnapshot }, runs: members.map(member => ({ memberId: member.id, contextSnapshot, configSnapshot: configSnapshot.members.find(item => Number(item.id) === Number(member.id)) })) })
        + additionalEdges * estimateCanvasStorageBytes({ relation: "context" });
      await assertCanvasStorageQuota(client, req.session.userId, persistenceEstimate);
      requestAbortController.signal.throwIfAborted();
      const batch = (await client.query(
        `INSERT INTO write_canvas_agent_batches (user_id, project_id, group_id, message, context_node_ids, status, context_snapshot, config_snapshot, started_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'running', $6::jsonb, $7::jsonb, NOW()) RETURNING id`,
        [req.session.userId, Number(group.project_id), groupId, message, JSON.stringify(contextNodeIds), JSON.stringify(contextSnapshot), JSON.stringify(configSnapshot)],
      )).rows[0];
      batchId = Number(batch.id);
      await client.query(
        `DELETE FROM write_canvas_edges WHERE user_id = $1 AND project_id = $2 AND target_node_id = $3 AND relation = 'context'`,
        [req.session.userId, Number(group.project_id), Number(group.node_id)],
      );
      for (const contextNodeId of contextNodeIds) {
        await client.query(
          `INSERT INTO write_canvas_edges (user_id, project_id, source_node_id, target_node_id, relation)
           VALUES ($1, $2, $3, $4, 'context')
           ON CONFLICT (project_id, source_node_id, target_node_id, relation) DO NOTHING`,
          [req.session.userId, Number(group.project_id), contextNodeId, Number(group.node_id)],
        );
      }
      await client.query(
        `UPDATE write_canvas_agent_groups SET status = 'running', current_batch_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`,
        [batchId, groupId, req.session.userId],
      );
      for (const member of members) {
        const run = (await client.query(
          `INSERT INTO write_canvas_agent_runs (user_id, project_id, group_id, group_member_id, batch_id, action, context_snapshot, config_snapshot)
           VALUES ($1, $2, $3, $4, $5, 'group_batch', $6::jsonb, $7::jsonb) RETURNING id`,
          [req.session.userId, Number(group.project_id), groupId, Number(member.id), batchId, JSON.stringify(contextSnapshot), JSON.stringify({ sharedPrompt: group.shared_prompt, member: configSnapshot.members.find((item: { id: number }) => item.id === Number(member.id)) })],
        )).rows[0];
        runs.push({ id: Number(run.id), member });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CanvasStorageLimitError) return res.status(413).json({ error: error.message });
      throw error;
    } finally {
      client.release();
    }
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (type: string, data: unknown) => { res.write(`event: ${type}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); };
    const memberRuns = runs.slice(0, WRITE_CANVAS_MAX_AGENT_GROUP_MEMBERS).map(async ({ id: runId, member }, index) => {
      let reservedBudgetTokens = 0;
      let providerStarted = false;
      send("member_start", { batchId, runId, memberId: Number(member.id), name: member.name });
      try {
        const startedRun = await pool.query(
          `UPDATE write_canvas_agent_runs r
           SET status = 'running', started_at = NOW(), updated_at = NOW()
           FROM write_canvas_agent_batches b
           JOIN write_canvas_agent_groups g
             ON g.id = b.group_id AND g.user_id = b.user_id AND g.project_id = b.project_id
           WHERE r.id = $1 AND r.batch_id = $2 AND r.user_id = $3 AND r.status = 'queued'
             AND b.id = r.batch_id AND b.status = 'running' AND g.current_batch_id = b.id
           RETURNING r.id`,
          [runId, batchId, req.session.userId],
        );
        if (startedRun.rowCount !== 1) throw new CanvasAgentBatchLeaseLostError("Agent batch was superseded before provider execution");
        requestAbortController.signal.throwIfAborted();
        const estimatedInputTokens = estimatedInputTokensByMember.get(Number(member.id)) || 0;
        const reservation = await reserveCanvasAgentRunBudget(req.session.userId, runId, Number(member.max_tokens), estimatedInputTokens);
        if (!reservation) throw new Error("今日 AI 使用额度已达到上限，请稍后再试");
        reservedBudgetTokens = reservation.reservedTokens;
        requestAbortController.signal.throwIfAborted();
        await markCanvasAgentRunProviderStarted(req.session.userId, runId);
        providerStarted = true;
        const completion = await requestCanvasAgentCompletion({ model: member.model, systemPrompt: [member.system_prompt || getDefaultCanvasAgentConfig().systemPrompt, group.shared_prompt].filter(Boolean).join("\n\n"), message, contexts: resolvedContexts, previousMessages: [], temperature: Number(member.temperature), topP: Number(member.top_p), maxTokens: Number(member.max_tokens) });
        const outputClient = await pool.connect();
        let outputNodeIds: number[];
        try {
          await outputClient.query("BEGIN");
          await lockCanvasUser(outputClient, req.session.userId);
          await assertCurrentCanvasAgentBatchLease(outputClient, req.session.userId, groupId, batchId);
          const lineage = { sourceNodeId: Number(group.node_id), relation: "generated" as const };
          outputNodeIds = await createCanvasGeneratedNodes(outputClient, req.session.userId, Number(group.project_id), lineage.sourceNodeId, [{ title: `${member.name} 输出`, content: completion.content, role: "insight", origin: "generated", status: "pending_review", relation: lineage.relation, x: Number(group.node_x) + 400 + index * 360, y: Number(group.node_y), meta: { batchId, runId, groupId, memberId: Number(member.id) } }], Buffer.byteLength(completion.content, "utf8"));
          const completedRun = await outputClient.query(
            `UPDATE write_canvas_agent_runs
             SET status = 'completed', output = $1, completed_at = NOW(), updated_at = NOW()
             WHERE id = $2 AND batch_id = $3 AND user_id = $4 AND status = 'running'`,
            [completion.content, runId, batchId, req.session.userId],
          );
          if (completedRun.rowCount !== 1) throw new CanvasAgentBatchLeaseLostError("Agent run was superseded before output persistence");
          await outputClient.query("COMMIT");
        } catch (error) {
          await outputClient.query("ROLLBACK");
          throw error;
        } finally {
          outputClient.release();
        }
        send("member_final", { batchId, runId, memberId: Number(member.id), output: completion.content, outputNodeIds });
        return { runId, memberId: Number(member.id), status: "completed", output: completion.content, outputNodeIds };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Agent 执行失败";
        const runStatus = requestAbortController.signal.aborted ? "cancelled" : "failed";
        await failCanvasAgentRunIfLeaseCurrent({ userId: req.session.userId, groupId, batchId, runId, status: runStatus, error: errorMessage.slice(0, 2000) }).catch(refundError => {
          logger.error({ err: refundError, module: "canvas-agent-group", batchId, runId, providerStarted, reservedBudgetTokens }, "Failed to finalize canvas Agent group budget");
          return false;
        });
        if (!res.destroyed && !res.writableEnded) send("member_error", { batchId, runId, memberId: Number(member.id), message: errorMessage });
        throw error;
      }
    });
    try {
      const settled = await Promise.allSettled(memberRuns);
      const successes = settled.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      const failures = settled.flatMap(result => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
      const status = requestAbortController.signal.aborted && successes.length === 0
        ? "cancelled"
        : successes.length > 0 && failures.length > 0
          ? "partial"
          : successes.length > 0 ? "completed" : "failed";
      const persistedRuns = successes.map(({ output: _output, ...result }) => result);
      const finalized = await finishCanvasAgentBatch({ userId: req.session.userId, batchId, groupId, status, output: { runs: persistedRuns }, error: failures.join("; ").slice(0, 4000) || null });
      if (!finalized) {
        if (!res.destroyed && !res.writableEnded) { send("error", { batchId, message: "批次已被新的运行替代" }); res.end(); }
        return;
      }
      if (!res.destroyed && !res.writableEnded) { send("final", { batchId, status, successes, failures }); res.end(); }
    } finally {
      if (typeof res.locals.releasePaidConcurrency === "function") res.locals.releasePaidConcurrency();
    }
  }));

  app.post("/api/write/canvas/agents/:id/chat/stream", requireAuth, paidOperationLimiter, paidConcurrencyMiddleware, canvasAgentConcurrencyMiddleware, asyncHandler(async (req, res) => {
    const agentId = Number(req.params.id);
    if (!Number.isFinite(agentId)) {
      return res.status(400).json({ error: "invalid agent id" });
    }
    const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, WRITE_AGENT_MAX_MESSAGE_LENGTH) : "";
    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }
    const agentRow = await getCanvasAgentNode(pool, req.session.userId, agentId);
    if (!agentRow) {
      return res.status(404).json({ error: "agent not found" });
    }
    if (!getOpenAIWriteAgentConfig()) {
      return res.status(500).json({ error: "Writing agent model is not configured: set OPENAI_API_KEY/OPENAI_MODEL or AI_API_KEY/AI_BASE_URL/AI_MODEL" });
    }
    if (!isAllowedCanvasAgentModel(agentRow.model)) {
      return res.status(400).json({ error: "该 Agent 使用的模型未被服务器允许，请先更新模型设置" });
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (type: string, data: unknown) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const runId = randomUUID();
    let userMessageId: number | null = null;
    let turnPersisted = false;
    let providerStarted = false;
    const requestAbortController = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) requestAbortController.abort(new Error("Client disconnected"));
    });
    try {
      send("partial_status", { runId, message: "读取画布连线上下文" });
      const previousMessages = (await pool.query(
        `SELECT role, content
         FROM write_canvas_agent_messages
         WHERE user_id = $1 AND agent_id = $2
           AND COALESCE(meta->>'status', 'completed') = 'completed'
         ORDER BY created_at DESC
         LIMIT 10`,
        [req.session.userId, agentId]
      )).rows.reverse().filter(row => row.role === "user" || row.role === "assistant");
      const contexts = await resolveCanvasContextItems(pool, req.session.userId, Number(agentRow.node_id), Number(agentRow.project_id));
      assertCanvasAggregateContextWithinLimit(contexts, message, agentRow.system_prompt, previousMessages);
      const estimatedInputTokens = estimateCanvasInputTokens(contexts, message, agentRow.system_prompt, previousMessages);
      const reservedBudgetTokens = getDailyAiBudgetReservationTokens(Number(agentRow.max_tokens), estimatedInputTokens);
      const inputClient = await pool.connect();
      try {
        await inputClient.query("BEGIN");
        await lockCanvasUser(inputClient, req.session.userId);
        const reservation = await reserveDailyAiBudget(
          req.session.userId,
          Number(agentRow.max_tokens),
          estimatedInputTokens,
          inputClient,
        );
        if (!reservation) throw new Error("今日 AI 使用额度已达到上限，请稍后再试");
        const inputMeta = {
          runId,
          status: "pending",
          providerStarted: false,
          budgetReservedTokens: reservedBudgetTokens,
          budgetReservationDate: normalizeAiBudgetDate(reservation.usage_date),
        };
        await assertCanvasStorageQuota(inputClient, req.session.userId, estimateCanvasStorageBytes({ message, meta: inputMeta }));
        const userMessage = (await inputClient.query(
          `INSERT INTO write_canvas_agent_messages (user_id, agent_id, role, content, meta)
           VALUES ($1, $2, 'user', $3, $4)
           RETURNING id`,
          [req.session.userId, agentId, message, JSON.stringify(inputMeta)],
        )).rows[0];
        userMessageId = Number(userMessage.id);
        await inputClient.query("COMMIT");
      } catch (error) {
        await inputClient.query("ROLLBACK");
        throw error;
      } finally {
        inputClient.release();
      }
      send("partial_status", { runId, message: `已连接 ${contexts.length} 个上下文节点` });
      requestAbortController.signal.throwIfAborted();
      const providerStart = await pool.query(
        `UPDATE write_canvas_agent_messages
         SET meta = meta || $1::jsonb
         WHERE id = $2 AND user_id = $3 AND agent_id = $4 AND meta->>'status' = 'pending'
         RETURNING id`,
        [JSON.stringify({ providerStarted: true }), userMessageId, req.session.userId, agentId],
      );
      if (providerStart.rowCount !== 1) throw new Error("Agent turn is no longer active");
      providerStarted = true;
      const completion = await requestCanvasAgentCompletion({
        model: agentRow.model,
        systemPrompt: agentRow.system_prompt,
        message,
        contexts,
        previousMessages,
        temperature: Number(agentRow.temperature),
        topP: Number(agentRow.top_p),
        maxTokens: Number(agentRow.max_tokens),
      });
      const outputClient = await pool.connect();
      let assistantRow: Record<string, unknown> | null = null;
      try {
        await outputClient.query("BEGIN");
        await lockCanvasUser(outputClient, req.session.userId);
        const assistantMeta = {
          runId,
          status: "completed",
          model: completion.model,
          provider: completion.provider,
          contextNodeIds: contexts.map(item => item.nodeId),
          usedImages: completion.usedImages,
        };
        await assertCanvasStorageQuota(outputClient, req.session.userId, estimateCanvasStorageBytes({ content: completion.content, meta: assistantMeta }));
        await outputClient.query(
          `UPDATE write_canvas_agent_messages
           SET meta = meta || $1::jsonb
           WHERE id = $2 AND user_id = $3 AND agent_id = $4`,
          [JSON.stringify({ status: "completed" }), userMessageId, req.session.userId, agentId],
        );
        assistantRow = (await outputClient.query(
          `INSERT INTO write_canvas_agent_messages (user_id, agent_id, role, content, meta)
           VALUES ($1, $2, 'assistant', $3, $4)
           RETURNING id, agent_id AS "agentId", role, content, meta, created_at AS "createdAt"`,
          [req.session.userId, agentId, completion.content, JSON.stringify(assistantMeta)],
        )).rows[0];
        await outputClient.query(
          `DELETE FROM write_canvas_agent_messages
           WHERE user_id = $1 AND agent_id = $2 AND id IN (
             SELECT id FROM write_canvas_agent_messages
             WHERE user_id = $1 AND agent_id = $2
             ORDER BY created_at DESC, id DESC
             OFFSET $3
           )`,
          [req.session.userId, agentId, WRITE_CANVAS_MAX_MESSAGES_PER_AGENT],
        );
        await outputClient.query("COMMIT");
        turnPersisted = true;
      } catch (error) {
        await outputClient.query("ROLLBACK");
        throw error;
      } finally {
        outputClient.release();
      }
      if (!assistantRow) throw new Error("Assistant message persistence failed");
      send("final", {
        runId,
        message: mapCanvasMessageRow(assistantRow),
        context: {
          nodes: contexts.map(item => ({ nodeId: item.nodeId, kind: item.kind, title: item.title })),
          usedImages: completion.usedImages
        }
      });
      res.end();
    } catch (error) {
      if (userMessageId && !turnPersisted) {
        await cancelPendingCanvasAgentMessage(req.session.userId, agentId, userMessageId)
          .catch(refundError => logger.error({ err: refundError, module: "canvas-agent", runId, providerStarted }, "Failed to finalize incomplete canvas turn budget"));
      }
      logger.error({ err: error, module: "canvas-agent", runId, agentId, userId: req.session.userId }, "Canvas agent failed");
      if (!res.destroyed && !res.writableEnded) {
        send("error", {
          runId,
          message: error instanceof Error && error.message ? error.message : "画布 Agent 暂时不可用"
        });
        res.end();
      }
    } finally {
      if (typeof res.locals.releaseCanvasAgentConcurrency === "function") res.locals.releaseCanvasAgentConcurrency();
      if (typeof res.locals.releasePaidConcurrency === "function") res.locals.releasePaidConcurrency();
    }
  }));

  app.post("/api/write/canvas/agents/:id/save-result", requireAuth, asyncHandler(async (req, res) => {
    const agentId = Number(req.params.id);
    if (!Number.isFinite(agentId)) return res.status(400).json({ error: "invalid agent id" });
    const agentRow = await getCanvasAgentNode(pool, req.session.userId, agentId);
    if (!agentRow) return res.status(404).json({ error: "agent not found" });
    let content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    const messageId = Number(req.body?.messageId);
    if (!content && Number.isFinite(messageId)) {
      const messageRow = (await pool.query(
        `SELECT content FROM write_canvas_agent_messages
         WHERE id = $1 AND agent_id = $2 AND user_id = $3 AND role = 'assistant'
           AND COALESCE(meta->>'status', 'completed') = 'completed'`,
        [messageId, agentId, req.session.userId]
      )).rows[0];
      content = messageRow?.content || "";
    }
    if (!content) return res.status(400).json({ error: "content or messageId is required" });
    content = content.slice(0, WRITE_AGENT_MAX_MESSAGE_LENGTH);
    const title = typeof req.body?.title === "string" && req.body.title.trim()
      ? req.body.title.trim().slice(0, 120)
      : "Agent 输出";
    const client = await pool.connect();
    let nodeId: number;
    let edgeRow: Record<string, unknown>;
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const lockedProject = (await client.query(
        `SELECT id FROM write_canvas_projects WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [Number(agentRow.project_id), req.session.userId],
      )).rows[0];
      if (!lockedProject) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      const lockedAgent = (await client.query(
        `SELECT n.id AS node_id, n.project_id
         FROM write_agent_instances ai
         JOIN write_canvas_nodes n ON n.agent_id = ai.id AND n.user_id = ai.user_id
         WHERE ai.id = $1 AND ai.user_id = $2 AND n.kind = 'agent'
         FOR SHARE OF ai, n`,
        [agentId, req.session.userId]
      )).rows[0];
      if (!lockedAgent) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "agent not found" });
      }
      const nodeCount = Number((await client.query(
        `SELECT COUNT(*)::int AS count FROM write_canvas_nodes WHERE project_id = $1 AND user_id = $2`,
        [lockedAgent.project_id, req.session.userId],
      )).rows[0]?.count || 0);
      if (nodeCount >= WRITE_CANVAS_MAX_NODES_PER_PROJECT) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目节点数量已达到上限" });
      }
      await assertCanvasEdgeCapacity(client, req.session.userId, Number(lockedAgent.project_id));
      const newAssetBytes = Buffer.byteLength(content, "utf8") * 2;
      const storedBytes = await getCanvasStoredBytes(client, req.session.userId);
      if (storedBytes + newAssetBytes > canvasUserStorageMaxBytes) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "画布资料存储额度已用完，请删除旧资料后重试" });
      }
      const assetRow = (await client.query(
        `INSERT INTO write_canvas_assets (user_id, project_id, type, title, content_text, extracted_text, meta)
         VALUES ($1, $2, 'text', $3, $4, $4, $5)
         RETURNING id`,
        [req.session.userId, lockedAgent.project_id, title, content, JSON.stringify({ sourceAgentId: agentId, messageId: Number.isFinite(messageId) ? messageId : null })]
      )).rows[0];
      const nodeRow = (await client.query(
        `INSERT INTO write_canvas_nodes
           (user_id, project_id, kind, node_role, content_type, origin, status, title, summary, asset_id, meta, x, y, width, height)
         SELECT $1, n.project_id, 'result', 'document', 'result', 'generated', 'pending_review', $2, $3, $4, $5, n.x + 420, n.y + 40, 320, 220
         FROM write_canvas_nodes n
         WHERE n.id = $6 AND n.user_id = $1
         RETURNING id`,
        [
          req.session.userId,
          title,
          normalizePlainText(content).slice(0, 180),
          Number(assetRow.id),
          JSON.stringify({ sourceAgentId: agentId, messageId: Number.isFinite(messageId) ? messageId : null }),
          Number(lockedAgent.node_id)
        ]
      )).rows[0];
      if (!nodeRow) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "agent node not found" });
      }
      nodeId = Number(nodeRow.id);
      edgeRow = (await client.query(
        `INSERT INTO write_canvas_edges (user_id, project_id, source_node_id, target_node_id, relation)
         VALUES ($1, $2, $3, $4, 'generated')
         ON CONFLICT (project_id, source_node_id, target_node_id, relation) DO UPDATE SET relation = EXCLUDED.relation
         RETURNING id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                   target_node_id AS "targetNodeId", relation, created_at AS "createdAt"`,
        [req.session.userId, lockedAgent.project_id, Number(lockedAgent.node_id), nodeId]
      )).rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CanvasStorageLimitError) return res.status(413).json({ error: error.message });
      throw error;
    } finally {
      client.release();
    }
    const detail = await fetchCanvasProjectDetail(pool, req.session.userId, Number(agentRow.project_id));
    res.json({
      node: detail?.nodes.find(item => item.id === nodeId),
      edge: mapCanvasEdgeRow(edgeRow)
    });
  }));

  app.get("/api/write/agent/threads", requireAuth, asyncHandler(async (req, res) => {
    const threadType = req.query.type === 'skill' ? 'skill' : 'chat';
    const rows = (await pool.query(
      `SELECT id, title, summary, state, thread_type, created_at, updated_at
       FROM write_agent_threads
       WHERE user_id = $1 AND thread_type = $2
       ORDER BY updated_at DESC
       LIMIT 30`,
      [req.session.userId, threadType]
    )).rows;
    res.json(rows);
  }));

  app.post("/api/write/agent/threads", requireAuth, asyncHandler(async (req, res) => {
    const { title, threadType } = req.body || {};
    const normalizedType = threadType === 'skill' ? 'skill' : 'chat';
    const row = (await pool.query(
      `INSERT INTO write_agent_threads (user_id, title, thread_type)
       VALUES ($1, $2, $3)
       RETURNING id, title, summary, state, thread_type, created_at, updated_at`,
      [req.session.userId, typeof title === 'string' && title.trim() ? title.trim() : '新的写作会话', normalizedType]
    )).rows[0];
    res.json(row);
  }));

  app.delete("/api/write/agent/threads/:id", requireAuth, asyncHandler(async (req, res) => {
    const threadId = Number(req.params.id);
    if (!Number.isSafeInteger(threadId) || threadId <= 0) return res.status(400).json({ error: "invalid thread id" });
    const result = await pool.query(
      `DELETE FROM write_agent_threads WHERE id = $1 AND user_id = $2`,
      [threadId, req.session.userId],
    );
    if (result.rowCount !== 1) return res.status(404).json({ error: "thread not found" });
    return res.json({ success: true });
  }));

  app.get("/api/write/agent/threads/:id/messages", requireAuth, asyncHandler(async (req, res) => {
    const thread = (await pool.query(
      `SELECT id, title, summary, state, thread_type, created_at, updated_at
       FROM write_agent_threads
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.userId]
    )).rows[0];
    if (!thread) return res.status(404).json({ error: 'thread not found' });
    const messages = await getRecentThreadMessages(pool, Number(req.params.id), 60);
    res.json({ thread, messages });
  }));

  app.post("/api/write/agent/messages/:id/feedback", requireAuth, asyncHandler(async (req, res) => {
    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback : 'none';
    if (!['liked', 'disliked', 'none'].includes(feedback)) {
      return res.status(400).json({ error: 'unsupported feedback' });
    }
    const result = await pool.query(
      `UPDATE write_agent_messages wam
       SET meta = jsonb_set(
         COALESCE(wam.meta, '{}'::jsonb),
         '{feedback}',
         to_jsonb($1::text),
         true
       )
       FROM write_agent_threads wat
       WHERE wam.id = $2
         AND wam.thread_id = wat.id
         AND wat.user_id = $3
         AND wam.role = 'assistant'
       RETURNING wam.id, wam.meta`,
      [feedback, req.params.id, req.session.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'message not found' });
    res.json({ success: true, feedback, messageId: Number(result.rows[0].id) });
  }));

	  app.get("/api/write/agent/threads/:id/events", requireAuth, asyncHandler(async (req, res) => {
    const thread = (await pool.query(
      `SELECT id FROM write_agent_threads WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.userId]
    )).rows[0];
    if (!thread) return res.status(404).json({ error: 'thread not found' });
    const rows = (await pool.query(
      `SELECT node, duration_ms AS "durationMs", input_summary AS "inputSummary",
              output_summary AS "outputSummary", meta, created_at AS "createdAt"
       FROM write_agent_events
       WHERE thread_id = $1 AND user_id = $2
       ORDER BY created_at ASC
       LIMIT 200`,
      [req.params.id, req.session.userId]
    )).rows;
	    res.json({ events: rows });
	  }));

	  const sanitizeSkillList = (items: unknown, max: number) => (
	    Array.isArray(items)
	      ? items.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim().slice(0, 180)).slice(0, max)
	      : []
	  );

	  app.get("/api/write/agent/skills", requireAuth, asyncHandler(async (req, res) => {
	    const type = normalizeAgentSkillType(req.query.type);
	    const hasTypeFilter = typeof req.query.type === "string" && ["card_storage", "citation", "writing", "style"].includes(req.query.type);
	    const skills = await fetchWriteAgentSkills(pool, req.session.userId, hasTypeFilter ? type : undefined);
	    res.json({
	      skills,
	      systemSkills: skills.filter(skill => skill.visibility === "system"),
	      userSkills: skills.filter(skill => skill.visibility === "user")
	    });
	  }));

	  app.post("/api/write/agent/skills", requireAuth, asyncHandler(async (req, res) => {
	    const { name, description = "", prompt, examples = [], constraints = [], isDefault = false } = req.body || {};
	    const type = normalizeAgentSkillType(req.body?.type);
	    if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name is required" });
	    if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "prompt is required" });
	    const client = await pool.connect();
	    try {
	      await client.query("BEGIN");
	      if (isDefault) {
	        await client.query(`UPDATE write_style_skills SET is_default = FALSE WHERE user_id = $1 AND type = $2`, [req.session.userId, type]);
	      }
	      const row = (await client.query(
	        `INSERT INTO write_style_skills (user_id, name, type, description, prompt, examples, constraints, is_default)
	         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	         RETURNING id, name, type, description, prompt, examples, constraints, is_default AS "isDefault",
	                   created_at AS "createdAt", updated_at AS "updatedAt"`,
	        [
	          req.session.userId,
	          name.trim().slice(0, 40),
	          type,
	          typeof description === "string" ? description.trim().slice(0, 180) : "",
	          prompt.trim().slice(0, 2000),
	          JSON.stringify(sanitizeSkillList(examples, 8)),
	          JSON.stringify(sanitizeSkillList(constraints, 12)),
	          Boolean(isDefault)
	        ]
	      )).rows[0];
	      await client.query("COMMIT");
	      res.json({ skill: { ...row, id: Number(row.id), type: normalizeAgentSkillType(row.type), visibility: "user" } });
	    } catch (error) {
	      await client.query("ROLLBACK");
	      throw error;
	    } finally {
	      client.release();
	    }
	  }));

	  app.put("/api/write/agent/skills/:id", requireAuth, asyncHandler(async (req, res) => {
	    const skillId = Number(req.params.id);
	    if (!Number.isFinite(skillId)) return res.status(400).json({ error: "invalid skill id" });
	    const current = (await pool.query(`SELECT type FROM write_style_skills WHERE id = $1 AND user_id = $2`, [skillId, req.session.userId])).rows[0];
	    if (!current) return res.status(404).json({ error: "skill not found" });
	    const currentType = normalizeAgentSkillType(current.type);
	    const nextType = req.body?.type ? normalizeAgentSkillType(req.body.type) : currentType;
	    const { name, description, prompt, examples, constraints, isDefault } = req.body || {};
	    const client = await pool.connect();
	    try {
	      await client.query("BEGIN");
	      if (isDefault) {
	        await client.query(`UPDATE write_style_skills SET is_default = FALSE WHERE user_id = $1 AND type = $2`, [req.session.userId, nextType]);
	      }
	      const row = (await client.query(
	        `UPDATE write_style_skills SET
	           name = COALESCE($1, name),
	           type = $2,
	           description = COALESCE($3, description),
	           prompt = COALESCE($4, prompt),
	           examples = COALESCE($5, examples),
	           constraints = COALESCE($6, constraints),
	           is_default = COALESCE($7, is_default),
	           updated_at = NOW()
	         WHERE id = $8 AND user_id = $9
	         RETURNING id, name, type, description, prompt, examples, constraints, is_default AS "isDefault",
	                   created_at AS "createdAt", updated_at AS "updatedAt"`,
	        [
	          typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : null,
	          nextType,
	          typeof description === "string" ? description.trim().slice(0, 180) : null,
	          typeof prompt === "string" && prompt.trim() ? prompt.trim().slice(0, 2000) : null,
	          Array.isArray(examples) ? JSON.stringify(sanitizeSkillList(examples, 8)) : null,
	          Array.isArray(constraints) ? JSON.stringify(sanitizeSkillList(constraints, 12)) : null,
	          typeof isDefault === "boolean" ? isDefault : null,
	          skillId,
	          req.session.userId
	        ]
	      )).rows[0];
	      await client.query("COMMIT");
	      res.json({ skill: { ...row, id: Number(row.id), type: normalizeAgentSkillType(row.type), visibility: "user" } });
	    } catch (error) {
	      await client.query("ROLLBACK");
	      throw error;
	    } finally {
	      client.release();
	    }
	  }));

	  app.delete("/api/write/agent/skills/:id", requireAuth, asyncHandler(async (req, res) => {
	    const result = await pool.query(
	      `DELETE FROM write_style_skills WHERE id = $1 AND user_id = $2`,
	      [req.params.id, req.session.userId]
	    );
	    if (result.rowCount === 0) return res.status(404).json({ error: "skill not found" });
	    res.json({ success: true });
	  }));

	  app.post("/api/write/agent/skills/generate", requireAuth, paidOperationLimiter, paidConcurrencyMiddleware, skillCreationDailyPaidOperationBudgetMiddleware, asyncHandler(async (req, res) => {
	    const { userInput, sampleText } = req.body;

	    if (!userInput || typeof userInput !== "string" || userInput.trim().length < 5) {
	      return res.status(400).json({ error: "userInput is required and must be at least 5 characters" });
	    }

	    if (sampleText !== undefined && typeof sampleText !== "string") {
	      return res.status(400).json({ error: "sampleText must be a string if provided" });
	    }

	    const result = await runSkillCreationGraph(pool, {
	      userId: req.session.userId!,
	      userInput: userInput.trim(),
	      sampleText: sampleText?.trim(),
	      onProviderStart: () => markDailyAiBudgetProviderStarted(res),
	      onStep: async (event) => {
	        logger.debug({ event }, "Skill creation graph step");
	      }
	    });

	    res.json({
	      success: true,
	      skill: result.generatedSkill,
	      validationErrors: result.validationErrors || [],
	      trace: result.graphTrace
	    });
	  }));

	  app.get("/api/write/style-skills", requireAuth, asyncHandler(async (req, res) => {
	    res.json({ skills: await fetchWriteStyleSkills(pool, req.session.userId) });
  }));

	  app.post("/api/write/style-skills", requireAuth, asyncHandler(async (req, res) => {
    const { name, description = "", prompt, examples = [], constraints = [], isDefault = false } = req.body || {};
    if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name is required" });
    if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "prompt is required" });
    const client = await pool.connect();
    try {
	      await client.query("BEGIN");
	      if (isDefault) {
	        await client.query(`UPDATE write_style_skills SET is_default = FALSE WHERE user_id = $1 AND type = 'style'`, [req.session.userId]);
	      }
	      const row = (await client.query(
	        `INSERT INTO write_style_skills (user_id, name, type, description, prompt, examples, constraints, is_default)
	         VALUES ($1, $2, 'style', $3, $4, $5, $6, $7)
	         RETURNING id, name, type, description, prompt, examples, constraints, is_default AS "isDefault",
	                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          req.session.userId,
          name.trim().slice(0, 40),
          typeof description === "string" ? description.trim().slice(0, 160) : "",
          prompt.trim().slice(0, 1600),
          JSON.stringify(Array.isArray(examples) ? examples.filter((item): item is string => typeof item === "string").slice(0, 8) : []),
          JSON.stringify(Array.isArray(constraints) ? constraints.filter((item): item is string => typeof item === "string").slice(0, 12) : []),
          Boolean(isDefault)
        ]
      )).rows[0];
      await client.query("COMMIT");
	      res.json({ skill: { ...row, id: Number(row.id), type: "style", visibility: "user" } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.put("/api/write/style-skills/:id", requireAuth, asyncHandler(async (req, res) => {
    const skillId = Number(req.params.id);
    if (!Number.isFinite(skillId)) return res.status(400).json({ error: "invalid skill id" });
    const { name, description, prompt, examples, constraints, isDefault } = req.body || {};
    const client = await pool.connect();
    try {
	      await client.query("BEGIN");
	      if (isDefault) {
	        await client.query(`UPDATE write_style_skills SET is_default = FALSE WHERE user_id = $1 AND type = 'style'`, [req.session.userId]);
	      }
	      const row = (await client.query(
        `UPDATE write_style_skills SET
           name = COALESCE($1, name),
           description = COALESCE($2, description),
           prompt = COALESCE($3, prompt),
           examples = COALESCE($4, examples),
           constraints = COALESCE($5, constraints),
           is_default = COALESCE($6, is_default),
           updated_at = NOW()
	         WHERE id = $7 AND user_id = $8 AND type = 'style'
	         RETURNING id, name, type, description, prompt, examples, constraints, is_default AS "isDefault",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : null,
          typeof description === "string" ? description.trim().slice(0, 160) : null,
          typeof prompt === "string" && prompt.trim() ? prompt.trim().slice(0, 1600) : null,
          Array.isArray(examples) ? JSON.stringify(examples.filter((item): item is string => typeof item === "string").slice(0, 8)) : null,
          Array.isArray(constraints) ? JSON.stringify(constraints.filter((item): item is string => typeof item === "string").slice(0, 12)) : null,
          typeof isDefault === "boolean" ? isDefault : null,
          skillId,
          req.session.userId
        ]
      )).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "style skill not found" });
      }
      await client.query("COMMIT");
	      res.json({ skill: { ...row, id: Number(row.id), type: "style", visibility: "user" } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.delete("/api/write/style-skills/:id", requireAuth, asyncHandler(async (req, res) => {
	    const result = await pool.query(
	      `DELETE FROM write_style_skills WHERE id = $1 AND user_id = $2 AND type = 'style'`,
      [req.params.id, req.session.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "style skill not found" });
    res.json({ success: true });
  }));

  const buildWriteAgentRequest = (body: any) => {
    const { threadId, message, focusedTopic, activatedNodeIds, activationSummary, action } = body || {};
    const isCreateArticle = action === 'create_article';
    if (!isCreateArticle && (!message || typeof message !== 'string' || !message.trim())) {
      return { error: 'message is required' };
    }
    const normalizedMessage = isCreateArticle
      ? (typeof message === 'string' && message.trim() ? message.trim() : '请根据当前对话和激活网络创建一篇文章')
      : message.trim();
    const graphUserState: WriteAgentState = {
      focusedTopic: typeof focusedTopic === 'string' ? focusedTopic : undefined,
      activatedNodeIds: Array.isArray(activatedNodeIds) ? activatedNodeIds.filter((id): id is string => typeof id === 'string') : undefined,
      activationSummary: Array.isArray(activationSummary) ? activationSummary.filter((item): item is string => typeof item === 'string') : undefined,
	      selectedStyleSkillId: typeof body?.selectedStyleSkillId === 'string' || typeof body?.selectedStyleSkillId === 'number'
	        ? body.selectedStyleSkillId
	        : undefined,
	      selectedSkillIds: Array.isArray(body?.selectedSkillIds)
	        ? body.selectedSkillIds.filter((id): id is number | string => typeof id === 'string' || typeof id === 'number')
	        : undefined,
	      writingGoal: typeof body?.writingGoal === 'string' ? body.writingGoal : undefined,
      selectedCardIds: Array.isArray(body?.selectedCardIds) ? body.selectedCardIds.filter((id): id is string => typeof id === 'string') : undefined
    };
    return {
      threadId: threadId ? Number(threadId) : undefined,
      normalizedMessage,
      isCreateArticle,
      graphUserState
    };
  };

  const buildWriteAgentResponse = (graphState: WriteAgentGraphState) => ({
    runId: graphState.toolPayload?.runId,
    threadId: Number(graphState.threadId),
    threadState: graphState.mergedState,
    assistant: {
      role: 'assistant',
      content: graphState.assistantContent
    },
    assistantMessage: graphState.assistantContent,
    messageId: graphState.assistantMessageId || graphState.toolPayload?.messageId,
    toolResult: graphState.toolPayload,
    uiBlocks: graphState.uiBlocks || [],
    choices: graphState.choices || [],
    sources: graphState.sources,
    graphTrace: graphState.graphTrace || [],
    note: graphState.persistedDraftNote
      ? {
        id: Number(graphState.persistedDraftNote.id),
        title: graphState.persistedDraftNote.title,
        created_at: graphState.persistedDraftNote.created_at,
        updated_at: graphState.persistedDraftNote.updated_at
      }
      : null,
    noteCreated: Boolean(graphState.persistedDraftNote),
    context: {
      activeCards: graphState.activeCards?.length || 0,
      recalledCards: graphState.recalledCards?.length || 0
    }
  });

  app.post("/api/write/agent/chat/stream", requireAuth, paidOperationLimiter, paidConcurrencyMiddleware, writeAgentDailyPaidOperationBudgetMiddleware, asyncHandler(async (req, res) => {
    const runId = randomUUID();
    const parsed = buildWriteAgentRequest(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    if (!getOpenAIWriteAgentConfig()) {
      return res.status(500).json({ error: 'Writing agent model is not configured: set OPENAI_API_KEY/OPENAI_MODEL or AI_API_KEY/AI_BASE_URL/AI_MODEL' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (type: string, data: unknown) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      send('partial_status', { runId, message: '启动写作 Agent' });
      const graphState = await runOpenAIWriteAgentRuntime(pool, {
        userId: req.session.userId,
        threadId: parsed.threadId,
        message: parsed.normalizedMessage,
        isCreateArticle: parsed.isCreateArticle,
        userState: parsed.graphUserState,
        runId,
        onProviderStart: () => markDailyAiBudgetProviderStarted(res),
        onStep: async event => {
          send(event.type, {
            runId,
            node: event.node,
            message: event.message,
            ...(event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : { data: event.data })
          });
        }
      });
      logger.info({
        module: "write-agent-stream",
        runId,
        userId: req.session.userId,
        threadId: graphState.threadId,
        intent: graphState.intent?.intent,
        requestedTools: graphState.requestedTools,
        noteId: graphState.persistedDraftNote ? Number(graphState.persistedDraftNote.id) : undefined
      }, "Streaming write agent completed");
      send('final', buildWriteAgentResponse(graphState));
      res.end();
    } catch (error) {
      logger.error({ err: error, module: "write-agent-stream", runId, userId: req.session.userId }, "Streaming write agent failed");
      send('error', {
        runId,
        message: error instanceof Error && error.message ? error.message : '写作助手暂时不可用'
      });
      res.end();
    }
  }));

  app.post("/api/write/agent/chat", requireAuth, paidOperationLimiter, paidConcurrencyMiddleware, writeAgentDailyPaidOperationBudgetMiddleware, asyncHandler(async (req, res) => {
    const runId = randomUUID();
    const parsed = buildWriteAgentRequest(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    if (!getOpenAIWriteAgentConfig()) {
      return res.status(500).json({ error: 'Writing agent model is not configured: set OPENAI_API_KEY/OPENAI_MODEL or AI_API_KEY/AI_BASE_URL/AI_MODEL' });
    }

    const graphState = await runOpenAIWriteAgentRuntime(pool, {
      userId: req.session.userId,
      threadId: parsed.threadId,
      message: parsed.normalizedMessage,
      isCreateArticle: parsed.isCreateArticle,
      userState: parsed.graphUserState,
      runId,
      onProviderStart: () => markDailyAiBudgetProviderStarted(res),
    });

    logger.info({
      module: "write-agent",
      runId,
      userId: req.session.userId,
      threadId: graphState.threadId,
      intent: graphState.intent?.intent,
      requestedTools: graphState.requestedTools,
      noteId: graphState.persistedDraftNote ? Number(graphState.persistedDraftNote.id) : undefined
    }, "Write agent completed");
    return res.json(buildWriteAgentResponse(graphState));
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
    if (err instanceof multer.MulterError) {
      const payloadTooLarge = err.code === "LIMIT_FILE_SIZE" || err.code === "LIMIT_FIELD_VALUE";
      res.status(payloadTooLarge ? 413 : 400).json({
        error: payloadTooLarge ? "上传内容超过大小限制" : "上传请求格式不合法",
      });
      return;
    }
    const errorRecord = isPlainRecord(err) ? err : {};
    if (errorRecord.type === "entity.too.large") {
      res.status(413).json({ error: "请求内容超过大小限制" });
      return;
    }
    if (err instanceof SyntaxError && errorRecord.type === "entity.parse.failed") {
      res.status(400).json({ error: "JSON 请求格式不合法" });
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

  const asrMaxFrameBytes = readBoundedEnvNumber(process.env.ASR_MAX_FRAME_KB, 256, 32, 1024) * 1024;
  const asrMaxPendingBytes = readBoundedEnvNumber(process.env.ASR_MAX_PENDING_MB, 2, 1, 8) * 1024 * 1024;
  const asrMaxSessionMs = readBoundedEnvNumber(process.env.ASR_MAX_SESSION_SECONDS, 600, 30, 1800) * 1000;
  const asrMaxConnectionsPerUser = readBoundedEnvNumber(process.env.ASR_MAX_CONNECTIONS_PER_USER, 2, 1, 5);
  const asrMaxGlobalConnections = readBoundedEnvNumber(process.env.ASR_MAX_GLOBAL_CONNECTIONS, 20, 2, 200);
  const asrMaxSessionAudioBytes = readBoundedEnvNumber(process.env.ASR_MAX_SESSION_AUDIO_MB, 25, 5, 200) * 1024 * 1024;
  const asrMaxBytesPerSecond = readBoundedEnvNumber(process.env.ASR_MAX_BYTES_PER_SECOND, 1024 * 1024, 64 * 1024, 4 * 1024 * 1024);
  const asrMaxUpstreamBufferedBytes = readBoundedEnvNumber(process.env.ASR_MAX_UPSTREAM_BUFFER_MB, 1, 1, 8) * 1024 * 1024;
  const asrConnectionsByUser = new Map<number, number>();
  let asrGlobalConnections = 0;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: asrMaxFrameBytes,
    perMessageDeflate: false,
  });

  const rejectUpgrade = (socket: import("node:stream").Duplex, status: 401 | 403 | 404 | 429, message: string) => {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  httpServer.on("upgrade", (upgradeRequest, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(upgradeRequest.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/api/asr") {
      if (isProduction) rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const origin = upgradeRequest.headers.origin;
    if (isProduction) {
      try {
        if (!origin || !allowedOrigins.has(new URL(origin).origin)) {
          rejectUpgrade(socket, 403, "Forbidden");
          return;
        }
      } catch {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
    }

    const upgradeResponse = new ServerResponse(upgradeRequest);
    sessionMiddleware(upgradeRequest as express.Request, upgradeResponse as unknown as express.Response, () => {
      const userId = (upgradeRequest as express.Request).session?.userId;
      if (!userId) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      if ((asrConnectionsByUser.get(userId) || 0) >= asrMaxConnectionsPerUser) {
        rejectUpgrade(socket, 429, "Too Many Requests");
        return;
      }
      if (asrGlobalConnections >= asrMaxGlobalConnections) {
        rejectUpgrade(socket, 429, "Too Many Requests");
        return;
      }
      wss.handleUpgrade(upgradeRequest, socket, head, clientWs => {
        wss.emit("connection", clientWs, upgradeRequest);
      });
    });
  });

  wss.on("connection", (clientWs, request) => {
    const userId = (request as express.Request).session?.userId;
    if (!userId) {
      clientWs.close(1008, "Authentication required");
      return;
    }
    asrConnectionsByUser.set(userId, (asrConnectionsByUser.get(userId) || 0) + 1);
    asrGlobalConnections += 1;
    let connectionReleased = false;
    const releaseConnection = () => {
      if (connectionReleased) return;
      connectionReleased = true;
      const remaining = (asrConnectionsByUser.get(userId) || 1) - 1;
      if (remaining <= 0) asrConnectionsByUser.delete(userId);
      else asrConnectionsByUser.set(userId, remaining);
      asrGlobalConnections = Math.max(0, asrGlobalConnections - 1);
    };

    if (!ASR_APPID || !ASR_TOKEN) {
      clientWs.send(JSON.stringify({ error: "ASR credentials not configured" }));
      clientWs.close(1011, "ASR unavailable");
      releaseConnection();
      return;
    }

    const reqid = randomUUID();
    let upstreamWs: WsWebSocket | null = null;
    let upstreamReady = false;
    const pendingAudio: Buffer[] = [];
    let pendingAudioBytes = 0;
    let totalAudioBytes = 0;
    let rateWindowStartedAt = Date.now();
    let rateWindowBytes = 0;
    const safeClientSend = (payload: unknown) => {
      if (clientWs.readyState === WsWebSocket.OPEN) clientWs.send(JSON.stringify(payload));
    };
    const closeUpstream = () => {
      if (!upstreamWs) return;
      try {
        if (upstreamWs.readyState === WsWebSocket.OPEN) upstreamWs.send(buildAudioRequest(Buffer.alloc(0), true));
        if (upstreamWs.readyState === WsWebSocket.OPEN || upstreamWs.readyState === WsWebSocket.CONNECTING) upstreamWs.close();
      } catch {
        upstreamWs.terminate();
      }
      upstreamWs = null;
      upstreamReady = false;
    };
    const asrSessionTimeout = setTimeout(() => {
      safeClientSend({ error: "ASR session reached its maximum duration" });
      clientWs.close(1000, "Session limit reached");
      closeUpstream();
    }, asrMaxSessionMs);

    const upstream = new WsWebSocket(ASR_WS_URL, {
      headers: { Authorization: `Bearer; ${ASR_TOKEN}` },
      handshakeTimeout: 10000,
      maxPayload: asrMaxFrameBytes,
      perMessageDeflate: false,
    });
    upstreamWs = upstream;

    upstream.on("open", () => {
      upstream.send(buildFullClientRequest(reqid));
    });

    upstream.on("message", (rawData) => {
      const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData as ArrayBuffer);
      const parsed = parseAsrResponse(data);
      if (!parsed) return;

      if (parsed.code === 1000) {
        if (!upstreamReady) {
          upstreamReady = true;
          for (const chunk of pendingAudio) upstream.send(buildAudioRequest(chunk, false));
          pendingAudio.length = 0;
          pendingAudioBytes = 0;
        }
        if (parsed.text !== undefined) safeClientSend({ text: parsed.text, utterances: parsed.utterances });
      } else {
        safeClientSend({ error: `ASR error code: ${parsed.code}` });
      }
    });

    upstream.on("error", (err) => {
      logger.error({ err, module: "asr", userId }, "ASR upstream error");
      safeClientSend({ error: "ASR connection error" });
    });

    upstream.on("close", (code) => {
      const wasCurrentUpstream = upstreamWs === upstream;
      upstreamWs = null;
      upstreamReady = false;
      if (wasCurrentUpstream && clientWs.readyState === WsWebSocket.OPEN) {
        if (code !== 1000) safeClientSend({ error: "ASR upstream connection closed" });
        clientWs.close(code === 1000 ? 1000 : 1011, code === 1000 ? "ASR session ended" : "ASR upstream unavailable");
      }
    });

    clientWs.on("message", (rawData, isBinary) => {
      const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData as ArrayBuffer);
      if (!isBinary) {
        try {
          const message = JSON.parse(data.toString("utf8"));
          if (message.type === "stop") {
            if (upstreamWs?.readyState === WsWebSocket.OPEN) upstreamWs.send(buildAudioRequest(Buffer.alloc(0), true));
            return;
          }
          clientWs.close(1003, "Unsupported control message");
          return;
        } catch {
          clientWs.close(1003, "Invalid control message");
          return;
        }
      }

      const now = Date.now();
      if (now - rateWindowStartedAt >= 1000) {
        rateWindowStartedAt = now;
        rateWindowBytes = 0;
      }
      rateWindowBytes += data.byteLength;
      totalAudioBytes += data.byteLength;
      if (rateWindowBytes > asrMaxBytesPerSecond) {
        safeClientSend({ error: "ASR audio rate limit exceeded" });
        clientWs.close(1008, "Audio rate limit exceeded");
        closeUpstream();
        return;
      }
      if (totalAudioBytes > asrMaxSessionAudioBytes) {
        safeClientSend({ error: "ASR session audio limit exceeded" });
        clientWs.close(1009, "Session audio limit exceeded");
        closeUpstream();
        return;
      }

      if (upstreamReady && upstreamWs?.readyState === WsWebSocket.OPEN) {
        if (upstreamWs.bufferedAmount > asrMaxUpstreamBufferedBytes) {
          safeClientSend({ error: "ASR upstream queue limit exceeded" });
          clientWs.close(1013, "ASR upstream is busy");
          closeUpstream();
          return;
        }
        upstreamWs.send(buildAudioRequest(data, false));
        return;
      }
      if (pendingAudioBytes + data.byteLength > asrMaxPendingBytes) {
        safeClientSend({ error: "ASR pending audio limit exceeded" });
        clientWs.close(1009, "Pending audio limit exceeded");
        closeUpstream();
        return;
      }
      pendingAudio.push(data);
      pendingAudioBytes += data.byteLength;
    });

    const cleanup = () => {
      clearTimeout(asrSessionTimeout);
      pendingAudio.length = 0;
      pendingAudioBytes = 0;
      closeUpstream();
      releaseConnection();
    };
    clientWs.once("close", cleanup);
    clientWs.once("error", cleanup);
  });

  let shuttingDown = false;
  const shutdown = (signal: "SIGTERM" | "SIGINT") => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ module: "server", signal }, "Graceful shutdown started");
    clearInterval(feedRefreshTimer);
    clearInterval(verificationCleanupTimer);
    if (canvasAiRecoveryTimer) clearInterval(canvasAiRecoveryTimer);
    for (const client of wss.clients) client.close(1012, "Server restarting");

    const forceExitTimer = setTimeout(() => {
      logger.error({ module: "server", signal }, "Graceful shutdown timed out");
      httpServer.closeAllConnections();
      process.exit(1);
    }, 15000);
    forceExitTimer.unref();

    httpServer.close(async error => {
      try {
        await pool?.end();
      } catch (poolError) {
        logger.error({ err: poolError, module: "db" }, "Failed to close PostgreSQL pool");
        error ||= poolError instanceof Error ? poolError : new Error("Failed to close PostgreSQL pool");
      } finally {
        clearTimeout(forceExitTimer);
        if (error) logger.error({ err: error, module: "server" }, "Graceful shutdown completed with errors");
        else logger.info({ module: "server" }, "Graceful shutdown completed");
        process.exit(error ? 1 : 0);
      }
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.fatal(
        { module: "server", port: PORT },
        `Port ${PORT} is already in use. AtomFlow uses a fixed local port; stop the existing process instead of switching ports.`
      );
    } else {
      logger.fatal({ err, module: "server", port: PORT }, "HTTP server failed to start");
    }
    process.exit(1);
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    logger.info({ module: "server", port: PORT }, `Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  logger.fatal({ err }, "Fatal error during server startup");
  process.exit(1);
});
