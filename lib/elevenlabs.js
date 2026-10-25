// ElevenLabs text-to-speech service. Provider-specific code lives only here.
// Docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
import { secret, config } from "./config.js";
import { ApiError, timedFetch } from "./http.js";

/** @returns {Promise<Buffer>} MP3 audio */
export async function synthesize(text) {
  const key = secret("ELEVENLABS_API_KEY"), voice = secret("ELEVENLABS_VOICE_ID");
  if (!key) throw new ApiError(503, "not_configured", "Voice isn't set up yet. Add ELEVENLABS_API_KEY to your .env file and restart the server (see README).");
  if (!voice) throw new ApiError(503, "voice_not_configured", "Voice isn't set up yet. Add ELEVENLABS_VOICE_ID to your .env file and restart the server (see README).");
  const url = `${config.elevenBaseUrl()}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
  const res = await timedFetch(url, { method: "POST", headers: { "content-type": "application/json", "xi-api-key": key, accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: config.elevenModel() }) }, config.timeoutMs(), "ElevenLabs");
  if (!res.ok) {
    if (res.status === 401) throw new ApiError(502, "invalid_credentials", "ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY in your .env file.");
    if (res.status === 404 || res.status === 422) throw new ApiError(502, "voice_not_found", "ElevenLabs couldn't use that voice. Check ELEVENLABS_VOICE_ID and ELEVENLABS_MODEL_ID in your .env file.");
    if (res.status === 429) throw new ApiError(429, "rate_limited", "ElevenLabs is busy or the quota is used up. Try again later.");
    throw new ApiError(502, "upstream_error", "ElevenLabs had a problem. Try again in a moment.");
  }
  return Buffer.from(await res.arrayBuffer());
}
