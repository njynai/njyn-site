# njyn Signage

Your own digital signage, in the spirit of Yodeck: upload images and videos,
arrange them into playlists, split screens into zones, schedule what plays when,
and push it all to TVs running the [TV player app](../tv-player/).

It runs entirely on your Cloudflare account: one Worker serves the dashboard,
the API and the player page; a D1 database holds the settings; an R2 bucket
holds the media. For a handful of screens it fits in Cloudflare's free tier.

| Page | Address | Who uses it |
|---|---|---|
| Dashboard | `https://<your-worker>/admin/` | You, signed in with a password |
| Player | `https://<your-worker>/player/` | The TVs |

## What it does

- **Media**: drag-and-drop images and videos (up to 500 MB each), streamed straight to R2.
- **Playlists**: images, videos, web pages and widgets in order, each with its own duration.
  A video with no duration plays to the end.
- **Widgets**: clock, weather (no API key needed), scrolling ticker, and a text slide.
- **Layouts**: split the screen into up to 8 zones, each playing its own playlist.
  Presets for full screen, main + sidebar, main + ticker, both, split, and a 2 × 2 grid.
- **Schedules**: per screen, e.g. *weekdays 11:30–14:00 show the lunch layout*. Rules
  can run past midnight; otherwise the screen's default layout plays.
- **Pairing**: a new TV shows a 6-character code; type it in under **Screens → Add screen**.
- **Offline playback**: each TV downloads its media and keeps the last schedule, so it keeps
  playing through an internet outage and catches up when it's back.
- **Remote control**: see which screens are online, and reload a player from the dashboard.

## Set it up

You need a Cloudflare account and Node.js 20 or newer.

```bash
cd apps/signage
npm install
npx wrangler login

# 1. Create the database and paste the printed database_id into wrangler.jsonc
npx wrangler d1 create signage

# 2. Create the media bucket
npx wrangler r2 bucket create njyn-signage-media

# 3. Create the tables
npm run db:migrate

# 4. Choose the dashboard password
npx wrangler secret put ADMIN_PASSWORD

# 5. Deploy
npm run deploy
```

Wrangler prints the Worker's address, e.g. `https://njyn-signage.<you>.workers.dev`.
Open `/admin/` there and sign in. To use your own domain (say `signage.njyn.ai`),
add it under the Worker's **Settings → Domains & Routes** in the Cloudflare dashboard.

Then on each TV install the [player app](../tv-player/), enter
`https://<your-worker>/player/` once, and pair it with the code it shows.

### First content in five minutes

1. **Media**: upload a few images or a video.
2. **Playlists → New playlist**: add them; set how long each image shows.
3. **Layouts → New layout**: keep *Fullscreen* (or pick a preset) and choose the playlist for each zone.
4. **Screens**: open the TV, set the layout as its **Default layout**, and **Save**.
   The TV picks up the change within 30 seconds.

## Develop locally

```bash
cp .dev.vars.example .dev.vars        # sets ADMIN_PASSWORD for local use
npm run db:migrate:local
npm run dev                            # http://localhost:8787/admin/
npm test                               # schedule and validation tests
```

`wrangler dev` emulates D1 and R2 on disk under `.wrangler/`, so nothing touches
your real account. Open `http://localhost:8787/player/` in a second browser
window to act as a TV.

## How it fits together

```
 Dashboard (/admin) ──cookie──▶ Worker API ──▶ D1: screens, playlists, layouts, media records
                                    │
                                    └──────▶ R2: the media files
 TV app ─▶ Player (/player) ──token──▶ /api/player/manifest   (every 30 s)
                     │
                     └─ service worker caches /media/* for offline playback
```

- A player registers once and gets a secret device token plus a pairing code. Until the
  screen is claimed, the manifest just returns the code.
- The manifest holds the screen's schedule and every layout, playlist and media file it can
  reach. The player picks the layout itself, in the screen's time zone, every 15 seconds, so
  schedules keep working offline.
- When the manifest changes, the player restarts playback only if what's on screen changed,
  and its service worker downloads new media and deletes media no longer used.

## Good to know

- **Video formats**: MP4 (H.264 + AAC) plays on every Android TV and Fire TV device. Keep videos
  at 1080p unless every TV is 4K and the box can decode it.
- **Media links aren't secret-protected**: TVs fetch media at `/media/<random id>`. The id is an
  unguessable UUID, but anyone given that link can view the file. Don't upload anything confidential.
- **Web pages**: many sites forbid being shown inside another page (Google, most news sites). Those
  show as blank. Google Slides works through *File → Share → Publish to web → Embed*.
- **Weather** comes from [Open-Meteo](https://open-meteo.com), free for non-commercial use. A
  commercial deployment needs their paid plan.
- **One password**: the dashboard has a single admin password, not user accounts. For several
  people, put the Worker behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
  so each signs in with their own email.
