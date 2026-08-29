class HttpError extends Error {
  constructor({ url, status, body }) {
    const endpoint = new URL(url);
    const detail = body?.error?.message || body?.message || body?.error_description || null;
    super(`HTTP ${status} for ${endpoint.host}${endpoint.pathname}${detail ? `: ${detail}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.endpoint = `${endpoint.host}${endpoint.pathname}`;
    this.body = body || null;
  }
}

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
      if (!response.ok) {
        let body = null;
        try { body = await response.json(); }
        catch { /* Some upstream errors intentionally have an empty/non-JSON body. */ }
        throw new HttpError({ url, status: response.status, body });
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { HttpClient, HttpError };
