# @roamhq/wrtc publishes prebuilt binaries for Node 18/20/22; 20 LTS is the
# safe middle. (The old node:18 + unmaintained `wrtc` combo crash-looped.)
FROM node:20-bookworm-slim
# Debian Bookworm marks its system Python as externally managed (PEP 668), so
# yt-dlp must live in its own virtual environment instead of `pip3 install`
# into the OS package set.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3-venv ca-certificates curl unzip \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir -U yt-dlp bgutil-ytdlp-pot-provider \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*
# yt-dlp plugin for the bgutil-ytdlp-pot-provider sidecar (see docker-compose:
# service `bgutil-provider`). Supplies a real Proof-of-Origin token so
# YouTube's bot check passes from this VPS's datacenter IP, which is what
# kept invalidating even freshly-exported account cookies within hours
# ("Sign in to confirm you're not a bot" / LOGIN_REQUIRED despite valid
# cookies). Needs yt-dlp >= 2025.05.22; the `-U` above always installs newer.
# Deno is yt-dlp's JS runtime for solving YouTube's signature / `n` challenges
# (index.js passes `--js-runtimes deno --remote-components ejs:github`).
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /usr/local/bin \
    && chmod +x /usr/local/bin/deno \
    && rm /tmp/deno.zip
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js test.js ./
COPY src ./src
# Pre-create the yt-dlp cache dir owned by `node` so the named volume mounted
# there (docker-compose) inherits that ownership instead of root's.
RUN mkdir -p /home/node/.cache/yt-dlp && chown -R node:node /home/node/.cache
USER node
CMD ["node", "index.js"]
