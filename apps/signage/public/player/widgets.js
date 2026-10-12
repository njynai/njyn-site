// Built-in widgets. Each takes (container, options, ctx) and returns a cleanup
// function. ctx.timezone is the screen's time zone.

export function mountWidget(name, el, options, ctx) {
  const fn = { clock, weather, ticker, text }[name];
  if (!fn) return () => {};
  return fn(el, options, ctx);
}

function clock(el, o, { timezone }) {
  el.className = 'w-clock';
  el.innerHTML = '<div class="time"></div><div class="date"></div>';
  const time = el.querySelector('.time'), date = el.querySelector('.date');
  date.hidden = !o.showDate;
  const fmtTime = new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: !o.hour24 });
  const fmtDate = new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long' });
  const tick = () => { const d = new Date(); time.textContent = fmtTime.format(d); date.textContent = fmtDate.format(d); };
  tick();
  const t = setInterval(tick, 1000);
  return () => clearInterval(t);
}

const WEATHER_TTL_MS = 30 * 60 * 1000;
const WMO = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Cloudy', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'], 51: ['Drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Drizzle', '🌦️'],
  61: ['Rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow', '🌨️'],
  80: ['Showers', '🌦️'], 81: ['Showers', '🌦️'], 82: ['Heavy showers', '⛈️'], 85: ['Snow showers', '🌨️'], 86: ['Snow showers', '🌨️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm', '⛈️'], 99: ['Thunderstorm', '⛈️'],
};

// Open-Meteo needs no API key. Results are cached so a rotating playlist doesn't
// refetch on every pass, and the last reading survives going offline.
async function fetchWeather(city, units) {
  const key = `signage.weather.${units}.${city.toLowerCase()}`;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(key)); } catch {}
  if (cached && Date.now() - cached.at < WEATHER_TTL_MS) return cached.data;
  try {
    const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`)).json();
    const place = geo.results?.[0];
    if (!place) throw new Error(`Unknown city ${city}`);
    const q = new URLSearchParams({
      latitude: place.latitude, longitude: place.longitude, timezone: 'auto', temperature_unit: units,
      current: 'temperature_2m,weather_code', daily: 'temperature_2m_max,temperature_2m_min', forecast_days: '1',
    });
    const f = await (await fetch(`https://api.open-meteo.com/v1/forecast?${q}`)).json();
    const data = {
      place: place.name, temp: f.current.temperature_2m, code: f.current.weather_code,
      hi: f.daily.temperature_2m_max[0], lo: f.daily.temperature_2m_min[0],
    };
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch {}
    return data;
  } catch (e) {
    if (cached) return cached.data;
    throw e;
  }
}

function weather(el, o) {
  el.className = 'w-weather';
  el.innerHTML = '<div class="place"></div><div class="now"></div><div class="desc"></div><div class="range"></div>';
  const $ = (s) => el.querySelector(s);
  $('.place').textContent = o.city;
  let stopped = false;
  const deg = o.units === 'fahrenheit' ? '°F' : '°C';
  const load = () => fetchWeather(o.city, o.units).then((d) => {
    if (stopped) return;
    const [desc, icon] = WMO[d.code] || ['', ''];
    $('.place').textContent = d.place;
    $('.now').textContent = `${icon} ${Math.round(d.temp)}${deg}`;
    $('.desc').textContent = desc;
    $('.range').textContent = `High ${Math.round(d.hi)}° · Low ${Math.round(d.lo)}°`;
  }).catch(() => { if (!stopped) $('.desc').textContent = 'Weather unavailable'; });
  load();
  const t = setInterval(load, WEATHER_TTL_MS);
  return () => { stopped = true; clearInterval(t); };
}

function ticker(el, o) {
  el.className = 'w-ticker';
  const span = document.createElement('span');
  span.textContent = o.text;
  el.append(span);
  // Pixels per second → animation length, once the text has been measured.
  requestAnimationFrame(() => {
    const distance = span.offsetWidth; // padding-left 100% + text width
    span.style.animationDuration = `${Math.max(distance / (o.speed || 80), 3)}s`;
  });
  return () => {};
}

function text(el, o) {
  el.className = 'w-text';
  el.textContent = o.text;
  el.style.color = o.color;
  el.style.background = o.background;
  el.style.fontSize = `calc(var(--zh) * ${(o.size || 12) / 100})`; // size is % of zone height
  return () => {};
}
