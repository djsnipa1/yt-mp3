FROM brainicism/bgutil-ytdlp-pot-provider:2.0.2 AS bgutil

FROM python:3.12-slim-bookworm

# Runtime libs for Node.js + certs (both stages use Debian Bookworm)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libatomic1 \
    && rm -rf /var/lib/apt/lists/*

# Copy Node.js binary + prebuilt bgutil PO-token HTTP server from official image
COPY --from=bgutil /usr/local/bin/node /usr/local/bin/node
COPY --from=bgutil /app /opt/bgutil

# Install latest yt-dlp (with EJS JS challenge support) + bgutil PO-token plugin
RUN pip install --no-cache-dir -U "yt-dlp[default]" bgutil-ytdlp-pot-provider

WORKDIR /app
COPY server.py /app/server.py

ENV PORT=8080
EXPOSE 8080

CMD ["python3", "/app/server.py"]

