const CSRF_TOKEN_ENDPOINT = "/api/csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type CsrfTokenResponse = {
  csrfToken?: unknown;
};

const inputUrl = (input: RequestInfo | URL) => (
  input instanceof Request ? input.url : input.toString()
);

export const installCsrfFetch = () => {
  const currentFetch = window.fetch;
  if ((currentFetch as typeof currentFetch & { csrfAware?: boolean }).csrfAware) return;

  const nativeFetch = currentFetch.bind(window);
  let csrfToken: string | null = null;
  let csrfTokenRequest: Promise<string> | null = null;

  const loadCsrfToken = async (force = false) => {
    if (force) csrfToken = null;
    if (csrfToken) return csrfToken;
    if (csrfTokenRequest) return csrfTokenRequest;

    csrfTokenRequest = (async () => {
      const response = await nativeFetch(CSRF_TOKEN_ENDPOINT, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Unable to initialize request security");
      const payload = await response.json() as CsrfTokenResponse;
      if (typeof payload.csrfToken !== "string" || payload.csrfToken.length < 32) {
        throw new Error("Server returned an invalid request security token");
      }
      csrfToken = payload.csrfToken;
      return payload.csrfToken;
    })().finally(() => {
      csrfTokenRequest = null;
    });
    return csrfTokenRequest;
  };

  const csrfAwareFetch: typeof window.fetch = async (input, init) => {
    const url = new URL(inputUrl(input), window.location.href);
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (
      url.origin !== window.location.origin
      || !url.pathname.startsWith("/api/")
      || SAFE_METHODS.has(method)
      || url.pathname === CSRF_TOKEN_ENDPOINT
    ) {
      return nativeFetch(input, init);
    }

    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(url, init);
    const send = async (token: string) => {
      const attempt = request.clone();
      const headers = new Headers(attempt.headers);
      headers.set("X-CSRF-Token", token);
      return nativeFetch(new Request(attempt, { headers }));
    };

    let response = await send(await loadCsrfToken());
    if (response.status === 403 && response.headers.get("X-CSRF-Token-Invalid") === "1") {
      await response.body?.cancel().catch(() => undefined);
      response = await send(await loadCsrfToken(true));
    }
    return response;
  };

  Object.defineProperty(csrfAwareFetch, "csrfAware", { value: true });
  window.fetch = csrfAwareFetch;
};
