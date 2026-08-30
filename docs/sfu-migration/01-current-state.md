# 01 — Estado atual (o que existe hoje)

Monorepo. Layout relevante:

```
talkeando/
├── server/                          # Rust (axum + tokio + sqlx). REST + WS. Fonte da verdade.
│   └── src/ws/                       # handler.rs, hub.rs, call_registry.rs, protocol.rs, activity.rs
├── client/
│   ├── ui/                          # React 18 + TS + Vite. Contém rtc.ts (engine mesh, ~1.4k linhas).
│   │   └── src/{rtc.ts, App.tsx, nativeScreen.ts, nativeMusic.ts, noiseSuppression.ts}
│   ├── native/Talkeando.Client/     # .NET 6 WPF + WebView2 host. NetworkClient.cs, IpcBridge.cs,
│   │                                #   MusicPlayback.cs (MORTO), captura de tela GDI, shared buffers.
│   └── audio/                       # AudioWorklet + RNNoise WASM.
├── music-bot/                       # Node. @roamhq/wrtc + yt-dlp + ffmpeg + provider chain.
├── protocol/                        # JSON Schemas dos envelopes WS/IPC (não é código, só validação/doc).
├── infra/                           # docker-compose.production.yml, Caddyfile, coturn.
└── .github/workflows/               # deploy-production.yml (Lightsail SP), build-windows-client.yml, ...
```

## 1. Fluxos de mídia (todos P2P / mesh hoje)

| # | Fluxo | Topologia hoje | Arquivos donos | Observações |
|---|---|---|---|---|
| 1 | **Voz (microfone)** | Malha completa: cada participante ↔ cada participante | `client/ui/src/rtc.ts` (`joinCall`, `connectToPeer`, `pc.ontrack` audio), `music-bot` não | Opus. RNNoise aplicado antes (`noiseSuppression.ts`). ~40 kbps/pessoa. |
| 2 | **Câmera / webcam** | Malha: broadcast para **todos** os peers da call (sem subscribe-gate) | `rtc.ts` (`startCamera`, `applyCameraSend`, `cameraSlots`, `cameraNeedsOffer`) | Ver `memory/webcam-architecture.md`. `msid` distingue câmera de tela. |
| 3 | **Tela (vídeo)** | Modelo SUB-FR: o dono só envia para quem deu `stream.subscribe`; conexão + renegociação **por viewer** | `rtc.ts` (`publishScreen`, `applyScreenSend`, `setScreenSubscription`, `screenSlots`, `screenSubscribers`) + captura nativa | Invariante "0 viewers ⇒ 0 bytes". Keyframe (PLI) por viewer novo. |
| 4 | **Tela (áudio de sistema / loopback)** | Track separado, mesmo caminho da tela | `rtc.ts` (`applyScreenSend` ramo de áudio, `screenAudioEls`/`screenAudioStreams` — sink separado por dono), `nativeScreen.ts`, shared buffer `screen-audio` | Mute/volume independentes do mic (corrigido recentemente). |
| 5 | **Bot de música (áudio)** | Bot é um peer de malha: **1 `RTCPeerConnection` por ouvinte** | `music-bot/index.js` (`peer`, `offer`, `newMusicTrack`, feeder → `RTCAudioSource.onData`) | yt-dlp → ffmpeg → PCM 48 kHz → `RTCAudioSource`. Fan-out do wrtc é a origem do "só alguns ouvem". |
| 6 | **Spectate / hover-preview** | O dono da tela abre uma P2P dedicada para cada espectador de **fora** da call | `rtc.ts` (`spectate`, `stopSpectate`, `spectatorPeers`, `setScreenSubscription` com o hack "o dono inicia porque o espectador nunca oferece") + `server` (`is_stream_viewer`, `remove_viewer_globally`) | Ver `memory/voice-roster-and-spectate.md`. |

### Máquina de sinalização (tudo via WebSocket, relayada pelo servidor)

Ops WS relevantes (de `server/src/ws/handler.rs` / `protocol.rs`):

- **Membership de call**: `call.join`, `call.leave`, `call.snapshot`, `call.peer_joined`, `call.peer_left`, `call.state.update` (mute/deafen), `voice.move_member`/`voice.moved`, `voice.disconnect_member`/`voice.disconnected`.
- **Roster (broadcast p/ comunidade inteira, não só a call)**: `voice.roster`, `voice.rooms`.
- **Sinalização RTC (relayada 1:1 via `relay_rtc`)**: `rtc.offer`, `rtc.answer`, `rtc.ice`, `rtc.connection_state`, `rtc.turn_credentials` (+ `rtc.turn_credentials.request`).
- **Streams (tela/câmera/música)**: `stream.publish`, `stream.published`, `stream.unpublish`, `stream.unpublished`, `stream.subscribe`, `stream.subscription_requested`, `stream.unsubscribe`, `stream.unsubscribed`.
- **Música**: `music.command` (server → bot), `music.status` (bot → server), `music.announcement` (**depreciado** — hoje o card vira mensagem persistida em `chat.message.created`).
- `device.list_changed` (informativo).

### Estado efêmero (em RAM, sem persistência, sem re-sync)

| Camada | Estrutura | Arquivo |
|---|---|---|
| Servidor | `CallRegistry` (`calls: HashMap<ChannelId, ActiveCall>` com `participants` + `streams` + `viewers`), `music_djs: HashMap<ChannelId, UserId>` | `server/src/ws/call_registry.rs`, `hub.rs` |
| Bot | `peers: Map<userId, RTCPeerConnection>`, `voiceChannel`, `iceRestartTimers`, `queue`, `current` | `music-bot/index.js` |
| Cliente (UI) | `call` (React state), `watching`, `remoteVideos`, `mutedPeers`, `peerVolumes`, `screenMutedPeers`, `screenVolumes`; e no `rtc.ts`: `peers`, `screenSlots`, `cameraSlots`, `musicSlots`, `screenSubscribers`, `spectatorPeers`, `spectatedStreams`, `remoteStreamMeta`, `pendingCandidates`, ... | `client/ui/src/App.tsx`, `rtc.ts` |

> **Ponto central:** essas três camadas nunca se reconciliam. Um blip de WS ou
> um restart do servidor desincroniza uma da outra e não há protocolo de
> re-sync — apenas "re-anúncios" band-aid adicionados aos poucos.

## 2. Serviços por diretório

### `server/` — Rust (axum, tokio, sqlx → Postgres/Neon)
- **REST**: auth, comunidades, canais, mensagens, anexos, perfis, convites, media, `routes/turn.rs` (credenciais TURN time-limited estilo coturn `use-auth-secret`), `activity_assets`.
- **WS** (`src/ws/`): handshake `auth.hello`, presença, atividade, chat realtime, **relay de sinalização RTC** (`relay_rtc` valida `is_participant || is_stream_viewer` e reenvia), `CallRegistry`, roteamento `music.command`/`music.status`.
- **Não toca em mídia.** Zero pacote RTP/SRTP/DTLS.
- Env: `DATABASE_URL`, `BIND_ADDR`, `TURN_SHARED_SECRET`, `TURN_REALM`, `TURN_URIS`, `TURN_CREDENTIAL_TTL_SECONDS`, `MUSIC_BOT_TOKEN`, `ALLOWED_ORIGINS`, `ATTACHMENT_STORAGE_PATH`.

### `client/ui/` — React + TS
- `rtc.ts`: o **motor de malha inteiro** — `getUserMedia`, N `RTCPeerConnection`, offer/answer/ICE via WS, "id menor oferece", glare handling, `restartIce`, reuso de transceiver por tipo de track (`screenSlots`/`cameraSlots`/`musicSlots`), renegociação "uma vez" com `*NeedsOffer` flags, sinks de áudio (`<audio>` por peer + sink separado por tela), amostragem de qualidade e de "quem fala" via `getStats()`. **~1.4k linhas, é a maior fonte de bug.**
- `App.tsx`: UI + estado de call (`call`, `watching`, tiles, menus de volume/mute), consome os eventos WS e chama `rtc.*`.
- `nativeScreen.ts` / `nativeMusic.ts`: ponte IPC com o host .NET (shared buffers de vídeo/áudio da captura). **`nativeMusic.ts` só serve ao caminho DJ-local morto.**
- `noiseSuppression.ts`: RNNoise WASM sobre o mic, antes do WebRTC.

### `client/native/Talkeando.Client/` — .NET 6 WPF + WebView2
- `NetworkClient.cs`: HTTP + `ClientWebSocket` (com reconexão/backoff), hidratação de mídia `/api/...` → data URI.
- `IpcBridge.cs`: bridge JS↔native; relay puro dos ops de call/rtc/stream para o WS (`case "call.join": ... await _network.SendWebSocketAsync(op, ...)`), captura de tela, `music.play`/`music.pcm`.
- `MusicPlayback.cs`: **CÓDIGO MORTO** — yt-dlp/ffmpeg local para o antigo "DJ local". O servidor nunca envia `music.command` para clientes humanos.
- Captura de tela: GDI borderless → `CoreWebView2SharedBuffer` → canvas no `rtc.ts`.

### `music-bot/` — Node
- `index.js`: `@roamhq/wrtc` (fork de `node-webrtc`, **abandonado desde 2020** — o comentário no topo do arquivo documenta isso), WS para o servidor, provider chain (`cache,library,soundcloud,audius` + `youtube` opt-in), `RTCAudioSource` alimentado por feeder de 10 ms, 1 PC por ouvinte, ICE restart manual.
- `src/`: `infrastructure/` (spotify/youtube/audius/yt-dlp clients + http), `intents/`, `matching/` (scorer + normalizer), `providers/`, `status/`.

### `protocol/` — JSON Schemas
- `websocket-envelope.schema.json`, `ipc-envelope.schema.json` — só validam o **envelope** (`{v, op, data}`), não os payloads por-op. Doc/contrato leve.

### `infra/`
- `docker-compose.production.yml`: `tupi-server`, `music-bot`, `caddy` (reverse proxy TLS), `coturn` (`network_mode: host`, `--use-auth-secret`, portas 3478 + 49160-49200 UDP), (`bgutil-provider` removido).
- Lightsail **2 GB** em São Paulo. Deploy via SSH + `docker compose up -d --build` (`.github/workflows/deploy-production.yml`).

## 3. Cliente Windows: como a mídia chega hoje

`getUserMedia`/canvas no WebView2 → `RTCPeerConnection` no `rtc.ts` → ICE (STUN Google + coturn) → mídia P2P direta ou relayada pelo coturn. O host .NET **não** processa RTP; só faz captura de tela e a ponte WS. RNNoise roda no WebView (WASM).
