# njyn.ai

Astro + Tailwind CSS v4, static, deployed to Cloudflare Pages.
Includes a live "Ask the engine" AI demo powered by the Anthropic API.

## Develop
    npm install
    npm run dev

## Build
    npm run build

## Deploy to Cloudflare Pages
1. Push this folder to a Git repo.
2. Cloudflare dashboard: Workers & Pages > Create > Pages > Connect to Git.
3. Framework preset: Astro. Build command: npm run build. Output directory: dist.
4. The functions/ folder deploys automatically as Pages Functions.
5. Add custom domain njyn.ai.

## Enable the live AI demo
1. Get an API key at console.anthropic.com (pay as you go).
2. Pages project > Settings > Variables and Secrets > add Secret:
   ANTHROPIC_API_KEY = sk-ant-...
3. Redeploy. The demo at #demo now runs real prompts through Claude
   with live web search. Without the key it shows a labeled sample output.

Cost control: responses are capped at 700 tokens and 3 web searches per
prompt. A typical demo query costs a few cents. For a public endpoint,
add a rate-limiting rule (Security > WAF > Rate limiting rules) on /api/ask
and optionally Cloudflare Turnstile on the form.

## The one CTA
Edit src/config.ts to point BOOKING_URL at your booking link.

## apps/
Product code that ships alongside the site. See [apps/README.md](apps/README.md).

- `apps/desktop` — njyn Meeting Notes, an Electron tray app for Windows
  (also macOS and Linux). Records system audio + mic, transcribes with
  whisper.cpp locally or a hosted Whisper, and writes a summarised markdown
  note to `~/MeetingNotes`.
- `apps/android` — the same app for Android 10+, driven from an ongoing
  notification instead of a tray icon.

Neither has accounts, cloud storage or telemetry, and neither is part of the
Astro build.
