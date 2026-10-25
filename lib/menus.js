// Reads the local menu database (data/menus) on the server. Used by the Photon iMessage agent, which has no browser to send menu context.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DIR = fileURLToPath(new URL("../data/menus/", import.meta.url));

export function loadMenus() {
  const out = {};
  let files = [];
  try { const man = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")); files = Array.isArray(man) ? man : man.files || []; } catch { return out; }
  for (const f of files) {
    if (!/^[\w.-]+\.json$/.test(f)) continue;
    try { const d = JSON.parse(readFileSync(join(DIR, f), "utf8")); if (["west", "east"].includes(d.hall) && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && Array.isArray(d.items)) out[`${d.hall}--${d.date}`] = d; } catch {}
  }
  return out;
}

/** Context JSON in the same shape the website sends (no profile or plan: the iMessage agent doesn't know the student). */
export function buildContext(menus = loadMenus(), today = new Date().toISOString().slice(0, 10)) {
  const dates = [...new Set(Object.values(menus).map(m => m.date))].sort();
  const date = dates.find(d => d >= today) || dates.at(-1) || null;
  const compact = m => m ? m.items.map(i => ({ id: i.id, station: i.station, name: i.name, kcal: i.nutr.cal, protein_g: i.nutr.protein, carbs_g: i.nutr.carbs, fat_g: i.nutr.fat, fiber_g: i.nutr.fiber, labels: i.labels, allergens: i.allergens?.length ? i.allergens : "not listed" })) : "not loaded";
  return JSON.stringify({ selected: { date }, profile: null, menus: { west: compact(menus[`west--${date}`]), east: compact(menus[`east--${date}`]) } });
}
