import express from "express";
import compression from "compression";
import helmet from "helmet";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import { MOCK_ARTICLES } from "./src/data/mock.js";
import { AtomCard, Article, User } from "./src/types.js";
import multer from "multer";
import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import createDOMPurify from "dompurify";
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
import { Agent, OpenAIProvider, Runner, setTracingDisabled, tool, type AgentInputItem } from "@openai/agents";
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
import { canChangePassword, isRecentAuthentication } from "./src/server/accountSecurity.js";
import { extractCardsForUser } from "./src/server/articleCardExtraction.js";
import {
  extractCanvasBusinessLayouts,
  hasEmbeddedCanvasMedia,
  readCanvasDocumentSchemaVersion,
} from "./src/server/canvasDocument.js";
import { findArticleByIdentity, normalizeArticleUrl } from "./src/utils/articleIdentity.js";
import { citationArticleIdentity } from "./src/utils/citationIdentity.js";
import { loadBillingConfig, isBillingPlanCode } from "./src/server/billing/config.js";
import { BillingService } from "./src/server/billing/service.js";
import { BillingError } from "./src/server/billing/types.js";
import {
  RSS_MAX_CONCURRENCY,
  RssRuntimeController,
  type RssRuntimeAlert,
  type RssRuntimeEvent,
} from "./src/server/rssRuntime.js";
import {
  DATABASE_SCHEMA_VERSION,
  WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS,
  createDatabasePool,
  verifyDatabaseSchema,
} from "./src/server/databaseMigrations.js";
import {
  RSS_ARTICLE_CONTENT_MAX_BYTES,
  RSS_GLOBAL_ARTICLE_LIMIT,
  RssArticleCache,
  truncateUtf8,
} from "./src/server/rssCache.js";

dotenv.config();

const isProduction = process.env.NODE_ENV === "production";
const DEV_SESSION_SECRET = "atomflow-dev-secret-change-in-prod";
const PUBLIC_WEB_PORTS = new Set(["", "80", "443"]);
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGAL_PLACEHOLDER_PATTERN = /\[(?:DEPLOYMENT_OPERATOR_NAME|DEPLOYMENT_OPERATOR_ADDRESS|SERVICE_CONTACT_EMAIL|REFUND_CONTACT_EMAIL|PRIVACY_CONTACT_EMAIL|SECURITY_CONTACT_EMAIL|SERVICE_URL|DATA_HOSTING_REGION|TERMS_EFFECTIVE_DATE|GOVERNING_LAW|DISPUTE_FORUM|LOG_RETENTION_DAYS|BACKUP_RETENTION_DAYS|RIGHTS_REQUEST_RESPONSE_DAYS)\]/g;
const LEGAL_DOCUMENTS = {
  privacy: "PRIVACY.md",
  terms: "TERMS.md",
  security: "SECURITY.md",
  refunds: "REFUNDS.md",
} as const;

const legalReplacementValues = (appUrl?: string) => ({
  DEPLOYMENT_OPERATOR_NAME: process.env.DEPLOYMENT_OPERATOR_NAME || "",
  DEPLOYMENT_OPERATOR_ADDRESS: process.env.DEPLOYMENT_OPERATOR_ADDRESS || "",
  SERVICE_CONTACT_EMAIL: process.env.SERVICE_CONTACT_EMAIL || "",
  REFUND_CONTACT_EMAIL: process.env.REFUND_CONTACT_EMAIL || "",
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

const validateProductionLegalConfiguration = (appUrl?: string, billingEnabled = false) => {
  // Keep the public application deployable while paid billing is deliberately
  // disabled. The complete operator/refund policy becomes a hard startup gate
  // only when the Live checkout is actually enabled.
  if (!isProduction || !billingEnabled) return;
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
      "req.headers.paddle-signature",
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
const rssArticleCache = new RssArticleCache<Article>(
  CACHE_FILE,
  RSS_GLOBAL_ARTICLE_LIMIT,
  RSS_ARTICLE_CONTENT_MAX_BYTES,
);

function expandFeedUrls(url: string) {
  if (url.startsWith('rsshub://')) {
    const path = url.replace('rsshub://', '');
    return RSSHUB_BASES.map(base => `${base}/${path}`);
  }
  return [url];
}

async function parseFirstAvailable(urls: string[], signal?: AbortSignal) {
  let lastError: unknown;
  for (const url of urls) {
    if (signal?.aborted) throw signal.reason;
    const expanded = expandFeedUrls(url);
    // RSSHub 镜像多，每个给 5s；直连源只有 1 个 URL，给 10s
    const perCandidateTimeout = expanded.length > 1 ? 5000 : 10000;
    for (const candidate of expanded) {
      if (signal?.aborted) throw signal.reason;
      try {
        const parsed = await parseBoundedFeedCandidate(candidate, perCandidateTimeout, signal);
        const itemCount = parsed.items?.length ?? 0;
        if (itemCount > 0) {
          return parsed;
        }
        lastError = new Error(`Feed has 0 items: ${candidate}`);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        lastError = error;
      }
    }
  }
  throw lastError;
}

async function parseFreshestAvailable(urls: string[], signal?: AbortSignal) {
  let latest: { parsed: Parser.Output<any>, newestAt: number, itemCount: number } | null = null;
  let lastError: unknown;
  for (const url of urls) {
    if (signal?.aborted) throw signal.reason;
    const expanded = expandFeedUrls(url);
    for (const candidate of expanded) {
      if (signal?.aborted) throw signal.reason;
      try {
        const parsed = await parseBoundedFeedCandidate(candidate, 2500, signal);
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
        if (signal?.aborted) throw signal.reason;
        lastError = error;
      }
    }
  }
  if (latest) return latest.parsed;
  throw lastError || new Error('No feed available');
}

async function parseBoundedFeedCandidate(candidate: string, timeoutMs: number, signal?: AbortSignal) {
  const resource = await fetchBoundedPublicResource(candidate, {
    timeoutMs,
    maxBytes: 3 * 1024 * 1024,
    maxRedirects: 3,
    signal,
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

type FullArticleResourceFetcher = typeof fetchBoundedPublicResource;

const fetchReadableArticleContent = async (
  rawUrl: string,
  fetchResource: FullArticleResourceFetcher = fetchBoundedPublicResource,
): Promise<string | null> => {
  const resource = await fetchResource(rawUrl, {
    timeoutMs: 10_000,
    maxBytes: 3 * 1024 * 1024,
    maxRedirects: 3,
    allowedPorts: PUBLIC_WEB_PORTS,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AtomFlow/1.0; +https://github.com/)",
      "Accept": "text/html, application/xhtml+xml;q=0.9",
    },
  });
  if (resource.status < 200 || resource.status >= 300) return null;

  const contentType = (resource.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") return null;

  const dom = new JSDOM(resource.body.toString("utf8"), {
    url: resource.url.toString(),
  });
  const readable = new Readability(dom.window.document).parse();
  const content = readable?.content?.trim();
  return content || null;
};

const buildFullArticleView = async (
  article: Article,
  fetchResource: FullArticleResourceFetcher = fetchBoundedPublicResource,
): Promise<Article> => {
  const cachedFullContent = article.markdownContent?.trim();
  const fallbackContent = cachedFullContent || (article.source === '即刻话题'
    ? formatJikeContent(article.content)
    : article.content || article.excerpt || '暂无内容');
  let markdownContent = fallbackContent;
  let readabilityUsed = Boolean(article.readabilityUsed || (article.fullFetched && cachedFullContent));

  if (article.url) {
    try {
      const readableContent = await fetchReadableArticleContent(article.url, fetchResource);
      if (readableContent) {
        markdownContent = readableContent;
        readabilityUsed = true;
      }
    } catch (error) {
      logger.warn({ err: error, module: "articles", articleId: article.id }, "Full article fetch failed; using RSS content");
    }
  }

  return {
    ...article,
    markdownContent,
    readabilityUsed,
    fullFetched: true,
  };
};

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
      id: prev.id,
      saved: prev.saved,
      cards: [],
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
  return rssArticleCache.load();
}

async function saveArticlesCache(articles: Article[]) {
  await rssArticleCache.save(articles);
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
      `SELECT url, title, source
       FROM saved_articles
       WHERE user_id = $1`,
      [userId]
    )
  ]);

  const savedArticleIds = new Set(cardResult.rows.map(row => Number(row.article_id)));
  const savedUrls = new Set(
    savedArticleResult.rows
      .map(row => row.url)
      .filter((url): url is string => typeof url === "string" && url.length > 0)
  );
  const savedSourceTitles = new Set(
    savedArticleResult.rows.map(row => `${row.source || ""}\t${row.title || ""}`)
  );

  return articleList.map(article => {
    const savedByCurrentUser = savedArticleIds.has(article.id)
      || Boolean(article.url && savedUrls.has(article.url))
      || savedSourceTitles.has(`${article.source}\t${article.title}`)
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

function stableArticleId(source: string, item: Parser.Item, idOffset: number, index: number) {
  const key = [
    source,
    idOffset,
    item.guid || '',
    item.link || '',
    item.title || '',
    item.pubDate || '',
    index
  ].join('|');
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 1_000_000_000_000 + (hash >>> 0);
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
  return normalizedItems.map((item, index) => {
    const rawContent = item['content:encoded'] || item.content || item.contentSnippet || '';
    const formattedContent = source === '即刻话题' ? formatJikeContent(rawContent) : rawContent;
    const boundedContent = truncateUtf8(formattedContent, RSS_ARTICLE_CONTENT_MAX_BYTES);
    const excerpt = boundedContent.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').substring(0, 120) + '...';
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
      content: boundedContent,
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

const decodeHtmlAttributeEntities = (value: string) => value.replace(
  /&(?:#(\d+)|#x([\da-f]+)|(amp|quot|apos|lt|gt));/gi,
  (match, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
    if (decimal || hexadecimal) {
      const codePoint = Number.parseInt(decimal || hexadecimal || '', decimal ? 10 : 16);
      if (Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }
    const namedEntities: Record<string, string> = {
      amp: '&',
      quot: '"',
      apos: "'",
      lt: '<',
      gt: '>',
    };
    return namedEntities[(named || '').toLowerCase()] || match;
  },
);

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
    add(decodeHtmlAttributeEntities(match[1]));
  }
  for (const match of content.matchAll(/\b(?:src|data-src|data-original)=["']([^"']+)["']/gi)) {
    add(decodeHtmlAttributeEntities(match[1]));
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
  canvasNodeId?: number;
  captureId?: string;
  citationPrefix?: string;
  citationSuffix?: string;
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
  "citation",
  "podcast_episode",
  "note",
  "agent",
  "result",
] as const;

type WriteCanvasNodeKind = typeof WRITE_CANVAS_NODE_KINDS[number];

type CanvasContextItem = {
  nodeId: number;
  kind: WriteCanvasNodeKind;
  title: string;
  text: string;
  refId?: string;
  imageDataUrl?: string;
  mimeType?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  sourceExcerpt?: string;
  sourceContext?: string;
  originalQuote?: string;
  articleId?: number;
  savedArticleId?: number;
  captureId?: string;
  citationPrefix?: string;
  citationSuffix?: string;
};

type WriteCanvasSkillConfig = {
  mode: "inherit" | "override";
  inherit: boolean;
  skillIds: Array<number | string>;
  primaryStyleSkillId?: number | string;
};

type WriteCanvasDocumentSnapshot = {
  store: Record<string, unknown>;
  schema?: Record<string, unknown>;
};

const WRITE_CANVAS_MAX_NODES_PER_PROJECT = readBoundedEnvNumber(process.env.CANVAS_MAX_NODES_PER_PROJECT, 500, 50, 5000);
const WRITE_CANVAS_MAX_MESSAGES_PER_AGENT = readBoundedEnvNumber(process.env.CANVAS_MAX_MESSAGES_PER_AGENT, 200, 20, 1000);
const WRITE_CANVAS_MAX_PROJECTS_PER_USER = readBoundedEnvNumber(process.env.CANVAS_MAX_PROJECTS_PER_USER, 50, 5, 500);
const WRITE_CANVAS_MAX_CONTEXT_ITEMS = readBoundedEnvNumber(process.env.CANVAS_MAX_CONTEXT_ITEMS, 30, 5, 100);
const WRITE_CANVAS_MAX_CONTEXT_CHARS = readBoundedEnvNumber(process.env.CANVAS_MAX_CONTEXT_CHARS, 60000, 10000, 250000);
const WRITE_CANVAS_MAX_CONTEXT_IMAGE_BYTES = readBoundedEnvNumber(process.env.CANVAS_MAX_CONTEXT_IMAGE_MB, 12, 1, 40) * 1024 * 1024;
const WRITE_CANVAS_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
const WRITE_CANVAS_DOCUMENT_MAX_RECORDS = 5000;
const WRITE_CANVAS_MAX_SKILL_IDS = 32;
const WRITE_CANVAS_CLONE_MAX_ROWS = 10_000;
const WRITE_CANVAS_CLONE_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const WRITE_CANVAS_CLONE_MAX_METADATA_BYTES = 8 * 1024 * 1024;
const WRITE_CANVAS_CLONE_METADATA_BATCH_SIZE = 250;
const WRITE_CANVAS_LEGACY_THREAD_MIGRATION_MAX_BYTES = readBoundedEnvNumber(
  process.env.CANVAS_LEGACY_THREAD_MIGRATION_MAX_MB,
  1,
  1,
  16,
) * 1024 * 1024;
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
    canvasNodeId?: number;
    captureId?: string;
  }>;
  quotes: Array<{
    cardId: string;
    articleTitle?: string;
    quote: string;
    sourceUrl?: string;
    canvasNodeId?: number;
    captureId?: string;
    prefix?: string;
    suffix?: string;
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

const fetchWriteAgentSkills = async (database: pg.Pool | pg.PoolClient, userId: number, typeFilter?: WriteAgentSkillType): Promise<WriteAgentSkillRecord[]> => {
  const rows = (await database.query(
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

const resolveWriteAgentSkillsFromAvailable = (
  skills: WriteAgentSkillRecord[],
  selectedSkillIds?: Array<number | string>,
  selectedStyleSkillId?: number | string
): WriteAgentSkillRecord[] => {
  const selectedSet = new Set((selectedSkillIds || []).map(id => String(id)));
  const primaryStyleKey = selectedStyleSkillId !== undefined && selectedStyleSkillId !== null
    ? String(selectedStyleSkillId)
    : null;
  if (selectedStyleSkillId !== undefined && selectedStyleSkillId !== null) {
    selectedSet.add(primaryStyleKey!);
  }
  const selected = skills.filter(skill => selectedSet.has(String(skill.id)) && !isBaselineSkill(skill));
  const result: WriteAgentSkillRecord[] = [];
  getBaselineWriteAgentSkills().forEach(skill => result.push(skill));
  const primaryStyle = primaryStyleKey
    ? selected.find(skill => skill.type === "style" && String(skill.id) === primaryStyleKey)
    : undefined;
  if (primaryStyle) result.push(primaryStyle);
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

const selectPrimaryWriteStyleSkill = (
  skills: WriteAgentSkillRecord[],
  primaryStyleSkillId?: number | string,
) => {
  if (primaryStyleSkillId !== undefined && primaryStyleSkillId !== null) {
    const primaryKey = String(primaryStyleSkillId);
    const explicitPrimary = skills.find(skill => skill.type === "style" && String(skill.id) === primaryKey);
    if (explicitPrimary) return explicitPrimary;
  }
  return skills.find(skill => skill.type === "style");
};

const resolveWriteAgentSkills = async (
  pool: pg.Pool,
  userId: number,
  selectedSkillIds?: Array<number | string>,
  selectedStyleSkillId?: number | string
): Promise<WriteAgentSkillRecord[]> => {
  const skills = await fetchWriteAgentSkills(pool, userId);
  return resolveWriteAgentSkillsFromAvailable(skills, selectedSkillIds, selectedStyleSkillId);
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
      originalQuote: typeof card.originalQuote === "string" ? card.originalQuote.trim().slice(0, 2000) : undefined,
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
      savedAt: typeof card.savedAt === "string" ? card.savedAt : undefined,
      canvasNodeId: typeof card.canvasNodeId === "number" && Number.isSafeInteger(card.canvasNodeId)
        ? card.canvasNodeId
        : undefined,
      captureId: typeof card.captureId === "string" ? card.captureId.slice(0, 128) : undefined,
      citationPrefix: typeof card.citationPrefix === "string" ? card.citationPrefix.slice(-120) : undefined,
      citationSuffix: typeof card.citationSuffix === "string" ? card.citationSuffix.slice(0, 120) : undefined,
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
const WRITE_AGENT_MAX_MESSAGE_LENGTH = 120000;
const AI_DRAFT_MAX_TOKENS = 2400;
const AI_POLISH_MAX_TOKENS = 2400;
const MIMO_MIN_STRUCTURED_OUTPUT_TOKENS = 4096;
const draftSanitizer = createDOMPurify(new JSDOM("").window as unknown as Parameters<typeof createDOMPurify>[0]);

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
  return draftSanitizer.sanitize(rawHtml);
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

const summarizeCanvasUserInstructions = (messages: Array<{ role: string; content: string }>) => {
  const compact = messages
    .filter(message => message.role === "user")
    .slice(-10)
    .map(message => `用户：${normalizePlainText(message.content).slice(0, 120)}`)
    .join(" | ");
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

const getRecentCanvasUserInstructions = async (
  database: pg.Pool | pg.PoolClient,
  threadId: number,
  limit = 10,
  beforeMessageId?: number,
) => {
  const rows = (await database.query(
    `SELECT id, role, content, meta, created_at
     FROM write_agent_messages
     WHERE thread_id = $1 AND role = 'user'
       AND ($3::bigint IS NULL OR id < $3)
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [threadId, limit, beforeMessageId ?? null],
  )).rows;
  return rows.reverse().map(row => ({
    id: Number(row.id),
    role: "user" as const,
    content: row.content as string,
    meta: row.meta || {},
    created_at: row.created_at,
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
      const styleSkill = selectPrimaryWriteStyleSkill(agentSkills, state.mergedState?.selectedStyleSkillId)
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

            if (generatedDraftText.trim() && state.isCreateArticle) {
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
    const text = typeof input === "string"
      ? input
      : input.flatMap(item => {
        if (!isPlainRecord(item) || item.role !== "user") return [];
        const content = item.content;
        if (typeof content === "string") return [content];
        if (!Array.isArray(content)) return [];
        return content.flatMap(part => isPlainRecord(part) && part.type === "input_text" && typeof part.text === "string"
          ? [part.text]
          : []);
      }).join("\n");
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
    threadType?: "chat" | "skill" | "canvas";
    authorizedCards?: WritingCardInput[];
    authorizedImages?: string[];
    agentSystemPrompt?: string;
    model?: string;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    runId?: string;
    creationKey?: string;
    requestKey?: string;
    signal?: AbortSignal;
    onProviderBoundary?: () => void | Promise<void>;
    onBeforeProvider?: () => void | Promise<void>;
    onStep?: (event: { type: string; node?: string; message?: string; data?: unknown }) => void | Promise<void>;
  }
): Promise<WriteAgentGraphState> => {
  const isCanvasRun = input.threadType === "canvas";
  const baseConfig = getOpenAIWriteAgentConfig();
  if (!baseConfig) throw new Error("OpenAI writing agent is not configured: set OPENAI_API_KEY and OPENAI_MODEL");
  const config = input.model
    ? { ...baseConfig, model: normalizeAiModelName(input.model) }
    : baseConfig;
  const runtimeModelSettings = {
    temperature: clampNumber(input.temperature, 0.55, 0, 2),
    topP: clampNumber(input.topP, 1, 0.01, 1),
    maxTokens: Math.round(clampNumber(input.maxTokens, 1200, 128, getCanvasAgentMaxOutputTokens())),
  };

  const runId = input.runId || randomUUID();
  const runStartedAt = Date.now();
  const runner = createOpenAIWriteAgentRunner(config);
  const authorizedImages = selectAuthorizedCanvasImages(config.model, input.authorizedImages || []);
  const withAuthorizedImages = (prompt: string): string | AgentInputItem[] => authorizedImages.length > 0
    ? [{
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        ...authorizedImages.map(image => ({ type: "input_image" as const, image, detail: "auto" })),
      ],
    }]
    : prompt;
  const sdkTools = createWriteAgentSdkTools();
  const trace: WriteAgentGraphTraceRecord[] = [];
  let providerStartPromise: Promise<void> | null = null;
  const beforeProviderInvocation = async () => {
    input.signal?.throwIfAborted();
    await input.onProviderBoundary?.();
    if (!providerStartPromise) {
      providerStartPromise = Promise.resolve(input.onBeforeProvider?.());
    }
    await providerStartPromise;
  };
  const withStep = async <T,>(node: string, label: string, fn: () => Promise<{ value: T; summary?: string; meta?: Record<string, unknown> }>) => {
    input.signal?.throwIfAborted();
    const started = Date.now();
    await input.onStep?.({ type: "step_start", node, message: getWriteAgentNodeLabel(node, "start") });
    const result = await fn();
    input.signal?.throwIfAborted();
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
    const expectedThreadType = input.threadType || "chat";
    thread = input.threadId
      ? (await pool.query(
        `SELECT id, title, summary, state, created_at, updated_at
         FROM write_agent_threads
         WHERE id = $1 AND user_id = $2 AND thread_type = $3`,
        [input.threadId, input.userId, expectedThreadType]
      )).rows[0]
      : null;
    if (!thread) {
      thread = (await pool.query(
        `INSERT INTO write_agent_threads (user_id, title, state, thread_type)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, summary, state, thread_type, created_at, updated_at`,
        [input.userId, inferThreadTitle(input.message), JSON.stringify({}), expectedThreadType]
      )).rows[0];
    }
    const normalizedThreadId = Number(thread.id);
    const userMessageMeta = {
      state: input.userState,
      action: input.isCreateArticle ? "create_article" : undefined,
      ...(input.requestKey ? { canvasRunRequestKey: input.requestKey } : {}),
    };
    const insertedUserMessage = (await pool.query(
      `INSERT INTO write_agent_messages (thread_id, role, content, meta)
       VALUES ($1, 'user', $2, $3)
       ${input.requestKey ? "ON CONFLICT DO NOTHING" : ""}
       RETURNING id`,
      [normalizedThreadId, input.message, JSON.stringify(userMessageMeta)]
    )).rows[0];
    let currentUserMessageId = Number(insertedUserMessage?.id);
    if (!Number.isSafeInteger(currentUserMessageId) && input.requestKey) {
      const existingUserMessage = (await pool.query(
        `SELECT id
         FROM write_agent_messages
         WHERE thread_id = $1 AND role = 'user' AND meta->>'canvasRunRequestKey' = $2
         LIMIT 1`,
        [normalizedThreadId, input.requestKey],
      )).rows[0];
      currentUserMessageId = Number(existingUserMessage?.id);
    }
    if (isCanvasRun && !Number.isSafeInteger(currentUserMessageId)) {
      throw new Error("Canvas Agent user instruction could not be persisted");
    }
    // Supplying authorizedCards creates a hard material boundary for canvas
    // runs: global cards and notes are not hydrated into the model context.
    dbCards = input.authorizedCards === undefined
      ? await fetchUserSavedCards(pool, input.userId)
      : sanitizeWritingCards(input.authorizedCards);
    previousMessages = isCanvasRun
      ? await getRecentCanvasUserInstructions(pool, normalizedThreadId, 10, currentUserMessageId)
      : await getRecentThreadMessages(pool, normalizedThreadId, 14);
    if (isCanvasRun) {
      // Canvas assistant/tool output remains stored for the UI and audit trail,
      // but only prior user instructions may cross into a later model run.
      thread = {
        ...thread,
        summary: summarizeCanvasUserInstructions(previousMessages),
      };
    }
    const threadState = (thread.state || {}) as WriteAgentState;
    mergedState = {
      focusedTopic: isCanvasRun ? input.userState.focusedTopic : input.userState.focusedTopic || threadState.focusedTopic,
      activatedNodeIds: isCanvasRun
        ? input.userState.activatedNodeIds || []
        : input.userState.activatedNodeIds || threadState.activatedNodeIds || [],
      activationSummary: isCanvasRun
        ? input.userState.activationSummary || []
        : input.userState.activationSummary || threadState.activationSummary || [],
      selectedStyleSkillId: isCanvasRun
        ? input.userState.selectedStyleSkillId
        : input.userState.selectedStyleSkillId || threadState.selectedStyleSkillId,
      selectedSkillIds: input.userState.selectedSkillIds || threadState.selectedSkillIds || [],
      effectiveSkillIds: Array.isArray(threadState.effectiveSkillIds) ? threadState.effectiveSkillIds : [],
      writingGoal: input.userState.writingGoal || threadState.writingGoal,
      pendingChoice: input.userState.pendingChoice || threadState.pendingChoice,
      selectedCardIds: isCanvasRun
        ? input.userState.selectedCardIds || []
        : input.userState.selectedCardIds || threadState.selectedCardIds || [],
      sourceImageIds: isCanvasRun ? [] : threadState.sourceImageIds || [],
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
    if (input.agentSystemPrompt?.trim()) {
      agentSkills.push({
        id: "canvas-agent-instructions",
        name: "画布 Agent 指令",
        type: "writing",
        scenario: "drafting",
        prompt: input.agentSystemPrompt.trim().slice(0, 8000),
        visibility: "system",
      });
    }
    styleSkill = selectPrimaryWriteStyleSkill(agentSkills, mergedState.selectedStyleSkillId)
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
      await beforeProviderInvocation();
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
        signal: input.signal,
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
    recentNotes = input.authorizedCards === undefined && (requestedTools.includes("list_recent_notes") || requestedTools.includes("generate_draft"))
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
    modelSettings: runtimeModelSettings,
    instructions: "你负责判断召回素材是否足以支撑写作任务。必须明确素材不足，不要伪造来源。",
    tools: sdkTools,
    inputGuardrails: [writeAgentInputGuardrail],
    outputGuardrails: [writeAgentOutputGuardrail]
  });
  const outlineAgent = new Agent<OpenAIWriteAgentContext>({
    name: "OutlineAgent",
    handoffDescription: "Generate article angles and outlines from AtomFlow knowledge cards.",
    model: config.model,
    modelSettings: runtimeModelSettings,
    instructions: WRITING_PLAN_SYSTEM_PROMPT,
    inputGuardrails: [writeAgentInputGuardrail],
    outputGuardrails: [writeAgentOutputGuardrail]
  });
  const draftAgent = new Agent<OpenAIWriteAgentContext>({
    name: "DraftAgent",
    handoffDescription: "Write article drafts from outlines, cards, citations and style skills.",
    model: config.model,
    modelSettings: runtimeModelSettings,
    instructions: WRITING_AGENT_SYSTEM_PROMPT,
    inputGuardrails: [writeAgentInputGuardrail],
    outputGuardrails: [writeAgentOutputGuardrail]
  });
  const coordinatorAgent = new Agent<OpenAIWriteAgentContext>({
    name: "CoordinatorAgent",
    handoffDescription: "Coordinate AtomFlow writing tasks and produce final user-facing answers.",
    model: config.model,
    modelSettings: runtimeModelSettings,
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
        await beforeProviderInvocation();
        const planResult = await runner.run(outlineAgent, withAuthorizedImages(buildWritingPlanPrompt(topicForWriting, cardsForWriting, sanitizeWritingCards(recalledCards), styleSkill, agentSkills)), {
          context: sdkContext,
          maxTurns: 4,
          signal: input.signal,
        });
        generatedPlan = sanitizeWritingPlan(safeJsonParse<WritingPlanResult>(String(planResult.finalOutput || "")), topicForWriting);
        generatedOutlineText = generatedPlan.outline.map(item => `- ${item.heading}：${item.goal}`).join("\n");
        const evidenceMap = buildEvidenceMap(generatedPlan, cardsForWriting);
        if (shouldGenerateDraft) {
          await input.onStep?.({ type: "partial_status", node: "generate_answer_or_draft", message: "正在生成完整文章草稿" });
          await beforeProviderInvocation();
          const draftResult = await runner.run(draftAgent, withAuthorizedImages(buildDraftPrompt(topicForWriting, generatedPlan, cardsForWriting, sanitizeWritingCards(recalledCards), evidenceMap, styleSkill, agentSkills)), {
            context: sdkContext,
            maxTurns: 4,
            signal: input.signal,
          });
          generatedDraftText = String(draftResult.finalOutput || "").trim();
          if (generatedDraftText && input.isCreateArticle) {
            const preparedDraft = prepareAgentDraftForNote(generatedDraftText, generatedPlan.title);
            await input.onStep?.({ type: "partial_status", node: "persist_memory", message: "正在保存文章与引用链路" });
            const activationSummaryForNote = (mergedState.activationSummary || []).length > 0
              ? mergedState.activationSummary || []
              : cardsForWriting.slice(0, 5).map(card => `${card.type} · ${card.content.slice(0, 20)}`);
            input.signal?.throwIfAborted();
            persistedDraftNote = await createAgentDraftNote(pool, input.userId, {
              creationKey: input.creationKey,
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
        await beforeProviderInvocation();
        return runner.run(coordinatorAgent, withAuthorizedImages(formatOpenAIWriteAgentPrompt({
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
      })), {
        context: sdkContext,
        maxTurns: 6,
        signal: input.signal,
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
      model: config.model,
      usedImages: authorizedImages.length,
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
    const finalMessages = isCanvasRun
      ? await getRecentCanvasUserInstructions(pool, threadId, 10)
      : await getRecentThreadMessages(pool, threadId, 14);
    const summary = isCanvasRun
      ? summarizeCanvasUserInstructions(finalMessages)
      : summarizeAgentMessages(finalMessages.map(item => ({ role: item.role, content: item.content })));
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
  if (assistantMessageId) {
    const completedTrace = [...trace];
    const traceUpdate = await pool.query(
      `UPDATE write_agent_messages
       SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{graphTrace}', $3::jsonb, true)
       WHERE id = $1 AND thread_id = $2`,
      [assistantMessageId, threadId, JSON.stringify(completedTrace)],
    );
    if (traceUpdate.rowCount !== 1) throw new Error("Writing Agent trace could not be finalized");
    toolPayload = { ...toolPayload, graphTrace: completedTrace };
  }
  input.signal?.throwIfAborted();
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
  }
) => {
  const requestChat = async (messages: AiChatMessage[], temperature: number, maxTokens: number) => {
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
    canvasNodeId: card.canvasNodeId,
    captureId: card.captureId,
    citationPrefix: card.citationPrefix,
    citationSuffix: card.citationSuffix,
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
              canvasNodeId?: number;
              captureId?: string;
              exact?: string;
              prefix?: string;
              suffix?: string;
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
      savedAt: card.savedAt,
      canvasNodeId: card.canvasNodeId,
      captureId: card.captureId,
      exact: card.originalQuote,
      prefix: card.citationPrefix,
      suffix: card.citationSuffix,
    });
  });
  return Array.from(unique.values());
};

// 从写作卡片中提取唯一来源文章列表
const buildSourceArticlesFromCards = (cardsForWriting: WritingCardInput[], _dbCards: unknown[]) => {
  const articleMap = new Map<string, {
    savedArticleId?: number;
    articleId?: number;
    title: string;
    articleTitle: string;
    source: string;
    url?: string;
    excerpt?: string;
    citationContext?: string;
    sourceImages?: string[];
    imageUrls?: string[];
    cardIds: string[];
    canvasNodeId?: number;
    captureId?: string;
    exact?: string;
    prefix?: string;
    suffix?: string;
  }>();
  for (const card of cardsForWriting) {
    const savedArticleId = card.savedArticleId;
    const articleTitle = card.articleTitle || '未知来源';
    const sourceUrl = card.sourceUrl;
    const key = card.captureId
      ? `capture_${card.captureId}`
      : savedArticleId
        ? `saved_${savedArticleId}`
        : card.articleId
          ? `article_${card.articleId}`
          : card.canvasNodeId
            ? `canvas_${card.canvasNodeId}`
            : `source_${sourceUrl || articleTitle}`;
    if (!articleMap.has(key)) {
      const sourceImages = normalizeJsonStringArray(card.sourceImages);
      articleMap.set(key, {
        savedArticleId,
        articleId: card.articleId,
        title: articleTitle,
        articleTitle,
        source: card.sourceName || '画布授权素材',
        url: sourceUrl || undefined,
        excerpt: card.sourceExcerpt || card.sourceContext || card.originalQuote || card.content.slice(0, 260),
        citationContext: card.sourceContext,
        cardIds: [],
        sourceImages,
        imageUrls: sourceImages,
        canvasNodeId: card.canvasNodeId,
        captureId: card.captureId,
        exact: card.originalQuote,
        prefix: card.citationPrefix,
        suffix: card.citationSuffix,
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
        imageUrls: card.sourceImages || [],
        canvasNodeId: card.canvasNodeId,
        captureId: card.captureId,
      });
    }
    if (card.originalQuote && card.id) {
      quotes.push({
        cardId: card.id,
        articleTitle: card.articleTitle,
        quote: card.originalQuote,
        sourceUrl: card.sourceUrl,
        canvasNodeId: card.canvasNodeId,
        captureId: card.captureId,
        prefix: card.citationPrefix,
        suffix: card.citationSuffix,
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
    creationKey?: string;
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
    creationKey: input.creationKey,
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
    `INSERT INTO notes (user_id, title, content, tags, meta, creation_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, creation_key) WHERE creation_key IS NOT NULL
     DO UPDATE SET creation_key = EXCLUDED.creation_key
     RETURNING id, title, content, tags, meta, created_at, updated_at`,
    [userId, input.title, input.content, JSON.stringify(tags), JSON.stringify(meta), input.creationKey || null]
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
    signal?: AbortSignal;
  }
) => {
  const config = getAiChatConfig();
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
      signal: options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal,
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

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
};

const normalizeJsonObject = (value: unknown) => (
  isPlainRecord(value) ? value : {}
);

const normalizeCanvasSkillId = (candidate: unknown): number | string | undefined => (
  typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : typeof candidate === "string" && candidate.trim() && candidate.trim().length <= 128
      ? candidate.trim()
      : undefined
);

const normalizeCanvasSkillConfig = (
  value: unknown,
  emptyMode: "inherit" | "override" = "inherit",
): WriteCanvasSkillConfig => {
  const record = isPlainRecord(value) ? value : {};
  const source = Array.isArray(value)
    ? value
    : Array.isArray(record.skillIds)
      ? record.skillIds
      : Array.isArray(record.selectedSkillIds)
        ? record.selectedSkillIds
        : [];
  const seen = new Set<string>();
  const skillIds: Array<number | string> = [];
  for (const candidate of source) {
    const normalized = normalizeCanvasSkillId(candidate);
    if (normalized === undefined) continue;
    const key = String(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    skillIds.push(normalized);
    if (skillIds.length >= WRITE_CANVAS_MAX_SKILL_IDS) break;
  }
  const primaryStyleSkillId = normalizeCanvasSkillId(record.primaryStyleSkillId ?? record.selectedStyleSkillId);
  const hasSelection = skillIds.length > 0 || primaryStyleSkillId !== undefined;
  const explicitMode = record.mode === "inherit" || record.mode === "override" ? record.mode : undefined;
  const inherit = explicitMode
    ? explicitMode === "inherit"
    : typeof record.inherit === "boolean"
      ? record.inherit
      : !hasSelection && emptyMode === "inherit";
  return {
    mode: inherit ? "inherit" : "override",
    inherit,
    skillIds: inherit ? [] : skillIds,
    ...(!inherit && primaryStyleSkillId !== undefined ? { primaryStyleSkillId } : {}),
  };
};

const filterCanvasSkillConfigFromAvailable = (
  available: WriteAgentSkillRecord[],
  value: unknown,
  emptyMode: "inherit" | "override" = "inherit",
): WriteCanvasSkillConfig => {
  const requested = normalizeCanvasSkillConfig(value, emptyMode);
  if (requested.inherit) return requested;
  const availableById = new Map(available.map(skill => [String(skill.id), skill]));
  const skillIds = requested.skillIds.filter(id => availableById.has(String(id)));
  const primaryStyleSkillId = requested.primaryStyleSkillId !== undefined
    && availableById.get(String(requested.primaryStyleSkillId))?.type === "style"
    ? requested.primaryStyleSkillId
    : undefined;
  return {
    mode: "override",
    inherit: false,
    skillIds,
    ...(primaryStyleSkillId !== undefined ? { primaryStyleSkillId } : {}),
  };
};

const filterCanvasSkillConfig = async (
  database: pg.Pool | pg.PoolClient,
  userId: number,
  value: unknown,
  emptyMode: "inherit" | "override" = "inherit",
): Promise<WriteCanvasSkillConfig> => {
  const available = await fetchWriteAgentSkills(database, userId);
  return filterCanvasSkillConfigFromAvailable(available, value, emptyMode);
};

const resolveEffectiveCanvasSkillsFromAvailable = (
  available: WriteAgentSkillRecord[],
  value: unknown,
  inheritedValue?: unknown,
  emptyMode: "inherit" | "override" = inheritedValue === undefined ? "override" : "inherit",
) => {
  const skillConfig = filterCanvasSkillConfigFromAvailable(available, value, emptyMode);
  const inheritedConfig = inheritedValue === undefined
    ? { mode: "override" as const, inherit: false, skillIds: [] as Array<number | string> }
    : filterCanvasSkillConfigFromAvailable(available, inheritedValue, "override");
  const effectiveSkillConfig: WriteCanvasSkillConfig = skillConfig.inherit
    ? { ...inheritedConfig, mode: "override", inherit: false }
    : { ...skillConfig, mode: "override", inherit: false };
  const effectiveSkills = resolveWriteAgentSkillsFromAvailable(
    available,
    effectiveSkillConfig.skillIds,
    effectiveSkillConfig.primaryStyleSkillId,
  );
  return {
    skillConfig,
    effectiveSkillConfig,
    effectiveSkills: buildAgentSkillSnapshots(effectiveSkills),
  };
};

const resolveEffectiveCanvasSkills = async (
  pool: pg.Pool,
  userId: number,
  value: unknown,
  inheritedValue?: unknown,
  emptyMode: "inherit" | "override" = inheritedValue === undefined ? "override" : "inherit",
) => {
  const available = await fetchWriteAgentSkills(pool, userId);
  return resolveEffectiveCanvasSkillsFromAvailable(available, value, inheritedValue, emptyMode);
};

const parseCanvasDocumentSnapshot = (value: unknown): WriteCanvasDocumentSnapshot | null => {
  if (!isPlainRecord(value) || !isPlainRecord(value.store)) return null;
  const recordCount = Object.keys(value.store).length;
  if (recordCount > WRITE_CANVAS_DOCUMENT_MAX_RECORDS) return null;
  if (value.schema !== undefined && !isPlainRecord(value.schema)) return null;
  return {
    store: value.store,
    ...(isPlainRecord(value.schema) ? { schema: value.schema } : {}),
  };
};

type CanvasDocumentValidationResult =
  | { ok: true; snapshot: WriteCanvasDocumentSnapshot }
  | { ok: false; status: 400 | 413; error: string; code: string };

const validateCanvasDocumentSnapshotInput = (value: unknown): CanvasDocumentValidationResult => {
  let parsedSnapshot = value;
  let serializedSnapshot: string;
  if (typeof value === "string") {
    serializedSnapshot = value;
    if (Buffer.byteLength(serializedSnapshot, "utf8") > WRITE_CANVAS_DOCUMENT_MAX_BYTES) {
      return { ok: false, status: 413, error: "画布文档超过 2MB 上限", code: "CANVAS_DOCUMENT_TOO_LARGE" };
    }
    try {
      parsedSnapshot = JSON.parse(serializedSnapshot);
    } catch {
      return { ok: false, status: 400, error: "snapshot must be valid JSON", code: "INVALID_CANVAS_DOCUMENT" };
    }
  } else {
    try {
      serializedSnapshot = JSON.stringify(value);
    } catch {
      return { ok: false, status: 400, error: "snapshot must be valid JSON", code: "INVALID_CANVAS_DOCUMENT" };
    }
    if (Buffer.byteLength(serializedSnapshot, "utf8") > WRITE_CANVAS_DOCUMENT_MAX_BYTES) {
      return { ok: false, status: 413, error: "画布文档超过 2MB 上限", code: "CANVAS_DOCUMENT_TOO_LARGE" };
    }
  }

  const snapshot = parseCanvasDocumentSnapshot(parsedSnapshot);
  if (!snapshot) {
    const count = isPlainRecord(parsedSnapshot) && isPlainRecord(parsedSnapshot.store)
      ? Object.keys(parsedSnapshot.store).length
      : null;
    return count !== null && count > WRITE_CANVAS_DOCUMENT_MAX_RECORDS
      ? {
        ok: false,
        status: 413,
        error: `画布记录不能超过 ${WRITE_CANVAS_DOCUMENT_MAX_RECORDS} 条`,
        code: "CANVAS_DOCUMENT_RECORD_LIMIT",
      }
      : { ok: false, status: 400, error: "snapshot.store must be an object", code: "INVALID_CANVAS_DOCUMENT" };
  }
  if (hasEmbeddedCanvasMedia(snapshot)) {
    return {
      ok: false,
      status: 400,
      error: "画布快照不允许原生或外链媒体，请通过受限上传接口添加素材",
      code: "EMBEDDED_CANVAS_MEDIA_REJECTED",
    };
  }
  return { ok: true, snapshot };
};

type CanvasViewportInputResult =
  | { ok: true; viewport: { camera: { x: number; y: number; z: number } } | null }
  | { ok: false; error: string };

const parseCanvasViewportInput = (value: unknown): CanvasViewportInputResult => {
  if (value === undefined || value === null || value === "") return { ok: true, viewport: null };
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ok: false, error: "viewport must be valid JSON" };
    }
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.camera)) {
    return { ok: false, error: "viewport.camera is required" };
  }
  return {
    ok: true,
    viewport: {
      camera: {
        x: clampNumber(parsed.camera.x, 0, -100_000, 100_000),
        y: clampNumber(parsed.camera.y, 0, -100_000, 100_000),
        z: clampNumber(parsed.camera.z, 1, 0.01, 100),
      },
    },
  };
};

const remapClonedCanvasDocumentSnapshot = (
  snapshot: WriteCanvasDocumentSnapshot,
  nodeIdMap: Map<number, number>,
  edgeIdMap: Map<number, number>,
): WriteCanvasDocumentSnapshot => {
  const recordIdMap = new Map<string, string>();
  for (const [storeKey, rawRecord] of Object.entries(snapshot.store)) {
    if (!isPlainRecord(rawRecord)) continue;
    const recordId = typeof rawRecord.id === "string" ? rawRecord.id : storeKey;
    if (rawRecord.type === "atomflow-node" && isPlainRecord(rawRecord.props)) {
      const clonedNodeId = nodeIdMap.get(Number(rawRecord.props.nodeId));
      if (clonedNodeId !== undefined) {
        const clonedShapeId = `shape:atomflow-node-${clonedNodeId}`;
        recordIdMap.set(storeKey, clonedShapeId);
        recordIdMap.set(recordId, clonedShapeId);
      }
    }
    if (isPlainRecord(rawRecord.meta)) {
      const clonedEdgeId = edgeIdMap.get(Number(rawRecord.meta.atomflowEdgeId));
      if (clonedEdgeId !== undefined) {
        const clonedShapeId = `shape:atomflow-edge-${clonedEdgeId}`;
        recordIdMap.set(storeKey, clonedShapeId);
        recordIdMap.set(recordId, clonedShapeId);
      }
    }
  }

  const remapValue = (value: unknown): unknown => {
    if (typeof value === "string") return recordIdMap.get(value) || value;
    if (Array.isArray(value)) return value.map(remapValue);
    if (!isPlainRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remapValue(child)]));
  };

  const storeEntries = Object.entries(snapshot.store).map(([storeKey, rawRecord]) => {
    if (!isPlainRecord(rawRecord)) return [recordIdMap.get(storeKey) || storeKey, remapValue(rawRecord)] as const;
    const remappedRecord = remapValue(rawRecord) as Record<string, unknown>;
    let remappedKey = recordIdMap.get(storeKey) || storeKey;
    if (rawRecord.type === "atomflow-node" && isPlainRecord(rawRecord.props)) {
      const clonedNodeId = nodeIdMap.get(Number(rawRecord.props.nodeId));
      if (clonedNodeId !== undefined) {
        remappedKey = `shape:atomflow-node-${clonedNodeId}`;
        remappedRecord.id = remappedKey;
        const props = isPlainRecord(remappedRecord.props) ? remappedRecord.props : {};
        remappedRecord.props = { ...props, nodeId: String(clonedNodeId) };
      }
    }
    if (isPlainRecord(rawRecord.meta)) {
      const clonedEdgeId = edgeIdMap.get(Number(rawRecord.meta.atomflowEdgeId));
      if (clonedEdgeId !== undefined) {
        remappedKey = `shape:atomflow-edge-${clonedEdgeId}`;
        remappedRecord.id = remappedKey;
        const meta = isPlainRecord(remappedRecord.meta) ? remappedRecord.meta : {};
        remappedRecord.meta = { ...meta, atomflowEdgeId: clonedEdgeId };
      }
    }
    return [remappedKey, remappedRecord] as const;
  });

  return {
    store: Object.fromEntries(storeEntries),
    ...(snapshot.schema ? { schema: remapValue(snapshot.schema) as Record<string, unknown> } : {}),
  };
};

type CanvasCloneEntityMaps = {
  sourceProjectId: number;
  targetProjectId: number;
  assetIds: Map<number, number>;
  nodeIds: Map<number, number>;
  edgeIds: Map<number, number>;
  agentIds: Map<number, number>;
  threadIds: Map<number, number>;
  messageIdsByAgent: Map<string, number>;
};

const remapCanvasCloneMetadata = (value: unknown, maps: CanvasCloneEntityMaps): unknown => {
  const remapId = (candidate: unknown, idMap: Map<number, number>) => {
    const replacement = idMap.get(Number(candidate));
    if (replacement === undefined) return candidate;
    return typeof candidate === "string" ? String(replacement) : replacement;
  };
  const visit = (candidate: unknown, field = "", inheritedAgentId?: number): unknown => {
    if (Array.isArray(candidate)) return candidate.map(item => visit(item, field, inheritedAgentId));
    if (!isPlainRecord(candidate)) {
      if (field === "projectId" || field === "canvasProjectId") {
        return Number(candidate) === maps.sourceProjectId
          ? (typeof candidate === "string" ? String(maps.targetProjectId) : maps.targetProjectId)
          : candidate;
      }
      if (["nodeId", "canvasNodeId", "sourceNodeId", "targetNodeId", "generatedNodeId"].includes(field)) {
        return remapId(candidate, maps.nodeIds);
      }
      if (["edgeId", "atomflowEdgeId"].includes(field)) return remapId(candidate, maps.edgeIds);
      if (["agentId", "canvasAgentId", "generatedByAgentId", "sourceAgentId"].includes(field)) {
        return remapId(candidate, maps.agentIds);
      }
      if (field === "threadId") return remapId(candidate, maps.threadIds);
      if (["assetId", "canvasAssetId", "sourceAssetId", "generatedAssetId"].includes(field)) {
        return remapId(candidate, maps.assetIds);
      }
      if (["messageId", "assistantMessageId"].includes(field) && inheritedAgentId) {
        const replacement = maps.messageIdsByAgent.get(`${inheritedAgentId}:${Number(candidate)}`);
        if (replacement !== undefined) return typeof candidate === "string" ? String(replacement) : replacement;
        // A retained pointer to a source-project message is misleading and may
        // collide with another thread after cloning. Keep provenance content,
        // but explicitly clear references outside the bounded cloned history.
        if (maps.agentIds.has(inheritedAgentId)) return null;
      }
      if (field === "resultKey" && inheritedAgentId && typeof candidate === "string") {
        const messageResult = candidate.match(/^message:(\d+)$/);
        if (messageResult) {
          const replacement = maps.messageIdsByAgent.get(`${inheritedAgentId}:${Number(messageResult[1])}`);
          if (replacement !== undefined) return `message:${replacement}`;
        }
      }
      if (typeof candidate === "string") {
        const canvasNodeMatch = candidate.match(/^canvas-node:(\d+):(.*)$/);
        if (canvasNodeMatch) {
          const clonedNodeId = maps.nodeIds.get(Number(canvasNodeMatch[1]));
          if (clonedNodeId !== undefined) return `canvas-node:${clonedNodeId}:${canvasNodeMatch[2]}`;
        }
        if (field.toLowerCase().includes("endpoint")) {
          return candidate.replace(/\/api\/write\/canvas\/agents\/(\d+)\//g, (match, rawAgentId: string) => {
            const clonedAgentId = maps.agentIds.get(Number(rawAgentId));
            return clonedAgentId === undefined ? match : `/api/write/canvas/agents/${clonedAgentId}/`;
          });
        }
      }
      return candidate;
    }
    const markerAgentId = Number(candidate.__atomflowCloneSourceAgentId);
    const sourceAgentId = Number(candidate.sourceAgentId ?? candidate.agentId);
    const contextualAgentId = Number.isSafeInteger(markerAgentId) && markerAgentId > 0
      ? markerAgentId
      : Number.isSafeInteger(sourceAgentId) && sourceAgentId > 0
        ? sourceAgentId
        : inheritedAgentId;
    return Object.fromEntries(
      Object.entries(candidate)
        .filter(([key]) => key !== "__atomflowCloneSourceAgentId" && key !== "__atomflowCloneSourceMessageId")
        .map(([key, child]) => [key, visit(child, key, contextualAgentId)]),
    );
  };
  return visit(value);
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
  documentSnapshot: row.documentSnapshot ?? row.tldrawSnapshot ?? row.tldraw_snapshot ?? row.document_snapshot ?? null,
  documentRevision: Number(row.documentRevision ?? row.document_revision ?? 0),
  documentSchemaVersion: Number(row.documentSchemaVersion ?? row.document_schema_version ?? 0),
  tldrawSnapshot: row.documentSnapshot ?? row.tldrawSnapshot ?? row.tldraw_snapshot ?? row.document_snapshot ?? null,
  tldrawRevision: Number(row.documentRevision ?? row.document_revision ?? 0),
  tldrawSchemaVersion: Number(row.documentSchemaVersion ?? row.document_schema_version ?? 0),
  defaultSkillConfig: normalizeCanvasSkillConfig(row.defaultSkillConfig ?? row.default_skill_config, "override"),
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
  threadId: row.threadId ?? row.agentThreadId ?? row.agent_thread_id
    ? Number(row.threadId ?? row.agentThreadId ?? row.agent_thread_id)
    : null,
  skillConfig: normalizeCanvasSkillConfig(row.skillConfig ?? row.skill_config),
  effectiveSkillConfig: row.effectiveSkillConfig,
  effectiveSkills: row.effectiveSkills,
  createdAt: row.createdAt || row.created_at,
  updatedAt: row.updatedAt || row.updated_at
}) : null;

const mapCanvasNodeRow = (row: any) => ({
  id: Number(row.id),
  projectId: Number(row.projectId ?? row.project_id),
  kind: row.kind as WriteCanvasNodeKind,
  title: row.title as string,
  summary: row.summary || "",
  refId: row.refId ?? row.ref_id ?? null,
  asset: mapCanvasAssetRow(row.asset || null),
  agent: mapCanvasAgentRow(row.agent || null),
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
  relation: "context" as const,
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
  skillConfig: normalizeCanvasSkillConfig(row.skillConfig ?? row.skill_config),
  effectiveSkillConfig: row.effectiveSkillConfig,
  effectiveSkills: row.effectiveSkills,
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
    if (message.ok) finish(() => resolve(normalizePlainText(message.text || "").slice(0, WRITE_AGENT_MAX_MESSAGE_LENGTH)));
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

const getCanvasStoredBytes = async (client: pg.PoolClient, userId: number) => Number((await client.query(
  `SELECT COALESCE(SUM(
     octet_length(COALESCE(data_url, '')) +
     octet_length(COALESCE(content_text, '')) +
     octet_length(COALESCE(extracted_text, ''))
   ), 0) AS bytes
   FROM write_canvas_assets
   WHERE user_id = $1`,
  [userId],
)).rows[0]?.bytes || 0);

const ensureCanvasProject = async (pool: pg.Pool, userId: number) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockCanvasUser(client, userId);
    const existing = (await client.query(
      `SELECT id, name, viewport, tldraw_snapshot AS "documentSnapshot",
              document_revision AS "documentRevision", document_schema_version AS "documentSchemaVersion",
              default_skill_config AS "defaultSkillConfig",
              created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"
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
       RETURNING id, name, viewport, tldraw_snapshot AS "documentSnapshot",
                 document_revision AS "documentRevision", document_schema_version AS "documentSchemaVersion",
                 default_skill_config AS "defaultSkillConfig",
                 created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"`,
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

const ensureCanvasAgentThread = async (pool: pg.Pool, userId: number, agentId: number) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockCanvasUser(client, userId);
    const agent = (await client.query(
      `SELECT ai.id, ai.agent_thread_id, ai.name, ai.project_id
       FROM write_agent_instances ai
       WHERE ai.id = $1 AND ai.user_id = $2
       FOR UPDATE`,
      [agentId, userId],
    )).rows[0];
    if (!agent) {
      await client.query("ROLLBACK");
      return null;
    }
    if (agent.agent_thread_id) {
      const ownedThread = (await client.query(
        `SELECT id FROM write_agent_threads
         WHERE id = $1 AND user_id = $2 AND thread_type = 'canvas'`,
        [agent.agent_thread_id, userId],
      )).rows[0];
      if (ownedThread) {
        await client.query("COMMIT");
        return Number(ownedThread.id);
      }
    }

    const thread = (await client.query(
      `INSERT INTO write_agent_threads (user_id, title, state, thread_type)
       VALUES ($1, $2, $3, 'canvas')
       RETURNING id`,
      [
        userId,
        `${String(agent.name || "写作 Agent").slice(0, 80)} · 画布会话`,
        JSON.stringify({ canvasAgentId: agentId, canvasProjectId: Number(agent.project_id) }),
      ],
    )).rows[0];
    const threadId = Number(thread.id);
    await client.query(
      `INSERT INTO write_agent_messages (thread_id, role, content, meta, created_at)
       SELECT $1, legacy.role, legacy.content,
              COALESCE(legacy.meta, '{}'::jsonb) || jsonb_build_object('legacyCanvasMessageId', legacy.id),
              legacy.created_at
       FROM (
         SELECT id, role, content, meta, created_at
         FROM (
           SELECT id, role, content, meta, created_at,
                  ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS message_rank,
                  SUM(
                    octet_length(COALESCE(content, '')::text)
                    + octet_length(COALESCE(meta, '{}'::jsonb)::text)
                  ) OVER (ORDER BY created_at DESC, id DESC) AS cumulative_message_bytes
           FROM write_canvas_agent_messages
           WHERE user_id = $2 AND agent_id = $3
             AND role IN ('user', 'assistant')
         ) bounded
         WHERE message_rank <= $4
           AND cumulative_message_bytes <= $5
         ORDER BY created_at ASC, id ASC
       ) legacy`,
      [
        threadId,
        userId,
        agentId,
        WRITE_CANVAS_MAX_MESSAGES_PER_AGENT,
        WRITE_CANVAS_LEGACY_THREAD_MIGRATION_MAX_BYTES,
      ],
    );
    await client.query(
      `UPDATE write_agent_instances
       SET agent_thread_id = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3`,
      [threadId, agentId, userId],
    );
    await client.query("COMMIT");
    return threadId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const fetchCanvasProjectDetail = async (pool: pg.Pool, userId: number, projectId: number) => {
  const projectRow = (await pool.query(
    `SELECT id, name, viewport, tldraw_snapshot AS "documentSnapshot",
               document_revision AS "documentRevision", document_schema_version AS "documentSchemaVersion",
               default_skill_config AS "defaultSkillConfig",
               created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"
     FROM write_canvas_projects
     WHERE id = $1 AND user_id = $2`,
    [projectId, userId]
  )).rows[0];
  if (!projectRow) return null;

  const nodeRows = (await pool.query(
    `SELECT n.id, n.project_id AS "projectId", n.kind, n.title, n.summary, n.ref_id AS "refId",
            n.meta, n.x, n.y, n.width, n.height, n.created_at AS "createdAt", n.updated_at AS "updatedAt",
            CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', a.id, 'type', a.type, 'title', a.title,
              'contentText', a.content_text, 'extractedText', a.extracted_text,
              'fileName', a.file_name, 'mimeType', a.mime_type,
              'dataUrl', a.data_url, 'meta', a.meta, 'createdAt', a.created_at
            ) END AS asset,
            CASE WHEN ai.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', ai.id, 'projectId', ai.project_id, 'templateId', ai.template_id,
              'name', ai.name, 'model', ai.model, 'systemPrompt', ai.system_prompt,
              'temperature', ai.temperature, 'topP', ai.top_p, 'maxTokens', ai.max_tokens,
              'skillConfig', ai.skill_config, 'threadId', wat.id,
              'createdAt', ai.created_at, 'updatedAt', ai.updated_at
            ) END AS agent
     FROM write_canvas_nodes n
     LEFT JOIN write_canvas_assets a ON a.id = n.asset_id AND a.user_id = n.user_id
     LEFT JOIN write_agent_instances ai ON ai.id = n.agent_id AND ai.user_id = n.user_id
     LEFT JOIN write_agent_threads wat ON wat.id = ai.agent_thread_id
       AND wat.user_id = ai.user_id AND wat.thread_type = 'canvas'
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
    const missingThreadAgentIds = nodeRows.flatMap(node => node.agent && !node.agent.threadId ? [node.agent.id] : []);
    for (const agentId of missingThreadAgentIds) {
      const threadId = await ensureCanvasAgentThread(pool, userId, agentId);
      const node = nodeRows.find(candidate => candidate.agent?.id === agentId);
      if (node?.agent) node.agent.threadId = threadId;
    }
    const messageRows = (await pool.query(
      `SELECT id, agent_id AS "agentId", role, content, meta, created_at AS "createdAt"
       FROM (
         SELECT wam.id, ai.id AS agent_id, wam.role, wam.content, wam.meta, wam.created_at,
                ROW_NUMBER() OVER (PARTITION BY ai.id ORDER BY wam.created_at DESC, wam.id DESC) AS message_rank
         FROM write_agent_instances ai
         JOIN write_agent_messages wam ON wam.thread_id = ai.agent_thread_id
         WHERE ai.user_id = $1 AND ai.id = ANY($2::bigint[])
           AND wam.role IN ('user', 'assistant')
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

  const availableSkills = await fetchWriteAgentSkills(pool, userId);
  const skillResolutionCache = new Map<string, ReturnType<typeof resolveEffectiveCanvasSkillsFromAvailable>>();
  const resolveCachedSkills = (
    value: unknown,
    inheritedValue?: unknown,
    emptyMode: "inherit" | "override" = inheritedValue === undefined ? "override" : "inherit",
  ) => {
    const key = JSON.stringify({
      own: normalizeCanvasSkillConfig(value, emptyMode),
      inherited: inheritedValue === undefined ? null : normalizeCanvasSkillConfig(inheritedValue, "override"),
    });
    const existing = skillResolutionCache.get(key);
    if (existing) return existing;
    const resolved = resolveEffectiveCanvasSkillsFromAvailable(availableSkills, value, inheritedValue, emptyMode);
    skillResolutionCache.set(key, resolved);
    return resolved;
  };
  const projectSkills = resolveCachedSkills(projectRow.defaultSkillConfig, undefined, "override");
  const project = {
    ...mapCanvasProjectRow(projectRow),
    defaultSkillConfig: projectSkills.skillConfig,
    effectiveSkillConfig: projectSkills.effectiveSkillConfig,
    effectiveSkills: projectSkills.effectiveSkills,
  };
  for (const node of nodeRows) {
    if (!node.agent) continue;
    const agentSkills = resolveCachedSkills(node.agent.skillConfig, projectRow.defaultSkillConfig, "inherit");
    node.agent.skillConfig = agentSkills.skillConfig;
    node.agent.effectiveSkillConfig = agentSkills.effectiveSkillConfig;
    node.agent.effectiveSkills = agentSkills.effectiveSkills;
  }

  return {
    project,
    nodes: nodeRows,
    edges: edgeRows,
    messages
  };
};

const getCanvasAgentNode = async (pool: pg.Pool, userId: number, agentId: number) => {
  return (await pool.query(
    `SELECT n.id AS node_id, n.project_id, p.default_skill_config AS project_default_skill_config, ai.*
     FROM write_agent_instances ai
     JOIN write_canvas_nodes n ON n.agent_id = ai.id AND n.user_id = ai.user_id
     JOIN write_canvas_projects p ON p.id = ai.project_id AND p.user_id = ai.user_id
     WHERE ai.id = $1 AND ai.user_id = $2 AND n.kind = 'agent'`,
    [agentId, userId]
  )).rows[0];
};

const ensureCanvasGeneratedNoteNode = async (
  pool: pg.Pool,
  userId: number,
  agentId: number,
  noteValue: unknown,
  threadId: number,
  runId: string,
) => {
  const noteId = isPlainRecord(noteValue) ? Number(noteValue.id) : Number(noteValue);
  if (!Number.isSafeInteger(noteId) || noteId <= 0) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockCanvasUser(client, userId);
    const agent = (await client.query(
      `SELECT n.id AS node_id, n.project_id, n.x, n.y, n.width
       FROM write_agent_instances ai
       JOIN write_canvas_nodes n
         ON n.agent_id = ai.id AND n.user_id = ai.user_id AND n.project_id = ai.project_id
       WHERE ai.id = $1 AND ai.user_id = $2 AND n.kind = 'agent'
       FOR UPDATE OF ai, n`,
      [agentId, userId],
    )).rows[0];
    if (!agent) throw new Error("Canvas Agent no longer exists");
    const note = (await client.query(
      `SELECT id, title, content, tags, meta, created_at, updated_at
       FROM notes
       WHERE id = $1 AND user_id = $2
       FOR SHARE`,
      [noteId, userId],
    )).rows[0];
    if (!note) throw new Error("Generated note no longer exists");

    let nodeRow = (await client.query(
      `SELECT id, project_id AS "projectId", kind, title, summary, ref_id AS "refId",
              meta, x, y, width, height, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM write_canvas_nodes
       WHERE user_id = $1 AND project_id = $2 AND kind = 'note' AND ref_id = $3
       ORDER BY id ASC
       LIMIT 1
       FOR UPDATE`,
      [userId, Number(agent.project_id), String(noteId)],
    )).rows[0];
    if (!nodeRow) {
      const nodeCount = Number((await client.query(
        `SELECT COUNT(*)::int AS count
         FROM write_canvas_nodes
         WHERE user_id = $1 AND project_id = $2`,
        [userId, Number(agent.project_id)],
      )).rows[0]?.count || 0);
      if (nodeCount >= WRITE_CANVAS_MAX_NODES_PER_PROJECT) {
        throw new Error("项目节点数量已达到上限，文章已保存但无法添加到画布");
      }
      nodeRow = (await client.query(
        `INSERT INTO write_canvas_nodes
           (user_id, project_id, kind, title, summary, ref_id, meta, x, y, width, height)
         VALUES ($1, $2, 'note', $3, $4, $5, $6, $7, $8, 360, 240)
         RETURNING id, project_id AS "projectId", kind, title, summary, ref_id AS "refId",
                   meta, x, y, width, height, created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          userId,
          Number(agent.project_id),
          String(note.title || "文章草稿").slice(0, 120),
          normalizePlainText(note.content || "").slice(0, 500),
          String(noteId),
          JSON.stringify({ generatedByAgentId: agentId, threadId, runId }),
          Number(agent.x) + Number(agent.width) + 80,
          Number(agent.y),
        ],
      )).rows[0];
    }
    await client.query("COMMIT");
    return mapCanvasNodeRow(nodeRow);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const resolveCanvasContextItems = async (pool: pg.Pool, userId: number, agentNodeId: number, projectId: number): Promise<CanvasContextItem[]> => {
  const sourceRows = (await pool.query(
    `SELECT n.id, n.kind, n.title, n.summary, n.ref_id, n.meta,
            a.id AS asset_id, a.type AS asset_type, a.title AS asset_title, a.content_text,
            a.extracted_text, a.file_name, a.mime_type, a.data_url
     FROM write_canvas_edges e
     JOIN write_canvas_nodes n ON n.id = e.source_node_id AND n.user_id = e.user_id
     LEFT JOIN write_canvas_assets a ON a.id = n.asset_id AND a.user_id = n.user_id
     WHERE e.user_id = $1 AND e.project_id = $2 AND e.target_node_id = $3 AND e.relation = 'context'
     ORDER BY e.created_at ASC
     LIMIT $4`,
    [userId, projectId, agentNodeId, WRITE_CANVAS_MAX_CONTEXT_ITEMS]
  )).rows;

  const items: CanvasContextItem[] = [];
  for (const row of sourceRows) {
    const kind = normalizeCanvasNodeKind(row.kind);
    if (!kind) continue;
    if (["asset_text", "asset_file", "asset_image", "result"].includes(kind)) {
      const text = normalizePlainText([
        row.content_text,
        row.extracted_text,
        row.summary,
        row.meta?.note,
      ].filter(Boolean).join("\n")).slice(0, 12000);
      items.push({
        nodeId: Number(row.id),
        kind,
        title: row.title || row.asset_title || row.file_name || "资料",
        text,
        refId: row.ref_id ? String(row.ref_id) : undefined,
        imageDataUrl: kind === "asset_image" ? row.data_url || undefined : undefined,
        mimeType: row.mime_type || undefined,
        sourceLabel: row.file_name || undefined
      });
      continue;
    }
    if (kind === "saved_article" && row.ref_id) {
      const article = (await pool.query(
        `SELECT id, title, source, url, excerpt, content, citation_context, image_urls,
                audio_url, audio_duration
         FROM saved_articles
         WHERE id = $1 AND user_id = $2`,
        [Number(row.ref_id), userId]
      )).rows[0];
      if (article) {
        items.push({
          nodeId: Number(row.id),
          kind,
          title: article.title,
          refId: String(article.id),
          text: normalizePlainText([
            article.citation_context,
            article.excerpt,
            article.content,
            article.audio_url ? `音频：${article.audio_url}` : "",
            article.audio_duration ? `时长：${article.audio_duration}` : "",
          ].filter(Boolean).join("\n")).slice(0, 12000),
          sourceLabel: article.source || article.url || undefined,
          sourceUrl: article.url || undefined,
          sourceExcerpt: article.excerpt || undefined,
          sourceContext: article.citation_context || undefined,
          savedArticleId: Number(article.id),
        });
      }
      continue;
    }
    if (kind === "atom_card" && row.ref_id) {
      const card = (await pool.query(
        `SELECT sc.id, sc.type, sc.content, sc.summary, sc.original_quote, sc.context,
                sc.citation_note, sc.tags, sc.article_title, sc.article_id, sc.saved_article_id,
                sa.source, sa.url, sa.excerpt, sa.citation_context
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
          refId: String(card.id),
          text: normalizePlainText([
            `[${card.type}] ${card.content}`,
            card.summary,
            card.context,
            card.original_quote ? `原文摘录：${card.original_quote}` : "",
            card.citation_note ? `引用建议：${card.citation_note}` : "",
            card.tags ? `tags：${(typeof card.tags === "string" ? JSON.parse(card.tags) : card.tags).join("、")}` : "",
          ].filter(Boolean).join("\n")).slice(0, 6000),
          sourceLabel: card.source || card.url || undefined,
          sourceUrl: card.url || undefined,
          sourceExcerpt: card.excerpt || undefined,
          sourceContext: card.context || card.citation_context || undefined,
          originalQuote: card.original_quote || undefined,
          articleId: Number.isSafeInteger(Number(card.article_id)) && Number(card.article_id) > 0
            ? Number(card.article_id)
            : undefined,
          savedArticleId: Number.isSafeInteger(Number(card.saved_article_id)) && Number(card.saved_article_id) > 0
            ? Number(card.saved_article_id)
            : undefined,
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
          refId: String(note.id),
          text: normalizePlainText(note.content || "").slice(0, 12000),
          sourceLabel: "我的文章"
        });
      }
      continue;
    }
    if (kind === "citation") {
      const article = isPlainRecord(row.meta?.article) ? row.meta.article : {};
      const selection = isPlainRecord(row.meta?.selection) ? row.meta.selection : {};
      const exact = typeof selection.exact === "string" ? selection.exact.slice(0, 2000) : "";
      const prefix = typeof selection.prefix === "string" ? selection.prefix.slice(-120) : "";
      const suffix = typeof selection.suffix === "string" ? selection.suffix.slice(0, 120) : "";
      const paragraph = typeof selection.paragraph === "string" ? selection.paragraph.slice(0, 8000) : "";
      const articleId = Number(article.id);
      const text = normalizePlainText([
        typeof selection.heading === "string" ? selection.heading : "",
        exact,
        paragraph,
        typeof article.excerpt === "string" ? article.excerpt : "",
      ].filter(Boolean).join("\n")).slice(0, 12000);
      items.push({
        nodeId: Number(row.id),
        kind,
        title: row.title || (typeof article.title === "string" ? article.title : "引用"),
        text,
        refId: row.ref_id ? String(row.ref_id) : undefined,
        sourceLabel: typeof article.source === "string"
          ? article.source
          : typeof article.url === "string" ? article.url : undefined,
        sourceUrl: typeof article.url === "string" ? article.url : undefined,
        sourceExcerpt: typeof article.excerpt === "string" ? article.excerpt : undefined,
        sourceContext: paragraph || [prefix, exact, suffix].filter(Boolean).join(" "),
        originalQuote: exact || undefined,
        articleId: Number.isSafeInteger(articleId) && articleId > 0 ? articleId : undefined,
        captureId: typeof row.meta?.captureId === "string"
          ? row.meta.captureId
          : row.ref_id ? String(row.ref_id) : undefined,
        citationPrefix: prefix || undefined,
        citationSuffix: suffix || undefined,
      });
      continue;
    }
    if (kind === "podcast_episode") {
      const episode = isPlainRecord(row.meta?.episode) ? row.meta.episode : row.meta;
      const episodeSourceUrl = typeof episode.sourceUrl === "string"
        ? episode.sourceUrl
        : typeof episode.url === "string" ? episode.url : undefined;
      const episodeArticleId = Number(episode.articleId);
      const episodeSavedArticleId = Number(episode.savedArticleId);
      items.push({
        nodeId: Number(row.id),
        kind,
        title: row.title || (typeof episode.title === "string" ? episode.title : "播客单集"),
        text: normalizePlainText([
          row.summary,
          typeof episode.excerpt === "string" ? episode.excerpt : "",
        ].filter(Boolean).join("\n")).slice(0, 12000),
        refId: row.ref_id ? String(row.ref_id) : undefined,
        sourceLabel: typeof episode.source === "string"
          ? episode.source
          : episodeSourceUrl,
        sourceUrl: episodeSourceUrl,
        sourceExcerpt: typeof episode.excerpt === "string" ? episode.excerpt : row.summary || undefined,
        sourceContext: row.summary || (typeof episode.excerpt === "string" ? episode.excerpt : undefined),
        articleId: Number.isSafeInteger(episodeArticleId) && episodeArticleId > 0 ? episodeArticleId : undefined,
        savedArticleId: Number.isSafeInteger(episodeSavedArticleId) && episodeSavedArticleId > 0
          ? episodeSavedArticleId
          : undefined,
      });
    }
  }
  let remainingChars = WRITE_CANVAS_MAX_CONTEXT_CHARS;
  return items.flatMap(item => {
    if (remainingChars <= 0 && !item.imageDataUrl) return [];
    const text = item.text.slice(0, Math.max(0, remainingChars));
    remainingChars -= text.length;
    return [{ ...item, text }];
  });
};

const canvasContextsToWritingCards = (contexts: CanvasContextItem[]): WritingCardInput[] => contexts.flatMap(context => {
  const text = context.text || context.title;
  const chunks = text.match(/[\s\S]{1,500}/g)?.slice(0, 4) || [context.title];
  return chunks.map((chunk, index) => ({
    id: context.kind === "atom_card" && context.refId
      ? context.refId
      : `canvas-node:${context.nodeId}:${index}`,
    type: "灵感" as const,
    content: chunk,
    summary: index === 0 ? text.slice(0, 180) : undefined,
    tags: ["画布授权", context.kind],
    articleTitle: chunks.length > 1 ? `${context.title} (${index + 1}/${chunks.length})` : context.title,
    sourceName: context.sourceLabel,
    sourceUrl: context.sourceUrl,
    sourceExcerpt: context.sourceExcerpt,
    sourceContext: context.sourceContext,
    originalQuote: index === 0 ? context.originalQuote : undefined,
    articleId: context.articleId,
    savedArticleId: context.savedArticleId,
    canvasNodeId: context.nodeId,
    captureId: context.captureId,
    citationPrefix: context.citationPrefix,
    citationSuffix: context.citationSuffix,
  }));
});

const canvasModelSupportsImages = (model: string) => {
  const normalized = model.toLowerCase();
  return /(vision|vl|gpt-4o|gpt-4\.1|gpt-5|o3|o4|gemini|claude-3|mimo-vl)/.test(normalized);
};

const selectAuthorizedCanvasImages = (model: string, candidates: string[]) => {
  if (!canvasModelSupportsImages(model)) return [];
  const selected: string[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (selected.length >= 4) break;
    if (typeof candidate !== "string") continue;
    const match = /^data:image\/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(candidate);
    if (!match) continue;
    const padding = match[1].endsWith("==") ? 2 : match[1].endsWith("=") ? 1 : 0;
    const decodedBytes = Math.floor(match[1].length * 3 / 4) - padding;
    if (decodedBytes <= 0 || totalBytes + decodedBytes > WRITE_CANVAS_MAX_CONTEXT_IMAGE_BYTES) continue;
    totalBytes += decodedBytes;
    selected.push(candidate);
  }
  return selected;
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
  signal?: AbortSignal;
}) => {
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
      if (!item.imageDataUrl || imageParts.length >= 4) continue;
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
    signal: input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const responseBody = await response.text();
    logger.error({ module: "canvas-agent", status: response.status, responseBody: responseBody.slice(0, 1000) }, "Canvas agent request failed");
    throw new Error(`AI request failed ${response.status}: ${responseBody}`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return {
    content: (data.choices?.[0]?.message?.content || "").trim(),
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
  storageSkills: WriteAgentSkillRecord[] = []
): Promise<ExtractedKnowledge> => {
  if (!getAiChatConfig()) return { cards: [] };

  try {
    const plainContent = normalizePlainText(
      article.markdownContent || article.content || article.excerpt
    ).slice(0, 5200);

    if (plainContent.length < 30) return { cards: [] };

    const skillPrompt = formatAgentSkillInstructions(storageSkills, ["card_storage", "citation"]);
    const userPrompt = `标题：${article.title}\n来源：${article.source}\n话题：${article.topic}
${skillPrompt ? `\n本次入库必须遵循的 Skills：\n${skillPrompt}` : ""}

正文：${plainContent}`;

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

type BuiltinFeedSource = {
  id: string;
  label: string;
  urls: readonly string[];
  source: string;
  topic: string;
  idOffset: number;
};

const BUILTIN_FEED_SOURCES: readonly BuiltinFeedSource[] = [
  { id: "sspai", label: "少数派", urls: ["rsshub://sspai/index"], source: "少数派", topic: "科技资讯", idOffset: 0 },
  { id: "woshipm", label: "人人都是产品经理", urls: ["https://www.woshipm.com/feed", "rsshub://woshipm/popular"], source: "人人都是产品经理", topic: "产品运营", idOffset: 1000 },
  { id: "36kr", label: "36氪", urls: ["rsshub://36kr/hot-list", "https://36kr.com/feed", "rsshub://36kr/news"], source: "36氪", topic: "创投商业", idOffset: 2000 },
  { id: "huxiu", label: "虎嗅", urls: ["https://www.huxiu.com/rss/0.xml", "rsshub://huxiu/article"], source: "虎嗅", topic: "商业资讯", idOffset: 3000 },
  { id: "zslren", label: "数字生命卡兹克", urls: ["https://wechat2rss.bestblogs.dev/feed/ff621c3e98d6ae6fceb3397e57441ffc6ea3c17f.xml"], source: "数字生命卡兹克", topic: "公众号", idOffset: 4000 },
  { id: "xzy", label: "新智元", urls: ["https://plink.anyfeeder.com/weixin/AI_era"], source: "新智元", topic: "公众号", idOffset: 4500 },
  { id: "jike", label: "即刻话题", urls: ["rsshub://jike/topic/63579abb6724cc583b9bba9a"], source: "即刻话题", topic: "Jike", idOffset: 6000 },
  { id: "github", label: "GitHub Blog", urls: ["https://github.blog/feed/"], source: "GitHub Blog", topic: "Tech", idOffset: 7000 },
  { id: "sama", label: "Sam Altman Twitter", urls: ["rsshub://twitter/user/sama"], source: "Sam Altman", topic: "Twitter", idOffset: 8000 },
  { id: "xyzfm", label: "张小珺商业访谈录", urls: ["https://feed.xyzfm.space/dk4yh3pkpjp3"], source: "张小珺商业访谈录", topic: "Podcast", idOffset: 9000 },
  { id: "lex", label: "Lex Fridman", urls: ["rsshub://youtube/user/%40lexfridman", "https://www.youtube.com/feeds/videos.xml?channel_id=UCSHZKyawb77ixDdsGog4iWA"], source: "Lex Fridman", topic: "Podcast", idOffset: 10000 },
  { id: "yc", label: "Y Combinator", urls: ["rsshub://youtube/user/%40ycombinator", "https://www.youtube.com/feeds/videos.xml?channel_id=UCcefcZRL2oaA_uBNeo5UOWg"], source: "Y Combinator", topic: "YouTube", idOffset: 11000 },
  { id: "karpathy", label: "Andrej Karpathy", urls: ["rsshub://youtube/user/@AndrejKarpathy", "https://www.youtube.com/feeds/videos.xml?channel_id=UCYO_jab_esuFRV4b17AJtAw"], source: "Andrej Karpathy", topic: "YouTube", idOffset: 12000 },
  { id: "aiHotSelected", label: "AI HOT 精选", urls: ["https://aihot.virxact.com/feed.xml"], source: "AI HOT 精选", topic: "AI 资讯", idOffset: 13000 },
];

async function fetchBuiltinFeedSource(source: BuiltinFeedSource, parentSignal: AbortSignal): Promise<Article[]> {
  const sourceSignal = AbortSignal.any([parentSignal, AbortSignal.timeout(20_000)]);
  const parsed = await parseFirstAvailable([...source.urls], sourceSignal);
  return normalizeFeedItems(
    parsed.items || [],
    source.source,
    source.topic,
    source.idOffset,
    extractFeedIcon(parsed),
  );
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 1000);
  const billingConfig = loadBillingConfig(isProduction);
  const appUrl = process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  if (isProduction && (!appUrl || /your-domain\.example|replace-/i.test(appUrl))) {
    throw new Error("APP_URL or RAILWAY_PUBLIC_DOMAIN must identify the real production origin");
  }
  validateProductionLegalConfiguration(appUrl, billingConfig.enabled);
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  if (isProduction && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable must be set in production");
  }

  // Railway runs the idempotent schema migration as a pre-deploy command.
  // The web process only verifies the version marker so it can bind its port quickly.
  let pool: pg.Pool | null = null;
  let schemaReady = false;
  try {
    pool = createDatabasePool(logger);
    await pool.query("SELECT 1");
    schemaReady = await verifyDatabaseSchema(pool);
    if (schemaReady) {
      logger.info({ module: "db", schemaVersion: DATABASE_SCHEMA_VERSION }, "Database connected and schema version verified");
    } else {
      logger.error({ module: "db", expectedSchemaVersion: DATABASE_SCHEMA_VERSION }, "Database schema version is not ready; run npm run migrate");
    }
  } catch (err) {
    await pool?.end().catch(() => undefined);
    pool = null;
    if (isProduction) throw err;
    logger.warn({ err, module: "db" }, "Database unavailable; server will start without auth/persistence features");
  }

  const billingService = pool && schemaReady ? new BillingService(pool, billingConfig, logger) : null;
  billingService?.startWorkers();

  const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

  // Gmail SMTP transporter (preferred over Resend for free usage)
  const smtpTransporter = process.env.SMTP_USER && process.env.SMTP_PASS
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      })
    : null;

  const sendRssRuntimeAlert = async (alert: RssRuntimeAlert) => {
    const recipient = process.env.SECURITY_CONTACT_EMAIL?.trim();
    if (!recipient) throw new Error("SECURITY_CONTACT_EMAIL is not configured for RSS memory alerts");
    const rssMegabytes = Math.round((alert.rssBytes / 1024 / 1024) * 10) / 10;
    const subject = `[AtomFlow] ${alert.kind} (${rssMegabytes} MB)`;
    const textContent = `${alert.message}\n\nRSS: ${rssMegabytes} MB\nTime: ${alert.occurredAt}`;
    if (resend) {
      const result = await resend.emails.send({
        from: "AtomFlow <noreply@atomflow.cloud>",
        to: recipient,
        subject,
        text: textContent,
      });
      if (result.error) throw new Error(`Resend RSS alert failed: ${result.error.message}`);
      return;
    }
    if (smtpTransporter) {
      await smtpTransporter.sendMail({
        from: `AtomFlow <${process.env.SMTP_USER}>`,
        to: recipient,
        subject,
        text: textContent,
      });
      return;
    }
    throw new Error("No email transport is configured for RSS memory alerts");
  };

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
  const canvasDocumentUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: WRITE_CANVAS_DOCUMENT_MAX_BYTES,
      files: 1,
      fields: 8,
      parts: 9,
      fieldNameSize: 100,
      fieldSize: WRITE_CANVAS_DOCUMENT_MAX_BYTES,
    },
    fileFilter: (_req, file, cb) => {
      cb(null, ["application/json", "application/octet-stream", "text/json", "text/plain"].includes(file.mimetype));
    },
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

  const paddleFrameOrigins = billingConfig.environment === "sandbox"
    ? ["https://sandbox-buy.paddle.com"]
    : ["https://buy.paddle.com"];
  const paddleConnectOrigins = billingConfig.environment === "sandbox"
    ? ["https://sandbox-create-checkout.paddle.com", "https://sandbox-api.paddle.com"]
    : ["https://create-checkout.paddle.com", "https://api.paddle.com"];
  const paddleCdnOrigin = "https://cdn.paddle.com";
  const paddleStyleOrigins = billingConfig.environment === "sandbox"
    ? ["https://sandbox-cdn.paddle.com"]
    : [paddleCdnOrigin];
  app.use(helmet({
    contentSecurityPolicy: isProduction ? {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", ...(billingConfig.enabled ? paddleConnectOrigins : [])],
        fontSrc: ["'self'", "data:"],
        frameAncestors: ["'none'"],
        frameSrc: billingConfig.enabled ? paddleFrameOrigins : ["'none'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", ...(billingConfig.enabled ? [paddleCdnOrigin] : [])],
        styleSrc: ["'self'", "'unsafe-inline'", ...(billingConfig.enabled ? paddleStyleOrigins : [])],
        workerSrc: ["'self'", "blob:"],
      },
    } : false,
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
  app.post("/api/billing/webhooks/paddle", express.raw({ type: "application/json", limit: "256kb" }), asyncHandler(async (req, res) => {
    if (!billingService || !billingConfig.enabled) {
      return res.status(503).json({ code: "BILLING_UNAVAILABLE", error: "账单服务未启用" });
    }
    const signature = req.get("paddle-signature") || "";
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      await billingService.receiveWebhook(rawBody, signature);
      return res.status(200).json({ received: true });
    } catch (error) {
      if (error instanceof BillingError) {
        return res.status(error.status).json({ code: error.code, error: error.message });
      }
      throw error;
    }
  }));
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
  const articleSaveConcurrencyGuard = createUserConcurrencyGuard(1);
  const canvasAgentConcurrencyGuard = createUserConcurrencyGuard(1);
  const mediaProxyUserConcurrencyGuard = createUserConcurrencyGuard(
    readBoundedEnvNumber(process.env.MEDIA_PROXY_USER_CONCURRENCY, 2, 1, 4),
  );
  const mediaProxyGlobalConcurrencyGuard = createUserConcurrencyGuard(
    readBoundedEnvNumber(process.env.MEDIA_PROXY_GLOBAL_CONCURRENCY, 8, 2, 20),
  );
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
    res.once("finish", release);
    res.once("close", release);
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

  let rssRuntime: RssRuntimeController<BuiltinFeedSource, Article[]> | null = null;

  app.get("/api/health", asyncHandler(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!pool || !schemaReady) {
      return res.status(503).json({ status: "unhealthy", database: pool ? "schema-unavailable" : "unavailable" });
    }
    try {
      schemaReady = await verifyDatabaseSchema(pool);
      if (!schemaReady) {
        return res.status(503).json({ status: "unhealthy", database: "schema-unavailable" });
      }
      const rssStatus = rssRuntime?.getStatus();
      return res.json({
        status: "ok",
        database: "connected",
        schemaVersion: DATABASE_SCHEMA_VERSION,
        rss: rssStatus ? {
          state: rssStatus.refresh.pausedForMemory
            ? "paused-memory"
            : rssStatus.refresh.inProgress ? "refreshing" : "active",
          lastCompletedAt: rssStatus.refresh.lastCompletedAt,
          lastSuccessfulAt: rssStatus.refresh.lastSuccessfulAt,
          maxConsecutiveFailures: Math.max(
            0,
            ...Object.values(rssStatus.sources).map(source => source.consecutiveFailures),
          ),
        } : { state: "starting", lastCompletedAt: null, lastSuccessfulAt: null, maxConsecutiveFailures: 0 },
      });
    } catch (error) {
      logger.warn({ err: error, module: "db" }, "Database health check failed");
      return res.status(503).json({ status: "unhealthy", database: "unavailable" });
    }
  }));

  // In-memory database for prototype
  let articles: Article[] = [];
  const fullArticleImageAuthorizationCache = new Map<string, { expiresAt: number; imageUrls: string[] }>();
  const rememberFullArticleImages = (article: Article) => {
    const key = article.url || `${article.source}\u0000${article.title}`;
    fullArticleImageAuthorizationCache.set(key, {
      expiresAt: Date.now() + 60 * 60 * 1000,
      imageUrls: extractImageUrlsFromArticle(article, 48),
    });
    while (fullArticleImageAuthorizationCache.size > 500) {
      const oldestKey = fullArticleImageAuthorizationCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      fullArticleImageAuthorizationCache.delete(oldestKey);
    }
  };
  const isCachedFullArticleImage = (imageUrl: string) => {
    const now = Date.now();
    for (const [key, cached] of fullArticleImageAuthorizationCache) {
      if (cached.expiresAt <= now) {
        fullArticleImageAuthorizationCache.delete(key);
        continue;
      }
      if (cached.imageUrls.includes(imageUrl)) return true;
    }
    return false;
  };
  const cachedArticles = await loadArticlesCache();
  if (cachedArticles.length > 0) {
    articles = cachedArticles;
  } else {
    articles = [...MOCK_ARTICLES];
  }

  const rssRefreshIntervalMs = readBoundedEnvNumber(process.env.RSS_REFRESH_INTERVAL_MINUTES, 30, 5, 360) * 60 * 1000;
  const rssMemoryWarningBytes = readBoundedEnvNumber(process.env.RSS_MEMORY_WARNING_MB, 600, 256, 4096) * 1024 * 1024;
  const rssMemoryPauseBytes = readBoundedEnvNumber(process.env.RSS_MEMORY_PAUSE_MB, 700, 300, 6144) * 1024 * 1024;
  const rssMemoryResumeBytes = readBoundedEnvNumber(process.env.RSS_MEMORY_RESUME_MB, 550, 128, 4096) * 1024 * 1024;
  const rssMaxConcurrency = readBoundedEnvNumber(process.env.RSS_MAX_CONCURRENCY, RSS_MAX_CONCURRENCY, 1, 8);
  const onRssRuntimeEvent = (event: RssRuntimeEvent) => {
    const memory = process.memoryUsage();
    const runtimeStatus = rssRuntime?.getStatus();
    const payload = {
      module: "rss-runtime",
      event: event.event,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      articleCount: articles.length,
      configuredConcurrency: rssMaxConcurrency,
      activeSources: runtimeStatus?.refresh.activeSources ?? 0,
      maxObservedActiveSources: runtimeStatus?.refresh.maxObservedActiveSources ?? 0,
      lastCycleDurationMs: runtimeStatus?.refresh.lastDurationMs ?? null,
      ...(event.details || {}),
    };
    if (event.event === "memory-alert-failed") logger.error(payload, "RSS memory alert failed");
    else if (event.event === "source-failed") logger.warn(payload, "RSS source refresh failed");
    else logger.info(payload, "RSS runtime event");
  };

  rssRuntime = new RssRuntimeController<BuiltinFeedSource, Article[]>({
    getSources: () => BUILTIN_FEED_SOURCES,
    getSourceId: source => source.id,
    refreshSource: fetchBuiltinFeedSource,
    refreshIntervalMs: rssRefreshIntervalMs,
    concurrency: rssMaxConcurrency,
    memoryWarningBytes: rssMemoryWarningBytes,
    memoryPauseBytes: rssMemoryPauseBytes,
    memoryResumeBytes: rssMemoryResumeBytes,
    sendAlert: sendRssRuntimeAlert,
    onEvent: onRssRuntimeEvent,
    onCycleComplete: async ({ results, failureCount, skippedSourceCount }) => {
      const counts = Object.fromEntries(BUILTIN_FEED_SOURCES.map(source => [source.id, results.get(source.id)?.length || 0]));
      const fresh = Array.from(results.values()).flat();
      logger.info({ module: "rss", counts, freshCount: fresh.length, failureCount, skippedSourceCount }, "RSS feed counts");
      if (fresh.length === 0) {
        logger.info({ module: "rss" }, "No fresh articles fetched, keeping existing data");
        return;
      }
      const withFallback = mergeWithSourceFallback(articles, fresh);
      articles = mergeArticles(articles, rankArticles(withFallback)).slice(0, RSS_GLOBAL_ARTICLE_LIMIT);
      await saveArticlesCache(articles);
      logger.info({ module: "rss", articleCount: articles.length }, "Loaded articles");
    },
  });
  logger.info({ module: "rss", articleCount: articles.length }, "Using cached or fallback articles, starting bounded refresh runtime");
  rssRuntime.start();

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

  app.post("/api/auth/verify", verificationCheckLimiter, asyncHandler(async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
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

  app.post("/api/auth/register/verify", verificationCheckLimiter, asyncHandler(async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
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
    isRecentAuthentication(req.session.reauthenticatedAt)
  );

  const requireRecentAuthentication: express.RequestHandler = (req, res, next) => {
    if (!hasRecentAuthentication(req)) {
      return res.status(403).json({ code: "REAUTH_REQUIRED", error: "请重新登录后再执行此账户操作" });
    }
    next();
  };

  const sendBillingError = (res: express.Response, error: unknown) => {
    if (error instanceof BillingError) {
      return res.status(error.status).json({ code: error.code, error: error.message });
    }
    logger.error({ err: error, module: "billing" }, "Billing request failed");
    return res.status(503).json({ code: "BILLING_UNAVAILABLE", error: "账单服务暂时不可用" });
  };

  const requireMagicWritingReadAccess: express.RequestHandler = asyncHandler(async (req, res, next) => {
    if (!billingConfig.enabled) return next();
    if (!billingService) return res.status(503).json({ code: "BILLING_UNAVAILABLE", error: "账单服务暂时不可用" });
    try {
      const status = await billingService.resolveMagicWritingAccess(req.session.userId!);
      if (status.access === "full" || status.access === "read_only") return next();
      return res.status(402).json({ code: "MAGIC_WRITE_SUBSCRIPTION_REQUIRED", error: "魔法写作需要 Pro 订阅" });
    } catch (error) {
      return sendBillingError(res, error);
    }
  });

  const requireMagicWritingFullAccess: express.RequestHandler = asyncHandler(async (req, res, next) => {
    if (!billingConfig.enabled) return next();
    if (!billingService) return res.status(503).json({ code: "BILLING_UNAVAILABLE", error: "账单服务暂时不可用" });
    try {
      const status = await billingService.resolveMagicWritingAccess(req.session.userId!);
      if (status.access === "full") return next();
      const code = status.access === "read_only" ? "MAGIC_WRITE_READ_ONLY" : "MAGIC_WRITE_SUBSCRIPTION_REQUIRED";
      const error = status.access === "read_only" ? "当前魔法写作空间为只读" : "魔法写作需要 Pro 订阅";
      return res.status(402).json({ code, error });
    } catch (billingError) {
      return sendBillingError(res, billingError);
    }
  });

  app.get("/api/billing/plans", asyncHandler(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!billingConfig.enabled) {
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json({ enabled: false, plans: billingConfig.plans });
    }
    if (!billingService) return res.status(503).json({ code: "BILLING_UNAVAILABLE", error: "账单服务暂时不可用" });
    try {
      const plans = await billingService.getValidatedPlans();
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json({ enabled: true, plans });
    } catch (error) {
      return sendBillingError(res, error);
    }
  }));

  app.get("/api/billing/status", requireAuth, asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!billingService) return res.status(503).json({ code: "BILLING_UNAVAILABLE", error: "账单服务暂时不可用" });
    try {
      const status = await billingService.resolveMagicWritingAccess(req.session.userId!);
      const scheduledCancelAt = status.scheduledChange
        ? String(status.scheduledChange.effective_at || status.scheduledChange.effectiveAt || status.currentPeriodEndsAt || "") || null
        : null;
      return res.json({
        enabled: billingConfig.enabled,
        access: status.access,
        subscriptionStatus: status.subscriptionStatus,
        planCode: status.planCode,
        currentPeriodEnd: status.currentPeriodEndsAt,
        scheduledCancelAt,
        paymentActionRequired: status.paymentActionRequired,
        hasLegacyWriteData: status.hasWritingHistory,
        hasBillingCustomer: status.hasBillingCustomer,
      });
    } catch (error) {
      return sendBillingError(res, error);
    }
  }));

  app.post("/api/billing/checkout", requireAuth, asyncHandler(async (req, res) => {
    if (!billingService || !billingConfig.enabled) return res.status(503).json({ code: "BILLING_UNAVAILABLE", error: "账单服务未启用" });
    const planCode = req.body?.planCode;
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId.trim() : "";
    if (!isBillingPlanCode(planCode)) return res.status(400).json({ code: "INVALID_BILLING_PLAN", error: "套餐无效" });
    try {
      return res.json(await billingService.createCheckout(req.session.userId!, req.session.email || "", planCode, requestId));
    } catch (error) {
      return sendBillingError(res, error);
    }
  }));

  app.post("/api/billing/portal", requireAuth, asyncHandler(async (req, res) => {
    if (!billingService || !billingConfig.enabled) return res.status(503).json({ code: "BILLING_UNAVAILABLE", error: "账单服务未启用" });
    try {
      res.setHeader("Cache-Control", "no-store");
      return res.json(await billingService.createPortal(req.session.userId!));
    } catch (error) {
      return sendBillingError(res, error);
    }
  }));

  app.use("/api/notes", requireAuth, (req, res, next) => (
    req.method === "GET" || req.method === "HEAD"
      ? requireMagicWritingReadAccess(req, res, next)
      : requireMagicWritingFullAccess(req, res, next)
  ));
  app.use("/api/write", requireAuth, (req, res, next) => (
    req.method === "GET" || req.method === "HEAD"
      ? requireMagicWritingReadAccess(req, res, next)
      : requireMagicWritingFullAccess(req, res, next)
  ));

  const reserveDailyAiBudget = async (
    userId: number,
    reservedOutputTokens: number,
    database: pg.Pool | pg.PoolClient = pool,
  ) => {
    const maxOperations = readBoundedEnvNumber(process.env.PAID_OPERATION_DAILY_LIMIT, 100, 1, 10000);
    const maxOutputTokens = readBoundedEnvNumber(process.env.PAID_OUTPUT_TOKENS_DAILY_LIMIT, 200_000, 1000, 10_000_000);
    return (await database.query(
      `INSERT INTO user_ai_usage_daily (user_id, usage_date, operation_count, reserved_output_tokens)
       SELECT $1, CURRENT_DATE, 1, $2
       WHERE $2 <= $4
       ON CONFLICT (user_id, usage_date) DO UPDATE
       SET operation_count = user_ai_usage_daily.operation_count + 1,
           reserved_output_tokens = user_ai_usage_daily.reserved_output_tokens + EXCLUDED.reserved_output_tokens,
           updated_at = NOW()
       WHERE user_ai_usage_daily.operation_count < $3
         AND user_ai_usage_daily.reserved_output_tokens + EXCLUDED.reserved_output_tokens <= $4
       RETURNING operation_count, reserved_output_tokens`,
      [userId, reservedOutputTokens, maxOperations, maxOutputTokens],
    )).rows[0] || null;
  };

  const getWriteAgentOutputReservation = (
    perTurnMaxTokens: unknown,
    modelTurnLimit: number,
    routerTokens = 0,
  ) => {
    const perTurn = Math.round(clampNumber(perTurnMaxTokens, 1200, 128, getCanvasAgentMaxOutputTokens()));
    return perTurn * Math.max(1, Math.round(modelTurnLimit)) + Math.max(0, Math.round(routerTokens));
  };

  const dailyPaidOperationBudgetMiddleware: express.RequestHandler = asyncHandler(async (req, res, next) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: "请先登录" });
    const reservation = await reserveDailyAiBudget(userId, getCanvasAgentMaxOutputTokens());
    if (!reservation) {
      res.setHeader("Retry-After", "3600");
      return res.status(429).json({ error: "今日 AI 使用额度已达到上限，请稍后再试" });
    }
    next();
  });

  const writingAgentDailyBudgetMiddleware: express.RequestHandler = asyncHandler(async (req, res, next) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: "请先登录" });
    const reservation = await reserveDailyAiBudget(
      userId,
      getWriteAgentOutputReservation(getCanvasAgentMaxOutputTokens(), 6, 260),
    );
    if (!reservation) {
      res.setHeader("Retry-After", "3600");
      return res.status(429).json({ error: "今日 AI 使用额度已达到上限，请稍后再试" });
    }
    next();
  });

  const canvasAgentRunLeaseMs = readBoundedEnvNumber(
    process.env.WRITE_CANVAS_RUN_LEASE_MS,
    Math.min(3_600_000, Math.max(1_200_000, AI_REQUEST_TIMEOUT_MS * 4)),
    300_000,
    3_600_000,
  );
  const canvasAgentRunDeadlineMs = Math.max(
    60_000,
    canvasAgentRunLeaseMs - Math.min(180_000, Math.floor(canvasAgentRunLeaseMs / 2)),
  );

  const sendCanvasRunFinal = (res: express.Response, payloadValue: unknown, replayed = false) => {
    const payload = isPlainRecord(payloadValue)
      ? { ...payloadValue, ...(replayed ? { replayed: true } : {}) }
      : { replayed, message: "文章已创建" };
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write("event: final\n");
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.end();
  };

  const sendCanvasRunRetryable = (res: express.Response, message: string) => {
    res.setHeader("Retry-After", "5");
    return res.status(409).json({ code: "CANVAS_RUN_IN_PROGRESS", error: message, retryable: true });
  };

  const sendCanvasRunAttemptsExhausted = (res: express.Response) => res.status(409).json({
    code: "CANVAS_RUN_ATTEMPTS_EXHAUSTED",
    error: "该创建文章请求的执行次数已用尽，请使用新的 requestId 重试",
    retryable: false,
  });

  const hasActiveCanvasAgentRun = async (
    database: pg.Pool | pg.PoolClient,
    userId: number,
    scope: { projectId?: number; agentId?: number },
  ) => Boolean((await database.query(
    `SELECT active_run.agent_id
     FROM (
       SELECT run_request.agent_id, agent.project_id
       FROM write_canvas_agent_run_requests AS run_request
       JOIN write_agent_instances AS agent
         ON agent.id = run_request.agent_id AND agent.user_id = run_request.user_id
       WHERE run_request.user_id = $1
         AND run_request.status = 'running'
         AND run_request.lease_expires_at IS NOT NULL
         AND run_request.lease_expires_at > NOW()
       UNION ALL
       SELECT execution_lease.agent_id, agent.project_id
       FROM write_canvas_agent_execution_leases AS execution_lease
       JOIN write_agent_instances AS agent
         ON agent.id = execution_lease.agent_id AND agent.user_id = execution_lease.user_id
       WHERE execution_lease.user_id = $1
         AND execution_lease.lease_expires_at > NOW()
     ) AS active_run
     WHERE ($2::bigint IS NULL OR active_run.project_id = $2)
       AND ($3::bigint IS NULL OR active_run.agent_id = $3)
     LIMIT 1`,
    [userId, scope.projectId ?? null, scope.agentId ?? null],
  )).rows[0]);

  const acquireCanvasAgentExecutionLease = async (input: {
    userId: number;
    agentId: number;
    runId: string;
  }): Promise<"acquired" | "active" | "agent_missing"> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, input.userId);
      const agent = (await client.query(
        `SELECT id, agent_thread_id
         FROM write_agent_instances
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [input.agentId, input.userId],
      )).rows[0];
      if (!agent) {
        await client.query("ROLLBACK");
        return "agent_missing";
      }
      await client.query(
        `DELETE FROM write_canvas_agent_execution_leases
         WHERE user_id = $1 AND agent_id = $2 AND lease_expires_at <= NOW()`,
        [input.userId, input.agentId],
      );
      if (await hasActiveCanvasAgentRun(client, input.userId, { agentId: input.agentId })) {
        await client.query("ROLLBACK");
        return "active";
      }
      await client.query(
        `INSERT INTO write_canvas_agent_execution_leases
           (user_id, agent_id, thread_id, run_id, lease_kind, lease_expires_at)
         VALUES ($1, $2, $3, $4, 'chat', NOW() + ($5::bigint * INTERVAL '1 millisecond'))`,
        [input.userId, input.agentId, agent.agent_thread_id || null, input.runId, canvasAgentRunLeaseMs],
      );
      await client.query("COMMIT");
      return "acquired";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  const updateCanvasAgentExecutionLeaseThread = async (input: {
    userId: number;
    agentId: number;
    runId: string;
    threadId: number;
  }) => Boolean((await pool.query(
    `UPDATE write_canvas_agent_execution_leases
     SET thread_id = $4, updated_at = NOW()
     WHERE user_id = $1 AND agent_id = $2 AND run_id = $3
       AND lease_expires_at > NOW()
     RETURNING id`,
    [input.userId, input.agentId, input.runId, input.threadId],
  )).rows[0]);

  const renewCanvasAgentExecutionLease = async (input: {
    userId: number;
    agentId: number;
    runId: string;
  }) => {
    const renewed = (await pool.query(
      `UPDATE write_canvas_agent_execution_leases
       SET lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE user_id = $1 AND agent_id = $2 AND run_id = $3
         AND lease_expires_at > NOW()
       RETURNING id`,
      [input.userId, input.agentId, input.runId, canvasAgentRunLeaseMs],
    )).rows[0];
    if (!renewed) throw new Error("Canvas Agent execution lease expired before provider invocation");
  };

  const renewCanvasCreateArticleRunLease = async (input: {
    userId: number;
    agentId: number;
    requestId: string;
    runId: string;
  }) => {
    const renewed = (await pool.query(
      `UPDATE write_canvas_agent_run_requests
       SET lease_expires_at = NOW() + ($5::bigint * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE user_id = $1 AND agent_id = $2 AND request_id = $3 AND run_id = $4
         AND status = 'running'
         AND lease_expires_at IS NOT NULL AND lease_expires_at > NOW()
       RETURNING id`,
      [input.userId, input.agentId, input.requestId, input.runId, canvasAgentRunLeaseMs],
    )).rows[0];
    if (!renewed) throw new Error("Canvas create-article lease expired before provider invocation");
  };

  const releaseCanvasAgentExecutionLease = async (input: {
    userId: number;
    agentId: number;
    runId: string;
  }) => {
    await pool.query(
      `DELETE FROM write_canvas_agent_execution_leases
       WHERE user_id = $1 AND agent_id = $2 AND run_id = $3`,
      [input.userId, input.agentId, input.runId],
    );
  };

  const completeCanvasRunRequest = async (input: {
    userId: number;
    agentId: number;
    requestId: string;
    runId: string;
    payload: unknown;
    noteId?: number;
    threadId?: number;
  }) => {
    const completed = (await pool.query(
      `UPDATE write_canvas_agent_run_requests
       SET status = 'completed', response_payload = $5, note_id = $6, thread_id = $7,
           lease_expires_at = NULL, error_message = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND agent_id = $2 AND request_id = $3 AND run_id = $4
         AND status = 'running'
       RETURNING id`,
      [
        input.userId,
        input.agentId,
        input.requestId,
        input.runId,
        JSON.stringify(input.payload),
        input.noteId || null,
        input.threadId || null,
      ],
    )).rows[0];
    if (!completed) {
      const current = (await pool.query(
        `SELECT run_id, status
         FROM write_canvas_agent_run_requests
         WHERE user_id = $1 AND agent_id = $2 AND request_id = $3`,
        [input.userId, input.agentId, input.requestId],
      )).rows[0];
      if (current?.status === "completed" && String(current.run_id) === input.runId) return;
      throw new Error("Canvas run ownership expired before completion");
    }
  };

  const failCanvasRunRequest = async (input: {
    userId: number;
    agentId: number;
    requestId: string;
    runId: string;
    error: unknown;
  }) => {
    await pool.query(
      `UPDATE write_canvas_agent_run_requests
       SET status = 'failed', lease_expires_at = NULL, error_message = $5,
           updated_at = NOW()
       WHERE user_id = $1 AND agent_id = $2 AND request_id = $3 AND run_id = $4
         AND status = 'running'`,
      [
        input.userId,
        input.agentId,
        input.requestId,
        input.runId,
        normalizePlainText(input.error instanceof Error ? input.error.message : String(input.error || "run failed")).slice(0, 500),
      ],
    );
  };

  const canvasAgentChatValidationMiddleware: express.RequestHandler = asyncHandler(async (req, res, next) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: "请先登录" });
    const agentId = Number(req.params.id);
    if (!Number.isSafeInteger(agentId) || agentId <= 0) {
      return res.status(400).json({ error: "invalid agent id" });
    }
    const message = typeof req.body?.message === "string"
      ? req.body.message.trim().slice(0, WRITE_AGENT_MAX_MESSAGE_LENGTH)
      : "";
    if (!message) return res.status(400).json({ error: "message is required" });
    const isCreateArticle = req.body?.action === "create_article";
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId.trim() : "";
    if (isCreateArticle && (!requestId || requestId.length > 128)) {
      return res.status(400).json({ error: "requestId is required for create_article" });
    }
    const agentRow = await getCanvasAgentNode(pool, userId, agentId);
    if (!agentRow) return res.status(404).json({ error: "agent not found" });
    const focusedTopic = typeof req.body?.focusedTopic === "string"
      ? req.body.focusedTopic.slice(0, 500)
      : message;
    const requestFingerprint = isCreateArticle
      ? createHash("sha256").update(JSON.stringify({ action: "create_article", message, focusedTopic })).digest("hex")
      : "";
    res.locals.canvasAgentChat = {
      userId,
      agentId,
      agentRow,
      message,
      focusedTopic,
      isCreateArticle,
      requestId,
      requestFingerprint,
      creationKey: isCreateArticle ? `canvas:${agentId}:${requestId}` : undefined,
    };
    next();
  });

  const canvasAgentExecutionValidationMiddleware: express.RequestHandler = (req, res, next) => {
    const prepared = res.locals.canvasAgentChat;
    if (!prepared) return res.status(500).json({ error: "Canvas Agent request was not prepared" });
    if (!getOpenAIWriteAgentConfig()) {
      return res.status(500).json({ error: "Writing agent model is not configured: set OPENAI_API_KEY/OPENAI_MODEL or AI_API_KEY/AI_BASE_URL/AI_MODEL" });
    }
    if (!isAllowedCanvasAgentModel(prepared.agentRow.model)) {
      return res.status(400).json({ error: "该 Agent 使用的模型未被服务器允许，请先更新模型设置" });
    }
    next();
  };

  const canvasAgentContextValidationMiddleware: express.RequestHandler = asyncHandler(async (_req, res, next) => {
    const prepared = res.locals.canvasAgentChat;
    if (!prepared) return res.status(500).json({ error: "Canvas Agent request was not prepared" });
    const contexts = await resolveCanvasContextItems(
      pool,
      prepared.userId,
      Number(prepared.agentRow.node_id),
      Number(prepared.agentRow.project_id),
    );
    res.locals.canvasAgentContexts = contexts;
    if (!prepared.isCreateArticle) return next();
    const durableNoteExists = Boolean((await pool.query(
      `SELECT 1 FROM notes WHERE user_id = $1 AND creation_key = $2 LIMIT 1`,
      [prepared.userId, prepared.creationKey],
    )).rows[0]);
    if (durableNoteExists) return next();
    const usableCards = sanitizeWritingCards(canvasContextsToWritingCards(contexts));
    if (usableCards.length === 0) {
      return res.status(400).json({
        code: "CANVAS_CONTEXT_REQUIRED",
        error: "创建文章前，请先将至少一项可用素材连接到 Agent",
        retryable: false,
      });
    }
    next();
  });

  const canvasCreateArticleReplayMiddleware: express.RequestHandler = asyncHandler(async (_req, res, next) => {
    const prepared = res.locals.canvasAgentChat;
    if (!prepared?.isCreateArticle) return next();
    const existing = (await pool.query(
      `SELECT request_fingerprint, status, response_payload, attempt_count,
              lease_expires_at IS NOT NULL AND lease_expires_at > NOW() AS lease_active,
              EXISTS (
                SELECT 1 FROM notes
                WHERE user_id = $1 AND creation_key = $4
              ) AS note_exists
       FROM write_canvas_agent_run_requests
       WHERE user_id = $1 AND agent_id = $2 AND request_id = $3`,
      [prepared.userId, prepared.agentId, prepared.requestId, prepared.creationKey],
    )).rows[0];
    if (!existing) return next();
    if (existing.request_fingerprint !== prepared.requestFingerprint) {
      return res.status(409).json({
        code: "CANVAS_REQUEST_ID_REUSED",
        error: "requestId 已用于不同的创建文章请求，请生成新的 requestId",
        retryable: false,
      });
    }
    if (existing.status === "completed" && isPlainRecord(existing.response_payload)) {
      sendCanvasRunFinal(res, existing.response_payload, true);
      return;
    }
    if (existing.status === "running" && existing.lease_active) {
      sendCanvasRunRetryable(res, "同一创建文章请求仍在执行，请稍后重试");
      return;
    }
    if (!existing.note_exists && Number(existing.attempt_count) >= WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS) {
      sendCanvasRunAttemptsExhausted(res);
      return;
    }
    next();
  });

  const canvasCreateArticleClaimMiddleware: express.RequestHandler = asyncHandler(async (_req, res, next) => {
    const prepared = res.locals.canvasAgentChat;
    if (!prepared?.isCreateArticle) return next();
    const proposedRunId = randomUUID();
    const client = await pool.connect();
    let outcome:
      | { type: "acquired"; runId: string }
      | { type: "replay"; payload: unknown }
      | { type: "in_progress" }
      | { type: "conflict" }
      | { type: "agent_missing" }
      | { type: "attempts_exhausted" };
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, prepared.userId);
      const agent = (await client.query(
        `SELECT id
         FROM write_agent_instances
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [prepared.agentId, prepared.userId],
      )).rows[0];
      if (!agent) {
        outcome = { type: "agent_missing" };
      } else if (await hasActiveCanvasAgentRun(client, prepared.userId, { agentId: prepared.agentId })) {
        outcome = { type: "in_progress" };
      } else {
        const inserted = (await client.query(
          `INSERT INTO write_canvas_agent_run_requests
             (user_id, agent_id, request_id, request_fingerprint, action, run_id, status, lease_expires_at)
           VALUES ($1, $2, $3, $4, 'create_article', $5, 'running', NOW() + ($6::bigint * INTERVAL '1 millisecond'))
           ON CONFLICT (user_id, agent_id, request_id) DO NOTHING
           RETURNING id`,
          [prepared.userId, prepared.agentId, prepared.requestId, prepared.requestFingerprint, proposedRunId, canvasAgentRunLeaseMs],
        )).rows[0];
        const row = (await client.query(
          `SELECT request_fingerprint, run_id, status, response_payload, attempt_count,
                  lease_expires_at IS NOT NULL AND lease_expires_at > NOW() AS lease_active
           FROM write_canvas_agent_run_requests
           WHERE user_id = $1 AND agent_id = $2 AND request_id = $3
           FOR UPDATE`,
          [prepared.userId, prepared.agentId, prepared.requestId],
        )).rows[0];
        const noteExists = Boolean((await client.query(
          `SELECT 1 FROM notes WHERE user_id = $1 AND creation_key = $2`,
          [prepared.userId, prepared.creationKey],
        )).rows[0]);
        if (!row || row.request_fingerprint !== prepared.requestFingerprint) {
          outcome = { type: "conflict" };
        } else if (inserted) {
          outcome = { type: "acquired", runId: proposedRunId };
        } else if (row.status === "completed" && isPlainRecord(row.response_payload)) {
          outcome = { type: "replay", payload: row.response_payload };
        } else if (row.status === "running" && row.lease_active) {
          outcome = { type: "in_progress" };
        } else if (noteExists) {
          // The paid model already produced its durable Note. An expired owner
          // may repair the response/node record without starting another attempt.
          await client.query(
            `UPDATE write_canvas_agent_run_requests
             SET run_id = $4, status = 'running', response_payload = NULL,
                 lease_expires_at = NOW() + ($5::bigint * INTERVAL '1 millisecond'),
                 error_message = NULL, completed_at = NULL, updated_at = NOW()
             WHERE user_id = $1 AND agent_id = $2 AND request_id = $3`,
            [prepared.userId, prepared.agentId, prepared.requestId, proposedRunId, canvasAgentRunLeaseMs],
          );
          outcome = { type: "acquired", runId: proposedRunId };
        } else if (Number(row.attempt_count) >= WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS) {
          outcome = { type: "attempts_exhausted" };
        } else {
          const retried = (await client.query(
            `UPDATE write_canvas_agent_run_requests
             SET run_id = $4, status = 'running', response_payload = NULL,
                 lease_expires_at = NOW() + ($5::bigint * INTERVAL '1 millisecond'),
                 budget_reserved_at = CASE
                   WHEN provider_started_at IS NULL THEN budget_reserved_at
                   ELSE NULL
                 END,
                 provider_started_at = NULL,
                 error_message = NULL,
                 completed_at = NULL, updated_at = NOW()
             WHERE user_id = $1 AND agent_id = $2 AND request_id = $3
               AND attempt_count < $6
             RETURNING run_id`,
            [
              prepared.userId,
              prepared.agentId,
              prepared.requestId,
              proposedRunId,
              canvasAgentRunLeaseMs,
              WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS,
            ],
          )).rows[0];
          outcome = retried
            ? { type: "acquired", runId: proposedRunId }
            : { type: "attempts_exhausted" };
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (outcome.type === "conflict") {
      return res.status(409).json({
        code: "CANVAS_REQUEST_ID_REUSED",
        error: "requestId 已用于不同的创建文章请求，请生成新的 requestId",
        retryable: false,
      });
    }
    if (outcome.type === "agent_missing") {
      return res.status(404).json({ error: "agent not found" });
    }
    if (outcome.type === "replay") {
      sendCanvasRunFinal(res, outcome.payload, true);
      return;
    }
    if (outcome.type === "in_progress") {
      sendCanvasRunRetryable(res, "该 Agent 已有生成任务正在执行，请稍后重试");
      return;
    }
    if (outcome.type === "attempts_exhausted") {
      sendCanvasRunAttemptsExhausted(res);
      return;
    }
    res.locals.canvasAgentRunId = outcome.runId;
    res.locals.canvasAgentRunDeadlineAt = Date.now() + canvasAgentRunDeadlineMs;
    next();
  });

  const canvasCreateArticleNoteRecoveryMiddleware: express.RequestHandler = asyncHandler(async (_req, res, next) => {
    const prepared = res.locals.canvasAgentChat;
    const runId = String(res.locals.canvasAgentRunId || "");
    if (!prepared?.isCreateArticle || !runId) return next();
    try {
      const note = (await pool.query(
        `SELECT id, title, content, tags, meta, created_at, updated_at
         FROM notes
         WHERE user_id = $1 AND creation_key = $2`,
        [prepared.userId, prepared.creationKey],
      )).rows[0];
      if (!note) return next();
      const threadId = await ensureCanvasAgentThread(pool, prepared.userId, prepared.agentId);
      if (!threadId) throw new Error("Canvas Agent thread could not be recovered");
      let noteNode = null;
      let recoveryWarning: string | undefined;
      try {
        noteNode = await ensureCanvasGeneratedNoteNode(pool, prepared.userId, prepared.agentId, note, threadId, runId);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("节点数量已达到上限")) throw error;
        recoveryWarning = error.message;
      }
      const assistant = (await pool.query(
        `SELECT id, role, content, meta, created_at
         FROM write_agent_messages
         WHERE thread_id = $1 AND role = 'assistant' AND meta->>'noteId' = $2
         ORDER BY id DESC
         LIMIT 1`,
        [threadId, String(note.id)],
      )).rows[0];
      const thread = (await pool.query(
        `SELECT state FROM write_agent_threads WHERE id = $1 AND user_id = $2 AND thread_type = 'canvas'`,
        [threadId, prepared.userId],
      )).rows[0];
      const assistantContent = assistant?.content || `文章《${note.title || "未命名文章"}》已创建，可在「我的文章」继续编辑。`;
      const toolResult = isPlainRecord(assistant?.meta)
        ? assistant.meta
        : { runId, noteId: Number(note.id), noteTitle: note.title, noteSaved: true, recovered: true };
      const uiBlocks = Array.isArray(toolResult.uiBlocks)
        ? toolResult.uiBlocks
        : [
          { type: "answer", markdown: assistantContent },
          { type: "draft_created", noteId: Number(note.id), noteTitle: note.title || "未命名文章" },
        ];
      const payload = {
        runId,
        recovered: true,
        message: assistant
          ? mapCanvasMessageRow({ ...assistant, agent_id: prepared.agentId })
          : {
            id: 0,
            agentId: prepared.agentId,
            role: "assistant",
            content: assistantContent,
            meta: toolResult,
            createdAt: note.updated_at || note.created_at,
          },
        threadId,
        threadState: isPlainRecord(thread?.state) ? thread.state : {},
        toolResult,
        uiBlocks,
        choices: Array.isArray(toolResult.choices) ? toolResult.choices : [],
        sources: isPlainRecord(toolResult.sources) ? toolResult.sources : { cards: [], images: [] },
        note,
        noteNode,
        ...(recoveryWarning ? { warning: recoveryWarning } : {}),
        context: {
          nodes: [],
          usedImages: Number(toolResult.usedImages) || 0,
          authorizedCardIds: [],
          globalRecallCandidates: [],
          globalRecallRequiresConfirmation: false,
          globalRecallConfirmationEndpoint: `/api/write/canvas/agents/${prepared.agentId}/recall/confirm`,
        },
      };
      await completeCanvasRunRequest({
        userId: prepared.userId,
        agentId: prepared.agentId,
        requestId: prepared.requestId,
        runId,
        payload,
        noteId: Number(note.id),
        threadId,
      });
      sendCanvasRunFinal(res, payload, true);
    } catch (error) {
      try {
        await failCanvasRunRequest({
          userId: prepared.userId,
          agentId: prepared.agentId,
          requestId: prepared.requestId,
          runId,
          error,
        });
      } catch (persistenceError) {
        logger.error(
          { err: persistenceError, module: "canvas-agent", runId, agentId: prepared.agentId, userId: prepared.userId },
          "Failed to release Canvas create-article claim after Note recovery error",
        );
      }
      const completed = (await pool.query(
        `SELECT response_payload
         FROM write_canvas_agent_run_requests
         WHERE user_id = $1 AND agent_id = $2 AND request_id = $3
           AND status = 'completed'`,
        [prepared.userId, prepared.agentId, prepared.requestId],
      )).rows[0];
      if (isPlainRecord(completed?.response_payload)) {
        sendCanvasRunFinal(res, completed.response_payload, true);
        return;
      }
      throw error;
    }
  });

  const canvasAgentExecutionLeaseMiddleware: express.RequestHandler = asyncHandler(async (_req, res, next) => {
    const prepared = res.locals.canvasAgentChat;
    if (!prepared) return res.status(500).json({ error: "Canvas Agent request was not prepared" });
    if (prepared.isCreateArticle) return next();
    const runId = randomUUID();
    const outcome = await acquireCanvasAgentExecutionLease({
      userId: prepared.userId,
      agentId: prepared.agentId,
      runId,
    });
    if (outcome === "agent_missing") return res.status(404).json({ error: "agent not found" });
    if (outcome === "active") {
      res.setHeader("Retry-After", "5");
      return res.status(409).json({
        code: "CANVAS_AGENT_RUN_ACTIVE",
        error: "该 Agent 已有生成任务正在执行，请稍后重试",
        retryable: true,
      });
    }
    let releasePromise: Promise<void> | null = null;
    const release = async () => {
      if (!releasePromise) {
        releasePromise = releaseCanvasAgentExecutionLease({
          userId: prepared.userId,
          agentId: prepared.agentId,
          runId,
        }).catch(error => {
          logger.error(
            { err: error, module: "canvas-agent", runId, agentId: prepared.agentId, userId: prepared.userId },
            "Failed to release Canvas Agent execution lease",
          );
        });
      }
      await releasePromise;
    };
    res.locals.canvasAgentRunId = runId;
    res.locals.canvasAgentRunDeadlineAt = Date.now() + canvasAgentRunDeadlineMs;
    res.locals.releaseCanvasAgentExecutionLease = release;
    next();
  });

  const beginCanvasCreateArticleProviderAttempt = async (input: {
    userId: number;
    agentId: number;
    requestId: string;
    runId: string;
  }) => {
    const started = (await pool.query(
      `UPDATE write_canvas_agent_run_requests
       SET attempt_count = attempt_count + 1,
           provider_started_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND agent_id = $2 AND request_id = $3 AND run_id = $4
         AND status = 'running'
         AND lease_expires_at IS NOT NULL AND lease_expires_at > NOW()
         AND budget_reserved_at IS NOT NULL
         AND provider_started_at IS NULL
         AND attempt_count < $5
       RETURNING attempt_count`,
      [input.userId, input.agentId, input.requestId, input.runId, WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS],
    )).rows[0];
    if (!started) throw new Error("Canvas create-article provider attempt is not ready");
  };

  const canvasAgentDailyBudgetMiddleware: express.RequestHandler = asyncHandler(async (_req, res, next) => {
    const prepared = res.locals.canvasAgentChat;
    if (!prepared) return res.status(500).json({ error: "Canvas Agent request was not prepared" });
    if (!prepared.isCreateArticle) {
      let reservation;
      try {
        reservation = await reserveDailyAiBudget(
          prepared.userId,
          getWriteAgentOutputReservation(prepared.agentRow.max_tokens, 6, 260),
        );
      } catch (error) {
        if (typeof res.locals.releaseCanvasAgentExecutionLease === "function") {
          await res.locals.releaseCanvasAgentExecutionLease();
        }
        throw error;
      }
      if (!reservation) {
        if (typeof res.locals.releaseCanvasAgentExecutionLease === "function") {
          await res.locals.releaseCanvasAgentExecutionLease();
        }
        res.setHeader("Retry-After", "3600");
        return res.status(429).json({ error: "今日 AI 使用额度已达到上限，请稍后再试" });
      }
      return next();
    }
    const runId = String(res.locals.canvasAgentRunId || "");
    if (!runId) return res.status(409).json({ error: "创建文章请求尚未取得执行权", retryable: true });
    let client: pg.PoolClient | null = null;
    let outcome: "ready" | "budget_exhausted" | "attempts_exhausted" = "budget_exhausted";
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const run = (await client.query(
        `SELECT budget_reserved_at, provider_started_at, attempt_count
         FROM write_canvas_agent_run_requests
         WHERE user_id = $1 AND agent_id = $2 AND request_id = $3 AND run_id = $4
           AND status = 'running'
         FOR UPDATE`,
        [prepared.userId, prepared.agentId, prepared.requestId, runId],
      )).rows[0];
      if (!run) {
        await client.query("ROLLBACK");
        return sendCanvasRunRetryable(res, "创建文章请求的执行权已变化，请重试");
      }
      if (run.provider_started_at) {
        await client.query("ROLLBACK");
        return sendCanvasRunRetryable(res, "创建文章请求的模型调用已开始，请稍后重试");
      }
      if (Number(run.attempt_count) >= WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS) {
        await client.query(
          `UPDATE write_canvas_agent_run_requests
           SET status = 'failed', lease_expires_at = NULL,
               error_message = 'provider attempt limit exhausted', updated_at = NOW()
           WHERE user_id = $1 AND agent_id = $2 AND request_id = $3 AND run_id = $4`,
          [prepared.userId, prepared.agentId, prepared.requestId, runId],
        );
        outcome = "attempts_exhausted";
      } else if (run.budget_reserved_at) {
        outcome = "ready";
      } else {
        const reservation = await reserveDailyAiBudget(
          prepared.userId,
          getWriteAgentOutputReservation(prepared.agentRow.max_tokens, 2),
          client,
        );
        if (reservation) {
          await client.query(
            `UPDATE write_canvas_agent_run_requests
             SET budget_reserved_at = NOW(), updated_at = NOW()
             WHERE user_id = $1 AND agent_id = $2 AND request_id = $3 AND run_id = $4`,
            [prepared.userId, prepared.agentId, prepared.requestId, runId],
          );
          outcome = "ready";
        } else {
          await client.query(
            `UPDATE write_canvas_agent_run_requests
             SET status = 'failed', lease_expires_at = NULL,
                 error_message = 'daily AI budget exhausted', updated_at = NOW()
             WHERE user_id = $1 AND agent_id = $2 AND request_id = $3 AND run_id = $4`,
            [prepared.userId, prepared.agentId, prepared.requestId, runId],
          );
          outcome = "budget_exhausted";
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      try {
        await failCanvasRunRequest({
          userId: prepared.userId,
          agentId: prepared.agentId,
          requestId: prepared.requestId,
          runId,
          error,
        });
      } catch (persistenceError) {
        logger.error(
          { err: persistenceError, module: "canvas-agent", runId, agentId: prepared.agentId, userId: prepared.userId },
          "Failed to release Canvas create-article claim after budget error",
        );
      }
      throw error;
    } finally {
      client?.release();
    }
    if (outcome === "attempts_exhausted") {
      sendCanvasRunAttemptsExhausted(res);
      return;
    }
    if (outcome === "budget_exhausted") {
      res.setHeader("Retry-After", "3600");
      return res.status(429).json({ error: "今日 AI 使用额度已达到上限，请稍后再试" });
    }
    next();
  });

  // --- Set/Change password (requires auth) ---
  app.put("/api/auth/set-password", requireAuth, asyncHandler(async (req, res) => {
    const password = req.body?.password || '';
    const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    if (!password || password.length < 8) {
      return res.status(400).json({ error: '密码至少 8 个字符' });
    }

    const account = (await pool.query(
      'SELECT id, email, password_hash FROM users WHERE id = $1',
      [req.session.userId],
    )).rows[0];
    if (!account) return res.status(404).json({ error: '用户不存在' });

    const authorized = await canChangePassword({
      existingPasswordHash: account.password_hash || null,
      currentPassword,
      reauthenticatedAt: req.session.reauthenticatedAt,
      comparePassword: bcrypt.compare,
    });
    if (!authorized) {
      return res.status(403).json({
        code: "REAUTH_REQUIRED",
        error: account.password_hash
          ? "请输入当前密码，或重新登录后再修改密码"
          : "请使用邮箱验证码重新登录后设置密码",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await updatePasswordAndInvalidateSessions(req.session.userId, passwordHash);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    await establishAuthenticatedSession(req, Number(user.id), String(user.email));
    return res.json({ success: true });
  }));

  // --- Reset password (forgot password: verify code + set new password, no auth) ---
  app.post("/api/auth/reset-password", verificationCheckLimiter, asyncHandler(async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const code = (req.body?.code || '').trim();
    const password = req.body?.password || '';
    if (!email || !code) {
      return res.status(400).json({ error: '请输入邮箱和验证码' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: '密码至少 8 个字符' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
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
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM write_canvas_agent_run_requests t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM user_ai_usage_daily t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM billing_subscriptions t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM billing_checkout_attempts t WHERE user_id = $1
         UNION ALL SELECT COALESCE(SUM(octet_length(row_to_json(t)::text)), 0)::bigint FROM billing_usage_events t WHERE user_id = $1
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
      canvasRunRequests,
      aiUsage,
      billingSubscriptions,
      billingCheckoutAttempts,
      billingUsageEvents,
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
      rows(`SELECT * FROM write_canvas_agent_run_requests WHERE user_id = $1 ORDER BY id`),
      rows(`SELECT usage_date, operation_count, reserved_output_tokens, updated_at FROM user_ai_usage_daily WHERE user_id = $1 ORDER BY usage_date`),
      rows(`SELECT paddle_subscription_id, product_id, price_id, plan_code, status, current_period_starts_at, current_period_ends_at, scheduled_change, created_at, updated_at FROM billing_subscriptions WHERE user_id = $1 ORDER BY created_at`),
      rows(`SELECT id, request_id, plan_code, paddle_transaction_id, status, error_code, created_at, updated_at FROM billing_checkout_attempts WHERE user_id = $1 ORDER BY created_at`),
      rows(`SELECT operation_key, operation_type, occurred_at FROM billing_usage_events WHERE user_id = $1 ORDER BY occurred_at`),
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
        runRequests: canvasRunRequests,
      },
      aiUsage,
      billing: {
        subscriptions: billingSubscriptions,
        checkoutAttempts: billingCheckoutAttempts,
        usageEvents: billingUsageEvents,
      },
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

    if (!billingService) {
      return res.status(503).json({ code: "BILLING_UNAVAILABLE", error: "账单状态暂时无法确认，账户尚未删除" });
    }
    try {
      await billingService.deleteAccountUnderBillingLock(
        userId,
        async client => {
          // BillingService has opened BEGIN on this same client before invoking
          // the callback, so the user row lock covers the remote cancellation.
          await lockCanvasUser(client, userId);
          if (await hasActiveCanvasAgentRun(client, userId, {})) {
            throw new BillingError(409, "CANVAS_AGENT_RUN_ACTIVE", "账户仍有画布 Agent 正在生成内容，请等待完成后再注销");
          }
        },
        async client => {
          await client.query(`DELETE FROM verification_codes WHERE email = $1`, [user.email]);
          await client.query(`DELETE FROM session WHERE sess ->> 'userId' = $1`, [String(userId)]);
          const deleted = await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
          if (deleted.rowCount !== 1) throw new Error("Account deletion did not remove exactly one user");
        },
      );
    } catch (error) {
      return sendBillingError(res, error);
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
    if (!req.session.userId) {
      return res.json(articles.map(toArticleListItem));
    }
    const userArticles = await loadUserArticlesAsArticles(req.session.userId, pool);
    if (userArticles.length === 0) {
      const withSavedState = await applyUserSavedStateToArticles(req.session.userId, articles, pool);
      return res.json(withSavedState.map(toArticleListItem));
    }
    // Deduplicate: skip user articles whose URL already exists in global store
    const globalUrls = new Set(articles.filter(a => a.url).map(a => a.url as string));
    const uniqueUserArticles = userArticles.filter(a => !a.url || !globalUrls.has(a.url));
    const rankedArticles = rankArticles([...articles, ...uniqueUserArticles]);
    const withSavedState = await applyUserSavedStateToArticles(req.session.userId, rankedArticles, pool);
    return res.json(withSavedState.map(toArticleListItem));
  }));

  app.post("/api/sources/fetch", requireAuth, remoteFetchLimiter, asyncHandler(async (req, res) => {
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
    const fullFeed = req.body?.full === true;
    if (!source || !input) {
      return res.status(400).json({ error: "source and input are required" });
    }
    const isBuiltin = BUILTIN_SOURCE_NAMES.has(source);
    const userId = req.session.userId;
    if (isBuiltin) return res.status(403).json({ error: "内置订阅源由服务器定时刷新" });
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

  app.post("/api/sources/retry", requireAuth, remoteFetchLimiter, asyncHandler(async (req, res) => {
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
    const fullFeed = req.body?.full === true;
    if (!source || !input) {
      return res.status(400).json({ error: "source and input are required" });
    }
    const isBuiltin = BUILTIN_SOURCE_NAMES.has(source);
    const userId = req.session.userId;
    if (isBuiltin) return res.status(403).json({ error: "内置订阅源由服务器定时刷新" });
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
  app.post("/api/articles/:id/save", requireAuth, remoteFetchLimiter, paidOperationLimiter, dailyPaidOperationBudgetMiddleware, paidConcurrencyMiddleware, articleSaveConcurrencyMiddleware, asyncHandler(async (req, res) => {
    const articleId = parseInt(req.params.id);
    const sourceUrl = typeof req.query.sourceUrl === 'string' ? req.query.sourceUrl.trim() : '';
    const sourceName = typeof req.query.sourceName === 'string' ? req.query.sourceName.trim() : '';
    const sourceTitle = typeof req.query.sourceTitle === 'string' ? req.query.sourceTitle.trim() : '';
    let article = findArticleByIdentity(articles, {
      id: articleId,
      url: sourceUrl || undefined,
      source: sourceName || undefined,
      title: sourceTitle || undefined,
    });
    let isUserArticle = false;

    // If not in global store, check user_articles DB
    if (!article && req.session.userId) {
      const hasSourceIdentity = !sourceUrl && Boolean(sourceName && sourceTitle);
      const identityCondition = sourceUrl ? 'url = $2' : hasSourceIdentity ? 'source = $2 AND title = $3' : 'id = $2';
      const identityParams = sourceUrl
        ? [req.session.userId, sourceUrl]
        : hasSourceIdentity
          ? [req.session.userId, sourceName, sourceTitle]
          : [req.session.userId, articleId];
      const row = (await pool.query(
        `SELECT id, source, source_icon, topic, title, excerpt, content, url,
                audio_url, audio_duration, published_at, time_str, saved,
                full_fetched, markdown_content
         FROM user_articles
         WHERE user_id = $1 AND ${identityCondition}
         LIMIT 1`,
        identityParams
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

    // Built-in RSS articles are shared process state. Work on a request-local
    // copy so user-specific fetch/extraction/save state never leaks to others.
    article = { ...article, cards: [] };

    // First, we need to determine the saved_article_id to check for duplicates properly
    // This is a pre-check to see if we've already saved this article
    const normalizedUrl = normalizeArticleUrl(article.url);
    const contentHash = normalizedUrl ? null : generateContentHash(article.title, article.source, article.excerpt);

    let existingSavedArticleId: number | null = null;
    if (normalizedUrl) {
      const existingSavedArticle = await pool.query(
        'SELECT id FROM saved_articles WHERE user_id = $1 AND url = $2',
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
      article = await buildFullArticleView(article);

      // AI extraction BEFORE transaction (may take up to 45s, don't hold DB conn)
      const extraction = await extractCardsForUser({
        article,
        userId: req.session.userId,
        defaultArticleCitationContext: buildDefaultArticleCitationContext(article),
        resolveSkills: userId => resolveWriteAgentSkills(pool, userId),
        extractWithAI: extractKnowledgeWithAI,
        buildFallbackCards: buildCardsFromArticleContent,
        fallbackDisabled: isAiFallbackDisabled(),
      });
      if (!extraction) {
        return res.status(502).json({ error: "AI extraction failed", fallbackDisabled: true });
      }
      const {
        cards: cardsToSave,
        articleCitationContext,
        origin,
        extractionSkills,
      } = extraction;

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
          // URL exists: upsert using unique index (with normalized URL)
          const savedArticleResult = await client.query(
            `INSERT INTO saved_articles (user_id, title, url, source, source_icon, topic, excerpt, content, citation_context, image_urls, audio_url, audio_duration, published_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (user_id, url) WHERE url IS NOT NULL
             DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, excerpt = EXCLUDED.excerpt,
                           source_icon = EXCLUDED.source_icon, citation_context = EXCLUDED.citation_context,
                           image_urls = EXCLUDED.image_urls,
                           audio_url = COALESCE(NULLIF(EXCLUDED.audio_url, ''), saved_articles.audio_url),
                           audio_duration = COALESCE(NULLIF(EXCLUDED.audio_duration, ''), saved_articles.audio_duration)
             RETURNING id`,
            [
              req.session.userId, article.title, normalizedUrl,
              article.source, article.sourceIcon || null, article.topic,
              article.excerpt, article.markdownContent || article.content || article.excerpt,
              articleCitationContext,
              JSON.stringify(articleImageUrls),
              article.audioUrl || null,
              article.audioDuration || null,
              article.publishedAt || null
            ]
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
               SET title = $1, content = $2, excerpt = $3, source_icon = $4,
                   citation_context = $5, image_urls = $6,
                   audio_url = COALESCE(NULLIF($7, ''), audio_url),
                   audio_duration = COALESCE(NULLIF($8, ''), audio_duration)
               WHERE id = $9 AND user_id = $10`,
              [
                article.title,
                article.markdownContent || article.content || article.excerpt,
                article.excerpt,
                article.sourceIcon || null,
                articleCitationContext,
                JSON.stringify(articleImageUrls),
                article.audioUrl || null,
                article.audioDuration || null,
                savedArticleId,
                req.session.userId
              ]
            );
          } else {
            const insertResult = await client.query(
              `INSERT INTO saved_articles (user_id, title, url, source, source_icon, topic, excerpt, content, citation_context, image_urls, audio_url, audio_duration, published_at, content_hash)
               VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
               ON CONFLICT (user_id, content_hash) WHERE content_hash IS NOT NULL
               DO UPDATE SET title = EXCLUDED.title,
                             content = EXCLUDED.content,
                             excerpt = EXCLUDED.excerpt,
                             source_icon = EXCLUDED.source_icon,
                             citation_context = EXCLUDED.citation_context,
                             image_urls = EXCLUDED.image_urls,
                             audio_url = COALESCE(NULLIF(EXCLUDED.audio_url, ''), saved_articles.audio_url),
                             audio_duration = COALESCE(NULLIF(EXCLUDED.audio_duration, ''), saved_articles.audio_duration)
               RETURNING id`,
              [
                req.session.userId, article.title,
                article.source, article.sourceIcon || null, article.topic,
                article.excerpt, article.markdownContent || article.content || article.excerpt,
                articleCitationContext,
                JSON.stringify(articleImageUrls),
                article.audioUrl || null,
                article.audioDuration || null,
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
    article = { ...article, saved: true };

    // Also update saved flag in user_articles if this is a user article
    if (isUserArticle) {
      await pool.query(
        'UPDATE user_articles SET saved = TRUE WHERE id = $1 AND user_id = $2',
        [article.id, req.session.userId]
      );
    }

    res.json({ success: true, article });
  }));

  // Fetch full content for an article
  app.get("/api/articles/:id/full", remoteFetchLimiter, asyncHandler(async (req, res) => {
    const articleId = parseInt(req.params.id);
    const sourceUrl = typeof req.query.sourceUrl === 'string' ? req.query.sourceUrl.trim() : '';
    const sourceName = typeof req.query.sourceName === 'string' ? req.query.sourceName.trim() : '';
    const sourceTitle = typeof req.query.sourceTitle === 'string' ? req.query.sourceTitle.trim() : '';
    let article: Article | undefined = findArticleByIdentity(articles, {
      id: articleId,
      url: sourceUrl || undefined,
      source: sourceName || undefined,
      title: sourceTitle || undefined,
    });

    let userArticleId: number | null = null;

    // If not in global store, check user_articles DB
    if (!article && req.session.userId) {
      const hasSourceIdentity = !sourceUrl && Boolean(sourceName && sourceTitle);
      const identityCondition = sourceUrl ? 'url = $2' : hasSourceIdentity ? 'source = $2 AND title = $3' : 'id = $2';
      const identityParams = sourceUrl
        ? [req.session.userId, sourceUrl]
        : hasSourceIdentity
          ? [req.session.userId, sourceName, sourceTitle]
          : [req.session.userId, articleId];
      const row = (await pool.query(
        `SELECT id, source, source_icon, topic, title, excerpt, content, url,
                audio_url, audio_duration, published_at, time_str, saved,
                full_fetched, markdown_content
         FROM user_articles
         WHERE user_id = $1 AND ${identityCondition}
         LIMIT 1`,
        identityParams
      )).rows[0];
      if (row) {
        userArticleId = Number(row.id);
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

    const fullArticle = await buildFullArticleView(article);
    if (userArticleId && req.session.userId) {
      if (fullArticle.markdownContent && fullArticle.markdownContent !== article.markdownContent) {
        // Cache the normalized full text so later image-proxy requests can prove
        // that an exact absolute image URL came from this account-owned article.
        await pool.query(
          `UPDATE user_articles
           SET markdown_content = $1, full_fetched = TRUE
           WHERE id = $2 AND user_id = $3`,
          [fullArticle.markdownContent, userArticleId, req.session.userId],
        );
      }
    } else {
      // Keep request-local hydration isolated from shared feed objects while
      // retaining bounded, expiring evidence for exact image proxy requests.
      rememberFullArticleImages(fullArticle);
    }

    return res.json({
      success: true,
      article: fullArticle,
    });
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
    const isAllowlistedHost = ALLOWED_IMAGE_HOST_SUFFIXES.some(
      suffix => hostname === suffix || hostname.endsWith(`.${suffix}`)
    );
    const referencedByGlobalArticle = articles.some(article => (
      article.sourceIcon === imageUrl
      || article.sourceImages?.includes(imageUrl)
      || extractImageUrlsFromArticle(article).includes(imageUrl)
    )) || isCachedFullArticleImage(imageUrl);
    let referencedByUserArticle = false;
    if (!isAllowlistedHost && !referencedByGlobalArticle && req.session.userId) {
      const candidateRows = (await pool.query(
        `SELECT url, source_icon, content, markdown_content, NULL::jsonb AS image_urls
         FROM user_articles
         WHERE user_id = $1 AND (
           url = $3 OR source_icon = $2 OR content LIKE '%' || $2 || '%' OR markdown_content LIKE '%' || $2 || '%'
         )
         UNION ALL
         SELECT url, source_icon, content, NULL::text AS markdown_content, image_urls
         FROM saved_articles
         WHERE user_id = $1 AND (
           url = $3 OR source_icon = $2 OR content LIKE '%' || $2 || '%' OR image_urls::text LIKE '%' || $2 || '%'
         )`,
        [req.session.userId, imageUrl, referer || null],
      )).rows;
      referencedByUserArticle = candidateRows.some(row => (
        row.source_icon === imageUrl
        || normalizeJsonStringArray(row.image_urls).includes(imageUrl)
        || extractImageUrlsFromArticle({
          url: typeof row.url === 'string' ? row.url : undefined,
          content: typeof row.content === 'string' ? row.content : '',
          markdownContent: typeof row.markdown_content === 'string' ? row.markdown_content : undefined,
        }).includes(imageUrl)
      ));
    }
    const isAllowedHost = isAllowlistedHost || referencedByGlobalArticle || referencedByUserArticle;
    if (!isAllowedHost) {
      return res.status(403).send("Host not allowed");
    }
    const imageProxyMaxBytes = readBoundedEnvNumber(process.env.IMAGE_PROXY_MAX_MB, 8, 1, 16) * 1024 * 1024;
    const imageProxyTimeoutMs = readBoundedEnvNumber(process.env.IMAGE_PROXY_TIMEOUT_MS, 8000, 1000, 20000);
    const assertAllowedImageHost = (url: URL) => {
      const candidateHost = url.hostname.toLowerCase();
      if (candidateHost !== hostname && !ALLOWED_IMAGE_HOST_SUFFIXES.some(suffix => candidateHost === suffix || candidateHost.endsWith(`.${suffix}`))) {
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
        allowedPorts: PUBLIC_WEB_PORTS,
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
      res.setHeader(
        'Cache-Control',
        isAllowlistedHost || referencedByGlobalArticle
          ? 'public, max-age=31536000, immutable'
          : 'private, no-store',
      );
      res.send(resource.body);
    } catch (error) {
      logger.error({ err: error, module: "image-proxy", imageHost: parsedUrl.hostname }, "Image proxy error");
      if (error instanceof ResponseLimitError) return res.status(413).send("Remote image is too large");
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return res.status(504).send("Remote image timed out");
      res.status(502).send("Failed to load image");
    }
  }));

  // Authenticated, bounded proxy for podcast audio. The exact URL must already
  // belong to content visible to this account, so this cannot become an open
  // proxy. Range requests are forwarded to preserve seeking and metadata loads.
  app.get("/api/media-proxy", requireAuth, remoteFetchLimiter, asyncHandler(async (req, res) => {
    const targetUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
    if (!targetUrl) return res.status(400).send("Missing url parameter");
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      return res.status(400).send("Invalid url parameter");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol) || (parsedUrl.port && !["80", "443"].includes(parsedUrl.port))) {
      return res.status(400).send("Invalid media URL");
    }
    const authorizedInMemory = articles.some(article => article.audioUrl === targetUrl);
    const authorizedInDatabase = authorizedInMemory ? true : (await pool.query(
      `SELECT (
         EXISTS (SELECT 1 FROM user_articles WHERE user_id = $1 AND audio_url = $2)
         OR EXISTS (SELECT 1 FROM saved_articles WHERE user_id = $1 AND audio_url = $2)
       ) AS authorized`,
      [req.session.userId, targetUrl],
    )).rows[0]?.authorized === true;
    if (!authorizedInDatabase) return res.status(403).send("Media URL is not available to this account");

    const requestedRange = req.get("range")?.trim();
    const rangeMatch = requestedRange?.match(/^bytes=(\d*)-(\d*)$/);
    if (requestedRange && (!rangeMatch || (!rangeMatch[1] && !rangeMatch[2]))) return res.status(416).send("Unsupported range");
    const mediaProxyRangeBytes = readBoundedEnvNumber(process.env.MEDIA_PROXY_RANGE_MB, 8, 1, 16) * 1024 * 1024;
    let range: string;
    if (!rangeMatch) {
      range = `bytes=0-${mediaProxyRangeBytes - 1}`;
    } else if (rangeMatch[1]) {
      const start = Number(rangeMatch[1]);
      const requestedEnd = rangeMatch[2] ? Number(rangeMatch[2]) : start + mediaProxyRangeBytes - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || requestedEnd < start) return res.status(416).send("Unsupported range");
      range = `bytes=${start}-${Math.min(requestedEnd, start + mediaProxyRangeBytes - 1)}`;
    } else {
      const suffixBytes = Number(rangeMatch[2]);
      if (!Number.isSafeInteger(suffixBytes) || suffixBytes <= 0) return res.status(416).send("Unsupported range");
      range = `bytes=-${Math.min(suffixBytes, mediaProxyRangeBytes)}`;
    }
    const mediaProxyTimeoutMs = readBoundedEnvNumber(process.env.MEDIA_PROXY_TIMEOUT_MS, 20_000, 2_000, 60_000);
    let releaseGlobal: (() => void) | undefined;
    let releaseUser: (() => void) | undefined;
    try {
      releaseGlobal = mediaProxyGlobalConcurrencyGuard.acquire("global");
      releaseUser = mediaProxyUserConcurrencyGuard.acquire(authenticatedUserKey(req));
      const resource = await fetchBoundedPublicResource(targetUrl, {
        timeoutMs: mediaProxyTimeoutMs,
        maxBytes: mediaProxyRangeBytes,
        maxRedirects: 3,
        headers: {
          "User-Agent": "AtomFlow/1.0 podcast media proxy",
          Accept: "audio/*,application/ogg,application/octet-stream;q=0.5",
          Range: range,
        },
      });
      if (resource.status !== 200 && resource.status !== 206) throw new Error(`Media source returned ${resource.status}`);
      const contentType = (resource.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!(/^audio\//.test(contentType) || contentType === "application/ogg" || contentType === "application/octet-stream")) {
        return res.status(415).send("Remote content is not supported audio");
      }
      res.status(resource.status);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", String(resource.body.length));
      res.setHeader("Cache-Control", "private, max-age=300");
      const contentRange = resource.headers.get("content-range");
      if (contentRange) res.setHeader("Content-Range", contentRange);
      const acceptRanges = resource.headers.get("accept-ranges");
      if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);
      return res.send(resource.body);
    } catch (error) {
      if (error instanceof ConcurrencyLimitError) {
        res.setHeader("Retry-After", "5");
        return res.status(429).send("Media proxy is busy");
      }
      logger.error({ err: error, module: "media-proxy", mediaHost: parsedUrl.hostname }, "Media proxy error");
      if (error instanceof ResponseLimitError) return res.status(413).send("Remote media is too large");
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return res.status(504).send("Remote media timed out");
      return res.status(502).send("Failed to load media");
    } finally {
      releaseUser?.();
      releaseGlobal?.();
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
              audio_url AS "audioUrl", audio_duration AS "audioDuration",
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
              audio_url AS "audioUrl", audio_duration AS "audioDuration",
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
      throw error;
    } finally {
      client.release();
    }
  }));

  // Translate article content (Baidu Translate API)
  // Supports both single string (content) and array of strings (segments) for paragraph-level translation
  app.post("/api/translate", requireAuth, paidOperationLimiter, dailyPaidOperationBudgetMiddleware, paidConcurrencyMiddleware, asyncHandler(async (req, res) => {
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
      const response = await fetch(`https://fanyi-api.baidu.com/api/trans/vip/translate?${params}`, {
        signal: AbortSignal.timeout(15_000),
      });
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
    const rows = (await pool.query(
      `SELECT id, name, viewport, document_revision AS "documentRevision",
              document_schema_version AS "documentSchemaVersion",
              default_skill_config AS "defaultSkillConfig",
              created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"
       FROM write_canvas_projects
       WHERE user_id = $1
       ORDER BY last_opened_at DESC
       LIMIT $2`,
      [req.session.userId, WRITE_CANVAS_MAX_PROJECTS_PER_USER]
    )).rows;
    const availableSkills = await fetchWriteAgentSkills(pool, req.session.userId);
    const projects = rows.map(row => {
      const effective = resolveEffectiveCanvasSkillsFromAvailable(availableSkills, row.defaultSkillConfig);
      return {
        ...mapCanvasProjectRow(row),
        defaultSkillConfig: effective.skillConfig,
        effectiveSkillConfig: effective.effectiveSkillConfig,
        effectiveSkills: effective.effectiveSkills,
      };
    });
    res.json({ projects });
  }));

  app.post("/api/write/canvas/projects", requireAuth, asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === "string" && req.body.name.trim()
      ? req.body.name.trim().slice(0, 80)
      : "新的魔法写作项目";
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId.trim() : "";
    if (requestId && !REQUEST_ID_PATTERN.test(requestId)) return res.status(400).json({ error: "requestId must be a UUID" });
    const requestAction = "create_canvas_project";
    const defaultSkillConfig = await filterCanvasSkillConfig(pool, req.session.userId, req.body?.defaultSkillConfig, "override");
    let effective = await resolveEffectiveCanvasSkills(pool, req.session.userId, defaultSkillConfig, undefined, "override");
    const client = await pool.connect();
    let row: Record<string, unknown> | undefined;
    let reused = false;
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      if (requestId) {
        row = (await client.query(
          `SELECT p.id, p.name, p.viewport, p.tldraw_snapshot AS "documentSnapshot",
                  p.document_revision AS "documentRevision", p.document_schema_version AS "documentSchemaVersion",
                  p.default_skill_config AS "defaultSkillConfig",
                  p.created_at AS "createdAt", p.updated_at AS "updatedAt", p.last_opened_at AS "lastOpenedAt"
           FROM write_canvas_action_requests r
           JOIN write_canvas_projects p ON p.id = r.result_project_id AND p.user_id = r.user_id
           WHERE r.user_id = $1 AND r.request_id = $2 AND r.action = $3
           FOR SHARE OF r, p`,
          [req.session.userId, requestId, requestAction],
        )).rows[0];
        reused = Boolean(row);
      }
      if (!row) {
        row = (await client.query(
          `INSERT INTO write_canvas_projects (user_id, name, default_skill_config)
           SELECT $1, $2, $4
           WHERE (SELECT COUNT(*) FROM write_canvas_projects WHERE user_id = $1) < $3
           RETURNING id, name, viewport, tldraw_snapshot AS "documentSnapshot",
                     document_revision AS "documentRevision", document_schema_version AS "documentSchemaVersion",
                     default_skill_config AS "defaultSkillConfig",
                     created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"`,
          [req.session.userId, name, WRITE_CANVAS_MAX_PROJECTS_PER_USER, JSON.stringify(defaultSkillConfig)]
        )).rows[0];
        if (row && requestId) {
          await client.query(
            `INSERT INTO write_canvas_action_requests (user_id, request_id, action, result_project_id)
             VALUES ($1, $2, $3, $4)`,
            [req.session.userId, requestId, requestAction, row.id],
          );
        }
      }
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "画布项目数量已达到上限" });
      }
      await client.query("COMMIT");
      if (reused) {
        effective = await resolveEffectiveCanvasSkills(pool, req.session.userId, row.defaultSkillConfig, undefined, "override");
      }
      res.json({
        project: {
          ...mapCanvasProjectRow(row),
          defaultSkillConfig: effective.skillConfig,
          effectiveSkillConfig: effective.effectiveSkillConfig,
          effectiveSkills: effective.effectiveSkills,
        },
        reused,
      });
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
    const viewport = isPlainRecord(req.body?.viewport) ? req.body.viewport : null;
    const hasDefaultSkillConfig = Object.prototype.hasOwnProperty.call(req.body || {}, "defaultSkillConfig");
    const defaultSkillConfig = hasDefaultSkillConfig
      ? await filterCanvasSkillConfig(pool, req.session.userId, req.body?.defaultSkillConfig, "override")
      : null;
    const row = (await pool.query(
      `UPDATE write_canvas_projects
       SET name = COALESCE($1, name),
           viewport = COALESCE($2, viewport),
           default_skill_config = COALESCE($5, default_skill_config),
           updated_at = NOW(),
           last_opened_at = NOW()
       WHERE id = $3 AND user_id = $4
       RETURNING id, name, viewport, tldraw_snapshot AS "documentSnapshot",
                 document_revision AS "documentRevision", document_schema_version AS "documentSchemaVersion",
                 default_skill_config AS "defaultSkillConfig",
                 created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"`,
      [name || null, viewport ? JSON.stringify(viewport) : null, projectId, req.session.userId, defaultSkillConfig ? JSON.stringify(defaultSkillConfig) : null]
    )).rows[0];
    if (!row) return res.status(404).json({ error: "project not found" });
    const effective = await resolveEffectiveCanvasSkills(pool, req.session.userId, row.defaultSkillConfig, undefined, "override");
    res.json({
      project: {
        ...mapCanvasProjectRow(row),
        defaultSkillConfig: effective.skillConfig,
        effectiveSkillConfig: effective.effectiveSkillConfig,
        effectiveSkills: effective.effectiveSkills,
      },
    });
  }));

  const canvasDocumentMultipart = canvasDocumentUpload.fields([
    { name: "snapshot", maxCount: 1 },
    { name: "document", maxCount: 1 },
  ]);
  const updateCanvasDocument = asyncHandler(async (req, res) => {
    const projectId = Number(req.params.id);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return res.status(400).json({ error: "invalid project id" });
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const snapshotFile = files?.snapshot?.[0] || files?.document?.[0];
    const rawSnapshot = snapshotFile?.buffer.toString("utf8")
      || (typeof req.body?.snapshot === "string" ? req.body.snapshot : "")
      || (typeof req.body?.document === "string" ? req.body.document : "");
    if (!rawSnapshot) return res.status(400).json({ error: "snapshot is required" });
    const validatedDocument = validateCanvasDocumentSnapshotInput(rawSnapshot);
    if (validatedDocument.ok === false) {
      return res.status(validatedDocument.status).json({
        error: validatedDocument.error,
        code: validatedDocument.code,
      });
    }
    const snapshot = validatedDocument.snapshot;
    const baseRevision = Number(req.body?.baseRevision ?? req.body?.revision);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      return res.status(400).json({ error: "baseRevision must be a non-negative integer" });
    }
    const legacySchema = typeof req.body?.schema === "string" ? req.body.schema.trim() : "";
    let legacySchemaVersion: unknown = legacySchema || undefined;
    if (legacySchema.startsWith("{")) {
      try {
        const parsedSchema = JSON.parse(legacySchema);
        legacySchemaVersion = isPlainRecord(parsedSchema) ? parsedSchema.schemaVersion : legacySchema;
      } catch {
        legacySchemaVersion = legacySchema;
      }
    }
    const embeddedSchemaVersionInput = isPlainRecord(snapshot.schema)
      ? snapshot.schema.schemaVersion
      : undefined;
    const embeddedSchemaVersion = readCanvasDocumentSchemaVersion(snapshot) ?? undefined;
    const requestedSchemaInput = req.body?.schemaVersion ?? legacySchemaVersion;
    const requestedSchemaVersion = requestedSchemaInput === undefined
      ? undefined
      : Number(requestedSchemaInput);
    if (
      (embeddedSchemaVersionInput !== undefined && embeddedSchemaVersion === undefined)
      || (requestedSchemaVersion !== undefined && (!Number.isSafeInteger(requestedSchemaVersion) || requestedSchemaVersion < 0))
    ) {
      return res.status(400).json({ error: "schemaVersion must be a non-negative integer" });
    }
    if (
      embeddedSchemaVersion !== undefined
      && requestedSchemaVersion !== undefined
      && embeddedSchemaVersion !== requestedSchemaVersion
    ) {
      return res.status(400).json({
        error: "schemaVersion does not match the uploaded document",
        code: "CANVAS_SCHEMA_VERSION_MISMATCH",
      });
    }
    const schemaVersion = embeddedSchemaVersion ?? requestedSchemaVersion ?? 0;
    const viewportInput = parseCanvasViewportInput(req.body?.viewport);
    if (viewportInput.ok === false) return res.status(400).json({ error: viewportInput.error });
    const businessLayouts = extractCanvasBusinessLayouts(snapshot);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const current = (await client.query(
        `SELECT id, document_revision FROM write_canvas_projects
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [projectId, req.session.userId],
      )).rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      const currentRevision = Number(current.document_revision);
      if (currentRevision !== baseRevision) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "画布已在其他位置更新，请合并后重试",
          code: "CANVAS_REVISION_CONFLICT",
          currentRevision,
        });
      }
      if (businessLayouts.length > 0) {
        await client.query(
          `UPDATE write_canvas_nodes AS node
           SET x = layout.x,
               y = layout.y,
               width = layout.width,
               height = layout.height,
               updated_at = NOW()
           FROM jsonb_to_recordset($1::jsonb)
             AS layout(node_id BIGINT, x REAL, y REAL, width REAL, height REAL)
           WHERE node.id = layout.node_id
             AND node.user_id = $2
             AND node.project_id = $3`,
          [JSON.stringify(businessLayouts.map(layout => ({
            node_id: layout.nodeId,
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
          }))), req.session.userId, projectId],
        );
      }
      const row = (await client.query(
        `UPDATE write_canvas_projects
         SET tldraw_snapshot = $1,
             document_snapshot = $1,
             document_revision = document_revision + 1,
             document_schema_version = $2,
             viewport = COALESCE($6::jsonb, viewport),
             updated_at = NOW(), last_opened_at = NOW()
         WHERE id = $3 AND user_id = $4 AND document_revision = $5
         RETURNING id, name, viewport, tldraw_snapshot AS "documentSnapshot",
                   document_revision AS "documentRevision", document_schema_version AS "documentSchemaVersion",
                   default_skill_config AS "defaultSkillConfig",
                   created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"`,
        [
          JSON.stringify(snapshot),
          schemaVersion,
          projectId,
          req.session.userId,
          baseRevision,
          viewportInput.viewport ? JSON.stringify(viewportInput.viewport) : null,
        ],
      )).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "画布版本冲突", code: "CANVAS_REVISION_CONFLICT" });
      }
      await client.query("COMMIT");
      const project = mapCanvasProjectRow(row);
      res.setHeader("ETag", `\"canvas-${projectId}-${project.documentRevision}\"`);
      return res.json({
        snapshot: project.documentSnapshot,
        revision: project.documentRevision,
        schemaVersion: project.documentSchemaVersion,
        document: {
          snapshot: project.documentSnapshot,
          revision: project.documentRevision,
          schemaVersion: project.documentSchemaVersion,
        },
        project,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
  app.put("/api/write/canvas/projects/:id/document", requireAuth, canvasDocumentMultipart, updateCanvasDocument);
  app.put("/api/write/canvas/projects/:id/snapshot", requireAuth, canvasDocumentMultipart, updateCanvasDocument);

  app.post("/api/write/canvas/projects/:id/clone", requireAuth, canvasDocumentMultipart, asyncHandler(async (req, res) => {
    const sourceProjectId = Number(req.params.id);
    if (!Number.isSafeInteger(sourceProjectId) || sourceProjectId <= 0) {
      return res.status(400).json({ error: "invalid project id" });
    }
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const snapshotFile = files?.snapshot?.[0] || files?.document?.[0];
    const rawSnapshot = snapshotFile?.buffer.toString("utf8")
      || (typeof req.body?.snapshot === "string" ? req.body.snapshot : "")
      || (typeof req.body?.document === "string" ? req.body.document : "");
    if (!rawSnapshot) return res.status(400).json({ error: "snapshot is required" });
    const validatedDocument = validateCanvasDocumentSnapshotInput(rawSnapshot);
    if (validatedDocument.ok === false) {
      return res.status(validatedDocument.status).json({
        error: validatedDocument.error,
        code: validatedDocument.code,
      });
    }
    const embeddedSchemaVersionInput = isPlainRecord(validatedDocument.snapshot.schema)
      ? validatedDocument.snapshot.schema.schemaVersion
      : undefined;
    const embeddedSchemaVersion = readCanvasDocumentSchemaVersion(validatedDocument.snapshot) ?? undefined;
    const requestedSchemaInput = req.body?.documentSchemaVersion ?? req.body?.schemaVersion;
    const requestedSchemaVersion = requestedSchemaInput === undefined ? undefined : Number(requestedSchemaInput);
    if (
      (embeddedSchemaVersionInput !== undefined && embeddedSchemaVersion === undefined)
      || (requestedSchemaVersion !== undefined && (!Number.isSafeInteger(requestedSchemaVersion) || requestedSchemaVersion < 0))
    ) {
      return res.status(400).json({ error: "schemaVersion must be a non-negative integer" });
    }
    if (
      embeddedSchemaVersion !== undefined
      && requestedSchemaVersion !== undefined
      && embeddedSchemaVersion !== requestedSchemaVersion
    ) {
      return res.status(400).json({
        error: "schemaVersion does not match the uploaded document",
        code: "CANVAS_SCHEMA_VERSION_MISMATCH",
      });
    }
    const schemaVersion = embeddedSchemaVersion ?? requestedSchemaVersion ?? 0;
    const viewportInput = parseCanvasViewportInput(req.body?.viewport);
    if (viewportInput.ok === false) return res.status(400).json({ error: viewportInput.error });
    const localBusinessLayouts = extractCanvasBusinessLayouts(validatedDocument.snapshot);
    const requestedName = typeof req.body?.name === "string" && req.body.name.trim()
      ? req.body.name.trim().slice(0, 80)
      : "";

    const client = await pool.connect();
    let clonedProjectId: number | null = null;
    let clonedProject: ReturnType<typeof mapCanvasProjectRow> | null = null;
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const sourceProject = (await client.query(
        `SELECT id, name, viewport, default_skill_config
         FROM write_canvas_projects
         WHERE id = $1 AND user_id = $2
         FOR SHARE`,
        [sourceProjectId, req.session.userId],
      )).rows[0];
      if (!sourceProject) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }

      const projectCount = Number((await client.query(
        `SELECT COUNT(*)::int AS count FROM write_canvas_projects WHERE user_id = $1`,
        [req.session.userId],
      )).rows[0]?.count || 0);
      if (projectCount >= WRITE_CANVAS_MAX_PROJECTS_PER_USER) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "画布项目数量已达到上限" });
      }

      const sourceNodes = (await client.query(
        `SELECT id, kind, title, summary, ref_id, asset_id, agent_id, meta,
                x, y, width, height, created_at, updated_at
         FROM write_canvas_nodes
         WHERE project_id = $1 AND user_id = $2
         ORDER BY id ASC
         LIMIT $3
         FOR SHARE`,
        [sourceProjectId, req.session.userId, WRITE_CANVAS_MAX_NODES_PER_PROJECT + 1],
      )).rows;
      if (sourceNodes.length > WRITE_CANVAS_MAX_NODES_PER_PROJECT) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目节点数量已达到上限" });
      }

      const sourceAssets = (await client.query(
        `SELECT id, type, title, content_text, extracted_text, file_name, mime_type,
                data_url, meta, created_at
         FROM write_canvas_assets
         WHERE project_id = $1 AND user_id = $2
         ORDER BY id ASC
         LIMIT $3
         FOR SHARE`,
        [sourceProjectId, req.session.userId, WRITE_CANVAS_CLONE_MAX_ROWS + 1],
      )).rows;
      if (sourceAssets.length > WRITE_CANVAS_CLONE_MAX_ROWS) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目资料数量超过克隆上限" });
      }
      let clonedRowCount = 1 + sourceNodes.length + sourceAssets.length;
      let clonedMessageBytes = 0;
      let clonedMetadataBytes = Buffer.byteLength(JSON.stringify(sourceProject.default_skill_config || {}), "utf8")
        + sourceNodes.reduce((total, node) => total + Buffer.byteLength(JSON.stringify(node.meta || {}), "utf8"), 0)
        + sourceAssets.reduce((total, asset) => total + Buffer.byteLength(JSON.stringify(asset.meta || {}), "utf8"), 0);
      if (clonedRowCount > WRITE_CANVAS_CLONE_MAX_ROWS || clonedMetadataBytes > WRITE_CANVAS_CLONE_MAX_METADATA_BYTES) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目数据量超过克隆上限" });
      }
      const clonedAssetBytes = sourceAssets.reduce((total, asset) => total
        + Buffer.byteLength(String(asset.data_url || ""), "utf8")
        + Buffer.byteLength(String(asset.content_text || ""), "utf8")
        + Buffer.byteLength(String(asset.extracted_text || ""), "utf8"), 0);
      const storedBytes = await getCanvasStoredBytes(client, req.session.userId);
      if (storedBytes + clonedAssetBytes > canvasUserStorageMaxBytes) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "画布资料存储额度已用完，请删除旧资料后重试" });
      }

      const projectRow = (await client.query(
        `INSERT INTO write_canvas_projects
           (user_id, name, viewport, tldraw_snapshot, document_snapshot, document_revision,
            document_schema_version, default_skill_config, last_opened_at)
         VALUES ($1, $2, $3, '{"store":{}}'::jsonb, '{"store":{}}'::jsonb, 0, $4, $5, NOW())
         RETURNING id`,
        [
          req.session.userId,
          requestedName || `${String(sourceProject.name || "魔法写作项目").slice(0, 65)} · 副本`,
          JSON.stringify(viewportInput.viewport || sourceProject.viewport || {}),
          schemaVersion,
          JSON.stringify(sourceProject.default_skill_config || {}),
        ],
      )).rows[0];
      clonedProjectId = Number(projectRow.id);

      const assetIdMap = new Map<number, number>();
      for (const asset of sourceAssets) {
        const clonedAsset = (await client.query(
          `INSERT INTO write_canvas_assets
             (user_id, project_id, type, title, content_text, extracted_text,
              file_name, mime_type, data_url, meta, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            req.session.userId,
            clonedProjectId,
            asset.type,
            asset.title,
            asset.content_text,
            asset.extracted_text,
            asset.file_name,
            asset.mime_type,
            asset.data_url,
            JSON.stringify(asset.meta || {}),
            asset.created_at,
          ],
        )).rows[0];
        assetIdMap.set(Number(asset.id), Number(clonedAsset.id));
      }

      const sourceAgents = (await client.query(
        `SELECT ai.id,
                (SELECT template.id
                 FROM write_agent_templates template
                 WHERE template.id = ai.template_id AND template.user_id = ai.user_id) AS template_id,
                ai.name, ai.model, ai.system_prompt, ai.temperature, ai.top_p,
                ai.max_tokens, ai.skill_config, ai.agent_thread_id, ai.created_at, ai.updated_at
         FROM write_agent_instances ai
         WHERE ai.project_id = $1 AND ai.user_id = $2
         ORDER BY ai.id ASC
         LIMIT $3
         FOR SHARE OF ai`,
        [sourceProjectId, req.session.userId, WRITE_CANVAS_MAX_NODES_PER_PROJECT + 1],
      )).rows;
      if (sourceAgents.length > WRITE_CANVAS_MAX_NODES_PER_PROJECT) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目 Agent 数量超过克隆上限" });
      }
      clonedRowCount += sourceAgents.length * 2;
      clonedMetadataBytes += sourceAgents.reduce(
        (total, agent) => total + Buffer.byteLength(JSON.stringify(agent.skill_config || {}), "utf8"),
        0,
      );
      if (clonedRowCount > WRITE_CANVAS_CLONE_MAX_ROWS || clonedMetadataBytes > WRITE_CANVAS_CLONE_MAX_METADATA_BYTES) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目数据量超过克隆上限" });
      }
      const agentIdMap = new Map<number, number>();
      const threadIdMap = new Map<number, number>();
      const messageIdsByAgent = new Map<string, number>();
      const clonedThreadIds: number[] = [];
      for (const agent of sourceAgents) {
        const sourceThreadId = Number(agent.agent_thread_id);
        let sourceThread: Record<string, unknown> | null = null;
        if (Number.isSafeInteger(sourceThreadId) && sourceThreadId > 0) {
          sourceThread = (await client.query(
            `SELECT id, title, state, created_at, updated_at
             FROM write_agent_threads
             WHERE id = $1 AND user_id = $2 AND thread_type = 'canvas'
             FOR SHARE`,
            [sourceThreadId, req.session.userId],
          )).rows[0];
        }

        // Every cloned Agent receives a valid canvas thread before commit. For
        // pre-thread legacy Agents, migrate the retained legacy history now so
        // post-commit detail loading remains read-only and retry-safe.
        const sourceMessages = sourceThread
          ? (await client.query(
            `SELECT id, role, content, meta, created_at
             FROM (
               SELECT id, role, content, meta, created_at
               FROM write_agent_messages
               WHERE thread_id = $1
               ORDER BY created_at DESC, id DESC
               LIMIT $2
             ) recent
             ORDER BY created_at ASC, id ASC`,
            [sourceThreadId, WRITE_CANVAS_MAX_MESSAGES_PER_AGENT],
          )).rows
          : (await client.query(
            `SELECT id, role, content, meta, created_at
             FROM (
               SELECT id, role, content, meta, created_at
               FROM write_canvas_agent_messages
               WHERE user_id = $1 AND agent_id = $2
                 AND role IN ('user', 'assistant')
               ORDER BY created_at DESC, id DESC
               LIMIT $3
             ) recent
             ORDER BY created_at ASC, id ASC`,
            [req.session.userId, agent.id, WRITE_CANVAS_MAX_MESSAGES_PER_AGENT],
          )).rows;
        clonedRowCount += sourceMessages.length;
        clonedMessageBytes += sourceMessages.reduce(
          (total, sourceMessage) => total + Buffer.byteLength(String(sourceMessage.content || ""), "utf8"),
          0,
        );
        clonedMetadataBytes += Buffer.byteLength(JSON.stringify(sourceThread?.state || {}), "utf8")
          + sourceMessages.reduce(
            (total, sourceMessage) => total + Buffer.byteLength(JSON.stringify(sourceMessage.meta || {}), "utf8"),
            0,
          );
        if (
          clonedRowCount > WRITE_CANVAS_CLONE_MAX_ROWS
          || clonedMessageBytes > WRITE_CANVAS_CLONE_MAX_MESSAGE_BYTES
          || clonedMetadataBytes > WRITE_CANVAS_CLONE_MAX_METADATA_BYTES
        ) {
          await client.query("ROLLBACK");
          return res.status(413).json({ error: "项目消息或元数据超过克隆上限" });
        }
        const sourceState = normalizeJsonObject(sourceThread?.state);
        const clonedThread = (await client.query(
          `INSERT INTO write_agent_threads
             (user_id, title, summary, state, thread_type, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'canvas', $5, $6)
           RETURNING id`,
          [
            req.session.userId,
            sourceThread?.title || `${String(agent.name || "写作 Agent").slice(0, 70)} · 画布会话`,
            summarizeCanvasUserInstructions(sourceMessages),
            JSON.stringify({
              ...sourceState,
              // Keep the source Agent identity until the bounded metadata
              // rewrite below has remapped any message pointers in state.
              // The marker is stripped by remapCanvasCloneMetadata.
              __atomflowCloneSourceAgentId: Number(agent.id),
              canvasAgentId: Number(agent.id),
              canvasProjectId: clonedProjectId,
              activatedNodeIds: [],
              selectedCardIds: [],
              activationSummary: [],
              sourceImageIds: [],
            }),
            sourceThread?.created_at || agent.created_at,
            sourceThread?.updated_at || agent.updated_at,
          ],
        )).rows[0];
        const clonedThreadId = Number(clonedThread.id);
        clonedThreadIds.push(clonedThreadId);
        if (sourceThread) threadIdMap.set(sourceThreadId, clonedThreadId);
        if (sourceMessages.length > 0) {
          await client.query(
            `INSERT INTO write_agent_messages (thread_id, role, content, meta, created_at)
             SELECT $1, message.role, message.content,
                    COALESCE(message.meta, '{}'::jsonb) || jsonb_build_object(
                      '__atomflowCloneSourceAgentId', $3::bigint,
                      '__atomflowCloneSourceMessageId', message.source_id
                    ),
                    message.created_at
             FROM jsonb_to_recordset($2::jsonb)
               AS message(source_id BIGINT, role TEXT, content TEXT, meta JSONB, created_at TIMESTAMPTZ)`,
            [clonedThreadId, JSON.stringify(sourceMessages.map(sourceMessage => ({
              ...sourceMessage,
              source_id: Number(sourceMessage.id),
            }))), Number(agent.id)],
          );
          const clonedMessageMappings = (await client.query(
            `SELECT id, (meta->>'__atomflowCloneSourceMessageId')::bigint AS source_message_id
             FROM write_agent_messages
             WHERE thread_id = $1 AND meta->>'__atomflowCloneSourceAgentId' = $2
             ORDER BY id ASC`,
            [clonedThreadId, String(agent.id)],
          )).rows;
          for (const mapping of clonedMessageMappings) {
            messageIdsByAgent.set(`${Number(agent.id)}:${Number(mapping.source_message_id)}`, Number(mapping.id));
          }
        }

        const clonedAgent = (await client.query(
          `INSERT INTO write_agent_instances
             (user_id, project_id, template_id, name, model, system_prompt,
              temperature, top_p, max_tokens, skill_config, agent_thread_id,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING id`,
          [
            req.session.userId,
            clonedProjectId,
            agent.template_id,
            agent.name,
            agent.model,
            agent.system_prompt,
            agent.temperature,
            agent.top_p,
            agent.max_tokens,
            JSON.stringify(agent.skill_config || {}),
            clonedThreadId,
            agent.created_at,
            agent.updated_at,
          ],
        )).rows[0];
        const clonedAgentId = Number(clonedAgent.id);
        agentIdMap.set(Number(agent.id), clonedAgentId);
      }

      const nodeIdMap = new Map<number, number>();
      for (const node of sourceNodes) {
        const sourceAssetId = Number(node.asset_id);
        // Older Agent nodes may have persisted the Agent only in ref_id.
        // Resolve both representations so the clone never points back to the
        // source project's Agent instance.
        const sourceAgentId = Number(
          node.agent_id ?? (node.kind === "agent" ? node.ref_id : null),
        );
        const clonedAssetId = Number.isSafeInteger(sourceAssetId) && sourceAssetId > 0
          ? assetIdMap.get(sourceAssetId)
          : null;
        const clonedAgentId = Number.isSafeInteger(sourceAgentId) && sourceAgentId > 0
          ? agentIdMap.get(sourceAgentId)
          : null;
        if ((sourceAssetId > 0 && clonedAssetId === undefined) || (sourceAgentId > 0 && clonedAgentId === undefined)) {
          throw new Error("Canvas clone encountered an invalid project relation");
        }
        const clonedNode = (await client.query(
          `INSERT INTO write_canvas_nodes
             (user_id, project_id, kind, title, summary, ref_id, asset_id, agent_id,
              meta, x, y, width, height, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING id`,
          [
            req.session.userId,
            clonedProjectId,
            node.kind,
            node.title,
            node.summary,
            node.kind === "agent" && clonedAgentId ? String(clonedAgentId) : node.ref_id,
            clonedAssetId ?? null,
            clonedAgentId ?? null,
            JSON.stringify(node.meta || {}),
            node.x,
            node.y,
            node.width,
            node.height,
            node.created_at,
            node.updated_at,
          ],
        )).rows[0];
        nodeIdMap.set(Number(node.id), Number(clonedNode.id));
      }
      const clonedBusinessLayouts = localBusinessLayouts.flatMap(layout => {
        const clonedNodeId = nodeIdMap.get(layout.nodeId);
        return clonedNodeId === undefined ? [] : [{
          node_id: clonedNodeId,
          x: layout.x,
          y: layout.y,
          width: layout.width,
          height: layout.height,
        }];
      });
      if (clonedBusinessLayouts.length > 0) {
        await client.query(
          `UPDATE write_canvas_nodes AS node
           SET x = layout.x,
               y = layout.y,
               width = layout.width,
               height = layout.height,
               updated_at = NOW()
           FROM jsonb_to_recordset($1::jsonb)
             AS layout(node_id BIGINT, x REAL, y REAL, width REAL, height REAL)
           WHERE node.id = layout.node_id
             AND node.user_id = $2
             AND node.project_id = $3`,
          [JSON.stringify(clonedBusinessLayouts), req.session.userId, clonedProjectId],
        );
      }

      const sourceEdges = (await client.query(
        `SELECT id, source_node_id, target_node_id, relation, created_at
         FROM write_canvas_edges
         WHERE project_id = $1 AND user_id = $2
         ORDER BY id ASC
         LIMIT $3
         FOR SHARE`,
        [sourceProjectId, req.session.userId, WRITE_CANVAS_DOCUMENT_MAX_RECORDS + 1],
      )).rows;
      if (sourceEdges.length > WRITE_CANVAS_DOCUMENT_MAX_RECORDS) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目上下文连线数量超过克隆上限" });
      }
      clonedRowCount += sourceEdges.length;
      if (clonedRowCount > WRITE_CANVAS_CLONE_MAX_ROWS) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目总记录数超过克隆上限" });
      }
      const edgeIdMap = new Map<number, number>();
      for (const edge of sourceEdges) {
        const clonedSourceNodeId = nodeIdMap.get(Number(edge.source_node_id));
        const clonedTargetNodeId = nodeIdMap.get(Number(edge.target_node_id));
        if (!clonedSourceNodeId || !clonedTargetNodeId) {
          throw new Error("Canvas clone encountered an invalid edge relation");
        }
        const clonedEdge = (await client.query(
          `INSERT INTO write_canvas_edges
             (user_id, project_id, source_node_id, target_node_id, relation, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            req.session.userId,
            clonedProjectId,
            clonedSourceNodeId,
            clonedTargetNodeId,
            edge.relation,
            edge.created_at,
          ],
        )).rows[0];
        edgeIdMap.set(Number(edge.id), Number(clonedEdge.id));
      }

      const cloneEntityMaps: CanvasCloneEntityMaps = {
        sourceProjectId,
        targetProjectId: clonedProjectId,
        assetIds: assetIdMap,
        nodeIds: nodeIdMap,
        edgeIds: edgeIdMap,
        agentIds: agentIdMap,
        threadIds: threadIdMap,
        messageIdsByAgent,
      };
      const clonedNodeMetaRows = (await client.query(
        `SELECT id, meta
         FROM write_canvas_nodes
         WHERE user_id = $1 AND project_id = $2
         ORDER BY id ASC`,
        [req.session.userId, clonedProjectId],
      )).rows.map((row: { id: string | number; meta: unknown }) => ({
        id: Number(row.id),
        meta: remapCanvasCloneMetadata(row.meta, cloneEntityMaps),
      }));
      if (clonedNodeMetaRows.length > 0) {
        for (let offset = 0; offset < clonedNodeMetaRows.length; offset += WRITE_CANVAS_CLONE_METADATA_BATCH_SIZE) {
          await client.query(
            `UPDATE write_canvas_nodes AS node
             SET meta = remapped.meta
             FROM jsonb_to_recordset($1::jsonb) AS remapped(id BIGINT, meta JSONB)
             WHERE node.id = remapped.id AND node.user_id = $2 AND node.project_id = $3`,
            [
              JSON.stringify(clonedNodeMetaRows.slice(offset, offset + WRITE_CANVAS_CLONE_METADATA_BATCH_SIZE)),
              req.session.userId,
              clonedProjectId,
            ],
          );
        }
      }

      const clonedAssetIds = [...assetIdMap.values()];
      if (clonedAssetIds.length > 0) {
        const clonedAssetMetaRows = (await client.query(
          `SELECT id, meta
           FROM write_canvas_assets
           WHERE user_id = $1 AND project_id = $2 AND id = ANY($3::bigint[])
           ORDER BY id ASC`,
          [req.session.userId, clonedProjectId, clonedAssetIds],
        )).rows.map((row: { id: string | number; meta: unknown }) => ({
          id: Number(row.id),
          meta: remapCanvasCloneMetadata(row.meta, cloneEntityMaps),
        }));
        for (let offset = 0; offset < clonedAssetMetaRows.length; offset += WRITE_CANVAS_CLONE_METADATA_BATCH_SIZE) {
          await client.query(
            `UPDATE write_canvas_assets AS asset
             SET meta = remapped.meta
             FROM jsonb_to_recordset($1::jsonb) AS remapped(id BIGINT, meta JSONB)
             WHERE asset.id = remapped.id AND asset.user_id = $2 AND asset.project_id = $3`,
            [
              JSON.stringify(clonedAssetMetaRows.slice(offset, offset + WRITE_CANVAS_CLONE_METADATA_BATCH_SIZE)),
              req.session.userId,
              clonedProjectId,
            ],
          );
        }
      }

      if (clonedThreadIds.length > 0) {
        const clonedThreadStateRows = (await client.query(
          `SELECT id, state
           FROM write_agent_threads
           WHERE user_id = $1 AND id = ANY($2::bigint[])
           ORDER BY id ASC`,
          [req.session.userId, clonedThreadIds],
        )).rows.map((row: { id: string | number; state: unknown }) => ({
          id: Number(row.id),
          state: remapCanvasCloneMetadata(row.state, cloneEntityMaps),
        }));
        for (let offset = 0; offset < clonedThreadStateRows.length; offset += WRITE_CANVAS_CLONE_METADATA_BATCH_SIZE) {
          await client.query(
            `UPDATE write_agent_threads AS thread
             SET state = remapped.state
             FROM jsonb_to_recordset($1::jsonb) AS remapped(id BIGINT, state JSONB)
             WHERE thread.id = remapped.id AND thread.user_id = $2`,
            [
              JSON.stringify(clonedThreadStateRows.slice(offset, offset + WRITE_CANVAS_CLONE_METADATA_BATCH_SIZE)),
              req.session.userId,
            ],
          );
        }

        const clonedMessageMetaRows = (await client.query(
          `SELECT message.id, message.meta
           FROM write_agent_messages AS message
           JOIN write_agent_threads AS thread ON thread.id = message.thread_id
           WHERE thread.user_id = $1 AND thread.id = ANY($2::bigint[])
           ORDER BY message.id ASC`,
          [req.session.userId, clonedThreadIds],
        )).rows.map((row: { id: string | number; meta: unknown }) => ({
          id: Number(row.id),
          meta: remapCanvasCloneMetadata(row.meta, cloneEntityMaps),
        }));
        if (clonedMessageMetaRows.length > 0) {
          for (let offset = 0; offset < clonedMessageMetaRows.length; offset += WRITE_CANVAS_CLONE_METADATA_BATCH_SIZE) {
            await client.query(
              `UPDATE write_agent_messages AS message
               SET meta = remapped.meta
               FROM jsonb_to_recordset($1::jsonb) AS remapped(id BIGINT, meta JSONB),
                    write_agent_threads AS thread
               WHERE message.id = remapped.id
                 AND thread.id = message.thread_id
                 AND thread.user_id = $2
                 AND thread.id = ANY($3::bigint[])`,
              [
                JSON.stringify(clonedMessageMetaRows.slice(offset, offset + WRITE_CANVAS_CLONE_METADATA_BATCH_SIZE)),
                req.session.userId,
                clonedThreadIds,
              ],
            );
          }
        }
      }

      const remappedSnapshot = remapClonedCanvasDocumentSnapshot(
        validatedDocument.snapshot,
        nodeIdMap,
        edgeIdMap,
      );
      const validatedRemappedDocument = validateCanvasDocumentSnapshotInput(remappedSnapshot);
      if (validatedRemappedDocument.ok === false) {
        await client.query("ROLLBACK");
        return res.status(validatedRemappedDocument.status).json({
          error: validatedRemappedDocument.error,
          code: validatedRemappedDocument.code,
        });
      }
      const finalizedProjectRow = (await client.query(
        `UPDATE write_canvas_projects
         SET tldraw_snapshot = $1,
             document_snapshot = $1,
             document_revision = 1,
             document_schema_version = $2,
             updated_at = NOW(),
             last_opened_at = NOW()
         WHERE id = $3 AND user_id = $4
         RETURNING id, name, viewport, tldraw_snapshot AS "documentSnapshot",
                   document_revision AS "documentRevision", document_schema_version AS "documentSchemaVersion",
                   default_skill_config AS "defaultSkillConfig",
                   created_at AS "createdAt", updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt"`,
        [JSON.stringify(validatedRemappedDocument.snapshot), schemaVersion, clonedProjectId, req.session.userId],
      )).rows[0];
      clonedProject = mapCanvasProjectRow(finalizedProjectRow);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    if (!clonedProjectId || !clonedProject) throw new Error("Canvas clone failed to create the target project");
    return res.json({ project: clonedProject });
  }));

  app.post("/api/write/canvas/projects/:id/citations", requireAuth, asyncHandler(async (req, res) => {
    const projectId = Number(req.params.id);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return res.status(400).json({ error: "invalid project id" });
    const captureId = typeof req.body?.captureId === "string" ? req.body.captureId.trim() : "";
    if (!captureId || captureId.length > 128) return res.status(400).json({ error: "captureId is required" });
    const targetAgentNodeId = Number(req.body?.targetAgentNodeId);
    const identity = isPlainRecord(req.body?.articleIdentity)
      ? req.body.articleIdentity
      : isPlainRecord(req.body?.article) ? req.body.article : {};
    const articleId = Number(identity.id ?? req.body?.articleId);
    const sourceUrl = typeof (identity.url ?? req.body?.sourceUrl) === "string"
      ? String(identity.url ?? req.body?.sourceUrl).trim().slice(0, 2048)
      : "";
    const sourceName = typeof (identity.source ?? req.body?.sourceName) === "string"
      ? String(identity.source ?? req.body?.sourceName).trim().slice(0, 200)
      : "";
    const sourceTitle = typeof (identity.title ?? req.body?.sourceTitle) === "string"
      ? String(identity.title ?? req.body?.sourceTitle).trim().slice(0, 500)
      : "";
    if (!Number.isSafeInteger(articleId) && !sourceUrl && !(sourceName && sourceTitle)) {
      return res.status(400).json({ error: "article identity is required" });
    }
    const lookupArticleId = Number.isSafeInteger(articleId) ? articleId : null;
    const normalizedSourceUrl = normalizeArticleUrl(sourceUrl) || sourceUrl;
    const stableArticleIdentity = citationArticleIdentity({
      articleId: lookupArticleId ?? undefined,
      articleTitle: sourceTitle,
      source: sourceName,
      sourceUrl: normalizedSourceUrl,
    });
    const requestedStableIdentity = typeof identity.stableIdentity === "string"
      ? identity.stableIdentity.trim()
      : "";
    if (requestedStableIdentity && requestedStableIdentity !== stableArticleIdentity) {
      return res.status(400).json({
        error: "article stable identity does not match the supplied source",
        code: "CITATION_ARTICLE_IDENTITY_MISMATCH",
      });
    }
    const rawSelection = isPlainRecord(req.body?.selection) ? req.body.selection : {};
    const exact = typeof rawSelection.exact === "string" ? rawSelection.exact : "";
    if (!exact.trim()) return res.status(400).json({ error: "selection.exact is required" });
    if (exact.length > 2000) {
      return res.status(400).json({
        error: "selection.exact cannot exceed 2000 characters",
        code: "CITATION_SELECTION_TOO_LARGE",
      });
    }
    const selection = {
      exact,
      prefix: typeof rawSelection.prefix === "string" ? rawSelection.prefix.slice(-120) : "",
      suffix: typeof rawSelection.suffix === "string" ? rawSelection.suffix.slice(0, 120) : "",
      paragraph: typeof rawSelection.paragraph === "string" ? rawSelection.paragraph.slice(0, 8000) : "",
      heading: typeof rawSelection.heading === "string" ? rawSelection.heading.trim().slice(0, 500) : "",
      capturedAt: typeof rawSelection.capturedAt === "string" && !Number.isNaN(Date.parse(rawSelection.capturedAt))
        ? new Date(rawSelection.capturedAt).toISOString()
        : new Date().toISOString(),
    };
    const citationMatchesRequest = (row: Record<string, unknown>) => {
      const meta = isPlainRecord(row.meta) ? row.meta : {};
      const storedArticle = isPlainRecord(meta.article) ? meta.article : {};
      const storedSelection = isPlainRecord(meta.selection) ? meta.selection : {};
      const storedStableIdentity = typeof storedArticle.stableIdentity === "string"
        ? storedArticle.stableIdentity
        : citationArticleIdentity({
          articleId: Number.isSafeInteger(Number(storedArticle.id)) ? Number(storedArticle.id) : undefined,
          articleTitle: typeof storedArticle.title === "string" ? storedArticle.title : undefined,
          source: typeof storedArticle.source === "string" ? storedArticle.source : undefined,
          sourceUrl: typeof storedArticle.url === "string" ? storedArticle.url : undefined,
        });
      const identityMatches = storedStableIdentity === stableArticleIdentity;
      return identityMatches
        && storedSelection.exact === selection.exact
        && (storedSelection.prefix || "") === selection.prefix
        && (storedSelection.suffix || "") === selection.suffix
        && (storedSelection.paragraph || "") === selection.paragraph
        && (storedSelection.heading || "") === selection.heading;
    };

    // A committed citation is the durable source snapshot. Resolve it before
    // touching the live article source so a lost response remains retryable
    // even after an RSS item or subscription has disappeared.
    const existingClient = await pool.connect();
    let existingCitationNode: Record<string, unknown> | null = null;
    let existingCitationEdge: Record<string, unknown> | null = null;
    try {
      await existingClient.query("BEGIN");
      await lockCanvasUser(existingClient, req.session.userId);
      const project = (await existingClient.query(
        `SELECT id FROM write_canvas_projects WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [projectId, req.session.userId],
      )).rows[0];
      if (!project) {
        await existingClient.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      existingCitationNode = (await existingClient.query(
        `SELECT id, project_id AS "projectId", kind, title, summary, ref_id AS "refId",
                meta, x, y, width, height, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM write_canvas_nodes
         WHERE user_id = $1 AND project_id = $2 AND kind = 'citation' AND ref_id = $3
         FOR UPDATE`,
        [req.session.userId, projectId, captureId],
      )).rows[0] || null;
      if (existingCitationNode && !citationMatchesRequest(existingCitationNode)) {
        await existingClient.query("ROLLBACK");
        return res.status(409).json({
          error: "captureId has already been used for a different citation",
          code: "CITATION_CAPTURE_ID_REUSED",
        });
      }
      if (existingCitationNode && Number.isSafeInteger(targetAgentNodeId) && targetAgentNodeId > 0) {
        const target = (await existingClient.query(
          `SELECT id FROM write_canvas_nodes
           WHERE id = $1 AND user_id = $2 AND project_id = $3 AND kind = 'agent'
           FOR SHARE`,
          [targetAgentNodeId, req.session.userId, projectId],
        )).rows[0];
        if (!target) {
          await existingClient.query("ROLLBACK");
          return res.status(404).json({ error: "target agent node not found" });
        }
        existingCitationEdge = (await existingClient.query(
          `INSERT INTO write_canvas_edges (user_id, project_id, source_node_id, target_node_id, relation)
           VALUES ($1, $2, $3, $4, 'context')
           ON CONFLICT (project_id, source_node_id, target_node_id, relation)
           DO UPDATE SET relation = EXCLUDED.relation
           RETURNING id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                     target_node_id AS "targetNodeId", relation, created_at AS "createdAt"`,
          [req.session.userId, projectId, Number(existingCitationNode.id), targetAgentNodeId],
        )).rows[0];
      }
      await existingClient.query("COMMIT");
    } catch (error) {
      await existingClient.query("ROLLBACK");
      throw error;
    } finally {
      existingClient.release();
    }
    if (existingCitationNode) {
      return res.json({
        node: mapCanvasNodeRow(existingCitationNode),
        edge: existingCitationEdge ? mapCanvasEdgeRow(existingCitationEdge) : null,
        created: false,
      });
    }

    let article = sourceUrl
      ? articles.find(candidate => {
        if (!candidate.url) return false;
        return candidate.url.trim() === sourceUrl
          || normalizeArticleUrl(candidate.url) === normalizedSourceUrl;
      })
      : undefined;
    if (!article && !sourceUrl && lookupArticleId !== null) {
      article = articles.find(candidate => (
        candidate.id === lookupArticleId
        && (!sourceName || candidate.source === sourceName)
      ));
    }
    if (!article && sourceName && sourceTitle) {
      article = findArticleByIdentity(articles, { source: sourceName, title: sourceTitle });
    }
    const lookupParams = [
      req.session.userId,
      sourceUrl,
      normalizedSourceUrl,
      sourceName,
      sourceTitle,
      sourceUrl ? null : lookupArticleId,
    ];
    if (!article) {
      const row = (await pool.query(
        `SELECT id, source, source_icon, topic, title, excerpt, content, url,
                audio_url, audio_duration, published_at, time_str
         FROM user_articles
         WHERE user_id = $1
           AND (
             ($2::text <> '' AND (url = $2 OR url = $3))
             OR ($6::bigint IS NOT NULL AND id = $6 AND ($4::text = '' OR source = $4))
             OR ($4::text <> '' AND $5::text <> '' AND source = $4 AND title = $5)
           )
         ORDER BY CASE
           WHEN $2::text <> '' AND (url = $2 OR url = $3) THEN 0
           WHEN $6::bigint IS NOT NULL AND id = $6 AND ($4::text = '' OR source = $4) THEN 1
           WHEN $4::text <> '' AND $5::text <> '' AND source = $4 AND title = $5 THEN 2
           ELSE 2
         END
         LIMIT 1`,
        lookupParams,
      )).rows[0];
      if (row) {
        article = {
          id: Number(row.id),
          saved: false,
          source: row.source,
          sourceIcon: row.source_icon || undefined,
          topic: row.topic,
          title: row.title,
          excerpt: row.excerpt,
          content: row.content,
          url: row.url || undefined,
          audioUrl: row.audio_url || undefined,
          audioDuration: row.audio_duration || undefined,
          publishedAt: row.published_at ? Number(row.published_at) : undefined,
          time: row.time_str || "",
          cards: [],
        };
      }
    }
    if (!article) {
      const row = (await pool.query(
        `SELECT id, source, source_icon, topic, title, excerpt, content, url,
                audio_url, audio_duration, published_at
         FROM saved_articles
         WHERE user_id = $1
           AND (
             ($2::text <> '' AND (url = $2 OR url = $3))
             OR ($6::bigint IS NOT NULL AND id = $6 AND ($4::text = '' OR source = $4))
             OR ($4::text <> '' AND $5::text <> '' AND source = $4 AND title = $5)
           )
         ORDER BY CASE
           WHEN $2::text <> '' AND (url = $2 OR url = $3) THEN 0
           WHEN $6::bigint IS NOT NULL AND id = $6 AND ($4::text = '' OR source = $4) THEN 1
           WHEN $4::text <> '' AND $5::text <> '' AND source = $4 AND title = $5 THEN 2
           ELSE 2
         END, saved_at DESC
         LIMIT 1`,
        lookupParams,
      )).rows[0];
      if (row) {
        article = {
          id: Number(row.id),
          saved: true,
          source: row.source,
          sourceIcon: row.source_icon || undefined,
          topic: row.topic,
          title: row.title,
          excerpt: row.excerpt,
          content: row.content,
          url: row.url || undefined,
          audioUrl: row.audio_url || undefined,
          audioDuration: row.audio_duration || undefined,
          publishedAt: row.published_at ? Number(row.published_at) : undefined,
          time: "",
          cards: [],
        };
      }
    }
    if (!article) return res.status(404).json({ error: "article not found" });

    const rawPosition = isPlainRecord(req.body?.position) ? req.body.position : {};
    const x = clampNumber(rawPosition.x, 120, -100000, 100000);
    const y = clampNumber(rawPosition.y, 120, -100000, 100000);
    const articleSnapshot = {
      id: article.id,
      stableIdentity: stableArticleIdentity,
      title: article.title.slice(0, 500),
      source: article.source.slice(0, 200),
      url: article.url?.slice(0, 2048),
      topic: article.topic.slice(0, 200),
      excerpt: article.excerpt.slice(0, 2000),
      publishedAt: article.publishedAt,
      audioUrl: article.audioUrl?.slice(0, 2048),
      audioDuration: article.audioDuration?.slice(0, 100),
      fetchedAt: new Date().toISOString(),
    };
    const nodeMeta = { captureId, article: articleSnapshot, selection };

    const client = await pool.connect();
    let nodeRow: Record<string, unknown>;
    let edgeRow: Record<string, unknown> | null = null;
    let created = false;
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
      const existing = (await client.query(
        `SELECT id, project_id AS "projectId", kind, title, summary, ref_id AS "refId",
                meta, x, y, width, height, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM write_canvas_nodes
         WHERE user_id = $1 AND project_id = $2 AND kind = 'citation' AND ref_id = $3
         FOR UPDATE`,
        [req.session.userId, projectId, captureId],
      )).rows[0];
      if (existing) {
        if (!citationMatchesRequest(existing)) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "captureId has already been used for a different citation",
            code: "CITATION_CAPTURE_ID_REUSED",
          });
        }
        nodeRow = existing;
      } else {
        const nodeCount = Number((await client.query(
          `SELECT COUNT(*)::int AS count FROM write_canvas_nodes WHERE project_id = $1 AND user_id = $2`,
          [projectId, req.session.userId],
        )).rows[0]?.count || 0);
        if (nodeCount >= WRITE_CANVAS_MAX_NODES_PER_PROJECT) {
          await client.query("ROLLBACK");
          return res.status(413).json({ error: "项目节点数量已达到上限" });
        }
        nodeRow = (await client.query(
          `INSERT INTO write_canvas_nodes
             (user_id, project_id, kind, title, summary, ref_id, meta, x, y, width, height)
           VALUES ($1, $2, 'citation', $3, $4, $5, $6, $7, $8, 320, 190)
           ON CONFLICT DO NOTHING
           RETURNING id, project_id AS "projectId", kind, title, summary, ref_id AS "refId",
                     meta, x, y, width, height, created_at AS "createdAt", updated_at AS "updatedAt"`,
          [
            req.session.userId,
            projectId,
            selection.heading || article.title,
            exact.slice(0, 500),
            captureId,
            JSON.stringify(nodeMeta),
            x,
            y,
          ],
        )).rows[0];
        if (!nodeRow) {
          nodeRow = (await client.query(
            `SELECT id, project_id AS "projectId", kind, title, summary, ref_id AS "refId",
                    meta, x, y, width, height, created_at AS "createdAt", updated_at AS "updatedAt"
             FROM write_canvas_nodes
             WHERE user_id = $1 AND project_id = $2 AND kind = 'citation' AND ref_id = $3`,
            [req.session.userId, projectId, captureId],
          )).rows[0];
        } else {
          created = true;
        }
      }
      if (Number.isSafeInteger(targetAgentNodeId) && targetAgentNodeId > 0) {
        const target = (await client.query(
          `SELECT id FROM write_canvas_nodes
           WHERE id = $1 AND user_id = $2 AND project_id = $3 AND kind = 'agent'
           FOR SHARE`,
          [targetAgentNodeId, req.session.userId, projectId],
        )).rows[0];
        if (!target) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "target agent node not found" });
        }
        edgeRow = (await client.query(
          `INSERT INTO write_canvas_edges (user_id, project_id, source_node_id, target_node_id, relation)
           VALUES ($1, $2, $3, $4, 'context')
           ON CONFLICT (project_id, source_node_id, target_node_id, relation)
           DO UPDATE SET relation = EXCLUDED.relation
           RETURNING id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                     target_node_id AS "targetNodeId", relation, created_at AS "createdAt"`,
          [req.session.userId, projectId, Number(nodeRow.id), targetAgentNodeId],
        )).rows[0];
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return res.json({
      node: mapCanvasNodeRow(nodeRow),
      edge: edgeRow ? mapCanvasEdgeRow(edgeRow) : null,
      created,
    });
  }));

  app.delete("/api/write/canvas/projects/:id", requireAuth, asyncHandler(async (req, res) => {
    const projectId = Number(req.params.id);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return res.status(400).json({ error: "invalid project id" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const agentThreadIds = (await client.query(
        `SELECT agent_thread_id FROM write_agent_instances
         WHERE project_id = $1 AND user_id = $2 AND agent_thread_id IS NOT NULL
         FOR UPDATE`,
        [projectId, req.session.userId],
      )).rows.map(row => Number(row.agent_thread_id));
      if (await hasActiveCanvasAgentRun(client, req.session.userId, { projectId })) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          code: "CANVAS_AGENT_RUN_ACTIVE",
          error: "项目中仍有 Agent 正在生成内容，请等待完成后再删除",
          retryable: true,
        });
      }
      const result = await client.query(
        `DELETE FROM write_canvas_projects WHERE id = $1 AND user_id = $2`,
        [projectId, req.session.userId]
      );
      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      if (agentThreadIds.length > 0) {
        await client.query(
          `DELETE FROM write_agent_threads WHERE user_id = $1 AND id = ANY($2::bigint[])`,
          [req.session.userId, agentThreadIds],
        );
      }
      await client.query("COMMIT");
      res.json({ success: true });
    } catch (error) {
      await client.query("ROLLBACK");
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
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId.trim() : "";
    if (requestId && !REQUEST_ID_PATTERN.test(requestId)) return res.status(400).json({ error: "requestId must be a UUID" });
    const requestAction = kind === "podcast_episode" ? "add_podcast_episode" : "create_canvas_node";
    if (kind === "citation") {
      return res.status(400).json({ error: "citation nodes must be created through the citations API" });
    }
    const x = clampNumber(req.body?.x, 120, -100000, 100000);
    const y = clampNumber(req.body?.y, 120, -100000, 100000);
    const width = clampNumber(req.body?.width, kind === "agent" ? 360 : 280, 160, 1200);
    const height = clampNumber(req.body?.height, kind === "agent" ? 260 : 180, 120, 1000);
    const meta = normalizeJsonObject(req.body?.meta);
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

    let createdNodeId: number | null = null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fail = async (status: number, error: string) => {
        await client.query("ROLLBACK");
        return res.status(status).json({ error });
      };
      await lockCanvasUser(client, req.session.userId);
      const project = (await client.query(
        `SELECT id, default_skill_config FROM write_canvas_projects WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [projectId, req.session.userId]
      )).rows[0];
      if (!project) return await fail(404, "project not found");
      if (requestId) {
        const existing = (await client.query(
          `SELECT n.id, n.project_id AS "projectId", n.kind, n.title, n.summary,
                  n.ref_id AS "refId", n.asset_id AS "assetId", n.agent_id AS "agentId",
                  n.meta, n.x, n.y, n.width, n.height,
                  n.created_at AS "createdAt", n.updated_at AS "updatedAt"
           FROM write_canvas_action_requests r
           JOIN write_canvas_nodes n ON n.id = r.result_node_id AND n.user_id = r.user_id
           WHERE r.user_id = $1 AND r.request_id = $2 AND r.action = $3
           FOR SHARE OF r, n`,
          [req.session.userId, requestId, requestAction],
        )).rows[0];
        if (existing) {
          if (Number(existing.projectId) !== projectId) {
            return await fail(409, "requestId has already been used for a different project");
          }
          await client.query("COMMIT");
          return res.json({ node: mapCanvasNodeRow(existing), reused: true });
        }
      }
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
      const requestedSkillConfig = Object.prototype.hasOwnProperty.call(req.body || {}, "skillConfig")
        ? req.body.skillConfig
        : template?.skill_config;
      const skillConfig = await filterCanvasSkillConfig(client, req.session.userId, requestedSkillConfig);
      const row = (await client.query(
        `INSERT INTO write_agent_instances
           (user_id, project_id, template_id, name, model, system_prompt, temperature, top_p, max_tokens, skill_config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
          Math.round(clampNumber(req.body?.maxTokens ?? template?.max_tokens, defaults.maxTokens, 128, getCanvasAgentMaxOutputTokens())),
          JSON.stringify(skillConfig),
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
      } else if (kind === "podcast_episode") {
      const episode = isPlainRecord(meta.episode) ? meta.episode : meta;
      const audioUrl = typeof episode.audioUrl === "string" ? episode.audioUrl.trim().slice(0, 2048) : "";
      if (audioUrl && !/^https?:\/\//i.test(audioUrl)) return await fail(400, "podcast audioUrl must use http or https");
      const episodeTitle = typeof episode.title === "string" ? episode.title.trim().slice(0, 500) : title;
      const episodeUrl = typeof episode.sourceUrl === "string"
        ? episode.sourceUrl.trim().slice(0, 2048)
        : typeof episode.url === "string" ? episode.url.trim().slice(0, 2048) : "";
      title = title || episodeTitle || "播客单集";
      summary = summary || (typeof episode.excerpt === "string" ? episode.excerpt.trim().slice(0, 500) : "");
      refId = refId?.slice(0, 128) || createHash("sha256")
        .update(`${episodeUrl}|${audioUrl}|${title}`, "utf8")
        .digest("hex");
      }

      const nodeRow = (await client.query(
      `INSERT INTO write_canvas_nodes
         (user_id, project_id, kind, title, summary, ref_id, asset_id, agent_id, meta, x, y, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        req.session.userId,
        projectId,
        kind,
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
      createdNodeId = Number(nodeRow.id);
      if (requestId) {
        await client.query(
          `INSERT INTO write_canvas_action_requests (user_id, request_id, action, result_node_id)
           VALUES ($1, $2, $3, $4)`,
          [req.session.userId, requestId, requestAction, createdNodeId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const detail = await fetchCanvasProjectDetail(pool, req.session.userId, projectId);
    const node = detail?.nodes.find(item => item.id === createdNodeId);
    res.json({ node, reused: false });
  }));

  app.put("/api/write/canvas/nodes/:id", requireAuth, asyncHandler(async (req, res) => {
    const nodeId = Number(req.params.id);
    if (!Number.isFinite(nodeId)) return res.status(400).json({ error: "invalid node id" });
    const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 120) : null;
    const summary = typeof req.body?.summary === "string" ? req.body.summary.trim().slice(0, 500) : null;
    const hasMetaUpdate = Object.prototype.hasOwnProperty.call(req.body || {}, "meta");
    const meta = isPlainRecord(req.body?.meta) ? req.body.meta : null;
    let projectId: number | null = null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const owner = (await client.query(
        `SELECT project_id
         FROM write_canvas_nodes
         WHERE id = $1 AND user_id = $2`,
        [nodeId, req.session.userId],
      )).rows[0];
      if (!owner) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "node not found" });
      }
      const project = (await client.query(
        `SELECT id
         FROM write_canvas_projects
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [owner.project_id, req.session.userId],
      )).rows[0];
      if (!project) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      const current = (await client.query(
        `SELECT id, project_id, kind, agent_id
         FROM write_canvas_nodes
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [nodeId, req.session.userId],
      )).rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "node not found" });
      }
      projectId = Number(current.project_id);
      if (["citation", "podcast_episode", "result"].includes(String(current.kind)) && hasMetaUpdate) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "provenance metadata cannot be edited through the generic node API" });
      }
      const requestedAgentModel = current.agent_id && typeof req.body?.model === "string" && req.body.model.trim()
        ? resolveAllowedCanvasAgentModel(req.body.model, req.body.model)
        : null;
      if (current.agent_id && typeof req.body?.model === "string" && req.body.model.trim() && !requestedAgentModel) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "该模型未被服务器允许" });
      }
      const hasSkillConfig = current.agent_id && Object.prototype.hasOwnProperty.call(req.body || {}, "skillConfig");
      const skillConfig = hasSkillConfig
        ? await filterCanvasSkillConfig(client, req.session.userId, req.body?.skillConfig)
        : null;
      if (current.agent_id) {
        const lockedAgent = (await client.query(
          `SELECT id
           FROM write_agent_instances
           WHERE id = $1 AND user_id = $2 AND project_id = $3
           FOR UPDATE`,
          [current.agent_id, req.session.userId, projectId],
        )).rows[0];
        if (!lockedAgent) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "agent not found" });
        }
      }
      await client.query(
        `UPDATE write_canvas_nodes
         SET title = COALESCE($1, title),
             summary = COALESCE($2, summary),
             meta = COALESCE($3, meta),
             x = COALESCE($4, x),
             y = COALESCE($5, y),
             width = COALESCE($6, width),
             height = COALESCE($7, height),
             updated_at = NOW()
         WHERE id = $8 AND user_id = $9`,
        [
          title,
          summary,
          meta ? JSON.stringify(meta) : null,
          req.body?.x === undefined ? null : clampNumber(req.body.x, 0, -100000, 100000),
          req.body?.y === undefined ? null : clampNumber(req.body.y, 0, -100000, 100000),
          req.body?.width === undefined ? null : clampNumber(req.body.width, 280, 160, 1200),
          req.body?.height === undefined ? null : clampNumber(req.body.height, 180, 120, 1000),
          nodeId,
          req.session.userId,
        ],
      );
      if (current.agent_id) {
        const defaults = getDefaultCanvasAgentConfig();
        await client.query(
          `UPDATE write_agent_instances
           SET name = COALESCE($1, name),
               model = COALESCE($2, model),
               system_prompt = COALESCE($3, system_prompt),
               temperature = COALESCE($4, temperature),
               top_p = COALESCE($5, top_p),
               max_tokens = COALESCE($6, max_tokens),
               skill_config = COALESCE($7, skill_config),
               updated_at = NOW()
           WHERE id = $8 AND user_id = $9`,
          [
            title,
            requestedAgentModel,
            typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt.slice(0, 8000) : null,
            req.body?.temperature === undefined ? null : clampNumber(req.body.temperature, defaults.temperature, 0, 2),
            req.body?.topP === undefined ? null : clampNumber(req.body.topP, defaults.topP, 0.01, 1),
            req.body?.maxTokens === undefined ? null : Math.round(clampNumber(req.body.maxTokens, defaults.maxTokens, 128, getCanvasAgentMaxOutputTokens())),
            skillConfig ? JSON.stringify(skillConfig) : null,
            current.agent_id,
            req.session.userId,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const detail = await fetchCanvasProjectDetail(pool, req.session.userId, Number(projectId));
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
      const owner = (await client.query(
        `SELECT project_id
         FROM write_canvas_nodes
         WHERE id = $1 AND user_id = $2`,
        [nodeId, req.session.userId],
      )).rows[0];
      if (!owner) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "node not found" });
      }
      const project = (await client.query(
        `SELECT id
         FROM write_canvas_projects
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [owner.project_id, req.session.userId],
      )).rows[0];
      if (!project) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      const current = (await client.query(
        `SELECT id, agent_id, asset_id
         FROM write_canvas_nodes
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [nodeId, req.session.userId]
      )).rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "node not found" });
      }
      let agentThreadId: number | null = null;
      if (current.agent_id) {
        const agent = (await client.query(
          `SELECT id, agent_thread_id
           FROM write_agent_instances
           WHERE id = $1 AND user_id = $2 AND project_id = $3
           FOR UPDATE`,
          [current.agent_id, req.session.userId, owner.project_id],
        )).rows[0];
        agentThreadId = agent?.agent_thread_id ? Number(agent.agent_thread_id) : null;
        if (agent && await hasActiveCanvasAgentRun(client, req.session.userId, { agentId: Number(agent.id) })) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            code: "CANVAS_AGENT_RUN_ACTIVE",
            error: "该 Agent 正在生成内容，请等待完成后再删除",
            retryable: true,
          });
        }
      }
      if (current.asset_id) {
        await client.query(
          `SELECT id FROM write_canvas_assets WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [current.asset_id, req.session.userId]
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
        if (agentThreadId) {
          await client.query(
            `DELETE FROM write_agent_threads WHERE id = $1 AND user_id = $2`,
            [agentThreadId, req.session.userId],
          );
        }
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
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/write/canvas/edges", requireAuth, asyncHandler(async (req, res) => {
    const projectId = Number(req.body?.projectId);
    const sourceNodeId = Number(req.body?.sourceNodeId);
    const targetNodeId = Number(req.body?.targetNodeId);
    if (![projectId, sourceNodeId, targetNodeId].every(value => Number.isSafeInteger(value) && value > 0)) {
      return res.status(400).json({ error: "projectId, sourceNodeId and targetNodeId are required" });
    }
    if (sourceNodeId === targetNodeId) return res.status(400).json({ error: "cannot connect node to itself" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const project = (await client.query(
        `SELECT id FROM write_canvas_projects
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [projectId, req.session.userId],
      )).rows[0];
      if (!project) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      const nodes = (await client.query(
        `SELECT id, kind FROM write_canvas_nodes
         WHERE user_id = $1 AND project_id = $2 AND id = ANY($3::bigint[])
         ORDER BY id ASC
         FOR SHARE`,
        [req.session.userId, projectId, [sourceNodeId, targetNodeId]],
      )).rows;
      const source = nodes.find(node => Number(node.id) === sourceNodeId);
      const target = nodes.find(node => Number(node.id) === targetNodeId);
      if (nodes.length !== 2 || !source || !target) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "nodes not found" });
      }
      if (source.kind === "agent" || target.kind !== "agent") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "context must connect material to an agent" });
      }
      const row = (await client.query(
        `INSERT INTO write_canvas_edges (user_id, project_id, source_node_id, target_node_id, relation)
         VALUES ($1, $2, $3, $4, 'context')
         ON CONFLICT (project_id, source_node_id, target_node_id, relation)
         DO UPDATE SET relation = EXCLUDED.relation
         RETURNING id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                   target_node_id AS "targetNodeId", relation, created_at AS "createdAt"`,
        [req.session.userId, projectId, sourceNodeId, targetNodeId],
      )).rows[0];
      await client.query("COMMIT");
      return res.json({ edge: mapCanvasEdgeRow(row) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.put("/api/write/canvas/edges/:id", requireAuth, asyncHandler(async (req, res) => {
    const edgeId = Number(req.params.id);
    const projectId = Number(req.body?.projectId);
    const sourceNodeId = Number(req.body?.sourceNodeId);
    const targetNodeId = Number(req.body?.targetNodeId);
    if (![edgeId, projectId, sourceNodeId, targetNodeId].every(value => Number.isSafeInteger(value) && value > 0)) {
      return res.status(400).json({ error: "edge id and valid endpoints are required" });
    }
    if (sourceNodeId === targetNodeId) return res.status(400).json({ error: "cannot connect node to itself" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const project = (await client.query(
        `SELECT id FROM write_canvas_projects
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [projectId, req.session.userId],
      )).rows[0];
      if (!project) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "project not found" });
      }
      const nodes = (await client.query(
        `SELECT id, kind FROM write_canvas_nodes
         WHERE user_id = $1 AND project_id = $2 AND id = ANY($3::bigint[])
         ORDER BY id ASC
         FOR SHARE`,
        [req.session.userId, projectId, [sourceNodeId, targetNodeId]],
      )).rows;
      const source = nodes.find(node => Number(node.id) === sourceNodeId);
      const target = nodes.find(node => Number(node.id) === targetNodeId);
      if (nodes.length !== 2 || !source || !target) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "nodes not found" });
      }
      if (source.kind === "agent" || target.kind !== "agent") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "context must connect material to an agent" });
      }

      // Keep the global canvas lock order consistent with clone and other
      // project mutations: user -> project -> sorted nodes -> edge rows.
      const current = (await client.query(
        `SELECT id, project_id
         FROM write_canvas_edges
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [edgeId, req.session.userId],
      )).rows[0];
      if (!current || Number(current.project_id) !== projectId) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "edge not found" });
      }

      const existing = (await client.query(
        `SELECT id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                target_node_id AS "targetNodeId", relation, created_at AS "createdAt"
         FROM write_canvas_edges
         WHERE user_id = $1 AND project_id = $2 AND source_node_id = $3
           AND target_node_id = $4 AND relation = 'context' AND id <> $5
         FOR UPDATE`,
        [req.session.userId, projectId, sourceNodeId, targetNodeId, edgeId],
      )).rows[0];
      let row: Record<string, unknown>;
      if (existing) {
        await client.query(
          `DELETE FROM write_canvas_edges WHERE id = $1 AND user_id = $2`,
          [edgeId, req.session.userId],
        );
        row = existing;
      } else {
        row = (await client.query(
          `UPDATE write_canvas_edges
           SET source_node_id = $1, target_node_id = $2
           WHERE id = $3 AND user_id = $4 AND project_id = $5
           RETURNING id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                     target_node_id AS "targetNodeId", relation, created_at AS "createdAt"`,
          [sourceNodeId, targetNodeId, edgeId, req.session.userId, projectId],
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

  app.post("/api/write/canvas/assets/upload", requireAuth, uploadLimiter, uploadConcurrencyMiddleware, canvasAssetUpload.single("file"), asyncHandler(async (req, res) => {
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
    const extractedText = isImage ? "" : await extractCanvasFileText(req.file).catch(error => {
      logger.warn({ err: error, module: "canvas-upload", fileName: req.file?.originalname }, "Canvas file text extraction failed");
      return "";
    });
    const title = (typeof req.body?.title === "string" && req.body.title.trim())
      ? req.body.title.trim().slice(0, 120)
      : req.file.originalname || "上传资料";
    const dataUrl = isImage ? `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}` : null;
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
      const newAssetBytes = Buffer.byteLength(dataUrl || "", "utf8") + Buffer.byteLength(extractedText, "utf8");
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
          JSON.stringify({ size: req.file.size })
        ]
      )).rows[0];
      const nodeKind = isImage ? "asset_image" : "asset_file";
      const nodeResponse = await client.query(
        `INSERT INTO write_canvas_nodes
           (user_id, project_id, kind, title, summary, asset_id, meta, x, y, width, height)
         VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8, $9, $10)
         RETURNING id`,
        [
          req.session.userId,
          projectId,
          nodeKind,
          title,
          isImage ? "图片资料" : normalizePlainText(extractedText).slice(0, 180),
          Number(assetRow.id),
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
      throw error;
    } finally {
      client.release();
    }
    const detail = await fetchCanvasProjectDetail(pool, req.session.userId, projectId);
    const node = detail?.nodes.find(item => item.id === nodeId);
    res.json({ node });
  }));

  app.get("/api/write/agent/templates", requireAuth, asyncHandler(async (req, res) => {
    const [rowsResult, availableSkills] = await Promise.all([
      pool.query(
      `SELECT id, name, model, system_prompt AS "systemPrompt", temperature, top_p AS "topP",
              max_tokens AS "maxTokens", skill_config AS "skillConfig",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM write_agent_templates
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 100`,
      [req.session.userId],
      ),
      fetchWriteAgentSkills(pool, req.session.userId),
    ]);
    const templates = rowsResult.rows.map(row => {
      const effective = resolveEffectiveCanvasSkillsFromAvailable(availableSkills, row.skillConfig, undefined, "inherit");
      return mapAgentTemplateRow({ ...row, ...effective });
    });
    res.json({ templates });
  }));

  app.post("/api/write/agent/templates", requireAuth, asyncHandler(async (req, res) => {
    const defaults = getDefaultCanvasAgentConfig();
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 60) : "写作 Agent 模板";
    const templateModel = resolveAllowedCanvasAgentModel(req.body?.model, defaults.model);
    if (!templateModel) return res.status(400).json({ error: "该模型未被服务器允许" });
    const skillConfig = await filterCanvasSkillConfig(pool, req.session.userId, req.body?.skillConfig);
    const effective = await resolveEffectiveCanvasSkills(pool, req.session.userId, skillConfig, undefined, "inherit");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const row = (await client.query(
        `INSERT INTO write_agent_templates (user_id, name, model, system_prompt, temperature, top_p, max_tokens, skill_config)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8
         WHERE (SELECT COUNT(*) FROM write_agent_templates WHERE user_id = $1) < 100
         RETURNING id, name, model, system_prompt AS "systemPrompt", temperature, top_p AS "topP",
                   max_tokens AS "maxTokens", skill_config AS "skillConfig",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          req.session.userId,
          name,
          templateModel,
          typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt.slice(0, 8000) : defaults.systemPrompt,
          clampNumber(req.body?.temperature, defaults.temperature, 0, 2),
          clampNumber(req.body?.topP, defaults.topP, 0.01, 1),
          Math.round(clampNumber(req.body?.maxTokens, defaults.maxTokens, 128, getCanvasAgentMaxOutputTokens())),
          JSON.stringify(skillConfig),
        ]
      )).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "Agent 模板数量已达到上限" });
      }
      await client.query("COMMIT");
      res.json({ template: mapAgentTemplateRow({ ...row, ...effective }) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.put("/api/write/agent/templates/:id", requireAuth, asyncHandler(async (req, res) => {
    const templateId = Number(req.params.id);
    if (!Number.isSafeInteger(templateId) || templateId <= 0) return res.status(400).json({ error: "invalid template id" });
    const defaults = getDefaultCanvasAgentConfig();
    const requestedModel = typeof req.body?.model === "string" && req.body.model.trim()
      ? resolveAllowedCanvasAgentModel(req.body.model, req.body.model)
      : null;
    if (typeof req.body?.model === "string" && req.body.model.trim() && !requestedModel) {
      return res.status(400).json({ error: "该模型未被服务器允许" });
    }
    const hasSkillConfig = Object.prototype.hasOwnProperty.call(req.body || {}, "skillConfig");
    const skillConfig = hasSkillConfig
      ? await filterCanvasSkillConfig(pool, req.session.userId, req.body.skillConfig)
      : null;
    const row = (await pool.query(
      `UPDATE write_agent_templates
       SET name = COALESCE($1, name), model = COALESCE($2, model),
           system_prompt = COALESCE($3, system_prompt), temperature = COALESCE($4, temperature),
           top_p = COALESCE($5, top_p), max_tokens = COALESCE($6, max_tokens),
           skill_config = COALESCE($7, skill_config), updated_at = NOW()
       WHERE id = $8 AND user_id = $9
       RETURNING id, name, model, system_prompt AS "systemPrompt", temperature, top_p AS "topP",
                 max_tokens AS "maxTokens", skill_config AS "skillConfig",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 60) : null,
        requestedModel,
        typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt.slice(0, 8000) : null,
        req.body?.temperature === undefined ? null : clampNumber(req.body.temperature, defaults.temperature, 0, 2),
        req.body?.topP === undefined ? null : clampNumber(req.body.topP, defaults.topP, 0.01, 1),
        req.body?.maxTokens === undefined ? null : Math.round(clampNumber(req.body.maxTokens, defaults.maxTokens, 128, getCanvasAgentMaxOutputTokens())),
        skillConfig ? JSON.stringify(skillConfig) : null,
        templateId,
        req.session.userId,
      ],
    )).rows[0];
    if (!row) return res.status(404).json({ error: "template not found" });
    const effective = await resolveEffectiveCanvasSkills(pool, req.session.userId, row.skillConfig, undefined, "inherit");
    return res.json({ template: mapAgentTemplateRow({ ...row, ...effective }) });
  }));

  app.get("/api/write/canvas/agents/:id/skills", requireAuth, asyncHandler(async (req, res) => {
    const agentId = Number(req.params.id);
    if (!Number.isSafeInteger(agentId) || agentId <= 0) return res.status(400).json({ error: "invalid agent id" });
    const row = (await pool.query(
      `SELECT ai.skill_config AS "skillConfig", p.default_skill_config AS "projectDefaultSkillConfig"
       FROM write_agent_instances ai
       JOIN write_canvas_projects p ON p.id = ai.project_id AND p.user_id = ai.user_id
       WHERE ai.id = $1 AND ai.user_id = $2`,
      [agentId, req.session.userId],
    )).rows[0];
    if (!row) return res.status(404).json({ error: "agent not found" });
    return res.json(await resolveEffectiveCanvasSkills(
      pool,
      req.session.userId,
      row.skillConfig,
      row.projectDefaultSkillConfig,
      "inherit",
    ));
  }));

  app.post("/api/write/canvas/agents/:id/recall/confirm", requireAuth, asyncHandler(async (req, res) => {
    const agentId = Number(req.params.id);
    if (!Number.isSafeInteger(agentId) || agentId <= 0) return res.status(400).json({ error: "invalid agent id" });
    const requestedIds: unknown[] = Array.isArray(req.body?.cardIds)
      ? req.body.cardIds
      : Array.isArray(req.body?.candidateCardIds) ? req.body.candidateCardIds : [];
    const cardIds: string[] = Array.from(new Set<string>(requestedIds
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 128)
      .map(value => value.trim())))
      .slice(0, 8);
    if (cardIds.length === 0) return res.status(400).json({ error: "cardIds is required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const agent = (await client.query(
        `SELECT n.id AS node_id, n.project_id, n.x, n.y, n.width
         FROM write_agent_instances ai
         JOIN write_canvas_nodes n
           ON n.agent_id = ai.id AND n.user_id = ai.user_id AND n.project_id = ai.project_id
         WHERE ai.id = $1 AND ai.user_id = $2 AND n.kind = 'agent'
         FOR UPDATE OF ai, n`,
        [agentId, req.session.userId],
      )).rows[0];
      if (!agent) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "agent not found" });
      }
      const cards = (await client.query(
        `SELECT id, type, content, summary, tags, article_title, saved_article_id
         FROM saved_cards
         WHERE user_id = $1 AND id = ANY($2::text[])`,
        [req.session.userId, cardIds],
      )).rows;
      const cardsById = new Map(cards.map(card => [String(card.id), card]));
      const missingCardIds = cardIds.filter(id => !cardsById.has(id));
      if (missingCardIds.length > 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "one or more cards were not found", missingCardIds });
      }
      const existingRows = (await client.query(
        `SELECT id, project_id AS "projectId", kind, title, summary, ref_id AS "refId",
                meta, x, y, width, height, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM write_canvas_nodes
         WHERE user_id = $1 AND project_id = $2 AND kind = 'atom_card' AND ref_id = ANY($3::text[])
         ORDER BY id ASC
         FOR UPDATE`,
        [req.session.userId, Number(agent.project_id), cardIds],
      )).rows;
      const existingByRefId = new Map(existingRows.map(row => [String(row.refId), row]));
      const newCardCount = cardIds.filter(id => !existingByRefId.has(id)).length;
      const nodeCount = Number((await client.query(
        `SELECT COUNT(*)::int AS count FROM write_canvas_nodes WHERE user_id = $1 AND project_id = $2`,
        [req.session.userId, Number(agent.project_id)],
      )).rows[0]?.count || 0);
      if (nodeCount + newCardCount > WRITE_CANVAS_MAX_NODES_PER_PROJECT) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "项目节点数量已达到上限" });
      }

      const nodes: ReturnType<typeof mapCanvasNodeRow>[] = [];
      const edges: ReturnType<typeof mapCanvasEdgeRow>[] = [];
      const createdCardIds: string[] = [];
      const reusedCardIds: string[] = [];
      for (const [index, cardId] of cardIds.entries()) {
        const card = cardsById.get(cardId);
        let nodeRow = existingByRefId.get(cardId);
        if (!nodeRow) {
          nodeRow = (await client.query(
            `INSERT INTO write_canvas_nodes
               (user_id, project_id, kind, title, summary, ref_id, meta, x, y, width, height)
             VALUES ($1, $2, 'atom_card', $3, $4, $5, $6, $7, $8, 300, 180)
             RETURNING id, project_id AS "projectId", kind, title, summary, ref_id AS "refId",
                       meta, x, y, width, height, created_at AS "createdAt", updated_at AS "updatedAt"`,
            [
              req.session.userId,
              Number(agent.project_id),
              `${String(card.type || "原子卡")} · ${String(card.article_title || "知识卡片")}`.slice(0, 120),
              normalizePlainText(card.summary || card.content || "").slice(0, 500),
              cardId,
              JSON.stringify({
                confirmedGlobalRecall: true,
                card: {
                  id: cardId,
                  type: card.type,
                  articleTitle: card.article_title,
                  savedArticleId: card.saved_article_id ? Number(card.saved_article_id) : undefined,
                },
              }),
              Number(agent.x) - 380 - (index % 3) * 28,
              Number(agent.y) + index * 200,
            ],
          )).rows[0];
          existingByRefId.set(cardId, nodeRow);
          createdCardIds.push(cardId);
        } else {
          reusedCardIds.push(cardId);
        }
        const edgeRow = (await client.query(
          `INSERT INTO write_canvas_edges (user_id, project_id, source_node_id, target_node_id, relation)
           VALUES ($1, $2, $3, $4, 'context')
           ON CONFLICT (project_id, source_node_id, target_node_id, relation)
           DO UPDATE SET relation = EXCLUDED.relation
           RETURNING id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                     target_node_id AS "targetNodeId", relation, created_at AS "createdAt"`,
          [req.session.userId, Number(agent.project_id), Number(nodeRow.id), Number(agent.node_id)],
        )).rows[0];
        nodes.push(mapCanvasNodeRow(nodeRow));
        edges.push(mapCanvasEdgeRow(edgeRow));
      }
      await client.query("COMMIT");
      return res.json({
        confirmed: cardIds,
        createdCardIds,
        reusedCardIds,
        nodes,
        edges,
        usableOnNextGeneration: true,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/write/canvas/agents/:id/chat/stream", requireAuth, paidOperationLimiter, canvasAgentChatValidationMiddleware, canvasCreateArticleReplayMiddleware, canvasAgentExecutionValidationMiddleware, canvasAgentContextValidationMiddleware, paidConcurrencyMiddleware, canvasAgentConcurrencyMiddleware, canvasCreateArticleClaimMiddleware, canvasCreateArticleNoteRecoveryMiddleware, canvasAgentExecutionLeaseMiddleware, canvasAgentDailyBudgetMiddleware, asyncHandler(async (req, res) => {
    const runId = String(res.locals.canvasAgentRunId || randomUUID());
    if (billingService && billingConfig.enabled) {
      await billingService.recordUsage(req.session.userId!, `canvas-agent:${req.params.id}:${runId}`, "canvas_agent_chat");
    }
    const prepared = res.locals.canvasAgentChat;
    const { userId, agentId, agentRow, message, focusedTopic, isCreateArticle, requestId, creationKey } = prepared;

    const send = (type: string, data: unknown) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const requestAbortController = new AbortController();
    const abortDisconnectedRequest = () => {
      if (!res.writableFinished) requestAbortController.abort(new Error("Client disconnected"));
    };
    req.once("aborted", abortDisconnectedRequest);
    res.once("close", abortDisconnectedRequest);
    if (req.aborted || res.destroyed) abortDisconnectedRequest();
    const configuredDeadlineAt = Number(res.locals.canvasAgentRunDeadlineAt);
    const runDeadlineAt = Number.isFinite(configuredDeadlineAt)
      ? configuredDeadlineAt
      : Date.now() + canvasAgentRunDeadlineMs;
    const runDeadlineRemainingMs = runDeadlineAt - Date.now();
    const runDeadlineTimer = runDeadlineRemainingMs > 0
      ? setTimeout(
        () => requestAbortController.abort(new Error("Canvas Agent run deadline exceeded")),
        runDeadlineRemainingMs,
      )
      : null;
    runDeadlineTimer?.unref();
    if (runDeadlineRemainingMs <= 0) {
      requestAbortController.abort(new Error("Canvas Agent run deadline exceeded"));
    }
    try {
      requestAbortController.signal.throwIfAborted();
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      send("partial_status", { runId, message: "读取画布连线上下文" });
      const contexts = Array.isArray(res.locals.canvasAgentContexts)
        ? res.locals.canvasAgentContexts as CanvasContextItem[]
        : await resolveCanvasContextItems(pool, userId, Number(agentRow.node_id), Number(agentRow.project_id));
      const threadId = await ensureCanvasAgentThread(pool, userId, agentId);
      if (!threadId) throw new Error("Canvas Agent thread could not be created");
      if (!isCreateArticle) {
        const leaseBound = await updateCanvasAgentExecutionLeaseThread({ userId, agentId, runId, threadId });
        if (!leaseBound) throw new Error("Canvas Agent execution lease expired before provider invocation");
      }
      const allUserCards = await fetchUserSavedCards(pool, userId);
      const linkedAtomCardIds = new Set(
        contexts
          .filter(context => context.kind === "atom_card" && context.refId)
          .map(context => String(context.refId)),
      );
      const linkedCards = allUserCards.filter(card => linkedAtomCardIds.has(String(card.id)));
      const connectedSyntheticCards = canvasContextsToWritingCards(
        contexts.filter(context => context.kind !== "atom_card"),
      );
      const authorizedCards = [
        ...linkedCards,
        ...connectedSyntheticCards,
      ];
      const authorizedImages = contexts.flatMap(context => context.imageDataUrl ? [context.imageDataUrl] : []);
      const authorizedIds = new Set(authorizedCards.map(card => String(card.id)));
      const globalRecallCandidates = toolRecallCards(message, allUserCards, Array.from(authorizedIds))
        .slice(0, 5)
        .map(card => ({
          cardId: String(card.id),
          type: card.type,
          title: card.articleTitle || "知识卡片",
          preview: String(card.summary || card.content || "").slice(0, 180),
          requiresConfirmation: true,
          confirmationEndpoint: `/api/write/canvas/agents/${agentId}/recall/confirm`,
        }));
      const effectiveSkills = await resolveEffectiveCanvasSkills(
        pool,
        userId,
        agentRow.skill_config,
        agentRow.project_default_skill_config,
        "inherit",
      );
      send("partial_status", {
        runId,
        message: `已连接 ${contexts.length} 个授权上下文节点`,
        globalRecallCandidates,
      });
      requestAbortController.signal.throwIfAborted();
      const graphState = await runOpenAIWriteAgentRuntime(pool, {
        userId,
        threadId,
        threadType: "canvas",
        message,
        isCreateArticle,
        userState: {
          focusedTopic,
          activatedNodeIds: authorizedCards.map(card => String(card.id)),
          selectedCardIds: authorizedCards.map(card => String(card.id)),
          selectedSkillIds: effectiveSkills.effectiveSkillConfig.skillIds,
          selectedStyleSkillId: effectiveSkills.effectiveSkillConfig.primaryStyleSkillId,
          activationSummary: contexts.slice(0, 8).map(context => `${context.kind} · ${context.title}`),
        },
        authorizedCards,
        authorizedImages,
        agentSystemPrompt: agentRow.system_prompt,
        model: agentRow.model,
        temperature: Number(agentRow.temperature),
        topP: Number(agentRow.top_p),
        maxTokens: Number(agentRow.max_tokens),
        runId,
        creationKey,
        requestKey: isCreateArticle ? creationKey : undefined,
        signal: requestAbortController.signal,
        onProviderBoundary: isCreateArticle
          ? () => renewCanvasCreateArticleRunLease({ userId, agentId, requestId, runId })
          : () => renewCanvasAgentExecutionLease({ userId, agentId, runId }),
        onBeforeProvider: isCreateArticle
          ? () => beginCanvasCreateArticleProviderAttempt({ userId, agentId, requestId, runId })
          : undefined,
        onStep: async event => {
          requestAbortController.signal.throwIfAborted();
          send(event.type, {
            runId,
            node: event.node,
            message: event.message,
            ...(event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : { data: event.data }),
          });
        },
      });
      requestAbortController.signal.throwIfAborted();
      const note = graphState.persistedDraftNote || null;
      const noteNode = note
        ? await ensureCanvasGeneratedNoteNode(
          pool,
          userId,
          agentId,
          note,
          threadId,
          runId,
        )
        : null;
      const assistantRow = {
        id: Number(graphState.assistantMessageId || graphState.toolPayload?.messageId),
        agentId,
        role: "assistant" as const,
        content: graphState.assistantContent,
        meta: graphState.toolPayload || {},
        createdAt: new Date().toISOString(),
      };
      const finalPayload = {
        runId,
        message: mapCanvasMessageRow(assistantRow),
        threadId,
        threadState: graphState.mergedState,
        toolResult: graphState.toolPayload,
        uiBlocks: graphState.uiBlocks || [],
        choices: graphState.choices || [],
        sources: graphState.sources,
        note,
        noteNode,
        context: {
          nodes: contexts.map(item => ({ nodeId: item.nodeId, kind: item.kind, title: item.title })),
          usedImages: Number(graphState.toolPayload?.usedImages) || 0,
          authorizedCardIds: Array.from(authorizedIds),
          globalRecallCandidates,
          globalRecallRequiresConfirmation: globalRecallCandidates.length > 0,
          globalRecallConfirmationEndpoint: `/api/write/canvas/agents/${agentId}/recall/confirm`,
        },
      };
      if (isCreateArticle) {
        await completeCanvasRunRequest({
          userId,
          agentId,
          requestId,
          runId,
          payload: finalPayload,
          noteId: note ? Number(note.id) : undefined,
          threadId,
        });
      } else if (typeof res.locals.releaseCanvasAgentExecutionLease === "function") {
        await res.locals.releaseCanvasAgentExecutionLease();
      }
      send("final", finalPayload);
      res.end();
    } catch (error) {
      if (isCreateArticle) {
        try {
          await failCanvasRunRequest({ userId, agentId, requestId, runId, error });
        } catch (persistenceError) {
          logger.error({ err: persistenceError, module: "canvas-agent", runId, agentId, userId }, "Failed to persist canvas run failure");
        }
      } else if (typeof res.locals.releaseCanvasAgentExecutionLease === "function") {
        await res.locals.releaseCanvasAgentExecutionLease();
      }
      if (!requestAbortController.signal.aborted) {
        logger.error({ err: error, module: "canvas-agent", runId, agentId, userId }, "Canvas agent failed");
      }
      if (!res.destroyed && !res.writableEnded) {
        send("error", {
          runId,
          message: error instanceof Error && error.message ? error.message : "画布 Agent 暂时不可用"
        });
        res.end();
      }
    } finally {
      if (runDeadlineTimer) clearTimeout(runDeadlineTimer);
      if (typeof res.locals.releaseCanvasAgentExecutionLease === "function") {
        await res.locals.releaseCanvasAgentExecutionLease();
      }
      if (typeof res.locals.releaseCanvasAgentConcurrency === "function") res.locals.releaseCanvasAgentConcurrency();
      if (typeof res.locals.releasePaidConcurrency === "function") res.locals.releasePaidConcurrency();
    }
  }));

  app.post("/api/write/canvas/agents/:id/save-result", requireAuth, asyncHandler(async (req, res) => {
    const agentId = Number(req.params.id);
    if (!Number.isSafeInteger(agentId) || agentId <= 0) return res.status(400).json({ error: "invalid agent id" });
    const agentRow = await getCanvasAgentNode(pool, req.session.userId, agentId);
    if (!agentRow) return res.status(404).json({ error: "agent not found" });
    const hasMessageId = req.body?.messageId !== undefined && req.body?.messageId !== null && req.body?.messageId !== "";
    const parsedMessageId = Number(req.body?.messageId);
    if (hasMessageId && (!Number.isSafeInteger(parsedMessageId) || parsedMessageId <= 0)) {
      return res.status(400).json({ error: "invalid messageId" });
    }
    const messageId = hasMessageId ? parsedMessageId : null;
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId.trim() : "";
    if (!messageId && (!requestId || requestId.length > 128)) {
      return res.status(400).json({ error: "requestId is required when saving direct content" });
    }
    const resultKey = messageId ? `message:${messageId}` : `request:${requestId}`;
    const existingResult = (await pool.query(
      `SELECT id
       FROM write_canvas_nodes
       WHERE user_id = $1 AND project_id = $2 AND kind = 'result'
         AND meta->>'sourceAgentId' = $3 AND meta->>'resultKey' = $4`,
      [req.session.userId, Number(agentRow.project_id), String(agentId), resultKey],
    )).rows[0];
    let content = "";
    if (!existingResult && messageId) {
      const threadId = await ensureCanvasAgentThread(pool, req.session.userId, agentId);
      let messageRow = threadId ? (await pool.query(
        `SELECT wam.content FROM write_agent_messages wam
         JOIN write_agent_threads wat ON wat.id = wam.thread_id
         WHERE wam.id = $1 AND wam.thread_id = $2 AND wat.user_id = $3 AND wam.role = 'assistant'`,
        [messageId, threadId, req.session.userId]
      )).rows[0] : null;
      // A short compatibility window keeps old message ids usable after lazy
      // migration; new writes only use write_agent_messages.
      if (!messageRow) {
        messageRow = (await pool.query(
          `SELECT content FROM write_canvas_agent_messages
           WHERE id = $1 AND agent_id = $2 AND user_id = $3 AND role = 'assistant'`,
          [messageId, agentId, req.session.userId],
        )).rows[0];
      }
      content = messageRow?.content || "";
    } else if (!existingResult) {
      content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    }
    if (!content && !existingResult) return res.status(400).json({ error: "content or messageId is required" });
    content = content.slice(0, WRITE_AGENT_MAX_MESSAGE_LENGTH);
    const resultMeta = {
      sourceAgentId: agentId,
      messageId,
      ...(!messageId ? { requestId } : {}),
      resultKey,
    };
    const title = typeof req.body?.title === "string" && req.body.title.trim()
      ? req.body.title.trim().slice(0, 120)
      : "Agent 输出";
    const client = await pool.connect();
    let nodeId: number;
    let edgeRow: Record<string, unknown>;
    let created = false;
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
      const existingNode = (await client.query(
        `SELECT id
         FROM write_canvas_nodes
         WHERE user_id = $1 AND project_id = $2 AND kind = 'result'
           AND meta->>'sourceAgentId' = $3 AND meta->>'resultKey' = $4
         FOR UPDATE`,
        [req.session.userId, lockedAgent.project_id, String(agentId), resultKey],
      )).rows[0];
      if (existingNode) {
        nodeId = Number(existingNode.id);
        edgeRow = (await client.query(
          `INSERT INTO write_canvas_edges (user_id, project_id, source_node_id, target_node_id, relation)
           VALUES ($1, $2, $3, $4, 'context')
           ON CONFLICT (project_id, source_node_id, target_node_id, relation)
           DO UPDATE SET relation = EXCLUDED.relation
           RETURNING id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                     target_node_id AS "targetNodeId", relation, created_at AS "createdAt"`,
          [req.session.userId, lockedAgent.project_id, nodeId, Number(lockedAgent.node_id)],
        )).rows[0];
        await client.query("COMMIT");
      } else {
        // The optimistic lookup above lets retries succeed even after their source
        // message is gone. Re-check the captured payload after taking the user and
        // project locks so a concurrent result deletion cannot create an empty
        // replacement asset.
        if (!content) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "来源消息已不可用，请重新生成后再保存" });
        }
        const nodeCount = Number((await client.query(
          `SELECT COUNT(*)::int AS count FROM write_canvas_nodes WHERE project_id = $1 AND user_id = $2`,
          [lockedAgent.project_id, req.session.userId],
        )).rows[0]?.count || 0);
        if (nodeCount >= WRITE_CANVAS_MAX_NODES_PER_PROJECT) {
          await client.query("ROLLBACK");
          return res.status(413).json({ error: "项目节点数量已达到上限" });
        }
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
          [req.session.userId, lockedAgent.project_id, title, content, JSON.stringify(resultMeta)]
        )).rows[0];
        const nodeRow = (await client.query(
          `INSERT INTO write_canvas_nodes
             (user_id, project_id, kind, title, summary, asset_id, meta, x, y, width, height)
           SELECT $1, n.project_id, 'result', $2, $3, $4, $5, n.x + 420, n.y + 40, 320, 220
           FROM write_canvas_nodes n
           WHERE n.id = $6 AND n.user_id = $1
           RETURNING id`,
          [
            req.session.userId,
            title,
            normalizePlainText(content).slice(0, 180),
            Number(assetRow.id),
            JSON.stringify(resultMeta),
            Number(lockedAgent.node_id)
          ]
        )).rows[0];
        if (!nodeRow) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "agent node not found" });
        }
        nodeId = Number(nodeRow.id);
        created = true;
        edgeRow = (await client.query(
          `INSERT INTO write_canvas_edges (user_id, project_id, source_node_id, target_node_id, relation)
           VALUES ($1, $2, $3, $4, 'context')
           ON CONFLICT (project_id, source_node_id, target_node_id, relation) DO UPDATE SET relation = EXCLUDED.relation
           RETURNING id, project_id AS "projectId", source_node_id AS "sourceNodeId",
                     target_node_id AS "targetNodeId", relation, created_at AS "createdAt"`,
          [req.session.userId, lockedAgent.project_id, nodeId, Number(lockedAgent.node_id)]
        )).rows[0];
        await client.query("COMMIT");
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const detail = await fetchCanvasProjectDetail(pool, req.session.userId, Number(agentRow.project_id));
    res.json({
      node: detail?.nodes.find(item => item.id === nodeId),
      edge: mapCanvasEdgeRow(edgeRow),
      created,
    });
  }));

  app.get("/api/write/agent/threads", requireAuth, asyncHandler(async (req, res) => {
    const threadType = req.query.type === 'skill' ? 'skill' : req.query.type === 'canvas' ? 'canvas' : 'chat';
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
    const normalizedType = threadType === 'skill' ? 'skill' : threadType === 'canvas' ? 'canvas' : 'chat';
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
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockCanvasUser(client, req.session.userId);
      const thread = (await client.query(
        `SELECT id, thread_type
         FROM write_agent_threads
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [threadId, req.session.userId],
      )).rows[0];
      if (!thread) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "thread not found" });
      }
      const boundAgents = (await client.query(
        `SELECT id
         FROM write_agent_instances
         WHERE user_id = $1 AND agent_thread_id = $2
         ORDER BY id
         FOR UPDATE`,
        [req.session.userId, threadId],
      )).rows;
      if (boundAgents.length > 0) {
        let hasActiveRun = false;
        for (const agent of boundAgents) {
          if (await hasActiveCanvasAgentRun(client, req.session.userId, { agentId: Number(agent.id) })) {
            hasActiveRun = true;
            break;
          }
        }
        if (hasActiveRun) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            code: "CANVAS_AGENT_RUN_ACTIVE",
            error: "该画布会话仍有 Agent 正在生成内容，请等待完成",
            retryable: true,
          });
        }
        await client.query("ROLLBACK");
        return res.status(409).json({
          code: "CANVAS_THREAD_MANAGED",
          error: "画布 Agent 会话由所属项目管理，请从画布删除 Agent 或项目",
          retryable: false,
        });
      }
      await client.query(
        `DELETE FROM write_agent_threads WHERE id = $1 AND user_id = $2`,
        [threadId, req.session.userId],
      );
      await client.query("COMMIT");
      return res.json({ success: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

		  app.post("/api/write/agent/skills/generate", requireAuth, paidOperationLimiter, dailyPaidOperationBudgetMiddleware, paidConcurrencyMiddleware, asyncHandler(async (req, res) => {
		    const { userInput, sampleText } = req.body;

	    if (!userInput || typeof userInput !== "string" || userInput.trim().length < 5) {
	      return res.status(400).json({ error: "userInput is required and must be at least 5 characters" });
	    }

		    if (sampleText !== undefined && typeof sampleText !== "string") {
		      return res.status(400).json({ error: "sampleText must be a string if provided" });
		    }
		    if (billingService && billingConfig.enabled) {
		      await billingService.recordUsage(req.session.userId!, `skill-generate:${randomUUID()}`, "skill_generate");
		    }

		    const result = await runSkillCreationGraph(pool, {
	      userId: req.session.userId!,
	      userInput: userInput.trim(),
	      sampleText: sampleText?.trim(),
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
    const requestId = typeof body?.requestId === 'string' ? body.requestId.trim() : '';
    if (isCreateArticle && (!requestId || requestId.length > 128)) {
      return { error: 'requestId is required for create_article' };
    }
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
      requestId: requestId || undefined,
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

  app.post("/api/write/agent/chat/stream", requireAuth, paidOperationLimiter, writingAgentDailyBudgetMiddleware, paidConcurrencyMiddleware, asyncHandler(async (req, res) => {
    const runId = randomUUID();
    const parsed = buildWriteAgentRequest(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    if (!getOpenAIWriteAgentConfig()) {
      return res.status(500).json({ error: 'Writing agent model is not configured: set OPENAI_API_KEY/OPENAI_MODEL or AI_API_KEY/AI_BASE_URL/AI_MODEL' });
    }
    if (billingService && billingConfig.enabled) {
      await billingService.recordUsage(req.session.userId!, `write-agent:${runId}`, "write_agent_chat");
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (type: string, data: unknown) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const requestAbortController = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) requestAbortController.abort(new Error('Client disconnected'));
    });

    try {
      send('partial_status', { runId, message: '启动写作 Agent' });
      const graphState = await runOpenAIWriteAgentRuntime(pool, {
        userId: req.session.userId,
        threadId: parsed.threadId,
        threadType: "chat",
        message: parsed.normalizedMessage,
        isCreateArticle: parsed.isCreateArticle,
        userState: parsed.graphUserState,
        runId,
        creationKey: parsed.isCreateArticle ? `write:${parsed.requestId}` : undefined,
        signal: requestAbortController.signal,
        onStep: async event => {
          requestAbortController.signal.throwIfAborted();
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
      if (!requestAbortController.signal.aborted) {
        logger.error({ err: error, module: "write-agent-stream", runId, userId: req.session.userId }, "Streaming write agent failed");
      }
      if (!res.destroyed && !res.writableEnded) {
        send('error', {
          runId,
          message: error instanceof Error && error.message ? error.message : '写作助手暂时不可用'
        });
        res.end();
      }
    }
  }));

  app.post("/api/write/agent/chat", requireAuth, paidOperationLimiter, writingAgentDailyBudgetMiddleware, paidConcurrencyMiddleware, asyncHandler(async (req, res) => {
    const runId = randomUUID();
    const parsed = buildWriteAgentRequest(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    if (!getOpenAIWriteAgentConfig()) {
      return res.status(500).json({ error: 'Writing agent model is not configured: set OPENAI_API_KEY/OPENAI_MODEL or AI_API_KEY/AI_BASE_URL/AI_MODEL' });
    }
    if (billingService && billingConfig.enabled) {
      await billingService.recordUsage(req.session.userId!, `write-agent:${runId}`, "write_agent_chat");
    }

    const requestAbortController = new AbortController();
    req.once('aborted', () => requestAbortController.abort(new Error('Client disconnected')));
    res.once('close', () => {
      if (!res.writableFinished) requestAbortController.abort(new Error('Client disconnected'));
    });
    const graphState = await runOpenAIWriteAgentRuntime(pool, {
      userId: req.session.userId,
      threadId: parsed.threadId,
      threadType: "chat",
      message: parsed.normalizedMessage,
      isCreateArticle: parsed.isCreateArticle,
      userState: parsed.graphUserState,
      runId,
      creationKey: parsed.isCreateArticle ? `write:${parsed.requestId}` : undefined,
      signal: requestAbortController.signal,
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
    rssRuntime?.shutdown();
    clearInterval(verificationCleanupTimer);
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
