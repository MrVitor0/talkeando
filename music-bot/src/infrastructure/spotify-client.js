class SpotifyClient {
  constructor({ http, clientId, clientSecret, maxTracks = 500 }) {
    this.http = http;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.maxTracks = maxTracks;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  get configured() { return Boolean(this.clientId && this.clientSecret); }

  async authenticate() {
    if (!this.configured) throw new Error("Spotify ainda não está configurado; use uma busca ou URL do YouTube.");
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const body = await this.http.json("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!body.access_token) throw new Error("não foi possível autenticar na API do Spotify");
    this.accessToken = body.access_token;
    this.expiresAt = Date.now() + Math.max(0, (Number(body.expires_in) || 3600) - 60) * 1000;
    return this.accessToken;
  }

  async getTrack(id) {
    return this.get(`https://api.spotify.com/v1/tracks/${id}`);
  }

  async getCollection(kind, id) {
    let resource = null;
    try { resource = await this.get(`https://api.spotify.com/v1/${kind === "album" ? "albums" : "playlists"}/${id}`); }
    catch { /* Track pagination below remains useful when optional collection metadata is unavailable. */ }
    const tracks = [];
    let next = kind === "album"
      ? `https://api.spotify.com/v1/albums/${id}/tracks?limit=50`
      : `https://api.spotify.com/v1/playlists/${id}/items?limit=50`;
    let firstPage = true;
    while (next && tracks.length < this.maxTracks) {
      let page;
      try {
        page = await this.get(next);
      } catch (error) {
        if (kind !== "playlist" || !firstPage || !next.includes("/items?")) throw error;
        next = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=50`;
        page = await this.get(next);
      }
      for (const value of page.items || []) {
        const track = kind === "album" ? value : (value.item || value.track);
        if (track?.type === "track" || track?.name) tracks.push(track);
        if (tracks.length >= this.maxTracks) break;
      }
      next = page.next;
      firstPage = false;
    }
    if (kind === "album") await this.hydrateTracks(tracks);
    return {
      tracks,
      collection: {
        kind,
        title: resource?.name || null,
        owner: kind === "album"
          ? (resource?.artists || []).map(artist => artist.name).filter(Boolean).join(", ") || null
          : resource?.owner?.display_name || null,
        description: resource?.description || null,
        imageUrl: resource?.images?.[0]?.url || null,
        sourceUrl: resource?.external_urls?.spotify || null,
        itemCount: Number(resource?.total || resource?.total_tracks || resource?.tracks?.total) || tracks.length,
      },
    };
  }

  async hydrateTracks(tracks) {
    for (let offset = 0; offset < tracks.length; offset += 50) {
      const slice = tracks.slice(offset, offset + 50);
      const ids = slice.map(track => track.id).filter(Boolean);
      if (!ids.length) continue;
      const full = await this.get(`https://api.spotify.com/v1/tracks?ids=${encodeURIComponent(ids.join(","))}`);
      const byId = new Map((full.tracks || []).filter(Boolean).map(track => [track.id, track]));
      slice.forEach((track, index) => { if (byId.has(track.id)) tracks[offset + index] = byId.get(track.id); });
    }
  }

  async get(url) {
    const token = await this.authenticate();
    return this.http.json(url, { headers: { authorization: `Bearer ${token}` } });
  }
}

module.exports = { SpotifyClient };
