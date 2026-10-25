// Daily menu refresh: fetch Nutrislice (server-side), upsert normalized menus, record freshness. Idempotent and safe to run twice.
import { HALLS, fetchWeek } from "./nutrislice.js";

export const menuKey = (hall, date) => `menu:${hall}:${date}`;
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** "Today" in Stony Brook's timezone, so the 9:00 UTC cron (early morning in New York) asks for the right date. */
export const todayNY = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);

export async function refreshMenus({ store, fetcher = fetchWeek, now = new Date(), log = console }) {
  const started = Date.now();
  if (!(await store.lock("menu:lock", 120))) return { ok: false, skipped: "already_running" };
  const summary = { ok: true, updated: 0, errors: [], halls: {} };
  try {
    const today = todayNY(now);
    // Required: the week around today for every hall. Optional: the following week (may not be published yet).
    const jobs = Object.keys(HALLS).flatMap(h => [{ hall: h, iso: today, required: true }, { hall: h, iso: addDays(today, 7), required: false }]);
    const results = await Promise.all(jobs.map(async j => { try { return { j, days: await fetcher(j.hall, j.iso) }; } catch (e) { return { j, error: e.message }; } }));
    for (const { j, days, error } of results) {
      if (error) { if (j.required || !/No dishes/.test(error)) { summary.errors.push(`${j.hall} ${j.iso}: ${error}`); if (j.required) summary.ok = false; } continue; }
      for (const d of days) {
        const doc = { hall: d.hall, date: d.date, items: d.items, source: d.source, sourceUrl: d.sourceUrl, importedAt: now.toISOString() };
        await store.set(menuKey(d.hall, d.date), doc); await store.sadd("menu:index", menuKey(d.hall, d.date));   // upsert by key: reruns overwrite, never duplicate
        summary.updated++; (summary.halls[d.hall] ||= []).push(d.date);
      }
    }
    const prev = (await store.get("menu:meta")) || {};
    const meta = { ...prev, lastAttempt: now.toISOString(), lastErrors: summary.errors.slice(0, 5) };
    if (summary.ok) { meta.lastSuccess = now.toISOString(); meta.lastUpdated = summary.updated; }   // a partial refresh never counts as success; last good data stays in place
    await store.set("menu:meta", meta);
  } catch (e) { summary.ok = false; summary.errors.push(e.message); }
  finally { await store.unlock("menu:lock").catch(() => {}); }
  summary.ms = Date.now() - started;
  log.log(`[refresh] ok=${summary.ok} updated=${summary.updated} errors=${summary.errors.length} ${summary.ms}ms`);
  return summary;
}

/** Everything the website needs: menus for [from, to] plus freshness. */
export async function readMenus(store, { from, to } = {}) {
  const keys = (await store.smembers("menu:index")).filter(k => { const d = k.split(":")[2]; return (!from || d >= from) && (!to || d <= to); }).sort();
  const docs = (await store.mget(keys)).filter(Boolean);
  const meta = (await store.get("menu:meta")) || {};
  const age = meta.lastSuccess ? Date.now() - Date.parse(meta.lastSuccess) : Infinity;
  return { menus: docs, meta: { lastSuccess: meta.lastSuccess || null, lastAttempt: meta.lastAttempt || null, stale: age > 36 * 3600e3 } };
}
