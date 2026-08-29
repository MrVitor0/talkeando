const { Provider } = require("./provider");

class AudiusProvider extends Provider {
  constructor({ client, scorer }) { super({ name: "audius", scorer }); this.client = client; }

  async resolve(intent) {
    const query = [intent.artist, intent.title || intent.query].filter(Boolean).join(" ");
    const tracks = await this.client.search(query, 10);
    const candidates = tracks.map(track => ({
      provider: this.name,
      ref: track.id,
      title: track.title || "",
      artist: track.user?.name || track.user?.handle || null,
      durationMs: Number(track.duration) > 0 ? Number(track.duration) * 1000 : null,
      isrc: track.isrc || null,
      policy: track._co_sign?.policy || track.policy || null,
      imageUrl: track.artwork?.["1000x1000"] || track.artwork?.["480x480"] || track.artwork?.["150x150"] || null,
      sourceUrl: track.permalink ? `https://audius.co${track.permalink}` : null,
    })).filter(candidate => candidate.ref && candidate.title);
    return this.choose(intent, candidates);
  }

  open(ref) { return this.client.streamUrl(ref); }
}

module.exports = { AudiusProvider };
