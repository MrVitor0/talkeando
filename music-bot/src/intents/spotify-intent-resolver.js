class SpotifyIntentResolver {
  constructor({ client }) { this.client = client; }

  match(raw) {
    return String(raw).match(/^https:\/\/open\.spotify\.com\/(track|playlist|album)\/([A-Za-z0-9]+)/i);
  }

  supports(raw) { return Boolean(this.match(raw)); }

  async resolve(raw) {
    const [, rawKind, id] = this.match(raw);
    const kind = rawKind.toLowerCase();
    const result = kind === "track"
      ? { tracks: [await this.client.getTrack(id)], collection: null }
      : await this.client.getCollection(kind, id);
    const tracks = Array.isArray(result) ? result : result.tracks;
    const collection = Array.isArray(result) ? null : result.collection;
    const intents = tracks.filter(track => track?.name).map(track => this.toIntent(track, raw));
    if (!intents.length) throw new Error(kind === "track" ? "faixa do Spotify indisponível" : "playlist Spotify vazia ou indisponível");
    return { intents, collection };
  }

  toIntent(track, raw) {
    return {
      title: track.name,
      artist: (track.artists || []).map(artist => artist.name).filter(Boolean).join(" ") || null,
      durationMs: Number(track.duration_ms) || null,
      isrc: track.external_ids?.isrc || null,
      query: null,
      raw,
      source: "spotify",
      sourceUrl: track.external_urls?.spotify || null,
      imageUrl: track.album?.images?.[0]?.url || null,
      album: track.album?.name || null,
    };
  }
}

module.exports = { SpotifyIntentResolver };
