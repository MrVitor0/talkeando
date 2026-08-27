# Talkeando

Discord-style private voice/text/screen-share app for a ~10-person
community. Rust backend, C#/WPF+WebView2 native Windows client, React UI.
See `SDD/` for the full design; `SDD/31-implementation-status.md` for
exactly what's implemented vs. still pending.

**This file did not exist until now** — everything below has been run for
real this session, but nobody has yet followed these exact steps start to
finish in one uninterrupted pass. If a step doesn't work as written, that's
a real gap, not a formality; say what broke.

## Prerequisites

Already confirmed present on this machine:
- Rust (`cargo`) — backend
- .NET 6 SDK — native client (targets `net6.0-windows10.0.19041.0`)
- Node.js + npm — React UI
- Docker — for a local Postgres (and optionally coturn)

## 1. Start Postgres

```
cd infra
docker compose up -d postgres
```

This uses the credentials already in `docker-compose.yml`
(`talkeando`/`talkeando`, database `talkeando`), exposed on host port
**5434** (not Postgres's usual 5432 — picked to avoid colliding with a
Postgres someone might already have running locally for something else,
which was in fact the case on the machine this was written on). If 5434 is
also taken, change the port mapping in `infra/docker-compose.yml` and
`server/.env`'s `DATABASE_URL` together.

## 2. Configure and start the backend

```
cd server
cp .env.example .env
```

Edit `.env` if you want, but the defaults work for local testing as-is
(`DATABASE_URL` already points at the compose Postgres above). Then:

```
cargo run --bin talkeando-server -- bootstrap-owner --username alice --password alicepass123 --display-name Alice
```

This creates the one community this instance serves, a `general` text
channel, a `voice` channel, and the owner account (`alice`/`alicepass123`).
It also prints the community id — you won't need it for anything below.
**Run this exactly once** — it refuses to run again once a community
exists.

Now start the server for real (this also runs pending migrations
automatically):

```
cargo run --bin talkeando-server
```

Leave this running. It listens on `127.0.0.1:8080` by default
(`BIND_ADDR` in `.env`).

To create a second account (e.g. "bob") to actually test voice/chat/screen
share between two people, first mint an invite as alice:

```
curl -X POST http://127.0.0.1:8080/api/auth/login -H "Content-Type: application/json" -d "{\"username\":\"alice\",\"password\":\"alicepass123\"}"
```

Copy the `token` from the response, then:

```
curl -X POST http://127.0.0.1:8080/api/invites -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d "{}"
```

That returns a `code` — that's the invite code bob's client will use to
register.

## 3. Build the React UI

```
cd client/ui
npm install
npm run build
```

This produces `client/ui/dist/`, which the native client project embeds
directly (`Talkeando.Client.csproj` copies `../../ui/dist/**` into its own
output as `ui/`). **Rebuild this after every UI change** — the native
client does not run a dev server, it loads the built `index.html` from
disk.

## 4. Build and run the native client

```
cd client/native/Talkeando.Client
dotnet build
dotnet run
```

No environment variables needed for local testing — `NetworkClient`
defaults to `http://localhost:8080/api` and `ws://localhost:8080/ws` when
`TALKEANDO_API_BASE_URL`/`TALKEANDO_WS_URL` aren't set (see
`client/.env.example` for how to point at a different backend).

Log in as `alice`/`alicepass123`.

## 5. Testing with two accounts on one machine

### The shortcut: `dev.cmd`

From the repo root:

```
dev
```

(or `.\dev.cmd`, or `powershell -File scripts\dev.ps1`). It creates
`server/.env` if missing, builds and `bootstrap-owner`s the server
(idempotent), starts it in its own window, mints an invite and registers
`bob` if he doesn't exist yet, builds the React UI, then opens **two
client windows**, one with `TALKEANDO_PROFILE=alice` and one with `=bob`.
Log the alice window in as `alice`/`alicepass123` and the bob window as
`bob`/`bobpass123`.

**Database:** `dev.cmd` reads `server/.env`'s `DATABASE_URL`. The
checked-in default is the shared/managed database — no Docker needed, and
`bootstrap-owner`/migrations run against it directly. Only if you point
`DATABASE_URL` back at `@localhost:5434` does the script start (and need)
the compose Postgres. The Rust server also forces `search_path = public`
on every connection so migrations work through a managed Postgres pooler
(Neon etc.). `cargo test` is unaffected — it uses its own
`TEST_DATABASE_ADMIN_URL` (local by default), never `DATABASE_URL`.

The stack binds **port 8090**, not 8080 — 8090 is far less likely to
collide with another dev server, and `dev.cmd` rewrites `server/.env`'s
`BIND_ADDR` and points both client windows there automatically. The
by-hand steps below still use 8080 (the `.env.example` default); change
`BIND_ADDR` yourself if 8080 is taken.

Flags:

- `dev -Reset` — wipe the local per-profile session/WebView2 folders (and,
  when on the local DB, `docker compose down -v`).
- `dev -SkipUiBuild` — skip `npm run build` (no `client/ui/src` changes
  since last run).
- `dev -NoClients` — bring the backend up and ensure both accounts, but
  don't open the client windows.

The rest of this section is what that script automates, done by hand.

### By hand

You don't need two physical machines to exercise most of this — but you do
need to set `TALKEANDO_PROFILE` per instance, or the two windows will fight
over one shared session file (found the hard way: a second login silently
overwrote the first window's saved token, and REST calls could pick up the
wrong user's bearer token mid-session — see `SDD/27-decisions.md` ADR-006).

Terminal 1:
```
set TALKEANDO_PROFILE=alice
dotnet run
```
Terminal 2 (a second terminal window, same folder):
```
set TALKEANDO_PROFILE=bob
dotnet run
```
(PowerShell: use `$env:TALKEANDO_PROFILE="alice"` instead of `set`.)

Each window's title bar shows its profile name. Log into one as the owner
and register the other with the invite code from step 2 ("Tenho um
convite" on the login screen). Both processes talk to the same local
backend; a voice call or screen share between them is a real P2P
connection over loopback — this validates signaling, mute/deafen, the
publish/subscribe screen-share gating, and the UI end to end.

What this single-machine setup does **not** validate: TURN relay (needs a
real NAT/restrictive-network scenario), and anything specifically about
running on two separate physical Windows installs (driver quirks, a
machine with no microphone, etc.) — see
`SDD/31-implementation-status.md` for exactly what's still pending
real-hardware validation.

## Running the automated tests

Backend (spins up its own throwaway Postgres database per test against
whatever Postgres you point it at — safe to run against the same instance
from step 1):

```
cd server
cargo test
```

Native client (no server or Postgres needed — these are pure logic/DPAPI
tests, see `SDD/testing/unit.md` for exactly what is and isn't covered):

```
cd client/native/Talkeando.Client.Tests
dotnet test
```

## Troubleshooting

- **`bootstrap-owner` says a community already exists**: it already ran
  successfully; don't run it again. Use the invite-code flow (step 2) for
  more accounts.
- **Client can't reach the server**: confirm `cargo run --bin
  talkeando-server` (step 2) is still running in another terminal, and
  that nothing else is bound to port 8080.
- **UI looks stale after a change**: you edited `client/ui/src/*` but
  forgot `npm run build` — the native client only reads the built
  `dist/`, never live source.

## More detail

- `SDD/31-implementation-status.md` — current state, what's verified vs.
  not, what's genuinely still missing for v1.
- `SDD/27-decisions.md` — architecture decisions made (and corrected) with
  the reasoning, including a few real deviations from the original plan
  (e.g. G722 instead of Opus, GDI capture instead of Windows.Graphics.Capture)
  found by actually trying to build against the real libraries.
- `SDD/testing/integration.md` and `SDD/testing/unit.md` — what the
  automated tests actually cover.
