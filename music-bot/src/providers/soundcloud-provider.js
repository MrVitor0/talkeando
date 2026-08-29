const { Provider } = require("./provider");

class SoundCloudProvider extends Provider {
  constructor({ client, scorer }) { super({ name: "soundcloud", scorer }); this.client = client; }

  async resolve(intent) {
    const query = [intent.artist, intent.title || intent.query].filter(Boolean).join(" ");
    const entries = await this.client.searchSoundCloud(query, 5);
    const candidates = entries.map(entry => ({
      provider: this.name,
      ref: entry.webpage_url || entry.original_url || entry.url,
      title: entry.title || "",
      artist: entry.uploader || entry.artist || null,
      durationMs: Number(entry.duration) > 0 ? Number(entry.duration) * 1000 : null,
      isrc: entry.isrc || null,
      policy: entry.policy || entry.format_note || null,
      imageUrl: entry.thumbnail || entry.artwork_url || null,
      sourceUrl: entry.webpage_url || entry.original_url || null,
    })).filter(candidate => candidate.ref && candidate.title);
    return this.choose(intent, candidates);
  }

  open(ref) { return ref; }
}

module.exports = { SoundCloudProvider };
