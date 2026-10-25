// POST /api/chat  Gemini-powered Wolfie Butler replies for the website chat.
// Request:  { messages:[{role:"user"|"assistant",content}], context:string(JSON), tools?:boolean, trail?:[], toolResults?:[{name,response}] }
// Response: { text, toolCalls:[{name,args}], trail }   (when toolCalls is non-empty, run them in the browser and call again with toolResults)
import { ApiError, guard, rateLimit, readJson, sendError, sendJson } from "../lib/http.js";
import { buildSystemPrompt } from "../lib/prompt.js";
import { generate, TOOLS } from "../lib/gemini.js";

const MAX_TURNS = 12, MAX_CHARS = 2000, MAX_CONTEXT = 250_000;

function cleanMessages(messages) {
  if (!Array.isArray(messages)) throw new ApiError(400, "bad_request", "messages must be an array.");
  const out = messages.slice(-MAX_TURNS).filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content.slice(0, MAX_CHARS) }] }));
  if (!out.length || out[out.length - 1].role !== "user") throw new ApiError(400, "bad_request", "The last message must come from the user.");
  return out;
}

function cleanTrail(trail) {
  if (trail === undefined || trail === null) return [];
  if (!Array.isArray(trail) || trail.length > 8 || JSON.stringify(trail).length > 60_000) throw new ApiError(400, "bad_request", "Invalid tool trail.");
  return trail.map(t => {
    if (!t || (t.role !== "model" && t.role !== "user") || !Array.isArray(t.parts) || t.parts.length > 8) throw new ApiError(400, "bad_request", "Invalid tool trail.");
    return { role: t.role, parts: t.parts.map(p => {
      const o = {};
      if (typeof p.text === "string") o.text = p.text.slice(0, MAX_CHARS * 2);
      if (p.functionCall && TOOLS[p.functionCall.name]) o.functionCall = { name: p.functionCall.name, args: p.functionCall.args || {} };
      if (p.functionResponse && TOOLS[p.functionResponse.name]) o.functionResponse = { name: p.functionResponse.name, response: p.functionResponse.response || {} };
      if (typeof p.thoughtSignature === "string") o.thoughtSignature = p.thoughtSignature;
      return o;
    }) };
  });
}

export default async function handler(req, res) {
  try {
    guard(req, res); rateLimit(req, "chat", 30);
    const body = await readJson(req);
    const context = typeof body.context === "string" ? body.context : "{}";
    if (context.length > MAX_CONTEXT) throw new ApiError(413, "too_large", "The menu context is too large.");
    const useTools = body.tools !== false;
    const trail = cleanTrail(body.trail);
    if (Array.isArray(body.toolResults) && body.toolResults.length) {
      trail.push({ role: "user", parts: body.toolResults.slice(0, 8).filter(r => r && TOOLS[r.name]).map(r => ({ functionResponse: { name: r.name, response: r.response && typeof r.response === "object" ? r.response : { result: String(r.response) } } })) });
    }
    const contents = [...cleanMessages(body.messages), ...trail];
    const t0 = Date.now(), wantStream = body.stream === true; let streaming = false;
    const onText = wantStream ? d => {
      if (!streaming) { streaming = true; res.statusCode = 200; res.setHeader("content-type", "text/event-stream; charset=utf-8"); res.setHeader("cache-control", "no-store, no-transform"); res.setHeader("x-accel-buffering", "no"); }
      res.write(`data: ${JSON.stringify({ t: d })}\n\n`);
    } : undefined;
    let out;
    try { out = await generate({ system: buildSystemPrompt(context, { tools: useTools }), contents, tools: useTools ? [TOOLS.add_to_meal] : [], onText }); }
    catch (e) {
      console.log(`[chat] status=${e.status || 500} code=${e.code || "error"} streamed=${streaming} totalMs=${Date.now() - t0}`);
      if (streaming) { res.write(`data: ${JSON.stringify({ error: { code: e.code || "server_error", message: e.code ? e.message : "Something went wrong on the server." } })}\n\n`); return res.end(); }
      throw e;
    }
    const nextTrail = out.toolCalls.length ? [...trail, { role: "model", parts: out.parts }] : [];
    const payload = { text: out.text, toolCalls: out.toolCalls, trail: nextTrail };
    console.log(`[chat] status=200 stream=${wantStream} streamed=${streaming} toolCalls=${out.toolCalls.length} contextChars=${context.length} totalMs=${Date.now() - t0}`);
    if (streaming) { res.write(`data: ${JSON.stringify({ done: true, ...payload })}\n\n`); return res.end(); }
    sendJson(res, 200, payload);
  } catch (e) { sendError(res, e); }
}
