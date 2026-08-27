-- Playtime ledger for the activity feature (SDD/specs/activity.md, ACT-FR-030).
-- The only persisted piece of "activity": how long each member has spent in
-- each game, accumulated across sessions. Nothing about music / "now playing"
-- is ever written here. One open row (ended_at IS NULL) per (user, game) at a
-- time; closed on the next report that drops the game, on disconnect, or —
-- for rows left dangling by a crash — at server startup.
CREATE TABLE game_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_key    TEXT NOT NULL,   -- "steam:<appid>" or "name:<lowercased name>"
    game_name   TEXT NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ
);

CREATE INDEX idx_game_sessions_user_key ON game_sessions (user_id, game_key);
-- At most one open session per (user, game); also makes the "close on drop"
-- update and the open-session lookups cheap.
CREATE UNIQUE INDEX idx_game_sessions_open_unique
    ON game_sessions (user_id, game_key)
    WHERE ended_at IS NULL;
