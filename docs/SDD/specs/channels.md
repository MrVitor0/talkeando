# Channels — Specification

Status: Draft v1
Owner/Domain: Backend (server/src/channels/*), Client UI (client/ui/src/features/channels)
Related canon sections: §7 (schema), §9 (ID catalog), §10 (ChannelSidebar layout)

## Objetivo

Model and serve the community's structure: one community (v1: exactly one
row, seeded), organized into categories, each containing text or voice
channels, rendered in the `ChannelSidebar`.

## Contexto

Talkeando is single-community in v1. The `communities` table exists for
future multi-community modeling but the UI never shows a community switcher
beyond the single seeded community's rail icon. Channels are either `text`
(chat) or `voice` (a joinable call, see `specs/calls.md`). Categories are
purely a UI grouping/ordering mechanism, collapsible client-side.

## Escopo

- REST CRUD for categories and channels (owner-restricted mutations; all
  members can read)
- Channel/category ordering (`position` field, drag-reorder is a future UI
  nicety — v1 ships reorder via API/admin only, not drag-and-drop UI)
- `ChannelSidebar` rendering: category groups, text channel rows, voice
  channel rows with inline connected-member avatars and `NN / 10` capacity
  pill, collapsible categories (client-only, persisted to local settings)
- Fetching channel list on app load / community switch (single community in
  v1, so effectively on app load only)

## Fora de escopo

- Per-channel permission UI/enforcement (table exists per canon §7, only
  community-membership is enforced) — record as explicit scope cut.
- Channel creation/deletion/rename UI in v1 client (REST endpoints exist for
  completeness and are usable via a future admin UI or `curl`, but no
  in-app "create channel" button ships in v1 — this keeps phase-01/04 scope
  bounded; record as deferred UI, not a missing capability at the API layer).
- Multi-community switching UX.
- Nested categories (single-level category → channel only).

## User stories

- As any community member, I see all categories and channels immediately
  on connecting, with voice channels showing who's currently in them.
- As the owner, I can create/rename/reorder channels and categories via the
  REST API (e.g. scripted or via `curl`/Postman) without a dedicated UI.
- As a member, I can collapse a category I don't care about and have that
  preference remembered next time I open the app.

## Functional requirements

- **CHAN-FR-001**: `GET /channels` (Bearer auth) returns the full structure
  for the caller's community: categories (with `position`) each containing
  their channels (with `position`, `kind`, `topic`), plus any channels with
  `category_id = null` (uncategorized, rendered at the top of the sidebar
  before any category group).
- **CHAN-FR-002**: `POST /channels/categories` (owner role only) creates a
  category `{ name, position? }`; if `position` omitted, appended
  (`max(position)+1` within the community).
- **CHAN-FR-003**: `PATCH /channels/categories/{id}` (owner only) updates
  `name` and/or `position`.
- **CHAN-FR-004**: `DELETE /channels/categories/{id}` (owner only) deletes a
  category; channels under it become uncategorized (`category_id = null`),
  never cascade-deleted.
- **CHAN-FR-005**: `POST /channels` (owner only) creates a channel
  `{ name, kind: "text"|"voice", category_id?, topic?, position? }`.
- **CHAN-FR-006**: `PATCH /channels/{id}` (owner only) updates `name`,
  `topic`, `category_id`, `position`. `kind` is immutable after creation
  (changing text↔voice is not a supported operation — delete and recreate).
- **CHAN-FR-007**: `DELETE /channels/{id}` (owner only). If `kind = "voice"`
  and it has an active `ActiveCall` (canon §6), the server first force-ends
  the call (broadcasts `call.peer_left` for every participant with a
  `reason: "channel_deleted"`) before deleting the row.
- **CHAN-FR-008**: All read endpoints (`GET /channels`) require only
  community membership, not any role — matches canon's "all members see all
  channels" v1 scope cut.
- **CHAN-FR-009**: Voice channels carry an implicit capacity of 10
  (matching the community's max size; not a separately configurable
  per-channel field in v1 — the `NN / 10` pill is a UX affordance, not an
  enforced hard cap distinct from the community size itself, since the
  whole community is ≤10 people, capacity is never actually exceedable and
  no join is ever rejected for capacity reasons in v1). Record as: pill is
  informational, no enforcement path needed given community size.
- **CHAN-FR-010**: `ChannelSidebar` renders categories in `position` order,
  channels within a category in `position` order; uncategorized channels
  render above all categories, also in `position` order.
- **CHAN-FR-011**: A voice channel row renders one avatar (22px) per
  currently-connected participant plus their display name, sourced from
  `call.snapshot`/`call.peer_joined`/`call.peer_left` events (see
  `specs/calls.md`), and the `NN / 10` pill where `NN` = current participant
  count.
- **CHAN-FR-012**: Category collapse/expand state is a client-only UI
  preference, persisted in local settings storage (see `specs/settings.md`),
  keyed by category id; not synced across devices/sessions.
- **CHAN-FR-013**: Clicking a text channel row navigates the main content
  column to that channel's `MessageList`/`Composer` (see `specs/chat.md`)
  and updates `ChatHeader` (name, topic).
- **CHAN-FR-014**: Clicking a voice channel row triggers `call.join` for
  that channel (see `flows/join-call.md`); it does not "navigate" the main
  content column away from whatever text channel is currently open — voice
  channel membership and the currently-viewed text channel are independent
  pieces of UI state (matches Discord-like behavior: you can be in a voice
  call while reading a different text channel).
- **CHAN-FR-015**: The channel list is fetched once via REST on app startup
  (after `auth.ok`) and kept live thereafter purely by WS-driven presence
  and call events — there is no `channel.*` WS namespace in v1 (channel
  structure changes are rare, admin-only, and do not require realtime
  propagation to already-connected clients in v1; a structural change made
  by the owner via the API takes effect for other clients on their next
  `GET /channels`, i.e. next app restart — record as an accepted v1
  limitation, not silently missing).
- **CHAN-FR-016**: Default seed data on bootstrap: one category "Geral"
  containing one text channel `#geral` and one voice channel `◗ Sala de
  Voz`, created by the `--bootstrap-owner` CLI alongside the owner account
  and the single `communities` row, so a fresh deployment is immediately
  usable.

## Non-functional requirements

- `GET /channels` responds in <100ms p95 for a community this size (single
  flat query with joins, negligible row counts — no pagination needed).

## UX behavior

- Sidebar always shows something (never a blank sidebar): the seed data
  guarantees at least one category/channel exist from first boot.
- Empty-of-messages text channel: see `specs/chat.md` for the empty state
  (this spec only owns the sidebar row, not the message list body).
- No channels in community yet (theoretical, since seed data prevents it in
  practice, but the client must not crash if `GET /channels` ever returns an
  empty array — e.g. all channels manually deleted via API): sidebar shows a
  centered muted message "Nenhum canal ainda." and the main content column
  shows a matching empty state instead of a message list.

## UI states

- Sidebar: loaded (normal), loading (skeleton rows, shown only on the very
  first fetch before any cached structure exists), empty (see above), error
  (fetch failed — sidebar shows last-known structure if any, plus a small
  inline "Falha ao atualizar canais" notice; never blocks the rest of the
  app).
- Category: expanded, collapsed.
- Channel row: default, hover, active/selected (text channel currently
  open), voice-connected (current user is in this voice channel — distinct
  visual treatment, e.g. accent-colored icon).

## API contracts

```
GET /channels
200 -> {
  categories: [{ id, name, position, channels: [Channel] }],
  uncategorized_channels: [Channel]
}
Channel = { id, name, kind: "text"|"voice", category_id: uuid|null, topic: string|null, position: int }

POST /channels/categories   (owner only)
Request: { name: string, position?: int }
201 -> { id, name, position }
403 -> { code: "forbidden" }  (non-owner)

PATCH /channels/categories/{id}   (owner only)
Request: { name?: string, position?: int }
200 -> { id, name, position }

DELETE /channels/categories/{id}   (owner only)
204

POST /channels   (owner only)
Request: { name: string, kind: "text"|"voice", category_id?: uuid|null, topic?: string, position?: int }
201 -> Channel

PATCH /channels/{id}   (owner only)
Request: { name?: string, topic?: string, category_id?: uuid|null, position?: int }
200 -> Channel

DELETE /channels/{id}   (owner only)
204
```

## WebSocket events

None owned by this domain in v1 (see CHAN-FR-015). Voice channel occupancy
shown in the sidebar is derived from `call.snapshot` / `call.peer_joined` /
`call.peer_left` (owned by `specs/calls.md`), not from a channels-namespace
event.

## IPC contracts

None beyond the generic REST fetch path already available to the UI (no
native-only concern here).

## Data model

Per canon §7 exactly: `communities`, `community_members`,
`channel_categories`, `channels`, `channel_members` (existing, unenforced
beyond membership per CHAN-FR-008/canon §7).

## State transitions

Channels/categories have no lifecycle state machine beyond existence
(create → optionally update → optionally delete). Voice channel "occupancy"
state lives in `ActiveCall` (see `specs/calls.md`), not here.

## Concurrency model

Standard REST handlers over the connection pool; category/channel
create/update/delete use a single UPDATE/INSERT/DELETE statement each, no
multi-statement transactions needed except `DELETE /channels/categories/{id}`
which must, in one transaction: `UPDATE channels SET category_id = NULL
WHERE category_id = $1` then `DELETE FROM channel_categories WHERE id = $1`.

## Security considerations

- Role check (`owner` vs `member`) enforced server-side on every mutating
  endpoint by joining `community_members.role` for the caller against the
  single community row — never trust a client-supplied role.
- Read endpoints only check community membership, matching canon's stated
  v1 permission model (explicitly not more restrictive, and documented as
  such rather than silently permissive).

## Failure modes

- `GET /channels` fails (network/server down): client shows last cached
  structure (kept in memory from the prior successful fetch this session;
  on a cold start with no cache, shows the sidebar error/loading state) and
  retries are covered by the same reconnect logic as the WS layer (see
  `flows/reconnect.md`) — a failed initial fetch is retried with the same
  backoff schedule as WS reconnect for consistency.
- Mutating endpoint called by a non-owner: `403 forbidden`.
- Deleting a voice channel with an active call: handled per CHAN-FR-007,
  never leaves orphaned `ActiveCall` state referencing a deleted channel.

## Recovery behavior

Since channel structure changes are not pushed live (CHAN-FR-015), there is
no "resync" concern mid-session; a full resync simply happens on next app
restart via `GET /channels`. Voice occupancy resyncs via
`flows/reconnect.md`'s call-rejoin layer regardless of channel-structure
staleness.

## Telemetry

Server logs category/channel create/update/delete at `info` (actor user id,
target id, operation). `GET /channels` is not logged per-call beyond normal
HTTP access logging (too frequent/low-value at `info`).

## Testing

- Unit: position-append math when `position` omitted; category-delete
  orphaning logic.
- Integration: full CRUD round-trip for categories/channels; role
  enforcement (member gets 403 on all mutating endpoints); deleting a
  category with channels leaves them uncategorized, not deleted; deleting a
  voice channel with an active call correctly force-ends it (assert
  `call.peer_left` broadcast with `reason: "channel_deleted"` to all
  participants before the row disappears).
- Manual: seed data appears correctly on a truly fresh database after
  `--bootstrap-owner`; sidebar renders correctly with 0, 1, and many
  categories/channels; collapse state persists across app restart.

## Acceptance criteria

- Fresh deployment shows `#geral` and `◗ Sala de Voz` immediately after
  first login, no manual setup required.
- A member (non-owner) cannot create/edit/delete any channel or category via
  the API (403).
- Deleting a category never deletes its channels.
- Voice channel rows in the sidebar accurately reflect current occupancy
  within one call-event round-trip (no polling needed).

## Dependencies

- `sessions`/`community_members` from `specs/auth.md` for role checks.
- `specs/calls.md` for voice occupancy data feeding the sidebar.
- `specs/settings.md` for persisting category collapse state.

## Future considerations

- Drag-and-drop reorder UI.
- In-app channel/category create/rename/delete UI (owner-only controls).
- Per-channel permission enforcement beyond membership.
- Live `channel.*` WS namespace if structural changes need to propagate
  without a restart.
