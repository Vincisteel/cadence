# 🎧 Cadence — YouTube music dashboard

**Three ways to run it:**

| | What | Needs |
|---|---|---|
| **`cadence-dashboard.html`** | The whole dashboard in **one file** — double-click it, host it anywhere, no install | nothing (demo mode) |
| **This project** | The same dashboard wired to a real backend: YouTube Music search, radio, audio streaming | Python 3 (`./run.sh`) |
| **`cadence-android/`** | The same dashboard as an **installable Android app** (PWA): home-screen icon, full-screen, offline | any https static host |

The single file starts in **demo mode** (built-in catalog, simulated playback, every panel and
interaction live) and can be pointed at the backend from **⚙ Settings** for real search and audio.
To rebuild it after editing the dashboard: `python3 standalone/build_standalone.py`.

---

# Backend version

Search any song by name, stream it, and let the engine keep the music going with artist
radios and similar-song suggestions — wrapped in a browser dashboard with live playback,
suggestion and cache telemetry.

No API key needed: search/radio/artist/genre data comes from YouTube Music's public data
(via `ytmusicapi`), and the audio is pulled with `yt-dlp` and served by this server so the
browser can play, seek and buffer it like a normal audio file.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Cadence · dashboard        [ search songs, artists, albums… ]   CH  Queue  │
├───────────┬───────────────────────────────────────────────┬────────────────┤
│ Overview  │  ▢ now playing  ▢ queue  ▢ buffered  ▢ radio  │  Up next       │
│ Search    │  ┌──────────────────┐ ┌─────────────────────┐ │  (queue rail)  │
│ Trending  │  │  Now playing     │ │  Suggestion feed    │ │  track 3 of 42 │
│ Genres    │  │  art + controls  │ │  + reason labels    │ │  ...           │
│ Recent    │  └──────────────────┘ └─────────────────────┘ │                │
│ ───────   │  ┌──────────────────┐ ┌─────────────────────┐ │                │
│ Engine    │  │ Trending in CH   │ │ Trending artists    │ │                │
│ cache …   │  └──────────────────┘ └─────────────────────┘ │                │
├───────────┴───────────────────────────────────────────────┴────────────────┤
│  now playing · transport · seek · volume                                   │
└────────────────────────────────────────────────────────────────────────────┘
```

## Run it

```bash
./run.sh                  # installs deps if needed → http://localhost:8000
# or
pip install -r requirements.txt
PORT=8000 python3 app.py
```

Then open **http://localhost:8000** (dashboard) — the older single-column player is kept at
**/classic**.

## Dashboard views

| View | What you get |
|---|---|
| **Overview** | Live tiles (now playing, queue depth, *buffered ahead*, radio engine), a now-playing hero with one-click *Play similar* / *Artist radio*, the **suggestion feed** with a reason per track ("Up next", "Similar to X", "More from X"), trending tracks + artists, and recently played |
| **Search** | Any song / artist / album by name, with live suggestions in the search box; artists render as cards, songs as a playable list |
| **Trending** | YouTube Music charts for 69 regions (defaults to 🇨🇭 Switzerland) — charting tracks plus trending artists with rank and up/down trend |
| **Genres & moods** | 38 tiles (moods + genres) → curated playlists → playable track lists, all browsable without typing anything |
| **Artist** | Top songs, monthly listeners, "Fans also like" similar artists, albums & singles |
| **Album / playlist** | Full track lists with play-all and per-track *similar songs* |
| **Recently played** | Local listening history (stored in your browser) |
| **Queue rail** | The full upcoming queue, click any row to jump; collapses via the Queue button |
| **Engine panel** | Server telemetry: cache size vs. 3 GB cap, tracks cached, downloads, average fetch time, in-flight downloads, uptime |

Everything is hash-routed (`#/artist/…`, `#/playlist/…`, `#/genre/…`), so views are
shareable and the browser back button works.

## How the "keep playing" engine works

* Play any track → the server downloads the audio once into a local cache and serves it
  with HTTP Range support (seeking/buffering/replays are instant).
* While you listen, the next track is **prefetched** — the "Buffered ahead" tile polls
  `/api/ready/<id>` and flips to *Ready ✓* when it's on disk.
* When the queue runs low, radio suggestions for the current track are appended
  automatically (the "Radio" badge appears in the player bar), so playback never dead-ends.
* ✨ on any row = "play similar songs" → seeds a station from that track.

## Keyboard

`/` search · `space` play/pause · `n` / `p` next/prev · `←` `→` skip 10 s · `s` shuffle ·
`r` repeat (off/queue/track) · `m` mute · `q` toggle queue rail. OS media keys work too.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/search?q=&limit=` | songs + artists for a query |
| `GET /api/suggest?q=` | search-box autocomplete |
| `GET /api/radio?videoId=&limit=` | "similar songs" / up-next radio for a track |
| `GET /api/artist?id=\|name=` | top songs, albums, similar artists, monthly listeners |
| `GET /api/artist/radio?id=` | continuous artist station |
| `GET /api/trending?country=CH` | regional chart tracks + trending artists + region list |
| `GET /api/genres` · `GET /api/genre?params=` · `GET /api/playlist?id=` | browse tree and playlists |
| `GET /api/album?id=` | album track list |
| `GET /api/stream/<videoId>` | cached audio with Range support (the `<audio>` source) |
| `POST /api/prefetch/<videoId>` · `GET /api/ready/<videoId>` | warm the cache / check if a track is buffered |
| `GET /api/stats` | engine telemetry for the sidebar panel |
| `GET /healthz` | health probe (`{"status":"ok"}`) for Render/Fly/Railway |
| `GET /manifest.webmanifest` · `GET /sw.js` · `/static/pwa/icons/*` | installable-PWA assets |
| `GET /api/img?u=` · `GET /api/thumb/<videoId>` | image proxies (allow-listed hosts only) |

## Deploy it

**Quickest path: [DEPLOY.md](DEPLOY.md)** — Render, Railway and Fly are pre-configured
(`render.yaml`, `railway.json`, `fly.toml`). Whichever you pick, the dashboard, the PWA assets
and the API are served from the same https origin, so the installed Android app needs no
backend URL and there is no CORS or mixed-content setup.

The dashboard is server-backed, so it needs the Flask app running (a static host alone can't
stream or search).

**Docker**

```bash
docker build -t cadence .
docker run -p 8000:8000 -v cadence-data:/data cadence
```

**Render / Railway / Fly.io / any PaaS** — push the repo, it detects the `Procfile`:
`gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 16 --timeout 180 app:app`.
Set `CADENCE_CACHE` to a mounted volume (e.g. `/data`) so the audio cache survives restarts.
One worker is deliberate: the cache, download locks and stats live in-process.

**Reverse proxy** — keep response buffering off for `/api/stream/` (Nginx: `proxy_buffering off;`)
so seeking stays snappy.

## The standalone single-file dashboard

`cadence-dashboard.html` is generated from these same sources by `standalone/build_standalone.py`:

* CSS, icons, dashboard logic and a demo engine are inlined — **zero external requests**, so it
  works from `file://`, a USB stick, GitHub Pages/Netlify/S3, or an e-mail attachment.
* **Demo mode** synthesises a catalog (12 artists, 48 tracks, 32 regions, moods, genres, playlists),
  generates artwork as inline SVG, and runs a virtual player so progress, queue growth, radio
  suggestions and the telemetry panel all behave exactly like the live app.
* **Server mode** (⚙ Settings → enter a URL) switches every request to the real backend. The
  backend sends CORS headers, so the file can be hosted on a different origin. Mixed content
  applies: an `https` page needs an `https` backend.

## Android app (installable PWA)

`standalone/build_standalone.py` also emits `cadence-android/` — the app shell plus
`manifest.webmanifest`, `sw.js` and a full icon set. Host that folder on any https static host
(Netlify Drop, GitHub Pages, nginx…), open it on the phone and tap **Install**.

On phones the dashboard switches to a purpose-built layout (≤640 px): 2×2 tile grid,
full-width search, icon nav strip, compact 104 px player bar with thumb-reachable transport,
and the queue as a full-height sheet. Touch devices also drop the keyboard hints and turn
artist names inside track rows into plain text — Chrome's touch adjustment would otherwise
turn a "play this song" tap into "open this artist".

Install criteria, mixed-content rules and how to get a signed `.apk` are documented in
[`cadence-android/README.md`](cadence-android/README.md).

## Layout

```
cadence/
├── app.py                  # Flask: search, radio, artist, trending, genres, stream, images, stats
├── templates/dashboard.html # the dashboard shell (nav · panels · rail · player bar)
├── templates/index.html     # the classic single-column UI (/classic)
├── static/dash.css          # dashboard theme (dark, glassy)
├── static/dash.js           # router, views, player, radio growth, telemetry
├── static/style.css static/app.js   # classic UI
├── standalone/runtime.js    # demo engine + backend connector (injected into the single file)
├── standalone/build_standalone.py  # builds cadence-dashboard.html
├── requirements.txt · run.sh · Dockerfile · Procfile
```

## How search ranks results

`/api/search` runs three YouTube Music searches in parallel (relevance-ordered, filtered songs,
filtered artists) and merges them with de-duplication. Ordering:

1. **YouTube's own relevance position** leads — it encodes popularity, so the canonical recording
   beats karaoke and cover versions ("karma police" → Radiohead, not a band called Karma Police).
2. **Exact title / artist matches** lift near-ties — `"song 2"` puts Blur's track first.
3. **Artist queries** are detected automatically (many results by one artist vs. many songs with
   that title) and that artist's catalogue is promoted — `"nirvana"`, `"blur"`, `"drake"`.
4. Results sharing nothing with the query are **dropped**, so a nonsense query returns an honest
   "no matches" with suggestions instead of random noise.

Typical latency is 0.5–1.5 s (the three lookups run concurrently, not in sequence).

## Troubleshooting

**"YouTube refused to serve this audio to the server's IP address"** (HTTP 503, code `youtube_blocked`)
— YouTube rate-limits/blocks media downloads from many **datacenter and cloud IPs** (VPS, CI, some
PaaS egress ranges). The dashboard keeps working (search, charts, genres, suggestions, artist pages);
only the audio bytes are refused.
* Run it on your **own machine / home connection** — this is the normal setup and works.
* On a VPS, route `yt-dlp` through a **residential VPN/proxy** (`HTTPS_PROXY` env var), or use a
  local machine as the playback backend.
* The app tells you this explicitly instead of silently skipping tracks, and stops rather than
  hammering YouTube with retries.

**`WARNING: No supported JavaScript runtime could be found`** — harmless for audio-only use. Current
`yt-dlp` prefers the `deno` runtime for YouTube's JS challenges; most formats still resolve without
it. If a specific track returns *"Requested format is not available"*, install `deno` and re-run.

**First play is slow, then instant** — by design: the track is downloaded once into the cache
(≈1–2 s), then served locally with Range support.

**Port already in use** — `PORT=8010 ./run.sh`.

## Notes & limits

* Audio cache: `~/.cache/cadence` locally, `/data` in Docker (max ~3 GB, oldest evicted).
  Images cached in `…/img`.
* Only the first play of a track costs a download (~1–2 s); after that it's local.
* Regional trending charts are YouTube *trending videos*, so some titles arrive in
  video-style formatting rather than clean song metadata. Genre/mood playlists come from
  YouTube Music proper.
* Lyrics are not included — YouTube Music's lyrics endpoint rejects key-less requests.
* Built for personal use: it talks to the same public endpoints a browser does, so be
  sensible with volume.
