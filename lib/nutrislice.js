// Server-side Nutrislice ingestion. parse() is the same parser the website uses for imported JSON (copied verbatim from index.html's MenuProvider),
// so the cloud menus have exactly the shape the UI, nutrition maths and recommendations already consume.
export const HALLS = {
  west: { slug: "west-side-dining", menuType: "todays-dine-in-specials-wsd" },
  east: { slug: "east-side-dining", menuType: "todays-dine-in-specials-esd" }
};
const DISTRICT = "stonybrook";

const parse = (() => {
  const ALLERGEN = /\b(milk|dairy|eggs?|wheat|gluten|soy|soybeans?|peanuts?|tree ?nuts?|nuts?|fish|shellfish|crustacean|sesame|mustard|sulfites?|coconut)\b/i;
  const FREE = /\b(free|friendly|without|no|avoid|avoiding)\b/i;
  const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
  const clean = s => String(s || "").replace(/\s+/g," ").trim();
  function parse(raw, hallId){
    let data;
    try { data = typeof raw === "string" ? JSON.parse(raw.trim()) : raw; } catch(e){ throw new Error("Nutrislice returned invalid JSON."); }
    let days = Array.isArray(data?.days) ? data.days : (Array.isArray(data?.menu_items) ? [{ date:data.date, menu_items:data.menu_items }] : null);
    if (!days) throw new Error("This doesn't look like a Nutrislice menu. The JSON should have a \"days\" list.");
    const out = [];
    for (const day of days) {
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.date || "")) continue;
      let station = "Specials"; const seen = new Set(); const items = [];
      for (const mi of (day.menu_items || [])) {
        if (mi.is_section_title || mi.is_station_header || (!mi.food && mi.text)) { if (clean(mi.text)) station = clean(mi.text); continue; }
        const f = mi.food; if (!f || !f.name) continue;
        const id = String(f.id ?? mi.id ?? clean(f.name).toLowerCase().replace(/[^a-z0-9]+/g,"-"));
        if (seen.has(id + station)) continue; seen.add(id + station);
        const n = f.rounded_nutrition_info || f.nutrition_info || {};
        const hasN = f.has_nutrition_info !== false;
        const g = k => hasN ? num(n[k]) : null;
        const icons = Array.isArray(f.icons?.food_icons) ? f.icons.food_icons : (Array.isArray(f.icons) ? f.icons : []);
        const labels = [], allergens = [];
        icons.forEach(ic => { const nm = clean(ic?.name || ic?.synced_name || ic?.help_text); if (!nm) return;
          const isAllergen = ic.food_icon_group === 1261 || /^contains\s/i.test(nm) || (ALLERGEN.test(nm) && !FREE.test(nm));
          (isAllergen ? allergens : labels).push(nm.replace(/^contains\s+/i,"")); });
        const ss = f.serving_size_info || {};
        const serving = clean([ss.serving_size_amount, ss.serving_size_unit].filter(x => x !== null && x !== undefined && x !== "").join(" ")) || null;
        items.push({ id, name: clean(f.name), desc: clean(f.description), station: clean(mi.station_name || station) || station,
          serving, category: f.food_category ? clean(f.food_category) : null,
          nutr: { cal:g("calories"), protein:g("g_protein"), carbs:g("g_carbs"), fat:g("g_fat"), fiber:g("g_fiber"), sugar:g("g_sugar"), sodium:g("mg_sodium") },
          labels:[...new Set(labels)], allergens:[...new Set(allergens)], allergenInfo: allergens.length > 0 });
      }
      if (items.length) out.push({ hall: hallId, date: day.date, items });
    }
    if (!out.length) throw new Error("No dishes were found in this JSON. The menu may not be published yet for these dates.");
    return out;
  }
  return parse;
})();
export { parse };

export const weekUrl = (hall, iso, base = process.env.NUTRISLICE_BASE_URL || `https://${DISTRICT}.api.nutrislice.com`) => {
  const h = HALLS[hall]; if (!h) throw new Error("Unknown hall: " + hall);
  const [y, m, d] = iso.split("-");
  return `${base}/menu/api/weeks/school/${h.slug}/menu-type/${h.menuType}/${y}/${m}/${d}/?format=json`;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Fetch one week (the endpoint returns the 7 days around the date). Retries only transient failures (network, 429, 5xx), at most 2 times. */
export async function fetchWeek(hall, iso, { timeoutMs = 12000, retries = 2, backoffMs = 600, fetchImpl = fetch } = {}) {
  const url = weekUrl(hall, iso);
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { signal: ctl.signal, headers: { accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) { last = new Error(`Nutrislice HTTP ${r.status}`); }
      else if (!r.ok) throw Object.assign(new Error(`Nutrislice HTTP ${r.status}`), { fatal: true });
      else {
        const raw = await r.json();
        return parse(raw, hall).map(d => ({ ...d, source: "Nutrislice", sourceUrl: url }));
      }
    } catch (e) { if (e.fatal || /No dishes|doesn't look like/.test(e.message)) throw e; last = e.name === "AbortError" ? new Error("Nutrislice timed out") : e; }
    finally { clearTimeout(t); }
    if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
  }
  throw last;
}
