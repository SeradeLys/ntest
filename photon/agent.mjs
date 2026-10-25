// Optional Photon iMessage agent (Spectrum). A separate, long-running Node process, not a website or serverless feature.
// Photon's Spectrum SDK delivers iMessages; it has no website-chat provider, so the website chat stays on Gemini.
// Docs: https://photon.codes/docs/spectrum-ts/introduction
//   cd photon && npm install && cd .. && npm run photon
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers";
import { secret } from "../lib/config.js";
import { generate } from "../lib/gemini.js";
import { buildSystemPrompt } from "../lib/prompt.js";
import { buildContext } from "../lib/menus.js";

const projectId = secret("SPECTRUM_PROJECT_ID"), projectSecret = secret("SPECTRUM_PROJECT_SECRET");
if (!projectId || !projectSecret) { console.error("Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET in .env (see README). The placeholders don't count."); process.exit(1); }
if (!secret("GEMINI_API_KEY")) { console.error("Set GEMINI_API_KEY in .env. The iMessage agent answers with Gemini."); process.exit(1); }

const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
const history = new Map();   // space id -> last turns (in memory only)

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound" || message.content.type !== "text") continue;
  const key = String(space.id ?? "default"), turns = history.get(key) || [];
  turns.push({ role: "user", parts: [{ text: String(message.content.text).slice(0, 2000) }] });
  try {
    await space.responding(async () => {
      const out = await generate({ system: buildSystemPrompt(buildContext(), { tools: false, channel: "imessage" }), contents: turns.slice(-12) });
      turns.push({ role: "model", parts: [{ text: out.text }] });
      await space.send(out.text);
    });
  } catch (e) {
    console.error("[photon] reply failed:", e && e.message);
    try { await space.send("Sorry, I couldn't answer that just now. Try again in a moment."); } catch {}
  }
  history.set(key, turns.slice(-12));
}
process.on("SIGINT", async () => { await app.stop(); process.exit(0); });
