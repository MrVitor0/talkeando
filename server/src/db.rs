use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub avatar_color: Option<String>,
    pub avatar_storage_path: Option<String>,
    pub avatar_content_type: Option<String>,
    pub profile_tag: Option<String>,
    pub profile_badge_storage_path: Option<String>,
    pub profile_badge_content_type: Option<String>,
    /// Hex `#rrggbb` for the display name everywhere it is shown, or NULL for
    /// the client-side default.
    pub name_color: Option<String>,
    pub bio: Option<String>,
    pub banner_preset: Option<String>,
    pub pronouns: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicUser {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub avatar_color: Option<String>,
    pub avatar_url: Option<String>,
    pub profile_tag: Option<String>,
    pub profile_badge_url: Option<String>,
    pub name_color: Option<String>,
    pub bio: Option<String>,
    pub banner_preset: Option<String>,
    pub pronouns: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
}

impl From<User> for PublicUser {
    fn from(u: User) -> Self {
        Self {
            id: u.id,
            username: u.username,
            display_name: u.display_name,
            avatar_color: u.avatar_color,
            avatar_url: u.avatar_storage_path.map(|_| format!("/api/users/{}/avatar", u.id)),
            profile_tag: u.profile_tag,
            profile_badge_url: u.profile_badge_storage_path.map(|_| format!("/api/users/{}/profile-badge", u.id)),
            name_color: u.name_color,
            bio: u.bio,
            banner_preset: u.banner_preset,
            pronouns: u.pronouns,
            created_at: Some(u.created_at),
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Session {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token_hash: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Community {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Channel {
    pub id: Uuid,
    pub community_id: Uuid,
    pub category_id: Option<Uuid>,
    pub name: String,
    pub kind: String,
    pub topic: Option<String>,
    pub position: i32,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct ChannelCategory {
    pub id: Uuid,
    pub community_id: Uuid,
    pub name: String,
    pub position: i32,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Message {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub author_id: Uuid,
    pub content: String,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    /// Idempotency key for `chat.message.create` retries (CHAT-FR) —
    /// internal only, never serialized to REST/WS clients (the *creating*
    /// request's req_id is echoed explicitly by the WS handler instead, see
    /// ws/handler.rs).
    #[serde(skip_serializing)]
    pub client_req_id: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Invite {
    pub id: Uuid,
    pub community_id: Uuid,
    pub created_by: Uuid,
    pub code: String,
    pub max_uses: Option<i32>,
    pub uses: i32,
    pub expires_at: Option<DateTime<Utc>>,
}

/// Returns the channel iff `user_id` is a member of the community that owns
/// it (CHAN-FR-004: v1 authorization is community-membership only — see
/// SDD/07-database-design.md for the channel_members scope cut).
pub async fn channel_if_member(
    pool: &PgPool,
    channel_id: Uuid,
    user_id: Uuid,
) -> Result<Option<Channel>, sqlx::Error> {
    sqlx::query_as::<_, Channel>(
        "SELECT c.* FROM channels c \
         JOIN community_members cm ON cm.community_id = c.community_id \
         WHERE c.id = $1 AND cm.user_id = $2",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
}

/// Unscoped channel lookup for the internal music participant. Public callers
/// must use `channel_if_member` instead.
pub async fn channel_by_id(pool: &PgPool, channel_id: Uuid) -> Result<Option<Channel>, sqlx::Error> {
    sqlx::query_as::<_, Channel>("SELECT * FROM channels WHERE id = $1")
        .bind(channel_id)
        .fetch_optional(pool)
        .await
}

/// The community that owns a channel, if it exists. Used to fan a voice-roster
/// update out to the right community without loading the whole `Channel` row.
pub async fn channel_community(
    pool: &PgPool,
    channel_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    let row: Option<(Uuid,)> =
        sqlx::query_as("SELECT community_id FROM channels WHERE id = $1")
            .bind(channel_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(id,)| id))
}

/// Of the given channel ids, the subset that live in a community `user_id`
/// belongs to — so the voice.rooms snapshot never leaks rooms across
/// communities.
pub async fn visible_channel_ids(
    pool: &PgPool,
    user_id: Uuid,
    channel_ids: &[Uuid],
) -> Result<Vec<Uuid>, sqlx::Error> {
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT c.id FROM channels c \
         JOIN community_members cm ON cm.community_id = c.community_id \
         WHERE cm.user_id = $1 AND c.id = ANY($2)",
    )
    .bind(user_id)
    .bind(channel_ids)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// All users who may receive community-scoped realtime events. Keeping this
/// lookup next to the membership guard makes it hard for a new WS event to
/// accidentally fan out across communities.
pub async fn community_member_ids(
    pool: &PgPool,
    community_id: Uuid,
) -> Result<Vec<Uuid>, sqlx::Error> {
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT user_id FROM community_members WHERE community_id = $1",
    )
    .bind(community_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(user_id,)| user_id).collect())
}

/// Whether `user_id` is the `owner` of `community_id`. Used to gate
/// moderator-style actions (e.g. dragging another member between voice
/// channels) — mirrors the `role = 'owner'` checks in the HTTP routes.
pub async fn is_community_owner(
    pool: &PgPool,
    community_id: Uuid,
    user_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let found: Option<(Uuid,)> = sqlx::query_as(
        "SELECT user_id FROM community_members \
         WHERE community_id = $1 AND user_id = $2 AND role = 'owner'",
    )
    .bind(community_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}

/// The first community a user belongs to. v1 puts every member in exactly one
/// community, so "first" is "the" community; the debug endpoint (SPEC-002) and
/// `dm.open` both need it. Extracted from the inline query that used to live in
/// `ws/handler.rs`.
pub async fn primary_community_for(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    let row: Option<(Uuid,)> = sqlx::query_as(
        "SELECT community_id FROM community_members WHERE user_id = $1 LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(community_id,)| community_id))
}

/// `channel_id -> name` for the ids given. Missing ids are simply absent from
/// the map — the debug endpoint (SPEC-002) treats that as `channel_name: null`
/// so an orphaned registry row still shows up.
pub async fn channel_names_for(
    pool: &PgPool,
    channel_ids: &[Uuid],
) -> Result<HashMap<Uuid, String>, sqlx::Error> {
    if channel_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id, name FROM channels WHERE id = ANY($1)")
            .bind(channel_ids)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().collect())
}

/// `user_id -> display_name` for the ids given. Missing ids are absent from the
/// map. Used by the debug endpoint to label voice participants.
pub async fn display_names_for(
    pool: &PgPool,
    user_ids: &[Uuid],
) -> Result<HashMap<Uuid, String>, sqlx::Error> {
    if user_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id, display_name FROM users WHERE id = ANY($1)")
            .bind(user_ids)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().collect())
}

// ---- game_sessions (SDD/specs/activity.md, ACT-FR-030..032) ----

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GameStats {
    pub total_seconds: i64,
    pub last_played_at: Option<DateTime<Utc>>,
    pub is_new: bool,
}

/// Open a playtime row for a game the user just started, unless one is
/// already open (partial unique index on `(user_id, game_key) WHERE ended_at
/// IS NULL` makes this a no-op on conflict).
pub async fn open_game_session(
    pool: &PgPool,
    user_id: Uuid,
    game_key: &str,
    game_name: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO game_sessions (user_id, game_key, game_name) VALUES ($1, $2, $3) \
         ON CONFLICT (user_id, game_key) WHERE ended_at IS NULL DO NOTHING",
    )
    .bind(user_id)
    .bind(game_key)
    .bind(game_name)
    .execute(pool)
    .await
    .map(|_| ())
}

/// Close the open playtime row for one game (the user stopped playing it).
pub async fn close_game_session(pool: &PgPool, user_id: Uuid, game_key: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE game_sessions SET ended_at = now() WHERE user_id = $1 AND game_key = $2 AND ended_at IS NULL",
    )
    .bind(user_id)
    .bind(game_key)
    .execute(pool)
    .await
    .map(|_| ())
}

/// Close every open playtime row for a user (disconnect).
pub async fn close_all_game_sessions(pool: &PgPool, user_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE game_sessions SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL")
        .bind(user_id)
        .execute(pool)
        .await
        .map(|_| ())
}

/// Close rows left open by a crash — their real duration is unknown, so the
/// session is worth zero seconds (ended_at = started_at). Run at startup.
pub async fn close_dangling_game_sessions(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let result =
        sqlx::query("UPDATE game_sessions SET ended_at = started_at WHERE ended_at IS NULL")
            .execute(pool)
            .await?;
    Ok(result.rows_affected())
}

/// Lifetime aggregates for one (user, game): total seconds played, when it
/// was last played, and whether the very first session began under 24h ago.
pub async fn game_stats(pool: &PgPool, user_id: Uuid, game_key: &str) -> Result<GameStats, sqlx::Error> {
    sqlx::query_as::<_, GameStats>(
        "SELECT \
           COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)))::bigint, 0) AS total_seconds, \
           MAX(COALESCE(ended_at, now())) AS last_played_at, \
           COALESCE(MIN(started_at) > now() - INTERVAL '24 hours', true) AS is_new \
         FROM game_sessions WHERE user_id = $1 AND game_key = $2",
    )
    .bind(user_id)
    .bind(game_key)
    .fetch_one(pool)
    .await
}

/// All members sharing at least one community with `user_id`. v1 has a
/// single community, but this keeps presence fan-out correct at the boundary.
pub async fn related_member_ids(pool: &PgPool, user_id: Uuid) -> Result<Vec<Uuid>, sqlx::Error> {
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT DISTINCT other.user_id FROM community_members mine \
         JOIN community_members other ON other.community_id = mine.community_id \
         WHERE mine.user_id = $1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}
