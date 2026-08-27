# Chat — Specification

Status: Draft v1
Owner/Domain: Backend (server/src/chat/*), Client UI (client/ui/src/features/chat)
Related canon sections: §5 (signaling/chat ops), §7 (schema), §9 (ID catalog)

## Objetivo

Persistent text messaging per text channel: send, edit, delete, typing
indicator, realtime fan-out to all connected community members, optimistic
UI with retry on failure.

## Contexto

Chat is the baseline always-on feature (unlike voice, which is opt-in per
channel). Messages persist in Postgres indefinitely (no retention policy in
v1). All community members can read/write to all text channels (canon's
membership-only permission model). There is no message search, no reactions
UI, no read receipts in v1 (explicit scope cuts).

## Escopo

- REST: paginated message history fetch (`GET
  /channels/{id}/messages`), attachments upload association (see
  `specs/attachments.md` for the upload mechanics themselves).
- WebSocket ops: `chat.message.create/edit/delete` (+ `.created/.edited/
  .deleted` broadcasts), `chat.typing` (ephemeral, bidi).
- Client: `MessageList` rendering (grouping consecutive messages by same
  author within a time window), `Composer`, optimistic send with pending/
  failed/retry states, edit-in-place UI, delete confirmation.

## Fora de escopo

- Message search (canon explicit scope cut).
- Reactions UI (table exists per canon §7, no v1 UI — scope cut).
- Read receipts (canon explicit scope cut).
- Message threading/replies.
- Rich text formatting beyond plain text + basic markdown-lite (bold/
  italic/code via `**`/`*`/`` ` ``) rendering — client renders these four
  inline styles only, no full Markdown (no tables/headers/etc).
- Push notifications to phone (canon explicit scope cut; see
  `specs/notifications.md` for the desktop-only notification scope that
  does ship).

## User stories

- As a member, I type a message and hit Enter; it appears immediately in my
  own view (optimistic) and, within normal network latency, in everyone
  else's view.
- As a member, if my message fails to send (server down, WS disconnected), I
  see a clear "failed" indicator and can retry with one click, without
  retyping.
- As a member, I can edit or delete my own messages; others can't edit mine,
  but can see an "(editado)" marker; deletions show as removed content
  (server-side soft delete, not visible to other clients as a stub — see
  UX behavior below for the exact rendering choice).
- As a member, I see a lightweight "Fulano está digitando…" indicator when
  someone else is composing in the channel I'm viewing.
- As a member reopening a channel, I see recent history immediately and can
  scroll up to load older messages.

## Functional requirements

- **CHAT-FR-001**: `chat.message.create` (C→S): `{ req_id, channel_id,
  content, attachment_ids?: [uuid] }`. Server validates: sender is a
  community member, `channel_id` refers to an existing `kind = "text"`
  channel, `content` is non-empty after trim OR at least one
  `attachment_id` is present (a message may be attachment-only), `content`
  length ≤ 4000 chars. On success inserts a `messages` row and broadcasts
  `chat.message.created` to every connection currently subscribed to that
  channel (see Concurrency model for what "subscribed" means) including an
  echo to the sender (the sender's optimistic local message is reconciled
  against this echo by `req_id`/client-generated temp id, not suppressed —
  see UX behavior).
- **CHAT-FR-002**: `chat.message.created` (S→C broadcast): `{ data: {
  message: Message, in_reply_to: req_id|null } }` — `in_reply_to` is
  populated only in the echo sent back to the originating connection, null
  for all other broadcast recipients.
- **CHAT-FR-003**: `chat.message.edit` (C→S): `{ req_id, message_id,
  content }`. Server validates the caller is the message's `author_id` and
  the message is not `deleted_at`-set; updates `content`, sets `edited_at =
  now()`; broadcasts `chat.message.edited`. Editing is not time-limited in
  v1 (no "15 minute edit window" — full edit history is not tracked either,
  overwritten in place).
- **CHAT-FR-004**: `chat.message.delete` (C→S): `{ req_id, message_id }`.
  Server validates caller is the author OR the community owner (owner can
  moderate-delete any message — record this as an explicit v1 moderation
  allowance); sets `messages.deleted_at = now()` (soft delete, row and
  `content` retained in DB for potential future moderation/audit, never
  physically deleted); broadcasts `chat.message.deleted { message_id,
  channel_id }` (content itself is NOT included in the broadcast payload,
  even though it's retained server-side — clients receiving the delete
  event never see the deleted content).
- **CHAT-FR-005**: `chat.typing` (bidi, ephemeral): C→S `{ channel_id }`
  (no `req_id`/ack); server broadcasts `chat.typing { user_id, channel_id }`
  to all other connections currently viewing that channel. Never persisted,
  never queued/replayed on reconnect.
- **CHAT-FR-006**: Client suppresses sending repeat `chat.typing` more than
  once per 3 seconds of continuous typing (debounce), and the receiving
  client expires a shown "is typing" indicator 5 seconds after the last
  received event for that user if no follow-up arrives (covers the case
  where the typer stops without an explicit "stopped typing" event — v1 has
  no separate stop-typing op, timeout-based expiry only).
- **CHAT-FR-007**: `GET /channels/{id}/messages?before={message_id|null}&
  limit={n<=100, default 50}` returns messages in descending `created_at`
  order (paginated backward from `before`, or from "now" if `before` is
  omitted), each including author summary (id, username, display_name,
  avatar), reaction placeholders empty (reactions table exists, unpopulated
  UI-wise), and `attachments: [Attachment]` if any.
- **CHAT-FR-008**: Soft-deleted messages (`deleted_at IS NOT NULL`) are
  excluded from `GET /channels/{id}/messages` entirely (not returned as
  tombstones over REST) — a client that already has one loaded in memory
  learns about the deletion only via the live `chat.message.deleted` event
  while connected; a client that loads history fresh after the deletion
  simply never sees that message, with no gap indicator (accepted v1
  simplification).
- **CHAT-FR-009**: Message grouping for display: consecutive messages by
  the same `author_id` within 5 minutes of each other, with no other
  author's message in between, render as one visual group (single avatar/
  name/timestamp header, stacked message bodies) per the mock's grouped
  message style.
- **CHAT-FR-010**: Optimistic send: on submit, the client immediately
  appends a locally-constructed message object to `MessageList` with a
  client-generated temporary id and status `pending`, using `req_id` as the
  correlation key. On receiving the matching `chat.message.created` echo
  (`in_reply_to == req_id`), the client replaces the optimistic entry with
  the server-confirmed one (real `id`, `created_at`) in place (no visual
  jump/reorder if timestamps are close). On receiving an `error` with
  matching `in_reply_to`, or on send timeout (see CHAT-FR-011), the entry's
  status becomes `failed`.
- **CHAT-FR-011**: Client-side send timeout: if no `chat.message.created`
  echo or `error` arrives within 8 seconds of sending
  `chat.message.create`, the client marks that pending message `failed`
  (covers silent drops that don't produce an explicit error, e.g. a
  connection that died without a clean close frame).
- **CHAT-FR-012**: A `failed` message shows a retry affordance; retrying
  re-sends `chat.message.create` **reusing the same `req_id`** (corrected
  from an earlier draft of this spec that said to generate a fresh one —
  verified at runtime to matter: see `27-decisions.md` ADR-004). Reusing
  the id is what makes the retry safe: the server stores `req_id` as an
  idempotency key (`channel_id`, `author_id`, `req_id`) and a second
  `chat.message.create` with a key that already exists resolves to the
  original row instead of inserting a duplicate. A fresh `req_id` on retry
  would defeat that protection — if the original send actually succeeded
  and only its confirmation was lost, a fresh-id retry creates a second,
  duplicate message.
- **CHAT-FR-013**: A `pending` or `failed` message that the user chooses to
  discard (explicit "cancel"/delete-before-send affordance) is simply
  removed from local UI state; nothing is sent to the server if it never
  successfully sent (no delete-of-a-never-created message concern).
- **CHAT-FR-014**: `chat.message.create/edit/delete` targeting a channel
  the sender cannot access (nonexistent, or `kind != "text"`) returns
  `error { code: "channel_not_found"|"wrong_channel_kind", in_reply_to }`.
- **CHAT-FR-015**: Edit/delete of a message not owned by the caller (and,
  for delete, caller is not owner) returns `error { code: "forbidden",
  in_reply_to }`.
- **CHAT-FR-016**: Server enforces `content` length ≤ 4000 chars; violating
  requests return `error { code: "message_too_long", in_reply_to }` without
  persisting anything. Client also soft-enforces this in the Composer
  (character counter appears near the limit, hard-blocks submit past it) to
  avoid a round-trip for the common case.
- **CHAT-FR-017**: "Currently viewing/subscribed to a channel" (used to
  scope `chat.message.created`/`chat.typing` broadcast fan-out) is
  determined server-side by the last channel the connection explicitly
  announced via viewing it — in v1 this is simplified to: **every**
  connected community member's connection receives **every** text channel's
  `chat.message.created`/`.edited`/`.deleted` events regardless of which
  channel is currently open in their UI (community is ≤10 people, message
  volume is low, per-channel WS subscription bookkeeping is not worth the
  complexity for v1). `chat.typing`, by contrast, IS scoped narrowly to
  connections whose last-known "viewing" channel matches (typing indicators
  for a channel you're not looking at would be noisy/meaningless, and
  typing volume can be high, so this one op is scoped even though message
  events are not — client informs the server of the current channel via
  the existing `chat.typing` payload's `channel_id` plus an implicit
  per-connection "last channel context" the server tracks from the most
  recent `chat.typing` or `chat.message.create` on that connection; no
  separate `chat.channel.viewing` op exists in v1). Document this asymmetry
  explicitly — it is a deliberate v1 simplification, not an inconsistency
  to fix.
- **CHAT-FR-018**: Client only renders live `chat.message.created` events
  into `MessageList` for the currently-open channel (filtering the broadcast
  client-side per CHAT-FR-017); events for other channels are dropped
  (no unread-badge counting mechanism in v1 beyond what presence/voice
  already surface — chat unread badges are a future consideration).

## Non-functional requirements

- **CHAT-NFR-001**: `chat.message.create` round-trip (send → echo received
  by sender) p95 < 300ms on a healthy connection to a same-region server
  (excludes actual internet latency to a self-hosted box far from the
  user, which is out of the app's control).
- **CHAT-NFR-002**: `GET /channels/{id}/messages` p95 < 150ms for a 50-row
  page against a channel with up to 100k messages (indexed on
  `(channel_id, created_at)`).
- **CHAT-NFR-003**: Client never blocks the input field while a send is in
  flight — multiple messages can be pending concurrently, each tracked by
  its own `req_id`.
- **CHAT-NFR-004**: `chat.typing` broadcast fan-out must not noticeably
  degrade `chat.message.create` latency even if multiple users type
  simultaneously (typing events are cheap, unbounded-frequency-bounded by
  the 3s client debounce).
- **CHAT-NFR-005**: Message history scroll-back (pagination) must not
  re-fetch already-loaded pages (client caches loaded ranges per channel
  for the session's lifetime, cache cleared only on app restart).
- **CHAT-NFR-006**: Soft-deleted message content must never be sent to any
  client after deletion, including no leakage via edit/delete broadcast
  payloads (verified explicitly in tests, see Testing).

## UX behavior

- New channel with no messages: `MessageList` shows a centered empty state
  ("Este é o início do canal #{name}." + channel topic if set), no
  pagination controls.
- Message send in flight: message renders at full opacity immediately
  (optimistic) with a small clock/pending glyph near the timestamp slot;
  no visual "greying out" that would make the UI feel laggy — the pending
  indicator is subtle.
- Message send failed: message renders with a red-tinted left border or
  background tint (using the palette's danger red `#d0625c`) and an inline
  "Falha ao enviar · Tentar novamente" action.
- Editing: clicking edit on your own message turns that message's body
  into an inline editable text field (not a modal), pre-filled with current
  content, Enter to save / Escape to cancel; while the edit request is in
  flight the field is disabled with the same pending treatment as new
  sends.
- Deleting: requires a confirm step (small inline "Excluir esta mensagem?
  Sim / Cancelar" affordance, not a full modal dialog) to avoid accidental
  destructive taps; once confirmed and the server confirms, the message is
  removed from the list with a brief collapse animation (no "message
  deleted" tombstone placeholder — it simply disappears, matching
  CHAT-FR-004's payload not including content).
- Edited messages show a small "(editado)" label in muted text next to the
  timestamp, permanently (no way to see edit history in v1).
- Typing indicator renders as a small line below the message list / above
  the composer: "Fulano está digitando…" (single typer), "Fulano e Ciclano
  estão digitando…" (two), "Várias pessoas estão digitando…" (three+).
- Composer: multi-line grows up to a max height then scrolls internally;
  Enter sends, Shift+Enter inserts newline; attach button opens file picker
  (see `specs/attachments.md`).

## UI states

- `MessageList`: loading (initial history fetch — rendered as a
  bottom-anchored **skeleton** sized to the channel's last-known message
  count, persisted per channel in `localStorage` as `tk.msgCount.<id>`, not
  a spinner/flash), loaded, loading-more (scrolled to top, fetching older
  page), empty, error (history fetch failed — shows retry button, distinct
  from the "empty" state). The skeleton shows only on the **first** visit to
  a channel per session: re-entering a channel already hydrated restores its
  message list from the in-session per-channel cache (CHAT-NFR-005)
  instantly and re-fetches silently in the background, so channel-switching
  never flashes a loading state. The `chat.history` IPC payload carries
  `channel_id` so a slow reply for a channel the user already left updates
  only that channel's cache, never the visible list.
- Individual message: normal, pending, failed, editing, delete-confirming,
  edited (badge), deleted (never rendered — removed from list).
- Composer: idle, disabled (channel not yet loaded / not connected —
  see `flows/reconnect.md` for the disconnected-banner interaction), over
  character limit.

## API contracts

```
GET /channels/{channel_id}/messages?before={uuid|omitted}&limit={1..100, default 50}
200 -> {
  messages: [Message],   // descending created_at, oldest-to-newest reversed by client for display
  has_more: bool
}
Message = {
  id, channel_id, author: { id, username, display_name, avatar_color },
  content, created_at, edited_at: string|null,
  attachments: [Attachment]
}
```

## WebSocket events

```
chat.message.create (C->S)  { req_id, channel_id, content, attachment_ids?: [uuid] }
chat.message.created (S->C broadcast) { message: Message, in_reply_to: req_id|null }

chat.message.edit (C->S)    { req_id, message_id, content }
chat.message.edited (S->C broadcast) { message_id, content, edited_at, in_reply_to: req_id|null }

chat.message.delete (C->S)  { req_id, message_id }
chat.message.deleted (S->C broadcast) { message_id, channel_id, in_reply_to: req_id|null }

chat.typing (bidi, ephemeral) { channel_id }   // C->S has no req_id; S->C broadcast adds user_id
  S->C: { user_id, channel_id }
```
Errors use the generic envelope: `{ op: "error", data: { code, message,
in_reply_to } }` with codes `channel_not_found`, `wrong_channel_kind`,
`forbidden`, `message_too_long`, `not_found` (edit/delete of a nonexistent
or already-deleted message id).

## IPC contracts

None beyond the generic native-hosted WebSocket connection the UI already
uses (chat ops ride the same WS the native host may proxy — see
`../09-websocket-protocol.md` and `contracts/ipc-native-ui.md` for whether
the WS connection lives in the WebView2 JS context directly or is proxied
through the C# host; this spec assumes the JS layer holds the WS connection
directly per the architecture doc, chat has no additional native surface).
Desktop notifications for messages received while the app is unfocused are
specified in `specs/notifications.md`, not here.

## Data model

Per canon §7: `messages`, `reactions` (schema present, unused by UI in v1).
One additive column beyond the original canon schema, added to make
CHAT-FR-012's same-req_id retry safe: `messages.client_req_id TEXT`, with a
partial unique index on `(channel_id, author_id, client_req_id) WHERE
client_req_id IS NOT NULL` — see `migrations/0002_message_idempotency.sql`
and `27-decisions.md` ADR-004.

## State transitions

Message lifecycle (server-side): `created` → optionally `edited` (any
number of times, in place) → optionally `deleted` (terminal, soft). Client
optimistic-send lifecycle: `pending` → (`confirmed` | `failed`); `failed` →
`pending` (on retry, **same** `req_id` — see CHAT-FR-012) → (`confirmed` |
`failed`).

## Concurrency model

- Message create/edit/delete are single-row INSERT/UPDATE statements; no
  transactions needed beyond default per-statement atomicity.
- Broadcast fan-out (CHAT-FR-017): server iterates all currently-authenticated
  WS connections for the community (a `HashMap<ConnectionId, ConnSender>`
  guarded by the connection registry already needed for presence) and
  pushes the event to each; typing events additionally filter by each
  connection's last-known viewed channel_id (a field on connection state,
  updated non-transactionally, last-write-wins — races here are harmless,
  worst case a stray typing indicator shows briefly or is delayed one
  event).
- No per-channel actor/lock needed: Postgres row-level atomicity is
  sufficient since there's no multi-step invariant to protect beyond what
  a single INSERT/UPDATE guarantees.

## Security considerations

- Server re-validates author identity from the authenticated connection's
  `UserId` (from the session, set at `auth.ok` time) for every
  create/edit/delete — never trusts a client-supplied author/user id in
  the payload.
- `content` is stored and transmitted as plain text; the client is
  responsible for safe rendering (no `dangerouslySetInnerHTML` on raw
  content — the markdown-lite renderer (CHAT scope) must escape HTML
  entities before applying bold/italic/code substitutions, preventing
  script injection via chat messages). Document this explicitly in
  `../16-security.md` cross-reference: chat content is untrusted input
  rendered client-side, treated as XSS-relevant even in a trusted 10-person
  community, because a compromised or malicious peer account should not be
  able to run script in another member's client.
- Message length cap (4000) prevents trivial DoS via giant payloads.

## Failure modes

- WS disconnected while composing: Composer remains usable (user can keep
  typing) but Send is disabled with a tooltip/inline note; see
  `flows/reconnect.md` for the banner. Any message "sent" while
  disconnected never leaves the client — the Send action itself is
  disabled, not silently queued (v1 has no offline outbox).
- Server-side validation failure (too long, wrong channel kind, etc.):
  `error` event with matching `in_reply_to`; client marks that specific
  pending message `failed` with the specific reason surfaced in the retry
  tooltip when helpful (e.g. "Mensagem muito longa" vs a generic "Falha ao
  enviar").
- Editing a message that was deleted by an owner in the meantime: server
  returns `error { code: "not_found" }`; client shows a toast "Esta
  mensagem não existe mais." and removes the (stale) message from the local
  list.

## Recovery behavior

- On WS reconnect (see `flows/reconnect.md`), the client re-fetches the
  currently-open channel's most recent page via `GET
  /channels/{id}/messages` (no `before` param) and reconciles: any locally
  pending/failed messages from before the disconnect remain in their
  pending/failed state (never silently dropped) and are re-attempted only
  on explicit user retry, never automatically resent (avoids accidental
  duplicate sends if the original actually did succeed server-side before
  the disconnect — the user can visually check history to see if it
  arrived before retrying, since the fresh history fetch will show it if it
  did, at which point the client de-duplicates the optimistic entry against
  the newly-fetched real message by matching author+content+near
  timestamp... — practically, simplest correct rule: on reconnect, if a
  pending message's content+channel now appears in the freshly fetched
  history authored by the current user within the last 30 seconds, treat it
  as confirmed and drop the optimistic duplicate; otherwise leave it
  pending/failed for manual retry).
- Typing indicators are never restored after reconnect (ephemeral by
  definition; simply resume producing/consuming new ones).

## Telemetry

Server logs message create/edit/delete at `info` (ids only, never
`content`, to keep logs low-sensitivity even though content isn't
cryptographically secret — reduces log volume/PII surface per
`../24-observability.md`). Client-side: count of failed sends per session
surfaced only in local diagnostics, no remote telemetry backend in v1.

## Testing

- Unit: markdown-lite renderer escapes HTML before applying bold/italic/
  code (XSS regression test with `<script>` content); message grouping
  time-window logic; typing-indicator expiry timer.
- Integration: create/edit/delete round-trip incl. broadcast to a second
  connected client; edit/delete by non-author rejected; message length
  cap enforced; soft-deleted messages excluded from `GET .../messages` and
  their content never appears in `chat.message.deleted` payload; pagination
  `before` cursor correctness.
- Manual/E2E: send while offline is blocked, not silently queued;
  reconnect reconciliation does not duplicate a message that actually sent
  before the drop; two clients typing simultaneously show the correct
  "estão digitando" plural copy.

## Acceptance criteria

- A sent message appears for all connected members within CHAT-NFR-001's
  latency budget on a healthy connection.
- A failed send is clearly distinguishable from a pending one and is
  retryable without retyping.
- Only the author (or the owner, for delete) can edit/delete a message;
  enforced server-side regardless of client UI state.
- Deleted message content is never observable by any client after
  deletion, including ones that had it loaded before the delete.
- Typing indicators never persist/replay after a reconnect or across
  channel switches.

## Dependencies

- `specs/auth.md` for identity on every op.
- `specs/channels.md` for channel existence/kind validation.
- `specs/attachments.md` for `attachment_ids` resolution.
- `specs/presence.md` / connection registry for broadcast fan-out plumbing.
- `flows/reconnect.md` for reconnection reconciliation behavior.

## Future considerations

- Unread-message badges/counters per channel.
- Message search.
- Reactions UI (backing table already exists).
- Threaded replies.
- Offline outbox (queue sends made while disconnected).
- Per-channel WS "viewing" subscription to narrow `chat.message.created`
  fan-out the same way `chat.typing` is already narrowed, if channel/message
  volume ever grows enough to matter.
