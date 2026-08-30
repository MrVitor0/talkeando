# 03 — Mudanças por serviço (monorepo)

Tudo continua neste repositório. Novos pacotes/deps entram nos diretórios que já
existem; um serviço novo (`livekit`) entra no `infra/`.

---

## `infra/`  ·  novo serviço + sizing

### Novo container: `livekit`
`infra/docker-compose.production.yml` ganha:

```yaml
  livekit:
    image: livekit/livekit-server:v1.x
    restart: unless-stopped
    command: --config /etc/livekit.yaml
    network_mode: host          # precisa de faixa UDP larga p/ ICE, igual coturn
    volumes:
      - ./livekit/livekit.yaml:/etc/livekit.yaml:ro
    depends_on: [tupi-server]
```

`infra/livekit/livekit.yaml` (novo): `keys` (API key/secret), `port` (7880 WS/HTTP),
`rtc.udp_port` / `port_range_start..end` (faixa UDP dedicada — **não** colidir
com a do coturn 49160-49200), `rtc.use_external_ip: true`, `turn` (apontar para o
coturn existente OU habilitar o TURN embutido do LiveKit), `webhook.urls`
(`https://<api-domain>/api/livekit/webhook`), `redis` (só se
for rodar múltiplas instâncias — **não** para 1 nó).

### `Caddyfile`
Expor o LiveKit: proxy de `wss://<sfu-subdomain>/` → `localhost:7880` (WS de
sinalização + HTTP). O media UDP é direto na porta/faixa do host, não passa pelo
Caddy.

### `coturn`
Mantido. Duas opções: (a) LiveKit usa o coturn como TURN externo (config
`turn.external`), (b) desliga o TURN do coturn e usa o embutido do LiveKit.
Recomendo (a) no começo — menos mudança.

### Lightsail: **2 GB → 4 GB**
- RAM 2 GB já está no talo (server Rust + bot Node/wrtc/ffmpeg + caddy + coturn +
  overhead Docker). LiveKit idle ~80–150 MB, +alguns MB/participante.
- CPU: forward de ~10 pessoas + 1–2 telas = fração de 1 vCPU. Sem transcode.
- Banda: cota mensal da Lightsail (≈2–3 TB) é o limite real. Voz é irrelevante;
  screen-share pesado diário pode encostar — capar bitrate da tela (~2 Mbps /
  720–1080p) e/ou orçar excedente (~US$0,09/GB). Ver `risks.md`.
- Se um dia crescer para várias calls simultâneas com tela: separar o LiveKit
  numa instância dedicada (config já suporta, só muda a URL no token).

### `.github/workflows/deploy-production.yml`
- Copiar `infra/livekit/` no `tar` do release.
- `docker compose up -d --build` já sobe o novo serviço.
- Secrets novos no environment `production`: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
  `LIVEKIT_URL` (ex. `wss://sfu.<dominio>`).
- Gerar `infra/livekit/livekit.yaml` a partir dos secrets no deploy (mesmo padrão
  do `music-bot.env`).

---

## `server/`  ·  Rust — de relay de mídia a autorizador + espelho

### Adicionar
- **Dep**: crate para assinar JWT do LiveKit (`livekit-api` se existir versão
  estável, senão `jsonwebtoken` + montar o claim à mão — o formato de grant do
  LiveKit é simples e documentado). Client HTTP para a `RoomService` do LiveKit
  (`removeParticipant`, `updateParticipant`, `listParticipants`) — REST simples.
- **`routes/livekit.rs`** (novo):
  - `POST /api/livekit/token` (autenticado) — body `{ channel_id }`. Valida
    membership/permissão (o mesmo `channel_if_member` de hoje), monta o grant
    (`room = channel_id`, `roomJoin`, `canPublish/Subscribe`, `hidden` se for
    spectate), assina, devolve `{ url, token }`. **Substitui `call.join`** como
    porta de entrada da call.
  - `POST /api/livekit/webhook` — verifica assinatura (`Authorization` do
    LiveKit), trata `participant_joined` / `participant_left` / `track_published`
    / `track_unpublished` / `room_finished`. Atualiza o `CallRegistry` e dispara
    `voice.roster` / `voice.rooms` para a comunidade. Os ops
    `call.peer_*` / `call.snapshot` também saem — o roster do cliente na call
    passa a vir dos eventos do `Room` do LiveKit (`implementation.md` E1/C2).
- Config nova em `config.rs`: `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
  `LIVEKIT_API_SECRET`, `LIVEKIT_TOKEN_TTL_SECONDS`. O webhook
  é verificado com o mesmo `LIVEKIT_API_SECRET` (o LiveKit assina com o par
  key/secret) — ver `design.md §3`.

### Mudar
- `ws/handler.rs`:
  - `handle_call_join` → em vez de mexer no `CallRegistry` e mandar
    `call.snapshot`, pode virar um no-op / só logar (o cliente novo não manda
    `call.join`). Removido nesta migração (`implementation.md` E1).
  - `call.state.update` (mute/deafen p/ roster) — manter como sinal de UI leve,
    OU migrar para participant attributes do LiveKit. Mais simples: manter.
  - `handle_music_command` — inalterado (server → bot); o bot é que muda de
    transporte.
  - `handle_music_status` — inalterado (já persiste o card como mensagem).
  - `voice.move_member` → passa a: mandar `voice.moved` para o alvo (ele
    reconecta com token da nova room) — praticamente igual, só o alvo troca de
    room LiveKit em vez de mandar `call.join`.
  - `voice.disconnect_member` → chama `RoomService.removeParticipant` no LiveKit
    (humano) + o reset do bot (igual hoje).

### Deletar (nesta migração — sem coexistência)
- `relay_rtc` e os casos `rtc.offer` / `rtc.answer` / `rtc.ice` /
  `rtc.connection_state` no `dispatch`.
- `stream.subscribe` / `stream.subscription_requested` / `stream.unsubscribe` /
  `stream.unsubscribed` no servidor (assinatura passa a ser no LiveKit).
- `routes/turn.rs` + `rtc.turn_credentials` (o cliente novo não usa).
- `CallRegistry`: `subscribe`/`unsubscribe`/`publish`/`unpublish` mexidos por op
  somem; vira estrutura preenchida por webhook. `music_djs` provavelmente some
  (a lógica "último humano sai ⇒ tira o bot" pode virar webhook `room_finished`
  ou `participant_left` + contagem).

### Testes
- `server/tests/`: novos casos para `POST /api/livekit/token` (permissão,
  grant correto, TTL) e para o webhook (payload `participant_joined` →
  `voice.roster` sai correto). Os testes de `calls_test.rs` que exercitam
  `rtc.offer forbidden`, `stream.subscribe`, etc. são removidos/reescritos.

---

## `client/ui/`  ·  React + TS — trocar o motor de malha

### Adicionar
- **Dep**: `livekit-client` (browser SDK). Roda no WebView2 (Chromium) sem
  problema.
- `src/rtcLivekit.ts` (novo) — a nova fina camada:
  - `connect(channelId)`: `fetch('/api/livekit/token', {channel_id})` →
    `new Room({ adaptiveStream:true, dynacast:true, ... })` → `room.connect(url, token)`.
  - `room.localParticipant.setMicrophoneEnabled(...)`, `.setCameraEnabled(...)`.
  - Tela: capturar via ponte nativa (inalterado) → `MediaStreamTrack` →
    `room.localParticipant.publishTrack(track, { source: ScreenShare, simulcast:true })`
    + o track de áudio de sistema como `screen_share_audio`.
  - Render: `room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => ...)`
    → `track.attach()` devolve o `<audio>`/`<video>` já ligado; escolher o tile
    por `participant.identity` + `pub.source`.
  - Assinatura da tela (SUB-FR): `publication.setSubscribed(true/false)` no
    toggle "assistir". Deafen = não assinar áudio (`room.localParticipant`
    ...ou `setSubscribed(false)` nos tracks de mic).
  - `RoomEvent.ActiveSpeakersChanged` → substitui `onSpeaking`.
  - `RoomEvent.ConnectionQualityChanged` → substitui `onConnectionQuality`.
  - `RoomEvent.Disconnected` / `Reconnecting` / `Reconnected` → substitui o
    band-aid de reconexão; o LiveKit re-sincroniza o estado da room sozinho.
- `App.tsx`: trocar as chamadas `rtc.*` pelas equivalentes da nova camada. A
  UI (tiles, menus de volume/mute/parar de assistir) fica — só muda a origem
  dos streams e dos eventos.

### Manter
- `noiseSuppression.ts` (RNNoise sobre o mic, antes de publicar o track).
- `nativeScreen.ts` (captura de tela via shared buffer).
- Sinks de volume por-peer e por-tela: `livekit-client` dá `RemoteTrack` →
  `track.attach()` cria o elemento; o volume/mute local por participante e por
  tela continua sendo `el.volume`/`el.muted` como hoje, guardado em
  `tk.peerVolumes` / `tk.screenVolumes`.
- Seleção de device (`setSinkId`, input/output volume).

### Deletar
- `src/rtc.ts` mesh: **reescrito** nesta migração para a camada LiveKit
  (mantém o nome e os exports que o `App.tsx` usa — `implementation.md` C1).
- `src/nativeMusic.ts` e as exports `playMusic` / `stopMusic` / `setMusicPaused`
  / o handler de `music.command` no `App.tsx` (caminho DJ-local morto).

---

## `client/native/Talkeando.Client/`  ·  .NET — quase nada muda

### Manter
- `NetworkClient.cs` — o WS para o `tupi-server` continua (auth, chat,
  presença, roster, tokens são pedidos via REST). A reconexão de WS continua
  relevante para o app, só não é mais crítica para a mídia.
- Captura de tela GDI + `CoreWebView2SharedBuffer` — inalterado. O
  `MediaStreamTrack` resultante é publicado pelo `livekit-client` no WebView.
- `IpcBridge.cs` — o relay dos ops `rtc.*`/`stream.*` para o WS pode ser
  **removido** (o cliente novo fala direto com o LiveKit). Os ops de app
  (`call.state.update` se mantido, `music.command`, chat) continuam.

### Deletar
- `MusicPlayback.cs` (yt-dlp/ffmpeg local — morto) + o `case "music.play"` /
  `music.pcm` / `music.pause` / `music.stop` no `IpcBridge.cs` + os
  `WriteAudioSlot` / shared buffer `screen-audio` **se** ele só servia à música
  local (checar: o mesmo ring é usado pelo loopback de áudio da tela — esse
  fica).

---

## `music-bot/`  ·  Node — trocar `@roamhq/wrtc` pelo SDK do LiveKit

### Adicionar
- **Deps**: `livekit-server-sdk` (mintar o próprio token / usar RoomService) e
  o client de mídia. O client Node de mídia do LiveKit historicamente usa
  `@livekit/rtc-node` (bindings Rust nativos) — **validar** que compila/roda no
  `node:20-bookworm-slim` do `music-bot/Dockerfile` (é um risco de infra, ver
  `05`). Alternativa: manter `@roamhq/wrtc` **só** como fonte de
  `RTCAudioSource` e ligar num `Room` do `livekit-client` rodando sob Node com
  polyfills — mais frágil. Preferência: `@livekit/rtc-node`.

### Mudar
- `index.js`:
  - `join(channelId)` → pede token ao `tupi-server` (`POST /api/livekit/token`
    com o `MUSIC_BOT_TOKEN`) ou minta local com a API key → `room.connect`.
  - `publishTrack` de **um** track de áudio alimentado pelo feeder
    (`RTCAudioSource` equivalente do SDK). Fan-out é do SFU.
  - Deletar: `peer` / `offer` / `newMusicTrack` / `musicSource` compartilhado /
    `iceServers` / `restartPeerIce` / `iceRestartTimers` / todo o handling
    `rtc.offer|answer|ice` e o reconcile de `call.snapshot`.
  - `music.command` (play/pause/skip/stop/queue) e `music.status` — inalterados.
  - "Sair quando o último humano sai" → `RoomEvent.ParticipantDisconnected` +
    contar não-bots, ou reagir ao `room_finished` do servidor.

### Manter
- Toda a `src/` (provider chain, scorer, yt-dlp/ffmpeg, status reporter, fila,
  feeder de 10 ms). Só a **saída** de PCM muda de destino.
- `music-bot/test.js` — os checks de fila/feeder/PCM/pause/skip/stop ficam; os
  de `rtc.offer`/`call.snapshot reconcile`/`per-peer track` são removidos e
  trocados por "publica 1 track no room stub".

---

## `protocol/`
- `websocket-envelope.schema.json` — inalterado (o envelope não muda).
- Adicionar um `docs/` ou `.md` listando os ops **removidos** (`rtc.*`,
  `stream.subscribe/subscription_requested/unsubscribe/unsubscribed`,
  `rtc.turn_credentials*`) e os endpoints REST **novos** (`/api/livekit/token`,
  `/api/livekit/webhook`). Não há schema por-payload hoje, então é só doc.

---

## `README.md` (raiz)
- Badge "WebRTC Mesh" → "WebRTC SFU (LiveKit)".
- Seção Architecture: adicionar o `livekit` no diagrama e no bloco de árvore
  (`infra/livekit/`).
- Quick Start local: subir o `livekit` junto do postgres no
  `infra/docker-compose.yml` (dev).
