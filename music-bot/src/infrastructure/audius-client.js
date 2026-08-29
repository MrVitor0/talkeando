class AudiusClient {
  constructor({ http, apiKey = "", appName = "Tupi" }) {
    this.http = http;
    this.apiKey = apiKey;
    this.appName = appName;
  }

  async search(query, limit = 10) {
    const params = new URLSearchParams({ query, limit: String(limit), app_name: this.appName });
    const headers = this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
    const body = await this.http.json(`https://api.audius.co/v1/tracks/search?${params}`, { headers });
    return body.data || [];
  }

  streamUrl(trackId) {
    const params = new URLSearchParams({ app_name: this.appName });
    return `https://api.audius.co/v1/tracks/${encodeURIComponent(trackId)}/stream?${params}`;
  }
}

module.exports = { AudiusClient };
