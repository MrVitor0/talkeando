//! In-memory counters for the voice path. They stand in for a full metrics
//! stack, which would not fit the 2 GB VM — see
//! tupi-v2-refactor/09-alternatives-rejected.md §10. Exposed by
//! `GET /api/debug/voice` (SPEC-002).
//!
//! Counters for states that do not exist yet (provisional, deltas, drift) are
//! declared here and stay at zero until SPEC-003 / SPEC-005 start bumping them.
//! This is deliberate: the debug endpoint keeps the same shape across specs.

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct VoiceMetrics {
    pub webhooks_received: AtomicU64,
    pub webhooks_rejected: AtomicU64,
    pub webhooks_ignored_stale: AtomicU64,
    pub webhooks_ignored_duplicate: AtomicU64,
    pub webhooks_ignored_hidden: AtomicU64,
    pub reconciles_run: AtomicU64,
    pub reconciles_with_drift: AtomicU64,
    pub reconciles_failed: AtomicU64,
    pub participants_added_by_webhook: AtomicU64,
    pub participants_added_by_reconcile: AtomicU64,
    pub participants_removed_by_webhook: AtomicU64,
    pub participants_removed_by_reconcile: AtomicU64,
    pub provisional_created: AtomicU64,
    pub provisional_confirmed: AtomicU64,
    pub provisional_expired: AtomicU64,
    pub deltas_sent: AtomicU64,
    pub snapshots_sent: AtomicU64,
    pub version_gaps_reported: AtomicU64,
    pub tokens_issued: AtomicU64,
    pub tokens_refused: AtomicU64,
    pub last_reconcile_duration_ms: AtomicU64,
    pub last_reconcile_at_unix: AtomicU64,
}

impl VoiceMetrics {
    pub fn bump(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }

    #[allow(dead_code)]
    pub fn bump_by(counter: &AtomicU64, amount: u64) {
        counter.fetch_add(amount, Ordering::Relaxed);
    }

    pub fn set(counter: &AtomicU64, value: u64) {
        counter.store(value, Ordering::Relaxed);
    }

    pub fn get(counter: &AtomicU64) -> u64 {
        counter.load(Ordering::Relaxed)
    }

    /// Serializable snapshot for `GET /api/debug/voice`.
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "webhooks_received": Self::get(&self.webhooks_received),
            "webhooks_rejected": Self::get(&self.webhooks_rejected),
            "webhooks_ignored_stale": Self::get(&self.webhooks_ignored_stale),
            "webhooks_ignored_duplicate": Self::get(&self.webhooks_ignored_duplicate),
            "webhooks_ignored_hidden": Self::get(&self.webhooks_ignored_hidden),
            "reconciles_run": Self::get(&self.reconciles_run),
            "reconciles_with_drift": Self::get(&self.reconciles_with_drift),
            "reconciles_failed": Self::get(&self.reconciles_failed),
            "participants_added_by_webhook": Self::get(&self.participants_added_by_webhook),
            "participants_added_by_reconcile": Self::get(&self.participants_added_by_reconcile),
            "participants_removed_by_webhook": Self::get(&self.participants_removed_by_webhook),
            "participants_removed_by_reconcile": Self::get(&self.participants_removed_by_reconcile),
            "provisional_created": Self::get(&self.provisional_created),
            "provisional_confirmed": Self::get(&self.provisional_confirmed),
            "provisional_expired": Self::get(&self.provisional_expired),
            "deltas_sent": Self::get(&self.deltas_sent),
            "snapshots_sent": Self::get(&self.snapshots_sent),
            "version_gaps_reported": Self::get(&self.version_gaps_reported),
            "tokens_issued": Self::get(&self.tokens_issued),
            "tokens_refused": Self::get(&self.tokens_refused),
            "last_reconcile_duration_ms": Self::get(&self.last_reconcile_duration_ms),
            "last_reconcile_at_unix": Self::get(&self.last_reconcile_at_unix),
        })
    }
}
