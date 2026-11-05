/* Cadence standalone runtime — makes dashboard.js work with no backend at all.
   Two sources:
     • demo   → a built-in catalog + a virtual player, so every panel works offline
     • server → your own Cadence/Flask backend (any URL), for real search & audio
   Injected by build_standalone.py; the dashboard logic itself is unchanged. */
(() => {
  'use strict';

  /* Some browsers deny localStorage on file:// (opaque origin) and throw on mere access,
     which would take the whole app down. Fall back to memory so the file always runs. */
  (function ensureStorage() {
    let ok = true;
    try { window.localStorage.getItem('__probe__'); } catch { ok = false; }
    if (ok) return;
    const mem = new Map();
    const shim = {
      getItem: k => (mem.has(String(k)) ? mem.get(String(k)) : null),
      setItem: (k, v) => { mem.set(String(k), String(v)); },
      removeItem: k => { mem.delete(String(k)); },
      clear: () => mem.clear(),
      key: i => [...mem.keys()][i] ?? null,
      get length() { return mem.size; },
    };
    try { Object.defineProperty(window, 'localStorage', { value: shim, configurable: true }); }
    catch { try { window.localStorage = shim; } catch {} }
  })();

  const CFG_KEY = 'cadence:cfg';
  let CFG = { mode: 'demo', base: 'http://localhost:8000' };
  try { Object.assign(CFG, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); } catch {}
  const isDemo = () => CFG.mode !== 'server';

  /* ───────────────────────── deterministic helpers ───────────────────────── */
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const pick = (arr, seed) => arr[hash(String(seed)) % arr.length];
  const range = (n, seed) => Array.from({ length: n }, (_, i) => i + (hash(String(seed)) % 7));

  /* artwork: inline SVG gradient → works offline, from file://, no CORS */
  const artCache = new Map();
  function art(seed, label) {
    if (artCache.has(seed)) return artCache.get(seed);
    const h = hash(seed);
    const h1 = h % 360, h2 = (h1 + 40 + (h >> 8) % 90) % 360;
    const initials = (label || seed).split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${h1} 78% 58%)"/><stop offset="1" stop-color="hsl(${h2} 72% 34%)"/>
</linearGradient><radialGradient id="r" cx="0.25" cy="0.2" r="0.9">
<stop offset="0" stop-color="rgba(255,255,255,.5)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/>
</radialGradient></defs>
<rect width="300" height="300" fill="url(#g)"/><rect width="300" height="300" fill="url(#r)"/>
<circle cx="${60 + h % 180}" cy="${70 + (h >> 5) % 160}" r="${40 + (h >> 9) % 55}" fill="rgba(255,255,255,.14)"/>
<text x="150" y="168" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="86"
 font-weight="700" fill="rgba(255,255,255,.92)" text-anchor="middle">${initials}</text></svg>`;
    const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    artCache.set(seed, uri);
    return uri;
  }

  /* ───────────────────────── the demo catalog ───────────────────────────── */
  const ARTISTS = [
    { name: 'Neon Vesper', genre: 'synthwave', blurb: 'Analog synths, midnight drives.', since: 2014 },
    { name: 'Marta Okonkwo', genre: 'neo-soul', blurb: 'Velvet vocals over warm Rhodes chords.', since: 2011 },
    { name: 'Glass Harbor', genre: 'indie rock', blurb: 'Reverb-soaked guitars from the coast.', since: 2016 },
    { name: 'Kaito Mori', genre: 'lofi', blurb: 'Tape hiss and rainy-window pianos.', since: 2018 },
    { name: 'The Paper Lanterns', genre: 'folk', blurb: 'Harmonies recorded in one room.', since: 2009 },
    { name: 'Solene', genre: 'dream pop', blurb: 'Wide-screen textures, whispered hooks.', since: 2017 },
    { name: 'Ravi Chandran Trio', genre: 'jazz', blurb: 'Modal jazz with modern edges.', since: 2005 },
    { name: 'Basement Choir', genre: 'post-punk', blurb: 'Angular riffs, chorused bass.', since: 2013 },
    { name: 'Aiko & the Static', genre: 'electropop', blurb: 'Glitched beats and bright toplines.', since: 2019 },
    { name: 'Elian Cruz', genre: 'afrobeat', blurb: 'Polyrhythms built for open air.', since: 2012 },
    { name: 'Mira Halloran', genre: 'piano', blurb: 'Solo piano, patient and cinematic.', since: 2008 },
    { name: 'Static Bloom', genre: 'shoegaze', blurb: 'Wall-of-sound guitars, soft focus.', since: 2015 },
  ];
  const GENRE_TITLES = ['synthwave', 'neo-soul', 'indie rock', 'lofi', 'folk', 'dream pop', 'jazz', 'post-punk', 'electropop', 'afrobeat', 'piano', 'shoegaze'];
  const TITLES = {
    'Neon Vesper': ['Midnight Arcade', 'Chrome Horizon', 'Laser Bloom', 'Afterglow Drive'],
    'Marta Okonkwo': ['Honey Static', 'Slow Bloom', 'Kitchen Table', 'Velvet Hours'],
    'Glass Harbor': ['Saltwater Radio', 'Ferry Lights', 'Low Tide Riot', 'Coastline Static'],
    'Kaito Mori': ['Rain on the Balcony', 'Paper Cups', 'Second Coffee', 'Window Seat'],
    'The Paper Lanterns': ['Winter Orchard', 'Hollow Pines', 'Long Way Home', 'Sunday Letters'],
    'Solene': ['Glasshouse', 'Half Light', 'Soft Machine', 'Marble Sky'],
    'Ravi Chandran Trio': ['Blue Interval', 'Snake Charmer', 'Modal Drift', 'Late Set'],
    'Basement Choir': ['Concrete Hymn', 'Sirens', 'Blackout Kids', 'Tape Loop'],
    'Aiko & the Static': ['Pixel Heart', 'Overdrive', 'Glitch Bloom', 'Night Bus'],
    'Elian Cruz': ['Open Air', 'Marimba Sunrise', 'Coast Road', 'Dance Until Dawn'],
    'Mira Halloran': ['Folded Light', 'Nocturne for Rain', 'Six Winters', 'Quiet Room'],
    'Static Bloom': ['Gauze', 'Slow Collapse', 'Hyacinth', 'Feedback Bloom'],
  };
  const ALBUMS = {
    'Neon Vesper': ['Chrome Horizon', 'Night Signals'],
    'Marta Okonkwo': ['Velvet Hours', 'Honey Static'],
    'Glass Harbor': ['Saltwater Radio', 'Low Tide'],
    'Kaito Mori': ['Window Seat', 'Second Coffee'],
    'The Paper Lanterns': ['Winter Orchard', 'Long Way Home'],
    'Solene': ['Glasshouse', 'Half Light'],
    'Ravi Chandran Trio': ['Late Set', 'Modal Drift'],
    'Basement Choir': ['Concrete Hymn', 'Blackout Kids'],
    'Aiko & the Static': ['Pixel Heart', 'Night Bus'],
    'Elian Cruz': ['Open Air', 'Marimba Sunrise'],
    'Mira Halloran': ['Folded Light', 'Quiet Room'],
    'Static Bloom': ['Gauze', 'Hyacinth'],
  };

  const artistId = name => 'AR' + hash(name).toString(36).slice(0, 14);
  const albumId = name => 'AL' + hash(name).toString(36).slice(0, 14);
  const ARTIST_BY_ID = new Map(ARTISTS.map(a => [artistId(a.name), a]));

  const CATALOG = [];
  ARTISTS.forEach((a, ai) => {
    (TITLES[a.name] || []).forEach((title, si) => {
      const alb = ALBUMS[a.name][si % ALBUMS[a.name].length];
      const vid = 'demo' + hash(a.name + title).toString(36).slice(0, 9);
      CATALOG.push({
        video_id: vid,
        title,
        artists: [{ name: a.name, id: artistId(a.name) }],
        artist_text: a.name,
        album: { name: alb, id: albumId(alb) },
        duration: 168 + (hash(vid) % 130),
        year: a.since + (si % 9),
        _genre: a.genre,
      });
    });
  });
  const CAT_BY_ID = new Map(CATALOG.map(t => [t.video_id, t]));
  const artistObj = name => {
    const a = ARTISTS.find(x => x.name === name) || ARTISTS[0];
    return { id: artistId(a.name), name: a.name, thumbnail: 'artist:' + a.name,
             subscribers: ((hash(a.name) % 900) / 100 + 0.4).toFixed(1) + 'M',
             monthly_listeners: 200000 + (hash(a.name) % 8000000) };
  };

  const REGIONS = ['ZZ', 'CH', 'US', 'GB', 'DE', 'FR', 'IT', 'ES', 'AT', 'NL', 'SE', 'NO', 'DK', 'FI', 'BE', 'PT', 'PL', 'CZ', 'IE', 'GR', 'JP', 'KR', 'IN', 'BR', 'MX', 'AR', 'CA', 'AU', 'NZ', 'ZA', 'NG', 'TR'];
  const REGION_NAMES = { ZZ: 'Global', CH: 'Switzerland', US: 'United States', GB: 'United Kingdom', DE: 'Germany', FR: 'France', IT: 'Italy', ES: 'Spain', AT: 'Austria', NL: 'Netherlands', SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', BE: 'Belgium', PT: 'Portugal', PL: 'Poland', CZ: 'Czechia', IE: 'Ireland', GR: 'Greece', JP: 'Japan', KR: 'South Korea', IN: 'India', BR: 'Brazil', MX: 'Mexico', AR: 'Argentina', CA: 'Canada', AU: 'Australia', NZ: 'New Zealand', ZA: 'South Africa', NG: 'Nigeria', TR: 'Türkiye' };

  const MOODS = ['Chill', 'Commute', 'Energize', 'Feel good', 'Focus', 'Romance', 'Sad hours', 'Sleep', 'Workout', 'Dinner party', 'Sunday morning'];
  const GENRES = ['Pop', 'Rock', 'Hip-Hop', 'Electronic', 'Jazz', 'Lo-fi', 'Indie', 'Metal', 'Classical', 'Soul', 'Funk', 'Folk', 'Latin', 'Ambient'];

  /* shuffle that is stable per seed so a page re-render doesn't reshuffle */
  const stableShuffle = (arr, seed) => arr.map(t => [hash(seed + t.video_id), t]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const strip = t => ({ video_id: t.video_id, title: t.title, artists: t.artists, artist_text: t.artist_text, album: t.album, duration: t.duration, year: t.year });

  const playlistsFor = (key, seed) => {
    const names = [`${key} Essentials`, `${key} Deep Cuts`, `Late Night ${key}`, `${key} Rising`, `Pure ${key}`, `${key} for the Ride`, `${key} Classics`, `Fresh ${key}`];
    return names.map((title, i) => ({
      title, id: 'PL' + hash(key + title).toString(36).slice(0, 14),
      thumbnail: art('pl:' + key + title, title), count: 18 + (hash(title) % 40), _key: key, _i: i,
    }));
  };

  /* ───────────────────────── simulated engine telemetry ──────────────────── */
  const STARTED = Date.now();
  const STATS = { cached_bytes: 0, cached_tracks: 0, downloads: 0, download_failures: 0, secs: 0, downloads_inflight: 0 };
  const CACHED = new Map();   // video_id → bytes, so the tile reports distinct tracks
  const CACHE_LIMIT = 3 * 1024 * 1024 * 1024;

  /* ───────────────────────── the demo "API" ──────────────────────────────── */
  function demoApi(path) {
    const [rawPath, qs] = path.split('?');
    const q = new URLSearchParams(qs || '');
    const p = rawPath.replace(/\/+$/, '');

    if (p === '/api/stats') {
      return { cached_tracks: STATS.cached_tracks, cached_bytes: STATS.cached_bytes, downloads: STATS.downloads,
        download_failures: STATS.download_failures, avg_download_seconds: STATS.downloads ? +(STATS.secs / STATS.downloads).toFixed(2) : null,
        downloads_inflight: STATS.downloads_inflight, bytes_served: STATS.cached_bytes,
        uptime_seconds: Math.round((Date.now() - STARTED) / 1000), cache_limit_bytes: CACHE_LIMIT };
    }
    if (p.startsWith('/api/ready/')) return { cached: true, bytes: 3_400_000 + (hash(p) % 900_000) };

    if (p === '/api/genres') {
      return { categories: [
        { title: 'Moods & moments', items: MOODS.map(m => ({ title: m, params: 'mood:' + m })) },
        { title: 'Genres', items: GENRES.map(g => ({ title: g, params: 'genre:' + g })) },
      ] };
    }
    if (p === '/api/genre') {
      const params = q.get('params') || '';
      const key = params.split(':').slice(1).join(':') || 'Chill';
      return { playlists: playlistsFor(key, params) };
    }
    if (p === '/api/playlist') {
      const id = q.get('id') || '';
      const limit = Math.min(Number(q.get('limit') || 80) || 80, 150);
      const pl = playlistsFor('Chill', 'x').find(x => x.id === id);
      const key = id.slice(2, 6) || 'chill';
      const tracks = stableShuffle(CATALOG, key).slice(0, limit).map(strip);
      return { title: pl ? pl.title : 'Playlist', author: 'Cadence demo library', track_count: tracks.length, tracks };
    }
    if (p === '/api/album') {
      const id = q.get('id') || '';
      const name = ARTISTS.map(a => ALBUMS[a.name]).flat().find(al => albumId(al) === id) || 'Chrome Horizon';
      const tracks = CATALOG.filter(t => t.album && t.album.name === name).map(strip);
      const year = tracks.length ? tracks[0].year : 2024;
      return { id, title: name, year, artist: tracks.length ? tracks[0].artist_text : '', tracks };
    }
    if (p === '/api/artist') {
      const name = q.get('name') || (ARTIST_BY_ID.get(q.get('id') || '') || {}).name || 'Neon Vesper';
      const a = ARTISTS.find(x => x.name === name) || ARTISTS[0];
      const top = CATALOG.filter(t => t.artist_text === a.name).map(strip);
      const similar = ARTISTS.filter(x => x.genre !== a.genre).slice(0, 6)
        .map(x => { const o = artistObj(x.name); return { id: o.id, name: o.name, thumbnail: o.thumbnail }; });
      const albums = ALBUMS[a.name].map(al => ({ id: albumId(al), title: al, type: 'Album',
        year: (CATALOG.find(t => t.album.name === al) || {}).year }));
      return { ...artistObj(a.name), description: a.blurb + ' Active since ' + a.since + '.',
        top_tracks: top, similar, albums };
    }
    if (p === '/api/artist/radio') {
      const name = (ARTIST_BY_ID.get(q.get('id') || '') || {}).name || 'Neon Vesper';
      const own = CATALOG.filter(t => t.artist_text === name);
      const others = stableShuffle(CATALOG.filter(t => t.artist_text !== name), name).slice(0, 24);
      return { station_name: name + ' Radio', tracks: [...own, ...others].map(strip) };
    }
    if (p === '/api/radio') {
      const seedId = q.get('videoId') || '';
      const seed = CAT_BY_ID.get(seedId) || CATALOG[0];
      const same = CATALOG.filter(t => t.artist_text === seed.artist_text && t.video_id !== seed.video_id);
      const vibe = stableShuffle(CATALOG.filter(t => t._genre === seed._genre && t.artist_text !== seed.artist_text), seedId);
      const rest = stableShuffle(CATALOG.filter(t => t._genre !== seed._genre), seedId);
      const tracks = [...same, ...vibe, ...rest].slice(0, 25).map(strip);
      return { seed: seed.title, tracks };
    }
    if (p === '/api/suggest') {
      const v = (q.get('q') || '').toLowerCase();
      const pool = [...new Set([...CATALOG.map(t => t.title), ...ARTISTS.map(a => a.name)])];
      return { suggestions: pool.filter(s => s.toLowerCase().includes(v)).slice(0, 8) };
    }
    if (p === '/api/trending') {
      const country = (q.get('country') || 'ZZ').toUpperCase();
      const limit = Math.min(Number(q.get('limit') || 24) || 24, 50);
      const tracks = stableShuffle(CATALOG, 'chart:' + country).slice(0, limit).map(strip);
      const artists = stableShuffle(ARTISTS, 'artists:' + country).slice(0, 20).map((a, i) => {
        const o = artistObj(a.name);
        const trend = hash(a.name + country) % 3;
        return { id: o.id, name: o.name, thumbnail: o.thumbnail, rank: i + 1, trend: trend === 0 ? 'up' : trend === 1 ? 'down' : null };
      });
      return { country, country_name: REGION_NAMES[country] || country, countries: REGIONS, tracks, artists };
    }
    if (p === '/api/search') {
      const term = (q.get('q') || '').toLowerCase().trim();
      const tokens = term.replace(/[-–—]/g, ' ').split(/\s+/).filter(t => t.length > 1);
      const fieldScore = (field, weight) => tokens.reduce((n, tok) => n + (field.includes(tok) ? weight : 0), 0);

      const scored = CATALOG.map(t => {
        const title = t.title.toLowerCase();
        const artist = t.artist_text.toLowerCase();
        const album = ((t.album && t.album.name) || '').toLowerCase();
        const genre = t._genre.toLowerCase();
        let sc = fieldScore(title, 6) + fieldScore(artist, 9) + fieldScore(album, 3) + fieldScore(genre, 4);
        if (term && artist === term) sc += 60;
        if (term && title === term) sc += 55;
        if (term && artist.includes(term)) sc += 25;
        if (term && title.includes(term)) sc += 20;
        // every word matching is much better than a partial match
        if (tokens.length > 1 && tokens.every(tok => (title + ' ' + artist + ' ' + genre).includes(tok))) sc += 18;
        return [sc, t];
      }).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0]).map(x => x[1]);

      // artists: name/genre matches first, then whoever performs the matching songs
      const byName = ARTISTS.filter(a => term && (a.name.toLowerCase().includes(term) ||
        tokens.some(tok => a.name.toLowerCase().includes(tok) || a.genre.includes(tok))));
      const bySong = scored.map(t => ARTISTS.find(a => a.name === t.artist_text)).filter(Boolean);
      const artists = [...new Map([...byName, ...bySong].map(a => [a.name, a])).values()].slice(0, 8)
        .map(a => { const o = artistObj(a.name); return { id: o.id, name: o.name, thumbnail: o.thumbnail }; });

      // honest: no filler tracks when nothing matches
      return {
        tracks: scored.slice(0, 24).map(strip),
        artists,
        demo: true,
        suggestions: scored.length || artists.length ? [] :
          [...new Set([...ARTISTS.map(a => a.name), ...GENRES])].slice(0, 6),
      };
    }
    return {};
  }

  /* ───────────────────────── virtual player (demo mode) ──────────────────── */
  function makeVirtualAudio() {
    const listeners = new Map();
    let timer = null;
    const emit = (type, extra) => (listeners.get(type) || []).forEach(fn => fn(Object.assign({ type, target: el }, extra)));
    const el = {
      currentTime: 0, duration: 0, volume: 0.9, muted: false, paused: true, _src: '',
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      removeEventListener() {},
      dispatchEvent(e) { emit(e && e.type ? e.type : 'unknown'); return true; },
      play() {
        el.paused = false; emit('playing');
        clearInterval(timer);
        timer = setInterval(() => {
          if (el.paused) return;
          el.currentTime = Math.min(el.duration || 0, el.currentTime + 0.25);
          emit('timeupdate');
          if (el.duration && el.currentTime >= el.duration) { clearInterval(timer); el.paused = true; emit('ended'); }
        }, 250);
        return Promise.resolve();
      },
      pause() { el.paused = true; clearInterval(timer); emit('pause'); },
      load() {},
      get src() { return el._src; },
      set src(v) {
        el._src = v;
        const id = String(v).split('/').pop();
        const t = CAT_BY_ID.get(id);
        el.duration = t ? t.duration : 0;
        el.currentTime = 0;
        STATS.downloads += 1; STATS.secs += 0.4 + (hash(id) % 90) / 100;
        if (!CAT_BY_ID.has(id) || CACHED.has(id)) { STATS.downloads_inflight = 0; return; }
        const bytes = Math.round(el.duration * 16000);
        CACHED.set(id, bytes);
        STATS.cached_tracks = CACHED.size;
        STATS.cached_bytes = Math.min(CACHE_LIMIT, STATS.cached_bytes + bytes);
      },
    };
    return el;
  }

  /* ───────────────────────── source dispatcher ───────────────────────────── */
  async function serverFetch(path, opts) {
    let r;
    try { r = await fetch(CFG.base.replace(/\/$/, '') + path, opts); }
    catch (e) {
      const err = new Error('Can\'t reach the Cadence server at ' + CFG.base + ' — check the URL in ⚙ Settings, or switch to Demo mode.');
      err.code = 'offline'; throw err;
    }
    let data = null; try { data = await r.json(); } catch {}
    if (!r.ok) {
      const err = new Error((data && data.error) || `Request failed (${r.status})`);
      err.status = r.status; err.code = data && data.code; err.hint = data && data.hint; throw err;
    }
    return data;
  }

  const SRC = {
    get mode() { return CFG.mode; },
    get base() { return CFG.base; },
    async api(path, opts) {
      if (isDemo()) return demoApi(path);
      return serverFetch(path, opts);
    },
    thumb(vid) { return isDemo() ? art('v:' + vid, (CAT_BY_ID.get(vid) || {}).title || vid) : CFG.base.replace(/\/$/, '') + '/api/thumb/' + vid; },
    img(u) {
      if (isDemo()) {
        const label = String(u).startsWith('artist:') ? String(u).slice(7) : 'Artist';
        return art('i:' + u, label);
      }
      return CFG.base.replace(/\/$/, '') + '/api/img?u=' + encodeURIComponent(u);
    },
    makeAudio(el) {
      if (isDemo()) return makeVirtualAudio();
      // the page may live on another origin, so /api/stream/... must be made absolute
      const base = CFG.base.replace(/\/$/, '');
      try {
        const proto = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, 'src');
        Object.defineProperty(el, 'src', {
          configurable: true,
          get() { return proto.get.call(el); },
          set(v) { proto.set.call(el, String(v).startsWith('/api/') ? base + v : v); },
        });
      } catch {}
      return el;
    },
    async prefetch(id) { if (isDemo()) return; try { await fetch(CFG.base.replace(/\/$/, '') + '/api/prefetch/' + id, { method: 'POST' }); } catch {} },
    async diagnose(id) {
      if (isDemo()) return { kind: 'transient' };
      try {
        const r = await fetch(CFG.base.replace(/\/$/, '') + '/api/stream/' + id, { headers: { Range: 'bytes=0-1' } });
        if (r.ok) return { kind: 'transient' };
        let d = {}; try { d = await r.json(); } catch {}
        return { kind: d.code || 'unknown', message: d.error, hint: d.hint };
      } catch { return { kind: 'offline' }; }
    },
    saveCfg(next) {
      Object.assign(CFG, next);
      try { localStorage.setItem(CFG_KEY, JSON.stringify(CFG)); } catch {}
      location.reload();
    },
  };
  window.__SRC__ = SRC;
  window.__DEMO_CATALOG__ = CATALOG;

  /* ───────────────────────── settings dialog (injected) ──────────────────── */
  function mountUI() {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;
    const pill = document.createElement('button');
    pill.className = 'mode-pill ' + (isDemo() ? 'demo' : 'live');
    pill.id = 'modePill';
    pill.innerHTML = isDemo() ? '● demo' : '● connected';
    pill.title = isDemo() ? 'Demo data — click to connect a backend' : 'Live backend: ' + CFG.base;
    topbar.appendChild(pill);

    const wrap = document.createElement('div');
    wrap.className = 'cfg-overlay';
    wrap.id = 'cfgOverlay';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="cfg-card" role="dialog" aria-modal="true" aria-label="Dashboard settings">
        <h2>Dashboard settings</h2>
        <p class="cfg-sub">This file runs on its own. Point it at a backend for real search and playback — or keep exploring the built-in demo library.</p>
        <label class="cfg-opt"><input type="radio" name="cfgmode" value="demo" ${isDemo() ? 'checked' : ''}>
          <span><b>Demo mode</b><em>Built-in catalog, simulated playback. Works offline, from a file, on any static host.</em></span></label>
        <label class="cfg-opt"><input type="radio" name="cfgmode" value="server" ${isDemo() ? '' : 'checked'}>
          <span><b>Connect to a Cadence backend</b><em>Real YouTube Music search, artist radios and audio streaming.</em></span></label>
        <input class="cfg-url" id="cfgUrl" type="url" placeholder="http://localhost:8000" value="${CFG.base.replace(/"/g, '&quot;')}">
        <div class="cfg-note" id="cfgNote">Run <code>./run.sh</code> in the Cadence project, then use <code>http://localhost:8000</code>.<br>
          If this page is served over <b>https</b>, the backend must be https too (browsers block mixed content).</div>
        <div class="cfg-actions">
          <button class="cfg-btn" id="cfgTest">Test connection</button>
          <button class="cfg-btn primary" id="cfgSave">Save &amp; reload</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const open = () => { wrap.hidden = false; };
    SRC.openSettings = open;
    pill.addEventListener('click', open);
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') wrap.hidden = true; });

    const note = wrap.querySelector('#cfgNote');
    wrap.querySelector('#cfgTest').addEventListener('click', async () => {
      const url = wrap.querySelector('#cfgUrl').value.trim().replace(/\/$/, '') || 'http://localhost:8000';
      note.className = 'cfg-note';
      note.textContent = 'Testing ' + url + ' …';
      try {
        const r = await fetch(url + '/api/stats', { cache: 'no-store' });
        const d = await r.json();
        note.className = 'cfg-note ok';
        note.textContent = `Connected ✓ — ${d.cached_tracks} cached tracks, ${(d.cached_bytes / 1048576).toFixed(1)} MB ready.`;
      } catch {
        note.className = 'cfg-note err';
        note.textContent = 'No answer from ' + url + '. Is the backend running, and does it allow cross-origin requests?';
      }
    });
    wrap.querySelector('#cfgSave').addEventListener('click', () => {
      const mode = wrap.querySelector('input[name="cfgmode"]:checked').value;
      const base = wrap.querySelector('#cfgUrl').value.trim().replace(/\/$/, '') || 'http://localhost:8000';
      SRC.saveCfg({ mode, base });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUI);
  else mountUI();

  /* ── PWA: install banner (Chrome/Edge/Samsung Internet, incl. Android) ── */
  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true;

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    if (isStandalone() || localStorage.getItem('cadence:install-dismissed')) return;
    showInstallBar();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    const bar = document.getElementById('installBar');
    if (bar) bar.remove();
    try { localStorage.setItem('cadence:install-dismissed', '1'); } catch {}
  });

  function showInstallBar() {
    if (document.getElementById('installBar') || isStandalone()) return;
    const bar = document.createElement('div');
    bar.className = 'install-bar';
    bar.id = 'installBar';
    bar.innerHTML = `
      <img src="icons/icon-192.png" alt="" width="40" height="40">
      <div class="ib-text"><b>Install Cadence</b><span>Add it to your home screen — opens full screen, works offline.</span></div>
      <button class="ib-go" id="ibInstall">Install</button>
      <button class="ib-x" id="ibDismiss" aria-label="Not now">✕</button>`;
    document.body.appendChild(bar);
    bar.querySelector('#ibInstall').addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (outcome !== 'accepted') bar.remove();
    });
    bar.querySelector('#ibDismiss').addEventListener('click', () => {
      try { localStorage.setItem('cadence:install-dismissed', '1'); } catch {}
      bar.remove();
    });
  }

  // Android Chrome fires this when the criteria are met; keep the UI in sync if it retries
  setInterval(() => { if (deferredPrompt && !isStandalone()) showInstallBar(); }, 4000);
})();
