// Shared HTTP helpers for the API routes (work with Vercel functions and the local dev server).
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export function sendError(res, err) {
  const known = err instanceof ApiError;
  if (!known) console.error("[api] unexpected error:", err && err.name, err && err.message);   // never log request bodies or headers
  sendJson(res, known ? err.status : 500, { error: { code: known ? err.code : "server_error", message: known ? err.message : "Something went wrong on the server." } });
}

export async function readJson(req, maxBytes = 600_000) {
  if (req.body !== undefined && req.body !== null && typeof req.body === "object") return req.body;   // Vercel pre-parses JSON
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > maxBytes) throw new ApiError(413, "too_large", "That request is too large."); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new ApiError(400, "bad_request", "The request body must be valid JSON."); }
}

/** Allow only POST from the same origin (blocks other websites from spending your API quota through a visitor's browser). */
export function guard(req, res, method = "POST") {
  if (req.method !== method) { res.setHeader("allow", method); throw new ApiError(405, "method_not_allowed", `Use ${method}.`); }
  const origin = req.headers.origin;
  if (origin) { let host = ""; try { host = new URL(origin).host; } catch {} if (host !== req.headers.host) throw new ApiError(403, "forbidden_origin", "Cross-origin requests are not allowed."); }
}

// Best-effort in-memory rate limit (per server instance; on serverless it resets when an instance restarts).
const hits = new Map();
export function rateLimit(req, bucket, max, windowMs = 60_000) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  const key = bucket + ":" + ip, now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) throw new ApiError(429, "rate_limited", "Too many requests. Wait a moment and try again.");
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
}

/** fetch with a timeout; network and timeout failures become ApiErrors. */
export async function timedFetch(url, init, timeoutMs, provider) {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) throw new ApiError(504, "timeout", `${provider} took too long to respond. Try again.`);
    throw new ApiError(502, "upstream_unreachable", `Couldn't reach ${provider}. Check the server's internet connection.`);
  }
}
