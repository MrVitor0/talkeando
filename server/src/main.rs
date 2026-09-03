use std::{path::PathBuf, str::FromStr};

use clap::{Parser, Subcommand};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Executor;

use tupi_server::{auth, build_app, config::Config, discord_import, run_migrations, state::AppState, telemetry};

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
        #[arg(long, default_value = "Estação Finita")]
        community_name: String,
    },
    /// Imports the Discord message responses captured in a HAR archive.
    ImportDiscordHar {
        /// HAR file copied from the machine that captured the Discord history.
        #[arg(long)]
        har_path: PathBuf,
    },
    /// Imports the reviewed JSON produced by
    /// `scripts/discord-import/har-to-json.mjs` (step 2 of the HAR import).
    ImportDiscordJson {
        /// Path to the JSON file generated from the HAR.
        #[arg(long)]
        path: PathBuf,
    },
    /// Imports all approved Discord channels using a temporary credential in
    /// DISCORD_AUTHORIZATION. The secret is never stored by Tupi.
    ImportDiscordLive {
        /// Delete only messages previously imported from Discord before the
        /// fresh import. Messages authored in Tupi remain untouched.
        #[arg(long)]
        replace_imported: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    telemetry::init();

    let cli = Cli::parse();
    let config = Config::from_env();

    // Neon's PgBouncer pooler endpoint (`ep-xxx-pooler.<region>...`) runs in
    // transaction mode: it hands out sessions with an empty `search_path`
    // (so unqualified `CREATE TABLE` in the migrations fails with "no schema
    // has been selected to create in") and rejects the `options=search_path`
    // startup parameter outright. Talk to the direct endpoint instead — this
    // is a ~10-person deployment, the pooler buys us nothing.
    let database_url = config.database_url.replace("-pooler.", ".");
    let connect_options = PgConnectOptions::from_str(&database_url)?;
    let pool = PgPoolOptions::new()
        .max_connections(50)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                // Harmless on a direct connection; a safety net if the URL
                // ever points back at a session-mode pooler.
                conn.execute("SET search_path TO public").await.ok();
                Ok(())
            })
        })
        .connect_with(connect_options)
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
        Command::ImportDiscordHar { har_path } => {
            discord_import::import_har(&pool, &config, &har_path).await
        }
        Command::ImportDiscordJson { path } => {
            discord_import::import_json(&pool, &config, &path).await
        }
        Command::ImportDiscordLive { replace_imported } => {
            let authorization = std::env::var("DISCORD_AUTHORIZATION")
                .map_err(|_| anyhow::anyhow!("set DISCORD_AUTHORIZATION for this one command; do not put it in .env"))?;
            if replace_imported {
                discord_import::replace_with_live(&pool, &config, &authorization).await
            } else {
                discord_import::import_live(&pool, &config, &authorization).await
            }
        }
    }
}

async fn serve(pool: sqlx::PgPool, config: Config) -> anyhow::Result<()> {
    let bind_addr = config.bind_addr.clone();
    tokio::fs::create_dir_all(&config.attachment_storage_path).await?;
    tokio::fs::create_dir_all(
        std::path::Path::new(&config.attachment_storage_path).join("_activity_assets"),
    )
    .await?;
    // ACT-FR-031: a previous run may have crashed with playtime rows still
    // open; close them (worth zero seconds — real duration is unknown).
    match tupi_server::db::close_dangling_game_sessions(&pool).await {
        Ok(closed) if closed > 0 => tracing::info!(closed, "closed dangling game sessions from a prior run"),
        Ok(_) => {}
        Err(error) => tracing::warn!(%error, "failed to close dangling game sessions"),
    }
    let state = AppState::new(pool, config);
    spawn_attachment_cleanup(state.clone());
    spawn_voice_reconcile(state.clone());

    let app = build_app(state);

    tracing::info!(%bind_addr, "starting tupi-server");
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

            // SPEC-014: prune client diagnostics reports older than 7 days.
            let logs_dir = std::path::Path::new(&state.config.attachment_storage_path).join("_client_logs");
            if let Ok(mut entries) = tokio::fs::read_dir(&logs_dir).await {
                let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 24 * 60 * 60);
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let too_old = entry
                        .metadata()
                        .await
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .is_some_and(|modified| modified < cutoff);
                    if too_old {
                        if let Err(error) = tokio::fs::remove_file(entry.path()).await {
                            tracing::warn!(%error, path = ?entry.path(), "failed to remove old client log");
                        }
                    }
                }
            }
        }
    });
}

/// Keeps the ephemeral voice roster pinned to LiveKit's authoritative room
/// list. A server restart wipes the in-memory registry and LiveKit never
/// replays `participant_joined` for people already in a room, so without this
/// the sidebar stays empty (and screen-share indicators stale) until every
/// client re-announces itself.
fn spawn_voice_reconcile(state: AppState) {
    if state.config.livekit_url.is_none() {
        return;
    }
    tokio::spawn(async move {
        use std::time::{Duration, Instant};
        // Let the process settle and accept a few reconnects first.
        tokio::time::sleep(Duration::from_secs(3)).await;
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        let mut last_full = Instant::now();
        loop {
            ticker.tick().await;

            // 1. Directed reconciles that came due (leave, kick, move, room_finished).
            for channel_id in state.take_due_reconciles().await {
                tupi_server::ws::handler::reconcile_one_room(&state, channel_id).await;
            }

            // 2. Full sweep every 15 s, as before.
            if last_full.elapsed() >= Duration::from_secs(15)
                && state.should_reconcile_voice(Duration::ZERO).await
            {
                last_full = Instant::now();
                tupi_server::ws::handler::reconcile_voice_rooms(&state).await;
            }

            // 3. Expire provisionals (INV-A2).
            let expired = state.hub.voice.write().await.expire_provisionals();
            for change in expired {
                tupi_server::ws::voice_metrics::VoiceMetrics::bump(
                    &state.voice_metrics.provisional_expired,
                );
                tracing::warn!(
                    event = "voice.registry.participant_expired",
                    channel_id = %change.channel_id,
                    source = "expiry"
                );
                tupi_server::ws::handler::publish_room_change(&state, change).await;
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

    sqlx::query("INSERT INTO invites (community_id, created_by, code) VALUES ($1, $2, 'estacao-infinita')")
        .bind(community.0)
        .bind(user.0)
        .execute(&mut *tx)
        .await?;

    // The initial community mirrors the channel structure used by the
    // product UI, including separate text and voice groups.
    let categories = [
        "Central de Felipes#",
        "hub central#",
        "hub-larp",
        "Central de Comunicação",
        "Redes Privadas",
        "*Redes Desconhecidas*",
    ];
    let mut category_ids = Vec::with_capacity(categories.len());
    for (position, name) in categories.iter().enumerate() {
        let category: (uuid::Uuid,) = sqlx::query_as(
            "INSERT INTO channel_categories (community_id, name, position) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(community.0)
        .bind(name)
        .bind(position as i32)
        .fetch_one(&mut *tx)
        .await?;
        category_ids.push(category.0);
    }

    let channels = [
        (0, "hangar", "text"), (0, "monitor-de-noticias", "text"),
        (1, "átrio-principal", "text"), (1, "setor-habitacional", "text"),
        (1, "central-de-docs", "text"), (1, "mercado-negro", "text"),
        (1, "black-baratheon", "text"), (1, "comandos-de-console", "text"),
        (2, "atrio-principlarper", "text"), (2, "cobblemon-masters-news", "text"),
        (2, "comandos-de-larp", "text"),
        (3, "*Canal Primário*", "voice"), (3, "*Canal Of.1*", "voice"),
        (3, "*Canal Of.2*", "voice"), (4, "*Canal Alpha*", "voice"),
        (4, "*Canal Beta*", "voice"), (4, "*Canal Gamma*", "voice"),
        (4, "segredinho", "voice"), (5, "*&@Z#&+(O:*", "voice"),
    ];
    for (position, (category_index, name, kind)) in channels.iter().enumerate() {
        sqlx::query(
            "INSERT INTO channels (community_id, category_id, name, kind, position) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(community.0)
        .bind(category_ids[*category_index])
        .bind(name)
        .bind(kind)
        .bind(position as i32)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    println!(
        "Bootstrapped community '{community_name}' ({}) with owner '{username}' ({}).",
        community.0, user.0
    );
    println!("Create additional invite codes via POST /api/invites once logged in.");
    Ok(())
}
