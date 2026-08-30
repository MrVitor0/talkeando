# Implementation — execução em uma passada

Uma única execução autônoma. Faça **todos** os passos abaixo, na ordem
(dependência), e entregue **um commit**. Sem feature flag, sem backend dual, sem
"parar e perguntar". Rode as suítes ao longo do caminho; ao final, tudo verde.

Ordem de alto nível: `infra → protocol/design contracts → server → client/ui →
music-bot → remoção do mesh → testes → docs`. A remoção do mesh acontece na
mesma passada porque o novo caminho já substitui o antigo — não há período de
coexistência.

Suítes de verificação:
- `cd server && cargo test --locked`
- `cd music-bot && npm test`
- `cd client/ui && npm run build`   (roda `tsc -b`)
- `cd client/native/Talkeando.Client && dotnet build`  (se o SDK .NET estiver disponível)

Contratos: **`design.md`**. Requisitos: **`requirements.md`**. Detalhe por
diretório: **`03-changes-by-service.md`**.

---

## Bloco A — Infra (arquivos de config; quem aplica é o humano)

### A1. `livekit.yaml` (template + dev)
- **Req:** SFU-NFR-003, SFU-NFR-004, SFU-NFR-006 · **Contrato:** design §8
- **Arquivos:** `infra/livekit/livekit.yaml.tmpl` (novo),
  `infra/livekit/livekit.dev.yaml` (novo)
- **Fazer:**
  - `livekit.yaml.tmpl` com placeholders `${LIVEKIT_API_KEY}` /
    `${LIVEKIT_API_SECRET}` / `${API_DOMAIN}`, faixa UDP `50000-50200`,
    `turn.enabled: false`, `webhook.urls: [https://${API_DOMAIN}/api/livekit/webhook]`,
    `webhook.api_key: ${LIVEKIT_API_KEY}`, `room.empty_timeout: 300`,
    `room.max_participants: 12`.
  - `livekit.dev.yaml`: key/secret de dev fixos (`devkey` / `devsecret_at_least_32_chars_long`,
    comentar "DEV ONLY"), `webhook.urls: [http://host.docker.internal:8080/api/livekit/webhook]`.
- **Verificar:** `docker run --rm -v $PWD/infra/livekit/livekit.dev.yaml:/c.yaml
  livekit/livekit-server --config /c.yaml` sobe sem erro de config (ou revisão
  manual do YAML).

### A2. Serviço `livekit` nos dois composes
- **Req:** SFU-NFR-003/004 · **Contrato:** 03 §infra
- **Arquivos:** `infra/docker-compose.yml` (dev),
  `infra/docker-compose.production.yml`
- **Fazer:** serviço `livekit` (imagem `livekit/livekit-server:v1.9.x` pinada,
  `restart: unless-stopped`, `--config`, `network_mode: host`, monta o yaml,
  `depends_on: [tupi-server]`). Dev pode mapear portas em vez de `host` se
  preferir (`7880:7880`, `50000-50200:50000-50200/udp`).
- **Verificar:** `docker compose -f infra/docker-compose.production.yml config`
  válido.

### A3. Caddy expõe o LiveKit
- **Arquivos:** `infra/Caddyfile`, `infra/Caddyfile.example`
- **Fazer:** bloco `sfu.{$API_DOMAIN}` → `reverse_proxy localhost:7880`
  (WS + HTTP). Media UDP não passa pelo Caddy.

### A4. coturn: comentar faixa reservada
- **Arquivos:** `infra/coturn/turnserver.conf.example`
- **Fazer:** comentário: `# 50000-50200/udp é do livekit-server — não usar aqui`.

### A5. CI: gerar `livekit.yaml` + carregar env
- **Req:** SFU-NFR-002 · **Contrato:** 03 §infra
- **Arquivos:** `.github/workflows/deploy-production.yml`
- **Fazer:**
  - Novo step "Deploy LiveKit config": `envsubst < livekit.yaml.tmpl` com
    `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` / `API_DOMAIN` do environment
    `production`; escreve `/opt/talkeando/infra/livekit/livekit.yaml` no host
    via SSH (padrão do `music-bot.env`).
  - Incluir `infra/livekit/` no `tar` do "Upload and apply release".
  - `tupi-server` e `music-bot` no compose recebem `LIVEKIT_URL` /
    `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` do env.
  - README/nota lista os Secrets novos (`LIVEKIT_URL`, `LIVEKIT_API_KEY`,
    `LIVEKIT_API_SECRET`) que o humano cria.
- **Verificar:** `actionlint` (ou revisão) sem erro.

---

## Bloco B — Servidor Rust

### B1. Config
- **Req:** SFU-FR-001 · **Contrato:** design §7
- **Arquivos:** `server/src/config.rs`, `server/.env.example`
- **Fazer:** `Config` ganha `livekit_url: Option<String>`,
  `livekit_api_key: Option<String>`, `livekit_api_secret: Option<String>`,
  `livekit_token_ttl_seconds: i64` (default `21600`). Ler em `from_env`.
- **Verificar:** `cargo build`.

### B2. `livekit.rs` — token + verificação de webhook + RoomService
- **Req:** SFU-FR-001/002/003/010/013 · **Contrato:** design §2/§3
- **Arquivos:** `server/Cargo.toml`, `server/src/livekit.rs` (novo),
  `server/src/lib.rs` (`mod livekit;`)
- **Fazer:**
  - Dep: `livekit-api` se houver release estável; senão `jsonwebtoken` +
    `hmac`/`sha2` (o webhook do LiveKit é um JWT HS256 com o api-secret).
  - `pub fn access_token(cfg, identity: &str, name: &str, room: &str, mode: Mode) -> Result<String>`
    montando o claim de design §2 (`video` grant + `sub`/`name`/`exp`/`metadata`).
  - `pub fn verify_webhook(cfg, auth_header: &str, raw_body: &[u8]) -> Result<WebhookEvent>`
    (valida HS256 com o api-secret, desserializa o payload do LiveKit).
  - `pub async fn remove_participant(cfg, room: &str, identity: &str) -> Result<()>`
    (POST na `TwirpService` do LiveKit, `RoomService/RemoveParticipant`, com
    Authorization = token de API).
  - Unit tests: claim tem `video.room` certo; `canPublish` varia por `Mode`;
    `exp` respeita TTL; `verify_webhook` rejeita assinatura errada e aceita a
    certa.
- **Verificar:** `cargo test livekit`.

### B3. Rotas `/api/livekit/{token,webhook}`
- **Req:** SFU-FR-001/002/003/010/011/014 · **Contrato:** design §2/§3
- **Arquivos:** `server/src/routes/livekit.rs` (novo),
  `server/src/routes/mod.rs`
- **Fazer:**
  - `POST /api/livekit/token`: auth `AuthUser` **ou** `MUSIC_BOT_TOKEN` (reusar
    o padrão do `ws/handler.rs`). Body `{ channel_id, mode? }`. Validar canal
    existe + é `voice` + `channel_if_member` (bot dispensa membership). `503` se
    `livekit_url`/keys ausentes. Responder `{ url, room, token }`.
  - `POST /api/livekit/webhook`: `verify_webhook`; despachar por evento conforme
    design §3, chamando os helpers do `ws/handler.rs`
    (`broadcast_voice_roster`, `broadcast_to_community`) e mutando o
    `CallRegistry` (métodos novos — ver B4). `participant_left` deixando só o
    bot ou `room_finished` → `send_to(MUSIC_BOT_ID, music.command stop)` +
    `remove_participant(bot)`.
  - Registrar as rotas em `routes/mod.rs`.
  - `server/tests/livekit_test.rs` (novo): membro → 200 + token decodável com
    `video.room == channel`; não-membro → 403; canal texto → 403; POST webhook
    `participant_joined` fake → `voice.roster` sai com o participante;
    `participant_left` até esvaziar → `music.command stop` para o bot.
- **Verificar:** `cargo test --test livekit_test`.

### B4. `CallRegistry` vira espelho de webhook
- **Req:** SFU-FR-010/011 · **Contrato:** design §3
- **Arquivos:** `server/src/ws/call_registry.rs`, `server/src/ws/hub.rs`
- **Fazer:** adicionar `apply_participant(channel, user_id, joined: bool)`,
  `apply_track(channel, user_id, source, published: bool)`,
  `clear_channel(channel)`. Manter `roster`/`roster_streams`/`participant_ids`/
  `active_channel_ids` (o roster p/ a comunidade continua saindo daqui).
  Remover o que era mutado por op (`join`/`leave`/`publish`/`unpublish`/
  `subscribe`/`unsubscribe` mexidos por `dispatch`) — passo C-remoção. `music_djs`
  sai (a lógica "último humano" agora é no webhook).
- **Verificar:** `cargo build` (testes ajustados no bloco E).

### B5. Bootstrap expõe `livekit_url`; `voice.rooms` continua
- **Req:** SFU-FR-011, SFU-FR-012 · **Contrato:** design §5
- **Arquivos:** `server/src/ws/handler.rs` (envio de `auth.ok`/bootstrap),
  eventualmente `routes/*` se o bootstrap for REST
- **Fazer:** incluir `livekit_url` no payload que o cliente lê ao autenticar.
  `send_voice_rooms_snapshot` continua igual (alimentado pelo `CallRegistry`
  espelho).
- **Verificar:** `cargo test` (presence/auth suites verdes).

### B6. `voice.move_member` / `voice.disconnect_member`
- **Req:** SFU-FR-013
- **Arquivos:** `server/src/ws/handler.rs`
- **Fazer:** `handle_voice_move_member` inalterado (manda `voice.moved`; o alvo
  pede token novo). `handle_voice_disconnect_member`: humano →
  `livekit::remove_participant(cfg, channel, target)`; bot → `music.command stop`
  (igual).
- **Verificar:** `cargo test`.

---

## Bloco C — Cliente UI (React)

### C1. Nova camada de mídia
- **Req:** SFU-FR-020..024, SFU-FR-030..036, SFU-FR-043 · **Contrato:** design §4
- **Arquivos:** `client/ui/package.json` (dep `livekit-client`),
  `client/ui/src/rtc.ts` (**reescrever** — mantém o nome e o conjunto de
  exports que `App.tsx` usa)
- **Fazer:** reimplementar a superfície pública atual de `rtc.ts` sobre
  `livekit-client`. Mapear:
  | export atual | nova implementação |
  |---|---|
  | `init(userId)` | guarda `selfUserId` |
  | `joinCall(channelId, muted, deafened)` | `fetch('/api/livekit/token',{channel_id})` → `new Room({adaptiveStream:true, dynacast:true})` → `room.connect(url, token)` → publica mic (após `noiseSuppression.processMic`) respeitando `muted` |
  | `leaveCall()` | `room.disconnect()` + limpeza dos `<audio>`/sinks |
  | `setLocalAudioState(muted, deafened)` | `setMicrophoneEnabled(!muted)`; deafen = `setSubscribed(false)` nos remote audio ou `RemoteAudioTrack.setVolume(0)` |
  | `startCamera/stopCamera/switchCamera` | `setCameraEnabled` / `publishTrack({source:Camera,simulcast:true})` / `replaceTrack` |
  | `onLocalCamera(cb)` | do track local publicado |
  | `publishScreen/unpublishScreen/reconfigureScreen/switchScreenSource` | captura via `nativeScreen.ts` (inalterado) → `publishTrack(video,{source:ScreenShare,simulcast:true})` + `screen_share_audio` se houver |
  | `watchStream/stopWatchingStream` | `publication.setSubscribed(true/false)` do track `ScreenShare` do dono |
  | `spectate/stopSpectate` | token `mode:"spectator"` (`hidden`), conecta, assina só a tela, desconecta ao sair; fallback de produto se `hidden` não servir (`risks.md#5`) |
  | `onRemoteStream(cb)` | `RoomEvent.TrackSubscribed/Unsubscribed`: `track.attach()` → repassar `MediaStream` + identidade + `pub.source` |
  | `onSpeaking(cb)` | `RoomEvent.ActiveSpeakersChanged` |
  | `onConnectionQuality(cb)` | `RoomEvent.ConnectionQualityChanged` |
  | volume/mute por-peer e por-tela (`setPeerVolume`, `getPeerVolumes`, `setScreenAudioMuted`, `setScreenAudioVolume`, `getScreenAudioVolumes`, ...) | **manter igual**: continua `el.volume`/`el.muted` local nos elementos que `track.attach()` cria, persistido em `tk.peerVolumes` / `tk.screenVolumes` |
  | device getters/setters (`setAudioInputDevice`, `setSinkId`, input/output volume) | manter; aplicar `setSinkId` nos elementos do LiveKit |
  | `noiseSuppression.*` re-exports | inalterado |
  - Sem offer/answer/ICE/glare/`restartIce`/`*Slots`/`*NeedsOffer`/
    `pendingCandidates`/amostragem `getStats`. `RoomEvent.Disconnected/Reconnecting/
    Reconnected` só logam — o LiveKit re-sincroniza.
- **Verificar:** `npm run build` (tsc). Testar contra o LiveKit dev
  (`docker compose up -d livekit`) se possível.

### C2. `App.tsx` — parar de falar com os ops mesh
- **Req:** SFU-FR-012, SFU-FR-050
- **Arquivos:** `client/ui/src/App.tsx`
- **Fazer:**
  - `call`/tiles passam a ser derivados de `rtc.onRemoteStream` +
    `rtc.onParticipant...` (adicionar um `onCallParticipants(cb)` em `rtc.ts` que
    reflete `RoomEvent.ParticipantConnected/Disconnected`). O roster de sidebar
    (`voiceRooms`) continua vindo de `voice.roster`/`voice.rooms` como hoje.
  - Remover os handlers de eventos `call.snapshot` / `call.peer_joined` /
    `call.peer_left` / `rtc.offer` / `rtc.answer` / `rtc.ice` /
    `stream.published` / `stream.unpublished` / `stream.subscription_requested` /
    `stream.unsubscribed` / `music.available`.
  - Remover `nativeMusic.ts` import, exports `playMusic`/`stopMusic`/
    `setMusicPaused`, e o handler `music.command` (caminho DJ-local morto).
  - `joinCall` deixa de mandar `send("call.join", ...)` — só chama `rtc.joinCall`.
  - `leaveCall` deixa de mandar `send("call.leave", ...)`.
- **Arquivos p/ deletar:** `client/ui/src/nativeMusic.ts`.
- **Verificar:** `npm run build`; a UI de call/tiles/volume/assistir/parar
  funciona (teste manual contra o LiveKit dev).

---

## Bloco D — Music-bot

### D1. Publicar no LiveKit
- **Req:** SFU-FR-002/040/041/043 · **Contrato:** design §4 · **Risco:** risks.md#1
- **Arquivos:** `music-bot/package.json`, `music-bot/Dockerfile`,
  `music-bot/index.js`
- **Fazer:**
  - Dep de mídia: `@livekit/rtc-node`. Se **não** compilar no
    `node:20-bookworm-slim`: trocar a base do `music-bot/Dockerfile` para
    `node:20-bookworm` (não-slim) ou a imagem base recomendada pelo LiveKit;
    registrar a escolha num comentário no `Dockerfile`.
  - `join(channelId)` → pede token (`POST /api/livekit/token` com
    `MUSIC_BOT_TOKEN`) → `room.connect(LIVEKIT_URL, token)` → publica **um**
    `AudioSource` (`name: "music"`, `metadata: {"kind":"music"}`) alimentado pelo
    feeder de 10 ms existente (`pushFrame`/`onData`).
  - `leaveVoice()` → `room.disconnect()`.
  - "Sair quando o último humano sai": `room.on(ParticipantDisconnected)` +
    contar não-bots; ou reagir ao `music.command stop` que o servidor manda no
    webhook `participant_left`.
  - **Remover** (mesma passada): `peer` / `offer` / `newMusicTrack` /
    `musicSource` compartilhado / `iceServers` / `restartPeerIce` /
    `iceRestartTimers` / o handling `rtc.offer|answer|ice` / o reconcile de
    `call.snapshot` / o re-anúncio em `auth.ok`.
  - `music.command` / `music.status` / `MusicStatusReporter` / fila / provider
    chain / yt-dlp/ffmpeg / scorer: **inalterados**.
  - `package.json`: remover `@roamhq/wrtc`.
- **Verificar:** `npm test` — reescrever `test.js`: o stub de `wrtc` vira um
  stub de `Room` (`publishTrack` conta 1 track; `pushFrame` chega no track). Os
  checks de fila/feeder/PCM/pause/skip/stop/disconnect ficam. Remover os checks
  "per-peer track", "re-announces call membership", "offers music to every
  listener".

---

## Bloco E — Remoção do mesh no servidor (mesma passada)

### E1. Deletar sinalização RTC e streams
- **Req:** SFU-FR-050/053
- **Arquivos:** `server/src/ws/handler.rs`, `server/src/ws/protocol.rs`,
  `server/src/ws/mod.rs`, `server/src/routes/turn.rs` (deletar),
  `server/src/routes/mod.rs`, `server/src/ws/call_registry.rs`
- **Fazer:** remover do `dispatch` e do módulo: `relay_rtc`, `rtc.offer` /
  `rtc.answer` / `rtc.ice` / `rtc.connection_state`, `rtc.turn_credentials`
  (`.request`), `stream.publish` / `stream.published` / `stream.unpublish` /
  `stream.unpublished` / `stream.subscribe` / `stream.subscription_requested` /
  `stream.unsubscribe` / `stream.unsubscribed`, e `call.join` / `call.leave` /
  `call.snapshot` / `call.peer_joined` / `call.peer_left` (+ `CallSnapshot` /
  `CallPeerJoined` / `CallPeerLeft` / `RtcOffer` / `RtcAnswer` / `RtcIce` /
  `TurnCredentials` do `protocol.rs`). Deletar `routes/turn.rs` + sua rota.
  `CallRegistry`: manter só o caminho webhook (B4) + os getters de roster.
  `music_djs` fora. `handle_call_state_update` (mute/deafen p/ roster) fica.
- **Verificar:** `cargo build`; `grep -rn "relay_rtc\|rtc\.offer\|stream\.subscribe\|routes::turn" server/src` sem resultado.

### E2. Reescrever/remover testes de servidor do mesh
- **Req:** SFU-FR-053, SFU-NFR-001
- **Arquivos:** `server/tests/calls_test.rs`, `server/tests/music_test.rs`,
  `server/tests/common/mod.rs`
- **Fazer:** remover casos que dependiam de `call.join` + `rtc.offer` +
  `stream.subscribe`. `music_test.rs` — o "somente o bot pode publicar
  `music.status`" fica; o "persiste como mensagem" fica. Adicionar (se ainda não
  em `livekit_test.rs`) a cobertura do webhook.
- **Verificar:** `cargo test --locked` **inteiro** verde.

---

## Bloco F — Remoção do mesh no cliente / native (mesma passada)

### F1. Native: deletar música local
- **Req:** SFU-FR-051
- **Arquivos:** `client/native/Talkeando.Client/MusicPlayback.cs` (deletar),
  `client/native/Talkeando.Client/IpcBridge.cs`,
  `client/native/Talkeando.Client/MainWindow.xaml.cs` (se referencia
  `WriteAudioSlot` só p/ música)
- **Fazer:** deletar `MusicPlayback.cs` e os cases `music.play` / `music.pcm` /
  `music.pause` / `music.stop` do `IpcBridge.cs`. **Manter** o shared buffer
  `screen-audio` se ele também serve o loopback de áudio da tela (checar
  `MainWindow.xaml.cs` — o `_audioBuffer` é usado pela captura de tela; só
  remover o que era exclusivo da música).
  O relay dos ops `rtc.*` / `stream.*` no `IpcBridge.cs` pode sair (o cliente
  novo fala direto com o LiveKit); manter `call.state.update` (mute/deafen p/
  roster), `music.command`, chat, presença.
- **Verificar:** `dotnet build` (se disponível); senão, revisão + `dotnet test`
  no CI.

### F2. `client/native/Talkeando.Client.Tests`
- **Fazer:** remover/ajustar testes de `MusicPlayback`/IPC de música local.
- **Verificar:** `dotnet test`.

---

## Bloco G — Documentação

### G1. Docs do repo
- **Req:** SFU-FR-054
- **Arquivos:** `README.md` (raiz), `protocol/README.md`,
  `memory/screen-share-architecture.md`, `memory/voice-roster-and-spectate.md`,
  `memory/webcam-architecture.md`, `docs/sfu-migration/README.md`
- **Fazer:** badge "WebRTC Mesh" → "WebRTC SFU (LiveKit)"; diagrama de
  arquitetura com `livekit` e `infra/livekit/`; `protocol/README.md` lista ops
  removidos (`rtc.*`, `stream.subscribe*`, `call.join/leave/snapshot/peer_*`,
  `rtc.turn_credentials`) e endpoints novos (`/api/livekit/token`,
  `/api/livekit/webhook`); reescrever as 3 memórias para o modelo SFU; marcar
  `docs/sfu-migration/README.md` como **CONCLUÍDA**.

---

## Checklist final (antes do commit)

- [ ] `cd server && cargo test --locked` — verde
- [ ] `cd music-bot && npm test` — verde
- [ ] `cd client/ui && npm run build` — verde
- [ ] `cd client/native/Talkeando.Client && dotnet build` — verde (ou CI)
- [ ] `grep -rn "relay_rtc\|@roamhq/wrtc\|rtc\.offer\|routes::turn\|stream\.subscribe" server/ music-bot/ client/` — sem resultado funcional
- [ ] `infra/docker-compose.production.yml config` — válido
- [ ] Nenhum segredo commitado (`livekit.yaml` real não vai no repo; só o `.tmpl` e o `.dev.yaml`)
- [ ] `docs/` e `memory/` atualizados
- [ ] Um commit: `feat: migrate all realtime media from WebRTC mesh to LiveKit SFU`

## Tarefas do humano (fora desta execução)

1. Criar os GitHub Secrets no environment `production`: `LIVEKIT_URL`
   (`wss://sfu.<dominio>`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
2. Subir a Lightsail de 2 GB → 4 GB (snapshot + resize, ou instância nova).
3. Abrir a faixa UDP `50000-50200` no firewall da Lightsail; manter TCP 7881.
4. Apontar `sfu.<dominio>` (DNS) para o IP da Lightsail.
5. Rodar o deploy (`workflow_dispatch` ou push). Validar: `curl -sf
   https://sfu.<dominio>/`; `docker logs livekit` limpo; entrar numa call e
   confirmar voz/tela/bot.
