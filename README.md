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

## The one CTA (embedded scheduler)
Every "Book a call" button on the site drives to the same place. Until a
scheduler is connected they all fall back to email; connect one and they
scroll to the inline calendar in the `#book` section instead.

Edit `src/config.ts`:

    export const BOOKING_PROVIDER: BookingProvider = "cal";  // or "calendly"
    export const BOOKING_LINK = "njyn/30min";                // <user>/<event>

- **Cal.com** — `BOOKING_LINK` is the event path, e.g. `njyn/30min`
  (from https://cal.com/njyn/30min).
- **Calendly** — same shape, e.g. `njyn/30min`
  (from https://calendly.com/njyn/30min).

A full URL works for either provider; the origin is stripped. `BOOKING_LABEL`
sets the button text, `BOOKING_EMAIL_URL` is the fallback, and
`BOOKING_EMBED_HEIGHT` sizes the calendar box.

The embed is themed to the site palette (dark, gold accent) and its script is
only fetched once the section is near the viewport or someone follows a
`#book` link, so it costs nothing on first paint. If the third party is slow
or blocked, the placeholder stays and offers a direct link to the booking page.

Calendly's background/text colour parameters need a paid Calendly plan; on the
free plan it renders in Calendly's own light theme inside the same frame.

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
