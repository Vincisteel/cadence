#!/usr/bin/env python3
"""Build the standalone single-file dashboard.

Reads the Flask templates/CSS/JS and fuses them into one self-contained .html:
no server, no external requests, works from file://, a static host, or an e-mail.

    python3 standalone/build_standalone.py   →  ../cadence-dashboard.html
"""
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                     # /home/user/cadence
OUT = ROOT.parent / "cadence-dashboard.html"

html = (ROOT / "templates" / "dashboard.html").read_text()
css = (ROOT / "static" / "dash.css").read_text()
dash = (ROOT / "static" / "dash.js").read_text()
runtime = (HERE / "runtime.js").read_text()

# ── 1. dashboard.js → reroute every network touchpoint through the runtime ──
subs = [
    # data source
    ("""async function api(path, opts) {
  const r = await fetch(path, opts);
  let data = null; try { data = await r.json(); } catch {}
  if (!r.ok) {
    const err = new Error((data && data.error) || `Request failed (${r.status})`);
    err.status = r.status; err.code = data && data.code; err.hint = data && data.hint;
    throw err;
  }
  return data;
}""",
     """async function api(path, opts) { return window.__SRC__.api(path, opts); }"""),

    # artwork
    ("const thumb = vid => `/api/thumb/${vid}`;",
     "const thumb = vid => window.__SRC__.thumb(vid);"),
    ("const imgp = u => `/api/img?u=${encodeURIComponent(u)}`;",
     "const imgp = u => window.__SRC__.img(u);"),

    # the media element (real <audio> when connected, virtual clock in demo)
    ("const audio = $('#audio');",
     "const audio = window.__SRC__.makeAudio($('#audio'));"),

    # stream diagnostics
    ("""async function diagnoseStream(id) {
  try {
    const r = await fetch(`/api/stream/${id}`, { headers: { Range: 'bytes=0-1' } });
    if (r.ok) return { kind: 'transient' };
    let d = {}; try { d = await r.json(); } catch {}
    return { kind: d.code || 'unknown', message: d.error, hint: d.hint };
  } catch {
    return { kind: 'offline' };
  }
}""",
     """async function diagnoseStream(id) { return window.__SRC__.diagnose(id); }"""),

    # prefetch
    ("  try { await fetch(`/api/prefetch/${nxt.video_id}`, { method: 'POST' }); } catch {}",
     "  await window.__SRC__.prefetch(nxt.video_id);"),
]

missing = []
for old, new in subs:
    if old in dash:
        dash = dash.replace(old, new)
    else:
        missing.append(old.splitlines()[0][:70])
if missing:
    sys.exit("✗ anchors not found in dash.js:\n  - " + "\n  - ".join(missing))

# demo mode is offline by nature: don't pretend a backend is missing
dash = dash.replace(
    "      toast('Backend not reachable — start it with ./run.sh (search, streaming and suggestions need it)', true, 9000);",
    "      if (window.__SRC__.mode === 'demo') return;\n"
    "      toast('Backend not reachable — open ⚙ Settings to fix the URL or switch to Demo mode', true, 9000);")

dash = dash.replace(
    "function reportBlocked(info) {\n  if (blockingReported) return;",
    "function reportBlocked(info) {\n  if (blockingReported || window.__SRC__.mode === 'demo') return;")

# ── 2. fold CSS in, add the standalone-only styling ────────────────────────
extra_css = """
/* ── standalone build: settings + mode pill ─────────────────────────────── */
.mode-pill{margin-left:auto;display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;
  border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--dim);
  font:inherit;font-size:12px;font-weight:600;cursor:pointer;letter-spacing:.2px}
.mode-pill:hover{color:var(--fg);border-color:rgba(255,255,255,.22)}
.mode-pill.demo{color:#fbbf24;border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.09)}
.mode-pill.live{color:#4ade80;border-color:rgba(74,222,128,.35);background:rgba(74,222,128,.09)}
.cfg-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
  padding:20px;background:rgba(6,8,14,.72);backdrop-filter:blur(10px)}
.cfg-overlay[hidden]{display:none}   /* a class-level display: would otherwise defeat [hidden] */
.cfg-card{width:min(560px,100%);background:linear-gradient(180deg,rgba(26,30,44,.98),rgba(16,19,29,.98));
  border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:26px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.cfg-card h2{margin:0 0 6px;font-size:19px}
.cfg-sub{margin:0 0 18px;color:var(--dim);font-size:13px;line-height:1.55}
.cfg-opt{display:flex;gap:11px;align-items:flex-start;padding:13px 14px;margin-bottom:9px;cursor:pointer;
  border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.02)}
.cfg-opt:has(input:checked){border-color:rgba(139,92,246,.55);background:rgba(139,92,246,.10)}
.cfg-opt input{margin-top:3px;accent-color:#8b5cf6}
.cfg-opt span{display:block;font-size:13.5px;font-weight:600;line-height:1.4}
.cfg-opt em{display:block;font-style:normal;font-weight:400;font-size:12px;color:var(--dim);margin-top:3px}
.cfg-url{width:100%;margin:6px 0 10px;padding:11px 13px;border-radius:11px;border:1px solid var(--line);
  background:rgba(0,0,0,.35);color:var(--fg);font:inherit;font-size:13px}
.cfg-url:focus{outline:none;border-color:rgba(139,92,246,.6)}
.cfg-note{font-size:12px;color:var(--dim);line-height:1.6;margin-bottom:16px}
.cfg-note.ok{color:#4ade80}.cfg-note.err{color:#f87171}
.cfg-note code{background:rgba(255,255,255,.08);padding:1px 5px;border-radius:5px;font-size:11.5px}
.cfg-actions{display:flex;gap:10px;justify-content:flex-end}
.cfg-btn{height:38px;padding:0 16px;border-radius:10px;border:1px solid var(--line);background:rgba(255,255,255,.05);
  color:var(--fg);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.cfg-btn:hover{background:rgba(255,255,255,.1)}
.cfg-btn.primary{background:linear-gradient(135deg,#8b5cf6,#22d3ee);border-color:transparent;color:#0a0713}
.cfg-btn.primary:hover{filter:brightness(1.08)}
@media(max-width:900px){.mode-pill{display:none}}

/* install banner (PWA) */
.install-bar{position:fixed;left:12px;right:12px;bottom:calc(var(--player-h) + 14px);z-index:120;
  display:flex;align-items:center;gap:11px;padding:11px 12px;border-radius:15px;
  background:linear-gradient(180deg,rgba(32,36,52,.99),rgba(20,23,34,.99));
  border:1px solid rgba(139,92,246,.4);box-shadow:0 18px 50px rgba(0,0,0,.55);
  animation:pop .26s ease;max-width:min(560px,calc(100vw - 24px));margin:0 auto}
.install-bar img{border-radius:9px;flex:0 0 auto}
.install-bar .ib-text{min-width:0;flex:1}
.install-bar b{display:block;font-size:13px}
.install-bar span{display:block;font-size:11.5px;color:var(--dim);line-height:1.4;margin-top:1px}
.install-bar .ib-go{flex:0 0 auto;height:34px;padding:0 14px;border-radius:9px;border:0;cursor:pointer;
  background:linear-gradient(135deg,#8b5cf6,#22d3ee);color:#0a0713;font:inherit;font-size:12.5px;font-weight:700}
.install-bar .ib-x{flex:0 0 auto;width:28px;height:28px;border:0;background:transparent;color:var(--dim);
  font-size:14px;cursor:pointer;border-radius:7px}
.install-bar .ib-x:hover{background:rgba(255,255,255,.08);color:var(--fg)}

/* Android: respect notches/gesture bars, kill accidental zoom + text inflation */
@supports (padding: env(safe-area-inset-top)) {
  .topbar{padding-top:calc(9px + env(safe-area-inset-top))}
  .player{padding-bottom:calc(7px + env(safe-area-inset-bottom))}
  .sidebar{padding-left:calc(5px + env(safe-area-inset-left))}
}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
button,input,select{font-family:inherit}
@media (display-mode:standalone){
  body{overscroll-behavior-y:none}
  .topbar{user-select:none}
}
"""

# ── 3. swap the external <link>/<script> tags for inline blocks ────────────
def _inline_style(_m):
    return "<style>\n" + css + extra_css + "\n</style>"

def _inline_script(_m):
    return ("<script>\n/* ── runtime: demo engine + backend connector ── */\n" + runtime +
            "\n/* ── dashboard ── */\n" + dash + "\n</script>")

html = re.sub(r'<link rel="stylesheet" href="/static/dash\.css[^"]*">', _inline_style, html)
html = re.sub(r'<script src="/static/dash\.js[^"]*"></script>', _inline_script, html)

# title + a note that it is self-contained
html = html.replace("<title>", "<title>", 1)
if '<script src="/static/' in html or '<link rel="stylesheet" href="/static/' in html:
    sys.exit("✗ external asset references remain — the file would not be standalone")

OUT.write_text(html)
kb = OUT.stat().st_size / 1024
print(f"✓ {OUT}  ({kb:.0f} KB, single file, zero external requests)")

# ── 4. the installable PWA build (Android home-screen app) ─────────────────
import shutil

PWA = ROOT.parent / "cadence-android"
if PWA.exists():
    shutil.rmtree(PWA)
(PWA / "icons").mkdir(parents=True)

head_extra = """<link rel="manifest" href="manifest.webmanifest">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#08080d">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Cadence">
<meta name="application-name" content="Cadence">
<link rel="icon" href="icons/favicon-64.png" sizes="64x64">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">"""

pwa_html = html.replace(
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    head_extra, 1)
pwa_html = pwa_html.replace(
    "</body>",
    """<script>
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW failed:', err.message));
    });
  }
</script>
</body>""", 1)

(PWA / "index.html").write_text(pwa_html)
import json as _json
_served = _json.loads((ROOT / "static" / "pwa" / "manifest.webmanifest").read_text())
_static = dict(_served)
_static["start_url"] = "./index.html"
_static["scope"] = "./"
_static.pop("id", None)
for _sc in _static.get("shortcuts", []):
    _sc["url"] = _sc["url"].replace("/#/", "./index.html#/")
(PWA / "manifest.webmanifest").write_text(_json.dumps(_static, indent=2) + "\n")
shutil.copy(HERE / "pwa" / "sw.js", PWA / "sw.js")
for icon in (HERE / "icons").glob("*.png"):
    shutil.copy(icon, PWA / "icons" / icon.name)

files = sorted(p.relative_to(PWA).as_posix() for p in PWA.rglob("*") if p.is_file())
total = sum((PWA / f).stat().st_size for f in files) / 1024
print(f"✓ {PWA}  ({len(files)} files, {total:.0f} KB)")
