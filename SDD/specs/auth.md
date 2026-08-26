# Auth — Specification

Status: Draft v1
Owner/Domain: Backend (server/src/auth/*), Client native (client/native/*/Auth), Client UI (client/ui/src/features/auth)
Related canon sections: §7 (schema), §8 (auth decisions), §9 (ID catalog)

## Objetivo

Provide username+password authentication for a fixed, invite-only community
of ~10 people, issuing a long-lived opaque session token that both the REST
API and the WebSocket connection accept, without building any of the
infrastructure (email verification, OAuth, self-signup, MFA) appropriate to a
public product.

## Contexto

Talkeando is a single-deployment private app. There is no public registration
funnel: the first user (community owner) is created out-of-band via a server
bootstrap CLI, and every subsequent user joins via an invite code created by
an existing member. Sessions must survive app restarts (users should not have
to log in every time they open the desktop client) but must be revocable
(logout, or an admin-initiated revoke in a future version).

## Escopo

- POST `/auth/register` (invite-code gated)
- POST `/auth/login`
- POST `/auth/logout`
- Session token issuance, storage (server: hash only), verification
- `auth.hello` / `auth.ok` / `auth.rejected` WebSocket handshake
- Client-side secure token persistence (Windows DPAPI)
- Server bootstrap CLI (`server --bootstrap-owner`)
- Rate limiting on login
- Session sliding-expiration refresh

## Fora de escopo

- OAuth / SSO / social login — not needed for a 10-person private deployment.
- Email verification or password reset via email — no mail server in v1; a
  future version may add an admin-assisted password reset endpoint, not a
  self-service email flow.
- Multi-factor authentication.
- Cross-device session listing/management UI (sessions table supports it,
  no UI in v1 — record as deferred).
- CSRF tokens (see Security considerations — reasoning recorded, not a gap).

## User stories

- As the community owner, I run `server --bootstrap-owner` once on first
  deploy to create my own account without needing an invite.
- As the owner, I generate an invite code so a friend can create an account.
- As a new user, I register with an invite code, username, display name, and
  password, and I'm immediately logged in.
- As a returning user, I open the desktop app and it silently reuses my saved
  session — I only see the login screen if the session was revoked or
  expired.
- As a user, I can explicitly log out, which invalidates my session both
  locally and on the server.
- As an attacker who does not have a valid invite code, I cannot create an
  account no matter how many times I try.

## Functional requirements

- **AUTH-FR-001**: `POST /auth/register` accepts `{ invite_code, username,
  display_name, password }`. Rejects with `409 username_taken` if the
  username already exists (case-insensitive uniqueness).
- **AUTH-FR-002**: Registration validates the invite code exists, is not
  expired (`expires_at` null or in the future), and has remaining uses
  (`max_uses` null or `uses < max_uses`). On success, increments
  `invites.uses` and inserts a `community_members` row with
  `role = 'member'` for the sole seeded community.
- **AUTH-FR-003**: Username constraints: 3–24 chars, `[a-z0-9_]`, lowercased
  on write; `display_name`: 1–32 chars, arbitrary Unicode (validated non-empty
  after trim).
- **AUTH-FR-004**: Password constraints: minimum 8 characters. No maximum
  beyond a sane 256-char cap (prevents hashing abuse). No composition rules
  (length is the dominant factor with Argon2id).
- **AUTH-FR-005**: Passwords are hashed with Argon2id (`argon2` crate),
  parameters: memory 19 MiB (19456 KiB), iterations 2, parallelism 1 (OWASP
  2023 baseline for interactive login on modest server hardware) — encoded
  in the PHC string format stored in `users.password_hash`, so parameters can
  change later without a migration.
- **AUTH-FR-006**: `POST /auth/login` accepts `{ username, password }`,
  verifies against `password_hash`; on success creates a new `sessions` row
  and returns `{ token, user: { id, username, display_name, avatar_* } }`.
  The raw `token` is returned exactly once and never again.
- **AUTH-FR-007**: On login failure (unknown username OR wrong password) the
  response is identical: `401 { code: "invalid_credentials" }` — no
  distinction that would let an attacker enumerate valid usernames.
- **AUTH-FR-008**: Session token = 32 random bytes from a CSPRNG
  (`rand::rngs::OsRng`), base64url-encoded (no padding) for transport. Server
  stores only `SHA-256(token)` in `sessions.token_hash` (unique index). The
  raw token is never persisted anywhere server-side, never logged.
- **AUTH-FR-009**: Session `expires_at` is set to `now + 30 days` at creation
  and refreshed (slid forward to `now + 30 days`) on every authenticated
  request/WS message, but at most once per 5 minutes per session (avoid a
  write on every single message) — the in-memory/last-refresh timestamp is
  tracked per WsConn in the connection state to throttle refresh writes; REST
  requests refresh eagerly on any successful auth check subject to the same
  5-minute floor tracked via `sessions.updated_at` (add this column; if
  omitted from canon §7, treat as an additive column, not a schema
  contradiction) compared against `now`.
- **AUTH-FR-010**: `POST /auth/logout` (Bearer-authenticated) sets
  `sessions.revoked_at = now()` for the presented token's session. Revoked or
  expired sessions fail all subsequent auth checks with `401
  session_invalid`.
- **AUTH-FR-011**: REST endpoints requiring auth read `Authorization: Bearer
  <token>`; server hashes the presented token and looks up
  `sessions.token_hash`, checking `revoked_at IS NULL AND expires_at > now()`,
  joining to `users` for the identity.
- **AUTH-FR-012**: WebSocket auth: immediately after WS upgrade, the client
  MUST send `auth.hello { data: { token } }` as the first frame. The server
  gives a grace period of 5 seconds to receive it; if not received, the
  server closes the socket with code 4001 (`auth_timeout`). On a valid token,
  server replies `auth.ok { data: { user, session_expires_at } }` and attaches
  the `UserId`/`ConnectionId` to connection state; the connection is now
  eligible for `presence.snapshot`. On an invalid/expired/revoked token,
  server replies `auth.rejected { data: { code: "session_invalid" } }` then
  closes the socket (code 4003).
- **AUTH-FR-013**: `server --bootstrap-owner --username <u> --password <p>
  --display-name <d>` CLI command creates the single seeded `communities` row
  if none exists, creates the user, and inserts `community_members` with
  `role = 'owner'`. Refuses to run (exits non-zero, no-op) if any user
  already exists in the database — this is a one-time bootstrap, not a
  general admin-create-user tool.
- **AUTH-FR-014**: Invite creation `POST /invites` (Bearer-authenticated,
  any community member — v1 does not restrict invite creation to owners,
  since it's a 10-person trusted group; document as explicit scope choice)
  accepts `{ max_uses: Option<int>, expires_in_seconds: Option<int> }` and
  returns `{ code, expires_at }`. `code` is a random 10-char base32 string,
  unique.

## Non-functional requirements

- **AUTH-NFR-001**: Login endpoint rate-limited per `(ip, username)` tuple:
  10 attempts/minute, fixed window, in-memory (per canon §12 single-process
  constraint, no distributed rate-limit store needed). Exceeding it returns
  `429 { code: "rate_limited", retry_after_seconds }`.
- **AUTH-NFR-002**: Argon2id verification must complete in <500ms p95 on
  reference deployment hardware (the whole point of Argon2 is to be
  deliberately slow; 500ms is a UX ceiling, not a security target — tune
  memory/iteration cost to stay under it).
- **AUTH-NFR-003**: Session tokens must never appear in server logs
  (tracing spans must redact/omit the `token` field; use `tracing::field
  = %"[redacted]"` or skip the field entirely in `#[instrument(skip(token))]`).
- **AUTH-NFR-004**: The client persists the token via
  `System.Security.Cryptography.ProtectedData.Protect` with
  `DataProtectionScope.CurrentUser`, written to a file under
  `%LOCALAPPDATA%\Talkeando\session.dat`. The file is never written in
  plaintext at any point (encrypt in memory, then write).
- **AUTH-NFR-005**: All auth endpoints and the WS handshake are served only
  over TLS in any non-localhost deployment (enforced at the Caddy layer, not
  the Axum app — document that Axum itself does not distinguish; localhost
  dev may run plain HTTP).
- **AUTH-NFR-006**: Time to first authenticated `presence.snapshot` after a
  cold app launch with a valid cached session: <2s on a reasonable home
  connection (p95), excluding TURN credential fetch which is async and does
  not block presence.

## UX behavior

- App launch: if a token file exists and DPAPI-unprotects successfully, the
  client attempts silent login via WS `auth.hello` (no REST round-trip
  needed to "check" the token first — the WS handshake result IS the check).
  While waiting, show the app shell with a subtle "Conectando…" state on the
  server rail; do not show the login screen yet (avoid flicker for the
  common case).
- If `auth.rejected` is received, or no token file exists, or DPAPI
  unprotect fails (e.g. token file copied to another machine — DPAPI is
  machine+user bound and will fail to decrypt), show the Login screen.
- Login screen: username + password fields, "Entrar" button, and a "Tenho um
  convite" (I have an invite) link that reveals a registration form
  (invite code, username, display name, password, confirm password).
- Login failure shows a single generic inline error: "Usuário ou senha
  inválidos." No field-specific error (avoid username enumeration in the UI
  too).
- Rate-limited login shows: "Muitas tentativas. Tente novamente em {N}s."
  with a live countdown, button disabled until it elapses.
- Successful login/registration stores the token (DPAPI) and transitions to
  the main app shell, triggering `connect-websocket` flow.
- Logout (from UserPanel menu) clears the local token file, closes the WS
  connection, calls `POST /auth/logout`, and returns to the Login screen.
  Order matters for correctness under flaky network: clear local token and
  close the socket first (so the app is immediately "logged out" from the
  user's perspective even if the network call fails), then best-effort call
  `/auth/logout` (fire-and-forget with one retry; a session that never gets
  server-side revoked simply expires naturally after 30 days of disuse — not
  a security incident for a trusted 10-person deployment, but still attempt
  it for hygiene).

## UI states

- Loading/connecting (silent relogin in progress).
- Login form (idle, submitting, error, rate-limited).
- Registration form (idle, submitting, invalid-invite error, username-taken
  error, weak-password inline validation).
- Logged in (normal app shell).

## API contracts

```
POST /auth/register
Request: { invite_code: string, username: string, display_name: string, password: string }
201 -> { token: string, user: { id: uuid, username, display_name, avatar_color } }
400 -> { code: "invalid_invite" | "invalid_username" | "weak_password" }
409 -> { code: "username_taken" }

POST /auth/login
Request: { username: string, password: string }
200 -> { token: string, user: {...}, session_expires_at: string(RFC3339) }
401 -> { code: "invalid_credentials" }
429 -> { code: "rate_limited", retry_after_seconds: int }

POST /auth/logout
Headers: Authorization: Bearer <token>
204 -> (no body)
401 -> { code: "session_invalid" }

POST /invites
Headers: Authorization: Bearer <token>
Request: { max_uses: int | null, expires_in_seconds: int | null }
201 -> { code: string, expires_at: string | null }
```
Full JSON Schemas live in `protocol/` per canon; this file is the normative
prose description they must match.

## WebSocket events

- `auth.hello` (C→S): `{ v:1, op:"auth.hello", data:{ token: string,
  req_id: string } }`
- `auth.ok` (S→C): `{ v:1, op:"auth.ok", data:{ user, session_expires_at,
  in_reply_to: req_id } }`
- `auth.rejected` (S→C): `{ v:1, op:"auth.rejected", data:{ code:
  "session_invalid"|"auth_timeout", in_reply_to: req_id|null } }` followed by
  WS close.

See `flows/login.md` and `flows/connect-websocket.md` for the full sequence
including reconnect semantics.

## IPC contracts

- Native→UI: `auth.state_changed { state: "logged_out"|"connecting"|
  "logged_in", user? }` pushed whenever the C# host's session state changes
  (e.g. detects DPAPI failure at launch).
- UI→Native: `auth.persist_token { token }` (only sent right after a
  successful login/registration REST call — the UI never reads the token
  back, write-only) and `auth.clear_token {}` on logout.
- Rationale: the raw token touches JS memory only transiently during
  login/registration response handling before being handed to the native
  host for DPAPI storage; the native host is the only long-term holder of
  the plaintext token, and it also owns opening the WebSocket, so the token
  need not be re-exposed to the UI layer afterward. See
  `contracts/ipc-native-ui.md`.

## Data model

Per canon §7: `users`, `sessions`, `invites`, `community_members`. This spec
adds one additive column beyond the literal canon listing:
`sessions.updated_at timestamptz not null default now()` — tracks last sliding
refresh, used purely to throttle refresh writes (AUTH-FR-009); does not
change any decided column, purely additive bookkeeping.

## State transitions

Session states: `active` → (`revoked` | `expired`). Both are terminal;
re-authentication always creates a brand-new session row (never resurrect a
revoked/expired one). See `../state-machines/` (owned by the other writer)
for the formal diagram; this spec's prose above is the authoritative
transition list it must match.

## Concurrency model

- Login/register/logout are stateless REST handlers over the connection
  pool; no in-process shared mutable state beyond the rate limiter.
- Rate limiter: a `DashMap<(IpAddr, String), RateWindow>` (or equivalent
  `tokio::sync::Mutex<HashMap<...>>`) guarded appropriately; entries are
  lazily swept (on access, drop windows older than 60s) rather than run on a
  background timer, to keep it simple for a 10-user deployment.
- WS auth handshake is per-connection, no cross-connection shared state
  except the eventual registration into the presence roster, which happens
  strictly after `auth.ok` is decided.

## Security considerations

- Argon2id chosen over bcrypt/scrypt (memory-hard, resistant to GPU
  cracking, current OWASP recommendation).
- Token is high-entropy (256 bits), unguessable; only its hash is stored, so
  a database leak does not expose usable session tokens (attacker would
  still need to find a SHA-256 preimage, infeasible).
- No CSRF protection is implemented, and this is intentional, not an
  oversight: the API is a Bearer-token JSON API. Bearer tokens are never
  auto-attached by the browser/WebView2 the way cookies are — every request
  explicitly sets the `Authorization` header from application code that
  already possesses the token, so there is no confused-deputy vector for a
  third-party page to ride the user's session. Full reasoning duplicated in
  `../16-security.md` (SEC-NFR ownership lives there).
- Generic error messages prevent username enumeration via login.
- Invite codes are single-purpose capability tokens: possession = ability to
  register once (or up to `max_uses` times); they are not secrets tied to
  any particular invitee identity, consistent with a trusted-friend-group
  distribution model (shared via any out-of-band channel, e.g. a text
  message).
- DPAPI `CurrentUser` scope means a copied token file is useless on another
  machine or under another Windows account — this is the client-side
  equivalent of "don't store secrets in plaintext," not a replacement for
  server-side revocation.

## Failure modes

- Invite code invalid/expired/exhausted → `400 invalid_invite`; UI shows
  "Convite inválido ou expirado."
- Username taken → `409`; UI shows inline field error on the username field
  specifically (this one IS safe to disclose — the user is actively trying
  to pick a name, not probing for existing accounts).
- Login with valid username, wrong password N+1 times inside the window →
  `429` after the 10th attempt.
- WS `auth.hello` never arrives within 5s → server closes with 4001; client
  treats this the same as a rejected session (falls back to Login screen)
  and logs a diagnostic locally.
- Server database unreachable during login → `503 { code:
  "service_unavailable" }`; UI shows "Não foi possível conectar ao
  servidor. Tentando novamente…" and the login button re-enables for retry
  (no automatic retry loop on the login form itself — user-initiated retry
  only, unlike the always-on WS reconnect loop used post-login).

## Recovery behavior

- Expired/revoked session detected (REST 401 or WS `auth.rejected` with
  `session_invalid`): client clears the local token file (it's dead weight)
  and shows Login. This is the only path that proactively deletes the
  stored token — a transient network failure must never delete it.
- A session nearing its 30-day expiry that keeps being used never prompts
  the user; sliding refresh (AUTH-FR-009) means an actively-used app never
  expires in practice. Only a genuinely idle app (closed for 30+ days) hits
  expiry.

## Telemetry

- Server logs (structured, via `tracing`): login success/failure (username,
  outcome, NOT password/token), registration success/failure, rate-limit
  triggers, bootstrap-owner invocations. All at `info` for success, `warn`
  for failures/rate-limits.
- No client-side analytics telemetry in v1 (no telemetry backend specified
  in canon); local structured logs only, per `../24-observability.md`
  (owned elsewhere) for the logging pipeline shape.

## Testing

- Unit: Argon2 hash/verify round-trip; token generation entropy/format;
  username/password validators; rate-limiter window math.
- Integration (server, against a real Postgres test DB): register with
  valid/invalid/exhausted invite; duplicate username; login
  success/failure/rate-limited; logout revokes session; WS `auth.hello`
  happy path and timeout path; bootstrap CLI refuses on non-empty DB.
- Manual/E2E: cold launch with valid cached session reaches app shell
  without showing login flicker; DPAPI failure path (simulate by corrupting
  the token file) falls back to login cleanly; logout truly ends the
  session (verify a captured old token is rejected after logout).

## Acceptance criteria

- A user cannot register without a valid, non-exhausted, non-expired invite
  code.
- A user cannot log in with a wrong password, and the error message does
  not differ based on whether the username exists.
- A raw session token is never present in the Postgres database or in any
  log line.
- Logging out on device A causes a subsequent REST call using device A's
  old token to fail with 401 immediately.
- A valid cached session on app relaunch reaches `auth.ok` and
  `presence.snapshot` without the user seeing a login screen.
- `server --bootstrap-owner` run twice (against a DB that already has a
  user) fails loudly on the second run and creates nothing.

## Dependencies

- Postgres schema migrations (phase-02) for `users`, `sessions`, `invites`,
  `community_members`.
- WebSocket upgrade handler skeleton (phase-02) for `auth.hello` routing.
- Client native DPAPI wrapper (phase-03).
- `../09-websocket-protocol.md`, `../16-security.md`, `../contracts/rest-api.md`.

## Future considerations

- Cross-device session management UI (list/revoke individual sessions).
- Admin-assisted password reset endpoint.
- Per-invite-code creator restriction (owner-only) if the trust model
  changes beyond "10 friends."
- Optional MFA (TOTP) if the deployment ever grows beyond a fully-trusted
  friend group.
