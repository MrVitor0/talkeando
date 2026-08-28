-- Migration 0009: Add image_url to message_link_previews if not already present
-- and ensure description column exists for richer unfurls.

ALTER TABLE message_link_previews
    ADD COLUMN IF NOT EXISTS image_url TEXT,
    ADD COLUMN IF NOT EXISTS description TEXT;
