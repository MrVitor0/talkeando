use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

use sqlx::PgPool;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{config::Config, ws::hub::Hub};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
    pub hub: Arc<Hub>,
    pub login_limiter: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
    /// Monotonically changing generation per user. A delayed disconnect task
    /// may act only if no newer authenticated connection superseded it.
    pub presence_epochs: Arc<Mutex<HashMap<Uuid, u64>>>,
    pub pending_offline: Arc<Mutex<HashSet<Uuid>>>,
    /// When the voice roster was last reconciled against LiveKit. Throttles
    /// the on-connect reconcile so a server restart (every client reconnects
    /// within a second) doesn't fan out into one LiveKit sweep per client.
    pub last_voice_reconcile: Arc<Mutex<Option<Instant>>>,
    /// In-memory counters for the voice path (SPEC-002). Exposed by
    /// `GET /api/debug/voice`.
    pub voice_metrics: Arc<crate::ws::voice_metrics::VoiceMetrics>,
    /// Boot instant, for the debug endpoint's `uptime_seconds`.
    pub started_at: Instant,
    /// Last time `GET /api/debug/voice?live=1` hit LiveKit, so the live diff
    /// can be throttled to one sweep per 10 s (same pattern as
    /// `should_reconcile_voice`).
    pub last_debug_live: Arc<Mutex<Option<Instant>>>,
    /// Channels that need confirming against LiveKit, with the instant they
    /// become due. Drained by the 1 s tick in `main.rs` (SPEC-004).
    pub pending_reconcile: Arc<Mutex<HashMap<Uuid, Instant>>>,
}

impl AppState {
    pub fn new(pool: PgPool, config: Config) -> Self {
        Self {
            pool,
            config,
            hub: Arc::new(Hub::new()),
            login_limiter: Arc::new(Mutex::new(HashMap::new())),
            presence_epochs: Arc::new(Mutex::new(HashMap::new())),
            pending_offline: Arc::new(Mutex::new(HashSet::new())),
            last_voice_reconcile: Arc::new(Mutex::new(None)),
            voice_metrics: Arc::new(crate::ws::voice_metrics::VoiceMetrics::default()),
            started_at: Instant::now(),
            last_debug_live: Arc::new(Mutex::new(None)),
            pending_reconcile: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Schedules confirmation of ONE channel against LiveKit. If a sooner run
    /// is already queued for it, the sooner one wins.
    pub async fn schedule_reconcile(&self, channel_id: Uuid, delay: Duration) {
        let due = Instant::now() + delay;
        let mut pending = self.pending_reconcile.lock().await;
        pending
            .entry(channel_id)
            .and_modify(|existing| {
                if due < *existing {
                    *existing = due;
                }
            })
            .or_insert(due);
    }

    /// Channels whose scheduled time has passed, removing them from the queue.
    pub async fn take_due_reconciles(&self) -> Vec<Uuid> {
        let now = Instant::now();
        let mut pending = self.pending_reconcile.lock().await;
        let due: Vec<Uuid> = pending
            .iter()
            .filter(|(_, at)| **at <= now)
            .map(|(id, _)| *id)
            .collect();
        for id in &due {
            pending.remove(id);
        }
        due
    }

    /// Returns true (and stamps "now") when `GET /api/debug/voice?live=1` has
    /// not hit LiveKit within `min_gap`. Mirrors `should_reconcile_voice`.
    pub async fn should_run_debug_live(&self, min_gap: Duration) -> bool {
        let mut guard = self.last_debug_live.lock().await;
        let now = Instant::now();
        if guard.map_or(true, |last| now.duration_since(last) >= min_gap) {
            *guard = Some(now);
            true
        } else {
            false
        }
    }

    /// Returns true (and stamps "now") when the voice roster has not been
    /// reconciled against LiveKit within `min_gap`. Pass `Duration::ZERO`
    /// from the periodic task to always run; the WS-connect path passes a
    /// few seconds so a reconnect storm coalesces into one sweep.
    pub async fn should_reconcile_voice(&self, min_gap: Duration) -> bool {
        let mut guard = self.last_voice_reconcile.lock().await;
        let now = Instant::now();
        if guard.map_or(true, |last| now.duration_since(last) >= min_gap) {
            *guard = Some(now);
            true
        } else {
            false
        }
    }

    /// Fixed-window brute-force guard on login attempts, keyed by
    /// `ip:username` (AUTH-NFR-002 / SEC-NFR). 10 attempts per 60s window.
    pub async fn check_login_rate_limit(&self, key: &str) -> bool {
        const WINDOW: Duration = Duration::from_secs(60);
        const MAX_ATTEMPTS: usize = 10;

        let mut guard = self.login_limiter.lock().await;
        let now = Instant::now();
        let entry = guard.entry(key.to_string()).or_default();
        while let Some(front) = entry.front() {
            if now.duration_since(*front) > WINDOW {
                entry.pop_front();
            } else {
                break;
            }
        }
        if entry.len() >= MAX_ATTEMPTS {
            return false;
        }
        entry.push_back(now);
        true
    }

    pub async fn advance_presence_epoch(&self, user_id: Uuid) -> u64 {
        let mut epochs = self.presence_epochs.lock().await;
        let epoch = epochs.entry(user_id).or_insert(0);
        *epoch += 1;
        *epoch
    }

    pub async fn presence_epoch_is_current(&self, user_id: Uuid, epoch: u64) -> bool {
        self.presence_epochs
            .lock()
            .await
            .get(&user_id)
            .copied()
            == Some(epoch)
    }

    pub async fn begin_offline_grace(&self, user_id: Uuid) {
        self.pending_offline.lock().await.insert(user_id);
    }

    /// Returns whether an unexpired grace period was cancelled by a new WS.
    pub async fn cancel_offline_grace(&self, user_id: Uuid) -> bool {
        self.pending_offline.lock().await.remove(&user_id)
    }

    pub async fn finish_offline_grace(&self, user_id: Uuid) -> bool {
        self.pending_offline.lock().await.remove(&user_id)
    }
}

impl axum::extract::FromRef<AppState> for PgPool {
    fn from_ref(state: &AppState) -> Self {
        state.pool.clone()
    }
}
