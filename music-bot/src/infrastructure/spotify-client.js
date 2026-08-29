class SpotifyClient {
  constructor({ http, clientId, clientSecret, refreshToken = "", maxTracks = 500 }) {
    this.http = http;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.maxTracks = maxTracks;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  get configured() { return Boolean(this.clientId && this.clientSecret); }

  get hasUserAuthorization() { return Boolean(this.refreshToken); }

  async authenticate() {
    if (!this.configured) throw new Error("Spotify ainda não está configurado; use uma busca ou URL do YouTube.");
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const form = this.refreshToken
      ? new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.refreshToken })
      : new URLSearchParams({ grant_type: "client_credentials" });
    const body = await this.http.json("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!body.access_token) throw new Error("não foi possível autenticar na API do Spotify");
    this.accessToken = body.access_token;
    this.expiresAt = Date.now() + Math.max(0, (Number(body.expires_in) || 3600) - 60) * 1000;
    return this.accessToken;
  }

  async getTrack(id) {
    return this.get(`https://api.spotify.com/v1/tracks/${id}`);
  }

  /// Public playlist search (client_credentials is enough). Used by the
  /// integration smoke to pick a live user playlist instead of a brittle
  /// hardcoded id. Returns `{ id, name, owner }` rows.
  async searchPlaylists(query, limit = 10) {
    const params = new URLSearchParams({ q: query, type: "playlist", limit: String(Math.min(50, Math.max(1, limit))) });
    const body = await this.get(`https://api.spotify.com/v1/search?${params}`);
    return (body.playlists?.items || [])
      .filter(Boolean)
      .map(item => ({ id: item.id, name: item.name || null, owner: item.owner || null }));
  }

  async getCollection(kind, id) {
    // Public user playlists read fine with an app-only (client_credentials)
    // token — no SPOTIFY_REFRESH_TOKEN needed. Private/collaborative playlists
    // and Spotify's own editorial/algorithmic playlists (ids starting "37i9")
    // return 403/404 no matter the token; those surface as a clean message.
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
        const canRetryOlderEndpoint = kind === "playlist" && firstPage && next.includes("/items?");
        if (!canRetryOlderEndpoint) throw playlistAccessError(kind, error);
        next = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=50`;
        try { page = await this.get(next); }
        catch (retryError) { throw playlistAccessError(kind, retryError); }
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

/// A 401/403/404 reading playlist tracks means the playlist is private,
/// collaborative, or one of Spotify's own editorial/algorithmic playlists
/// (the API blocks those for third-party apps). Turn it into a message the
/// user can act on; leave anything else (rate limit, network) untouched.
function playlistAccessError(kind, error) {
  const status = error && error.status;
  if (kind === "playlist" && [401, 403, 404].includes(status)) {
    return new Error("Essa playlist é privada ou não pode ser usada. Playlists editoriais do Spotify (as que começam com \"37i9\") não são acessíveis pela API — use uma playlist pública de usuário.");
  }
  return error;
}

module.exports = { SpotifyClient };
