/* Weltradio 1.1 – Live-Radio aus aller Welt.
 *
 * Daten: Radio Browser (radio-browser.info), frei und ohne Schlüssel, CORS offen.
 *  - Nur Sender mit https-Stream (url_resolved), lastcheckok=1, hidebroken=true; sortiert nach Beliebtheit (clickcount).
 *  - Kartenpunkte: geo.json im Repo (alle Sender mit Ortsangabe, kompakt, wöchentlich per GitHub Action erneuert).
 *    Gezeichnet wird nur, was im Bild ist – herausgezoomt nur die beliebtesten. Volle Daten erst beim Antippen (byuuid).
 *  - Zufallsreise „Alle“: Land auslosen, dann dessen beliebteste Sender (kleine Abfrage je Land).
 *  - Genre-Vorräte (tag=…) und Länderlisten werden erst bei Bedarf geholt und im Speicher gehalten.
 * Wiedergabe: EIN <audio>-Element für alles (iOS gibt nur das per Tipp gestartete Element frei).
 * Karte: Leaflet (unpkg) mit preferCanvas → alle Punkte auf einem Canvas statt tausender DOM-Elemente.
 */
'use strict';

// ---------------------------------------------------------------- Speicher
const LS = {
  get(k, d) { try { const v = localStorage.getItem('wr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wr.' + k, JSON.stringify(v)); } catch { /* voll/privat */ } },
  del(k) { try { localStorage.removeItem('wr.' + k); } catch {} },
};
const $ = s => document.querySelector(s);

// ---------------------------------------------------------------- Konfiguration
const WINDOW = 2;           // Karten ober-/unterhalb der aktuellen im DOM (→ max. 5)
const AHEAD = 4;            // nachlegen, wenn weniger als so viele Sender vor einem liegen
const STALL_MS = 8000;      // so lange darf ein Stream laden, sonst „nicht erreichbar“
const GENRES = [
  ['all', 'Alle'], ['pop', 'Pop', 'pop'], ['rock', 'Rock', 'rock'], ['jazz', 'Jazz', 'jazz'], ['classical', 'Klassik', 'classical'],
  ['electronic', 'Electronic', 'electronic'], ['hiphop', 'Hip-Hop', 'hip hop'], ['chill', 'Chillout', 'chillout'],
  ['oldies', 'Oldies', 'oldies'], ['news', 'News', 'news'], ['talk', 'Talk', 'talk'],
];
const GENRE_BY = Object.fromEntries(GENRES.map(g => [g[0], g]));

// ---------------------------------------------------------------- Zustand
let favs = LS.get('favs', []);
let favIds = new Set(favs.map(s => s.id));
let genre = GENRE_BY[LS.get('genre', 'all')] ? LS.get('genre', 'all') : 'all';
let autoskip = LS.get('autoskip', true);
let countClicks = LS.get('count', true);
let heard = LS.get('heard', { n: 0, cc: [] });

// ---------------------------------------------------------------- Hilfen
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pick = a => a[Math.random() * a.length | 0];
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const regionNames = (() => { try { return new Intl.DisplayNames(['de'], { type: 'region' }); } catch { return null; } })();
function countryName(cc, fallback) {
  if (cc) try { const n = regionNames?.of(cc); if (n && n !== cc) return n; } catch {}
  return fallback || cc || 'Unbekannt';
}
const flag = cc => /^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map(c => 0x1F1A5 + c.charCodeAt(0))) : '🌐';
const fmtNum = n => n >= 10000 ? Math.round(n / 1000) + ' Tsd.' : n.toLocaleString('de-DE');
const placeOf = st => { const c = countryName(st.cc, st.country); return [norm(st.state) === norm(c) || norm(st.state) === norm(st.country) ? '' : st.state, c].filter(Boolean).join(' · '); };

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), Math.min(4500, 1500 + Math.max(0, msg.length - 30) * 45));
}
// Leichtes Tipp-Feedback (iPhone: unsichtbarer System-Schalter ab iOS 17.4, Android: Vibration) – wie Klangfeed.
function haptic() {
  try {
    if (navigator.vibrate) { navigator.vibrate(8); return; }
    const label = document.createElement('label'); label.style.display = 'none';
    const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('switch', '');
    label.append(input); document.head.append(label); label.click(); label.remove();
  } catch {}
}

// ---------------------------------------------------------------- Netz (Radio Browser)
async function getJSON(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
// Feste Spiegel + was der Server-Verzeichnisdienst meldet. Der erste, der antwortet, bleibt.
const HOSTS = ['de1', 'de2', 'fi1', 'nl1'].map(h => `https://${h}.api.radio-browser.info`);
let hostIdx = 0;
getJSON('https://all.api.radio-browser.info/json/servers', 6000).then(list => {
  for (const s of list || []) { const h = 'https://' + s.name; if (/^[a-z0-9.-]+\.api\.radio-browser\.info$/.test(s.name) && !HOSTS.includes(h)) HOSTS.push(h); }
}).catch(() => {});
async function api(path, ms = 12000) {
  let err;
  for (let k = 0; k < HOSTS.length; k++) {
    const i = (hostIdx + k) % HOSTS.length;
    try { const d = await getJSON(HOSTS[i] + path, ms); hostIdx = i; return d; }
    catch (e) { err = e; if (!navigator.onLine) break; }
  }
  throw err || new Error('Radio-Server nicht erreichbar');
}
const apiCache = new Map();
function cachedApi(path, ms) {
  if (!apiCache.has(path)) {
    apiCache.set(path, api(path, ms).catch(e => { apiCache.delete(path); throw e; }));
    if (apiCache.size > 40) apiCache.delete(apiCache.keys().next().value);
  }
  return apiCache.get(path);
}
const Q = 'is_https=true&hidebroken=true&order=clickcount&reverse=true';

// Taugt der Sender? https, zuletzt erreichbar, Format spielbar.
const probe = document.createElement('audio');
const canHls = !!probe.canPlayType('application/vnd.apple.mpegurl');
const canOgg = !!probe.canPlayType('audio/ogg; codecs="vorbis"') || !!probe.canPlayType('audio/ogg; codecs="opus"');
function playable(r) {
  if (!r || !/^https:\/\//i.test(r.url_resolved || '') || r.lastcheckok !== 1 || !String(r.name || '').trim()) return false;
  if (r.hls === 1 || /\.m3u8(\?|$)/i.test(r.url_resolved)) return canHls;
  if (/OGG|OPUS|VORBIS/i.test(r.codec || '') && !canOgg) return false;
  return true;
}
const cleanTag = t => t.trim().replace(/\s+/g, ' ');
function toSt(r) {
  const logo = String(r.favicon || '').trim().replace(/^http:\/\//i, 'https://');
  return {
    id: r.stationuuid, name: String(r.name).trim().replace(/\s+/g, ' ').slice(0, 90), url: r.url_resolved,
    logo: /^https:\/\/[^\s"'<>]+$/i.test(logo) ? logo : '',
    cc: String(r.countrycode || '').toUpperCase(), country: r.country || '', state: String(r.state || '').trim().slice(0, 40),
    tags: [...new Set(String(r.tags || '').split(',').map(cleanTag).filter(t => t && t.length <= 22))].slice(0, 5),
    codec: r.codec && r.codec !== 'UNKNOWN' ? r.codec : '', br: r.bitrate | 0, hls: r.hls ? 1 : 0,
    lat: typeof r.geo_lat === 'number' ? r.geo_lat : null, lng: typeof r.geo_long === 'number' ? r.geo_long : null,
    clicks: r.clickcount | 0,
  };
}
// Radio Browser enthält viele Doppel (gleicher Name, gleiches Land) – nur den beliebtesten behalten.
function stations(list, max = Infinity) {
  const out = [], seen = new Set();
  for (const r of list || []) {
    if (!playable(r)) continue;
    const st = toSt(r), k = norm(st.name) + '|' + st.cc;
    if (seen.has(k) || seen.has(st.id)) continue;
    seen.add(k); seen.add(st.id); out.push(st);
    if (out.length >= max) break;
  }
  return out;
}

const genrePools = new Map();
function genrePool(g) {
  const tag = GENRE_BY[g]?.[2];
  if (!genrePools.has(g)) genrePools.set(g, api(`/json/stations/search?tag=${encodeURIComponent(tag)}&${Q}&limit=300`, 20000)
    .then(l => stations(l)).catch(e => { genrePools.delete(g); throw e; }));
  return genrePools.get(g);
}
let countriesP = null;
function loadCountries() {
  return countriesP ||= api('/json/countries?hidebroken=true&order=stationcount&reverse=true', 15000)
    .then(list => (list || []).filter(c => /^[A-Z]{2}$/.test(c.iso_3166_1) && c.stationcount >= 3)
      .map(c => ({ cc: c.iso_3166_1, name: countryName(c.iso_3166_1, c.name), n: c.stationcount })))
    .catch(e => { countriesP = null; throw e; });
}
const countryStations = cc => cachedApi(`/json/stations/search?countrycode=${cc}&${Q}&limit=80`, 15000).then(l => stations(l, 50));
// Für die Zufallsreise reicht die Spitze eines Landes (klein, eigener Speicher je Land)
const tripCountry = new Map();
function tripCountryStations(cc) {
  if (!tripCountry.has(cc)) tripCountry.set(cc, api(`/json/stations/search?countrycode=${cc}&${Q}&limit=24`, 12000)
    .then(l => stations(l, 12)).catch(e => { tripCountry.delete(cc); throw e; }));
  return tripCountry.get(cc);
}
// Ein Sender voll (für Kartenpunkte aus geo.json); kleiner Speicher
const byIdCache = new Map();
function stationById(id) {
  if (!byIdCache.has(id)) {
    byIdCache.set(id, api('/json/stations/byuuid/' + encodeURIComponent(id), 10000)
      .then(l => { const r = (l || [])[0]; if (!r) throw new Error('Sender nicht gefunden'); return r; })
      .catch(e => { byIdCache.delete(id); throw e; }));
    if (byIdCache.size > 60) byIdCache.delete(byIdCache.keys().next().value);
  }
  return byIdCache.get(id);
}
// Klickzähler bei Radio Browser (gute Praxis; abschaltbar)
function countClick(st) {
  if (!countClicks || !st?.id) return;
  api('/json/url/' + encodeURIComponent(st.id), 8000).catch(() => {});
}

// ---------------------------------------------------------------- Farben (Logo, sonst Land)
function hashPal(key) {
  let h = 0; for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360;
  return [`hsl(${a} 55% 28%)`, `hsl(${(a + 40) % 360} 50% 26%)`, `hsl(${(a + 200) % 360} 45% 22%)`, `hsl(${(a + 320) % 360} 45% 24%)`, `hsl(${a} 85% 76%)`];
}
function setPal(el, p) { ['--c1', '--c2', '--c3', '--c4', '--glow'].forEach((v, k) => el.style.setProperty(v, p[k])); }
const palStyle = st => { const p = hashPal(st.cc || st.name); return `--c1:${p[0]};--c2:${p[1]};--c3:${p[2]}`; };
const pcv = document.createElement('canvas'); pcv.width = pcv.height = 4;
const pctx = pcv.getContext('2d', { willReadFrequently: true });
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
// Logo-Farben nur, wenn der Logo-Server CORS erlaubt (sonst bleibt die Länderfarbe). Nur für Karten im Fenster.
function applyPalette(el, st) {
  if (st.pal) return setPal(el, st.pal);
  setPal(el, hashPal(st.cc || st.name));
  // Logo-Farben nur bei Logo-Servern mit CORS. Fremde Logos ohne CORS erzeugen sonst rote Konsolenmeldungen –
  // darum nur bei bekannten CORS-freundlichen Hosts versuchen; sonst bleibt die Länderfarbe.
  if (!st.logo || st.palTried || !/^https:\/\/([a-z0-9-]+\.)*(githubusercontent\.com|imgur\.com|cloudfront\.net|wikimedia\.org)\//i.test(st.logo)) return;
  st.palTried = true;
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.referrerPolicy = 'no-referrer';
  const done = () => { im.onload = im.onerror = null; im.src = ''; };
  im.onerror = done;
  im.onload = () => {
    try {
      pctx.clearRect(0, 0, 4, 4);
      pctx.drawImage(im, 0, 0, 4, 4);
      const d = pctx.getImageData(0, 0, 4, 4).data;
      const cols = [], hues = [];
      for (let q = 0; q < 4; q++) {
        const x = (q % 2) * 2, y = (q >> 1) * 2; let r = 0, g = 0, b = 0, a = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const i = ((y + dy) * 4 + x + dx) * 4; const w = d[i + 3] / 255; r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; a += w; }
        if (a < .2) continue;
        const [hh, ss, ll] = rgbToHsl(r / a, g / a, b / a);
        if (ss > .15 && ll > .08 && ll < .95) hues.push([hh, ss]);
      }
      if (hues.length) {
        hues.sort((p, q) => q[1] - p[1]);
        const base = hues[0][0];
        for (let k = 0; k < 4; k++) { const [hh, ss] = hues[k % hues.length]; cols.push(`hsl(${(hh + k * 18) % 360 | 0} ${clamp(ss * 1.3, .4, .85) * 100 | 0}% ${[30, 27, 22, 25][k]}%)`); }
        st.pal = [...cols, `hsl(${base | 0} 90% 76%)`];
        if (el.isConnected) setPal(el, st.pal);
      }
    } catch { /* ohne CORS: Länderfarben bleiben */ }
    done();
  };
  im.src = st.logo;
}

// ---------------------------------------------------------------- Logos
// Fehlende/kaputte/winzige Logos → Anfangsbuchstabe + Flagge (Platzhalter liegt immer darunter).
const letterOf = st => esc(([...String(st.name || '?').replace(/^(radio|the|rádio|радио)\s+/i, '').trim()][0] || '?').toUpperCase());
function logoHTML(st, cls = '', min = 24) {
  return `<span class="logo ${cls}" data-l="${letterOf(st)}" style="${palStyle(st)}">${st.logo ? `<img src="${esc(st.logo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-min="${min}">` : ''}<i class="lf">${flag(st.cc)}</i></span>`;
}
document.addEventListener('load', e => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.closest('.logo')) return;
  if (img.naturalWidth < (+img.dataset.min || 24)) img.remove(); else img.classList.add('ready');
}, true);
document.addEventListener('error', e => { const img = e.target; if (img.tagName === 'IMG' && img.closest('.logo')) img.remove(); }, true);

// ---------------------------------------------------------------- Wiedergabe
// EIN Audio-Element für alles: iOS gibt nur das Element frei, das per Tipp gestartet wurde.
const pa = new Audio();
pa.preload = 'none';
pa.setAttribute('playsinline', '');
let now = null, nowSrc = '', pstate = 'idle', unlocked = false, wantPlay = false, watchdog = 0, pausedAt = 0;
const bad = new Set();   // in dieser Sitzung nicht erreichbare Sender

function playStation(st, src) {
  if (!st) return;
  const same = now && now.id === st.id;
  if (!same) { now = st; noteHeard(st); countClick(st); }
  if (src) nowSrc = src;
  wantPlay = true;
  // Live-Stream: nach längerer Pause oder Fehler neu verbinden, damit wieder „live“ läuft
  if (!same || pa.getAttribute('src') !== st.url || pa.error || (pausedAt && Date.now() - pausedAt > 20000)) pa.src = st.url;
  pausedAt = 0;
  setState(pa.paused || pa.readyState < 3 ? 'loading' : 'playing');
  armWatchdog(st);
  const p = pa.play();
  if (p) p.then(() => { unlocked = true; }).catch(err => {
    if (now !== st) return;
    if (err.name === 'NotAllowedError') { wantPlay = false; unlocked = false; clearTimeout(watchdog); setState('locked'); }
    else if (err.name === 'NotSupportedError') failed(st);
    else if (err.name !== 'AbortError') console.warn(err);
  });
  setMediaSession(st);
  renderMini();
}
function armWatchdog(st) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => { if (now === st && wantPlay && (pa.paused || pa.readyState < 3 || pstate === 'loading')) failed(st); }, STALL_MS);
}
function pause() {
  wantPlay = false; clearTimeout(watchdog);
  pa.pause(); pausedAt = Date.now();
  setState('paused');
}
function togglePlay() {
  if (!now) return;
  if (wantPlay && !pa.paused) pause(); else playStation(now);
}
function failed(st) {
  if (now !== st || !wantPlay) return;
  clearTimeout(watchdog);
  wantPlay = false; bad.add(st.id);
  try { pa.pause(); pa.removeAttribute('src'); pa.load(); } catch {}
  setState('error');
  toast(navigator.onLine ? 'Sender nicht erreichbar' : 'Offline – Radio braucht Internet');
  // In der Zufallsreise geht es von selbst weiter
  if (nowSrc === 'trip' && autoskip && navigator.onLine) setTimeout(() => { if (now === st && trip[cur] === st) nextTrip(); }, 900);
}
pa.addEventListener('playing', () => { clearTimeout(watchdog); if (wantPlay) setState('playing'); setPlaybackState('playing'); });
pa.addEventListener('waiting', () => { if (wantPlay && now) { setState('loading'); armWatchdog(now); } });
pa.addEventListener('stalled', () => { if (wantPlay && now && pstate !== 'playing') armWatchdog(now); });
pa.addEventListener('pause', () => {
  if (!pa.paused) return;   // veraltetes Ereignis (z. B. beim Senderwechsel)
  setPlaybackState('paused');
  if (wantPlay && !pa.error && pa.getAttribute('src')) { wantPlay = false; pausedAt = Date.now(); setState('paused'); }  // von außen pausiert (z. B. Anruf)
  if (pendingReload && document.visibilityState === 'hidden') location.reload();
});
pa.addEventListener('ended', () => { if (now && wantPlay) failed(now); });   // Live-Stream „endet“ = abgebrochen
pa.addEventListener('error', () => { if (pa.getAttribute('src') && now && wantPlay) failed(now); });

function setState(s) {
  pstate = s;
  renderMini();
  syncCards();
  syncLists();
  syncMapCard();
}
function setPlaybackState(s) { try { navigator.mediaSession && (navigator.mediaSession.playbackState = s); } catch {} }
function setMediaSession(st) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: st.name, artist: `${flag(st.cc)} ${countryName(st.cc, st.country)}`, album: 'Weltradio',
      artwork: st.logo ? [{ src: st.logo, sizes: '512x512' }, { src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }]
        : [{ src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
    });
  } catch {}
}
if ('mediaSession' in navigator) {
  const h = (k, f) => { try { navigator.mediaSession.setActionHandler(k, f); } catch {} };
  h('play', () => now && playStation(now));
  h('pause', pause);
  h('stop', pause);
  h('nexttrack', () => nextTrip(true));
  h('previoustrack', () => { if (cur > 0) { if (view === 'trip') goTo(cur - 1); else activate(cur - 1, true); } });
  // Live-Radio: kein Spulen
  h('seekbackward', null); h('seekforward', null); h('seekto', null);
}
function noteHeard(st) {
  heard.n++;
  if (st.cc && !heard.cc.includes(st.cc)) heard.cc.push(st.cc);
  LS.set('heard', heard);
}

// ---------------------------------------------------------------- Mini-Player
const miniEl = $('#mini');
let miniId = '';
function renderMini() {
  if (!now) { miniEl.hidden = true; document.body.classList.remove('has-mini'); return; }
  if (miniEl.hidden) { miniEl.hidden = false; document.body.classList.add('has-mini'); requestAnimationFrame(() => map?.invalidateSize()); }
  if (miniId !== now.id) {
    miniId = now.id;
    $('#mini-logo').outerHTML = logoHTML(now, 'sm').replace('class="logo sm"', 'class="logo sm" id="mini-logo"');
    $('#mini-name').textContent = now.name;
  }
  const sub = { loading: 'Verbindet …', error: 'Sender nicht erreichbar', locked: 'Tippen zum Abspielen' }[pstate];
  $('#mini-sub').textContent = sub || `${flag(now.cc)} ${placeOf(now)}`;
  for (const s of ['playing', 'loading', 'error']) miniEl.classList.toggle(s, pstate === s);
  miniEl.querySelector('.fav').classList.toggle('on', favIds.has(now.id));
  miniEl.querySelector('.play').setAttribute('aria-label', pstate === 'playing' || pstate === 'loading' ? 'Pause' : 'Abspielen');
}
miniEl.addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b || !now) return;
  haptic();
  if (b.dataset.a === 'play') togglePlay();
  else if (b.dataset.a === 'fav') toggleFav(now, b);
  else if (b.dataset.a === 'goto') {
    if (nowSrc === 'trip' && trip[cur] === now) showView('trip');
    else if (now.lat != null) showOnMap(now);
    else showView('favs');
  }
});

// ---------------------------------------------------------------- Favoriten
const slim = st => ({ id: st.id, name: st.name, url: st.url, logo: st.logo, cc: st.cc, country: st.country, state: st.state,
  tags: st.tags, codec: st.codec, br: st.br, hls: st.hls, lat: st.lat, lng: st.lng });
function toggleFav(st, btn) {
  if (favIds.has(st.id)) {
    favs = favs.filter(x => x.id !== st.id); favIds.delete(st.id);
    toast('Aus Favoriten entfernt');
  } else {
    favs.unshift(slim(st)); favIds.add(st.id);
    toast('⭐ In Favoriten');
    if (btn) burst(btn);
  }
  LS.set('favs', favs);
  updateFavCount(true);
  renderMini(); syncCards(); syncMapCard();
  document.querySelectorAll(`.list li[data-id="${CSS.escape(st.id)}"] .star`).forEach(b => b.classList.toggle('on', favIds.has(st.id)));
  if (view === 'favs' && !searchActive()) renderFavs();
}
function updateFavCount(bump) {
  const b = $('#fav-count');
  b.hidden = !favs.length; b.textContent = favs.length > 99 ? '99+' : favs.length;
  if (bump) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
}
function burst(btn) {
  if (document.documentElement.classList.contains('calm')) return;
  const r = btn.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let k = 0; k < 8; k++) {
    const p = document.createElement('i'); p.className = 'spark';
    p.style.cssText = `left:${cx - 4}px;top:${cy - 4}px;background:${['#ffc53d', '#ffe08a', '#fff4cc'][k % 3]}`;
    document.body.append(p);
    const a = k / 8 * Math.PI * 2, d = 30 + Math.random() * 16;
    p.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d}px) scale(.3)`, opacity: 0 }],
      { duration: 600, easing: 'cubic-bezier(.2,.8,.2,1)' }).onfinish = () => p.remove();
  }
}

// ---------------------------------------------------------------- Zufallsreise
let trip = [], cur = 0, shown = -1, tripGen = 0, filling = null, lastErr = '';
const cards = new Map();
const feedEl = $('#feed'), trackEl = $('#track');
let H = feedEl.clientHeight || innerHeight;
const used = new Set(), recentCC = [];
const byCountryCache = new WeakMap();

// Zufällig, aber gute Sender: erst ein Land (nicht eins der letzten), dann einer der beliebtesten dort.
function nextStation(list) {
  let by = byCountryCache.get(list);
  if (!by) {
    by = new Map();
    for (const st of list) { const k = st.cc || '?'; if (!by.has(k)) by.set(k, []); by.get(k).push(st); }
    byCountryCache.set(list, by);
  }
  for (let round = 0; round < 2; round++) {
    const ccs = [...by.keys()].filter(cc => !recentCC.includes(cc) && by.get(cc).some(st => !used.has(st.id) && !bad.has(st.id)));
    const pool = ccs.length ? ccs : [...by.keys()].filter(cc => by.get(cc).some(st => !used.has(st.id) && !bad.has(st.id)));
    if (pool.length) {
      // Länder mit mehr beliebten Sendern etwas häufiger, aber jedes Land hat eine Chance
      const w = pool.map(cc => Math.sqrt(Math.min(by.get(cc).length, 40)));
      let r = Math.random() * w.reduce((a, b) => a + b, 0), cc = pool[pool.length - 1];
      for (let k = 0; k < pool.length; k++) { r -= w[k]; if (r <= 0) { cc = pool[k]; break; } }
      const top = by.get(cc).filter(st => !used.has(st.id) && !bad.has(st.id)).slice(0, 6);
      const st = top[Math.min(top.length - 1, Math.floor(Math.random() ** 1.6 * top.length))];
      used.add(st.id);
      recentCC.push(cc); if (recentCC.length > Math.min(12, by.size - 1)) recentCC.shift();
      return st;
    }
    for (const st of list) if (!trip.slice(Math.max(0, cur - 3)).includes(st)) used.delete(st.id);   // alles durch → von vorn
  }
  return null;
}
// „Alle“: Länder auslosen (größere etwas häufiger, keins der letzten), je Land eine kleine Abfrage, dort einer der beliebtesten.
const emptyCC = new Set();
async function worldStations(n) {
  const cs = (await loadCountries()).filter(c => !emptyCC.has(c.cc));
  const out = [];
  for (let round = 0; round < 3 && out.length < n; round++) {
    const pool = cs.filter(c => !recentCC.includes(c.cc) && !emptyCC.has(c.cc));
    const picks = [];
    while (picks.length < n - out.length && pool.length) {
      const w = pool.map(c => Math.sqrt(Math.min(c.n, 40)));
      let r = Math.random() * w.reduce((a, b) => a + b, 0), k = pool.length - 1;
      for (let j = 0; j < pool.length; j++) { r -= w[j]; if (r <= 0) { k = j; break; } }
      picks.push(pool.splice(k, 1)[0].cc);
    }
    if (!picks.length) { recentCC.length = 0; continue; }
    const lists = await Promise.allSettled(picks.map(tripCountryStations));
    lists.forEach((res, k) => {
      const cc = picks[k];
      if (res.status !== 'fulfilled') return;
      if (!res.value.length) { emptyCC.add(cc); return; }
      const top = res.value.filter(st => !used.has(st.id) && !bad.has(st.id)).slice(0, 6);
      if (!top.length) { tripCountry.delete(cc); return; }
      const st = top[Math.min(top.length - 1, Math.floor(Math.random() ** 1.6 * top.length))];
      used.add(st.id); out.push(st);
      recentCC.push(cc); if (recentCC.length > 12) recentCC.shift();
    });
  }
  return out;
}
function fillTrip(n = 6) {
  if (filling) return filling;
  const gen = tripGen;
  filling = (async () => {
    const was = trip.length;
    if (genre === 'all') {
      const add = await worldStations(n);
      if (gen !== tripGen) return;
      if (!add.length) throw new Error('leer');
      trip.push(...add);
    } else {
      const list = await genrePool(genre);
      if (gen !== tripGen) return;
      if (!list.length) throw new Error('leer');
      for (let k = 0; k < n; k++) { const st = nextStation(list); if (!st) break; trip.push(st); }
    }
    lastErr = '';
    layout();
    if (!was && trip.length) activate(cur, false);
  })().catch(e => { if (gen === tripGen) lastErr = e.message || 'Fehler'; })
    .finally(() => { filling = null; updateState(); });
  updateState();
  return filling;
}

const IC = {
  star: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  play: '<path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8z"/>',
  pause: '<rect x="6" y="4.5" width="4.2" height="15" rx="1.2"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
};
const svg = (name, cls = '') => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${IC[name]}</svg>`;

function makeCard(i) {
  const st = trip[i];
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.i = i;
  el.style.top = (i * H) + 'px';
  el.style.height = H + 'px';
  const meta = [st.codec, st.br ? st.br + ' kbit/s' : '', st.hls ? 'HLS' : '', st.clicks ? fmtNum(st.clicks) + ' Aufrufe heute' : ''].filter(Boolean).join(' · ');
  el.innerHTML = `
    <div class="card-bg"></div>
    <div class="stage">
      <div class="cover-box logo" data-l="${letterOf(st)}">${st.logo ? `<img src="${esc(st.logo)}" alt="" decoding="async" referrerpolicy="no-referrer" data-min="40">` : ''}<i class="lf">${flag(st.cc)}</i>
        <div class="pp">${svg('play')}</div><div class="hint">Tippen zum Abspielen</div></div>
      <div class="side">
        <button class="sb fav ${favIds.has(st.id) ? 'on' : ''}" data-a="fav" aria-label="Favorit"><span class="sb-i">${svg('star')}</span><small>Favorit</small></button>
        <button class="sb pl" data-a="play" aria-label="Abspielen oder Pause"><span class="sb-i">${svg('play', 'fill i-play')}${svg('pause', 'fill i-pause')}</span><small>Pause</small></button>
        ${st.lat != null ? `<button class="sb onmap" data-a="map" aria-label="Auf der Karte zeigen"><span class="sb-i">${svg('pin')}</span><small>Karte</small></button>` : ''}
      </div>
    </div>
    <div class="card-body">
      <p class="why"><b class="flg">${flag(st.cc)}</b><span>${esc(placeOf(st))}</span><b class="eq"><i></i><i></i><i></i></b></p>
      <h2 class="title">${esc(st.name)}</h2>
      ${st.tags.length ? `<div class="tags">${st.tags.slice(0, 4).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
    </div>`;
  applyPalette(el, st);
  return el;
}
function disposeCard(el) {
  // Bilder freigeben (iOS hält dekodierte Bilder sonst länger im Speicher)
  el.querySelectorAll('img').forEach(img => img.removeAttribute('src'));
  el.remove();
}
function renderWindow(center) {
  const lo = Math.max(0, center - WINDOW), hi = Math.min(trip.length - 1, center + WINDOW);
  for (const [i, el] of cards) if (i < lo || i > hi) { disposeCard(el); cards.delete(i); }
  for (let i = lo; i <= hi; i++) {
    let el = cards.get(i);
    if (!el) { el = makeCard(i); cards.set(i, el); trackEl.appendChild(el); }
    el.classList.toggle('near', Math.abs(i - center) <= 1);
    el.classList.toggle('active', i === center);
  }
  shown = center;
  syncCards();
}
function layout() {
  H = feedEl.clientHeight || innerHeight;
  trackEl.style.height = ((trip.length + 1) * H) + 'px';
  for (const [i, el] of cards) { el.style.top = (i * H) + 'px'; el.style.height = H + 'px'; }
  if (trip.length) renderWindow(Math.min(cur, trip.length - 1));
  updateState();
}
function resetTrip() {
  tripGen++; filling = null;
  for (const [, el] of cards) disposeCard(el);
  cards.clear();
  trip = []; cur = 0; shown = -1;
  feedEl.scrollTop = 0;
  layout();
}
function cardState(st) {
  if (now !== st) return unlocked ? 'paused' : 'locked';
  return pstate === 'idle' ? 'paused' : pstate;
}
function syncCards() {
  for (const [i, el] of cards) {
    const st = trip[i], s = cardState(st);
    for (const c of ['loading', 'paused', 'playing', 'locked', 'error']) el.classList.toggle(c, s === c);
    el.querySelector('.hint').textContent = s === 'error' ? 'Sender nicht erreichbar' : 'Tippen zum Abspielen';
    el.querySelector('.sb.pl small').textContent = s === 'playing' || s === 'loading' ? 'Pause' : 'Play';
    el.querySelector('.sb.fav').classList.toggle('on', favIds.has(st.id));
  }
}

// Lade- bzw. Fehlerkarte hinter dem letzten Sender: nie eine leere Fläche
const stateEl = document.createElement('div');
stateEl.className = 'state';
trackEl.appendChild(stateEl);
function updateState() {
  stateEl.style.top = (trip.length * H) + 'px';
  stateEl.style.height = H + 'px';
  const off = !navigator.onLine;
  const html = filling || (!off && !lastErr)
    ? '<div><div class="spinner"></div><p>Suche Sender in aller Welt …</p></div>'
    : `<div><p>${off ? 'Keine Internetverbindung.<br>Weltradio lädt weiter, sobald du wieder online bist.' : 'Gerade kommen keine Sender an.'}</p><button class="btn" type="button" data-a="retry">Erneut versuchen</button></div>`;
  if (stateEl.dataset.h !== html) { stateEl.innerHTML = html; stateEl.dataset.h = html; }
}
stateEl.addEventListener('click', e => { if (e.target.closest('[data-a="retry"]')) { lastErr = ''; fillTrip(); } });
addEventListener('online', () => { lastErr = ''; if (trip.length - cur < AHEAD) fillTrip(); toast('Wieder online'); });
addEventListener('offline', () => { updateState(); toast('Offline – Radio braucht Internet'); });

// Scrollen
let scrollRaf = 0, settleTimer = 0;
feedEl.addEventListener('scroll', () => {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const idx = clamp(Math.round(feedEl.scrollTop / H), 0, Math.max(0, trip.length - 1));
    if (idx !== shown && trip.length) renderWindow(idx);
  });
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, 160);
}, { passive: true });
if ('onscrollend' in window) feedEl.addEventListener('scrollend', () => { clearTimeout(settleTimer); settle(); });
function settle() {
  if (!trip.length || view !== 'trip') return;
  const idx = clamp(Math.round(feedEl.scrollTop / H), 0, trip.length - 1);
  if (idx !== cur) activate(idx, true);
}
function goTo(i, smooth = true) {
  i = clamp(i, 0, trip.length);
  feedEl.scrollTo({ top: i * H, behavior: smooth ? 'smooth' : 'auto' });
}
// Beim Einrasten spielt der Sender (sobald einmal per Tipp freigegeben)
function activate(i, autoplay) {
  const st = trip[i];
  if (!st) return;
  cur = i;
  renderWindow(i);
  if (autoplay && unlocked) playStation(st, 'trip');
  if (trip.length - i < AHEAD) fillTrip();
}
// Nächster Zufallssender – auch vom Sperrbildschirm, wenn die Reise gerade nicht offen ist
async function nextTrip(fromLock) {
  if (cur + 1 >= trip.length) await fillTrip();
  if (cur + 1 >= trip.length) return;
  const direct = fromLock || document.visibilityState === 'hidden';
  if (view === 'trip' && !direct) goTo(cur + 1);
  else if (view === 'trip') { goTo(cur + 1); activate(cur + 1, true); }
  else activate(cur + 1, true);
}

// Antippen und Knöpfe auf den Karten
trackEl.addEventListener('click', e => {
  const card = e.target.closest('.card'); if (!card) return;
  const i = +card.dataset.i, st = trip[i];
  if (!st) return;
  const btn = e.target.closest('[data-a]');
  haptic();
  if (btn?.dataset.a === 'fav') { toggleFav(st, btn); btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); return; }
  if (btn?.dataset.a === 'map') { showOnMap(st); return; }
  if (i !== cur) { goTo(i); return; }
  if (now === st && (pstate === 'playing' || pstate === 'loading')) pause();
  else playStation(st, 'trip');
});

// Genre-Auswahl oben
function renderGenres() {
  $('#genres').innerHTML = GENRES.map(([k, label]) => `<button type="button" role="radio" class="gchip ${k === genre ? 'on' : ''}" aria-checked="${k === genre}" data-g="${k}">${label}</button>`).join('');
}
$('#genres').addEventListener('click', e => {
  const b = e.target.closest('[data-g]'); if (!b || b.dataset.g === genre) return;
  haptic();
  genre = b.dataset.g; LS.set('genre', genre);
  renderGenres();
  b.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  resetTrip();
  recentCC.length = 0;
  // Die neue Reise beginnt sofort mit dem ersten Sender (Tipp = Geste → darf spielen)
  fillTrip().then(() => { if (trip[0] && unlocked) playStation(trip[0], 'trip'); });
});

// ---------------------------------------------------------------- Karte (Leaflet, ein Canvas)
// Punkte aus geo.json: [uuid, name, lat, lon, clickcount, cc], nach Beliebtheit sortiert.
// Gezeichnet wird nur, was im Bild ist (plus Rand), gedeckelt je Zoomstufe → Speicher bleibt flach.
const DOT_LIMIT = [1500, 1500, 1500, 1800, 2200, 2600, 3000, 3200];  // je Zoomstufe; ab Zoom 8: alles im Bild
const DOT_MAX = 3500;                                                  // harte Obergrenze für Marker
let lastDot = 0;
let map = null, tiles = null, dots = null, renderer = null, selDot = null, leafletP = null, mapCardSt = null;
let geo = null, geoP = null, redrawTimer = 0;
const shownDots = new Map();   // uuid → circleMarker (nur die gerade gezeichneten)
function loadGeo() {
  return geoP ||= fetch('geo.json').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(list => (geo = Array.isArray(list) ? list : []))
    .catch(e => { geoP = null; throw e; });
}
function loadLeaflet() {
  return leafletP ||= new Promise((res, rej) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    css.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='; css.crossOrigin = '';
    document.head.insertBefore(css, document.querySelector('link[href="style.css"]'));
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='; s.crossOrigin = '';
    s.onload = () => res(window.L); s.onerror = () => { leafletP = null; s.remove(); rej(new Error('Karte lädt nicht')); };
    document.head.append(s);
  });
}
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function tileUrl() {
  const dark = document.documentElement.dataset.theme === 'nacht';
  // Esri „Canvas“-Karten: ruhig, ohne Schlüssel (CARTO verlangt seit 2026 einen API-Schlüssel)
  return `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${dark ? 'Dark' : 'Light'}_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
}
const dotStyle = () => { const c = cssVar('--dot') || '#8fd8ff'; return { radius: 2.4, weight: 4, color: c, opacity: .22, fillColor: c, fillOpacity: .95 }; };
async function initMap() {
  if (map) return;
  const geoReady = loadGeo().catch(() => null);   // parallel zur Karte holen
  let L;
  try { L = await loadLeaflet(); } catch { $('#map-count').textContent = 'Karte lädt nicht – Internet?'; return; }
  if (map) return;
  map = L.map('map', { preferCanvas: true, zoomControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 13, zoomSnap: .5, attributionControl: true })
    .setView([28, 12], 2);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  tiles = L.tileLayer(tileUrl(), {
    maxZoom: 19, maxNativeZoom: 16,
    attribution: 'Kacheln © <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> — Esri, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende',
  }).addTo(map);
  renderer = L.canvas({ padding: .3, tolerance: 8 });
  dots = L.featureGroup().addTo(map);
  dots.on('click', e => { const g = e.layer?.g; if (g) { L.DomEvent.stopPropagation(e); lastDot = Date.now(); haptic(); onDot(g); } });
  map.on('click', () => { if (Date.now() - lastDot > 400) hideMapCard(); });
  map.on('moveend zoomend', scheduleRedraw);
  await geoReady;
  if (!geo) {
    $('#map-count').textContent = 'Sender laden nicht – Internet?';
    // später erneut versuchen (z. B. wieder online)
    addEventListener('online', () => loadGeo().then(redrawDots).catch(() => {}), { once: true });
    return;
  }
  redrawDots();
}
function scheduleRedraw() { clearTimeout(redrawTimer); redrawTimer = setTimeout(redrawDots, 120); }
// Nur Punkte im (etwas erweiterten) Bild, beliebteste zuerst, gedeckelt je Zoom.
function redrawDots() {
  if (!map || !geo) return;
  const L = window.L, z = Math.floor(map.getZoom());
  const limit = Math.min(DOT_MAX, z >= DOT_LIMIT.length ? Infinity : DOT_LIMIT[z]);
  const view = map.getBounds(), b = view.pad(.2);
  const s = Math.max(-90, b.getSouth()), n = Math.min(90, b.getNorth()), w = b.getWest(), e = b.getEast();
  const vs = view.getSouth(), vn = view.getNorth(), vw = view.getWest(), ve = view.getEast();
  const allLng = e - w >= 360;
  const want = new Map();
  let inView = 0;
  for (let i = 0; i < geo.length && want.size < limit; i++) {
    const g = geo[i], lat = g[2];
    if (lat < s || lat > n) continue;
    let lng = g[3];
    if (!allLng) {
      // Weltkopien (worldCopyJump): Punkt in die sichtbare Kopie schieben
      if (lng < w) lng += 360 * Math.ceil((w - lng) / 360);
      else if (lng > e) lng -= 360 * Math.ceil((lng - e) / 360);
      if (lng < w || lng > e) continue;
    }
    want.set(g[0], [g, lng]);
    if (lat >= vs && lat <= vn && (allLng || (lng >= vw && lng <= ve))) inView++;
  }
  for (const [id, m] of shownDots) if (!want.has(id)) { dots.removeLayer(m); shownDots.delete(id); }
  const style = { ...dotStyle(), renderer };
  for (const [id, [g, lng]] of want) {
    const m = shownDots.get(id);
    if (m) { if (m.getLatLng().lng !== lng) m.setLatLng([g[2], lng]); continue; }
    const nm = L.circleMarker([g[2], lng], style);
    nm.g = g;
    shownDots.set(id, nm);
    dots.addLayer(nm);
  }
  $('#map-count').textContent = `${geo.length.toLocaleString('de-DE')} Sender · ${inView.toLocaleString('de-DE')} im Bild`;
}
// Stille (0,1 s) als Blob: gibt das Audio-Element im Tipp frei, während die Senderdaten noch laden (iOS)
let silentUrl = '';
function unlockAudio() {
  if (unlocked || (now && wantPlay)) return;
  try {
    if (!silentUrl) {
      const n = 800, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);
      const str = (o, t) => [...t].forEach((c, k) => d.setUint8(o + k, c.charCodeAt(0)));
      str(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
      d.setUint32(24, 8000, true); d.setUint32(28, 16000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); str(36, 'data'); d.setUint32(40, n * 2, true);
      silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    }
    pa.src = silentUrl;
    const p = pa.play();
    if (p) p.then(() => { unlocked = true; }).catch(() => {});
  } catch {}
}
// Antippen: Karte sofort mit dem, was geo.json weiß; volle Daten holen, dann spielen.
let dotReq = 0;
function geoStation(g) { return { id: g[0], name: g[1], url: '', logo: '', cc: g[5] || '', country: '', state: '', tags: [], codec: '', br: 0, hls: 0, lat: g[2], lng: g[3], clicks: g[4], stub: true }; }
async function onDot(g) {
  const req = ++dotReq;
  const stub = geoStation(g);
  unlockAudio();
  showMapCard(stub);
  try {
    const r = await stationById(g[0]);
    if (req !== dotReq || mapCardSt !== stub) return;
    const st = playable(r) ? toSt(r) : null;
    if (!st) { toast('Dieser Sender lässt sich hier nicht abspielen'); return; }
    if (st.lat == null) { st.lat = g[2]; st.lng = g[3]; }
    playStation(st, 'map');
    showMapCard(st);
  } catch {
    if (req === dotReq) toast(navigator.onLine ? 'Sender kommt gerade nicht an' : 'Offline – Radio braucht Internet');
  }
}
function markDot(st) {
  if (!map) return;
  if (selDot) { selDot.remove(); selDot = null; }
  if (st?.lat == null) return;
  selDot = window.L.circleMarker([st.lat, st.lng], { renderer, radius: 8, weight: 3, color: '#fff', opacity: 1, fillColor: cssVar('--accent2') || '#c39bff', fillOpacity: 1, interactive: false }).addTo(map);
}
function showMapCard(st) {
  mapCardSt = st;
  const el = $('#map-card');
  el.innerHTML = `${logoHTML(st)}
    <div class="t"><b>${esc(st.name)}</b><small>${flag(st.cc)} ${esc(placeOf(st))}</small>
      ${st.cc ? `<button type="button" data-a="country">Mehr aus ${esc(countryName(st.cc, st.country))} ›</button>` : ''}</div>
    <button class="icb fav" type="button" data-a="fav" aria-label="Favorit">${svg('star')}</button>
    <button class="icb pl" type="button" data-a="play" aria-label="Abspielen oder Pause"></button>
    <button class="icb x" type="button" data-a="close" aria-label="Schließen">×</button>`;
  el.hidden = false;
  markDot(st);
  syncMapCard();
}
function hideMapCard() { $('#map-card').hidden = true; mapCardSt = null; if (selDot) { selDot.remove(); selDot = null; } }
function syncMapCard() {
  const st = mapCardSt; if (!st || $('#map-card').hidden) return;
  const el = $('#map-card');
  el.querySelector('.fav').classList.toggle('on', favIds.has(st.id));
  const on = now === st && (pstate === 'playing' || pstate === 'loading');
  const pl = el.querySelector('.pl');
  const want = on ? 'pause' : 'play';
  if (pl.dataset.i !== want) { pl.dataset.i = want; pl.innerHTML = svg(want); pl.querySelector('svg').style.cssText = 'fill:currentColor;stroke:none'; }
}
$('#map-card').addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); const st = mapCardSt; if (!b || !st) return;
  haptic();
  const a = b.dataset.a;
  if (a === 'fav') toggleFav(st, b);
  else if (a === 'play') {
    if (st.stub) { const g = geo?.find(x => x[0] === st.id); if (g) onDot(g); }
    else if (now === st && (pstate === 'playing' || pstate === 'loading')) pause(); else playStation(st, 'map');
  }
  else if (a === 'close') hideMapCard();
  else if (a === 'country') openCountry(st.cc);
});
async function showOnMap(st) {
  showView('map');
  await initMap();
  if (!map || st.lat == null) return;
  map.invalidateSize();
  map.flyTo([st.lat, st.lng], Math.max(map.getZoom(), 6), { duration: document.documentElement.classList.contains('calm') ? 0 : 1.1 });
  showMapCard(st);
}

// Länder-Liste
const cpanel = $('#cpanel');
let cpCountry = '';
$('#open-countries').addEventListener('click', () => { haptic(); openCountries(); });
$('#cp-close').addEventListener('click', () => { haptic(); cpanel.hidden = true; $('#cp-body').innerHTML = ''; });
$('#cp-back').addEventListener('click', () => { haptic(); openCountries(); });
$('#cp-filter').addEventListener('input', () => renderCountryList());
async function openCountries() {
  cpanel.hidden = false; cpCountry = '';
  $('#cp-title').textContent = 'Länder'; $('#cp-back').hidden = true; $('.cp-search').hidden = false;
  $('#cp-body').innerHTML = '<div class="state" style="position:static;padding:40px"><div><div class="spinner"></div><p>Lädt Länder …</p></div></div>';
  try { await loadCountries(); renderCountryList(); }
  catch { $('#cp-body').innerHTML = '<p class="empty">Die Länderliste kommt gerade nicht an.</p>'; }
}
function renderCountryList() {
  if (cpCountry || !countriesP) return;
  countriesP.then(list => {
    if (cpCountry) return;
    const q = norm($('#cp-filter').value);
    const rows = list.filter(c => !q || norm(c.name).includes(q) || c.cc.toLowerCase() === q);
    $('#cp-body').innerHTML = rows.length ? `<ul class="clist">${rows.map(c => `<li><button type="button" data-cc="${c.cc}"><span class="fl">${flag(c.cc)}</span><span class="nm">${esc(c.name)}</span><small>${c.n.toLocaleString('de-DE')}</small></button></li>`).join('')}</ul>`
      : '<p class="empty">Kein Land gefunden.</p>';
  });
}
$('#cp-body').addEventListener('click', e => {
  const c = e.target.closest('[data-cc]');
  if (c) { haptic(); openCountry(c.dataset.cc); return; }
  listClick(e, () => countryList);
});
let countryList = [];
async function openCountry(cc) {
  cpanel.hidden = false; cpCountry = cc;
  $('#cp-title').textContent = `${flag(cc)} ${countryName(cc)}`; $('#cp-back').hidden = false; $('.cp-search').hidden = true;
  $('#cp-body').innerHTML = '<div class="state" style="position:static;padding:40px"><div><div class="spinner"></div><p>Lädt Sender …</p></div></div>';
  try {
    countryList = await countryStations(cc);
    if (cpCountry !== cc) return;
    $('#cp-body').innerHTML = countryList.length ? `<ul class="list">${countryList.map(itemHTML).join('')}</ul>` : '<p class="empty">Hier gibt es leider keine https-Sender.</p>';
    syncLists();
    // Karte auf das Land ausrichten
    const pts = countryList.filter(st => st.lat != null);
    if (map && pts.length) {
      const b = window.L.latLngBounds(pts.map(st => [st.lat, st.lng]));
      map.flyToBounds(b.pad(.2), { maxZoom: 6, paddingBottomRight: [0, innerHeight * .45], duration: .9 });
    }
  } catch { if (cpCountry === cc) $('#cp-body').innerHTML = '<p class="empty">Die Sender kommen gerade nicht an.</p>'; }
}

// ---------------------------------------------------------------- Listen (Favoriten, Suche, Land)
function itemHTML(st) {
  const sub = [flag(st.cc) + ' ' + placeOf(st), st.tags?.slice(0, 2).join(', ')].filter(Boolean).join(' · ');
  return `<li data-id="${esc(st.id)}">
    <button class="thumb" type="button" data-a="play" aria-label="Abspielen">${logoHTML(st)}<b>${svg('play')}</b></button>
    <button class="t" type="button" data-a="play"><b>${esc(st.name)}</b><small>${esc(sub)}</small></button>
    <button class="star ${favIds.has(st.id) ? 'on' : ''}" type="button" data-a="fav" aria-label="Favorit">${svg('star')}</button>
  </li>`;
}
function listClick(e, getList) {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const id = b.closest('li')?.dataset.id;
  const st = getList().find(x => x.id === id); if (!st) return;
  haptic();
  if (b.dataset.a === 'fav') { toggleFav(st, b); return; }
  if (now && now.id === st.id && (pstate === 'playing' || pstate === 'loading')) pause();
  else playStation(now && now.id === st.id ? now : st, 'list');
}
function syncLists() {
  document.querySelectorAll('.list li[data-id]').forEach(li => {
    const on = now && li.dataset.id === now.id;
    li.classList.toggle('playing', !!on && pstate === 'playing');
    li.classList.toggle('loading', !!on && pstate === 'loading');
    const b = li.querySelector('.thumb b');
    const want = on && pstate === 'playing' ? 'pause' : 'play';
    if (b && b.dataset.i !== want) { b.dataset.i = want; b.innerHTML = svg(want); }
  });
}

// Suche
const qEl = $('#q'), sCountry = $('#s-country');
let sGenre = '', results = [], searchGen = 0, searchTimer = 0;
const searchActive = () => !!(qEl.value.trim() || sGenre || sCountry.value);
function renderSearchGenres() {
  $('#s-genres').innerHTML = GENRES.slice(1).map(([k, label, tag]) => `<button type="button" class="tchip ${sGenre === tag ? 'on' : ''}" data-tag="${esc(tag)}">${label}</button>`).join('');
}
$('#s-genres').addEventListener('click', e => {
  const b = e.target.closest('[data-tag]'); if (!b) return;
  haptic();
  sGenre = sGenre === b.dataset.tag ? '' : b.dataset.tag;
  renderSearchGenres(); runSearch();
});
qEl.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 400); });
qEl.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(); qEl.blur(); } });
sCountry.addEventListener('change', runSearch);
async function fillCountrySelect() {
  if (sCountry.options.length > 1) return;
  try {
    const list = await loadCountries();
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    sCountry.insertAdjacentHTML('beforeend', sorted.map(c => `<option value="${c.cc}">${flag(c.cc)} ${esc(c.name)}</option>`).join(''));
  } catch {}
}
async function runSearch() {
  clearTimeout(searchTimer);
  const gen = ++searchGen;
  if (!searchActive()) { results = []; renderFavs(); return; }
  const q = qEl.value.trim();
  const params = new URLSearchParams();
  if (q) params.set('name', q);
  if (sGenre) params.set('tag', sGenre);
  if (sCountry.value) params.set('countrycode', sCountry.value);
  $('#list-h').textContent = 'Suche …';
  try {
    const list = await cachedApi(`/json/stations/search?${params}&${Q}&limit=120`, 15000);
    if (gen !== searchGen) return;
    results = stations(list, 60);
    $('#list-h').textContent = results.length ? `${results.length}${results.length === 60 ? '+' : ''} Treffer` : 'Treffer';
    $('#res-list').innerHTML = results.map(itemHTML).join('');
    $('#res-empty').textContent = results.length ? '' : 'Nichts gefunden. Versuch einen kürzeren Namen oder ein anderes Land.';
    syncLists();
  } catch {
    if (gen !== searchGen) return;
    $('#list-h').textContent = 'Treffer';
    $('#res-list').innerHTML = '';
    $('#res-empty').textContent = navigator.onLine ? 'Die Suche kommt gerade nicht an. Gleich noch mal versuchen.' : 'Offline – Suchen braucht Internet.';
  }
}
function renderFavs() {
  if (searchActive()) { runSearch(); return; }
  $('#list-h').textContent = favs.length ? `Favoriten · ${favs.length}` : 'Favoriten';
  $('#res-list').innerHTML = favs.map(itemHTML).join('');
  $('#res-empty').innerHTML = favs.length ? '' : 'Noch keine Favoriten.<br>Tippe auf ⭐ bei einem Sender, um ihn hier zu behalten.';
  syncLists();
}
$('#res-list').addEventListener('click', e => listClick(e, () => searchActive() ? results : favs));
function renderFavsHead() {
  $('#favs-sub').textContent = 'Suche nach Name, Genre oder Land – oder hör deine Favoriten.';
}

// ---------------------------------------------------------------- Ansichten & Leiste unten
const views = { map: $('#view-map'), trip: $('#view-trip'), favs: $('#view-favs'), settings: $('#view-settings') };
const VIEW_ORDER = ['map', 'trip', 'favs', 'settings'];
let view = '';
document.querySelector('.tabbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]'); if (!b) return;
  haptic();
  showView(b.dataset.view);
});
function showView(v) {
  if (!views[v]) v = 'map';
  if (v === view) {
    if (v === 'favs' || v === 'settings') views[v].scrollTo({ top: 0, behavior: 'smooth' });
    if (v === 'map' && map) { cpanel.hidden = true; map.flyTo([28, 12], 2, { duration: .8 }); }
    return;
  }
  const prev = view; view = v; LS.set('view', v);
  for (const [k, el] of Object.entries(views)) el.classList.toggle('active', k === v);
  document.querySelector('.tabbar').style.setProperty('--i', VIEW_ORDER.indexOf(v));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (prev === 'favs') { $('#res-list').innerHTML = ''; }   // Listenbilder freigeben
  if (v === 'map') { initMap().then(() => map?.invalidateSize()); }
  if (v === 'trip') {
    if (!trip.length) fillTrip();
    requestAnimationFrame(() => { layout(); feedEl.scrollTop = cur * H; });
  }
  if (v === 'favs') { renderFavsHead(); renderSearchGenres(); fillCountrySelect(); renderFavs(); }
  if (v === 'settings') renderSettings();
}

// ---------------------------------------------------------------- Einstellungen
const THEMES = [
  { id: 'nacht', name: 'Nacht', bg: '#07080d', sw: 'linear-gradient(135deg, #0b0d18 30%, #3448d6 70%, #7d35c9)' },
  { id: 'sand', name: 'Sand', bg: '#efe6d8', sw: 'linear-gradient(135deg, #f6e9d6 30%, #eec39c 70%, #e7b3a6)' },
  { id: 'salbei', name: 'Salbei', bg: '#e5eadb', sw: 'linear-gradient(135deg, #edf1e3 30%, #b9d6b0 70%, #a9cfc4)' },
  { id: 'himmel', name: 'Himmel', bg: '#e4eaf3', sw: 'linear-gradient(135deg, #eef2f8 30%, #b5cdef 70%, #d5caf0)' },
  { id: 'rose', name: 'Rosé', bg: '#f3e6e4', sw: 'linear-gradient(135deg, #f8ecea 30%, #f0b9c2 70%, #f5d2b9)' },
];
function applyTheme(id) {
  const th = THEMES.find(t => t.id === id) || THEMES[0];
  const changed = document.documentElement.dataset.theme !== th.id;
  document.documentElement.dataset.theme = th.id;
  document.querySelector('meta[name="theme-color"]').content = th.bg;
  document.querySelectorAll('.tpick').forEach(b => { const on = b.dataset.theme === th.id; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  if (changed && map) { tiles.setUrl(tileUrl()); dots.setStyle(dotStyle()); }
}
function renderThemePicks() {
  const box = $('#theme-picks'); box.innerHTML = '';
  for (const th of THEMES) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tpick'; b.setAttribute('role', 'radio'); b.dataset.theme = th.id;
    b.innerHTML = `<i style="background:${th.sw}"></i><span>${th.name}</span>`;
    b.onclick = () => { haptic(); LS.set('theme', th.id); applyTheme(th.id); };
    box.append(b);
  }
  applyTheme(document.documentElement.dataset.theme);
}
const autoskipBox = $('#autoskip'); autoskipBox.checked = autoskip;
autoskipBox.onchange = () => { autoskip = autoskipBox.checked; LS.set('autoskip', autoskip); };
const countBox = $('#count'); countBox.checked = countClicks;
countBox.onchange = () => { countClicks = countBox.checked; LS.set('count', countClicks); };
const calmBox = $('#calm'); calmBox.checked = document.documentElement.classList.contains('calm');
calmBox.onchange = () => { LS.set('calm', calmBox.checked); document.documentElement.classList.toggle('calm', calmBox.checked); };
$('#wipe').onclick = () => {
  if (!confirm('Wirklich alle Weltradio-Daten auf diesem Gerät löschen? Das lässt sich nicht rückgängig machen.')) return;
  Object.keys(localStorage).filter(k => k.startsWith('wr.')).forEach(k => localStorage.removeItem(k));
  location.reload();
};
function renderSettings() {
  const c = heard.cc.length;
  $('#stats').textContent = `${heard.n} Sender gehört · ${c} ${c === 1 ? 'Land' : 'Länder'} bereist · ${favs.length} ${favs.length === 1 ? 'Favorit' : 'Favoriten'}`;
}
renderThemePicks();

// ---------------------------------------------------------------- Begrüßung beim ersten Start
function showOnboarding() {
  const sh = $('#onboard');
  sh.hidden = false;
  const close = () => { LS.set('onb', true); sh.classList.add('out'); setTimeout(() => { sh.hidden = true; sh.classList.remove('out'); }, 360); };
  $('#ob-go').onclick = () => {
    haptic(); close();
    showView('trip');
    // Erstes Abspielen direkt aus dem Tipp (iOS-Freigabe)
    if (trip[cur]) playStation(trip[cur], 'trip');
    else { unlocked = true; toast('Einen Moment, die ersten Sender kommen …'); fillTrip().then(() => { if (trip[cur] && !now) playStation(trip[cur], 'trip'); }); }
  };
  $('#ob-map').onclick = () => { haptic(); close(); showView('map'); };
}

// ---------------------------------------------------------------- Tastatur (Rechner)
document.addEventListener('keydown', e => {
  if (e.target.closest?.('input, select, textarea')) return;
  if (view === 'trip' && (e.key === 'ArrowDown' || e.key === 'j')) { e.preventDefault(); goTo(cur + 1); }
  else if (view === 'trip' && (e.key === 'ArrowUp' || e.key === 'k')) { e.preventDefault(); goTo(cur - 1); }
  else if (e.key === ' ') { e.preventDefault(); if (now) togglePlay(); else if (view === 'trip' && trip[cur]) playStation(trip[cur], 'trip'); }
  else if (e.key === 'f' && now) toggleFav(now);
});
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { layout(); feedEl.scrollTop = cur * H; map?.invalidateSize(); }, 120); });

// ---------------------------------------------------------------- Start
updateFavCount();
renderGenres();
fillTrip();
const firstStart = !LS.get('onb', false);
showView(firstStart ? 'trip' : LS.get('view', 'map'));
if (firstStart) showOnboarding();

// Service Worker: neue Version wird im Hintergrund geladen und gilt ab dem nächsten Start.
// Ist die App gerade offen und spielt nichts, lädt sie sich gleich neu.
let pendingReload = false;
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(reg => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    if (pa.paused) location.reload(); else pendingReload = true;
  });
}
