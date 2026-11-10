# njyn.ai · NJYN Inc.

Astro + Tailwind CSS v4, static, deployed to Cloudflare Pages.

## Pages
- `/`        NJYN Inc. (parent): divisions, company, contact
- `/studio`  NJYN Studio (games): boot sequence reel, title in development, principles
- `/ai`      NJYN AI (business): live "Ask the engine" demo, system, process, team, pricing CTA

## Live demo
`functions/api/ask.js` is a Pages Function holding the Anthropic key server side.
Cloudflare: Settings > Variables and Secrets > `ANTHROPIC_API_KEY` (Secret).

## Edit points
- `src/config.ts`  contact email and the Book a call link (swap in Cal.com / Calendly)
- `src/components/Mark.astro`  the NJYN mark (geometry in `src/mark-paths.json`)
- `public/media/`  Studio intro video and poster

## Develop / build
    npm install
    npm run dev
    npm run build    # output: dist/
