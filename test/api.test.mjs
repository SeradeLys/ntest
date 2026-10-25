// Runs the real handlers against mock Gemini and ElevenLabs servers. No real keys or network needed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const calls = { gemini: [], eleven: [] };
let mode = { gemini: "ok", eleven: "ok" }, mock, app, base;

const listen = srv => new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const body = req => new Promise(r => { let d = ""; req.on("data", c => d += c); req.on("end", () => r(d)); });

before(async () => {
  mock = http.createServer(async (req, res) => {
    const raw = await body(req);
    if (req.url.includes(":generateContent")) {
      calls.gemini.push({ key: req.headers["x-goog-api-key"], body: JSON.parse(raw) });
      if (mode.gemini === "401") { res.statusCode = 403; return res.end('{"error":{"message":"API key not valid"}}'); }
      if (mode.gemini === "429") { res.statusCode = 429; return res.end("{}"); }
      const hasResult = raw.includes("functionResponse");
      const parts = mode.gemini === "tool" && !hasResult ? [{ functionCall: { name: "add_to_meal", args: { hallId: "west", dishId: "x1" } } }] : [{ text: hasResult ? "Added it!" : "Try the grilled chicken." }];
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] }));
    }
    if (req.url.includes("/v1/text-to-speech/")) {
      calls.eleven.push({ key: req.headers["xi-api-key"], url: req.url, body: JSON.parse(raw) });
      if (mode.eleven === "401") { res.statusCode = 401; return res.end("{}"); }
      if (mode.eleven === "404") { res.statusCode = 404; return res.end("{}"); }
      res.setHeader("content-type", "audio/mpeg"); return res.end(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    }
    res.statusCode = 404; res.end();
  });
  const mp = await listen(mock);
  Object.assign(process.env, { GEMINI_BASE_URL: `http://127.0.0.1:${mp}/v1beta`, ELEVENLABS_BASE_URL: `http://127.0.0.1:${mp}`, GEMINI_API_KEY: "test-gemini-key", ELEVENLABS_API_KEY: "test-eleven-key", ELEVENLABS_VOICE_ID: "voice-123" });
  const { createServer } = await import("../server.mjs");
  app = createServer(); base = `http://127.0.0.1:${await listen(app)}`;
});
after(() => { mock.close(); app.close(); });

const post = (path, b, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
const chat = (extra = {}) => post("/api/chat", { messages: [{ role: "user", content: "hi" }], context: '{"menus":{}}', ...extra });
const reset = () => { calls.gemini.length = calls.eleven.length = 0; mode = { gemini: "ok", eleven: "ok" }; };

test("site and health load; health reports booleans only", async () => {
  assert.equal((await fetch(base + "/")).status, 200);
  const h = await (await fetch(base + "/api/health")).json();
  assert.deepEqual(h.configured, { gemini: true, elevenlabs: true, photon: false, menuStore: false, cron: false });
  assert.ok(!JSON.stringify(h).includes("test-gemini-key"));
});

test("server files are not served", async () => {
  for (const p of ["/.env", "/lib/config.js", "/package.json", "/server.mjs", "/..%2f.env"]) assert.equal((await fetch(base + p)).status, 404, p);
});

test("chat returns Gemini text, key goes in header, system prompt is server-side", async () => {
  reset(); const r = await chat(); assert.equal(r.status, 200);
  const j = await r.json(); assert.equal(j.text, "Try the grilled chicken.");
  assert.equal(calls.gemini[0].key, "test-gemini-key");
  assert.match(JSON.stringify(calls.gemini[0].body.systemInstruction), /Wolfie Butler/);
  assert.equal(calls.eleven.length, 0, "text chat must not call ElevenLabs");
});

test("tool call round trip", async () => {
  reset(); mode.gemini = "tool";
  const a = await (await chat()).json(); assert.equal(a.toolCalls[0].name, "add_to_meal"); assert.ok(a.trail.length);
  const b = await (await chat({ trail: a.trail, toolResults: [{ name: "add_to_meal", response: { ok: true } }] })).json();
  assert.equal(b.text, "Added it!"); assert.equal(b.toolCalls.length, 0);
});

test("placeholder and missing Gemini key give a clear error and never reach the API", async () => {
  reset(); const keep = process.env.GEMINI_API_KEY;
  for (const v of ["REPLACE_WITH_YOUR_GEMINI_API_KEY", ""]) {
    process.env.GEMINI_API_KEY = v; const r = await chat(); const j = await r.json();
    assert.equal(r.status, 503); assert.equal(j.error.code, "not_configured"); assert.match(j.error.message, /GEMINI_API_KEY/);
  }
  assert.equal(calls.gemini.length, 0); process.env.GEMINI_API_KEY = keep;
});

test("Gemini invalid credentials and rate limits map to friendly errors without leaking keys", async () => {
  reset(); mode.gemini = "401"; let r = await chat(); let j = await r.json();
  assert.equal(j.error.code, "invalid_credentials"); assert.ok(!JSON.stringify(j).includes("test-gemini-key"));
  mode.gemini = "429"; r = await chat(); j = await r.json(); assert.equal(r.status, 429); assert.equal(j.error.code, "rate_limited");
});

test("rejects cross-origin and bad requests", async () => {
  reset(); assert.equal((await chat.call(null) && await post("/api/chat", { messages: [{ role: "user", content: "x" }], context: "{}" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(base + "/api/chat")).status, 405);
  assert.equal((await post("/api/chat", { messages: [{ role: "assistant", content: "x" }] })).status, 400);
});

test("TTS returns audio of the reply only, with the configured voice", async () => {
  reset(); const r = await post("/api/tts", { text: "**Hello** there" });
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "audio/mpeg"); assert.equal((await r.arrayBuffer()).byteLength, 4);
  assert.equal(calls.eleven[0].key, "test-eleven-key"); assert.match(calls.eleven[0].url, /voice-123/); assert.equal(calls.eleven[0].body.text, "Hello there");
});

test("TTS errors: placeholder voice id, bad key, unknown voice", async () => {
  reset(); const v = process.env.ELEVENLABS_VOICE_ID, k = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_VOICE_ID = "REPLACE_WITH_YOUR_ELEVENLABS_VOICE_ID";
  let j = await (await post("/api/tts", { text: "hi" })).json(); assert.equal(j.error.code, "voice_not_configured"); assert.equal(calls.eleven.length, 0);
  process.env.ELEVENLABS_VOICE_ID = v; process.env.ELEVENLABS_API_KEY = "REPLACE_WITH_YOUR_ELEVENLABS_API_KEY";
  j = await (await post("/api/tts", { text: "hi" })).json(); assert.equal(j.error.code, "not_configured"); assert.equal(calls.eleven.length, 0);
  process.env.ELEVENLABS_API_KEY = k; mode.eleven = "401"; j = await (await post("/api/tts", { text: "hi" })).json(); assert.equal(j.error.code, "invalid_credentials");
  mode.eleven = "404"; j = await (await post("/api/tts", { text: "hi" })).json(); assert.equal(j.error.code, "voice_not_found");
});
