const DECORATION_PATTERNS = [
  /\((?:official\s+)?(?:music\s+)?video\)/gi,
  /\[(?:official\s+)?(?:music\s+)?video\]/gi,
  /\[(?:hd|hq|4k)\]/gi,
  /\b(?:feat|ft)\.?\s+[^()[\]-]+/gi,
];

function normalizeText(value) {
  let normalized = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  for (const pattern of DECORATION_PATTERNS) normalized = normalized.replace(pattern, " ");
  return normalized
    .replace(/^\s*\d+\s*\.\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenSetRatio(left, right) {
  const a = new Set(normalizeText(left).split(" ").filter(Boolean));
  const b = new Set(normalizeText(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  // Directional coverage: harmless decorations in a candidate should not
  // lower the score, but every meaningful token from the intent must match.
  return intersection / a.size;
}

module.exports = { normalizeText, tokenSetRatio };
