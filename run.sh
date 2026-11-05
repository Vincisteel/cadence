#!/usr/bin/env bash
# Cadence — install deps (if needed) and start the dashboard on http://localhost:8000
# Usage: ./run.sh            → port 8000
#        PORT=8010 ./run.sh  → custom port
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8000}"

have_deps() { python3 -c "import flask, yt_dlp, ytmusicapi, requests" >/dev/null 2>&1; }

if have_deps; then
  echo "✓ dependencies already available"
elif python3 -m pip install -q -r requirements.txt 2>/dev/null; then
  echo "✓ dependencies installed"
else
  # PEP 668 "externally managed" systems (Homebrew, Debian, Ubuntu) refuse system pip
  echo "· system pip declined — using a local virtualenv in ./.venv"
  [ -d .venv ] || python3 -m venv .venv
  ./.venv/bin/pip install -q -r requirements.txt
  echo "✓ dependencies installed in .venv"
  PORT="$PORT" exec ./.venv/bin/python app.py
fi

PORT="$PORT" exec python3 app.py
