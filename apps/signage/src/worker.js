// njyn Signage: API, media and pairing for the dashboard (/admin/) and the TV
// player (/player/). Static files in public/ are served by Workers Assets; only
// /api/* and /media/* reach this code.

import * as v from './validate.js';

const SESSION_COOKIE = 'signage_session';
const SESSION_TTL_S = 30 * 24 * 3600;
const UNCLAIMED_TTL_MS = 24 * 3600 * 1000;
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const error = (status, message) => json({ error: message }, status);
const now = () => Date.now();
const newId = () => crypto.randomUUID();

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      if (e instanceof v.ValidationError) return error(400, e.message);
      if (e instanceof SyntaxError) return error(400, 'Request body is not valid JSON');
      console.error(e);
      return error(500, 'Something went wrong');
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  const seg = path.split('/').filter(Boolean); // ['api', 'playlists', ':id']

  if (seg[0] === 'media' && seg.length === 2 && (method === 'GET' || method === 'HEAD')) {
    return serveMedia(request, env, seg[1]);
  }
  if (seg[0] !== 'api') return error(404, 'Not found');

  // Player endpoints authenticate with their own device token.
  if (seg[1] === 'player') {
    if (path === '/api/player/register' && method === 'POST') return registerPlayer(request, env);
    if (path === '/api/player/manifest' && method === 'GET') return playerManifest(request, env);
    return error(404, 'Not found');
  }

  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }
  const authed = await isAdmin(request, env);
  if (path === '/api/session') return json({ authed, configured: !!env.ADMIN_PASSWORD });
  if (!authed) return error(401, 'Sign in first');
  // Cookie auth: refuse cross-site writes outright.
  if (method !== 'GET' && !sameOrigin(request, url)) return error(403, 'Cross-site request refused');

  const [, resource, id, action] = seg;
  switch (resource) {
    case 'media':
      if (!id && method === 'GET') return listMedia(env);
      if (!id && method === 'PUT') return uploadMedia(request, env, url);
      if (id && method === 'PATCH') return renameMedia(request, env, id);
      if (id && method === 'DELETE') return deleteMedia(env, id);
      break;
    case 'playlists':
      return crud(request, env, id, {
        table: 'playlists', field: 'items', clean: v.playlistItems,
      });
    case 'layouts':
      return crud(request, env, id, {
        table: 'layouts', field: 'zones', clean: v.layoutZones,
      });
    case 'screens':
      if (!id && method === 'GET') return listScreens(env);
      if (id === 'claim' && method === 'POST') return claimScreen(request, env);
      if (id && action === 'reload' && method === 'POST') return reloadScreen(env, id);
      if (id && !action && method === 'PUT') return updateScreen(request, env, id);
      if (id && !action && method === 'DELETE') return deleteRow(env, 'screens', id);
      break;
  }
  return error(404, 'Not found');
}

// ---------- admin auth ----------

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(data) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time comparison of two equal-format strings.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  return !origin || origin === url.origin;
}

async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const value = cookie(request, SESSION_COOKIE);
  if (!value) return false;
  const [expires, sig] = value.split('.');
  if (!expires || Number(expires) < now() / 1000) return false;
  return safeEqual(sig, await hmac(env.ADMIN_PASSWORD, `session:${expires}`));
}

async function login(request, env) {
  if (!env.ADMIN_PASSWORD) return error(503, 'ADMIN_PASSWORD is not set on the server');
  const { password } = await request.json();
  // Hash both sides so the comparison is constant-time regardless of length.
  if (!safeEqual(await sha256(String(password ?? '')), await sha256(env.ADMIN_PASSWORD))) {
    return error(401, 'Wrong password');
  }
  const expires = Math.floor(now() / 1000) + SESSION_TTL_S;
  const sig = await hmac(env.ADMIN_PASSWORD, `session:${expires}`);
  return json({ ok: true }, 200, {
    'set-cookie': `${SESSION_COOKIE}=${expires}.${sig}; Path=/; Max-Age=${SESSION_TTL_S}; HttpOnly; Secure; SameSite=Strict`,
  });
}

// ---------- media ----------

const mediaRow = (r) => ({
  id: r.id, name: r.name, kind: r.kind, mime: r.mime, size: r.size,
  duration: r.duration_s, createdAt: r.created_at, url: `/media/${r.id}`,
});

async function listMedia(env) {
  const { results } = await env.DB.prepare('SELECT * FROM media ORDER BY created_at DESC').all();
  return json(results.map(mediaRow));
}

// The body is the raw file, streamed straight into R2. The name comes in the
// query string; a video's duration is measured by the dashboard before upload.
async function uploadMedia(request, env, url) {
  const mime = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : null;
  if (!kind) return error(415, 'Only images and videos can be uploaded');
  const size = Number(request.headers.get('content-length'));
  if (!size) return error(411, 'Upload size is missing');
  if (size > MAX_UPLOAD_BYTES) return error(413, 'Files can be at most 500 MB');
  if (!request.body) return error(400, 'The upload is empty');

  const id = newId();
  const fileName = v.name(url.searchParams.get('name') || 'Untitled');
  const durationParam = url.searchParams.get('duration');
  const duration = kind === 'video' && durationParam ? Number(durationParam) || null : null;
  const key = `media/${id}`;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: mime } });
  await env.DB.prepare(
    'INSERT INTO media (id, name, kind, mime, size, r2_key, duration_s, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, fileName, kind, mime, size, key, duration, now()).run();
  const row = await env.DB.prepare('SELECT * FROM media WHERE id = ?').bind(id).first();
  return json(mediaRow(row), 201);
}

async function renameMedia(request, env, id) {
  const body = await request.json();
  const res = await env.DB.prepare('UPDATE media SET name = ? WHERE id = ?').bind(v.name(body.name), id).run();
  if (!res.meta.changes) return error(404, 'Not found');
  return json(mediaRow(await env.DB.prepare('SELECT * FROM media WHERE id = ?').bind(id).first()));
}

async function deleteMedia(env, id) {
  const row = await env.DB.prepare('SELECT r2_key FROM media WHERE id = ?').bind(id).first();
  if (!row) return error(404, 'Not found');
  await env.MEDIA.delete(row.r2_key);
  await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// Media ids are random UUIDs, so URLs are unguessable rather than signed: the
// player's <video> and <img> tags can't send auth headers.
async function serveMedia(request, env, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return error(404, 'Not found');
  const row = await env.DB.prepare('SELECT r2_key FROM media WHERE id = ?').bind(id).first();
  if (!row) return error(404, 'Not found');
  const obj = await env.MEDIA.get(row.r2_key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return error(404, 'Not found');

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  if (!('body' in obj)) return new Response(null, { status: 304, headers }); // onlyIf matched

  let status = 200;
  if (obj.range && request.headers.has('range')) {
    const offset = obj.range.offset ?? (obj.size - obj.range.suffix);
    const length = obj.range.length ?? (obj.size - offset);
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
    status = 206;
  } else {
    headers.set('content-length', String(obj.size));
  }
  return new Response(request.method === 'HEAD' ? null : obj.body, { status, headers });
}

// ---------- playlists and layouts ----------

async function crud(request, env, id, { table, field, clean }) {
  const method = request.method;
  const toJson = (r) => ({ id: r.id, name: r.name, [field]: JSON.parse(r[field]), updatedAt: r.updated_at });
  if (!id && method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY name COLLATE NOCASE`).all();
    return json(results.map(toJson));
  }
  if (!id && method === 'POST') {
    const body = await request.json();
    const row = { id: newId(), name: v.name(body.name), data: JSON.stringify(clean(body[field] ?? defaultFor(field))) };
    await env.DB.prepare(`INSERT INTO ${table} (id, name, ${field}, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(row.id, row.name, row.data, now()).run();
    return json(toJson(await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(row.id).first()), 201);
  }
  if (id && method === 'GET') {
    const r = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
    return r ? json(toJson(r)) : error(404, 'Not found');
  }
  if (id && method === 'PUT') {
    const body = await request.json();
    const res = await env.DB.prepare(`UPDATE ${table} SET name = ?, ${field} = ?, updated_at = ? WHERE id = ?`)
      .bind(v.name(body.name), JSON.stringify(clean(body[field])), now(), id).run();
    if (!res.meta.changes) return error(404, 'Not found');
    return json(toJson(await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first()));
  }
  if (id && method === 'DELETE') return deleteRow(env, table, id);
  return error(404, 'Not found');
}

const defaultFor = (field) => (field === 'zones'
  ? [{ id: 'main', name: 'Main', x: 0, y: 0, w: 100, h: 100, playlistId: null }]
  : []);

async function deleteRow(env, table, id) {
  const res = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
  return res.meta.changes ? json({ ok: true }) : error(404, 'Not found');
}

// ---------- screens ----------

const ONLINE_WINDOW_MS = 2 * 60 * 1000;

const screenRow = (r) => ({
  id: r.id, name: r.name, timezone: r.timezone, defaultLayoutId: r.default_layout_id,
  schedule: JSON.parse(r.schedule), lastSeen: r.last_seen,
  online: !!r.last_seen && now() - r.last_seen < ONLINE_WINDOW_MS,
  player: r.player_info ? JSON.parse(r.player_info) : null,
});

async function listScreens(env) {
  const { results } = await env.DB.prepare('SELECT * FROM screens WHERE claimed = 1 ORDER BY name COLLATE NOCASE').all();
  return json(results.map(screenRow));
}

async function claimScreen(request, env) {
  const body = await request.json();
  const code = String(body.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const screenName = v.name(body.name, 'Screen name');
  const tz = v.timezone(body.timezone);
  const row = await env.DB.prepare('SELECT id FROM screens WHERE pair_code = ? AND claimed = 0').bind(code).first();
  if (!row) return error(404, 'No TV is showing that code. Check the code on the screen and try again.');
  await env.DB.prepare('UPDATE screens SET claimed = 1, pair_code = NULL, name = ?, timezone = ? WHERE id = ?')
    .bind(screenName, tz, row.id).run();
  return json(screenRow(await env.DB.prepare('SELECT * FROM screens WHERE id = ?').bind(row.id).first()), 201);
}

async function updateScreen(request, env, id) {
  const body = await request.json();
  const res = await env.DB.prepare(
    'UPDATE screens SET name = ?, timezone = ?, default_layout_id = ?, schedule = ? WHERE id = ? AND claimed = 1',
  ).bind(
    v.name(body.name, 'Screen name'), v.timezone(body.timezone),
    body.defaultLayoutId || null, JSON.stringify(v.schedule(body.schedule ?? [])), id,
  ).run();
  if (!res.meta.changes) return error(404, 'Not found');
  return json(screenRow(await env.DB.prepare('SELECT * FROM screens WHERE id = ?').bind(id).first()));
}

async function reloadScreen(env, id) {
  const res = await env.DB.prepare('UPDATE screens SET reload_nonce = reload_nonce + 1 WHERE id = ?').bind(id).run();
  return res.meta.changes ? json({ ok: true }) : error(404, 'Not found');
}

// ---------- player ----------

function pairCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join('');
}

async function registerPlayer(request, env) {
  await env.DB.prepare('DELETE FROM screens WHERE claimed = 0 AND created_at < ?').bind(now() - UNCLAIMED_TTL_MS).run();
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const id = newId();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = pairCode();
    try {
      await env.DB.prepare('INSERT INTO screens (id, token_hash, pair_code, created_at) VALUES (?, ?, ?, ?)')
        .bind(id, await sha256(token), code, now()).run();
      return json({ token, code }, 201);
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e; // code collision: try another
    }
  }
  return error(503, 'Could not allocate a pairing code, try again');
}

async function playerScreen(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  return env.DB.prepare('SELECT * FROM screens WHERE token_hash = ?').bind(await sha256(token)).first();
}

// Everything the player needs to run offline: the schedule plus every layout it
// can reach, every playlist those layouts use, and the media in them.
async function playerManifest(request, env) {
  const screen = await playerScreen(request, env);
  if (!screen) return error(401, 'Unknown player; register again');

  const info = request.headers.get('x-player-info');
  await env.DB.prepare('UPDATE screens SET last_seen = ?, player_info = COALESCE(?, player_info) WHERE id = ?')
    .bind(now(), info ? info.slice(0, 500) : null, screen.id).run();

  if (!screen.claimed) return json({ paired: false, code: screen.pair_code });

  const schedule = JSON.parse(screen.schedule);
  const layoutIds = [...new Set([screen.default_layout_id, ...schedule.map((r) => r.layoutId)].filter(Boolean))];
  const layouts = {};
  const playlistIds = new Set();
  for (const r of await selectIn(env, 'layouts', layoutIds)) {
    const zones = JSON.parse(r.zones);
    layouts[r.id] = { name: r.name, zones };
    zones.forEach((z) => z.playlistId && playlistIds.add(z.playlistId));
  }
  const playlists = {};
  const mediaIds = new Set();
  for (const r of await selectIn(env, 'playlists', [...playlistIds])) {
    const items = JSON.parse(r.items);
    playlists[r.id] = { name: r.name, items };
    items.forEach((it) => it.type === 'media' && mediaIds.add(it.mediaId));
  }
  const media = {};
  for (const r of await selectIn(env, 'media', [...mediaIds])) {
    media[r.id] = { kind: r.kind, url: `/media/${r.id}`, duration: r.duration_s, size: r.size };
  }
  // Drop items whose media was deleted, so the player never waits on a 404.
  for (const p of Object.values(playlists)) p.items = p.items.filter((it) => it.type !== 'media' || media[it.mediaId]);

  const body = {
    paired: true,
    screen: { id: screen.id, name: screen.name, timezone: screen.timezone },
    reloadNonce: screen.reload_nonce,
    defaultLayoutId: screen.default_layout_id,
    schedule, layouts, playlists, media,
  };
  body.version = (await sha256(JSON.stringify(body))).slice(0, 16);
  return json(body);
}

async function selectIn(env, table, ids) {
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids).all();
  return results;
}
