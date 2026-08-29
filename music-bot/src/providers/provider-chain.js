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

module.exports = { ProviderChain };
