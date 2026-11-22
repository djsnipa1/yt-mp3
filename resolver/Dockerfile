FROM python:3.12-slim

# Install yt-dlp (and nodejs so yt-dlp can solve YouTube JS challenges cleanly)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -U yt-dlp

WORKDIR /app
COPY server.py /app/server.py

ENV PORT=8080
EXPOSE 8080

CMD ["python3", "/app/server.py"]
