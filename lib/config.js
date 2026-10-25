// Server-side configuration. Secrets are read from process.env only and never sent to the browser.
const PLACEHOLDER = /^REPLACE_WITH_/;

/** Returns the trimmed value of a secret env var, or null if it is missing or still the .env.example placeholder. */
export function secret(name) {
  const v = (process.env[name] || "").trim();
  return v && !PLACEHOLDER.test(v) ? v : null;
}

const plain = (name, fallback) => (process.env[name] || "").trim() || fallback;

export const config = {
  geminiModel: () => plain("GEMINI_MODEL", "gemini-3.8-flash"),
  geminiBaseUrl: () => plain("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"),
  elevenModel: () => plain("ELEVENLABS_MODEL_ID", "eleven_v4"),
  elevenBaseUrl: () => plain("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io"),
  timeoutMs: () => Number(plain("API_TIMEOUT_MS", "15000")) || 15000,          // per attempt (time to first response, and max silence while streaming)
  budgetMs: () => Number(plain("API_BUDGET_MS", "24000")) || 24000,           // total across retries; stays under the 30s Vercel function limit
  geminiThinking: () => plain("GEMINI_THINKING_LEVEL", ""),                    // optional: minimal | low | medium | high
};

/** Which integrations are configured. Booleans only, safe to expose. */
export function status() {
  return {
    gemini: !!secret("GEMINI_API_KEY"),
    elevenlabs: !!secret("ELEVENLABS_API_KEY") && !!secret("ELEVENLABS_VOICE_ID"),
    photon: !!secret("SPECTRUM_PROJECT_ID") && !!secret("SPECTRUM_PROJECT_SECRET"),
    menuStore: !!(secret("UPSTASH_REDIS_REST_URL") || secret("KV_REST_API_URL")) && !!(secret("UPSTASH_REDIS_REST_TOKEN") || secret("KV_REST_API_TOKEN")),
    cron: !!secret("CRON_SECRET"),
  };
}
