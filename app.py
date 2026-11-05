#!/usr/bin/env python3
"""
Cadence — a YouTube-powered music player.

* Search any song / artist / album (YouTube Music data, no API key needed).
* Streams the audio through this server (yt-dlp), so the browser can play,
  seek and buffer it like a normal <audio> file.
* Suggestions: "up next" radio for any track, artist radio, similar artists
  and top songs for any artist.

Run:  python3 app.py   ->  http://0.0.0.0:8000
"""
from __future__ import annotations

import hashlib
import mimetypes
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
import yt_dlp
from flask import Flask, abort, jsonify, redirect, render_template, request, send_file
from ytmusicapi import YTMusic

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
APP_DIR = Path(__file__).resolve().parent
CACHE_ROOT = Path(os.environ.get("CADENCE_CACHE", Path.home() / ".cache" / "cadence"))
AUDIO_DIR = CACHE_ROOT / "audio"
IMG_DIR = CACHE_ROOT / "img"
for d in (AUDIO_DIR, IMG_DIR):
    d.mkdir(parents=True, exist_ok=True)

# evict oldest audio above this size (configurable for small hosting volumes)
CACHE_MAX_BYTES = int(os.environ.get("CADENCE_MAX_CACHE_BYTES", 3 * 1024**3))
PORT = int(os.environ.get("PORT", "8000"))

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
SAFE_BROWSE_RE = re.compile(r"^[A-Za-z0-9_-]{5,60}$")

MIME = {
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".webm": "audio/webm",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
}

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.json.sort_keys = False

# --------------------------------------------------------------------------- #
# ytmusicapi access — a small pool of worker threads so each thread keeps its
# own (thread-affine) YTMusic client alive.
# --------------------------------------------------------------------------- #
_tls = threading.local()
_yt_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ytmusic")


def _yt_call_retry(job, attempts=2):
    """YouTube Music occasionally answers with a transient error; one quiet retry fixes most."""
    last = None
    for i in range(attempts):
        try:
            return yt_call(job)
        except Exception as exc:  # noqa: BLE001
            last = exc
            if i + 1 < attempts:
                time.sleep(0.4)
    raise last


def yt_call(fn, timeout: float = 45):
    """Run fn(ytmusic_client) on a pooled worker thread that owns a client."""

    def job():
        client = getattr(_tls, "client", None)
        if client is None:
            client = YTMusic()
            _tls.client = client
        return fn(client)

    return _yt_executor.submit(job).result(timeout=timeout)


# --------------------------------------------------------------------------- #
# Normalisation helpers
# --------------------------------------------------------------------------- #
def parse_duration(value) -> int:
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        parts = [p for p in value.strip().split(":") if p.strip()]
        try:
            total = 0
            for p in parts:
                total = total * 60 + int(p)
            return total
        except ValueError:
            return 0
    return 0


def norm_artists(raw) -> list[dict]:
    out: list[dict] = []
    for a in raw.get("artists") or []:
        if isinstance(a, dict) and a.get("name"):
            out.append({"name": a["name"], "id": a.get("id")})
        elif isinstance(a, str) and a.strip():
            out.append({"name": a.strip(), "id": None})
    if not out:
        for key in ("author", "artist"):
            v = raw.get(key)
            if isinstance(v, str) and v.strip():
                out.append({"name": v.strip(), "id": raw.get("channelId")})
                break
    return out


def norm_track(raw: dict) -> dict | None:
    vid = raw.get("videoId")
    if not vid or not VIDEO_ID_RE.match(vid):
        return None
    artists = norm_artists(raw)
    album = raw.get("album")
    if isinstance(album, dict):
        album = {"name": album.get("name"), "id": album.get("id")}
    else:
        album = None
    duration = raw.get("duration_seconds")
    if duration is None:
        duration = parse_duration(raw.get("duration") or raw.get("length"))
    return {
        "video_id": vid,
        "title": raw.get("title") or "Unknown track",
        "artists": artists,
        "artist_text": ", ".join(a["name"] for a in artists) or "Unknown artist",
        "album": album,
        "duration": int(duration or 0),
        "year": raw.get("year"),
    }


def norm_tracks(raw_list) -> list[dict]:
    seen, out = set(), []
    for raw in raw_list or []:
        if not isinstance(raw, dict):
            continue
        t = norm_track(raw)
        if t and t["video_id"] not in seen:
            seen.add(t["video_id"])
            out.append(t)
    return out


def pick_thumb(thumbs, size: int = 226) -> str | None:
    """Smallest thumbnail that is at least <size> px wide (else the largest)."""
    if not thumbs:
        return None
    ordered = sorted(thumbs, key=lambda t: t.get("width") or 0)
    for t in ordered:
        if (t.get("width") or 0) >= size:
            return t.get("url")
    return ordered[-1].get("url")


def first_artist_id(track: dict) -> str | None:
    for a in track.get("artists", []):
        if a.get("id"):
            return a["id"]
    return None


# --------------------------------------------------------------------------- #
# Streaming: download audio to a local cache, then serve it with Range support.
# --------------------------------------------------------------------------- #
_dl_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="download")

ENGINE_STARTED = time.time()
_stats_lock = threading.Lock()
_stats = {"downloads": 0, "inflight": 0, "download_seconds": 0.0, "bytes_served": 0, "failures": 0}
_locks_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}


def _lock_for(video_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(video_id, threading.Lock())


def cached_audio_path(video_id: str) -> Path | None:
    for p in AUDIO_DIR.glob(f"{video_id}.*"):
        if p.suffix != ".part" and p.stat().st_size > 4096:
            return p
    return None


def _evict_cache() -> None:
    files = sorted(AUDIO_DIR.glob("*.*"), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    for p in files:
        if total <= CACHE_MAX_BYTES:
            break
        try:
            size = p.stat().st_size
            p.unlink()
            total -= size
        except OSError:
            pass


class DownloadError(RuntimeError):
    pass


class StreamBlocked(DownloadError):
    """YouTube refused to serve the media bytes to this server's IP."""


_BLOCK_MARKERS = ("403", "forbidden", "sign in to confirm", "not a bot", "too many requests")


def _looks_blocked(msg: str) -> bool:
    low = msg.lower()
    return any(m in low for m in _BLOCK_MARKERS)


def download_audio(video_id: str) -> Path:
    """Download (or return already cached) audio for a video id."""
    existing = cached_audio_path(video_id)
    if existing:
        os.utime(existing, None)  # mark as recently used
        return existing

    with _lock_for(video_id):
        existing = cached_audio_path(video_id)
        if existing:
            return existing

        opts = {
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": str(AUDIO_DIR / f"{video_id}.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "noprogress": True,
            "retries": 3,
            "socket_timeout": 30,
            "overwrites": True,
            "cachedir": str(CACHE_ROOT / "ytdlp"),
        }
        t0 = time.time()
        with _stats_lock:
            _stats["inflight"] += 1
        try:
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
            except Exception as exc:  # noqa: BLE001
                with _stats_lock:
                    _stats["failures"] += 1
                detail = str(exc).splitlines()[0][:200] if str(exc).strip() else exc.__class__.__name__
                if _looks_blocked(detail):
                    raise StreamBlocked(detail) from exc
                raise DownloadError(detail) from exc
        finally:
            with _stats_lock:
                _stats["inflight"] -= 1
                _stats["downloads"] += 1
                _stats["download_seconds"] += time.time() - t0

        path = cached_audio_path(video_id)
        if not path:
            raise DownloadError("audio file was not produced")
        _evict_cache()
        return path


def prefetch_audio(video_id: str) -> None:
    if cached_audio_path(video_id):
        return
    _dl_executor.submit(lambda: _safe_download(video_id))


def _safe_download(video_id: str) -> None:
    try:
        download_audio(video_id)
    except Exception:  # noqa: BLE001 — prefetch is best-effort
        pass


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
@app.after_request
def _cors(resp):
    """Let a standalone dashboard.html hosted anywhere (or opened from file://) call this API."""
    resp.headers.setdefault("Access-Control-Allow-Origin", "*")
    resp.headers.setdefault("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    resp.headers.setdefault("Access-Control-Allow-Headers", "Range, Content-Type, Accept")
    resp.headers.setdefault("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
    resp.headers.setdefault("Access-Control-Max-Age", "86400")
    return resp


@app.route("/api/<path:_any>", methods=["OPTIONS"])
def _cors_preflight(_any):
    return ("", 204)


# --------------------------------------------------------------------------- #
# PWA: installable app, served from the same origin as the API
# --------------------------------------------------------------------------- #
PWA_DIR = Path(__file__).parent / "static" / "pwa"


@app.get("/manifest.webmanifest")
def pwa_manifest():
    resp = send_file(PWA_DIR / "manifest.webmanifest", mimetype="application/manifest+json")
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.get("/sw.js")
def pwa_service_worker():
    resp = send_file(PWA_DIR / "sw.js", mimetype="text/javascript")
    # must live at the root with this header so it can control the whole origin
    resp.headers["Service-Worker-Allowed"] = "/"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


def _selfcheck():
    """Log what the deployment depends on, so a bad container is obvious in the logs."""
    import shutil as _sh
    problems = []
    if not (CACHE_ROOT / "audio").exists():
        try:
            (CACHE_ROOT / "audio").mkdir(parents=True, exist_ok=True)
            (CACHE_ROOT / "img").mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            problems.append(f"cache dir not writable: {exc}")
    if not _sh.which("ffmpeg"):
        # not fatal: we request a single m4a stream, so yt-dlp never needs to remux
        app.logger.info("ffmpeg not installed — fine for audio-only m4a streams")
    for problem in problems:
        app.logger.error("startup: %s", problem)
    return problems


@app.get("/index.html")
def index_html():
    """Some PWA start_urls and bookmarks point here; serve the app rather than a 404."""
    return redirect("/", code=302)


@app.get("/healthz")
def healthz():
    """Render/Fly/Railway probes: cheap, no upstream calls."""
    return jsonify(status="ok", uptime_seconds=int(time.time() - ENGINE_STARTED))


@app.get("/")
def index():
    """Dashboard UI (the main app)."""
    return render_template("dashboard.html")


def _rank_tracks(tracks, query, limit, rank_hint=None):
    """Order results the way a person expects.

    Three signals, strongest first: the *song* they typed, the *artist* they typed, and —
    as a stand-in for popularity — how early YouTube itself ranked the result.
    """
    rank_hint = rank_hint or {}
    ql = " ".join(query.lower().split())
    tokens = [t for t in ql.replace("-", " ").replace("–", " ").split() if len(t) > 1]

    # Is this an artist query or a song query? The results themselves tell us:
    # "daft punk" matches an artist name (and one joker's song title), "song 2" a title.
    artist_q = any((t.get("artist_text") or "").strip().lower() == ql for t in tracks)
    title_q = any((t.get("title") or "").strip().lower() == ql for t in tracks)

    # Many results sharing the exact title ⇒ a song query; a crowd of results by the same
    # artist ⇒ an artist query whose own catalogue should lead ("nirvana", "blur").
    title_hits = sum(1 for t in tracks if (t.get("title") or "").strip().lower() == ql)
    same_artist = {}
    for t in tracks:
        key = (t.get("artist_text") or "").strip().lower()
        same_artist[key] = same_artist.get(key, 0) + 1
    # "nirvana" → 31 results by Nirvana vs 5 songs merely *called* Nirvana → artist query.
    # "karma police" → as many covers named after the song as the band → song query.
    artist_dominant = same_artist.get(ql, 0) >= max(3, 2.5 * title_hits)
    w_title, w_artist = (160, 120)
    if artist_q and not title_q:
        w_title, w_artist = 120, 200
    elif artist_q and title_q:
        w_title, w_artist = 160, 170

    def score(t):
        title = (t.get("title") or "").lower()
        artist = (t.get("artist_text") or "").lower()
        album = ((t.get("album") or {}).get("name") or "").lower()
        s = 0
        if ql:
            if title == ql:
                s += w_title
            elif ql in title:
                s += w_title * 0.5
            if artist == ql:
                s += w_artist
            elif ql in artist:
                s += w_artist * 0.58
        for tok in tokens:
            if tok in title:
                s += 7
            if tok in artist:
                s += 9
            if tok in album:
                s += 2
        if tokens and all(tok in title for tok in tokens):
            s += 26
        if tokens and all(tok in artist for tok in tokens):
            s += 22
        # YouTube's relevance order is popularity-aware, so it leads — but a perfect
        # artist/title match can outrank a slightly-better-ranked near miss.
        idx = rank_hint.get(t.get("video_id"))
        s += max(0, 240 - 12 * idx) if idx is not None else 0
        if artist_dominant and artist == ql:
            s += 260                     # the artist they asked for, not a song named after them
        return s

    def relevant(t):
        """Does the query appear anywhere in the result at all?"""
        if not tokens:
            return True
        hay = ((t.get("title") or "") + " " + (t.get("artist_text") or "") + " " +
               ((t.get("album") or {}).get("name") or "")).lower()
        return any(tok in hay for tok in tokens)

    pool = [t for t in tracks if relevant(t)]
    if not pool:                                  # nothing matched: report nothing rather than noise
        return []

    scored = sorted(((score(t), i, t) for i, t in enumerate(pool)), key=lambda x: (-x[0], x[1]))
    seen, out = set(), []
    for _, _, t in scored:
        key = ((t.get("title") or "").strip().lower(), (t.get("artist_text") or "").strip().lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
        if len(out) >= limit:
            break
    return out


@app.get("/api/search")
def api_search():
    q = (request.args.get("q") or "").strip()
    limit = min(int(request.args.get("limit", 24)), 40)
    if not q:
        return jsonify(error="missing query"), 400

    # Three YouTube Music calls, run in parallel — sequential they pushed search past 4 s.
    def job_broad(yt):
        return yt.search(q, limit=max(limit, 20)) or []

    def job_songs(yt):
        return yt.search(q, filter="songs", limit=max(limit, 24)) or []

    def job_artists(yt):
        return yt.search(q, filter="artists", limit=8) or []

    t0 = time.time()
    results = {}

    def run(key, fn):
        try:
            results[key] = _yt_call_retry(fn)
        except Exception as exc:  # noqa: BLE001
            results[key] = []
            app.logger.warning("search %r (%s) failed: %s", q, key, exc)

    threads = [threading.Thread(target=run, args=("broad", job_broad), daemon=True),
               threading.Thread(target=run, args=("songs", job_songs), daemon=True),
               threading.Thread(target=run, args=("artists", job_artists), daemon=True)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    broad = results.get("broad") or []
    artists = results.get("artists") or []

    filtered = results.get("songs") or []

    merged, seen = [], set()
    for r in broad + filtered:
        if r.get("resultType") not in ("song", "video"):
            continue
        vid = r.get("videoId")
        if not vid or vid in seen:
            continue
        seen.add(vid)
        merged.append(r)
    artists = artists + [r for r in broad if r.get("resultType") == "artist"]
    rank_hint = {r.get("videoId"): i for i, r in enumerate(broad)}

    if not merged:
        return jsonify(query=q, tracks=[], artists=[], suggestions=[])

    ranked = _rank_tracks(norm_tracks(merged), q, limit, rank_hint)
    app.logger.info("search %r: %d results in %.2fs", q, len(ranked), time.time() - t0)

    out_artists, seen_names = [], set()
    for a in artists:
        name = (a.get("artist") or a.get("title") or "").strip()
        if not name or name.lower() in seen_names:
            continue
        seen_names.add(name.lower())
        out_artists.append({
            "name": name,
            "id": a.get("browseId"),
            "subscribers": a.get("subscribers"),
            "thumbnail": pick_thumb(a.get("thumbnails"), 226),
        })
    for t in ranked:
        for a in t.get("artists") or []:
            name = (a.get("name") or "").strip()
            if not name or name.lower() in seen_names:
                continue
            seen_names.add(name.lower())
            out_artists.append({"name": name, "id": a.get("id"), "subscribers": None, "thumbnail": None})

    suggestions = []
    if not ranked:
        try:
            def sug(yt):
                return yt.get_search_suggestions(q) or []
            suggestions = [x for x in _yt_call_retry(sug) if isinstance(x, str)][:6]
        except Exception:  # noqa: BLE001
            suggestions = []

    return jsonify(query=q, tracks=ranked, artists=out_artists[:12] if ranked else [], suggestions=suggestions)


@app.get("/api/suggest")
def api_suggest():
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify(suggestions=[])
    try:
        items = yt_call(lambda yt: yt.get_search_suggestions(q), timeout=15) or []
    except Exception:  # noqa: BLE001
        items = []
    return jsonify(suggestions=[s for s in items if isinstance(s, str)][:8])


@app.get("/api/radio")
def api_radio():
    """Tracks to play next: YouTube Music's radio / 'up next' for a seed track."""
    vid = (request.args.get("videoId") or "").strip()
    limit = min(int(request.args.get("limit", 25)), 50)
    if not VIDEO_ID_RE.match(vid):
        return jsonify(error="bad videoId"), 400
    try:
        data = yt_call(lambda yt: yt.get_watch_playlist(videoId=vid, limit=limit + 1))
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"radio failed: {exc}"), 502
    tracks = [t for t in norm_tracks(data.get("tracks")) if t["video_id"] != vid]
    return jsonify(seed=vid, tracks=tracks)


@app.get("/api/artist")
def api_artist():
    """Artist overview: top songs, albums, similar artists — by id or name."""
    bid = (request.args.get("id") or "").strip()
    name = (request.args.get("name") or "").strip()

    def job(yt):
        nonlocal bid
        if not bid and name:
            found = yt.search(name, filter="artists", limit=1) or []
            if found:
                bid = found[0].get("browseId")
        if not bid:
            raise LookupError("artist not found")
        art = yt.get_artist(bid)
        top = []
        songs_section = art.get("songs") or {}
        if songs_section.get("browseId"):
            try:
                pl = yt.get_playlist(songs_section["browseId"], limit=25)
                top = pl.get("tracks") or []
            except Exception:  # noqa: BLE001
                top = songs_section.get("results") or []
        return art, top

    try:
        art, top = yt_call(job)
    except LookupError as exc:
        return jsonify(error=str(exc)), 404
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"artist lookup failed: {exc}"), 502

    albums = []
    for key in ("albums", "singles"):
        for al in (art.get(key) or {}).get("results") or []:
            albums.append(
                {
                    "id": al.get("browseId"),
                    "title": al.get("title"),
                    "year": al.get("year"),
                    "type": "Single" if key == "singles" else "Album",
                }
            )

    return jsonify(
        id=art.get("channelId") or bid,
        name=art.get("name"),
        description=(art.get("description") or "")[:600],
        subscribers=art.get("subscribers"),
        thumbnail=pick_thumb(art.get("thumbnails"), 300),
        monthly_listeners=art.get("monthlyListeners"),
        top_tracks=norm_tracks(top),
        albums=albums[:12],
        similar=[
            {"name": r.get("title"), "id": r.get("browseId")}
            for r in (art.get("related") or {}).get("results") or []
            if r.get("browseId")
        ][:12],
    )


@app.get("/api/artist/radio")
def api_artist_radio():
    """Artist radio station — a continuous mix seeded by the artist."""
    bid = (request.args.get("id") or "").strip()
    limit = min(int(request.args.get("limit", 30)), 50)
    if not SAFE_BROWSE_RE.match(bid):
        return jsonify(error="bad artist id"), 400

    def job(yt):
        art = yt.get_artist(bid)
        radio_id = art.get("radioId") or art.get("shuffleId")
        if not radio_id:
            raise LookupError("this artist has no radio station")
        data = yt.get_watch_playlist(playlistId=radio_id, limit=limit)
        return art.get("name"), norm_tracks(data.get("tracks"))

    try:
        name, tracks = yt_call(job)
    except LookupError as exc:
        return jsonify(error=str(exc)), 404
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"radio failed: {exc}"), 502
    return jsonify(station_name=name, tracks=tracks)


@app.get("/api/album")
def api_album():
    bid = (request.args.get("id") or "").strip()
    if not SAFE_BROWSE_RE.match(bid):
        return jsonify(error="bad album id"), 400
    try:
        alb = yt_call(lambda yt: yt.get_album(bid))
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"album lookup failed: {exc}"), 502
    return jsonify(
        id=alb.get("audioPlaylistId") or bid,
        title=alb.get("title"),
        year=alb.get("year"),
        tracks=norm_tracks(alb.get("tracks")),
    )


# ── dashboard panels ────────────────────────────────────────────────────────


@app.get("/api/trending")
def api_trending():
    """Trending tracks + artists for a country (YouTube Music charts)."""
    country = (request.args.get("country") or "CH").upper()[:2]
    limit = min(int(request.args.get("limit", 12)), 30)

    def job(yt):
        charts = yt.get_charts(country=country)
        vids = charts.get("videos") or []
        artists = charts.get("artists") or []
        tracks = []
        if vids:
            try:
                pl = yt.get_playlist(vids[0]["playlistId"], limit=limit)
                tracks = pl.get("tracks") or []
            except Exception:  # noqa: BLE001
                tracks = []
        if not tracks:
            # fall back to the trending chart for the whole world
            zz = yt.get_charts(country="ZZ")
            zv = zz.get("videos") or []
            if zv:
                try:
                    pl = yt.get_playlist(zv[0]["playlistId"], limit=limit)
                    tracks = pl.get("tracks") or []
                except Exception:  # noqa: BLE001
                    tracks = []
            artists = artists or zz.get("artists") or []
        return charts, tracks, artists

    try:
        charts, tracks, artists = yt_call(job)
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"trending failed: {exc}"), 502

    selected = (charts.get("countries") or {}).get("selected") or {}
    return jsonify(
        country=country,
        country_name=selected.get("text") or country,
        countries=(charts.get("countries") or {}).get("options") or [country],
        tracks=norm_tracks(tracks)[:limit],
        artists=[
            {
                "name": a.get("title"),
                "id": a.get("browseId"),
                "subscribers": a.get("subscribers"),
                "rank": a.get("rank"),
                "trend": a.get("trend"),
                "thumbnail": pick_thumb(a.get("thumbnails"), 120),
            }
            for a in artists[:limit]
        ],
    )


@app.get("/api/genres")
def api_genres():
    """Browse tree: moods & moments + genres."""
    try:
        cats = yt_call(lambda yt: yt.get_mood_categories())
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"genres failed: {exc}"), 502
    return jsonify(
        categories=[
            {
                "title": title,
                "items": [{"title": x.get("title"), "params": x.get("params")} for x in items if x.get("params")],
            }
            for title, items in (cats or {}).items()
        ]
    )


@app.get("/api/genre")
def api_genre():
    """Playlists inside one mood/genre tile."""
    params = (request.args.get("params") or "").strip()
    if not SAFE_BROWSE_RE.match(params):
        return jsonify(error="bad params"), 400
    try:
        playlists = yt_call(lambda yt: yt.get_mood_playlists(params)) or []
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"genre failed: {exc}"), 502
    return jsonify(
        playlists=[
            {
                "title": p.get("title"),
                "id": p.get("playlistId"),
                "thumbnail": pick_thumb(p.get("thumbnails"), 226),
                "count": p.get("count"),
            }
            for p in playlists
            if p.get("playlistId")
        ]
    )


@app.get("/api/playlist")
def api_playlist():
    """Track list for a YouTube Music playlist (mixes, genre playlists, charts)."""
    pid = (request.args.get("id") or "").strip()
    if not SAFE_BROWSE_RE.match(pid):
        return jsonify(error="bad playlist id"), 400
    limit = min(int(request.args.get("limit", 80)), 150)
    try:
        pl = yt_call(lambda yt: yt.get_playlist(pid, limit=limit))
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"playlist failed: {exc}"), 502
    return jsonify(
        id=pid,
        title=pl.get("title"),
        author=(pl.get("author") or {}).get("name") if isinstance(pl.get("author"), dict) else pl.get("author"),
        track_count=pl.get("trackCount"),
        tracks=norm_tracks(pl.get("tracks")),
    )


@app.get("/api/stats")
def api_stats():
    """Engine telemetry for the dashboard's system panel."""
    files = [f for f in AUDIO_DIR.glob("*.*") if f.suffix != ".part"]
    with _stats_lock:
        snap = dict(_stats)
    return jsonify(
        cached_tracks=len(files),
        cached_bytes=sum(f.stat().st_size for f in files),
        downloads=snap["downloads"],
        downloads_inflight=snap["inflight"],
        download_failures=snap["failures"],
        avg_download_seconds=round(snap["download_seconds"] / snap["downloads"], 2) if snap["downloads"] else None,
        bytes_served=snap["bytes_served"],
        uptime_seconds=round(time.time() - ENGINE_STARTED, 1),
        cache_limit_bytes=CACHE_MAX_BYTES,
    )


@app.get("/api/ready/<video_id>")
def api_ready(video_id: str):
    """Is this track already buffered on the server? (drives the 'ready ahead' stat)"""
    if not VIDEO_ID_RE.match(video_id):
        abort(400)
    p = cached_audio_path(video_id)
    return jsonify(video_id=video_id, cached=bool(p), bytes=p.stat().st_size if p else 0)


@app.get("/classic")
def classic():
    """The original single-column player UI, kept for reference."""
    return render_template("index.html")


@app.route("/api/stream/<video_id>", methods=["GET", "HEAD"])
def api_stream(video_id: str):
    if not VIDEO_ID_RE.match(video_id):
        abort(400)
    started = time.time()
    try:
        path = download_audio(video_id)
    except StreamBlocked as exc:
        app.logger.warning("YouTube blocked media fetch for %s: %s", video_id, exc)
        return jsonify(
            error="YouTube refused to serve this audio to the server's IP address.",
            code="youtube_blocked",
            hint=(
                "Search, charts and suggestions still work. Playback needs a network YouTube "
                "doesn't rate-limit — run the app on your own machine/home connection, or use a "
                "residential VPN. Datacenter/cloud IPs are blocked most often."
            ),
            upstream=str(exc),
        ), 503
    except DownloadError as exc:
        app.logger.warning("download failed for %s: %s", video_id, exc)
        return jsonify(error=str(exc), code="download_failed"), 502
    with _stats_lock:
        _stats["bytes_served"] += path.stat().st_size
    app.logger.info("serving %s (%s) after %.2fs", video_id, path.name, time.time() - started)
    mime = MIME.get(path.suffix, mimetypes.guess_type(path.name)[0] or "application/octet-stream")
    resp = send_file(path, mimetype=mime, conditional=True, etag=True)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


@app.post("/api/prefetch/<video_id>")
def api_prefetch(video_id: str):
    if not VIDEO_ID_RE.match(video_id):
        abort(400)
    prefetch_audio(video_id)
    return jsonify(ok=True)


_IMG_HOSTS = (".googleusercontent.com", ".ggpht.com", ".ytimg.com")


@app.get("/api/img")
def api_img():
    """Proxy external images (artist photos) so the UI works behind any sandbox."""
    url = request.args.get("u") or ""
    host = url.split("/")[2].split(":")[0] if url.startswith("https://") and "/" in url[8:] else ""
    if not host or not host.endswith(_IMG_HOSTS):
        abort(400)
    key = hashlib.sha1((url + "|v1").encode()).hexdigest()[:24]
    cached = next(IMG_DIR.glob(f"{key}.*"), None)
    if cached is None:
        try:
            r = requests.get(url, timeout=12, headers={"User-Agent": "Mozilla/5.0 (Cadence)"})
            r.raise_for_status()
        except Exception:  # noqa: BLE001
            abort(502)
        ext = mimetypes.guess_extension(r.headers.get("Content-Type", "").split(";")[0]) or ".jpg"
        cached = IMG_DIR / f"{key}{ext}"
        cached.write_bytes(r.content)
    return send_file(cached, max_age=86400)


@app.get("/api/thumb/<video_id>")
def api_thumb(video_id: str):
    """Track artwork via the same image proxy (16:9 thumbnail from YouTube)."""
    if not VIDEO_ID_RE.match(video_id):
        abort(400)
    return api_img_redirect(f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg")


def api_img_redirect(url: str):
    key = hashlib.sha1((url + "|v1").encode()).hexdigest()[:24]
    cached = next(IMG_DIR.glob(f"{key}.*"), None)
    if cached is None:
        try:
            r = requests.get(url, timeout=12, headers={"User-Agent": "Mozilla/5.0 (Cadence)"})
            if r.status_code == 200 and r.content:
                cached = IMG_DIR / f"{key}.jpg"
                cached.write_bytes(r.content)
        except Exception:  # noqa: BLE001
            pass
    if cached is None:
        # 1x1 transparent gif fallback
        import base64

        gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
        from flask import Response

        return Response(gif, mimetype="image/gif", status=200)
    return send_file(cached, max_age=86400)


_selfcheck()
_evict_cache()

if __name__ == "__main__":
    print(f"🎧  Cadence running on http://0.0.0.0:{PORT}")
    app.run(host="0.0.0.0", port=PORT, threaded=True, debug=False)
