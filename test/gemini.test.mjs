// Gemini service behavior: bounded retries, no retry on client errors, streaming, timeouts. Mock upstream only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let mock, hits = 0, script = [];
before(async () => {
  mock = http.createServer((req, res) => { req.resume(); req.on("end", async () => {
    hits++; const step = script.shift() || { status: 200 };
    if (step.delay) await new Promise(r => setTimeout(r, step.delay));
    res.statusCode = step.status || 200;
    if (step.sse) { res.setHeader("content-type", "text/event-stream"); for (const c of step.sse) { res.write(`data: ${JSON.stringify(c)}\n\n`); await new Promise(r => setTimeout(r, step.gap || 5)); } if (step.stall) return; return res.end(); }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(step.body || { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }));
  }); });
  await new Promise(r => mock.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { GEMINI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1beta`, GEMINI_API_KEY: "k", API_TIMEOUT_MS: "400", API_BUDGET_MS: "6000" });
});
after(() => mock.close());
const run = async (steps, opts = {}) => { hits = 0; script = steps; const { generate } = await import("../lib/gemini.js"); return generate({ system: "s", contents: [{ role: "user", parts: [{ text: "hi" }] }], ...opts }); };
const origLog = console.log; before(() => { console.log = () => {}; }); after(() => { console.log = origLog; });

test("transient 503 is retried and then succeeds", async () => { const r = await run([{ status: 503 }, { status: 503 }, {}]); assert.equal(r.text, "ok"); assert.equal(hits, 3); });
test("retries are bounded (1 try + 2 retries)", async () => { await assert.rejects(run([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]), e => e.code === "upstream_error"); assert.equal(hits, 3); });
test("429 is retried at most twice", async () => { await assert.rejects(run([{ status: 429 }, { status: 429 }, { status: 429 }]), e => e.code === "rate_limited"); assert.equal(hits, 3); });
for (const [status, code] of [[400, "upstream_rejected"], [401, "invalid_credentials"], [403, "invalid_credentials"], [404, "model_not_found"]])
  test(`${status} is never retried`, async () => { await assert.rejects(run([{ status, body: { error: { message: status === 401 ? "API key not valid" : "x" } } }]), e => e.code === code); assert.equal(hits, 1); });
test("a hung upstream times out, retries within budget, and reports a timeout (not a generic error)", async () => {
  await assert.rejects(run([{ delay: 1500 }, { delay: 1500 }, { delay: 1500 }]), e => e.code === "timeout"); assert.ok(hits <= 3);
});
test("streaming passes text on as it arrives and merges the final answer", async () => {
  const seen = []; const r = await run([{ sse: [{ candidates: [{ content: { parts: [{ text: "Hel" }] } }] }, { candidates: [{ content: { parts: [{ text: "lo!" }] }, finishReason: "STOP" }] }] }], { onText: d => seen.push(d) });
  assert.deepEqual(seen, ["Hel", "lo!"]); assert.equal(r.text, "Hello!");
});
test("streaming surfaces tool calls", async () => {
  const r = await run([{ sse: [{ candidates: [{ content: { parts: [{ functionCall: { name: "add_to_meal", args: { hallId: "west", dishId: "1" } } }] }, finishReason: "STOP" }] }] }], { onText: () => {} });
  assert.equal(r.toolCalls[0].name, "add_to_meal"); assert.equal(r.text, "");
});
test("a stream that goes silent mid-answer ends with a timeout instead of hanging", async () => {
  await assert.rejects(run([{ sse: [{ candidates: [{ content: { parts: [{ text: "Hel" }] } }] }], stall: true }], { onText: () => {} }), e => e.code === "timeout");
});
test("thinking level is only sent when configured", async () => {
  let body; const orig = globalThis.fetch; globalThis.fetch = async (u, i) => { body = JSON.parse(i.body); return orig(u, i); };
  await run([{}]); assert.equal(body.generationConfig.thinkingConfig, undefined);
  process.env.GEMINI_THINKING_LEVEL = "low"; await run([{}]); assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "low"); delete process.env.GEMINI_THINKING_LEVEL; globalThis.fetch = orig;
});
