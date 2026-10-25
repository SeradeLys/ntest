# Wolfie Butler (NutriPlan) — code export

Stony Brook dining-hall meal planner: Nutrislice menus, nutrition estimates, meal planner with a full-day plan, favourites, recipes with Medal clip links, and the Wolfie Butler chat.

## Files
- `index.html` — standalone page. Open it in any browser or host it on any static host (GitHub Pages, Netlify, Vercel).
- `wolfie-butler-artifact.html` — the exact source published as the claude.ai artifact (no doctype/head; claude.ai adds those).
- `data/menus/` — the local menu database: one Nutrislice-format JSON file per hall and date (e.g. `west--2026-10-23.json`), plus `manifest.json` listing them.
- `tools/build-menu-manifest.py` — rebuilds `data/menus/manifest.json` after you add or remove menu files.
- `data/recipes.json` — the six starter recipes.

## Local menu database
Drop menu files into `data/menus/` (each: `{"hall":"west"|"east","date":"YYYY-MM-DD","items":[…]}`), then run `python3 tools/build-menu-manifest.py`. The app loads every listed file on start. These files win for the hall and date they cover; menus imported inside the app still appear for all other dates. The page opens on today's menu, or the next available date if today has none (the latest one if all are in the past). Serve the folder over http(s), because `fetch()` is blocked on `file://`.

## Running outside claude.ai
Everything runs in one file, with no build step. Outside claude.ai, the claude.ai-only features fall back automatically:
- **Cloud database** (shared menus/recipes, private profile/plan/favourites) → saved in the browser's localStorage instead. Use **Import menu** to load Nutrislice JSON.
- **Wolfie Butler chat** runs on the viewer's Claude account through the claude.ai runtime, so it's unavailable outside claude.ai. That's the slot to connect your own backend (Gemini, Photon) — see `AgentService.send` in the script.
- **Photo/icon uploads** need the claude.ai assets store. Set image paths directly in `CONFIG` instead.

## Where to change things
At the top of the `<script>`, in `CONFIG`:
- `hallImages` — West/East dining hall image paths.
- `chatIcon` — chatbot icon path.
- `activity`, `carbPct`, `fatPerKg`, `fiberRef`, `safety`, `dayShares`, `calTolerance` — nutrition and planning settings.
- `healthResources` — health links.

Code layout inside the script: `NutritionService` (BMR/TDEE/targets, meal totals, goal safety) · `MenuProvider` (Nutrislice parser) · `MealPlanService` · `DayPlanService` (±50 kcal day plan) · `RecommendationService` · `MedalProvider` · `Store` (persistence) · views and event handlers.

## Nutrislice API
`https://stonybrook.api.nutrislice.com/menu/api/weeks/school/{west-side-dining|east-side-dining}/menu-type/{todays-dine-in-specials-wsd|todays-dine-in-specials-esd}/YYYY/MM/DD/?format=json`
A browser page can't fetch this directly (cross-origin), so either paste the JSON into **Import menu** or fetch it from a small server.

Nutrition values are estimates, not medical advice.

## Support chat APIs (Gemini, ElevenLabs, Photon)

The Wolfie Butler chat talks only to this site's own `/api` routes. Provider keys stay on the server (`lib/`, `api/`) and are never sent to the browser.

| Piece | What it does | Where |
|---|---|---|
| Gemini | Writes the chat replies. The system prompt and menu rules live on the server. | `api/chat.js`, `lib/gemini.js`, `lib/prompt.js` |
| ElevenLabs | Turns an assistant reply into speech, only when voice replies are ON and the user plays it. | `api/tts.js`, `lib/elevenlabs.js` |
| Photon (Spectrum) | Optional, separate iMessage agent. Not used by the website chat. | `photon/agent.mjs` |

### Setup
1. Node 20 or newer. There are no runtime dependencies for the website.
2. `cp .env.example .env`, then replace each `REPLACE_WITH_...` value. Never commit `.env` (it is in `.gitignore`).
3. `npm run dev`, open http://localhost:3000. The terminal prints which integrations are configured.
4. `npm test` runs the API tests against mock Gemini and ElevenLabs servers (no keys needed).

| Variable | Needed for | Notes |
|---|---|---|
| `GEMINI_API_KEY` | chat | `REPLACE_WITH_YOUR_GEMINI_API_KEY` is treated as "not set" and is never sent to Google |
| `GEMINI_MODEL` | optional | default `gemini-3.8-flash`; change it if your key can't use it |
| `ELEVENLABS_API_KEY` | voice | `REPLACE_WITH_YOUR_ELEVENLABS_API_KEY` |
| `ELEVENLABS_VOICE_ID` | voice | `REPLACE_WITH_YOUR_ELEVENLABS_VOICE_ID`, a voice your account can use |
| `ELEVENLABS_MODEL_ID` | optional | default `eleven_v4` |
| `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | Photon agent only | Photon uses a project id and secret, not a single `PHOTON_API_KEY` |

### Voice replies
The speaker button in the chat header turns voice replies on or off. Turning it ON does not call ElevenLabs. With it on, each new reply is spoken after the text appears, and every reply gets Listen, Pause/Resume and Stop buttons. One audio player is shared, so replies never overlap. Turning voice OFF stops playback at once and discards the in-memory audio. Only the assistant's reply is sent to ElevenLabs, never the student's message. If speech fails the text stays and a "Try speech again" button appears.

### Deploy on Vercel
Import the repo. The `api/*.js` files become serverless functions and `index.html` plus `data/` are served statically. Add `GEMINI_API_KEY`, `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` under Project Settings, Environment Variables. The rate limit is in memory per instance, so add a shared limiter (for example Vercel KV) if you expect heavy traffic. Production start elsewhere: `npm start`.

### Photon iMessage agent
Photon's Spectrum SDK delivers messages over iMessage and other platforms. It has no website-chat provider, so the web chat stays on Gemini and the iMessage agent is its own process. It answers with the same Gemini prompt and the menus in `data/menus`, but it doesn't know a student's profile or plan. Because it is a long-running process it can't run on Vercel functions. Run it on any always-on host:

    cd photon && npm install && cd ..
    npm run photon

It exits with a clear message if the Photon credentials or `GEMINI_API_KEY` are missing.

### Not verified without real credentials
- The default model ids (`gemini-3.8-flash`, `eleven_v4`) and the `x-goog-api-key` header were not confirmed against live services. Override the models in `.env` if needed.
- The Photon agent's SDK exports (`Spectrum`, `imessage`) were confirmed by installing `spectrum-ts`, but it has not been run against a real Photon project.
- The Claude-hosted preview copy (`wolfie-butler-artifact.html`) can't reach this backend and keeps its original in-Claude chat.

## Daily cloud menus (Nutrislice)
Menus are fetched on the server, stored in Upstash Redis, and read by the site from `/api/menus`. The browser never calls Nutrislice for this and page loads never wait on it.

- `lib/nutrislice.js`: the Stony Brook endpoints (`stonybrook.api.nutrislice.com`, `west-side-dining` / `todays-dine-in-specials-wsd`, `east-side-dining` / `todays-dine-in-specials-esd`), the parser (same one the site uses for imported JSON), a 12s timeout and at most 2 retries for network, 429 and 5xx errors.
- `lib/refresh.js`: fetches this week and next week for each hall, upserts by key `menu:{hall}:{date}` (reruns never duplicate), records `lastSuccess`. If any required fetch fails the run is reported as failed, `lastSuccess` doesn't move, and the previous snapshot keeps being served. A lock stops overlapping runs.
- `api/refresh.js`: needs `Authorization: Bearer $CRON_SECRET`. `vercel.json` schedules it daily at **09:00 UTC** (5:00 AM EDT, 4:00 AM EST). Vercel crons run only on production deployments and, on the Hobby plan, may fire any time within that hour.
- `api/menus.js`: returns stored menus plus `meta.stale` (true when the last successful refresh is over 36 hours old).
- Meal plans store copies of their foods, so refreshing never changes a saved plan, favorites or recipes, which live elsewhere.
- Fallback: if the database isn't connected or `/api/menus` fails, the site uses `data/menus/*.json` as before. Keep those files until you've confirmed a cloud refresh in the logs.

Set up: Vercel project, Storage, add Upstash Redis (creates the REST variables), add `CRON_SECRET`, redeploy, then trigger once: `curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-SITE/api/refresh`.

## Chat speed and reliability
- Replies stream: text appears as Gemini produces it. If streaming isn't possible for a step (a tool call), the app shows "Thinking…".
- Greetings and thanks send no menu data. Food questions send the selected hall's menu; the other hall is sent only if the message mentions it (east, west, both, compare).
- Each Gemini call has a 15s timeout (and 15s max silence while streaming) and at most 2 retries, only for network errors, timeouts, 429 and 5xx. 400, 401, 403 and 404 are never retried. The whole call stops by 24s. The browser gives up at 45s.
- The server logs one line per step (`[gemini] ... headersMs / firstTextMs / totalMs`, `[chat] ... totalMs`) with no prompts, answers or keys. In Vercel see Logs for the project.
- If replies are still slow, check `firstTextMs` in the logs. A high value with a small `promptChars` usually means the model is spending time thinking: set `GEMINI_THINKING_LEVEL=low` or choose a faster `GEMINI_MODEL`.

## Replacing the logo
Put your image at `images/logo.png` (create the `images` folder next to `index.html`), or change `LOGO_SRC` near the top of the script in `index.html` (search for `const LOGO_SRC`). It is shown at 34×34, scaled to fit without cropping. If the file is missing the leaf icon stays.
