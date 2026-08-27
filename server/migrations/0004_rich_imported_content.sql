-- Imported Discord identities and link previews are stored locally, so the
-- Talkeando history never depends on expiring Discord CDN URLs.
ALTER TABLE users
    ADD COLUMN avatar_storage_path TEXT,
    ADD COLUMN avatar_content_type TEXT,
    ADD COLUMN profile_tag TEXT,
    ADD COLUMN profile_badge_storage_path TEXT,
    ADD COLUMN profile_badge_content_type TEXT;

CREATE TABLE message_link_previews (
    message_id          UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    url                 TEXT NOT NULL,
    title               TEXT,
    description         TEXT,
    site_name           TEXT,
    image_storage_path  TEXT,
    image_content_type  TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
