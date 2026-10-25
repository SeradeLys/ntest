// Persistent menu storage. Production uses Upstash Redis over its REST API (Vercel Marketplace integration; no dependency needed).
// The interface is tiny so another database can replace it, and tests use the in-memory version.
import { secret } from "./config.js";
import { ApiError, timedFetch } from "./http.js";

export function memoryStore() {
  const kv = new Map(), sets = new Map(), locks = new Map();
  return {
    kind: "memory",
    async get(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
    async set(k, v) { kv.set(k, JSON.stringify(v)); },
    async mget(ks) { return ks.map(k => kv.has(k) ? JSON.parse(kv.get(k)) : null); },
    async sadd(k, m) { (sets.get(k) || sets.set(k, new Set()).get(k)).add(m); },
    async smembers(k) { return [...(sets.get(k) || [])]; },
    async lock(k, ttlSec) { const now = Date.now(); if ((locks.get(k) || 0) > now) return false; locks.set(k, now + ttlSec * 1000); return true; },
    async unlock(k) { locks.delete(k); }
  };
}

export function upstashStore(url, token) {
  const cmd = async (...args) => {
    const r = await timedFetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) }, 8000, "Menu storage");
    if (!r.ok) throw new ApiError(502, "store_error", "Menu storage rejected the request.");
    const j = await r.json(); if (j.error) throw new ApiError(502, "store_error", "Menu storage rejected the request.");
    return j.result;
  };
  return {
    kind: "upstash",
    async get(k) { const v = await cmd("GET", k); return v ? JSON.parse(v) : null; },
    async set(k, v) { await cmd("SET", k, JSON.stringify(v)); },
    async mget(ks) { if (!ks.length) return []; return (await cmd("MGET", ...ks)).map(v => v ? JSON.parse(v) : null); },
    async sadd(k, m) { await cmd("SADD", k, m); },
    async smembers(k) { return (await cmd("SMEMBERS", k)) || []; },
    async lock(k, ttlSec) { return (await cmd("SET", k, "1", "NX", "EX", String(ttlSec))) === "OK"; },
    async unlock(k) { await cmd("DEL", k); }
  };
}

/** The configured store, or null when no database is connected (the site then keeps using its local menu files). */
export function getStore() {
  const url = secret("UPSTASH_REDIS_REST_URL") || secret("KV_REST_API_URL"), token = secret("UPSTASH_REDIS_REST_TOKEN") || secret("KV_REST_API_TOKEN");
  return url && token ? upstashStore(url, token) : null;
}
