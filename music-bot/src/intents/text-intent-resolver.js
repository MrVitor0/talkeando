function textIntent(raw) {
  const query = String(raw || "").trim();
  return { title: null, artist: null, durationMs: null, isrc: null, query, raw: query, source: "text", sourceUrl: null, imageUrl: null, album: null };
}

class TextIntentResolver {
  supports() { return true; }
  async resolve(raw) { return { intents: [textIntent(raw)], collection: null }; }
}

module.exports = { TextIntentResolver, textIntent };
