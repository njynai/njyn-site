// Signage dashboard: a small hash-routed single page app with no build step.

const app = document.getElementById('app');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WIDGET_LABELS = { clock: 'Clock', weather: 'Weather', ticker: 'Ticker', text: 'Text' };
const PRESETS = {
  'Fullscreen': [['Main', 0, 0, 100, 100]],
  'Main + sidebar': [['Main', 0, 0, 75, 100], ['Sidebar', 75, 0, 25, 100]],
  'Main + ticker': [['Main', 0, 0, 100, 90], ['Ticker', 0, 90, 100, 10]],
  'Main + sidebar + ticker': [['Main', 0, 0, 75, 90], ['Sidebar', 75, 0, 25, 90], ['Ticker', 0, 90, 100, 10]],
  'Split': [['Left', 0, 0, 50, 100], ['Right', 50, 0, 50, 100]],
  '2 × 2 grid': [['Top left', 0, 0, 50, 50], ['Top right', 50, 0, 50, 50], ['Bottom left', 0, 50, 50, 50], ['Bottom right', 50, 50, 50, 50]],
};

// ---------- helpers ----------

// h('div', { class: 'x', onclick: fn }, 'text', child) — never uses innerHTML,
// so names typed by users can't inject markup.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, val] of Object.entries(attrs || {})) {
    if (val == null || val === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), val);
    else if (k === 'class') el.className = val;
    else if (k === 'style' && typeof val === 'object') Object.assign(el.style, val);
    else if (k in el && k !== 'list' && typeof val !== 'string') el[k] = val;
    else if (k === 'value' || k === 'checked') el[k] = val;
    else el.setAttribute(k, val === true ? '' : val);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

class ApiError extends Error {}

async function api(method, path, body) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') { showLogin(); throw new ApiError('Signed out'); }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = isError ? 'toast error' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2500);
}

// Runs an async action, reporting failures instead of throwing.
async function attempt(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    if (!(e instanceof ApiError && e.message === 'Signed out')) toast(e.message, true);
    return undefined;
  }
}

function dialog(title, body, { ok = 'Save', danger = false } = {}) {
  return new Promise((resolve) => {
    const form = h('form', { method: 'dialog', class: 'stack' },
      h('h2', {}, title), body,
      h('div', { class: 'row end' },
        h('button', { type: 'button', onclick: () => { d.close(); } }, 'Cancel'),
        h('button', { class: danger ? 'danger' : 'primary', value: 'ok' }, ok)));
    const d = h('dialog', {}, form);
    d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); });
    document.body.append(d);
    d.showModal();
  });
}

const confirmDelete = (what) => dialog(`Delete ${what}?`, h('p', {}, 'This can’t be undone.'), { ok: 'Delete', danger: true });

function field(labelText, input) {
  return h('div', { class: 'field' }, h('label', {}, labelText), input);
}

function ago(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const bytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`);
const secs = (s) => (s == null ? '' : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function timezoneSelect(value) {
  const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [value];
  if (!zones.includes(value)) zones.unshift(value);
  return h('select', {}, zones.map((z) => h('option', { value: z, selected: z === value }, z)));
}

function optionsFor(items, selected, emptyLabel) {
  return [
    emptyLabel != null && h('option', { value: '' }, emptyLabel),
    ...items.map((x) => h('option', { value: x.id, selected: x.id === selected }, x.name)),
  ];
}

function mediaThumb(m, cls = 'thumb') {
  return m.kind === 'video'
    ? h('video', { class: cls, src: `${m.url}#t=0.5`, muted: true, preload: 'metadata', playsInline: true })
    : h('img', { class: cls, src: m.url, alt: '', loading: 'lazy' });
}

// ---------- routing ----------

async function route() {
  const [tab = 'screens', id] = location.hash.replace(/^#\/?/, '').split('/');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  app.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  const views = { screens: id ? screenEditor : screensView, media: mediaView, playlists: id ? playlistEditor : playlistsView, layouts: id ? layoutEditor : layoutsView };
  await attempt(() => (views[tab] || screensView)(id));
}

async function start() {
  const s = await fetch('/api/session').then((r) => r.json()).catch(() => ({}));
  if (!s.authed) return showLogin(s.configured === false);
  document.getElementById('nav').hidden = false;
  document.getElementById('logout').hidden = false;
  addEventListener('hashchange', route);
  route();
}

function showLogin(notConfigured = false) {
  document.getElementById('nav').hidden = true;
  document.getElementById('logout').hidden = true;
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, autofocus: true });
  const form = h('form', { class: 'card stack login', onsubmit: async (e) => {
    e.preventDefault();
    const ok = await attempt(() => api('POST', 'login', { password: pw.value }));
    if (ok) location.reload();
  } },
  h('h1', {}, 'Sign in'),
  notConfigured
    ? h('p', { class: 'muted' }, 'Set the ADMIN_PASSWORD secret on the Worker first (see the README).')
    : null,
  field('Password', pw),
  h('button', { class: 'primary' }, 'Sign in'));
  app.replaceChildren(form);
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', 'logout');
  location.reload();
});

// ---------- screens ----------

async function screensView() {
  const [screens, layouts] = await Promise.all([api('GET', 'screens'), api('GET', 'layouts')]);
  const layoutName = (id) => layouts.find((l) => l.id === id)?.name;
  app.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Screens'), h('button', { class: 'primary', onclick: addScreen }, '+ Add screen')),
    screens.length
      ? h('div', { class: 'grid' }, screens.map((s) => h('a', { class: 'card stack', href: `#/screens/${s.id}`, style: { textDecoration: 'none', color: 'inherit' } },
        h('div', { class: 'row' }, h('span', { class: `dot ${s.online ? 'on' : ''}` }), h('strong', {}, s.name)),
        h('p', { class: 'muted small' }, s.online ? 'Online' : `Offline · last seen ${ago(s.lastSeen)}`),
        h('p', { class: 'small' }, `Default: ${layoutName(s.defaultLayoutId) || 'nothing'}`,
          s.schedule.length ? ` · ${s.schedule.length} schedule rule${s.schedule.length > 1 ? 's' : ''}` : ''))))
      : h('div', { class: 'card empty stack' },
        h('p', {}, 'No screens yet.'),
        h('p', { class: 'small' }, 'Install the TV app (or open ', h('code', {}, `${location.origin}/player/`),
          ' in the TV’s browser). It shows a 6-letter code; choose Add screen and type it in.')),
  );
}

async function addScreen() {
  const code = h('input', { required: true, maxlength: 6, placeholder: 'ABC123', autocapitalize: 'characters', style: { textTransform: 'uppercase', letterSpacing: '.15em' } });
  const name = h('input', { required: true, placeholder: 'Reception TV' });
  const tz = timezoneSelect(browserTz());
  const ok = await dialog('Add screen', h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'Enter the code shown on the TV.'),
    field('Pairing code', code), field('Name', name), field('Time zone', tz)), { ok: 'Add screen' });
  if (!ok) return;
  const s = await attempt(() => api('POST', 'screens/claim', { code: code.value, name: name.value, timezone: tz.value }), 'Screen added');
  if (s) location.hash = `#/screens/${s.id}`;
}

async function screenEditor(id) {
  const [screens, layouts] = await Promise.all([api('GET', 'screens'), api('GET', 'layouts')]);
  const s = screens.find((x) => x.id === id);
  if (!s) { location.hash = '#/screens'; return; }

  const name = h('input', { value: s.name });
  const tz = timezoneSelect(s.timezone);
  const def = h('select', {}, optionsFor(layouts, s.defaultLayoutId, '— Nothing (idle screen) —'));
  const rulesEl = h('div', {});
  const rules = s.schedule.map((r) => ({ ...r }));

  function drawRules() {
    rulesEl.replaceChildren(...rules.map((r, i) => h('div', { class: 'rule' },
      field('Days', h('div', { class: 'days' }, DAYS.map((d, n) => h('label', {},
        h('input', { type: 'checkbox', checked: r.days.includes(n), onchange: (e) => {
          r.days = e.target.checked ? [...r.days, n].sort() : r.days.filter((x) => x !== n);
        } }), d)))),
      field('From', h('input', { type: 'time', value: r.start, oninput: (e) => { r.start = e.target.value; } })),
      field('Until', h('input', { type: 'time', value: r.end, oninput: (e) => { r.end = e.target.value; } })),
      field('Show', h('select', { onchange: (e) => { r.layoutId = e.target.value; } }, optionsFor(layouts, r.layoutId))),
      h('button', { class: 'icon', title: 'Remove rule', onclick: () => { rules.splice(i, 1); drawRules(); } }, '✕'),
    )));
    if (!rules.length) rulesEl.append(h('p', { class: 'muted small' }, 'No rules: the default layout plays all the time.'));
  }
  drawRules();

  const save = () => attempt(() => api('PUT', `screens/${id}`, {
    name: name.value, timezone: tz.value, defaultLayoutId: def.value || null, schedule: rules,
  }), 'Saved');

  app.replaceChildren(h('div', { class: 'stack' },
    h('div', { class: 'page-head' },
      h('div', {}, h('a', { href: '#/screens', class: 'small' }, '← Screens'), h('h1', {}, s.name)),
      h('div', { class: 'row' },
        h('span', { class: `dot ${s.online ? 'on' : ''}` }), h('span', { class: 'muted small' }, s.online ? 'Online' : `Last seen ${ago(s.lastSeen)}`))),
    h('div', { class: 'card stack' },
      h('div', { class: 'fields' }, field('Name', name), field('Time zone', tz)),
      field('Default layout', def)),
    h('div', { class: 'card' },
      h('h2', {}, 'Schedule'),
      h('p', { class: 'muted small' }, 'The first matching rule wins. A rule that ends before it starts runs past midnight.'),
      rulesEl,
      h('button', { disabled: !layouts.length, onclick: () => {
        rules.push({ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', layoutId: layouts[0].id });
        drawRules();
      } }, '+ Add rule'),
      !layouts.length ? h('p', { class: 'muted small' }, 'Create a layout first.') : null),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: save }, 'Save'),
      h('button', { onclick: () => attempt(() => api('POST', `screens/${id}/reload`), 'The player will reload within 30 seconds') }, 'Reload player'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'danger', onclick: async () => {
        if (!(await confirmDelete('this screen'))) return;
        if (await attempt(() => api('DELETE', `screens/${id}`), 'Screen removed')) location.hash = '#/screens';
      } }, 'Remove screen')),
    s.player ? h('p', { class: 'muted small' }, `Player: ${s.player.w}×${s.player.h} · ${s.player.ua}`) : null,
  ));
}

// ---------- media ----------

function videoDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { resolve(Number.isFinite(v.duration) ? v.duration : null); URL.revokeObjectURL(v.src); };
    v.onerror = () => resolve(null);
    v.src = URL.createObjectURL(file);
  });
}

// XHR rather than fetch, for upload progress.
function upload(file, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ name: file.name.replace(/\.[^.]+$/, '') });
    if (duration) q.set('duration', duration.toFixed(2));
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/media?${q}`);
    xhr.setRequestHeader('content-type', file.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      xhr.status < 300 ? resolve(data) : reject(new ApiError(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError('Upload failed: network error'));
    xhr.send(file);
  });
}

async function mediaView() {
  const media = await api('GET', 'media');
  const input = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, hidden: true });
  const progress = h('div', { class: 'stack' });
  const drop = h('div', { class: 'dropzone' },
    h('p', {}, 'Drop images or videos here, or ', h('button', { class: 'link', style: { color: 'var(--accent)' }, onclick: () => input.click() }, 'choose files'), '.'),
    h('p', { class: 'small' }, 'JPG, PNG, WebP, GIF, MP4 or WebM, up to 500 MB each. 1920×1080 suits most TVs.'));

  async function uploadAll(files) {
    for (const file of files) {
      if (!/^(image|video)\//.test(file.type)) { toast(`${file.name} isn’t an image or video`, true); continue; }
      const bar = h('progress', { max: 1, value: 0 });
      const row = h('div', {}, h('p', { class: 'small' }, file.name), bar);
      progress.append(row);
      const duration = file.type.startsWith('video/') ? await videoDuration(file) : null;
      await attempt(() => upload(file, duration, (p) => { bar.value = p; }));
      row.remove();
    }
    route();
  }
  input.addEventListener('change', () => uploadAll([...input.files]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); uploadAll([...e.dataTransfer.files]); });

  app.replaceChildren(h('div', { class: 'stack' },
    h('div', { class: 'page-head' }, h('h1', {}, 'Media')),
    drop, input, progress,
    media.length
      ? h('div', { class: 'grid' }, media.map((m) => h('div', { class: 'card stack' },
        mediaThumb(m),
        h('input', { value: m.name, 'aria-label': 'Name', onchange: (e) => attempt(() => api('PATCH', `media/${m.id}`, { name: e.target.value }), 'Renamed') }),
        h('div', { class: 'row small muted' },
          h('span', { class: 'badge' }, m.kind), bytes(m.size), m.duration ? `· ${secs(m.duration)}` : '',
          h('span', { class: 'spacer' }),
          h('button', { class: 'link', onclick: async () => {
            if (!(await confirmDelete(`“${m.name}”`))) return;
            if (await attempt(() => api('DELETE', `media/${m.id}`), 'Deleted')) route();
          } }, 'Delete')))))
      : h('p', { class: 'empty' }, 'Nothing uploaded yet.'),
  ));
}

// ---------- playlists ----------

async function namedCreate(kind, path, extra = {}) {
  const name = h('input', { required: true, autofocus: true });
  if (!(await dialog(`New ${kind}`, field('Name', name), { ok: 'Create' }))) return;
  const row = await attempt(() => api('POST', path, { name: name.value, ...extra }));
  if (row) location.hash = `#/${path}/${row.id}`;
}

async function playlistsView() {
  const playlists = await api('GET', 'playlists');
  app.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Playlists'), h('button', { class: 'primary', onclick: () => namedCreate('playlist', 'playlists') }, '+ New playlist')),
    playlists.length
      ? h('div', { class: 'card' }, h('ul', { class: 'list' }, playlists.map((p) => h('li', {},
        h('a', { class: 'grow', href: `#/playlists/${p.id}` }, p.name),
        h('span', { class: 'muted small' }, `${p.items.length} item${p.items.length === 1 ? '' : 's'}`)))))
      : h('p', { class: 'card empty' }, 'A playlist is a list of images, videos, web pages and widgets that plays in a loop. Create one to get started.'),
  );
}

function itemLabel(it, mediaById) {
  if (it.type === 'media') return mediaById[it.mediaId]?.name || '(deleted media)';
  if (it.type === 'web') { try { return new URL(it.url).host; } catch { return it.url; } }
  const o = it.options || {};
  const detail = { weather: o.city, ticker: o.text, text: o.text }[it.widget];
  return `${WIDGET_LABELS[it.widget]}${detail ? ` · ${detail.slice(0, 40)}` : ''}`;
}

// Option fields for a widget; returns [nodes, read()].
function widgetForm(widget, o = {}) {
  const inputs = {
    clock: () => ({
      hour24: h('input', { type: 'checkbox', checked: !!o.hour24 }),
      showDate: h('input', { type: 'checkbox', checked: o.showDate !== false }),
    }),
    weather: () => ({
      city: h('input', { value: o.city || '', placeholder: 'London', required: true }),
      units: h('select', {}, h('option', { value: 'celsius', selected: o.units !== 'fahrenheit' }, '°C'), h('option', { value: 'fahrenheit', selected: o.units === 'fahrenheit' }, '°F')),
    }),
    ticker: () => ({
      text: h('textarea', { value: o.text || '', required: true }),
      speed: h('input', { type: 'number', min: 10, max: 500, value: o.speed ?? 80 }),
    }),
    text: () => ({
      text: h('textarea', { value: o.text || '' }),
      size: h('input', { type: 'number', min: 1, max: 60, value: o.size ?? 12 }),
      color: h('input', { type: 'color', value: o.color || '#ffffff' }),
      background: h('input', { type: 'color', value: o.background || '#000000' }),
    }),
  }[widget]();
  const labels = { hour24: '24-hour time', showDate: 'Show date', city: 'City', units: 'Units', text: 'Text', speed: 'Speed (pixels per second)', size: 'Text size (% of zone height)', color: 'Text colour', background: 'Background' };
  const nodes = Object.entries(inputs).map(([k, el]) => (el.type === 'checkbox'
    ? h('label', { class: 'row', style: { color: 'var(--text)' } }, el, labels[k])
    : field(labels[k], el)));
  const read = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k,
    el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value]));
  return [h('div', { class: 'stack' }, nodes), read];
}

async function playlistEditor(id) {
  const [p, media] = await Promise.all([api('GET', `playlists/${id}`), api('GET', 'media')]);
  const mediaById = Object.fromEntries(media.map((m) => [m.id, m]));
  const items = p.items.map((x) => ({ ...x }));
  const name = h('input', { value: p.name });
  const listEl = h('ul', { class: 'list' });

  function draw() {
    listEl.replaceChildren(...items.map((it, i) => {
      const m = it.type === 'media' ? mediaById[it.mediaId] : null;
      const icon = m ? mediaThumb(m, 'thumb sm')
        : h('div', { class: 'thumb sm', style: { display: 'flex', alignItems: 'center', justifyContent: 'center' } }, it.type === 'web' ? '🌐' : { clock: '🕒', weather: '⛅', ticker: '📰', text: '🔤' }[it.widget]);
      const isVideo = m?.kind === 'video';
      return h('li', {},
        icon,
        h('div', { class: 'grow' }, h('div', {}, itemLabel(it, mediaById)), h('div', { class: 'muted small' }, it.type === 'media' ? m?.kind : it.type)),
        h('label', { class: 'row small', style: { margin: 0 } }, 'Seconds',
          h('input', { class: 'dur', type: 'number', min: 1, value: it.duration ?? '', placeholder: isVideo ? 'to end' : '10',
            title: isVideo ? 'Leave empty to play the whole video' : '', oninput: (e) => { it.duration = e.target.value === '' ? null : Number(e.target.value); } })),
        it.type !== 'media' ? h('button', { class: 'icon', title: 'Edit', onclick: () => editItem(it) }, '✎') : null,
        h('button', { class: 'icon', title: 'Move up', disabled: i === 0, onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); } }, '↑'),
        h('button', { class: 'icon', title: 'Move down', disabled: i === items.length - 1, onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); } }, '↓'),
        h('button', { class: 'icon', title: 'Remove', onclick: () => { items.splice(i, 1); draw(); } }, '✕'));
    }));
    if (!items.length) listEl.append(h('li', { class: 'muted' }, 'Empty. Add media, a web page or a widget below.'));
  }

  async function editItem(it) {
    if (it.type === 'web') {
      const url = h('input', { type: 'url', value: it.url, required: true });
      if (await dialog('Web page', field('URL', url))) { it.url = url.value; draw(); }
    } else {
      const [form, read] = widgetForm(it.widget, it.options);
      if (await dialog(WIDGET_LABELS[it.widget], form)) { it.options = read(); draw(); }
    }
  }

  async function addMedia() {
    if (!media.length) { toast('Upload something on the Media page first', true); return; }
    const picked = new Set();
    const picker = h('div', { class: 'picker' }, media.map((m) => {
      const b = h('button', { type: 'button', onclick: () => {
        picked.has(m.id) ? picked.delete(m.id) : picked.add(m.id);
        b.style.outline = picked.has(m.id) ? '2px solid var(--accent)' : '';
      } }, mediaThumb(m), m.name);
      return b;
    }));
    if (!(await dialog('Add media', h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Pick one or more.'), picker), { ok: 'Add' }))) return;
    for (const m of media) if (picked.has(m.id)) items.push({ type: 'media', mediaId: m.id, duration: m.kind === 'image' ? 10 : null });
    draw();
  }

  async function addWeb() {
    const url = h('input', { type: 'url', placeholder: 'https://', required: true });
    const dur = h('input', { type: 'number', min: 1, value: 30 });
    const ok = await dialog('Add web page', h('div', { class: 'stack' }, field('URL', url), field('Seconds', dur),
      h('p', { class: 'muted small' }, 'Google Slides: use File → Share → Publish to web → Embed, and paste the link. Some sites refuse to be shown inside other pages.')), { ok: 'Add' });
    if (ok) { items.push({ type: 'web', url: url.value, duration: Number(dur.value) || 30 }); draw(); }
  }

  async function addWidget() {
    const kind = h('select', {}, Object.entries(WIDGET_LABELS).map(([k, l]) => h('option', { value: k }, l)));
    const slot = h('div', {});
    let read;
    const redraw = () => { let form; [form, read] = widgetForm(kind.value); slot.replaceChildren(form); };
    kind.addEventListener('change', redraw);
    redraw();
    const dur = h('input', { type: 'number', min: 1, value: 30 });
    if (await dialog('Add widget', h('div', { class: 'stack' }, field('Widget', kind), slot, field('Seconds', dur)), { ok: 'Add' })) {
      items.push({ type: 'widget', widget: kind.value, options: read(), duration: Number(dur.value) || 30 });
      draw();
    }
  }

  draw();
  app.replaceChildren(h('div', { class: 'stack' },
    h('div', { class: 'page-head' }, h('div', {}, h('a', { href: '#/playlists', class: 'small' }, '← Playlists'), h('h1', {}, p.name))),
    h('div', { class: 'card stack' }, field('Name', name)),
    h('div', { class: 'card stack' },
      h('h2', {}, 'Items'), listEl,
      h('div', { class: 'row' },
        h('button', { onclick: addMedia }, '+ Media'), h('button', { onclick: addWeb }, '+ Web page'), h('button', { onclick: addWidget }, '+ Widget'))),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => attempt(() => api('PUT', `playlists/${id}`, { name: name.value, items }), 'Saved') }, 'Save'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'danger', onclick: async () => {
        if (!(await confirmDelete('this playlist'))) return;
        if (await attempt(() => api('DELETE', `playlists/${id}`), 'Deleted')) location.hash = '#/playlists';
      } }, 'Delete playlist')),
  ));
}

// ---------- layouts ----------

async function layoutsView() {
  const layouts = await api('GET', 'layouts');
  app.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Layouts'), h('button', { class: 'primary', onclick: () => namedCreate('layout', 'layouts') }, '+ New layout')),
    layouts.length
      ? h('div', { class: 'grid' }, layouts.map((l) => h('a', { class: 'card stack', href: `#/layouts/${l.id}`, style: { textDecoration: 'none', color: 'inherit' } },
        zonePreview(l.zones, {}), h('strong', {}, l.name))))
      : h('p', { class: 'card empty' }, 'A layout splits the screen into zones, each playing a playlist. Create one, then pick it as a screen’s default.'),
  );
}

function zonePreview(zones, playlistById) {
  return h('div', { class: 'preview' }, zones.map((z) => h('div', {
    class: 'pz', style: { left: `${z.x}%`, top: `${z.y}%`, width: `${z.w}%`, height: `${z.h}%` },
  }, h('span', {}, playlistById[z.playlistId] ? `${z.name} · ${playlistById[z.playlistId].name}` : z.name))));
}

async function layoutEditor(id) {
  const [l, playlists] = await Promise.all([api('GET', `layouts/${id}`), api('GET', 'playlists')]);
  const playlistById = Object.fromEntries(playlists.map((p) => [p.id, p]));
  let zones = l.zones.map((z) => ({ ...z }));
  const name = h('input', { value: l.name });
  const previewSlot = h('div', {});
  const zonesEl = h('div', { class: 'stack' });

  const redrawPreview = () => previewSlot.replaceChildren(zonePreview(zones, playlistById));
  function draw() {
    zonesEl.replaceChildren(...zones.map((z, i) => {
      const num = (k, label) => field(label, h('input', { type: 'number', min: 0, max: 100, step: 0.5, value: z[k],
        oninput: (e) => { z[k] = Number(e.target.value); redrawPreview(); } }));
      return h('div', { class: 'zone-row' },
        field('Zone', h('input', { value: z.name, oninput: (e) => { z.name = e.target.value; redrawPreview(); } })),
        num('x', 'Left %'), num('y', 'Top %'), num('w', 'Width %'), num('h', 'Height %'),
        field('Playlist', h('select', { onchange: (e) => { z.playlistId = e.target.value || null; redrawPreview(); } },
          optionsFor(playlists, z.playlistId, '— Empty —'))),
        h('button', { class: 'icon', title: 'Remove zone', disabled: zones.length === 1, onclick: () => { zones.splice(i, 1); draw(); } }, '✕'));
    }));
    redrawPreview();
  }

  function applyPreset(preset) {
    zones = PRESETS[preset].map(([zname, x, y, w, hh], i) => ({
      id: `z${i + 1}`, name: zname, x, y, w, h: hh, playlistId: zones[i]?.playlistId ?? null,
    }));
    draw();
  }

  draw();
  app.replaceChildren(h('div', { class: 'stack' },
    h('div', { class: 'page-head' }, h('div', {}, h('a', { href: '#/layouts', class: 'small' }, '← Layouts'), h('h1', {}, l.name))),
    h('div', { class: 'card stack' }, field('Name', name),
      h('div', {}, h('label', {}, 'Start from a preset'),
        h('div', { class: 'row' }, Object.keys(PRESETS).map((k) => h('button', { onclick: () => applyPreset(k) }, k))))),
    h('div', { class: 'card stack' }, h('h2', {}, 'Preview (16:9)'), previewSlot),
    h('div', { class: 'card stack' }, h('h2', {}, 'Zones'), zonesEl,
      h('button', { disabled: zones.length >= 8, onclick: () => {
        const n = zones.length + 1;
        zones.push({ id: `z${Date.now().toString(36)}`, name: `Zone ${n}`, x: 0, y: 0, w: 100, h: 100, playlistId: null });
        draw();
      } }, '+ Add zone'),
      !playlists.length ? h('p', { class: 'muted small' }, 'Create a playlist to fill these zones.') : null),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => attempt(() => api('PUT', `layouts/${id}`, { name: name.value, zones }), 'Saved') }, 'Save'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'danger', onclick: async () => {
        if (!(await confirmDelete('this layout'))) return;
        if (await attempt(() => api('DELETE', `layouts/${id}`), 'Deleted')) location.hash = '#/layouts';
      } }, 'Delete layout')),
  ));
}

start();
