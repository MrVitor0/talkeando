use clap::{Parser, Subcommand};
use sqlx::postgres::PgPoolOptions;

use talkeando_server::{auth, build_app, config::Config, run_migrations, state::AppState, telemetry};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the HTTP + WebSocket server (default if no subcommand given).
    Serve,
    /// One-time setup: create the single community and its owner account.
    /// Not exposed over HTTP — see SDD/specs/auth.md ("no open self-signup").
    BootstrapOwner {
        #[arg(long)]
        username: String,
        #[arg(long)]
        password: String,
        #[arg(long)]
        display_name: String,
        #[arg(long, default_value = "Talkeando")]
        community_name: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    telemetry::init();

    let cli = Cli::parse();
    let config = Config::from_env();
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await?;
    run_migrations(&pool).await?;

    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve(pool, config).await,
        Command::BootstrapOwner {
            username,
            password,
            display_name,
            community_name,
        } => bootstrap_owner(pool, username, password, display_name, community_name).await,
    }
}

async fn serve(pool: sqlx::PgPool, config: Config) -> anyhow::Result<()> {
    let bind_addr = config.bind_addr.clone();
    tokio::fs::create_dir_all(&config.attachment_storage_path).await?;
    let state = AppState::new(pool, config);
    spawn_attachment_cleanup(state.clone());

    let app = build_app(state);

    tracing::info!(%bind_addr, "starting talkeando-server");
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await?;
    Ok(())
}

/// Uploads are intentionally created before a WebSocket message references
/// them. Remove abandoned uploads periodically so a cancelled composer cannot
/// become permanent disk usage. A conditional delete prevents removing an
/// attachment that was associated between the scan and cleanup.
fn spawn_attachment_cleanup(state: AppState) {
    tokio::spawn(async move {
        let interval = std::time::Duration::from_secs(60 * 60);
        loop {
            tokio::time::sleep(interval).await;
            let rows: Result<Vec<(uuid::Uuid, String)>, sqlx::Error> = sqlx::query_as(
                "SELECT id, storage_path FROM attachments \
                 WHERE message_id IS NULL AND created_at < now() - ($1 * INTERVAL '1 hour')",
            )
            .bind(state.config.unattached_attachment_ttl_hours)
            .fetch_all(&state.pool)
            .await;
            let Ok(rows) = rows else {
                tracing::warn!("failed to scan unattached attachments for cleanup");
                continue;
            };
            for (id, storage_path) in rows {
                match sqlx::query("DELETE FROM attachments WHERE id = $1 AND message_id IS NULL")
                    .bind(id)
                    .execute(&state.pool)
                    .await
                {
                    Ok(result) if result.rows_affected() == 1 => {
                        if let Err(error) = tokio::fs::remove_file(&storage_path).await {
                            if error.kind() != std::io::ErrorKind::NotFound {
                                tracing::warn!(%id, %error, "failed to remove orphaned attachment file");
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(error) => tracing::warn!(%id, %error, "failed to delete orphaned attachment row"),
                }
            }
        }
    });
}

async fn bootstrap_owner(
    pool: sqlx::PgPool,
    username: String,
    password: String,
    display_name: String,
    community_name: String,
) -> anyhow::Result<()> {
    let already_bootstrapped: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM communities)")
        .fetch_one(&pool)
        .await?;
    if already_bootstrapped {
        anyhow::bail!("a community already exists; bootstrap-owner can only run once");
    }

    let username = auth::normalize_username(&username)
        .map_err(|e| anyhow::anyhow!("invalid owner username: {e}"))?;
    let password_hash = auth::hash_password(&password)
        .map_err(|e| anyhow::anyhow!("failed to hash password: {e}"))?;

    let mut tx = pool.begin().await?;

    let community: (uuid::Uuid,) =
        sqlx::query_as("INSERT INTO communities (name) VALUES ($1) RETURNING id")
            .bind(&community_name)
            .fetch_one(&mut *tx)
            .await?;

    let user: (uuid::Uuid,) = sqlx::query_as(
        "INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(&username)
    .bind(&display_name)
    .bind(&password_hash)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query("INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'owner')")
        .bind(community.0)
        .bind(user.0)
        .execute(&mut *tx)
        .await?;

    let category: (uuid::Uuid,) = sqlx::query_as(
        "INSERT INTO channel_categories (community_id, name, position) VALUES ($1, 'General', 0) RETURNING id",
    )
    .bind(community.0)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO channels (community_id, category_id, name, kind, position) VALUES \
         ($1, $2, 'general', 'text', 0), ($1, $2, 'voice-general', 'voice', 1)",
    )
    .bind(community.0)
    .bind(category.0)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    println!(
        "Bootstrapped community '{community_name}' ({}) with owner '{username}' ({}).",
        community.0, user.0
    );
    println!("Create additional invite codes via POST /api/invites once logged in.");
    Ok(())
}
