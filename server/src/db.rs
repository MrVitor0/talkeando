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
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicUser {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub avatar_color: Option<String>,
}

impl From<User> for PublicUser {
    fn from(u: User) -> Self {
        Self {
            id: u.id,
            username: u.username,
            display_name: u.display_name,
            avatar_color: u.avatar_color,
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
