class YouTubeClient {
  constructor({ http, apiKey, maxTracks = 500 }) {
    this.http = http;
    this.apiKey = apiKey;
    this.maxTracks = maxTracks;
  }

  async oEmbed(url) {
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    return this.http.json(endpoint);
  }

  async video(videoId, sourceUrl) {
    if (!this.apiKey) return null;
    const params = new URLSearchParams({
      part: "snippet,contentDetails",
      id: videoId,
      key: this.apiKey,
    });
    const page = await this.http.json(`https://www.googleapis.com/youtube/v3/videos?${params}`);
    const item = page.items?.[0];
    if (!item) return null;
    return this.toIntent(item, sourceUrl || `https://www.youtube.com/watch?v=${videoId}`);
  }

  async playlist(playlistId) {
    if (!this.apiKey) return null;
    const playlistParams = new URLSearchParams({ part: "snippet,contentDetails", id: playlistId, key: this.apiKey });
    let playlist = null;
    try {
      const playlistPage = await this.http.json(`https://www.googleapis.com/youtube/v3/playlists?${playlistParams}`);
      playlist = playlistPage.items?.[0] || null;
    } catch { /* Playlist items still provide enough metadata for playback. */ }
    const items = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({
        part: "snippet,contentDetails",
        playlistId,
        maxResults: "50",
        key: this.apiKey,
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.http.json(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`);
      for (const item of page.items || []) {
        const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
        if (!videoId || item.snippet?.title === "Deleted video" || item.snippet?.title === "Private video") continue;
        items.push({ videoId, playlistItem: item });
        if (items.length >= this.maxTracks) break;
      }
      pageToken = page.nextPageToken || null;
    } while (pageToken && items.length < this.maxTracks);

    const details = new Map();
    for (let offset = 0; offset < items.length; offset += 50) {
      const ids = items.slice(offset, offset + 50).map(item => item.videoId);
      const params = new URLSearchParams({ part: "snippet,contentDetails", id: ids.join(","), key: this.apiKey });
      try {
        const page = await this.http.json(`https://www.googleapis.com/youtube/v3/videos?${params}`);
        for (const item of page.items || []) details.set(item.id, item);
      } catch { /* Keep playlist item metadata and unknown durations as a graceful fallback. */ }
    }
    const intents = items.map(({ videoId, playlistItem }) => {
      const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const detail = details.get(videoId);
      return detail ? this.toIntent(detail, sourceUrl) : {
        title: playlistItem.snippet?.title || videoId,
        artist: playlistItem.snippet?.videoOwnerChannelTitle || playlistItem.snippet?.channelTitle || null,
        durationMs: null, isrc: null, query: null, raw: sourceUrl,
        source: "youtube", sourceUrl,
        imageUrl: bestThumbnail(playlistItem.snippet?.thumbnails), album: null,
      };
    });
    return {
      intents,
      collection: playlist ? {
        kind: "playlist",
        title: playlist.snippet?.title || null,
        owner: playlist.snippet?.channelTitle || null,
        description: playlist.snippet?.description || null,
        imageUrl: bestThumbnail(playlist.snippet?.thumbnails),
        sourceUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
        itemCount: Number(playlist.contentDetails?.itemCount) || intents.length,
      } : null,
    };
  }

  toIntent(item, sourceUrl) {
    return {
      title: item.snippet?.title || item.id,
      artist: item.snippet?.channelTitle || null,
      durationMs: parseIsoDuration(item.contentDetails?.duration),
      isrc: null, query: null, raw: sourceUrl, source: "youtube", sourceUrl,
      imageUrl: bestThumbnail(item.snippet?.thumbnails), album: null,
    };
  }
}

function bestThumbnail(thumbnails) {
  return thumbnails?.maxres?.url || thumbnails?.standard?.url || thumbnails?.high?.url || thumbnails?.medium?.url || thumbnails?.default?.url || null;
}

function parseIsoDuration(value) {
  const match = String(value || "").match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return null;
  return Math.round(((Number(match[1] || 0) * 86400) + (Number(match[2] || 0) * 3600) + (Number(match[3] || 0) * 60) + Number(match[4] || 0)) * 1000) || null;
}

module.exports = { YouTubeClient, parseIsoDuration };
