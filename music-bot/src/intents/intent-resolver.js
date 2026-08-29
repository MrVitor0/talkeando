class IntentResolver {
  constructor(resolvers) { this.resolvers = resolvers; }

  async resolve(raw) {
    const query = String(raw || "").trim();
    if (!query) throw new Error("informe uma música, artista ou URL");
    const resolver = this.resolvers.find(candidate => candidate.supports(query));
    const result = await resolver.resolve(query);
    return Array.isArray(result) ? { intents: result, collection: null } : result;
  }
}

module.exports = { IntentResolver };
