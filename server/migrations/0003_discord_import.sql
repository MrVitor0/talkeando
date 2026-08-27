-- Idempotency ledger for the one-way Discord archive importer. The imported
-- data remains ordinary Talkeando messages and attachments; these tables only
-- remember their Discord source IDs so a later, larger HAR can be re-run.
CREATE TABLE imported_message_sources (
    source              TEXT NOT NULL,
    source_message_id   TEXT NOT NULL,
    message_id          UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    PRIMARY KEY (source, source_message_id),
    UNIQUE (message_id)
);

CREATE TABLE imported_attachment_sources (
    source                  TEXT NOT NULL,
    source_attachment_id    TEXT NOT NULL,
    attachment_id           UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    PRIMARY KEY (source, source_attachment_id),
    UNIQUE (attachment_id)
);
