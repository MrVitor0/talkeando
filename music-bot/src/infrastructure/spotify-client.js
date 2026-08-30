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
    try { return await this.get(`https://api.spotify.com/v1/tracks/${id}`); }
    catch (error) {
      try { return await this.trackFromEmbed(id); }
      catch { throw error; }
    }
  }

  /// Spotify's Web API has become unreliable for playlist reads with app
  /// tokens — public user playlists 403/404, `/v1/search?type=playlist` returns
  /// "Invalid limit". So try the API first (it carries ISRCs, which sharpen
  /// matching) and fall back to scraping the public embed page, which serves
  /// any public or editorial playlist with no auth and no rate limit. A
  /// genuinely private playlist fails both and gets a short, actionable message.
  async getCollection(kind, id) {
    try {
      return await this.getCollectionViaApi(kind, id);
    } catch (apiError) {
      try {
        return await this.collectionFromEmbed(kind, id);
      } catch {
        throw playlistAccessError(kind, apiError);
      }
    }
  }

  async getCollectionViaApi(kind, id) {
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
        if (!canRetryOlderEndpoint) throw error;
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
    // The API answered but handed back nothing playable — let the embed
    // fallback try instead of surfacing an "empty playlist".
    if (!tracks.length) throw new Error("Spotify Web API returned no tracks");
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

  // ---- public embed scrape (no auth) --------------------------------------

  async collectionFromEmbed(kind, id) {
    const entity = await this.fetchEmbedEntity(kind, id);
    const list = Array.isArray(entity && entity.trackList) ? entity.trackList : [];
    const cover = embedCover(entity);
    const tracks = list.slice(0, this.maxTracks).map(item => embedTrackToApiShape(item, cover));
    if (!tracks.length) throw new Error("embed returned no tracks");
    return {
      tracks,
      collection: {
        kind,
        title: entity.title || entity.name || null,
        owner: entity.subtitle || null,
        description: null,
        imageUrl: cover,
        sourceUrl: `https://open.spotify.com/${kind}/${id}`,
        itemCount: list.length,
      },
    };
  }

  async trackFromEmbed(id) {
    const entity = await this.fetchEmbedEntity("track", id);
    const track = Array.isArray(entity && entity.trackList) && entity.trackList[0] ? entity.trackList[0] : entity;
    if (!track || !(track.title || track.name)) throw new Error("embed returned no track");
    return embedTrackToApiShape(track, embedCover(entity));
  }

  async fetchEmbedEntity(kind, id) {
    const html = await this.http.text(`https://open.spotify.com/embed/${kind}/${id}`, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "accept-language": "en" },
    });
    const entity = parseEmbedEntity(html);
    if (!entity) throw new Error("embed page had no parseable data");
    return entity;
  }
}

/// Both the Web API and the public embed refused the collection: it is
/// private, region-locked, or deleted. Short and actionable — this reaches
/// the user on the bot's error card.
function playlistAccessError(kind) {
  const what = kind === "album" ? "esse álbum" : "essa playlist";
  return new Error(`Não consegui ler ${what} do Spotify — confirme que ela está pública.`);
}

function parseEmbedEntity(html) {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html || "");
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[1]); } catch { return null; }
  const candidates = [
    data?.props?.pageProps?.state?.data?.entity,
    data?.props?.pageProps?.state?.data,
    data?.props?.pageProps?.entity,
  ];
  for (const entity of candidates) {
    if (entity && (Array.isArray(entity.trackList) || entity.title || entity.name)) return entity;
  }
  return findTrackListHolder(data);
}

/// Depth-first search for the first object carrying a non-empty `trackList`.
function findTrackListHolder(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  if (Array.isArray(node.trackList) && node.trackList.length) return node;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const found = findTrackListHolder(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function embedCover(entity) {
  const sources = entity && entity.coverArt && entity.coverArt.sources;
  return Array.isArray(sources) && sources.length ? sources[sources.length - 1].url : null;
}

function embedTrackToApiShape(item, cover) {
  const trackId = String(item.uri || "").split(":").pop() || null;
  return {
    id: trackId,
    type: "track",
    name: item.title || item.name || null,
    artists: item.subtitle ? [{ name: String(item.subtitle) }] : [],
    duration_ms: Number(item.duration) || null,
    album: { name: null, images: cover ? [{ url: cover }] : [] },
    external_urls: { spotify: trackId ? `https://open.spotify.com/track/${trackId}` : null },
    external_ids: {},
  };
}

module.exports = { SpotifyClient };
