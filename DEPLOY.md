# Deploying Cadence

The app is a single Flask service: it serves the dashboard, the installable PWA assets
(`/manifest.webmanifest`, `/sw.js`, icons) **and** the JSON/audio API from one origin. That
matters — a same-origin deployment means no CORS setup and no mixed-content problems, and the
installed Android app talks to the same URL it was installed from.

Everything below is prepared and tested; only the account-level clicks are yours.

| File | Used by |
|---|---|
| `Dockerfile` | Render, Railway, Fly, any container host |
| `render.yaml` | Render Blueprint (includes a 5 GB persistent disk) |
| `railway.json` | Railway (Dockerfile builder + health check) |
| `fly.toml` | Fly.io (volume mount, https redirect, scale-to-zero) |
| `Procfile` | Heroku-style hosts |
| `/healthz` | health probe for all of them (`{"status":"ok"}`) |

---

## 0. Put the code in a git repo

All three platforms deploy from git.

```bash
cd cadence
git init
git add .
git commit -m "Cadence: dashboard, API, PWA"
# create an empty repo on GitHub first, then:
git remote add origin https://github.com/<you>/cadence.git
git push -u origin main
```

`standalone/`, `run.sh`, the platform files and `*.zip` are excluded from the image by
`.dockerignore`; `__pycache__` and `.venv` are in `.gitignore`.

---

## 1. Render (recommended, and the simplest)

1. Sign in at <https://render.com>, click **New → Blueprint**.
2. Pick your repo. Render reads `render.yaml` and shows a `cadence` web service with a
   `/data` disk.
3. **Apply** — first build takes ~3–5 minutes, mostly `pip install`.

You get `https://cadence-xxxx.onrender.com`.

Notes:
- `plan: starter` (paid) keeps the service warm. The **free** plan sleeps after 15 minutes of
  inactivity, so the first request afterwards takes ~30 s — the health check absorbs it.
- Change `region:` in `render.yaml` if you prefer a different one; `frankfurt` is closest to
  Switzerland.
- The disk keeps the audio cache across restarts. 5 GB is plenty (the cache self-evicts at
  3 GB).

Without the blueprint, creating a plain **Web Service** also works: Render detects the
Dockerfile automatically. Add env vars `CADENCE_CACHE=/data` and `PORT=10000`, and a disk
mounted at `/data`.

---

## 2. Railway

```bash
npm i -g @railway/cli
railway login
railway init                      # create a new project
railway up                        # builds the Dockerfile and deploys

# persistent cache (otherwise it's rebuilt after every deploy)
railway volume add --mount-path /data
railway variables set CADENCE_CACHE=/data
railway domain                    # gives you an https URL
```

`railway.json` already sets the start command, `/healthz` health check and single-replica
policy. Keep **one replica**: the download locks and telemetry counters live in-process.

---

## 3. Fly.io

```bash
curl -L https://fly.io/install.sh | sh
fly auth login

cd cadence
fly launch --copy-config --name cadence-<something-unique> --region zrh
fly volumes create cadence_cache --size 5 --region zrh
fly deploy
```

`fly.toml` sets `force_https = true`, mounts the volume at `/data`, and stops the machine when
idle (`auto_stop_machines = "stop"`) — a cold start costs a couple of seconds.

---

## After deploying — check these three things

```bash
BASE=https://your-app.example

curl -s $BASE/healthz                       # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' $BASE/manifest.webmanifest   # 200
curl -s $BASE/api/stats                     # JSON, cached_tracks etc.
```

Then open `$BASE` on your phone → **Install Cadence** appears → install. The installed app is
same-origin with the API, so search and playback work with no extra configuration (no ⚙
backend URL needed).

### Expectations on cloud hosting

**Audio downloads may be blocked.** YouTube rate-limits media fetches from datacenter IPs.
Render, Railway and Fly all run in datacenters, so playback can fail with

```json
{"error":"YouTube refused to serve this audio to the server's IP address.","code":"youtube_blocked"}
```

The dashboard says so explicitly and pauses instead of skipping. Search, charts, genres,
artist pages and suggestions all keep working — only the audio bytes are refused. Options:

- Route `yt-dlp` through a residential proxy: set `HTTPS_PROXY` in the service's environment.
- Keep playback local (`./run.sh` on your machine) and use the deployed instance for browsing.
- Some regions/IPs are not blocked — it's worth simply testing your deployment.

**Memory.** `yt-dlp` plus Flask sits around 150–250 MB; the Fly config requests 512 MB. The
audio is streamed from disk, not buffered in RAM.

**Cold starts.** Free tiers sleep. The service worker means the *interface* opens instantly
even then; only live data waits for the wake-up.

**Single worker.** `--workers 1 --threads 16` is deliberate. Multiple worker processes would
each keep their own cache index, download locks and stats, so the engine panel would flicker
and two workers could download the same track. Scale with threads, not workers.

---

## Updating a deployment

```bash
git add -A && git commit -m "..." && git push     # Render/Railway auto-deploy
fly deploy                                         # Fly
```

The service worker caches the shell, so after an update users get the new version on their next
navigation (network-first for pages). To force it, bump `VERSION` in `static/pwa/sw.js` and
`standalone/pwa/sw.js`.

## Rebuilding the PWA from the dashboard sources

```bash
python3 standalone/build_standalone.py     # → cadence-dashboard.html + cadence-android/
python3 standalone/make_icons.py           # if you change the icon design
cp standalone/pwa/sw.js static/pwa/sw.js   # keep the served worker in sync
```
