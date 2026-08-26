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
