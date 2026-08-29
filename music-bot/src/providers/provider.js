class Provider {
  constructor({ name, scorer = null }) { this.name = name; this.scorer = scorer; }
  async resolve() { throw new Error(`${this.name}.resolve() must be implemented`); }
  open() { throw new Error(`${this.name}.open() must be implemented`); }

  choose(intent, candidates) {
    if (!this.scorer) return { candidate: candidates[0] || null, rejected: [] };
    const { best, rejected } = this.scorer.rank(intent, candidates);
    return { candidate: best, rejected };
  }
}

module.exports = { Provider };
