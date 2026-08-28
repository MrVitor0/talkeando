-- Rich embeds imported from Discord (bot polls, "now playing", changelog cards).
-- Unlike message_link_previews (a single URL unfurl), these have no Talkeando
-- authoring path yet: they exist only to render the imported history faithfully.
-- Images are copied into the attachment volume so history never depends on
-- expiring Discord CDN URLs.
CREATE TABLE message_embeds (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id                  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    position                    INTEGER NOT NULL DEFAULT 0,
    title                       TEXT,
    description                 TEXT,
    url                         TEXT,
    color                       INTEGER,
    author_name                 TEXT,
    author_url                  TEXT,
    provider_name               TEXT,
    footer_text                 TEXT,
    fields                      JSONB NOT NULL DEFAULT '[]',
    image_storage_path          TEXT,
    image_content_type          TEXT,
    thumbnail_storage_path      TEXT,
    thumbnail_content_type      TEXT,
    footer_icon_storage_path    TEXT,
    footer_icon_content_type    TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, position)
);
CREATE INDEX idx_message_embeds_message_id ON message_embeds(message_id);
