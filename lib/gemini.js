// Google Gemini service (REST). Provider-specific code lives only here.
// Docs: https://ai.google.dev/api/generate-content
import { secret, config } from "./config.js";
import { ApiError } from "./http.js";

export const TOOLS = {
  add_to_meal: {
    name: "add_to_meal",
    description: "Add a dish from the selected date's menu to the student's meal plan. Returns the updated plan item count.",
    parameters: { type: "OBJECT", properties: {
      hallId: { type: "STRING", enum: ["west", "east"] }, dishId: { type: "STRING" },
      servings: { type: "INTEGER" }, period: { type: "STRING", enum: ["Breakfast", "Lunch", "Dinner"] } }, required: ["hallId", "dishId"] },
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2, BACKOFF_MS = 700;

/** One-line timing log. Never includes keys, prompts or answers. */
function log(fields) { console.log("[gemini] " + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")); }

/**
 * POST to Gemini with a per-attempt timeout and bounded retries (max 2) for transient failures only:
 * network errors, timeouts, 429 and 5xx. Invalid requests, auth errors and unknown models are never retried.
 * The whole thing stays inside API_BUDGET_MS. Resolves with the first non-transient Response (headers received).
 */
async function post(url, init, meta) {
  const t0 = Date.now(), per = config.timeoutMs(), budget = config.budgetMs();
  let last;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), Math.min(per, Math.max(1000, budget - (Date.now() - t0))));
    const started = Date.now();
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      clearTimeout(timer);
      log({ ...meta, attempt, status: res.status, headersMs: Date.now() - started });
      if (!TRANSIENT.has(res.status)) { res._ctl = ctl; return res; }
      last = mapError(res.status, await res.json().catch(() => null));
    } catch (e) {
      clearTimeout(timer);
      const timedOut = e && (e.name === "AbortError" || e.name === "TimeoutError");
      log({ ...meta, attempt, status: timedOut ? "timeout" : "network_error", headersMs: Date.now() - started });
      last = timedOut ? new ApiError(504, "timeout", "Gemini didn't answer in time. Try again, or ask a shorter question.")
                      : new ApiError(502, "upstream_unreachable", "Couldn't reach Gemini. Check the server's internet connection.");
    }
    const wait = BACKOFF_MS * 2 ** (attempt - 1);
    if (attempt > MAX_RETRIES || Date.now() - t0 + wait + 1000 >= budget) break;
    await sleep(wait);
  }
  throw last;
}

/**
 * @param {{system:string, contents:object[], tools?:object[], onText?:(delta:string)=>void}} req
 * With onText the streaming endpoint is used and text is passed on as it arrives.
 * @returns {Promise<{text:string, toolCalls:{name:string,args:object}[], parts:object[]}>}
 */
export async function generate({ system, contents, tools = [], onText }) {
  const key = secret("GEMINI_API_KEY");
  if (!key) throw new ApiError(503, "not_configured", "Gemini isn't set up yet. Add GEMINI_API_KEY to your .env file and restart the server (see README).");
  const thinking = config.geminiThinking();
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 1200, ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}) },
    ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
  };
  const stream = typeof onText === "function", model = config.geminiModel();
  const url = `${config.geminiBaseUrl()}/models/${encodeURIComponent(model)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  const t0 = Date.now(), meta = { model, stream, promptChars: JSON.stringify(body).length };
  const res = await post(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) }, meta);
  if (!res.ok) throw mapError(res.status, await res.json().catch(() => null));

  let parts = [], blocked = false, reason = "", first = 0;
  const take = data => {
    if (data?.promptFeedback?.blockReason) blocked = true;
    const cand = data?.candidates?.[0]; if (cand?.finishReason) reason = cand.finishReason;
    for (const p of Array.isArray(cand?.content?.parts) ? cand.content.parts : []) {
      const prev = parts[parts.length - 1];
      if (typeof p.text === "string" && !p.thought && prev && typeof prev.text === "string" && !prev.thought && !prev.functionCall && !p.functionCall && !prev.thoughtSignature) prev.text += p.text;   // merge streamed text pieces
      else parts.push({ ...p });
      if (stream && typeof p.text === "string" && !p.thought && p.text) { if (!first) first = Date.now() - t0; onText(p.text); }
    }
  };
  if (!stream) take(await res.json().catch(() => null));
  else {
    // Idle timeout: abort if Gemini goes silent for API_TIMEOUT_MS between chunks.
    let idle; const arm = () => { clearTimeout(idle); idle = setTimeout(() => res._ctl.abort(), config.timeoutMs()); };
    const dec = new TextDecoder(); let buf = ""; arm();
    try {
      for await (const chunk of res.body) {
        arm(); buf += dec.decode(chunk, { stream: true });
        let i; while ((i = buf.indexOf("\n\n")) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); const line = ev.split("\n").find(l => l.startsWith("data:")); if (line) { try { take(JSON.parse(line.slice(5))); } catch {} } }
      }
      if (buf.trim().startsWith("data:")) { try { take(JSON.parse(buf.trim().slice(5))); } catch {} }
    } catch (e) { clearTimeout(idle); log({ ...meta, status: "stream_error", totalMs: Date.now() - t0 }); throw new ApiError(504, "timeout", "Gemini stopped answering partway through. Try again."); }
    clearTimeout(idle);
  }
  log({ ...meta, status: "done", firstTextMs: first || "-", totalMs: Date.now() - t0, finish: reason || "-" });
  const text = parts.filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("").trim();
  const toolCalls = parts.filter(p => p.functionCall && p.functionCall.name).map(p => ({ name: String(p.functionCall.name), args: p.functionCall.args || {} }));
  if (blocked || (!text && !toolCalls.length && reason === "SAFETY")) throw new ApiError(422, "refused", "I can't help with that one. Try asking about the menus or your meal plan.");
  if (!text && !toolCalls.length) throw new ApiError(502, "empty_response", "Gemini returned an empty answer. Try asking again.");
  return { text, toolCalls, parts };
}

function mapError(status, data) {
  const msg = String(data?.error?.message || "");
  if (status === 429) return new ApiError(429, "rate_limited", "Gemini is busy or the quota is used up. Wait a moment, then try again.");
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(msg))) return new ApiError(502, "invalid_credentials", "Gemini rejected the API key. Check GEMINI_API_KEY in your .env file.");
  if (status === 404) return new ApiError(502, "model_not_found", `Gemini doesn't know the model "${config.geminiModel()}". Set GEMINI_MODEL to a model your key can use.`);
  if (status === 400) return new ApiError(502, "upstream_rejected", config.geminiThinking() ? "Gemini rejected the request. If this keeps happening, remove GEMINI_THINKING_LEVEL (that model may not support it)." : "Gemini rejected the request. Try a shorter message.");
  return new ApiError(502, "upstream_error", "Gemini had a problem. Try again in a moment.");
}
