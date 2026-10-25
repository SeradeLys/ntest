// Menu pipeline tests: parser, retries, idempotent refresh, partial-failure safety, auth, and the real Upstash adapter against a mock REST server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parse, fetchWeek, weekUrl } from "../lib/nutrislice.js";
import { refreshMenus, readMenus } from "../lib/refresh.js";
import { memoryStore } from "../lib/store.js";

const raw = date => ({ days: [{ date, menu_items: [
  { is_section_title: true, text: "Hot Breakfast Buffet" },
  { food: { id: 1, name: "Scrambled Eggs", description: "", rounded_nutrition_info: { calories: 170, g_protein: 10, g_carbs: 1, g_fat: 14, g_fiber: 0 }, icons: { food_icons: [{ name: "Vegetarian" }, { name: "Contains Milk" }] }, serving_size_info: { serving_size_amount: 0.5, serving_size_unit: "cups" } } },
  { food: { id: 2, name: "Mystery Stew", has_nutrition_info: false } }
] }] });

test("parser keeps missing nutrition as null, splits labels and allergens", () => {
  const [d] = parse(raw("2026-10-26"), "west"); assert.equal(d.items.length, 2);
  const [eggs, stew] = d.items; assert.equal(eggs.nutr.cal, 170); assert.deepEqual(eggs.allergens, ["Milk"]); assert.deepEqual(eggs.labels, ["Vegetarian"]); assert.equal(eggs.station, "Hot Breakfast Buffet");
  assert.equal(stew.nutr.cal, null, "never invent nutrition");
});

test("endpoint URLs match the pattern in the supplied Stony Brook links", () => {
  assert.equal(weekUrl("west", "2026-10-23", "https://stonybrook.api.nutrislice.com"), "https://stonybrook.api.nutrislice.com/menu/api/weeks/school/west-side-dining/menu-type/todays-dine-in-specials-wsd/2026/10/23/?format=json");
  assert.match(weekUrl("east", "2026-10-23", "https://stonybrook.api.nutrislice.com"), /east-side-dining\/menu-type\/todays-dine-in-specials-esd\/2026\/10\/23/);
});

const resp = (status, body) => ({ status, ok: status < 400, json: async () => body });
test("fetchWeek retries transient errors a bounded number of times, never auth/client errors", async () => {
  let n = 0; const ok = await fetchWeek("west", "2026-10-26", { backoffMs: 1, fetchImpl: async () => ++n < 3 ? resp(503) : resp(200, raw("2026-10-26")) }); assert.equal(n, 3); assert.equal(ok[0].items.length, 2);
  n = 0; await assert.rejects(fetchWeek("west", "2026-10-26", { backoffMs: 1, fetchImpl: async () => { n++; return resp(503); } })); assert.equal(n, 3, "1 try + 2 retries, then stop");
  n = 0; await assert.rejects(fetchWeek("west", "2026-10-26", { backoffMs: 1, fetchImpl: async () => { n++; return resp(404); } })); assert.equal(n, 1, "404 is not retried");
});

const NOW = new Date("2026-10-26T13:00:00Z");
const okFetcher = async (hall, iso) => parse(raw(iso), hall).map(d => ({ ...d, source: "Nutrislice", sourceUrl: "u" }));

test("refresh is idempotent and records success", async () => {
  const store = memoryStore(); const silent = { log() {} };
  const a = await refreshMenus({ store, fetcher: okFetcher, now: NOW, log: silent }); assert.ok(a.ok);
  const b = await refreshMenus({ store, fetcher: okFetcher, now: NOW, log: silent }); assert.ok(b.ok);
  const { menus, meta } = await readMenus(store); assert.equal(menus.length, 4, "2 halls x 2 dates, no duplicates"); assert.equal(meta.stale, false); assert.ok(meta.lastSuccess);
});

test("partial failure keeps last good snapshot and is not marked successful", async () => {
  const store = memoryStore(); const silent = { log() {} };
  await refreshMenus({ store, fetcher: okFetcher, now: NOW, log: silent });
  const before = (await readMenus(store)).meta.lastSuccess;
  const later = new Date(NOW.getTime() + 864e5);
  const bad = await refreshMenus({ store, fetcher: async (h, iso) => { if (h === "east") throw new Error("Nutrislice timed out"); return okFetcher(h, iso); }, now: later, log: silent });
  assert.equal(bad.ok, false); const r = await readMenus(store);
  assert.equal(r.meta.lastSuccess, before, "lastSuccess unchanged"); assert.ok(r.menus.some(m => m.hall === "east"), "old east menus still served");
  assert.equal((await refreshMenus({ store, fetcher: async () => { throw new Error("down"); }, now: later, log: silent })).ok, false);
  assert.ok((await readMenus(store)).menus.length >= 4);
});

test("overlapping runs are refused", async () => {
  const store = memoryStore(); let release; const gate = new Promise(r => release = r);
  const slow = async (h, i) => { await gate; return okFetcher(h, i); };
  const first = refreshMenus({ store, fetcher: slow, now: NOW, log: { log() {} } });
  const second = await refreshMenus({ store, fetcher: okFetcher, now: NOW, log: { log() {} } }); assert.equal(second.skipped, "already_running");
  release(); assert.ok((await first).ok);
});

test("stale flag turns on after 36 hours", async () => {
  const store = memoryStore(); await refreshMenus({ store, fetcher: okFetcher, now: new Date(Date.now() - 40 * 3600e3), log: { log() {} } });
  assert.equal((await readMenus(store)).meta.stale, true);
});

// ---- real adapter + routes against a mock Upstash REST server and a mock Nutrislice ----
let up, nu, app, base; const kv = new Map(), sets = new Map(); const listen = s => new Promise(r => s.listen(0, "127.0.0.1", () => r(s.address().port)));
before(async () => {
  up = http.createServer((req, res) => { let d = ""; req.on("data", c => d += c); req.on("end", () => {
    if (req.headers.authorization !== "Bearer up-token") { res.statusCode = 401; return res.end("{}"); }
    const [c, k, ...a] = JSON.parse(d); let result = null;
    if (c === "GET") result = kv.get(k) ?? null; else if (c === "SET") { if (a.includes("NX") && kv.has(k)) result = null; else { kv.set(k, a[0]); result = "OK"; } }
    else if (c === "DEL") { kv.delete(k); result = 1; } else if (c === "SADD") { (sets.get(k) || sets.set(k, new Set()).get(k)).add(a[0]); result = 1; }
    else if (c === "SMEMBERS") result = [...(sets.get(k) || [])]; else if (c === "MGET") result = [k, ...a].map(x => kv.get(x) ?? null);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result })); }); });
  nu = http.createServer((req, res) => { const iso = req.url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//).slice(1).join("-"); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(raw(iso))); });
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${await listen(up)}`, UPSTASH_REDIS_REST_TOKEN: "up-token", NUTRISLICE_BASE_URL: `http://127.0.0.1:${await listen(nu)}`, CRON_SECRET: "cron-secret-xyz" });
  const { createServer } = await import("../server.mjs"); app = createServer(); base = `http://127.0.0.1:${await listen(app)}`;
});
after(() => { up.close(); nu.close(); app.close(); });

test("/api/refresh requires the secret, then fills the cloud store; /api/menus serves it", async () => {
  assert.equal((await fetch(base + "/api/refresh")).status, 401);
  assert.equal((await fetch(base + "/api/refresh", { headers: { authorization: "Bearer wrong" } })).status, 401);
  const r = await fetch(base + "/api/refresh", { headers: { authorization: "Bearer cron-secret-xyz" } }); const j = await r.json(); assert.equal(r.status, 200); assert.ok(j.ok && j.updated >= 2);
  const m = await (await fetch(base + "/api/menus")).json(); assert.ok(m.menus.length >= 2); assert.ok(m.meta.lastSuccess); assert.equal(m.meta.stale, false);
  const again = await (await fetch(base + "/api/refresh", { headers: { authorization: "Bearer cron-secret-xyz" } })).json(); assert.ok(again.ok);
  assert.equal((await (await fetch(base + "/api/menus")).json()).menus.length, m.menus.length, "rerun creates no duplicates");
  assert.equal((await fetch(base + "/api/menus?from=bad")).status, 400);
});
