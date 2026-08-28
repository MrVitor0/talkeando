FROM node:18-bookworm-slim
# Debian Bookworm marks its system Python as externally managed (PEP 668), so
# yt-dlp must live in its own virtual environment instead of `pip3 install`
# into the OS package set.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3-venv ca-certificates \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir yt-dlp \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install -g @mapbox/node-pre-gyp
RUN npm install --omit=dev
COPY index.js ./
USER node
CMD ["node", "index.js"]
