import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const RSS_ARTICLE_CONTENT_MAX_BYTES = 64 * 1024;
export const RSS_GLOBAL_ARTICLE_LIMIT = 250;

export const truncateUtf8 = (value: unknown, maxBytes = RSS_ARTICLE_CONTENT_MAX_BYTES) => {
  const text = String(value ?? "");
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return text;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      // UTF-8 code points use at most four bytes, so one of these boundaries is valid.
    }
  }
  return "";
};

type CacheableArticle = {
  content?: unknown;
  markdownContent?: unknown;
  fullFetched?: unknown;
  cards?: unknown;
};

export class RssArticleCache<TArticle extends CacheableArticle> {
  private writeQueue = Promise.resolve();
  private lastDigest: string | null = null;
  private tempSequence = 0;

  constructor(
    private readonly cacheFile: string,
    private readonly maxArticles = RSS_GLOBAL_ARTICLE_LIMIT,
    private readonly maxContentBytes = RSS_ARTICLE_CONTENT_MAX_BYTES,
  ) {}

  private normalize(articles: readonly TArticle[]) {
    return articles.slice(0, this.maxArticles).map(article => ({
      ...article,
      content: truncateUtf8(article.content, this.maxContentBytes),
      markdownContent: undefined,
      fullFetched: false,
      cards: [],
    })) as TArticle[];
  }

  async load(): Promise<TArticle[]> {
    try {
      const raw = await fs.readFile(this.cacheFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const bounded = this.normalize(parsed as TArticle[]);
      this.lastDigest = createHash("sha256").update(JSON.stringify(bounded)).digest("hex");
      return bounded;
    } catch {
      return [];
    }
  }

  async save(articles: readonly TArticle[]): Promise<void> {
    const payload = JSON.stringify(this.normalize(articles));
    const digest = createHash("sha256").update(payload).digest("hex");
    if (digest === this.lastDigest) return;
    const sequence = this.tempSequence;
    this.tempSequence += 1;
    const tempFile = `${this.cacheFile}.${process.pid}.${sequence}.tmp`;
    const write = this.writeQueue.then(async () => {
      if (digest === this.lastDigest) return;
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      try {
        await fs.writeFile(tempFile, payload, "utf8");
        await fs.rename(tempFile, this.cacheFile);
        this.lastDigest = digest;
      } catch (error) {
        await fs.rm(tempFile, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}
