-- Lets the client safely retry `chat.message.create` after a timeout
-- without risking a duplicate message: the client supplies its own req_id,
-- and a retry with the same (channel_id, author_id, req_id) resolves to
-- the original row instead of inserting a second one. See
-- SDD/specs/chat.md and IpcBridge/App.tsx optimistic-send handling.
ALTER TABLE messages ADD COLUMN client_req_id TEXT;

CREATE UNIQUE INDEX idx_messages_author_req_id
    ON messages (channel_id, author_id, client_req_id)
    WHERE client_req_id IS NOT NULL;
