import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type AgentOptions, type ClientRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as netConnect, isIP, type LookupFunction, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Agent as AgentBase, type AgentConnectOpts } from "agent-base";
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

const isClashFakeIp = (address: string) => {
  const numeric = ipv4ToNumber(address);
  return numeric !== null && isIpv4InCidr(numeric, "198.18.0.0", 15);
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
  ["::", 96],
  ["::1", 128],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
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
  trustedPublicLookup?: (hostname: string) => Promise<string[]>;
  allowedPorts?: ReadonlySet<string>;
  deadline?: number;
};

const TRUSTED_DNS_HOSTNAME = "cloudflare-dns.com";
const TRUSTED_DNS_ADDRESS = "1.0.0.1";
const TRUSTED_DNS_TIMEOUT_MS = 15_000;
const TRUSTED_DNS_MAX_BYTES = 64 * 1024;
const TRUSTED_DNS_CACHE_MS = 60_000;
const TRUSTED_DNS_CACHE_MAX_ENTRIES = 512;
const DEV_PROXY_MAX_HEADER_BYTES = 16 * 1024;
const trustedDnsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 4 });
const trustedDnsCache = new Map<string, { expiresAt: number; addresses: string[] }>();
const trustedDnsPending = new Map<string, Promise<string[]>>();

export const parseDevProxyUrl = (rawUrl: string) => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Development proxy URL is invalid");
  }
  const serializedHostname = parsed.hostname.toLowerCase();
  const hostname = serializedHostname.startsWith("[") && serializedHostname.endsWith("]")
    ? serializedHostname.slice(1, -1)
    : serializedHostname;
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:"
    || (hostname !== "127.0.0.1" && hostname !== "::1")
    || parsed.username
    || parsed.password
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("Development proxy must be an unauthenticated loopback HTTP URL with an explicit port");
  }
  return parsed;
};

const configuredDevProxyUrl = () => {
  const rawUrl = process.env.DEV_PROXY_URL?.trim();
  return rawUrl ? parseDevProxyUrl(rawUrl) : null;
};

const remainingDeadlineMs = (deadline: number, message: string) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DOMException(message, "TimeoutError");
  return remaining;
};

const openDevProxyTunnel = (
  proxyUrl: URL,
  targetAddress: string,
  targetPort: number,
  deadline: number,
  allowedProxyHostname?: string,
  signal?: AbortSignal,
) => new Promise<Socket>((resolve, reject) => {
  if (signal?.aborted) {
    reject(new DOMException("Development proxy CONNECT aborted", "AbortError"));
    return;
  }
  const targetIpVersion = isIP(targetAddress);
  const isAllowedTarget = targetIpVersion === 4
    || targetIpVersion === 6
    || (Boolean(allowedProxyHostname) && targetAddress === allowedProxyHostname);
  if (!isAllowedTarget || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    reject(new Error("Development proxy target must be a validated IP or explicitly approved HTTPS hostname and port"));
    return;
  }
  let timeoutMs: number;
  try {
    timeoutMs = remainingDeadlineMs(deadline, "Development proxy CONNECT timed out");
  } catch (error) {
    reject(error);
    return;
  }
  const serializedProxyHostname = proxyUrl.hostname;
  const proxyHostname = serializedProxyHostname.startsWith("[") && serializedProxyHostname.endsWith("]")
    ? serializedProxyHostname.slice(1, -1)
    : serializedProxyHostname;
  const socket = netConnect({ host: proxyHostname, port: Number(proxyUrl.port) });
  const timeoutError = new DOMException("Development proxy CONNECT timed out", "TimeoutError");
  let responseBuffer = Buffer.alloc(0);
  let settled = false;
  const timer = setTimeout(() => fail(timeoutError), timeoutMs);

  function cleanup() {
    clearTimeout(timer);
    socket.off("readable", read);
    socket.off("error", fail);
    socket.off("end", onEnd);
    socket.off("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }

  function fail(error: unknown) {
    if (settled) return;
    settled = true;
    cleanup();
    socket.destroy();
    reject(error instanceof Error ? error : new Error(String(error)));
  }

  function onEnd() {
    fail(new Error("Development proxy closed before CONNECT completed"));
  }

  function onClose() {
    fail(new Error("Development proxy connection closed before CONNECT completed"));
  }

  function onAbort() {
    fail(new DOMException("Development proxy CONNECT aborted", "AbortError"));
  }

  function read() {
    const chunk = socket.read() as Buffer | null;
    if (chunk) onData(chunk);
    else socket.once("readable", read);
  }

  function onData(chunk: Buffer) {
    responseBuffer = Buffer.concat([responseBuffer, chunk]);
    if (responseBuffer.byteLength > DEV_PROXY_MAX_HEADER_BYTES) {
      fail(new Error("Development proxy CONNECT response headers are too large"));
      return;
    }
    const headerEnd = responseBuffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      read();
      return;
    }
    const header = responseBuffer.subarray(0, headerEnd).toString("latin1");
    if (!/^HTTP\/1\.[01] 200(?:\s|$)/i.test(header.split("\r\n", 1)[0] || "")) {
      fail(new Error("Development proxy rejected CONNECT"));
      return;
    }
    const buffered = responseBuffer.subarray(headerEnd + 4);
    settled = true;
    cleanup();
    socket.setTimeout(0);
    if (buffered.byteLength > 0) socket.unshift(buffered);
    resolve(socket);
  }

  socket.once("connect", () => {
    const formattedTarget = targetIpVersion === 6 ? `[${targetAddress}]` : targetAddress;
    socket.write(
      `CONNECT ${formattedTarget}:${targetPort} HTTP/1.1\r\n`
      + `Host: ${formattedTarget}:${targetPort}\r\n`
      + "Proxy-Connection: Keep-Alive\r\n\r\n",
    );
  });
  socket.on("error", fail);
  socket.once("end", onEnd);
  socket.once("close", onClose);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  read();
});

class DevProxyTunnelAgent extends AgentBase {
  constructor(
    private readonly proxyUrl: URL,
    private readonly connectTimeoutMs: number,
    agentOptions: AgentOptions = { keepAlive: false },
    private readonly allowedProxyHostname?: string,
  ) {
    super(agentOptions);
  }

  override async connect(request: ClientRequest, options: AgentConnectOpts) {
    const deadline = Date.now() + this.connectTimeoutMs;
    const targetAddress = String(options.host || "");
    const targetPort = Number(options.port);
    const abortController = new AbortController();
    let connectionSocket: Socket | undefined;
    const onRequestClose = () => {
      abortController.abort();
      connectionSocket?.destroy();
    };
    request.once("close", onRequestClose);
    try {
      if (request.destroyed) throw new DOMException("Development proxy request aborted", "AbortError");
      const socket = await openDevProxyTunnel(
        this.proxyUrl,
        targetAddress,
        targetPort,
        deadline,
        this.allowedProxyHostname,
        abortController.signal,
      );
      connectionSocket = socket;
      if (request.destroyed) throw new DOMException("Development proxy request aborted", "AbortError");

      if (options.secureEndpoint) {
        const servername = typeof options.servername === "string" ? options.servername : "";
        if (!servername) throw new Error("TLS servername is required for proxied HTTPS requests");
        connectionSocket = tlsConnect({ socket, servername, rejectUnauthorized: true });
      }
      if (request.destroyed) throw new DOMException("Development proxy request aborted", "AbortError");
      request.once("socket", connectedSocket => {
        request.off("close", onRequestClose);
        connectedSocket.resume();
      });
      return connectionSocket;
    } catch (error) {
      request.off("close", onRequestClose);
      connectionSocket?.destroy();
      throw error;
    }
  }
}

const devTrustedDnsAgents = new Map<string, DevProxyTunnelAgent>();

const devTrustedDnsAgent = (proxyUrl: URL) => {
  const key = proxyUrl.href;
  const existing = devTrustedDnsAgents.get(key);
  if (existing) return existing;
  const agent = new DevProxyTunnelAgent(proxyUrl, TRUSTED_DNS_TIMEOUT_MS, {
    keepAlive: true,
    maxSockets: 4,
    maxTotalSockets: 4,
    maxFreeSockets: 4,
    scheduling: "fifo",
  }, TRUSTED_DNS_HOSTNAME);
  devTrustedDnsAgents.set(key, agent);
  if (devTrustedDnsAgents.size > 4) {
    const oldestKey = devTrustedDnsAgents.keys().next().value;
    if (typeof oldestKey === "string" && oldestKey !== key) {
      devTrustedDnsAgents.get(oldestKey)?.destroy();
      devTrustedDnsAgents.delete(oldestKey);
    }
  }
  return agent;
};

const defaultLookup = async (hostname: string) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map(result => result.address);
};

export const resolvePublicHttpUrl = async (rawUrl: string, options: PublicUrlValidationOptions = {}) => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("URL protocol must be HTTP or HTTPS");
  if (parsed.username || parsed.password) throw new Error("URL credentials are not allowed");
  if (options.allowedPorts && !options.allowedPorts.has(parsed.port)) throw new Error("URL port is not allowed");
  const serializedHostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const hostname = serializedHostname.startsWith("[") && serializedHostname.endsWith("]")
    ? serializedHostname.slice(1, -1)
    : serializedHostname;
  if (
    !hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
  ) {
    throw new Error("URL hostname is not public");
  }

  const literalVersion = isIP(hostname);
  const addresses = literalVersion ? [hostname] : await (options.lookup || defaultLookup)(hostname);
  if (addresses.length === 0) throw new Error("URL hostname did not resolve");
  const allowDevProxyFakeIp = process.env.NODE_ENV !== "production"
    && process.env.ALLOW_DEV_PROXY_FAKE_IP === "true"
    && literalVersion === 0;
  const resolvesToBlockedAddress = addresses.some(address => (
    isPrivateOrReservedIp(address)
    && !(allowDevProxyFakeIp && isClashFakeIp(address))
  ));
  if (resolvesToBlockedAddress) throw new Error("URL hostname resolves to a private or reserved address");
  let connectionAddresses = addresses;
  let devProxyUrl: URL | null = null;
  if (allowDevProxyFakeIp && addresses.some(isClashFakeIp)) {
    let trustedAddresses: string[];
    try {
      trustedAddresses = await (options.trustedPublicLookup
        ? options.trustedPublicLookup(hostname)
        : lookupTrustedPublicAddresses(hostname, options.deadline));
    } catch (error) {
      throw new Error("URL hostname could not be verified through trusted public DNS", { cause: error });
    }
    if (trustedAddresses.length === 0 || trustedAddresses.some(isPrivateOrReservedIp)) {
      throw new Error("URL hostname does not resolve to a public address through trusted DNS");
    }
    connectionAddresses = [...new Set(trustedAddresses)];
    devProxyUrl = configuredDevProxyUrl();
  }
  return { parsed, addresses: connectionAddresses, devProxyUrl };
};

export const validatePublicHttpUrl = async (rawUrl: string, options: PublicUrlValidationOptions = {}) => {
  return (await resolvePublicHttpUrl(rawUrl, options)).parsed;
};

type BoundedPublicFetchOptions = PublicUrlValidationOptions & {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  signal?: AbortSignal;
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

const queryTrustedPublicDns = (hostname: string, recordType: "A" | "AAAA", parentDeadline?: number) => (
  new Promise<string[]>((resolve, reject) => {
    const expectedFamily = recordType === "A" ? 4 : 6;
    const devProxyUrl = configuredDevProxyUrl();
    const deadline = Math.min(Date.now() + TRUSTED_DNS_TIMEOUT_MS, parentDeadline ?? Number.POSITIVE_INFINITY);
    const timeoutError = new DOMException("Trusted DNS request timed out", "TimeoutError");
    let timeoutMs: number;
    try {
      timeoutMs = remainingDeadlineMs(deadline, timeoutError.message);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
    let request: ClientRequest | undefined;
    const finishResolve = (addresses: string[]) => {
      if (settled) return;
      settled = true;
      if (wallClockTimer) clearTimeout(wallClockTimer);
      resolve(addresses);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (wallClockTimer) clearTimeout(wallClockTimer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    try {
      const createdRequest = httpsRequest({
        protocol: "https:",
        hostname: devProxyUrl ? TRUSTED_DNS_HOSTNAME : TRUSTED_DNS_ADDRESS,
        port: 443,
        path: `/dns-query?name=${encodeURIComponent(hostname)}&type=${recordType}`,
        method: "GET",
        headers: {
          Accept: "application/dns-json",
          "Accept-Encoding": "identity",
          Host: TRUSTED_DNS_HOSTNAME,
        },
        servername: TRUSTED_DNS_HOSTNAME,
        agent: devProxyUrl ? devTrustedDnsAgent(devProxyUrl) : trustedDnsAgent,
      }, response => {
        void (async () => {
          if (response.statusCode !== 200) {
            response.destroy();
            throw new Error(`Trusted DNS returned ${response.statusCode || 0}`);
          }
          const contentEncoding = String(response.headers["content-encoding"] || "identity").toLowerCase();
          if (contentEncoding !== "identity") {
            response.destroy();
            throw new Error("Compressed trusted DNS responses are not accepted");
          }
          const body = await readIncomingMessageBuffer(response, TRUSTED_DNS_MAX_BYTES);
          const payload = JSON.parse(body.toString("utf8")) as {
            Status?: unknown;
            Answer?: Array<{ type?: unknown; data?: unknown }>;
          };
          if (payload.Status !== 0 || !Array.isArray(payload.Answer)) return [];
          return payload.Answer.flatMap(answer => (
            answer.type === (recordType === "A" ? 1 : 28)
            && typeof answer.data === "string"
            && isIP(answer.data) === expectedFamily
              ? [answer.data]
              : []
          ));
        })().then(finishResolve, finishReject);
      });
      request = createdRequest;
      createdRequest.once("error", finishReject);
      wallClockTimer = setTimeout(() => {
        createdRequest.destroy(timeoutError);
        finishReject(timeoutError);
      }, timeoutMs);
      createdRequest.setTimeout(timeoutMs, () => {
        createdRequest.destroy(timeoutError);
        finishReject(timeoutError);
      });
      createdRequest.end();
    } catch (error) {
      request?.destroy();
      finishReject(error);
    }
  })
);

async function lookupTrustedPublicAddresses(hostname: string, deadline?: number) {
  const cached = trustedDnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return [...cached.addresses];
  const pending = trustedDnsPending.get(hostname);
  if (pending) return [...await pending];

  const lookupPromise = (async () => {
    // One independently verified address family is enough to authorize only the
    // validated target. Query AAAA only for IPv6-only hosts; some local proxy cores
    // starve back-to-back tunnels to the same DoH endpoint.
    const ipv4Addresses = await queryTrustedPublicDns(hostname, "A", deadline);
    if (ipv4Addresses.length > 0) return [...new Set(ipv4Addresses)];
    return [...new Set(await queryTrustedPublicDns(hostname, "AAAA", deadline))];
  })();
  trustedDnsPending.set(hostname, lookupPromise);
  try {
    const addresses = await lookupPromise;
    if (addresses.length === 0 || addresses.some(isPrivateOrReservedIp)) {
      throw new Error("Trusted DNS did not return exclusively public addresses");
    }
    if (trustedDnsCache.size >= TRUSTED_DNS_CACHE_MAX_ENTRIES) {
      const now = Date.now();
      for (const [cachedHostname, entry] of trustedDnsCache) {
        if (entry.expiresAt <= now) trustedDnsCache.delete(cachedHostname);
      }
      if (trustedDnsCache.size >= TRUSTED_DNS_CACHE_MAX_ENTRIES) {
        const oldestHostname = trustedDnsCache.keys().next().value;
        if (typeof oldestHostname === "string") trustedDnsCache.delete(oldestHostname);
      }
    }
    trustedDnsCache.set(hostname, { expiresAt: Date.now() + TRUSTED_DNS_CACHE_MS, addresses });
    return [...addresses];
  } finally {
    if (trustedDnsPending.get(hostname) === lookupPromise) trustedDnsPending.delete(hostname);
  }
}

export const createPinnedLookup = (validatedAddress: string): LookupFunction => {
  const family = isIP(validatedAddress);
  if (family !== 4 && family !== 6) throw new Error("Validated address is not an IP address");
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
  options: Pick<BoundedPublicFetchOptions, "headers" | "maxBytes" | "timeoutMs" | "signal">,
  devProxyUrl: URL | null,
) => new Promise<{ status: number; headers: Headers; body: Buffer }>((resolve, reject) => {
  const deadline = Date.now() + options.timeoutMs;
  const timeoutError = new DOMException("Remote request timed out", "TimeoutError");
  let timeoutMs: number;
  try {
    timeoutMs = remainingDeadlineMs(deadline, timeoutError.message);
  } catch (error) {
    reject(error);
    return;
  }
  const lookup = devProxyUrl ? undefined : createPinnedLookup(validatedAddress);
  const requestOptions: import("node:https").RequestOptions = {
    protocol: parsed.protocol,
    hostname: devProxyUrl ? validatedAddress : parsed.hostname,
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
    agent: devProxyUrl
      ? new DevProxyTunnelAgent(devProxyUrl, options.timeoutMs)
      : undefined,
  };
  let settled = false;
  let activeResponse: IncomingMessage | undefined;
  let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
  let request: ClientRequest | undefined;
  const cleanup = () => {
    if (wallClockTimer) clearTimeout(wallClockTimer);
    options.signal?.removeEventListener("abort", onAbort);
  };
  const finishResolve = (resource: { status: number; headers: Headers; body: Buffer }) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(resource);
  };
  const finishReject = (error: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error instanceof Error ? error : new Error(String(error)));
  };
  function onAbort() {
    const abortError = options.signal?.reason instanceof Error
      ? options.signal.reason
      : new DOMException("Remote request aborted", "AbortError");
    activeResponse?.destroy(abortError);
    request?.destroy(abortError);
    finishReject(abortError);
  }
  const onResponse = (response: IncomingMessage) => {
    activeResponse = response;
    const contentEncoding = String(response.headers["content-encoding"] || "identity").toLowerCase();
    if (contentEncoding !== "identity") {
      response.destroy();
      finishReject(new Error("Compressed remote responses are not accepted"));
      return;
    }
    void readIncomingMessageBuffer(response, options.maxBytes).then(body => {
      finishResolve({ status: response.statusCode || 0, headers: headersFromIncomingMessage(response), body });
    }, finishReject);
  };
  try {
    const createdRequest = parsed.protocol === "https:"
      ? httpsRequest(requestOptions, onResponse)
      : httpRequest(requestOptions, onResponse);
    request = createdRequest;
    createdRequest.once("error", finishReject);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    wallClockTimer = setTimeout(() => {
      activeResponse?.destroy(timeoutError);
      createdRequest.destroy(timeoutError);
      finishReject(timeoutError);
    }, timeoutMs);
    createdRequest.setTimeout(timeoutMs, () => {
      activeResponse?.destroy(timeoutError);
      createdRequest.destroy(timeoutError);
      finishReject(timeoutError);
    });
    createdRequest.end();
  } catch (error) {
    request?.destroy();
    finishReject(error);
  }
});

const settleBeforeDeadline = <T>(
  operation: () => Promise<T>,
  deadline: number,
  message: string,
  signal?: AbortSignal,
) => {
  const timeoutMs = remainingDeadlineMs(deadline, message);
  return new Promise<T>((resolve, reject) => {
    const timeoutError = new DOMException(message, "TimeoutError");
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finishResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    function onAbort() {
      finishReject(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("Remote fetch aborted", "AbortError"));
    }
    const timer = setTimeout(() => finishReject(timeoutError), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve().then(() => {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Remote fetch aborted", "AbortError");
      }
      remainingDeadlineMs(deadline, message);
      return operation();
    }).then(value => {
      finishResolve(value);
    }, finishReject);
  });
};

export const fetchBoundedPublicResource = async (rawUrl: string, options: BoundedPublicFetchOptions) => {
  const deadline = Date.now() + options.timeoutMs;
  const timeoutMessage = "Remote fetch timed out";
  let currentUrl = rawUrl;
  for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount += 1) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException("Remote fetch aborted", "AbortError");
    }
    const { parsed, addresses, devProxyUrl } = await settleBeforeDeadline(
      () => resolvePublicHttpUrl(currentUrl, {
        lookup: options.lookup,
        trustedPublicLookup: options.trustedPublicLookup,
        allowedPorts: options.allowedPorts,
        deadline,
      }),
      deadline,
      timeoutMessage,
      options.signal,
    );
    options.validateUrl?.(parsed);
    const remainingMs = remainingDeadlineMs(deadline, timeoutMessage);
    const resource = options.fetchImpl
      ? await settleBeforeDeadline(async () => {
          const timeoutSignal = AbortSignal.timeout(remainingMs);
          const response = await options.fetchImpl!(parsed, {
            method: "GET",
            headers: options.headers,
            redirect: "manual",
            signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal,
          });
          return {
            status: response.status,
            headers: response.headers,
            body: await readResponseBuffer(response, options.maxBytes),
          };
        }, deadline, timeoutMessage, options.signal)
      : await requestPinnedPublicResource(parsed, addresses[0], { ...options, timeoutMs: remainingMs }, devProxyUrl);
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
