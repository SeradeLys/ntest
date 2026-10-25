// GET /api/health  Which integrations are configured (booleans only; never returns keys).
import { sendError, sendJson, guard } from "../lib/http.js";
import { status } from "../lib/config.js";

export default function handler(req, res) {
  try { guard(req, res, "GET"); sendJson(res, 200, { ok: true, configured: status() }); } catch (e) { sendError(res, e); }
}
