FROM node:18-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3-pip ca-certificates \
    && pip3 install --no-cache-dir yt-dlp \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./
USER node
CMD ["node", "index.js"]
