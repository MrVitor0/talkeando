const { textIntent } = require("./text-intent-resolver");

class YouTubeIntentResolver {
  constructor({ client, logger = () => {} }) { this.client = client; this.logger = logger; }

  supports(raw) {
    try { return /(^|\.)((youtube\.com)|(youtu\.be))$/i.test(new URL(raw).hostname); }
    catch { return false; }
  }

  async resolve(raw) {
    const url = new URL(raw);
    const playlistId = url.searchParams.get("list");
    const videoId = url.hostname.toLowerCase().endsWith("youtu.be")
      ? url.pathname.split("/").filter(Boolean)[0]
      : url.searchParams.get("v");
    // A URL copied from a playlist normally contains both `v` and `list`.
    // The playlist is the user's explicit intent in that case; treating it as
    // a single video made the queue silently omit every remaining item.
    if (playlistId) return this.resolvePlaylist(raw, playlistId);
    return this.resolveVideo(raw, videoId);
  }

  async resolveVideo(raw, videoId) {
    let details = null;
    try { details = videoId ? await this.client.video?.(videoId, raw) : null; }
    catch (error) { this.logger("youtube.video.degraded", { reason: error.message, raw }); }
    if (details) return { intents: [details], collection: null };
    const meta = await this.client.oEmbed(raw);
    return { intents: [{
      title: meta.title || raw,
      artist: meta.author_name || null,
      durationMs: null,
      isrc: null,
      query: null,
      raw,
      source: "youtube",
      sourceUrl: raw,
      imageUrl: meta.thumbnail_url || null,
      album: null,
    }], collection: null };
  }

  async resolvePlaylist(raw, playlistId) {
    if (this.client.apiKey) {
      const result = await this.client.playlist(playlistId);
      if (Array.isArray(result) && result.length) return { intents: result, collection: null };
      if (result?.intents?.length) return result;
      throw new Error("não consegui ler essa playlist do YouTube");
    }
    this.logger("youtube.intent.degraded", { reason: "missing_api_key", raw });
    try {
      const meta = await this.client.oEmbed(raw);
      return { intents: [{ ...textIntent(meta.title || raw), raw, imageUrl: meta.thumbnail_url || null }], collection: null };
    } catch {
      return { intents: [textIntent(raw)], collection: null };
    }
  }
}

module.exports = { YouTubeIntentResolver };
