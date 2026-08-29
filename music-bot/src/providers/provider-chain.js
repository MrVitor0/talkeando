class ProviderChain {
  constructor({ providers, order, logger = () => {} }) {
    this.providers = new Map(providers.map(provider => [provider.name, provider]));
    this.logger = logger;
    this.order = [];
    for (const name of order) {
      if (this.providers.has(name) && !this.order.includes(name)) this.order.push(name);
      else if (!this.providers.has(name)) this.logger("provider.unknown", { provider: name });
    }
  }

  async resolve(intent, { afterIndex = -1 } = {}) {
    const rejected = [];
    for (let index = afterIndex + 1; index < this.order.length; index++) {
      const provider = this.providers.get(this.order[index]);
      try {
        const result = await provider.resolve(intent);
        rejected.push(...(result.rejected || []));
        if (!result.candidate) continue;
        const playable = provider.open(result.candidate.ref);
        if (!playable) continue;
        this.logger("source.resolved", {
          intent: summarizeIntent(intent),
          winner: { provider: provider.name, score: result.candidate.score },
          rejected,
        });
        return { provider: provider.name, providerIndex: index, candidate: result.candidate, playable };
      } catch (error) {
        rejected.push({ provider: provider.name, reason: "provider_error", detail: error.message });
      }
    }
    this.logger("source.unresolved", { intent: summarizeIntent(intent), rejected });
    return null;
  }
}

function summarizeIntent(intent) {
  return { title: intent.title, artist: intent.artist, durationMs: intent.durationMs, isrc: intent.isrc, raw: intent.raw };
}

// YouTube is discovery-only: its Data API turns a link/playlist into a title +
// artist, and playback then comes from SoundCloud/Audius. `youtube` is kept as
// a registered provider so `PROVIDER_CHAIN=...,youtube` can still re-enable it
// as a last-resort player, but it is deliberately absent from the default so a
// datacenter IP never has to satisfy YouTube's bot check (no cookies, no Po
// Token sidecar).
const DEFAULT_PROVIDER_ORDER = ["cache", "library", "soundcloud", "audius"];

/// Parse the `PROVIDER_CHAIN` env into an ordered provider-name list. Accepts a
/// JSON array (`["soundcloud","audius"]`) or a comma-separated string; an empty
/// value falls back to `DEFAULT_PROVIDER_ORDER`.
function parseProviderOrder(configured, fallback = DEFAULT_PROVIDER_ORDER) {
  if (!configured) return [...fallback];
  try {
    const parsed = JSON.parse(configured);
    if (Array.isArray(parsed)) return parsed.map(String).map(value => value.trim().toLowerCase()).filter(Boolean);
  } catch { /* comma-separated form below */ }
  return String(configured).split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
}

module.exports = { ProviderChain, parseProviderOrder, DEFAULT_PROVIDER_ORDER };
