import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import JSZip from "jszip";

export class ResponseLimitError extends Error {
  constructor(message = "Remote response exceeds the configured byte limit") {
    super(message);
    this.name = "ResponseLimitError";
  }
}

export class ConcurrencyLimitError extends Error {
  constructor(message = "Too many concurrent operations") {
    super(message);
    this.name = "ConcurrencyLimitError";
  }
}

export const readBoundedEnvNumber = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

const ipv4ToNumber = (address: string) => {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
};

const isIpv4InCidr = (address: number, base: string, bits: number) => {
  const baseNumber = ipv4ToNumber(base);
  if (baseNumber === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (baseNumber & mask);
};

const parseIpv6 = (input: string): bigint | null => {
  let address = input.toLowerCase().split("%")[0];
  const ipv4Match = address.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Match) {
    const ipv4 = ipv4ToNumber(ipv4Match[1]);
    if (ipv4 === null) return null;
    address = address.slice(0, -ipv4Match[1].length) + `${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
};

const isIpv6InCidr = (address: bigint, base: bigint, bits: number) => {
  if (bits === 0) return true;
  const shift = BigInt(128 - bits);
  return (address >> shift) === (base >> shift);
};

const IPV4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const IPV6_BLOCKS: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

export const isPrivateOrReservedIp = (address: string) => {
  const version = isIP(address.split("%")[0]);
  if (version === 4) {
    const numeric = ipv4ToNumber(address);
    return numeric === null || IPV4_BLOCKS.some(([base, bits]) => isIpv4InCidr(numeric, base, bits));
  }
  if (version !== 6) return true;

  const numeric = parseIpv6(address);
  if (numeric === null) return true;
  const mappedBase = parseIpv6("::ffff:0:0");
  if (mappedBase !== null && isIpv6InCidr(numeric, mappedBase, 96)) {
    return isPrivateOrReservedIp([
      Number((numeric >> 24n) & 0xffn),
      Number((numeric >> 16n) & 0xffn),
      Number((numeric >> 8n) & 0xffn),
      Number(numeric & 0xffn),
    ].join("."));
  }
  return IPV6_BLOCKS.some(([base, bits]) => {
    const parsedBase = parseIpv6(base);
    return parsedBase !== null && isIpv6InCidr(numeric, parsedBase, bits);
  });
};

type PublicUrlValidationOptions = {
  lookup?: (hostname: string) => Promise<string[]>;
  allowedPorts?: ReadonlySet<string>;
};

const defaultLookup = async (hostname: string) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map(result => result.address);
};

const resolvePublicHttpUrl = async (rawUrl: string, options: PublicUrlValidationOptions = {}) => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("URL protocol must be HTTP or HTTPS");
  if (parsed.username || parsed.password) throw new Error("URL credentials are not allowed");
  if (options.allowedPorts && !options.allowedPorts.has(parsed.port)) throw new Error("URL port is not allowed");
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("URL hostname is not public");
  }

  const literalVersion = isIP(hostname);
  const addresses = literalVersion ? [hostname] : await (options.lookup || defaultLookup)(hostname);
  if (addresses.length === 0) throw new Error("URL hostname did not resolve");
  if (addresses.some(isPrivateOrReservedIp)) throw new Error("URL hostname resolves to a private or reserved address");
  return { parsed, addresses };
};

export const validatePublicHttpUrl = async (rawUrl: string, options: PublicUrlValidationOptions = {}) => {
  return (await resolvePublicHttpUrl(rawUrl, options)).parsed;
};

type BoundedPublicFetchOptions = PublicUrlValidationOptions & {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  headers?: Record<string, string>;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  validateUrl?: (url: URL) => void;
};

const headersFromIncomingMessage = (response: IncomingMessage) => {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(response.headers)) {
    if (Array.isArray(rawValue)) rawValue.forEach(value => headers.append(name, value));
    else if (rawValue !== undefined) headers.set(name, String(rawValue));
  }
  return headers;
};

const readIncomingMessageBuffer = async (response: IncomingMessage, maxBytes: number) => {
  const declaredLength = Number(response.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.destroy();
    throw new ResponseLimitError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of response) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.byteLength;
    if (total > maxBytes) {
      response.destroy();
      throw new ResponseLimitError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
};

export const createPinnedLookup = (validatedAddress: string): LookupFunction => {
  const family = isIP(validatedAddress);
  return (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) {
      callback(null, [{ address: validatedAddress, family }]);
      return;
    }
    callback(null, validatedAddress, family);
  };
};

const requestPinnedPublicResource = (
  parsed: URL,
  validatedAddress: string,
  options: Pick<BoundedPublicFetchOptions, "headers" | "maxBytes" | "timeoutMs">,
) => new Promise<{ status: number; headers: Headers; body: Buffer }>((resolve, reject) => {
  const lookup = createPinnedLookup(validatedAddress);
  const requestOptions: import("node:https").RequestOptions = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || undefined,
    path: `${parsed.pathname}${parsed.search}`,
    method: "GET",
    headers: {
      ...options.headers,
      "Accept-Encoding": "identity",
      Host: parsed.host,
    },
    lookup,
    servername: parsed.hostname,
  };
  const onResponse = (response: IncomingMessage) => {
    const contentEncoding = String(response.headers["content-encoding"] || "identity").toLowerCase();
    if (contentEncoding !== "identity") {
      response.destroy();
      reject(new Error("Compressed remote responses are not accepted"));
      return;
    }
    void readIncomingMessageBuffer(response, options.maxBytes).then(body => {
      resolve({ status: response.statusCode || 0, headers: headersFromIncomingMessage(response), body });
    }, reject);
  };
  const request = parsed.protocol === "https:"
    ? httpsRequest(requestOptions, onResponse)
    : httpRequest(requestOptions, onResponse);
  request.setTimeout(options.timeoutMs, () => request.destroy(new DOMException("Remote request timed out", "TimeoutError")));
  request.once("error", reject);
  request.end();
});

export const fetchBoundedPublicResource = async (rawUrl: string, options: BoundedPublicFetchOptions) => {
  let currentUrl = rawUrl;
  for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount += 1) {
    const { parsed, addresses } = await resolvePublicHttpUrl(currentUrl, {
      lookup: options.lookup,
      allowedPorts: options.allowedPorts,
    });
    options.validateUrl?.(parsed);
    const resource = options.fetchImpl
      ? await (async () => {
          const response = await options.fetchImpl!(parsed, {
            method: "GET",
            headers: options.headers,
            redirect: "manual",
            signal: AbortSignal.timeout(options.timeoutMs),
          });
          return {
            status: response.status,
            headers: response.headers,
            body: await readResponseBuffer(response, options.maxBytes),
          };
        })()
      : await requestPinnedPublicResource(parsed, addresses[0], options);
    if ([301, 302, 303, 307, 308].includes(resource.status)) {
      const location = resource.headers.get("location");
      if (!location) throw new Error("Remote redirect is missing a location header");
      if (redirectCount >= options.maxRedirects) throw new Error("Remote redirect limit exceeded");
      currentUrl = new URL(location, parsed).toString();
      continue;
    }
    return { url: parsed, status: resource.status, headers: resource.headers, body: resource.body };
  }
  throw new Error("Remote redirect limit exceeded");
};

export const isAllowedUploadSignature = (buffer: Buffer, mimeType: string, fileName: string) => {
  const extension = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  const startsWith = (...bytes: number[]) => bytes.every((byte, index) => buffer[index] === byte);
  if (["text/plain", "text/markdown", "text/csv"].includes(mimeType)) {
    return [".txt", ".md", ".markdown", ".csv"].includes(extension) && !buffer.subarray(0, 8192).includes(0);
  }
  if (mimeType === "application/pdf") return extension === ".pdf" && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return extension === ".docx" && (startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06));
  }
  if (mimeType === "image/png") return extension === ".png" && startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mimeType === "image/jpeg") return [".jpg", ".jpeg"].includes(extension) && startsWith(0xff, 0xd8, 0xff);
  if (mimeType === "image/gif") {
    const header = buffer.subarray(0, 6).toString("ascii");
    return extension === ".gif" && (header === "GIF87a" || header === "GIF89a");
  }
  if (mimeType === "image/webp") {
    return extension === ".webp" && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
};

type ZipEntryWithSizes = JSZip.JSZipObject & {
  _data?: {
    compressedSize?: number;
    uncompressedSize?: number;
  };
};

export const validateDocxArchiveBounds = async (
  buffer: Buffer,
  options: { maxEntries?: number; maxUncompressedBytes?: number; maxCompressionRatio?: number } = {},
) => {
  const maxEntries = options.maxEntries ?? 1000;
  const maxUncompressedBytes = options.maxUncompressedBytes ?? 50 * 1024 * 1024;
  const maxCompressionRatio = options.maxCompressionRatio ?? 100;
  const archive = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false });
  const entries = Object.values(archive.files).filter(entry => !entry.dir) as ZipEntryWithSizes[];
  if (!archive.file("[Content_Types].xml") || !archive.file("word/document.xml")) return false;
  if (entries.length === 0 || entries.length > maxEntries) return false;

  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (const entry of entries) {
    const compressed = Number(entry._data?.compressedSize ?? 0);
    const uncompressed = Number(entry._data?.uncompressedSize ?? 0);
    if (!Number.isFinite(compressed) || !Number.isFinite(uncompressed) || compressed < 0 || uncompressed < 0) return false;
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    if (uncompressed > maxUncompressedBytes || totalUncompressed > maxUncompressedBytes) return false;
  }
  if (totalUncompressed > Math.max(totalCompressed, 1) * maxCompressionRatio) return false;
  return true;
};

export const buildAllowedOrigins = (appUrl?: string, configuredOrigins?: string) => {
  const origins = new Set<string>();
  for (const raw of [appUrl, ...(configuredOrigins || "").split(",")]) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") origins.add(parsed.origin);
    } catch {
      // Invalid values are ignored here and rejected by production startup validation.
    }
  }
  return origins;
};

type MutationOriginInput = {
  method: string;
  path: string;
  origin?: string;
  referer?: string;
  isAuthenticated?: boolean;
};

export const isAllowedMutationOrigin = (input: MutationOriginInput, allowedOrigins: ReadonlySet<string>) => {
  if (["GET", "HEAD", "OPTIONS"].includes(input.method.toUpperCase())) return true;
  const candidate = input.origin || input.referer;
  if (!candidate) return false;
  try {
    return allowedOrigins.has(new URL(candidate).origin);
  } catch {
    return false;
  }
};

export const readResponseBuffer = async (response: Response, maxBytes: number) => {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseLimitError();
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new ResponseLimitError();
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseLimitError();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
};

export const createUserConcurrencyGuard = (limit: number) => {
  const activeByKey = new Map<string, number>();
  const acquire = (key: string) => {
    const current = activeByKey.get(key) || 0;
    if (current >= limit) throw new ConcurrencyLimitError();
    activeByKey.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (activeByKey.get(key) || 1) - 1;
      if (remaining <= 0) activeByKey.delete(key);
      else activeByKey.set(key, remaining);
    };
  };
  return {
    active: (key: string) => activeByKey.get(key) || 0,
    acquire,
    run: async <T>(key: string, operation: () => Promise<T>) => {
      const release = acquire(key);
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
};
