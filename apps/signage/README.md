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

## Set it up from your phone

No computer needed: GitHub does the setup for you. Takes about 10 minutes.

**1. Turn on R2 storage in Cloudflare** (once). In the Cloudflare dashboard open
**R2 Object Storage** and follow the prompt to enable it. The free tier covers
10 GB, but Cloudflare asks for a payment method before enabling R2.

**2. Create an API token.** Cloudflare dashboard → your profile icon → **My Profile**
→ **API Tokens** → **Create Token** → **Create Custom Token**. Give it these
**Account** permissions, all set to **Edit**:

| Permission | Why |
|---|---|
| Workers Scripts | to deploy the Worker |
| D1 | to create the database |
| Workers R2 Storage | to create the media bucket |

Under **Account Resources** pick your account, then **Continue to summary** →
**Create Token**, and copy the token (it is shown only once).

**3. Find your Account ID.** Cloudflare dashboard → **Workers & Pages**: it's in the
right-hand column (or in the address bar, the long code after `dash.cloudflare.com/`).

**4. Add three secrets on GitHub.** Open the repository → **Settings** → **Secrets and
variables** → **Actions** → **New repository secret**, once for each:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | the ID from step 3 |
| `SIGNAGE_ADMIN_PASSWORD` | a password you choose for the dashboard |

**5. Deploy.** Repository → **Actions** → **Deploy signage** → **Run workflow** →
**Run workflow**. After about two minutes it turns green; open the run and its
summary shows your dashboard and TV player addresses.

Run it again any time (after updating the code, or to change the password): it
reuses the same database and media, so nothing is lost.

If it fails, open the red step to see why. The usual causes:
- the token is missing one of the three permissions (step 2);
- R2 isn't enabled yet (step 1);
- the account has no `workers.dev` subdomain yet: open **Workers & Pages** in the
  Cloudflare dashboard once, choose a subdomain if asked, and run the workflow again.

## Set it up from a computer

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
