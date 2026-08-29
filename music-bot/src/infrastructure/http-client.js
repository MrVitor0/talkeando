class HttpClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetch is required");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async json(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, { ...options, signal: options.signal || controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).host}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { HttpClient };
