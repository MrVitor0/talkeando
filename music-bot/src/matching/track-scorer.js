const { normalizeText, tokenSetRatio } = require("./text-normalizer");

const VARIANT_PATTERN = /\b(remix|nightcore|sped\s*up|slowed|cover|karaoke|8d)\b/i;

class TrackScorer {
  constructor({ durationToleranceMs = 7000, similarityCutoff = 0.6, scoreCutoff = 0.6 } = {}) {
    this.durationToleranceMs = durationToleranceMs;
    this.similarityCutoff = similarityCutoff;
    this.scoreCutoff = scoreCutoff;
  }

  rank(intent, candidates) {
    const durations = candidates
      .filter(candidate => String(candidate.policy || "").toUpperCase() !== "SNIP")
      .map(candidate => Number(candidate.durationMs))
      .filter(duration => duration > 0)
      .sort((a, b) => a - b);
    const medianDuration = median(durations);
    const accepted = [];
    const rejected = [];
    for (const candidate of candidates) {
      const result = this.score(intent, candidate, medianDuration);
      if (result.accepted) accepted.push({ ...candidate, score: result.score });
      else rejected.push({ provider: candidate.provider, title: candidate.title, durationMs: candidate.durationMs, reason: result.reason });
    }
    accepted.sort((a, b) => b.score - a.score);
    const best = accepted[0] || null;
    if (best && best.score < this.scoreCutoff) {
      for (const candidate of accepted) {
        rejected.push({ provider: candidate.provider, title: candidate.title, durationMs: candidate.durationMs, reason: "score_below_cutoff" });
      }
      return { best: null, rejected };
    }
    for (const candidate of accepted.slice(1)) {
      rejected.push({ provider: candidate.provider, title: candidate.title, durationMs: candidate.durationMs, reason: "lower_score" });
    }
    return { best, rejected };
  }

  score(intent, candidate, medianDuration) {
    const durationMs = Number(candidate.durationMs) || null;
    if (String(candidate.policy || "").toUpperCase() === "SNIP") return reject("policy_snip");
    const expectedIsrc = String(intent.isrc || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
    const candidateIsrc = String(candidate.isrc || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
    if (expectedIsrc && candidateIsrc && expectedIsrc !== candidateIsrc) return reject("isrc_mismatch");
    if (durationMs && durationMs >= 25000 && durationMs <= 35000 && Number(intent.durationMs) > 45000) return reject("licensed_preview_duration");

    let durationScore = 1;
    if (Number(intent.durationMs) > 0 && durationMs) {
      const delta = Math.abs(durationMs - intent.durationMs);
      if (delta > this.durationToleranceMs) return reject("duration_delta");
      durationScore = 1 - (delta / this.durationToleranceMs) * 0.2;
    } else if (!Number(intent.durationMs) && durationMs && medianDuration) {
      const tolerance = Math.max(20000, medianDuration * 0.35);
      if (Math.abs(durationMs - medianDuration) > tolerance) return reject("duration_outlier");
    }

    const expected = intent.title || intent.query || "";
    const actual = candidate.title || "";
    const similarity = expectedIsrc && candidateIsrc ? 1 : tokenSetRatio(expected, actual);
    if (similarity < this.similarityCutoff) return reject("title_similarity");

    let score = similarity * durationScore;
    const requestedVariant = VARIANT_PATTERN.test(normalizeText([intent.raw, intent.query, expected].filter(Boolean).join(" ")));
    if (VARIANT_PATTERN.test(normalizeText(candidate.title)) && !requestedVariant) score *= 0.4;
    return { accepted: true, score: Math.round(score * 1000) / 1000 };
  }
}

function reject(reason) { return { accepted: false, score: 0, reason }; }
function median(sorted) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

module.exports = { TrackScorer };
