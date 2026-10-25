// POST /api/tts  { text } -> audio/mpeg (ElevenLabs). Only called when the user turns voice chat on or presses Listen.
import { ApiError, guard, rateLimit, readJson, sendError } from "../lib/http.js";
import { synthesize } from "../lib/elevenlabs.js";

const MAX_CHARS = 2500;

export default async function handler(req, res) {
  try {
    guard(req, res); rateLimit(req, "tts", 20);
    const body = await readJson(req, 50_000);
    const text = typeof body.text === "string" ? body.text.replace(/[*•#]/g, "").replace(/\s+\n/g, "\n").trim() : "";
    if (!text) throw new ApiError(400, "bad_request", "There is no text to speak.");
    const audio = await synthesize(text.slice(0, MAX_CHARS));
    res.statusCode = 200;
    res.setHeader("content-type", "audio/mpeg"); res.setHeader("content-length", audio.length); res.setHeader("cache-control", "no-store");
    res.end(audio);
  } catch (e) { sendError(res, e); }
}
