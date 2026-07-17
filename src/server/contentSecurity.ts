import createDOMPurify from "dompurify";
import { compile as compileHtmlToText } from "html-to-text";
import { JSDOM } from "jsdom";
import { marked } from "marked";

const domWindow = new JSDOM("").window;
const sanitizer = createDOMPurify(domWindow as unknown as Parameters<typeof createDOMPurify>[0]);
const defaultDroppedContentTags = ["script", "style", "iframe", "object", "embed", "template", "svg", "math"];
const plainTextSelectors = [
  { selector: "a", options: { ignoreHref: true } },
  { selector: "img", format: "skip" },
  { selector: "blockquote", format: "block" },
  { selector: "ul", format: "block" },
  { selector: "ol", format: "block" },
  { selector: "li", format: "block" },
  { selector: "td", format: "block" },
  { selector: "th", format: "block" },
  ...["h1", "h2", "h3", "h4", "h5", "h6"].map(selector => ({
    selector,
    options: { uppercase: false },
  })),
];
const plainTextConverterCache = new Map<string, (html: string) => string>();
const bareHtmlTagNames = new Set([
  "p", "div", "span", "li", "ul", "ol", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "em", "strong", "code", "pre", "blockquote", "details", "summary",
  "figure", "video", "iframe", "script", "style", "a", "img", "table",
  "tr", "td", "th", "thead", "tbody", "tfoot", "section", "article",
  "header", "footer", "nav", "aside", "main",
]);
const bareTagBoundaries = new Set([" ", "\t", "。", "！", "？", ".", "!", "?"]);

export const buildContentSecurityDirectives = (isProduction: boolean) => ({
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  connectSrc: isProduction ? ["'self'"] : ["'self'", "ws:", "wss:"],
  fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
  frameAncestors: ["'none'"],
  frameSrc: ["'none'"],
  imgSrc: ["'self'", "data:", "blob:", "https:"],
  mediaSrc: ["'self'", "blob:", "data:", "https:"],
  objectSrc: ["'none'"],
  scriptSrc: isProduction ? ["'self'"] : ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  upgradeInsecureRequests: isProduction ? [] : null,
  workerSrc: ["'self'", "blob:"],
});

const unwrapCdata = (value: string) => {
  const trimmed = value.trim();
  return trimmed.startsWith("<![CDATA[") && trimmed.endsWith("]]>")
    ? trimmed.slice(9, -3)
    : value;
};

type PlainTextOptions = {
  preserveLineBreaks?: boolean;
  dropContentTags?: string[];
};

export type PlainTextBudget = {
  remainingOutputChars: number;
  remainingSourceChars: number;
};

const getPlainTextConverter = (preserveLineBreaks: boolean, dropContentTags: string[]) => {
  const normalizedDropTags = [...new Set(dropContentTags)].sort();
  const cacheKey = `${preserveLineBreaks ? "lines" : "inline"}:${normalizedDropTags.join(",")}`;
  const cached = plainTextConverterCache.get(cacheKey);
  if (cached) return cached;
  const converter = compileHtmlToText({
    preserveNewlines: preserveLineBreaks,
    wordwrap: false,
    selectors: [
      ...plainTextSelectors,
      ...normalizedDropTags.map(selector => ({ selector, format: "skip" })),
    ],
  });
  plainTextConverterCache.set(cacheKey, converter);
  return converter;
};

const normalizePreservedLines = (value: string) => {
  const lines: string[] = [];
  let previousWasBlank = false;
  for (const rawLine of value.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.replace(/\u00a0/g, " ").trim().replace(/[ \t]+/g, " ");
    if (!line) {
      if (lines.length > 0 && !previousWasBlank) lines.push("");
      previousWasBlank = true;
      continue;
    }
    lines.push(line);
    previousWasBlank = false;
  }
  if (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
};

export const normalizeTextExcerpt = (value: string, maxLength = 120) => {
  if (maxLength <= 0) return "";
  let result = "";
  let pendingSpace = false;
  for (const character of value) {
    if (!character.trim()) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) {
      if (result.length >= maxLength) break;
      result += " ";
      pendingSpace = false;
    }
    if (result.length + character.length > maxLength) break;
    result += character;
    if (result.length >= maxLength) break;
  }
  return result;
};

export const contentToPlainText = (
  value: string,
  options: boolean | PlainTextOptions = false,
) => {
  const preserveLineBreaks = typeof options === "boolean" ? options : Boolean(options.preserveLineBreaks);
  const dropContentTags = typeof options === "boolean"
    ? defaultDroppedContentTags
    : [...defaultDroppedContentTags, ...(options.dropContentTags || [])];
  const source = unwrapCdata(value || "");
  const rendered = marked.parse(source, { async: false, gfm: true, breaks: preserveLineBreaks }) as string;
  const text = getPlainTextConverter(preserveLineBreaks, dropContentTags)(rendered);
  if (!preserveLineBreaks) return text.replace(/\s+/g, " ").trim();
  return normalizePreservedLines(text);
};

export const createPlainTextBudget = (
  maxOutputChars: number,
  maxSourceChars = maxOutputChars * 2,
): PlainTextBudget => ({
  remainingOutputChars: Math.max(0, Math.floor(maxOutputChars)),
  remainingSourceChars: Math.max(0, Math.floor(maxSourceChars)),
});

export const contentToPlainTextWithinBudget = (
  value: string,
  budget: PlainTextBudget,
  maxOutputChars: number,
  options: boolean | PlainTextOptions = false,
) => {
  const outputLimit = Math.min(
    budget.remainingOutputChars,
    Math.max(0, Math.floor(maxOutputChars)),
  );
  if (outputLimit <= 0 || budget.remainingSourceChars <= 0 || !value) return "";

  const sourceLimit = Math.min(
    value.length,
    budget.remainingSourceChars,
    Math.max(outputLimit * 2, 512),
  );
  const source = value.slice(0, sourceLimit);
  budget.remainingSourceChars -= source.length;
  const text = contentToPlainText(source, options).slice(0, outputLimit);
  budget.remainingOutputChars -= text.length;
  return text;
};

export const buildFeedExcerpt = (
  rawContent: string,
  contentSnippet: string | undefined,
  title: string | undefined,
  maxSourceChars = 512,
  maxLength = 120,
) => {
  const snippet = normalizeTextExcerpt(contentSnippet || "", maxLength);
  if (snippet) return snippet;

  const boundedSourceChars = Math.max(0, Math.min(Math.floor(maxSourceChars), 2048));
  const content = boundedSourceChars > 0
    ? normalizeTextExcerpt(contentToPlainText((rawContent || "").slice(0, boundedSourceChars)), maxLength)
    : "";
  return content || normalizeTextExcerpt(title || "", maxLength);
};

export const sanitizeRichHtml = (value: string) => sanitizer.sanitize(value);

export const normalizeEmailAddress = (value: unknown) => {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 320) return null;

  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex !== email.lastIndexOf("@")) return null;
  const dotIndex = email.indexOf(".", atIndex + 2);
  if (dotIndex < 0 || dotIndex === email.length - 1) return null;

  for (const character of email) {
    if (!character.trim()) return null;
    const code = character.codePointAt(0) || 0;
    if (code < 32 || code === 127) return null;
  }
  return email;
};

const isBareHtmlTagToken = (value: string) => {
  const normalized = value.startsWith("/") ? value.slice(1) : value;
  return bareHtmlTagNames.has(normalized.toLowerCase());
};

const isAsciiTagTokenCharacter = (character: string) => {
  const code = character.charCodeAt(0);
  return character === "/"
    || (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
};

export const stripBareHtmlTagRemnants = (value: string) => {
  const keptLines: string[] = [];
  for (const rawLine of value.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (isBareHtmlTagToken(line.trim())) continue;

    let tokenStart = line.length;
    while (tokenStart > 0 && isAsciiTagTokenCharacter(line[tokenStart - 1])) {
      tokenStart -= 1;
    }
    const token = line.slice(tokenStart);
    if (
      tokenStart > 0
      && isBareHtmlTagToken(token)
      && bareTagBoundaries.has(line[tokenStart - 1])
    ) {
      keptLines.push(line.slice(0, tokenStart).trimEnd());
      continue;
    }
    keptLines.push(line);
  }
  return normalizePreservedLines(keptLines.join("\n"));
};

export const urlMatchesHostname = (value: string | undefined, expectedHostname: string) => {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    const expected = expectedHostname.toLowerCase().replace(/\.$/, "");
    return hostname === expected || hostname.endsWith(`.${expected}`);
  } catch {
    return false;
  }
};
