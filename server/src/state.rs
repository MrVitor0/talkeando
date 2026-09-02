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
    /// `channel_id -> (community_id, fetched_at)`. Channels almost never move
    /// communities; a 5 min TTL removes a Postgres query per roster event.
    pub channel_community_cache: Arc<Mutex<HashMap<Uuid, (Uuid, Instant)>>>,
    /// `community_id -> (member_ids, fetched_at)`. 60 s TTL plus explicit
    /// invalidation on join.
    pub community_members_cache: Arc<Mutex<HashMap<Uuid, (Vec<Uuid>, Instant)>>>,
    /// Sliding-window limiter for `voice.room.request`, keyed by user.
    pub room_request_limiter: Arc<Mutex<HashMap<Uuid, VecDeque<Instant>>>>,
}

const CHANNEL_COMMUNITY_TTL: Duration = Duration::from_secs(300);
const COMMUNITY_MEMBERS_TTL: Duration = Duration::from_secs(60);

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
            channel_community_cache: Arc::new(Mutex::new(HashMap::new())),
            community_members_cache: Arc::new(Mutex::new(HashMap::new())),
            room_request_limiter: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// `community_id` that owns `channel_id`, cached for `CHANNEL_COMMUNITY_TTL`
    /// (SPEC-005 §4.6). `None` when the channel does not exist.
    pub async fn community_of_channel(&self, channel_id: Uuid) -> Option<Uuid> {
        {
            let cache = self.channel_community_cache.lock().await;
            if let Some((community_id, at)) = cache.get(&channel_id) {
                if at.elapsed() < CHANNEL_COMMUNITY_TTL {
                    return Some(*community_id);
                }
            }
        }
        let community_id = crate::db::channel_community(&self.pool, channel_id)
            .await
            .ok()
            .flatten()?;
        self.channel_community_cache
            .lock()
            .await
            .insert(channel_id, (community_id, Instant::now()));
        Some(community_id)
    }

    /// Member ids of `community_id`, cached for `COMMUNITY_MEMBERS_TTL`.
    pub async fn community_members(&self, community_id: Uuid) -> Result<Vec<Uuid>, sqlx::Error> {
        {
            let cache = self.community_members_cache.lock().await;
            if let Some((members, at)) = cache.get(&community_id) {
                if at.elapsed() < COMMUNITY_MEMBERS_TTL {
                    return Ok(members.clone());
                }
            }
        }
        let members = crate::db::community_member_ids(&self.pool, community_id).await?;
        self.community_members_cache
            .lock()
            .await
            .insert(community_id, (members.clone(), Instant::now()));
        Ok(members)
    }

    pub async fn invalidate_channel_cache(&self, channel_id: Uuid) {
        self.channel_community_cache.lock().await.remove(&channel_id);
    }

    pub async fn invalidate_members_cache(&self, community_id: Uuid) {
        self.community_members_cache.lock().await.remove(&community_id);
    }

    /// `voice.room.request` limiter: at most 5 per user per rolling 10 s.
    pub async fn allow_room_request(&self, user_id: Uuid) -> bool {
        const WINDOW: Duration = Duration::from_secs(10);
        const MAX: usize = 5;
        let mut guard = self.room_request_limiter.lock().await;
        let now = Instant::now();
        let entry = guard.entry(user_id).or_default();
        while entry.front().is_some_and(|front| now.duration_since(*front) > WINDOW) {
            entry.pop_front();
        }
        if entry.len() >= MAX {
            return false;
        }
        entry.push_back(now);
        true
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
