// The TV player. Registers itself, shows a pairing code until the screen is
// claimed in the dashboard, then plays whatever layout the schedule picks.
// The last manifest is kept in localStorage and media in the service worker's
// cache, so a screen that loses its connection keeps playing.

import { activeLayoutId } from './schedule.js';
import { mountWidget } from './widgets.js';

const POLL_MS = 30_000;
const SCHEDULE_CHECK_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_IMAGE_S = 10;
const FADE_MS = 700;
const DAILY_RELOAD_HOUR = 4; // reload once a day to keep long-running WebViews fresh

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(`signage.${k}`); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`signage.${k}`, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(`signage.${k}`); } catch {} },
};

let manifest = null;
try { manifest = JSON.parse(store.get('manifest')); } catch {}
let shown = { layoutId: null, signature: null, zones: [] };
const startedAt = Date.now();

// ---------- server ----------

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' }); } finally { clearTimeout(t); }
}

async function register() {
  const r = await fetchWithTimeout('/api/player/register', { method: 'POST' });
  if (!r.ok) throw new Error(`register failed: ${r.status}`);
  const { token } = await r.json();
  store.set('token', token);
  return token;
}

const playerInfo = () => JSON.stringify({
  ua: navigator.userAgent.slice(0, 200), w: screen.width, h: screen.height,
});

async function poll(retried = false) {
  try {
    const token = store.get('token') || await register();
    const r = await fetchWithTimeout('/api/player/manifest', {
      headers: { authorization: `Bearer ${token}`, 'x-player-info': playerInfo() },
    });
    if (r.status === 401 && !retried) {
      // The screen was deleted in the dashboard (or never existed): start over.
      store.del('token'); store.del('manifest'); store.del('reloadNonce');
      return poll(true);
    }
    if (!r.ok) throw new Error(`manifest failed: ${r.status}`);
    setStatus(null);
    applyManifest(await r.json());
  } catch (e) {
    console.warn(e);
    setStatus(manifest ? 'Offline · playing saved content' : 'Can’t reach the server · retrying');
  }
}

function applyManifest(m) {
  if (!m.paired) {
    manifest = null;
    store.del('manifest');
    stopZones();
    $('idle').hidden = true;
    $('pair-code').textContent = m.code;
    $('pair-host').textContent = location.host;
    $('pairing').hidden = false;
    return;
  }
  $('pairing').hidden = true;

  const lastNonce = store.get('reloadNonce');
  store.set('reloadNonce', String(m.reloadNonce));
  if (lastNonce !== null && Number(lastNonce) !== m.reloadNonce) { location.reload(); return; }

  if (manifest?.version === m.version) return;
  manifest = m;
  store.set('manifest', JSON.stringify(m));
  syncMediaCache(m);
  render();
}

function syncMediaCache(m) {
  if (!('serviceWorker' in navigator)) return;
  const urls = Object.values(m.media).map((x) => x.url);
  navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: 'sync-media', urls }));
}

// ---------- layout ----------

// Everything that affects what a layout looks like; when it is unchanged a new
// manifest doesn't restart playback.
function layoutSignature(m, layoutId) {
  const layout = m.layouts[layoutId];
  const playlists = layout.zones.map((z) => m.playlists[z.playlistId] || null);
  const media = playlists.flatMap((p) => p?.items || []).filter((it) => it.type === 'media').map((it) => m.media[it.mediaId]);
  return JSON.stringify([layout, playlists, media, m.screen.timezone]);
}

function render() {
  if (!manifest) return;
  const layoutId = activeLayoutId(manifest);
  const signature = layoutId ? layoutSignature(manifest, layoutId) : null;
  if (layoutId === shown.layoutId && signature === shown.signature) return;

  stopZones();
  shown = { layoutId, signature, zones: [] };
  $('idle').hidden = !!layoutId;
  $('idle-name').textContent = manifest.screen.name;
  if (!layoutId) return;

  const stage = $('stage');
  for (const zone of manifest.layouts[layoutId].zones) {
    const el = document.createElement('div');
    el.className = 'zone';
    Object.assign(el.style, { left: `${zone.x}%`, top: `${zone.y}%`, width: `${zone.w}%`, height: `${zone.h}%` });
    stage.append(el);
    const player = new ZonePlayer(el, manifest.playlists[zone.playlistId], manifest);
    shown.zones.push(player);
    player.start();
  }
  sizeZones();
}

function stopZones() {
  shown.zones.forEach((z) => z.stop());
  shown = { layoutId: null, signature: null, zones: [] };
  $('stage').replaceChildren();
}

function sizeZones() {
  for (const z of document.querySelectorAll('.zone')) {
    z.style.setProperty('--zh', `${z.clientHeight}px`);
    z.style.setProperty('--zw', `${z.clientWidth}px`);
  }
}

// ---------- playback ----------

function waitFor(el, event, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timed out`)), ms);
    el.addEventListener(event, () => { clearTimeout(t); resolve(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(t); reject(new Error(`${event} failed`)); }, { once: true });
  });
}

// Inside the Android TV app autoplay with sound is allowed; a desktop browser
// may refuse, in which case play muted rather than not at all.
async function playVideo(video) {
  try { await video.play(); } catch { video.muted = true; await video.play(); }
}

class ZonePlayer {
  constructor(el, playlist, m) {
    this.el = el;
    this.items = playlist?.items || [];
    this.m = m;
    this.index = -1;
    this.seq = 0;
    this.timer = null;
    this.current = null; // { slide, cleanup }
  }

  start() { if (this.items.length) this.next(); }

  stop() {
    this.seq++;
    clearTimeout(this.timer);
    this.current?.cleanup();
    this.current = null;
  }

  async next() {
    const seq = ++this.seq;
    clearTimeout(this.timer);
    this.index = (this.index + 1) % this.items.length;
    const item = this.items[this.index];
    const single = this.items.length === 1;

    const slide = document.createElement('div');
    slide.className = 'slide';
    this.el.append(slide);
    let cleanup = () => {};
    let durationMs = (item.duration ?? DEFAULT_IMAGE_S) * 1000;

    try {
      if (item.type === 'media') {
        const media = this.m.media[item.mediaId];
        if (media.kind === 'image') {
          const img = new Image();
          img.decoding = 'async';
          img.src = media.url;
          slide.append(img);
          await waitFor(img, 'load', 20_000);
        } else {
          const video = document.createElement('video');
          video.src = media.url;
          video.playsInline = true;
          video.preload = 'auto';
          // A fixed duration loops the video for that long; no duration plays it once.
          video.loop = single || item.duration != null;
          slide.append(video);
          await waitFor(video, 'canplay', 30_000);
          if (seq !== this.seq) { slide.remove(); return; }
          await playVideo(video);
          if (item.duration == null) {
            durationMs = Infinity;
            if (!single) video.addEventListener('ended', () => seq === this.seq && this.next(), { once: true });
          }
          video.addEventListener('error', () => seq === this.seq && this.next(), { once: true });
          cleanup = () => { video.pause(); video.removeAttribute('src'); video.load(); };
        }
      } else if (item.type === 'web') {
        const frame = document.createElement('iframe');
        frame.src = item.url;
        frame.allow = 'autoplay; fullscreen';
        frame.referrerPolicy = 'no-referrer';
        slide.append(frame);
        await waitFor(frame, 'load', 15_000).catch(() => {}); // show it even if load never fires
      } else if (item.type === 'widget') {
        const w = document.createElement('div');
        slide.append(w);
        cleanup = mountWidget(item.widget, w, item.options, { timezone: this.m.screen.timezone });
      }
    } catch (e) {
      console.warn('Skipping item', item, e);
      cleanup();
      slide.remove();
      if (seq === this.seq && !single) this.timer = setTimeout(() => this.next(), 1000);
      else if (seq === this.seq) this.timer = setTimeout(() => { this.index = -1; this.next(); }, 30_000);
      return;
    }
    if (seq !== this.seq) { cleanup(); slide.remove(); return; }

    // Fade the new slide in over the old one, then drop the old one.
    const previous = this.current;
    this.current = { slide, cleanup };
    requestAnimationFrame(() => slide.classList.add('shown'));
    if (previous) setTimeout(() => { previous.cleanup(); previous.slide.remove(); }, FADE_MS);

    if (!single && Number.isFinite(durationMs)) this.timer = setTimeout(() => this.next(), durationMs);
  }
}

// ---------- chrome ----------

function setStatus(text) {
  $('status').hidden = !text;
  $('status').textContent = text || '';
}

function tickIdleClock() {
  const tz = manifest?.screen?.timezone;
  $('idle-time').textContent = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date());
}

function maybeDailyReload() {
  const uptimeH = (Date.now() - startedAt) / 3_600_000;
  if (uptimeH > 12 && new Date().getHours() === DAILY_RELOAD_HOUR && navigator.onLine) location.reload();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn(e));
addEventListener('resize', sizeZones);

if (manifest) { render(); syncMediaCache(manifest); } // play saved content before the network answers
poll();
setInterval(() => manifest && syncMediaCache(manifest), 3_600_000); // retry downloads that failed
setInterval(poll, POLL_MS);
setInterval(() => { render(); maybeDailyReload(); }, SCHEDULE_CHECK_MS);
setInterval(tickIdleClock, 1000);
tickIdleClock();
