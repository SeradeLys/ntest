// GET/POST /api/refresh  Protected daily menu refresh. Vercel Cron calls it with "Authorization: Bearer $CRON_SECRET".
import { timingSafeEqual } from "node:crypto";
import { ApiError, sendError, sendJson } from "../lib/http.js";
import { secret } from "../lib/config.js";
import { getStore } from "../lib/store.js";
import { refreshMenus } from "../lib/refresh.js";

const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") throw new ApiError(405, "method_not_allowed", "Use GET or POST.");
    const cron = secret("CRON_SECRET");
    if (!cron) throw new ApiError(503, "not_configured", "CRON_SECRET isn't set, so the refresh endpoint is disabled.");
    const auth = String(req.headers.authorization || "");
    if (!same(auth, `Bearer ${cron}`)) throw new ApiError(401, "unauthorized", "Missing or invalid refresh secret.");
    const store = getStore();
    if (!store) throw new ApiError(503, "not_configured", "No menu database is connected. Add the Upstash Redis integration (see README).");
    const out = await refreshMenus({ store });
    sendJson(res, out.ok ? 200 : out.skipped ? 202 : 502, out);
  } catch (e) { sendError(res, e); }
}
