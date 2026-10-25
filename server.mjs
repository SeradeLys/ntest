// Local server: serves the static site and the /api routes (the same handlers Vercel runs in production).
//   npm run dev     http://localhost:3000
import http from "node:http";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

// Minimal .env loader so no dependency is needed. Real environment variables win over the file.
function loadEnv(file = join(ROOT, ".env")) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1].startsWith("#")) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
// Only these paths are public. Source folders, .env and package files are never served.
const PUBLIC_FILES = new Set(["index.html"]);
const PUBLIC_DIRS = ["data" + sep, "images" + sep];
const ROUTES = new Set(["chat", "tts", "health", "menus", "refresh"]);

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        const name = url.pathname.slice(5).replace(/\/$/, "");
        if (!ROUTES.has(name)) { res.statusCode = 404; res.setHeader("content-type", "application/json"); return res.end('{"error":{"code":"not_found","message":"Unknown API route."}}'); }
        const mod = await import(pathToFileURL(join(ROOT, "api", name + ".js")).href);
        return await mod.default(req, res);
      }
      let rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^\/+/, "");
      rel = normalize(rel);
      const ok = !rel.startsWith("..") && (PUBLIC_FILES.has(rel) || PUBLIC_DIRS.some(d => rel.startsWith(d)));
      const file = join(ROOT, rel);
      if (!ok || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end("Not found"); }
      res.setHeader("content-type", TYPES[extname(file).toLowerCase()] || "application/octet-stream");
      createReadStream(file).pipe(res);
    } catch (e) { console.error("[server]", e && e.message); res.statusCode = 500; res.end("Server error"); }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => {
    console.log(`NutriPlan running at http://localhost:${port}`);
    import("./lib/config.js").then(({ status }) => { const s = status();
      console.log(`  Gemini: ${s.gemini ? "configured" : "NOT configured (set GEMINI_API_KEY in .env)"}`);
      console.log(`  ElevenLabs: ${s.elevenlabs ? "configured" : "NOT configured (set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID)"}`);
      console.log(`  Photon agent: ${s.photon ? "credentials present (run npm run photon)" : "NOT configured (optional, see README)"}`); });
  });
}
