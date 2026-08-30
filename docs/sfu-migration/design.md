# Design — Migração para SFU (LiveKit)

Este documento fixa os **contratos** que os passos de `implementation.md`
implementam. Para o mapa de "o que existe hoje" e "o que muda em cada serviço",
ver os anexos:

- `01-current-state.md` — inventário do estado atual (fluxos de mídia, ops WS,
  estado efêmero, serviços).
- `02-target-architecture.md` — topologia alvo, modelo do LiveKit, mapeamento
  conceito-a-conceito.
- `03-changes-by-service.md` — mudança concreta por diretório do monorepo.
- `risks.md` — riscos, custo, alternativas descartadas, perguntas em aberto.

---

## 1. Componentes (alvo)

```
Lightsail (SP) / docker compose:
  tupi-server (Rust)   — auth, REST, WS, CallRegistry(espelho), emite token, recebe webhook
  livekit-server       — SFU: DTLS/SRTP/ICE, forward RTP, simulcast, keyframe, dynacast
  music-bot (Node)     — fila + yt-dlp/ffmpeg + feeder; publica 1 track no LiveKit
  caddy                — TLS; proxy wss p/ tupi-server e p/ livekit
  coturn               — TURN (reaproveitado pelo LiveKit)
```

Cliente (WebView2/Chromium) e bot abrem **1** conexão WebRTC com o `livekit-server`.
Sinalização de mídia é cliente↔LiveKit. O `tupi-server` deixa de relayar mídia.

## 2. Contrato: token endpoint

`POST /api/livekit/token`  · auth: Bearer (sessão) **ou** `MUSIC_BOT_TOKEN`

Request:
```json
{ "channel_id": "<uuid>", "mode": "participant" }   // mode opcional, default "participant" | "spectator"
```

Response `200`:
```json
{ "url": "wss://sfu.<dominio>", "room": "<channel_id>", "token": "<jwt>" }
```

Grant (claim `video` do JWT LiveKit):
| campo | participant | spectator |
|---|---|---|
| `room` | `<channel_id>` | `<channel_id>` |
| `roomJoin` | `true` | `true` |
| `canPublish` | `true` | `false` |
| `canSubscribe` | `true` | `true` |
| `canPublishData` | `false` | `false` |
| `hidden` | `false` | `true` |

Claim de topo: `sub`/`identity = <user_id>` (ou `MUSIC_BOT_ID`), `name = <display_name>`,
`exp = now + LIVEKIT_TOKEN_TTL_SECONDS`, `metadata = {"avatar_color": "...", "is_bot": false}`.

Erros: `403` (não membro / canal não-voice), `401` (sem auth), `404` (canal
inexistente), `503` (LiveKit não configurado).

## 3. Contrato: webhook

`POST /api/livekit/webhook`  · header `Authorization: <jwt>` assinado com
`LIVEKIT_API_KEY/SECRET` — o handler DEVE verificar antes de processar.

Eventos tratados e efeito:
| evento | efeito no `tupi-server` |
|---|---|
| `room_started` | nada (ou log) |
| `participant_joined` | `CallRegistry`: add participante ao canal `room`; `broadcast_voice_roster(channel)` |
| `participant_left` | `CallRegistry`: remove; `broadcast_voice_roster`; se sobra só o bot → `music.command stop` + `remove_participant(bot)` |
| `track_published` | `CallRegistry`: marca `sharing` conforme `track.source` (`screen_share`/`screen_share_audio`/`camera`); `broadcast_voice_roster` |
| `track_unpublished` | idem, desmarca |
| `room_finished` | `CallRegistry`: limpa o canal; `music.command stop` |

`voice.roster` (canal) e `voice.rooms` (snapshot no bootstrap) são o **único**
canal de roster para o cliente — não há mais `call.peer_joined`/`call.peer_left`.
Ignorar: `egress_*`, `ingress_*`, `track_muted`/`unmuted` (mute vai por
`call.state.update` — ver §6).

## 4. Contrato: tracks

| Mídia | `source` (LiveKit) | `name` | metadata | publicado por |
|---|---|---|---|---|
| Microfone | `Microphone` | — | — | cada participante |
| Câmera | `Camera` | — | — | quem liga a câmera; `simulcast: true` |
| Tela (vídeo) | `ScreenShare` | — | — | quem compartilha; `simulcast: true`, `dynacast` na room |
| Tela (áudio de sistema) | `ScreenShareAudio` | — | — | idem, só se houver loopback |
| Música (bot) | `Microphone` | `"music"` | `{"kind":"music"}` | `music-bot` (identity = `MUSIC_BOT_ID`) |

O cliente classifica: `participant.identity === MUSIC_BOT_ID` → música;
`publication.source` → mic/câmera/tela/tela-áudio.

## 5. Sem flag — substituição limpa

Não há `MEDIA_BACKEND` nem backend dual. O `app.bootstrap` passa a incluir
`livekit_url`; o cliente sempre usa a camada LiveKit; o bot sempre publica no
LiveKit. Todo o código do caminho mesh sai nesta mesma migração
(ver `implementation.md`, passos de remoção). Rollback = `git revert` do commit.

## 6. Mute/deafen para o roster

Manter `call.state.update` no `tupi-server` como **sinal de UI** apenas (o
cliente informa muted/deafened; o servidor propaga p/ o roster). O mute real é
`setMicrophoneEnabled` local; deafen é não-assinar local. Não usar participant
attributes do LiveKit (menos código — ver `risks.md#4`).

## 7. Env / secrets novos

| Serviço | Variável | Origem |
|---|---|---|
| `tupi-server` | `LIVEKIT_URL` | GitHub Secret `LIVEKIT_URL` |
| `tupi-server` | `LIVEKIT_API_KEY` | GitHub Secret |
| `tupi-server` | `LIVEKIT_API_SECRET` | GitHub Secret |
| `tupi-server` | `LIVEKIT_TOKEN_TTL_SECONDS` | opcional, default `21600` |
| `music-bot` | `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | idem (ou pede token ao `tupi-server` com `MUSIC_BOT_TOKEN`) |
| `livekit` | conteúdo do `livekit.yaml` | gerado no deploy a partir dos secrets |

Env removidos ao final: nenhum novo de flag. `TURN_*` só permanece se o
`livekit.yaml` referenciar o coturn como TURN externo.

## 8. Config do `livekit.yaml` (chave)

```yaml
port: 7880                      # WS/HTTP de sinalização (atrás do Caddy)
rtc:
  tcp_port: 7881
  port_range_start: 50000       # UDP — DISJUNTO da faixa do coturn (49160-49200)
  port_range_end: 50200
  use_external_ip: true
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
webhook:
  api_key: ${LIVEKIT_API_KEY}
  urls:
    - https://${API_DOMAIN}/api/livekit/webhook
turn:
  enabled: false               # usar o coturn existente como ICE server externo
room:
  empty_timeout: 300           # room some 5 min após esvaziar
  max_participants: 12
```

`infra/coturn/turnserver.conf` DEVE declarar sua faixa `min-port 49160 /
max-port 49200` (já declara) e um comentário apontando que 50000-50200 é do
LiveKit.

## 9. O que encolhe

- `client/ui/src/rtc.ts` → **reescrito em lugar** para a camada LiveKit
  (mantém o nome do arquivo e o conjunto de exports que o `App.tsx` consome;
  ~1/3 do tamanho). Os anexos `01/02/03` chamam essa camada de `rtcLivekit.ts`
  como nome de trabalho — a decisão vigente é reescrever `rtc.ts`.
- `server/src/ws/handler.rs` → sai `relay_rtc` + roteamento `rtc.*` +
  `stream.subscribe*`; `CallRegistry` vira espelho de webhook.
- `music-bot/index.js` → sai `peer`/`offer`/`iceServers`/`restartPeerIce`/
  reconcile de `call.snapshot`/handling `rtc.*`.
- Deletados: `routes/turn.rs`, `nativeMusic.ts`, `MusicPlayback.cs`, dep
  `@roamhq/wrtc`.
