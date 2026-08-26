mod auth;
mod config;
mod db;
mod error;
mod routes;
mod state;
mod telemetry;
mod ws;

use clap::{Parser, Subcommand};
use sqlx::postgres::PgPoolOptions;
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{config::Config, state::AppState};

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
    sqlx::migrate!("./migrations").run(&pool).await?;

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
    let state = AppState::new(pool, config);

    let app = routes::router()
        .route("/ws", axum::routing::get(ws::ws_upgrade))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    tracing::info!(%bind_addr, "starting talkeando-server");
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
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
