// GET /api/menus?from=YYYY-MM-DD&to=YYYY-MM-DD  Reads stored menus. Never calls Nutrislice, so page loads never wait on it.
import { ApiError, guard, rateLimit, sendError } from "../lib/http.js";
import { getStore } from "../lib/store.js";
import { readMenus } from "../lib/refresh.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  try {
    guard(req, res, "GET"); rateLimit(req, "menus", 60);
    const store = getStore();
    if (!store) throw new ApiError(503, "not_configured", "No menu database is connected.");
    const url = new URL(req.url, "http://x"), from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || "";
    if ((from && !ISO.test(from)) || (to && !ISO.test(to))) throw new ApiError(400, "bad_request", "from and to must be YYYY-MM-DD.");
    const body = await readMenus(store, { from, to });
    res.statusCode = 200; res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "public, s-maxage=300, stale-while-revalidate=3600");   // CDN absorbs repeat loads
    res.end(JSON.stringify(body));
  } catch (e) { sendError(res, e); }
}
