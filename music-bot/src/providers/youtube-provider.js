const { Provider } = require("./provider");

class YouTubeProvider extends Provider {
  constructor() { super({ name: "youtube" }); }

  async resolve(intent) {
    const ref = intent.source === "youtube" && intent.sourceUrl
      ? intent.sourceUrl
      : `ytsearch1:${[intent.artist, intent.title || intent.query].filter(Boolean).join(" ")}`;
    return {
      candidate: {
        provider: this.name, ref, title: intent.title || intent.query, artist: intent.artist,
        durationMs: intent.durationMs, imageUrl: intent.imageUrl, sourceUrl: intent.sourceUrl, score: 1,
      },
      rejected: [],
    };
  }

  open(ref) { return ref; }
}

module.exports = { YouTubeProvider };
