class MusicStatusReporter {
  constructor({ send, createId }) {
    this.send = send;
    this.createId = createId;
  }

  report(channelId, kind, details = {}) {
    if (!channelId) return false;
    this.send("music.status", {
      status_id: this.createId(),
      channel_id: channelId,
      kind,
      origin: details.origin || null,
      provider: details.provider || null,
      title: details.title || null,
      artist: details.artist || null,
      detail: details.detail || null,
      count: Number.isInteger(details.count) ? details.count : null,
      position: Number.isInteger(details.position) ? details.position : null,
      queue_size: Number.isInteger(details.queueSize) ? details.queueSize : null,
      duration_ms: positiveNumber(details.durationMs),
      total_duration_ms: positiveNumber(details.totalDurationMs),
      eta_ms: nonNegativeNumber(details.etaMs),
      image_url: details.imageUrl || null,
      source_url: details.sourceUrl || null,
      collection_name: details.collectionName || null,
      collection_kind: details.collectionKind || null,
      requested_by: details.requestedBy || null,
      items: Array.isArray(details.items) ? details.items.slice(0, 10).map(item => ({
        title: item.title || "Faixa sem título",
        artist: item.artist || null,
        duration_ms: positiveNumber(item.durationMs),
      })) : [],
    });
    return true;
  }
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

module.exports = { MusicStatusReporter };
