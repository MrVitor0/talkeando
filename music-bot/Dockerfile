# @roamhq/wrtc publishes prebuilt binaries for Node 18/20/22; 20 LTS is the
# safe middle. (The old node:18 + unmaintained `wrtc` combo crash-looped.)
FROM node:20-bookworm-slim
# Debian Bookworm marks its system Python as externally managed (PEP 668), so
# yt-dlp must live in its own virtual environment instead of `pip3 install`
# into the OS package set.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3-venv ca-certificates curl unzip \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir -U yt-dlp \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*
# yt-dlp drives SoundCloud search/streaming (the default playback chain is
# cache,library,soundcloud,audius). Deno is only needed if someone opts back
# into the YouTube last-resort player with `PROVIDER_CHAIN=...,youtube` — it is
# yt-dlp's JS runtime for YouTube's signature / `n` challenges.
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /usr/local/bin \
    && chmod +x /usr/local/bin/deno \
    && rm /tmp/deno.zip
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js test.js ./
COPY src ./src
COPY scripts ./scripts
# Pre-create the yt-dlp cache dir owned by `node` so the named volume mounted
# there (docker-compose) inherits that ownership instead of root's.
RUN mkdir -p /home/node/.cache/yt-dlp && chown -R node:node /home/node/.cache
USER node
CMD ["node", "index.js"]
