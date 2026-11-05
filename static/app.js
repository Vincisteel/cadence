/* ── Cadence front-end ─────────────────────────────────────────────────── */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const audio = $('#audio');

/* ── state ──────────────────────────────────────────────────────────────── */
const state = {
  queue: [],           // array of track objects (play order)
  index: -1,           // index of the loaded track
  current: null,
  viewLists: {},       // named track lists of the rendered view
  shuffle: false,
  repeat: 0,           // 0 = off, 1 = all, 2 = one
  growing: false,
  history: [],
  lastSearch: { tracks: [], artists: [] },
  suggestItems: [],
  suggestActive: -1,
  token: 0,            // guards against out-of-order async renders
};

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('cadence:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cadence:' + k, JSON.stringify(v)); } catch {} },
};

/* ── tiny helpers ───────────────────────────────────────────────────────── */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = n => `<svg aria-hidden="true"><use href="#i-${n}"/></svg>`;

function fmtTime(sec) {
  if (!sec || !isFinite(sec) || sec < 0) return '0:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function toast(msg, isErr = false, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
  return data;
}

const thumb = vid => `/api/thumb/${vid}`;
const artOf = t => t.album && t.album.id ? t.album.id : null;
const artistName = t => t.artist_text || 'Unknown artist';

function artistLink(a) {
  return `<a data-artist data-artist-id="${esc(a.id || '')}" data-artist-name="${esc(a.name)}" href="#">${esc(a.name)}</a>`;
}

/* ── rendering primitives ───────────────────────────────────────────────── */
function trackRows(tracks, listName, startNum = 1, showAlbum = true) {
  if (!tracks || !tracks.length) return `<div class="empty"><h3>No tracks</h3><p>Try another search.</p></div>`;
  return `<div class="tracks">` + tracks.map((t, i) => `
    <div class="trow" data-vid="${esc(t.video_id)}" data-list="${esc(listName)}" data-i="${i}">
      <div class="idx"><span class="num" data-n="${startNum + i}">${startNum + i}</span>
        <span class="playicon">${icon('play')}</span></div>
      <img class="art" src="${thumb(t.video_id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="meta">
        <div class="tt">${esc(t.title)}</div>
        <div class="ta">${(t.artists || []).map(artistLink).join(', ') || esc(artistName(t))}</div>
      </div>
      <div class="album">${t.album && t.album.id
        ? `<a data-album="${esc(t.album.id)}" href="#">${esc(t.album.name || '')}</a>`
        : esc((t.album && t.album.name) || '')}</div>
      <div class="end">
        <button class="icon-btn addq" data-action="similar" title="Play similar songs (radio)">${icon('spark')}</button>
        <button class="icon-btn addq" data-action="queue" title="Add to queue">${icon('plus')}</button>
        <span>${esc(fmtTime(t.duration))}</span>
      </div>
    </div>`).join('') + `</div>`;
}

function skeletons(n = 8) {
  return Array.from({ length: n }, () => `<div class="skeleton"></div>`).join('');
}

function card({ img, title, sub, attrs, iconName }) {
  return `<button class="card" ${attrs || ''}>
    <div class="card-art">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : icon(iconName || 'artist')}</div>
    <div class="card-title">${esc(title || '')}</div>
    <div class="card-sub">${esc(sub || '')}</div>
  </button>`;
}

/* ── views ──────────────────────────────────────────────────────────────── */
const view = $('#view');

function markNowPlaying() {
  const vid = state.current && state.current.video_id;
  document.querySelectorAll('.trow, .qrow').forEach(el => {
    const on = vid && el.dataset.vid === vid;
    el.classList.toggle('now', !!on);
    const num = el.querySelector('.idx .num');
    if (num) num.innerHTML = on
      ? `<span class="nowbars"><i></i><i></i><i></i></span>`
      : (num.dataset.n || '');
  });
}

function renderHome() {
  const recent = LS.get('recent', []);
  const moods = ['Lo-fi beats', 'Queen', 'Radiohead', '80s hits', 'Taylor Swift', 'Jazz classics',
                 'Film scores', 'Kendrick Lamar', 'Daft Punk', 'Acoustic covers', 'Piano study', 'Drum & bass'];
  view.innerHTML = `
    <div class="hero">
      <h1>Search it. Stream it.<br><em>Let the radio take over.</em></h1>
      <p>Cadence plays any song by name from YouTube, then keeps the music going with artist radios and similar-track suggestions.</p>
      <div class="cta">
        <button class="chip strong" data-action="surprise">${icon('spark')}&nbsp;Surprise me</button>
        <button class="chip" data-action="focus-search">${icon('search')}&nbsp;Search a song</button>
      </div>
    </div>
    ${recent.length ? `<section class="section"><h2>${icon('queue')}Recently played</h2>${trackRows(recent, 'recent')}</section>` : ''}
    <section class="section"><h2>${icon('spark')}Start a station</h2>
      <div class="chips">${moods.map(m => `<button class="chip" data-search="${esc(m)}">${esc(m)}</button>`).join('')}</div>
    </section>`;
  state.viewLists = { recent };
}

async function runSearch(q, { render = true } = {}) {
  if (!q.trim()) return;
  const token = ++state.token;
  $('#q').value = q;
  hideSuggest();
  if (render) view.innerHTML = `<div class="section"><h2>${icon('search')}Searching "${esc(q)}"…</h2>${skeletons(9)}</div>`;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&limit=24`);
    if (token !== state.token) return;
    state.lastSearch = data;
    renderSearch(data);
  } catch (e) {
    if (token !== state.token) return;
    view.innerHTML = `<div class="empty"><h3>Search failed</h3><p>${esc(e.message)}</p></div>`;
  }
}

function renderSearch(data) {
  const artists = data.artists || [];
  const tracks = data.tracks || [];
  view.innerHTML = `
    ${artists.length ? `<section class="section" style="margin-top:0"><h2>${icon('artist')}Artists</h2>
      <div class="cards">${artists.slice(0, 8).map(a => card({
        img: a.thumbnail ? `/api/img?u=${encodeURIComponent(a.thumbnail)}` : '',
        title: a.name,
        sub: a.subscribers ? `${a.subscribers} subscribers` : 'Artist',
        attrs: `data-artist data-artist-id="${esc(a.id)}" data-artist-name="${esc(a.name)}"`,
        iconName: 'artist',
      })).join('')}</div></section>` : ''}
    <section class="section" ${artists.length ? '' : 'style="margin-top:0"'}>
      <h2>${icon('play')}Songs${tracks.length ? ` <span style="color:var(--dim);font-weight:400">(${tracks.length})</span>` : ''}</h2>
      ${trackRows(tracks, 'search')}
    </section>`;
  state.viewLists = { search: tracks };
  markNowPlaying();
}

async function openArtist({ id, name }) {
  const token = ++state.token;
  view.innerHTML = `
    <div class="artist-head"><div style="width:154px;height:154px;border-radius:50%;background:#1a1a26"></div>
      <div class="ah-text"><div class="eyebrow">Artist</div><h1>${esc(name || '…')}</h1><div class="stats">Loading…</div></div></div>
    ${skeletons(8)}`;
  try {
    const qs = (id && id !== 'undefined') ? `id=${encodeURIComponent(id)}` : `name=${encodeURIComponent(name || '')}`;
    const a = await api(`/api/artist?${qs}`);
    if (token !== state.token) return;
    const listeners = a.monthly_listeners ? `${Number(a.monthly_listeners).toLocaleString()} monthly listeners` : '';
    view.innerHTML = `
      <div class="artist-head">
        <img src="${a.thumbnail ? `/api/img?u=${encodeURIComponent(a.thumbnail)}` : ''}" alt="" onerror="this.style.visibility='hidden'">
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
      <section class="section" style="margin-top:0"><h2>${icon('play')}Top songs</h2>${trackRows(a.top_tracks, 'top')}</section>
      ${a.similar && a.similar.length ? `<section class="section"><h2>${icon('artist')}Fans also like</h2>
        <div class="cards">${a.similar.map(s => card({ title: s.name, sub: 'Artist', attrs: `data-artist data-artist-id="${esc(s.id)}" data-artist-name="${esc(s.name)}"`, iconName: 'artist' })).join('')}</div>
      </section>` : ''}
      ${a.albums && a.albums.length ? `<section class="section"><h2>${icon('queue')}Albums &amp; singles</h2>
        <div class="cards">${a.albums.map(al => card({ title: al.title, sub: [al.year, al.type].filter(Boolean).join(' · '), attrs: `data-album="${esc(al.id)}"` })).join('')}</div>
      </section>` : ''}`;
    state.viewLists = { top: a.top_tracks };
    state.artist = a;
    markNowPlaying();
  } catch (e) {
    if (token !== state.token) return;
    view.innerHTML = `<div class="empty"><h3>Couldn't load artist</h3><p>${esc(e.message)}</p></div>`;
  }
}

async function openAlbum(id) {
  const token = ++state.token;
  view.innerHTML = `<div class="section"><h2>${icon('queue')}Loading album…</h2>${skeletons(8)}</div>`;
  try {
    const al = await api(`/api/album?id=${encodeURIComponent(id)}`);
    if (token !== state.token) return;
    view.innerHTML = `
      <section class="section" style="margin-top:0">
        <div class="eyebrow">Album</div>
        <h2 style="text-transform:none;font-size:26px;letter-spacing:-.3px;color:var(--text)">${esc(al.title)} ${al.year ? `<span style="color:var(--dim);font-size:15px">· ${al.year}</span>` : ''}</h2>
        <button class="chip strong" data-action="play-list" data-list="album" style="margin:10px 0 16px">${icon('play')}&nbsp;Play album</button>
        ${trackRows(al.tracks, 'album')}
      </section>`;
    state.viewLists = { album: al.tracks };
    markNowPlaying();
  } catch (e) {
    if (token !== state.token) return;
    view.innerHTML = `<div class="empty"><h3>Couldn't load album</h3><p>${esc(e.message)}</p></div>`;
  }
}

const LABELS = { search: 'Search results', top: 'Top songs', album: 'Album', recent: 'Recently played' };

/* ── playback ───────────────────────────────────────────────────────────── */
function setQueue(list, startIndex, label) {
  state.queue = list.slice();
  state.queueSource = list;
  state.index = startIndex;
  state.radioLabel = label || null;
  refreshQueue(label);
}

function playTrackAt(i, { addToHistory = true } = {}) {
  if (i < 0 || i >= state.queue.length) return;
  const t = state.queue[i];
  if (addToHistory && state.current) state.history.push(state.index);
  state.index = i;
  state.current = t;

  $('#npTitle').textContent = t.title;
  $('#npArtist').innerHTML = (t.artists || []).map(artistLink).join(', ') || esc(artistName(t));
  $('#npArt').innerHTML = `<img src="${thumb(t.video_id)}" alt="">`;
  $('#radioBadge').hidden = !state.radioLabel;
  $('#addCurrent').hidden = false;
  document.title = `${t.title} · ${artistName(t)} — Cadence`;

  setLoading(true);
  audio.src = `/api/stream/${t.video_id}`;
  audio.play().catch(err => {
    setLoading(false);
    if (err && err.name !== 'AbortError') toast('Playback blocked — press play to start', true);
  });

  const next = state.queue[i + 1];
  if (next) fetch(`/api/prefetch/${next.video_id}`, { method: 'POST' }).catch(() => {});

  remember(t);
  markNowPlaying();
  refreshQueue();
  maybeGrow();
}

function remember(t) {
  const recent = LS.get('recent', []).filter(x => x.video_id !== t.video_id);
  recent.unshift({ video_id: t.video_id, title: t.title, artists: t.artists, artist_text: t.artist_text, album: t.album, duration: t.duration });
  LS.set('recent', recent.slice(0, 12));
}

function togglePlay() {
  if (!state.current) { toast('Pick a song first 🙂'); return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

function next(auto = false) {
  if (!state.queue.length) return;
  if (state.repeat === 2 && auto) { audio.currentTime = 0; audio.play(); return; }
  let i;
  if (state.shuffle) {
    do { i = Math.floor(Math.random() * state.queue.length); } while (state.queue.length > 1 && i === state.index);
  } else {
    i = state.index + 1;
  }
  if (i >= state.queue.length) {
    if (state.repeat === 1 || auto) {
      // keep the stream alive: grow via radio, otherwise loop
      growQueue().then(grew => {
        if (grew) playTrackAt(state.index + 1);
        else if (state.repeat === 1) playTrackAt(0);
        else { toast('End of queue'); audio.pause(); }
      });
      return;
    }
    playTrackAt(0);
    return;
  }
  playTrackAt(i);
}

function prev() {
  if (audio.currentTime > 4 || !state.queue.length) { audio.currentTime = 0; return; }
  playTrackAt(Math.max(0, state.index - 1));
}

/* radio: keep the queue fed from the track that is playing */
async function growQueue() {
  if (state.growing) return false;
  const seed = (state.current && state.current.video_id) || null;
  if (!seed) return false;
  state.growing = true;
  try {
    const data = await api(`/api/radio?videoId=${seed}&limit=22`);
    const have = new Set(state.queue.map(t => t.video_id));
    const fresh = (data.tracks || []).filter(t => !have.has(t.video_id));
    if (!fresh.length) return false;
    state.queue.push(...fresh);
    state.radioLabel = 'Radio · ' + (state.current ? artistName(state.current) : 'station');
    refreshQueue();
    $('#radioBadge').hidden = false;
    return true;
  } catch (e) {
    toast('Couldn\'t load suggestions: ' + e.message, true);
    return false;
  } finally {
    state.growing = false;
  }
}

function maybeGrow() {
  if (state.shuffle || state.repeat === 2) return;
  if (state.queue.length - state.index <= 3) growQueue();
}

/* "similar songs": seed the queue with this track + its radio suggestions */
async function playSimilar(t) {
  toast(`Finding songs similar to "${t.title}"…`);
  try {
    const data = await api(`/api/radio?videoId=${t.video_id}&limit=25`);
    const rest = (data.tracks || []).filter(x => x.video_id !== t.video_id);
    if (!rest.length) throw new Error('no suggestions came back');
    setQueue([t, ...rest], 0, `Similar to ${t.title}`);
    playTrackAt(0);
    toast(`▶ ${rest.length} songs similar to ${artistName(t)} queued`);
  } catch (e) {
    toast('Couldn\'t get similar songs: ' + e.message, true);
  }
}

async function playArtistRadio({ id, name }) {
  toast(`Tuning ${name} radio…`);
  try {
    const data = await api(`/api/artist/radio?id=${encodeURIComponent(id)}&limit=30`);
    const tracks = data.tracks || [];
    if (!tracks.length) throw new Error('station came back empty');
    setQueue(tracks, 0, `Artist radio · ${data.station_name || name}`);
    playTrackAt(0);
    toast(`▶ ${data.station_name || name} radio — ${tracks.length} tracks`);
  } catch (e) {
    toast('Radio failed: ' + e.message, true);
  }
}

/* ── queue panel ────────────────────────────────────────────────────────── */
function refreshQueue(label) {
  const list = $('#queueList');
  if (!state.queue.length) {
    list.innerHTML = `<div class="queue-empty">Nothing queued yet.<br>Play a song and Cadence will suggest what's next.</div>`;
    $('#queueSub').textContent = 'Suggestions appear as you listen';
    return;
  }
  $('#queueTitle').textContent = label || state.radioLabel || 'Up next';
  $('#queueSub').textContent = `Track ${state.index + 1} of ${state.queue.length}`;
  list.innerHTML = state.queue.map((t, i) => `
    <li class="qrow ${state.current && t.video_id === state.current.video_id ? 'now' : ''}" data-vid="${esc(t.video_id)}" data-qi="${i}">
      <img src="${thumb(t.video_id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div><div class="qt">${esc(t.title)}</div><div class="qa">${esc(artistName(t))}</div></div>
      <span class="qd">${esc(fmtTime(t.duration))}</span>
    </li>`).join('');
}

/* ── audio element plumbing ─────────────────────────────────────────────── */
function setLoading(on) { $('#spinner').hidden = !on; }

audio.addEventListener('playing', () => { setLoading(false); setPlayIcon(true); markNowPlaying(); growAhead(); });
audio.addEventListener('pause', () => setPlayIcon(false));
audio.addEventListener('waiting', () => setLoading(true));
audio.addEventListener('canplay', () => setLoading(false));
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || (state.current && state.current.duration) || 0;
  const p = d ? (audio.currentTime / d) : 0;
  $('#tCur').textContent = fmtTime(audio.currentTime);
  $('#tDur').textContent = fmtTime(d);
  if (!seeking) { $('#seek').value = Math.round(p * 1000); $('#seekFill').style.width = (p * 100) + '%'; }
});
audio.addEventListener('ended', () => next(true));
let errStreak = 0;
audio.addEventListener('error', () => {
  setLoading(false);
  if (!state.current) return;
  if (++errStreak > 3) { toast('Several tracks failed to stream — pausing', true); audio.pause(); return; }
  toast(`Couldn't stream "${state.current.title}" — skipping`, true);
  setTimeout(() => next(true), 700);
});
audio.addEventListener('playing', () => { errStreak = 0; });
audio.volume = LS.get('volume', 0.9);
$('#vol').value = audio.volume;

function setPlayIcon(playing) {
  $('#playBtn').innerHTML = icon(playing ? 'pause' : 'play');
  $('#playBtn').title = playing ? 'Pause (Space)' : 'Play (Space)';
}
setPlayIcon(false);

function growAhead() {
  // room remaining in queue? top it up with similar tracks in the background
  if (state.queue.length - state.index <= 3) growQueue();
}

/* seek */
let seeking = false;
const seek = $('#seek');
['input', 'change'].forEach(ev => seek.addEventListener(ev, () => {
  seeking = ev === 'input' ? true : seeking;
  const d = audio.duration || 0;
  if (d) {
    const t = (seek.value / 1000) * d;
    $('#tCur').textContent = fmtTime(t);
    $('#seekFill').style.width = (seek.value / 10) + '%';
    $('#tDur').textContent = fmtTime(d);
  }
  if (ev === 'change') { if (d) audio.currentTime = (seek.value / 1000) * d; seeking = false; }
}));
seek.addEventListener('pointerup', () => { seeking = false; });

/* volume / mute */
$('#vol').addEventListener('input', e => {
  audio.volume = Number(e.target.value);
  if (audio.volume > 0) audio.muted = false;
  LS.set('volume', audio.volume);
  syncMute();
});
function syncMute() { $('#muteBtn').innerHTML = icon(audio.muted || audio.volume === 0 ? 'mute' : 'vol'); }
$('#muteBtn').addEventListener('click', () => { audio.muted = !audio.muted; syncMute(); });
syncMute();

/* transport buttons */
$('#playBtn').addEventListener('click', togglePlay);
$('#nextBtn').addEventListener('click', () => next(false));
$('#prevBtn').addEventListener('click', prev);
$('#shuffleBtn').addEventListener('click', e => {
  state.shuffle = !state.shuffle;
  e.currentTarget.classList.toggle('on', state.shuffle);
  toast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
});
$('#repeatBtn').addEventListener('click', e => {
  state.repeat = (state.repeat + 1) % 3;
  e.currentTarget.classList.toggle('on', state.repeat > 0);
  e.currentTarget.innerHTML = icon(state.repeat === 2 ? 'repeat1' : 'repeat');
  toast(['Repeat off', 'Repeat queue', 'Repeat track'][state.repeat]);
});
$('#addCurrent').addEventListener('click', () => {
  if (!state.current) return;
  state.queue.push(state.current);
  refreshQueue();
  toast('Re-queued ' + state.current.title);
});

/* ── events: view ───────────────────────────────────────────────────────── */
view.addEventListener('click', e => {
  const artistEl = e.target.closest('[data-artist]');
  if (artistEl) { e.preventDefault(); openArtist({ id: artistEl.dataset.artistId || '', name: artistEl.dataset.artistName || '' }); return; }

  const albumEl = e.target.closest('[data-album]');
  if (albumEl) { e.preventDefault(); openAlbum(albumEl.dataset.album); return; }

  const act = e.target.closest('[data-action]');
  if (act) {
    const a = act.dataset.action;
    if (a === 'queue') {
      e.stopPropagation();
      const row = e.target.closest('.trow');
      const list = state.viewLists[row.dataset.list] || [];
      const t = list[Number(row.dataset.i)];
      if (t) { state.queue.push(t); refreshQueue(); toast(`Added "${t.title}" to queue`); }
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
    if (a === 'play-list') {
      const list = state.viewLists[act.dataset.list] || [];
      if (list.length) { setQueue(list, 0, 'Playing list'); playTrackAt(0); }
      return;
    }
    if (a === 'artist-radio') {
      playArtistRadio({ id: act.dataset.artistId, name: act.dataset.artistName });
      return;
    }
    if (a === 'surprise') {
      const picks = ['Lo-fi hip hop', 'Daft Punk', 'Fleetwood Mac', 'Kendrick Lamar', 'Tame Impala', 'Nina Simone', 'The Weeknd', 'Radiohead'];
      runSearch(picks[Math.floor(Math.random() * picks.length)]);
      return;
    }
    if (a === 'focus-search') { $('#q').focus(); return; }
  }

  const chip = e.target.closest('[data-search]');
  if (chip) { runSearch(chip.dataset.search); return; }

  const row = e.target.closest('.trow');
  if (row) {
    const listName = row.dataset.list;
    const list = state.viewLists[listName] || [];
    const i = Number(row.dataset.i);
    if (list.length) {
      const label = LABELS[listName] || 'Playing list';
      if (state.queueSource !== list) setQueue(list, i, label);
      playTrackAt(i);
    }
  }
});

/* ── events: queue panel ────────────────────────────────────────────────── */
$('#queueList').addEventListener('click', e => {
  const row = e.target.closest('.qrow');
  if (row) playTrackAt(Number(row.dataset.qi));
});
$('#clearQueue').addEventListener('click', () => {
  const keep = state.current;
  state.queue = keep ? [keep] : [];
  state.index = keep ? 0 : -1;
  state.radioLabel = null;
  $('#radioBadge').hidden = true;
  refreshQueue();
  toast('Queue cleared');
});
$('#queueToggle').addEventListener('click', e => {
  const isNarrow = window.matchMedia('(max-width:900px)').matches;
  const panel = $('#queuePanel');
  if (isNarrow) { panel.classList.toggle('open'); }
  else { $('.content').classList.toggle('queue-hidden'); }
  e.currentTarget.classList.toggle('active');
});

/* ── search box + suggestions ───────────────────────────────────────────── */
let searchTimer = null, suggestTimer = null;
const qInput = $('#q');

qInput.addEventListener('input', () => {
  const v = qInput.value.trim();
  clearTimeout(suggestTimer);
  if (v.length < 2) { hideSuggest(); return; }
  suggestTimer = setTimeout(fetchSuggestions, 160);
});

qInput.addEventListener('keydown', e => {
  const box = $('#suggest');
  const open = !box.hidden && state.suggestItems.length;
  if (e.key === 'ArrowDown' && open) { e.preventDefault(); state.suggestActive = Math.min(state.suggestActive + 1, state.suggestItems.length - 1); paintSuggest(); }
  else if (e.key === 'ArrowUp' && open) { e.preventDefault(); state.suggestActive = Math.max(state.suggestActive - 1, -1); paintSuggest(); }
  else if (e.key === 'Enter') {
    if (open && state.suggestActive >= 0) runSearch(state.suggestItems[state.suggestActive]);
    else runSearch(qInput.value);
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
  if (!state.suggestItems.length) { hideSuggest(); return; }
  box.innerHTML = state.suggestItems.map((s, i) =>
    `<div class="${i === state.suggestActive ? 'active' : ''}" data-s="${esc(s)}">${icon('search')}<span>${esc(s)}</span></div>`).join('');
  box.hidden = false;
}
function hideSuggest() { $('#suggest').hidden = true; state.suggestActive = -1; }
$('#suggest').addEventListener('mousedown', e => {
  const el = e.target.closest('[data-s]');
  if (el) { e.preventDefault(); runSearch(el.dataset.s); }
});
document.addEventListener('click', e => { if (!e.target.closest('.searchwrap')) hideSuggest(); });

/* ── keyboard shortcuts ─────────────────────────────────────────────────── */
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
    case 'arrowright': audio.currentTime = Math.min((audio.duration || 0), audio.currentTime + 10); break;
    case 'arrowleft': audio.currentTime = Math.max(0, audio.currentTime - 10); break;
  }
});

/* media session (lockscreen / headset buttons) */
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', togglePlay);
  navigator.mediaSession.setActionHandler('pause', togglePlay);
  navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}
function updateMediaSession(t) {
  if (!('mediaSession' in navigator) || !t) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: artistName(t), album: (t.album && t.album.name) || 'Cadence',
    artwork: [{ src: thumb(t.video_id), sizes: '320x180', type: 'image/jpeg' }],
  });
}
const _playTrackAt = playTrackAt;
playTrackAt = function (i, opts) { _playTrackAt(i, opts); updateMediaSession(state.current); };

/* ── boot ───────────────────────────────────────────────────────────────── */
$('#brandLink').addEventListener('click', e => { e.preventDefault(); state.token++; history.replaceState(null, '', '/'); renderHome(); });
window.addEventListener('popstate', () => renderHome());
renderHome();
console.log('%c🎧 Cadence ready', 'color:#a78bfa;font-weight:bold');

})();
