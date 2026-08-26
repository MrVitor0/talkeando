# Máquina de estado — WebSocket

`disconnected → connecting → authenticating → online → reconnecting`.

- `connecting → authenticating`: socket abriu.
- `authenticating → online`: `auth.ok` + `presence.snapshot`.
- `authenticating → disconnected`: timeout ou `auth.rejected`.
- `online → reconnecting`: close/erro de transporte.
- `reconnecting → connecting`: timer de retry.
- `reconnecting → disconnected`: usuário encerra sessão ou retries esgotam.

Frames fora de `auth.hello` durante `authenticating` são inválidos; UI não
envia mutações enquanto não está `online`.
