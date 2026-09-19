// Minimal HTTP client for the DrawCMS cloud API. Attaches the bearer token,
// parses JSON, and normalizes failures into a stable { ok:false, status, error }
// shape so commands never have to catch raw fetch errors. Uses global fetch
// (Node >=18).

/** Hard cap on any response body the CLI will buffer. The API returns small
 * JSON (a diagram document, a list of projects); anything approaching this is
 * either a misconfiguration or a hostile/compromised origin trying to exhaust
 * memory or disk (pull/stash write the body to a file). 16 MiB is comfortably
 * above a legitimate large diagram while bounding the blast radius. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Read a fetch Response body as text, but refuse to buffer more than `limit`
 * bytes. Streams the body so an oversized (or endless) response is aborted
 * early instead of being fully materialized. Returns { ok:true, text } or
 * { ok:false } when the cap is exceeded. */
async function readBodyCapped(response, limit) {
  // Fast path: if the server declared an oversized Content-Length, reject
  // before reading a single byte.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return { ok: false };

  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    // No stream available (unusual on Node >=18) — fall back to text() but still
    // guard the resulting size.
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) return { ok: false };
    return { ok: true, text };
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * @param {object} opts
 * @param {string} opts.origin   server origin, no trailing slash
 * @param {string} [opts.token]  bearer token for authenticated calls
 */
export function createApi({ origin, token }) {
  async function request(path, { method = "GET", body, headers = {}, auth = true } = {}) {
    const finalHeaders = { Accept: "application/json", ...headers };
    if (body !== undefined) finalHeaders["Content-Type"] = "application/json";
    if (auth && token) finalHeaders["Authorization"] = `Bearer ${token}`;

    let response;
    try {
      response = await fetch(`${origin}${path}`, {
        method,
        headers: finalHeaders,
        ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
      });
    } catch (error) {
      return { ok: false, status: 0, error: { code: "NETWORK", message: error.message } };
    }

    const capped = await readBodyCapped(response, MAX_RESPONSE_BYTES);
    if (!capped.ok) {
      return {
        ok: false,
        status: response.status,
        error: {
          code: "RESPONSE_TOO_LARGE",
          message: `Response from ${origin}${path} exceeded ${MAX_RESPONSE_BYTES} bytes and was refused.`,
        },
      };
    }
    const text = capped.text;
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!response.ok) {
      // Cloud errors use { ok:false, error:{ code, message } } or the auth
      // plugins' { code, message }. Normalize both.
      const err =
        (data && data.error) ||
        (data && data.code ? { code: data.code, message: data.message ?? response.statusText } : null) ||
        { code: `HTTP_${response.status}`, message: response.statusText || "Request failed" };
      return { ok: false, status: response.status, error: err, data };
    }

    return { ok: true, status: response.status, data };
  }

  return {
    request,
    get: (path, opts) => request(path, { ...opts, method: "GET" }),
    post: (path, body, opts) => request(path, { ...opts, method: "POST", body }),
    put: (path, body, opts) => request(path, { ...opts, method: "PUT", body }),
  };
}
