# Cadence — dashboard + streaming backend
#   docker build -t cadence . && docker run -p 8000:8000 -v cadence-data:/data cadence
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    CADENCE_CACHE=/data

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app.py ./
COPY templates ./templates
COPY static ./static

VOLUME ["/data"]
EXPOSE 8000
# single worker on purpose: the audio cache, download locks and telemetry are in-process
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-8000} --workers 1 --threads 16 --timeout 180 app:app"]
