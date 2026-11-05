/* ── Cadence dashboard ─────────────────────────────────────────────────────
   Views: overview · search · trending · browse (genres/moods) · artist · album
          playlist · recent           Engine stats + buffer-ahead telemetry.
   ──────────────────────────────────────────────────────────────────────── */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const audio = $('#audio');
const main = $('#main');

/* ── state ──────────────────────────────────────────────────────────────── */
const state = {
  queue: [], queueSource: null, index: -1, current: null,
  shuffle: false, repeat: 0, queueLabel: null, station: null, growing: false,
  suggestionsAdded: 0,
  viewLists: {}, artistCache: {},
  country: localStorage.getItem('cadence:country') || 'CH',
  token: 0, buffered: { id: null, ready: false, bytes: 0 },
};
const LABELS = { search: 'Search results', top: 'Top songs', album: 'Album', recent: 'Recently played',
                 playlist: 'Playlist', trending: 'Trending', over_rec: 'Recently played', feed: 'Suggestions' };

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('cadence:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cadence:' + k, JSON.stringify(v)); } catch {} },
};

/* ── helpers ────────────────────────────────────────────────────────────── */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = n => `<svg aria-hidden="true"><use href="#i-${n}"/></svg>`;
const thumb = vid => `/api/thumb/${vid}`;
const imgp = u => `/api/img?u=${encodeURIComponent(u)}`;
const artistName = t => (t && (t.artist_text || 'Unknown artist')) || 'Unknown artist';

function fmtTime(sec) {
  if (!sec || !isFinite(sec) || sec < 0) return '0:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const fmtBytes = b => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 3);
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtDur = s => { s = Math.round(s || 0); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${s % 60}s`; };

function toast(msg, isErr = false, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  let data = null; try { data = await r.json(); } catch {}
  if (!r.ok) {
    const err = new Error((data && data.error) || `Request failed (${r.status})`);
    err.status = r.status; err.code = data && data.code; err.hint = data && data.hint;
    throw err;
  }
  return data;
}

// A dead <audio> element tells us nothing useful, so ask the server what went wrong.
let blockingReported = false;
async function diagnoseStream(id) {
  try {
    const r = await fetch(`/api/stream/${id}`, { headers: { Range: 'bytes=0-1' } });
    if (r.ok) return { kind: 'transient' };
    let d = {}; try { d = await r.json(); } catch {}
    return { kind: d.code || 'unknown', message: d.error, hint: d.hint };
  } catch {
    return { kind: 'offline' };
  }
}

function reportBlocked(info) {
  if (blockingReported) return;
  blockingReported = true;
  toast(`${info.message || 'Playback is blocked'} ${info.hint ? '— ' + info.hint : ''}`, true, 12000);
  const badge = $('#radioBadge');
  if (badge) { badge.hidden = false; badge.textContent = 'streaming blocked'; }
}

const artistHref = a => `#/artist/${a.id ? encodeURIComponent(a.id) : ''}?name=${encodeURIComponent(a.name || '')}`;

// On touch screens a tap on a track row gets "adjusted" by the browser to the nearest
// link — so the artist name inside a row would hijack taps meant to play the song.
// Rows stay plain text on touch; artists remain reachable via cards and the hero buttons.
const COARSE_POINTER = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);

function artistLink(a) {
  if (COARSE_POINTER) return esc(a.name);
  // real hash link: shareable + right-clickable, and works even when the API gives no browse id
  return `<a href="${artistHref(a)}" data-artist data-artist-id="${esc(a.id || '')}" data-artist-name="${esc(a.name)}">${esc(a.name)}</a>`;
}

/* ── shared renderers ───────────────────────────────────────────────────── */
function trackRows(tracks, listName, opts = {}) {
  if (!tracks || !tracks.length) return `<div class="empty-panel">No tracks here.</div>`;
  const showAlbum = opts.showAlbum !== false;
  return `<div class="tracks${opts.showAlbum === false ? ' compact' : ''}">` + tracks.map((t, i) => `
    <div class="trow" data-vid="${esc(t.video_id)}" data-list="${esc(listName)}" data-i="${i}">
      <div class="idx"><span class="num" data-n="${opts.startNum ? opts.startNum + i : i + 1}">${opts.startNum ? opts.startNum + i : i + 1}</span>
        <span class="playicon">${icon('play')}</span></div>
      <img class="art" src="${thumb(t.video_id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="meta">
        <div class="tt">${esc(t.title)}</div>
        <div class="ta">${(t.artists || []).map(artistLink).join(', ') || esc(artistName(t))}</div>
      </div>
      ${showAlbum ? `<div class="album">${t.album && t.album.id ? `<a data-album="${esc(t.album.id)}" href="#/album/${encodeURIComponent(t.album.id)}">${esc(t.album.name || '')}</a>` : esc((t.album && t.album.name) || '')}</div>` : '<div class="album"></div>'}
      <div class="end">
        <button class="icon-btn addq" data-action="similar" title="Play similar songs">${icon('spark')}</button>
        <button class="icon-btn addq" data-action="queue" title="Add to queue">${icon('plus')}</button>
        <span>${esc(fmtTime(t.duration))}</span>
      </div>
    </div>`).join('') + `</div>`;
}

function skeletons(n = 8) { return Array.from({ length: n }, () => `<div class="skeleton"></div>`).join(''); }

const initials = name => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

function artistCard(a) {
  const src = a.thumbnail ? imgp(a.thumbnail) : '';
  const pic = src
    ? `<img src="${src}" alt="" loading="lazy" onerror="this.classList.add('is-broken');this.style.display='none';this.nextElementSibling.style.display='grid'"><div class="ph ph-ini" style="display:none">${esc(initials(a.name))}</div>`
    : `<div class="ph ph-ini">${esc(initials(a.name))}</div>`;
  const trend = a.trend === 'up' ? ' <span class="trend-up">▲</span>' : a.trend === 'down' ? ' <span class="trend-down">▼</span>' : '';
  return `<button class="artist-card" data-artist data-artist-id="${esc(a.id || '')}" data-artist-name="${esc(a.name)}">
    ${pic}
    <div class="n">${esc(a.name)}</div>
    <div class="s">${a.rank ? `#${a.rank} · ` : ''}${esc(a.subscribers || 'Artist')}${trend}</div>
  </button>`;
}

function markNowPlaying() {
  const vid = state.current && state.current.video_id;
  document.querySelectorAll('.trow, .qrow, .feed-row').forEach(el => {
    const on = vid && el.dataset.vid === vid;
    el.classList.toggle('now', !!on);
    const num = el.querySelector('.idx .num');
    if (num) num.innerHTML = on ? `<span class="nowbars"><i></i><i></i><i></i></span>` : (num.dataset.n || '');
  });
}

/* ── router ─────────────────────────────────────────────────────────────── */
const routes = {
  overview: () => renderOverview(),
  search: q => renderSearchView(q.get('q') || ''),
  trending: () => renderTrendingView(),
  browse: () => renderBrowse(),
  genre: (q, path) => renderGenre(path, q.get('title') || ''),
  playlist: (q, path) => renderPlaylist(path, q.get('title') || ''),
  album: (q, path) => renderAlbum(path),
  artist: (q, path) => renderArtistView(path, q.get('name') || ''),
  recent: () => renderRecentView(),
};

function go(route) { location.hash = '#' + route; }
function currentRoute() { const h = location.hash.replace(/^#\/?/, '') || 'overview'; return '/' + h; }

function renderRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'overview';
  const [pathPart, queryPart] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean);
  const name = segs[0] || 'overview';
  const arg = segs[1] ? decodeURIComponent(segs.slice(1).join('/')) : '';
  const q = new URLSearchParams(queryPart || '');
  const fn = routes[name] || routes.overview;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  main.scrollTop = 0;
  fn(q, arg);
}

/* ── overview ───────────────────────────────────────────────────────────── */
async function renderOverview() {
  const token = ++state.token;
  const recent = LS.get('recent', []).slice(0, 6);

  main.innerHTML = `
    <section class="stats" id="statTiles">
      ${statNowPlaying()} ${statQueue()} ${statBuffer()} ${statRadio()}
    </section>

    <div class="grid2">
      <section class="panel" id="npPanel">
        <div class="panel-head"><h2>${icon('play')}Now playing</h2><span class="badge" id="npBadge" hidden>${icon('spark')}Radio</span></div>
        <div class="panel-body" id="npBody">${nowPlayingHero()}</div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>${icon('spark')}Suggestion feed</h2>
          <span style="font-size:11.5px;color:var(--dim)" id="feedCount"></span>
        </div>
        <div class="panel-body tight" id="feedBody"></div>
        <div class="panel-foot">
          <button class="link-btn" id="moreSuggestions">${icon('spark')}Load more suggestions</button>
        </div>
      </section>
    </div>

    <div class="grid2">
      <section class="panel">
        <div class="panel-head">
          <h2>${icon('play')}Trending in <span id="trendRegion">…</span></h2>
          <button class="link-btn" data-nav-to="trending">Open charts</button>
        </div>
        <div class="panel-body tight" id="trendMini">${skeletons(5)}</div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>${icon('artist')}Trending artists</h2></div>
        <div class="artist-strip" id="artistMini">${skeletons(4)}</div>
      </section>
    </div>

    ${recent.length ? `<section class="panel" style="margin-top:16px">
      <div class="panel-head"><h2>${icon('queue')}Recently played</h2>
        <button class="link-btn" data-nav-to="recent">See all</button></div>
      <div class="panel-body tight">${trackRows(recent, 'over_rec', { showAlbum: false })}</div>
    </section>` : ''}`;

  state.viewLists.over_rec = recent;
  paintFeed();
  paintNowPlaying();
  $('#moreSuggestions').addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    const grew = await growQueue(true);
    e.currentTarget.disabled = false;
    if (!grew) toast('No more suggestions for this track', true);
  });
  main.querySelectorAll('[data-nav-to]').forEach(b => b.addEventListener('click', () => go('/' + b.dataset.navTo)));

  // trending panels
  try {
    const data = await api(`/api/trending?country=${state.country}&limit=12`);
    if (token !== state.token) return;
    fillCountrySelect(data.countries);
    const region = $('#trendRegion'); if (region) region.textContent = data.country_name;
    const mini = $('#trendMini');
    if (mini) {
      state.viewLists.trending = data.tracks;
      mini.innerHTML = trackRows(data.tracks.slice(0, 5), 'trending', { startNum: 1, showAlbum: false });
    }
    const strip = $('#artistMini');
    if (strip) strip.innerHTML = data.artists.slice(0, 8).map(artistCard).join('') || '<div class="empty-panel">No chart data</div>';
    markNowPlaying();
  } catch (e) {
    const mini = $('#trendMini'); if (mini) mini.innerHTML = `<div class="empty-panel">Charts unavailable — ${esc(e.message)}</div>`;
    const strip = $('#artistMini'); if (strip) strip.innerHTML = '';
  }
}

function nowPlayingHero() {
  const t = state.current;
  if (!t) return `<div class="np-hero"><div class="art">${icon('artist')}</div>
    <div class="info"><h1 style="color:var(--muted)">Nothing playing</h1>
    <div class="byline">Search for a song, or start a station from the panels below.</div>
    <div class="facts hero-tip">Tip: press <span class="kbd-hint">/</span> to jump to search, <span class="kbd-hint">space</span> to play/pause.</div>
    <div class="facts hero-tip-touch">Tap a row to play, or open Trending and Genres below.</div>
    <div class="hero-btns">
      <button class="chip strong" data-action="surprise">${icon('spark')}&nbsp;Surprise me</button>
    </div></div></div>`;
  return `<div class="np-hero" id="heroBox">
    <div class="art"><img src="${thumb(t.video_id)}" alt=""></div>
    <div class="info">
      <div class="badges">
        <span class="badge">${icon('play')}<span id="heroState">Loading…</span></span>
        ${state.station ? `<span class="badge">${icon('spark')}${esc(state.station)}</span>` : ''}
      </div>
      <h1>${esc(t.title)}</h1>
      <div class="byline">${(t.artists || []).map(artistLink).join(', ') || esc(artistName(t))}</div>
      <div class="facts" id="heroFacts">${esc(t.album && t.album.name || '')}${t.duration ? ` · ${fmtTime(t.duration)}` : ''}</div>
      <div class="hero-btns">
        <button class="chip strong" data-action="playpause">${icon('play')}&nbsp;<span id="heroBtnLabel">Play</span></button>
        <button class="chip" data-action="similar-now">${icon('spark')}&nbsp;Play similar songs</button>
        ${firstArtistId(t) ? `<button class="chip" data-action="artist-radio" data-artist-id="${esc(firstArtistId(t))}" data-artist-name="${esc(artistName(t))}">${icon('spark')}&nbsp;Artist radio</button>` : ''}
        ${firstArtistId(t) ? `<button class="chip" data-artist data-artist-id="${esc(firstArtistId(t))}" data-artist-name="${esc(artistName(t))}">${icon('artist')}&nbsp;Open artist</button>` : ''}
      </div>
    </div></div>`;
}
function firstArtistId(t) { return ((t && t.artists) || []).find(a => a.id)?.id || null; }

/* stat tiles */
function statNowPlaying() {
  const t = state.current;
  return `<div class="tile" id="tileNow"><div class="t-label">${icon('play')}Now playing</div>
    <div class="t-main" id="tnTitle">${t ? esc(t.title) : '—'}</div>
    <div class="t-sub" id="tnSub">${t ? esc(artistName(t)) : 'nothing loaded'}</div></div>`;
}
function statQueue() {
  return `<div class="tile" id="tileQueue"><div class="t-label">${icon('queue')}Queue</div>
    <div class="t-main" id="tqMain">${state.queue.length} tracks</div>
    <div class="t-sub" id="tqSub">${state.current ? `track ${state.index + 1} of ${state.queue.length}` : 'idle'}</div></div>`;
}
function statBuffer() {
  return `<div class="tile" id="tileBuf"><div class="t-label">${icon('play')}Buffered ahead</div>
    <div class="t-main" id="tbMain">–</div>
    <div class="t-sub" id="tbSub">waiting for playback</div></div>`;
}
function statRadio() {
  return `<div class="tile" id="tileRadio"><div class="t-label">${icon('spark')}Radio engine</div>
    <div class="t-main" id="trMain">${state.suggestionsAdded} suggested</div>
    <div class="t-sub" id="trSub">${state.radioLabel ? esc(state.radioLabel) : 'no station yet'}</div></div>`;
}

function paintNowPlaying() {
  const token = state.token;
  const body = $('#npBody');
  if (body) body.innerHTML = nowPlayingHero();
  const tn = $('#tnTitle'), ts = $('#tnSub');
  if (tn) tn.textContent = state.current ? state.current.title : '—';
  if (ts) ts.textContent = state.current ? artistName(state.current) : 'nothing loaded';
  updateHeroState();
  paintStats();
  void token;
}

function updateHeroState() {
  const el = $('#heroState'), label = $('#heroBtnLabel');
  if (el) el.textContent = state.current ? (audio.paused ? 'Paused' : 'Playing') : '';
  if (label) label.textContent = audio.paused ? 'Play' : 'Pause';
}

function paintStats() {
  const q = $('#tqMain'); if (q) { q.textContent = `${state.queue.length} tracks`; $('#tqSub').textContent = state.current ? `track ${state.index + 1} of ${state.queue.length}` : 'idle'; }
  const r = $('#trMain'); if (r) { r.textContent = `${state.suggestionsAdded} suggested`; $('#trSub').textContent = state.station || state.queueLabel || 'no station yet'; }
  const badge = $('#npBadge');
  if (badge) badge.hidden = !state.station;
  const tb = $('#tbMain'), tbs = $('#tbSub');
  if (tb && tbs) {
    if (!state.buffered.id) { tb.textContent = '–'; tbs.textContent = 'waiting for playback'; }
    else if (state.buffered.ready) { tb.textContent = 'Ready ✓'; tbs.textContent = `${fmtBytes(state.buffered.bytes)} cached for the next track`; $('.tile')?.classList.add('ok'); $('#tileBuf')?.classList.add('ok'); }
    else { tb.textContent = 'Buffering…'; tbs.textContent = 'next track is being fetched'; $('#tileBuf')?.classList.remove('ok'); }
  }
  const heroFacts = $('#heroFacts');
  if (heroFacts && state.current) {
    const d = audio.duration || state.current.duration || 0;
    heroFacts.textContent = [state.current.album && state.current.album.name, d ? fmtTime(d) : '', audio.currentTime ? `${fmtTime(audio.currentTime)} elapsed` : '']
      .filter(Boolean).join(' · ');
  }
}

/* suggestion feed */
function paintFeed() {
  const body = $('#feedBody'); if (!body) return;
  const upcoming = state.queue.slice(state.index + 1, state.index + 8);
  const count = $('#feedCount');
  if (count) count.textContent = state.queue.length > state.index + 1 ? `${state.queue.length - state.index - 1} in queue` : '';
  if (!upcoming.length) {
    body.innerHTML = `<div class="empty-panel">${state.current
      ? 'Queue is running low — suggestions will appear in a moment.'
      : 'Play something and Cadence will suggest what comes next.'}</div>`;
    return;
  }
  const curArtist = state.current ? artistName(state.current) : '';
  body.innerHTML = `<div class="feed">` + upcoming.map((t, i) => {
    const sameArtist = state.current && artistName(t) === curArtist;
    const reason = i === 0 ? 'Up next' : sameArtist ? `More from ${esc(artistName(t))}` : `Similar to ${esc(curArtist)}`;
    const qi = state.index + 1 + i;
    return `<div class="feed-row" data-vid="${esc(t.video_id)}" data-qi="${qi}">
      <img src="${thumb(t.video_id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div style="min-width:0">
        <div class="ft">${esc(t.title)}</div>
        <div class="fa">${esc(artistName(t))}<span class="reason">${reason}</span></div>
      </div>
      <span style="font-size:11.5px;color:var(--dim)">${esc(fmtTime(t.duration))}</span>
    </div>`;
  }).join('') + `</div>`;
  markNowPlaying();
}

/* ── search ─────────────────────────────────────────────────────────────── */
async function renderSearchView(query) {
  const token = ++state.token;
  if (!query) {
    main.innerHTML = `<div class="view-head"><div><h1>Search</h1><div class="sub">Find any song, artist, album or playlist on YouTube Music.</div></div></div>
      <section class="panel"><div class="panel-body">
        <div class="chips">${['Queen', 'Daft Punk', 'Drake', 'Lo-fi beats', 'Nina Simone', 'Coldplay', 'Beyoncé', 'Pink Floyd', 'Bad Bunny', 'Jazz classics']
          .map(s => `<button class="chip" data-search="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      </div></section>`;
    return;
  }
  main.innerHTML = `<div class="view-head"><div><h1>“${esc(query)}”</h1><div class="sub">Searching YouTube Music…</div></div></div>${skeletons(8)}`;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}&limit=24`);
    if (token !== state.token) return;
    const tracks = data.tracks || [], artists = data.artists || [];

    // Nothing at all: say so plainly, and offer a way forward instead of an empty page
    if (!tracks.length && !artists.length) {
      const chips = (data.suggestions && data.suggestions.length)
        ? data.suggestions
        : ['daft punk', 'taylor swift', 'jazz classics', 'lo-fi beats'];
      main.innerHTML = `
        <div class="view-head"><div><h1>“${esc(query)}”</h1><div class="sub">No matches</div></div></div>
        <section class="panel"><div class="panel-body">
          <div class="search-empty">
            <div class="se-icon">${icon('search')}</div>
            <h2>Nothing found for “${esc(query)}”</h2>
            <p>${window.__SRC__ && window.__SRC__.mode === 'demo'
              ? 'This file is running in demo mode, so it can only search its built-in library. Connect a backend to search all of YouTube Music.'
              : 'Try a different spelling, or one of these searches:'}</p>
            <div class="chips" style="justify-content:center">${chips.map(c => `<button class="chip" data-search="${esc(c)}">${esc(c)}</button>`).join('')}</div>
            ${window.__SRC__ && window.__SRC__.mode === 'demo'
              ? '<button class="link-btn" style="margin-top:14px" data-action="open-settings">Connect a backend →</button>' : ''}
          </div>
        </div></section>`;
      return;
    }

    state.viewLists.search = tracks;
    const count = `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}${artists.length ? ` · ${artists.length} ${artists.length === 1 ? 'artist' : 'artists'}` : ''}`;
    main.innerHTML = `
      <div class="view-head"><div><h1>“${esc(query)}”</h1><div class="sub">${count}</div></div></div>
      ${artists.length ? `<section class="panel" style="margin-bottom:16px">
        <div class="panel-head"><h2>${icon('artist')}Artists</h2>
          <span style="font-size:11.5px;color:var(--dim)">${artists.length}</span></div>
        <div class="artist-strip">${artists.slice(0, 10).map(artistCard).join('')}</div></section>` : ''}
      <section class="panel">
        <div class="panel-head"><h2>${icon('play')}Songs</h2>
          ${tracks.length ? `<button class="link-btn" data-action="play-list" data-list="search">${icon('play')}Play all</button>` : ''}</div>
        <div class="panel-body tight">${tracks.length ? trackRows(tracks, 'search') : '<div class="empty-panel">No songs matched — try the artists above.</div>'}</div>
      </section>`;
    markNowPlaying();
  } catch (e) {
    if (token !== state.token) return;
    main.innerHTML = `<div class="view-head"><div><h1>“${esc(query)}”</h1><div class="sub">Search failed</div></div></div>
      <section class="panel"><div class="panel-body"><div class="search-empty">
        <div class="se-icon">${icon('search')}</div>
        <h2>Couldn't run that search</h2>
        <p>${esc(e.message)}</p>
        <button class="chip strong" data-search="${esc(query)}">Try again</button>
      </div></div></section>`;
  }
}

/* ── trending ───────────────────────────────────────────────────────────── */
async function renderTrendingView() {
  const token = ++state.token;
  main.innerHTML = `<div class="view-head"><div><h1>Trending</h1><div class="sub">YouTube Music charts</div></div></div>${skeletons(8)}`;
  try {
    const data = await api(`/api/trending?country=${state.country}&limit=24`);
    if (token !== state.token) return;
    fillCountrySelect(data.countries);
    state.viewLists.trending = data.tracks;
    main.innerHTML = `
      <div class="view-head">
        <div><h1>Trending in ${esc(data.country_name)}</h1><div class="sub">Updated from the YouTube Music charts</div></div>
        <button class="link-btn" data-action="play-list" data-list="trending">${icon('play')}Play the chart</button>
      </div>
      <section class="panel" style="margin-bottom:16px">
        <div class="panel-head"><h2>${icon('play')}Charting tracks</h2><span style="font-size:11.5px;color:var(--dim)">${data.tracks.length} tracks</span></div>
        <div class="panel-body tight">${trackRows(data.tracks, 'trending')}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>${icon('artist')}Trending artists</h2></div>
        <div class="artist-strip">${data.artists.map(artistCard).join('')}</div>
      </section>`;
    markNowPlaying();
  } catch (e) {
    if (token !== state.token) return;
    main.innerHTML = `<div class="empty-panel">Charts unavailable — ${esc(e.message)}</div>`;
  }
}

function fillCountrySelect(options) {
  const sel = $('#countrySel');
  if (!sel || !options || !options.length) return;
  const names = { ZZ: '🌍 Global', CH: '🇨🇭 Switzerland', US: '🇺🇸 United States', GB: '🇬🇧 United Kingdom',
    DE: '🇩🇪 Germany', FR: '🇫🇷 France', IT: '🇮🇹 Italy', ES: '🇪🇸 Spain', AT: '🇦🇹 Austria',
    NL: '🇳🇱 Netherlands', SE: '🇸🇪 Sweden', JP: '🇯🇵 Japan', KR: '🇰🇷 South Korea', BR: '🇧🇷 Brazil',
    CA: '🇨🇦 Canada', AU: '🇦🇺 Australia', IN: '🇮🇳 India', MX: '🇲🇽 Mexico', PL: '🇵🇱 Poland', PT: '🇵🇹 Portugal' };
  if (sel.dataset.filled === options.join(',')) return;
  sel.innerHTML = options.map(c => `<option value="${esc(c)}" ${c === state.country ? 'selected' : ''}>${esc(names[c] || c)}</option>`).join('');
  sel.dataset.filled = options.join(',');
  sel.value = state.country;
}
$('#countrySel').addEventListener('change', e => {
  state.country = e.target.value;
  localStorage.setItem('cadence:country', state.country);
  if ((currentRoute().includes('trending')) || currentRoute() === '/overview') renderRoute();
});

/* ── browse: genres & moods ─────────────────────────────────────────────── */
const GENRE_COLORS = [['#8b5cf6', '#22d3ee'], ['#f472b6', '#8b5cf6'], ['#22d3ee', '#4ade80'], ['#fbbf24', '#f472b6'], ['#60a5fa', '#a78bfa'], ['#4ade80', '#22d3ee']];
async function renderBrowse() {
  const token = ++state.token;
  main.innerHTML = `<div class="view-head"><div><h1>Genres &amp; moods</h1><div class="sub">Browse YouTube Music moods, moments and genres</div></div></div>${skeletons(6)}`;
  try {
    const data = await api('/api/genres');
    if (token !== state.token) return;
    let ci = 0;
    main.innerHTML = `<div class="view-head"><div><h1>Genres &amp; moods</h1><div class="sub">Pick a vibe — every tile leads to ready-made playlists</div></div></div>` +
      data.categories.map(cat => `
        <section class="panel" style="margin-bottom:16px">
          <div class="panel-head"><h2>${icon('queue')}${esc(cat.title)}</h2><span style="font-size:11.5px;color:var(--dim)">${cat.items.length} tiles</span></div>
          <div class="panel-body">
            <div class="tiles">${cat.items.map(it => {
              const [a, b] = GENRE_COLORS[ci++ % GENRE_COLORS.length];
              return `<button class="tile-btn" data-genre="${esc(it.params)}" data-title="${esc(it.title)}">
                <span class="tb-glow" style="background:radial-gradient(circle,${a},${b})"></span>
                <span class="tb-title">${esc(it.title)}</span>
                <span class="tb-sub">Open playlists →</span></button>`;
            }).join('')}</div>
          </div>
        </section>`).join('');
  } catch (e) {
    if (token !== state.token) return;
    main.innerHTML = `<div class="empty-panel">Couldn't load genres — ${esc(e.message)}</div>`;
  }
}

async function renderGenre(params, title) {
  const token = ++state.token;
  main.innerHTML = `<div class="crumbs"><button data-nav-to="browse">Genres &amp; moods</button>› <span>${esc(title)}</span></div>${skeletons(6)}`;
  try {
    const data = await api(`/api/genre?params=${encodeURIComponent(params)}`);
    if (token !== state.token) return;
    main.innerHTML = `
      <div class="crumbs"><button data-nav-to="browse">Genres &amp; moods</button>› <span>${esc(title)}</span></div>
      <div class="view-head"><div><h1>${esc(title)}</h1><div class="sub">${data.playlists.length} playlists curated by YouTube Music</div></div></div>
      <div class="tiles">${data.playlists.map(p => `
        <button class="tile-btn" data-playlist="${esc(p.id)}" data-title="${esc(p.title)}" style="min-height:168px;padding:0;display:flex;flex-direction:column">
          <span style="display:block;width:100%;aspect-ratio:16/10;background:linear-gradient(135deg,#1e1e2f,#12121c);overflow:hidden">
            ${p.thumbnail ? `<img src="${imgp(p.thumbnail)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">` : ''}
          </span>
          <span style="padding:11px 12px;display:block">
            <span class="tb-title" style="font-size:13.5px">${esc(p.title)}</span>
            <span class="tb-sub">${esc(p.count || '')} ${p.count ? 'songs' : 'playlist'}</span>
          </span>
        </button>`).join('')}</div>`;
  } catch (e) {
    if (token !== state.token) return;
    main.innerHTML = `<div class="empty-panel">Couldn't load playlists — ${esc(e.message)}</div>`;
  }
}

async function renderPlaylist(id, title) {
  const token = ++state.token;
  main.innerHTML = `<div class="crumbs"><button data-nav-to="browse">Genres &amp; moods</button>› <span>${esc(title || 'Playlist')}</span></div>${skeletons(8)}`;
  try {
    const data = await api(`/api/playlist?id=${encodeURIComponent(id)}&limit=80`);
    if (token !== state.token) return;
    state.viewLists.playlist = data.tracks;
    main.innerHTML = `
      <div class="crumbs"><button data-nav-to="browse">Genres &amp; moods</button>› <span>${esc(data.title || title)}</span></div>
      <div class="view-head">
        <div><h1>${esc(data.title || title)}</h1><div class="sub">${data.tracks.length} tracks${data.author ? ' · ' + esc(data.author) : ''}</div></div>
        <button class="link-btn" data-action="play-list" data-list="playlist">${icon('play')}Play playlist</button>
      </div>
      <section class="panel"><div class="panel-body tight">${trackRows(data.tracks, 'playlist')}</div></section>`;
    markNowPlaying();
  } catch (e) {
    if (token !== state.token) return;
    main.innerHTML = `<div class="empty-panel">Couldn't load playlist — ${esc(e.message)}</div>`;
  }
}

/* ── artist / album ─────────────────────────────────────────────────────── */
async function renderArtistView(id, name) {
  const token = ++state.token;
  main.innerHTML = `<div class="view-head"><div><h1>${esc(name || '…')}</h1><div class="sub">Loading artist…</div></div></div>${skeletons(8)}`;
  try {
    const qs = (id && id !== 'undefined') ? `id=${encodeURIComponent(id)}` : `name=${encodeURIComponent(name || '')}`;
    const a = await api(`/api/artist?${qs}`);
    if (token !== state.token) return;
    state.viewLists.top = a.top_tracks;
    const listeners = a.monthly_listeners ? `${Number(a.monthly_listeners).toLocaleString()} monthly listeners` : '';
    main.innerHTML = `
      <div class="artist-head">
        <img src="${a.thumbnail ? imgp(a.thumbnail) : ''}" alt="" onerror="this.style.visibility='hidden'">
        <div class="ah-text">
          <div class="eyebrow">Artist</div>
          <h1>${esc(a.name)}</h1>
          <div class="stats">${[a.subscribers ? `${a.subscribers} subscribers` : '', listeners].filter(Boolean).join(' · ')}</div>
          ${a.description ? `<p class="desc">${esc(a.description)}</p>` : ''}
          <div class="chips" style="margin-top:14px">
            <button class="chip strong" data-action="artist-radio" data-artist-id="${esc(a.id)}" data-artist-name="${esc(a.name)}">${icon('spark')}&nbsp;Play artist radio</button>
            ${a.top_tracks.length ? `<button class="chip" data-action="play-list" data-list="top">${icon('play')}&nbsp;Play top songs</button>` : ''}
          </div>
        </div>
      </div>
      <div class="grid2">
        <section class="panel">
          <div class="panel-head"><h2>${icon('play')}Top songs</h2></div>
          <div class="panel-body tight">${trackRows(a.top_tracks, 'top')}</div>
        </section>
        <div style="display:flex;flex-direction:column;gap:16px">
          ${a.similar.length ? `<section class="panel">
            <div class="panel-head"><h2>${icon('artist')}Fans also like</h2></div>
            <div class="artist-strip">${a.similar.map(s => artistCard({ id: s.id, name: s.name, thumbnail: s.thumbnail })).join('')}</div></section>` : ''}
          ${a.albums.length ? `<section class="panel">
            <div class="panel-head"><h2>${icon('queue')}Albums &amp; singles</h2></div>
            <div class="panel-body tight">${a.albums.map(al => `
              <div class="feed-row" data-album="${esc(al.id)}" style="grid-template-columns:minmax(0,1fr) auto">
                <div style="min-width:0"><div class="ft">${esc(al.title)}</div><div class="fa">${esc(al.type)}${al.year ? ' · ' + al.year : ''}</div></div>
                <span style="color:var(--dim);font-size:12px">open →</span>
              </div>`).join('')}</div></section>` : ''}
        </div>
      </div>`;
    markNowPlaying();
  } catch (e) {
    if (token !== state.token) return;
    main.innerHTML = `<div class="empty-panel">Couldn't load artist — ${esc(e.message)}</div>`;
  }
}

async function renderAlbum(id) {
  const token = ++state.token;
  main.innerHTML = `<div class="crumbs"><button data-nav-to="overview">Dashboard</button>› <span>Album</span></div>${skeletons(8)}`;
  try {
    const al = await api(`/api/album?id=${encodeURIComponent(id)}`);
    if (token !== state.token) return;
    state.viewLists.album = al.tracks;
    main.innerHTML = `
      <div class="crumbs"><button data-nav-to="overview">Dashboard</button>› <span>Album</span></div>
      <div class="view-head">
        <div><h1>${esc(al.title)}</h1><div class="sub">${[al.year, `${al.tracks.length} tracks`].filter(Boolean).join(' · ')}</div></div>
        <button class="link-btn" data-action="play-list" data-list="album">${icon('play')}Play album</button>
      </div>
      <section class="panel"><div class="panel-body tight">${trackRows(al.tracks, 'album')}</div></section>`;
    markNowPlaying();
  } catch (e) {
    if (token !== state.token) return;
    main.innerHTML = `<div class="empty-panel">Couldn't load album — ${esc(e.message)}</div>`;
  }
}

/* ── recently played ────────────────────────────────────────────────────── */
function renderRecentView() {
  state.token++;
  const recent = LS.get('recent', []);
  state.viewLists.recent = recent;
  main.innerHTML = `
    <div class="view-head">
      <div><h1>Recently played</h1><div class="sub">${recent.length} tracks from this browser</div></div>
      ${recent.length ? `<button class="link-btn" data-action="play-list" data-list="recent">${icon('play')}Play all</button>` : ''}
    </div>
    <section class="panel"><div class="panel-body tight">${recent.length ? trackRows(recent, 'recent') : '<div class="empty-panel">Nothing played yet.</div>'}</div></section>`;
  markNowPlaying();
}

/* ── playback ───────────────────────────────────────────────────────────── */
function setQueue(list, startIndex, label, station = null) {
  state.queue = list.slice();
  state.queueSource = list;
  state.index = startIndex;
  state.queueLabel = label || null;
  state.station = station || null;
  refreshQueue();
}

function playTrackAt(i, { addToHistory = true } = {}) {
  if (i < 0 || i >= state.queue.length) return;
  const t = state.queue[i];
  if (addToHistory && state.current) state.history = state.history || [];
  state.index = i;
  state.current = t;

  $('#npTitle').textContent = t.title;
  $('#npArtist').innerHTML = (t.artists || []).map(artistLink).join(', ') || esc(artistName(t));
  $('#npArt').innerHTML = `<img src="${thumb(t.video_id)}" alt="">`;
  $('#radioBadge').hidden = !state.station;
  document.title = `${t.title} · ${artistName(t)} — Cadence`;
  updateMediaSession(t);

  setLoading(true);
  audio.src = `/api/stream/${t.video_id}`;
  audio.play().catch(err => {
    setLoading(false);
    if (!err || err.name === 'AbortError') return;
    // give the stream diagnosis a moment to speak first — it knows the real reason
    setTimeout(() => { if (!blockingReported) toast('Playback blocked — press play to start', true); }, 1500);
  });

  remember(t);
  bufferAhead();
  markNowPlaying();
  refreshQueue();
  paintNowPlaying();
  paintFeed();
  maybeGrow();
}

function remember(t) {
  const recent = LS.get('recent', []).filter(x => x.video_id !== t.video_id);
  recent.unshift({ video_id: t.video_id, title: t.title, artists: t.artists, artist_text: t.artist_text, album: t.album, duration: t.duration });
  LS.set('recent', recent.slice(0, 20));
}

function togglePlay() {
  if (!state.current) { go('/search'); toast('Pick a song first 🙂'); return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

function next(auto = false) {
  if (!state.queue.length) return;
  if (state.repeat === 2 && auto) { audio.currentTime = 0; audio.play(); return; }
  let i;
  if (state.shuffle) { do { i = Math.floor(Math.random() * state.queue.length); } while (state.queue.length > 1 && i === state.index); }
  else i = state.index + 1;
  if (i >= state.queue.length) {
    if (state.repeat === 1 || auto) {
      growQueue().then(grew => {
        if (grew) playTrackAt(state.index + 1);
        else if (state.repeat === 1) playTrackAt(0);
        else { toast('End of queue'); audio.pause(); }
      });
      return;
    }
    playTrackAt(0); return;
  }
  playTrackAt(i);
}
function prev() {
  if (audio.currentTime > 4 || !state.queue.length) { audio.currentTime = 0; return; }
  playTrackAt(Math.max(0, state.index - 1));
}

async function growQueue(force = false) {
  if (state.growing) return false;
  const seed = (state.current && state.current.video_id) || null;
  if (!seed) return false;
  state.growing = true;
  try {
    const data = await api(`/api/radio?videoId=${seed}&limit=25`);
    const have = new Set(state.queue.map(t => t.video_id));
    const fresh = (data.tracks || []).filter(t => !have.has(t.video_id));
    if (!fresh.length) return false;
    state.queue.push(...fresh);
    state.suggestionsAdded += fresh.length;
    state.station = 'Radio · ' + (state.current ? artistName(state.current) : 'station');
    refreshQueue(); paintFeed(); paintStats();
    $('#radioBadge').hidden = false;
    if (force) toast(`+${fresh.length} suggestions queued`);
    return true;
  } catch (e) {
    toast('Couldn\'t load suggestions: ' + e.message, true);
    return false;
  } finally { state.growing = false; }
}
function maybeGrow() { if (state.shuffle || state.repeat === 2) return; if (state.queue.length - state.index <= 4) growQueue(); }

/* buffer-ahead telemetry */
async function bufferAhead() {
  const nxt = state.queue[state.index + 1];
  state.buffered = { id: nxt ? nxt.video_id : null, ready: false, bytes: 0 };
  paintStats();
  if (!nxt) return;
  try { await fetch(`/api/prefetch/${nxt.video_id}`, { method: 'POST' }); } catch {}
  for (let attempt = 0; attempt < 24; attempt++) {
    await new Promise(r => setTimeout(r, attempt < 6 ? 250 : 800));
    if (state.buffered.id !== nxt.video_id) return;   // track changed meanwhile
    try {
      const d = await api(`/api/ready/${nxt.video_id}`);
      if (d.cached) { state.buffered.ready = true; state.buffered.bytes = d.bytes; paintStats(); return; }
    } catch {}
  }
}

async function playSimilar(t) {
  toast(`Finding songs similar to "${t.title}"…`);
  try {
    const data = await api(`/api/radio?videoId=${t.video_id}&limit=25`);
    const rest = (data.tracks || []).filter(x => x.video_id !== t.video_id);
    if (!rest.length) throw new Error('no suggestions came back');
    setQueue([t, ...rest], 0, `Similar to ${t.title}`, `Radio · ${artistName(t)}`);
    state.suggestionsAdded += rest.length;
    playTrackAt(0);
    toast(`▶ ${rest.length} songs like ${artistName(t)} queued`);
  } catch (e) { toast("Couldn't get similar songs: " + e.message, true); }
}

async function playArtistRadio({ id, name }) {
  toast(`Tuning ${name} radio…`);
  try {
    const data = await api(`/api/artist/radio?id=${encodeURIComponent(id)}&limit=30`);
    const tracks = data.tracks || [];
    if (!tracks.length) throw new Error('station came back empty');
    setQueue(tracks, 0, `Artist radio · ${data.station_name || name}`, `Artist radio · ${data.station_name || name}`);
    state.suggestionsAdded += tracks.length;
    playTrackAt(0);
    toast(`▶ ${data.station_name || name} radio — ${tracks.length} tracks`);
  } catch (e) { toast('Radio failed: ' + e.message, true); }
}

/* ── queue rail ─────────────────────────────────────────────────────────── */
function refreshQueue(label) {
  const list = $('#queueList');
  if (!list) return;
  if (!state.queue.length) {
    list.innerHTML = `<div class="queue-empty">Nothing queued yet.<br>Play a song and Cadence will suggest what's next.</div>`;
    $('#queueSub').textContent = 'Suggestions appear as you listen';
    return;
  }
  $('#queueTitle').textContent = label || state.queueLabel || 'Up next';
  $('#queueSub').textContent = `Track ${state.index + 1} of ${state.queue.length}`;
  list.innerHTML = state.queue.map((t, i) => `
    <li class="qrow ${state.current && t.video_id === state.current.video_id ? 'now' : ''}" data-vid="${esc(t.video_id)}" data-qi="${i}">
      <img src="${thumb(t.video_id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div><div class="qt">${esc(t.title)}</div><div class="qa">${esc(artistName(t))}</div></div>
      <span class="qd">${esc(fmtTime(t.duration))}</span>
    </li>`).join('');
}

/* ── audio plumbing ─────────────────────────────────────────────────────── */
function setLoading(on) { $('#spinner').hidden = !on; }
let errStreak = 0;
audio.addEventListener('playing', () => { setLoading(false); setPlayIcon(true); markNowPlaying(); updateHeroState(); errStreak = 0; blockingReported = false; if (state.queue.length - state.index <= 4) growQueue(); });
audio.addEventListener('pause', () => { setPlayIcon(false); updateHeroState(); });
audio.addEventListener('waiting', () => setLoading(true));
audio.addEventListener('canplay', () => setLoading(false));
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || (state.current && state.current.duration) || 0;
  const p = d ? (audio.currentTime / d) : 0;
  $('#tCur').textContent = fmtTime(audio.currentTime);
  $('#tDur').textContent = fmtTime(d);
  if (!seeking) { $('#seek').value = Math.round(p * 1000); $('#seekFill').style.width = (p * 100) + '%'; }
  if ($('#heroFacts')) paintStats();
});
audio.addEventListener('ended', () => next(true));
audio.addEventListener('error', async () => {
  setLoading(false);
  if (!state.current) return;
  const id = state.current.video_id;
  const info = await diagnoseStream(id);

  // YouTube refusing this server's IP won't be fixed by skipping tracks
  if (info.kind === 'youtube_blocked') { reportBlocked(info); audio.pause(); return; }
  if (info.kind === 'offline') {
    toast('Backend unreachable — is the Flask app still running?', true, 9000);
    audio.pause(); return;
  }

  if (++errStreak > 3) { toast('Several tracks failed to stream — pausing', true); audio.pause(); return; }
  toast(`Couldn't stream "${state.current.title}" — skipping`, true);
  setTimeout(() => next(true), 700);
});
audio.volume = LS.get('volume', 0.9);
$('#vol').value = audio.volume;

function setPlayIcon(playing) {
  $('#playBtn').innerHTML = icon(playing ? 'pause' : 'play');
  $('#playBtn').title = playing ? 'Pause (Space)' : 'Play (Space)';
}
setPlayIcon(false);

let seeking = false;
const seek = $('#seek');
['input', 'change'].forEach(ev => seek.addEventListener(ev, () => {
  const d = audio.duration || 0;
  if (d) {
    const t = (seek.value / 1000) * d;
    $('#tCur').textContent = fmtTime(t);
    $('#seekFill').style.width = (seek.value / 10) + '%';
    $('#tDur').textContent = fmtTime(d);
  }
  if (ev === 'input') seeking = true;
  if (ev === 'change') { if (d) audio.currentTime = (seek.value / 1000) * d; seeking = false; }
}));
seek.addEventListener('pointerup', () => { seeking = false; });

$('#vol').addEventListener('input', e => {
  audio.volume = Number(e.target.value);
  if (audio.volume > 0) audio.muted = false;
  LS.set('volume', audio.volume); syncMute();
});
function syncMute() { $('#muteBtn').innerHTML = icon(audio.muted || audio.volume === 0 ? 'mute' : 'vol'); }
$('#muteBtn').addEventListener('click', () => { audio.muted = !audio.muted; syncMute(); });
syncMute();

$('#playBtn').addEventListener('click', togglePlay);
$('#nextBtn').addEventListener('click', () => next(false));
$('#prevBtn').addEventListener('click', prev);
$('#shuffleBtn').addEventListener('click', e => { state.shuffle = !state.shuffle; e.currentTarget.classList.toggle('on', state.shuffle); toast(state.shuffle ? 'Shuffle on' : 'Shuffle off'); });
$('#repeatBtn').addEventListener('click', e => {
  state.repeat = (state.repeat + 1) % 3;
  e.currentTarget.classList.toggle('on', state.repeat > 0);
  e.currentTarget.innerHTML = icon(state.repeat === 2 ? 'repeat1' : 'repeat');
  toast(['Repeat off', 'Repeat queue', 'Repeat track'][state.repeat]);
});
$('#queueList').addEventListener('click', e => { const row = e.target.closest('.qrow'); if (row) playTrackAt(Number(row.dataset.qi)); });
$('#clearQueue').addEventListener('click', () => {
  const keep = state.current;
  state.queue = keep ? [keep] : []; state.index = keep ? 0 : -1; state.station = null;
  $('#radioBadge').hidden = true; refreshQueue(); paintFeed(); paintStats(); toast('Queue cleared');
});
$('#queueToggle').addEventListener('click', e => {
  const narrow = window.matchMedia('(max-width:900px)').matches;
  if (narrow) $('#rail').classList.toggle('open');
  else $('.body').classList.toggle('rail-hidden');
  e.currentTarget.classList.toggle('active');
});

/* ── click delegation in the main area ──────────────────────────────────── */
main.addEventListener('click', e => {
  const navTo = e.target.closest('[data-nav-to]');
  if (navTo) { go('/' + navTo.dataset.navTo); return; }

  const artistEl = e.target.closest('[data-artist]');
  if (artistEl) {
    e.preventDefault();   // hash href keeps working when this is a synthetic click too
    const id = artistEl.dataset.artistId || '';
    const nm = artistEl.dataset.artistName || '';
    if (id || nm) go(`/artist/${id ? encodeURIComponent(id) : ''}?name=${encodeURIComponent(nm)}`);
    return;
  }

  const albumEl = e.target.closest('[data-album]');
  if (albumEl) { e.preventDefault(); go(`/album/${encodeURIComponent(albumEl.dataset.album)}`); return; }

  const genreEl = e.target.closest('[data-genre]');
  if (genreEl) { go(`/genre/${encodeURIComponent(genreEl.dataset.genre)}?title=${encodeURIComponent(genreEl.dataset.title)}`); return; }

  const plEl = e.target.closest('[data-playlist]');
  if (plEl) { go(`/playlist/${encodeURIComponent(plEl.dataset.playlist)}?title=${encodeURIComponent(plEl.dataset.title)}`); return; }

  const chip = e.target.closest('[data-search]');
  if (chip) { $('#q').value = chip.dataset.search; runSearch(chip.dataset.search); return; }

  const act = e.target.closest('[data-action]');
  if (act) {
    const a = act.dataset.action;
    if (a === 'queue') {
      e.stopPropagation();
      const row = e.target.closest('.trow');
      const list = state.viewLists[row.dataset.list] || [];
      const t = list[Number(row.dataset.i)];
      if (t) { state.queue.push(t); refreshQueue(); paintFeed(); paintStats(); toast(`Added "${t.title}" to queue`); }
      return;
    }
    if (a === 'similar') {
      e.stopPropagation();
      const row = e.target.closest('.trow');
      const list = state.viewLists[row.dataset.list] || [];
      const t = list[Number(row.dataset.i)];
      if (t) playSimilar(t);
      return;
    }
    if (a === 'similar-now' && state.current) { playSimilar(state.current); return; }
    if (a === 'open-settings') {
      if (window.__SRC__ && window.__SRC__.openSettings) window.__SRC__.openSettings();
      else toast('Settings are only available in the standalone file', true);
      return;
    }
    if (a === 'playpause') { togglePlay(); return; }
    if (a === 'play-list') {
      const list = state.viewLists[act.dataset.list] || [];
      if (list.length) { setQueue(list, 0, LABELS[act.dataset.list] || 'Playing list'); playTrackAt(0); }
      return;
    }
    if (a === 'artist-radio') { playArtistRadio({ id: act.dataset.artistId, name: act.dataset.artistName }); return; }
    if (a === 'surprise') {
      const picks = ['Lo-fi hip hop', 'Daft Punk', 'Fleetwood Mac', 'Kendrick Lamar', 'Tame Impala', 'Nina Simone', 'Radiohead', 'Khruangbin'];
      const pick = picks[Math.floor(Math.random() * picks.length)];
      $('#q').value = pick; runSearch(pick);
      return;
    }
  }

  const row = e.target.closest('.trow');
  if (row) {
    const list = state.viewLists[row.dataset.list] || [];
    const i = Number(row.dataset.i);
    if (list.length) {
      if (state.queueSource !== list) setQueue(list, i, LABELS[row.dataset.list] || 'Playing list');
      playTrackAt(i);
    }
  }
});

/* suggestion feed rows live outside `main` re-renders when re-painted: delegate on document */
document.addEventListener('click', e => {
  const row = e.target.closest('.feed-row[data-qi]');
  if (row) playTrackAt(Number(row.dataset.qi));
});

/* nav + hash routing */
document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => go('/' + b.dataset.nav)));
window.addEventListener('hashchange', renderRoute);

/* ── search box ─────────────────────────────────────────────────────────── */
let suggestTimer = null;
const qInput = $('#q');
function runSearch(q) { $('#q').value = q; hideSuggest(); go(`/search/${encodeURIComponent(q)}?q=${encodeURIComponent(q)}`); if (currentRoute() === `/search/${encodeURIComponent(q)}?q=${encodeURIComponent(q)}`) renderRoute(); }
qInput.addEventListener('input', () => {
  const v = qInput.value.trim();
  clearTimeout(suggestTimer);
  if (v.length < 2) { hideSuggest(); return; }
  suggestTimer = setTimeout(fetchSuggestions, 160);
});
qInput.addEventListener('keydown', e => {
  const box = $('#suggest');
  const open = !box.hidden && state.suggestItems && state.suggestItems.length;
  if (e.key === 'ArrowDown' && open) { e.preventDefault(); state.suggestActive = Math.min((state.suggestActive ?? -1) + 1, state.suggestItems.length - 1); paintSuggest(); }
  else if (e.key === 'ArrowUp' && open) { e.preventDefault(); state.suggestActive = Math.max((state.suggestActive ?? -1) - 1, -1); paintSuggest(); }
  else if (e.key === 'Enter') {
    const v = (open && (state.suggestActive ?? -1) >= 0) ? state.suggestItems[state.suggestActive] : qInput.value;
    if (v && v.trim()) runSearch(v.trim());
  } else if (e.key === 'Escape') hideSuggest();
});
async function fetchSuggestions() {
  const v = qInput.value.trim();
  if (v.length < 2) return;
  try {
    const data = await api(`/api/suggest?q=${encodeURIComponent(v)}`);
    if (qInput.value.trim() !== v) return;
    state.suggestItems = data.suggestions || [];
    state.suggestActive = -1;
    paintSuggest();
  } catch {}
}
function paintSuggest() {
  const box = $('#suggest');
  const items = state.suggestItems || [];
  if (!items.length) { hideSuggest(); return; }
  box.innerHTML = items.map((s, i) => `<div class="${i === state.suggestActive ? 'active' : ''}" data-s="${esc(s)}">${icon('search')}<span>${esc(s)}</span></div>`).join('');
  box.hidden = false;
}
function hideSuggest() { $('#suggest').hidden = true; state.suggestActive = -1; }
$('#suggest').addEventListener('mousedown', e => { const el = e.target.closest('[data-s]'); if (el) { e.preventDefault(); runSearch(el.dataset.s); } });
document.addEventListener('click', e => { if (!e.target.closest('.searchwrap')) hideSuggest(); });

/* ── keyboard + media session ───────────────────────────────────────────── */
document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); qInput.focus(); qInput.select(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key.toLowerCase()) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'n': next(false); break;
    case 'p': prev(); break;
    case 's': $('#shuffleBtn').click(); break;
    case 'r': $('#repeatBtn').click(); break;
    case 'm': $('#muteBtn').click(); break;
    case 'q': $('#queueToggle').click(); break;
    case 'arrowright': audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); break;
    case 'arrowleft': audio.currentTime = Math.max(0, audio.currentTime - 10); break;
  }
});
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', togglePlay);
  navigator.mediaSession.setActionHandler('pause', togglePlay);
  navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}
function updateMediaSession(t) {
  if (!('mediaSession' in navigator) || !t) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: artistName(t), album: (t.album && t.album.name) || 'Cadence',
      artwork: [{ src: thumb(t.video_id), sizes: '320x180', type: 'image/jpeg' }],
    });
  } catch {}
}

/* ── engine telemetry poll ──────────────────────────────────────────────── */
let backendWarned = false;
async function pollStats() {
  if (document.hidden) return;
  try {
    const s = await api('/api/stats');
    backendWarned = false;
    $('#enCache').textContent = fmtBytes(s.cached_bytes);
    $('#enTracks').textContent = s.cached_tracks;
    $('#enDownloads').textContent = s.downloads + (s.download_failures ? ` (${s.download_failures} err)` : '');
    $('#enAvg').textContent = s.avg_download_seconds ? `${s.avg_download_seconds}s` : '–';
    $('#enInflight').textContent = s.downloads_inflight;
    $('#enUptime').textContent = fmtDur(s.uptime_seconds);
    $('#enBar').style.width = Math.min(100, (s.cached_bytes / s.cache_limit_bytes) * 100).toFixed(1) + '%';
  } catch {
    if (!backendWarned) {
      backendWarned = true;
      toast('Backend not reachable — start it with ./run.sh (search, streaming and suggestions need it)', true, 9000);
    }
  }
}
pollStats();
setInterval(pollStats, 5000);

/* ── boot ───────────────────────────────────────────────────────────────── */
$('#brandLink').addEventListener('click', e => { e.preventDefault(); go('/overview'); });
if (!location.hash) location.replace('#/overview');
renderRoute();
console.log('%c🎧 Cadence dashboard ready', 'color:#a78bfa;font-weight:bold');
})();
