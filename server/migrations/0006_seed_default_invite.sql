-- Backfill the 'estacao-infinita' invite for databases that predate the
-- seed added to bootstrap-owner (server/src/main.rs). That seed only runs on
-- a fresh install — `bootstrap-owner` bails once a community exists — so the
-- already-provisioned deployment never got a joinable code and every
-- registration failed with "invite code invalid, expired, or exhausted".
--
-- Attributed to the earliest community's owner. `code` is UNIQUE, so this is
-- a no-op wherever the invite already exists (fresh installs, reruns).
INSERT INTO invites (community_id, created_by, code)
SELECT m.community_id, m.user_id, 'estacao-infinita'
FROM community_members m
JOIN communities c ON c.id = m.community_id
WHERE m.role = 'owner'
ORDER BY c.created_at
LIMIT 1
ON CONFLICT (code) DO NOTHING;
