-- The music bot's status cards ("Procurando uma fonte", "Tocando agora",
-- "Bot desconectado", …) are persisted as ordinary messages so they survive a
-- reconnect / reload and load with channel history. See
-- ws/handler.rs::handle_music_status. NULL for every human-authored message.
ALTER TABLE messages ADD COLUMN music_status JSONB;

-- The bot authors those messages, and messages.author_id references users(id).
-- It authenticates over the WebSocket with MUSIC_BOT_TOKEN, never a password,
-- so the row just needs to exist. Id matches ws::handler::MUSIC_BOT_ID
-- (Uuid::from_u128(1)).
INSERT INTO users (id, username, display_name, password_hash, avatar_color, name_color, profile_tag, bio, banner_preset, pronouns)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'tupi-musica',
    'Tupi Música',
    '!',
    '#5865f2',
    '#5865f2',
    'BOT',
    'Bot de música oficial do Tupi. Toque qualquer música ou rádio usando os controles de voz.',
    'synthwave',
    'ele/bot'
)
ON CONFLICT DO NOTHING;
