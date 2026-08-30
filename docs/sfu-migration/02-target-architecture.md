# 02 — Arquitetura alvo (LiveKit SFU)

## Visão geral

```
                         ┌─────────────────────────────────────────┐
                         │  Lightsail (São Paulo) — Docker Compose  │
                         │                                         │
  cliente Windows  ──WS──┤  tupi-server (Rust)                      │
  (WebView2)       ──────┤    · auth / REST / chat / presença       │
        │                │    · CallRegistry  → "quem está na room" │
        │                │    · minta token LiveKit no call.join    │
        │                │    · recebe webhooks do LiveKit          │
        │  WebRTC         │                                         │
        │  (1 conexão)    │  livekit-server (SFU)  ◄── webhooks ──┐  │
        └────────────────┼──►  · termina DTLS/SRTP/ICE           │  │
                         │     · encaminha RTP por assinante     │  │
  music-bot (Node) ──────┼──►  · simulcast / keyframe / banda    │  │
   (livekit SDK)         │                                       │  │
                         │  coturn (TURN, reaproveitado)          │  │
                         └───────────────────────────────────────┘  │
                                                                    │
              tupi-server autoriza a room ────────────────────────────┘
```

Cada cliente (e o bot) abre **uma** conexão WebRTC — com o **LiveKit**, não com
os outros peers. Publica seus tracks uma vez; assina os tracks dos outros. O
SFU encaminha RTP. Sinalização de mídia (offer/answer/ICE) passa a ser
cliente↔LiveKit direto — **não** pelo `tupi-server`.

O `tupi-server` continua dono de **identidade, permissão e roster**. Ele só
deixa de ser o relay de mídia.

## Modelo do LiveKit

| Conceito LiveKit | Equivale a | Detalhe |
|---|---|---|
| **Room** | Um canal de voz (`channel_id`) | Nome da room = `channel_id`. Criada lazy no primeiro join. |
| **Access Token** (JWT assinado com API key/secret) | O que hoje é `call.join` + checagem de membership | `tupi-server` gera: `identity = user_id`, `name = display_name`, grants (`roomJoin`, `room = channel_id`, `canPublish`, `canSubscribe`, `canPublishData`). TTL curto. |
| **Participant** | Participante da call | `identity` estável = `user_id`. O bot é um participant com `identity = MUSIC_BOT_ID` e um token próprio. |
| **Track** publicado | `stream.publish` (tela/câmera/música) + o mic | Cada track tem `source` (`microphone`, `camera`, `screen_share`, `screen_share_audio`) e metadata livre. |
| **TrackPublication / Subscription** | `stream.subscribe` / o modelo SUB-FR | Assinatura por track. `setSubscribed(false)` = "0 bytes para mim" — o invariante SUB-FR vira config nativa. |
| **Simulcast** | (novo) | Publisher de vídeo manda 2–3 camadas; o SFU escolhe por assinante conforme banda/tamanho do tile. |
| **Active Speakers** | `onSpeaking` (hoje via `getStats()` local) | Evento do SFU, mais preciso. |
| **Connection Quality** | `onConnectionQuality` (hoje `getStats()` local) | Evento do SFU. |
| **Data messages** | — | Canal de dados por-room, opcional (não vamos usar de início; chat continua no `tupi-server`). |
| **Webhooks** | `call.peer_joined` / `call.peer_left` no servidor | LiveKit chama `POST /livekit/webhook` no `tupi-server` em `participant_joined`, `participant_left`, `track_published`, `room_finished`, etc. |
| **Egress** (gravação/RTMP) | — | Fora de escopo. |

## Como cada fluxo atual mapeia

| Fluxo (de `01-current-state.md`) | No alvo |
|---|---|
| **Voz** | Cada participante publica 1 track `microphone`. Todos assinam automaticamente (`autoSubscribe`). Mute = `setMicrophoneEnabled(false)` (ou `track.mute()`). |
| **Câmera** | `localParticipant.setCameraEnabled(true)` ou `publishTrack(camTrack, {source: Camera, simulcast})`. Assinatura automática. `msid` some — o `source` diz o que é. |
| **Tela (vídeo)** | `publishTrack(screenTrack, {source: ScreenShare, simulcast})`. Viewer faz `publication.setSubscribed(true)`. O invariante "0 viewers ⇒ 0 bytes" continua: LiveKit só entrega a quem assinou; com `dynacast` ligado, o publisher **para de enviar** as camadas que ninguém assina. Keyframe: o SFU pede PLI **uma vez** quando o primeiro assinante entra e serve os demais do buffer. |
| **Tela (áudio)** | Track separado `screen_share_audio`. Mute/volume por-track no cliente (o sink separado que já existe no `rtc.ts` continua, só a origem do track muda). |
| **Bot de música** | Bot vira participant LiveKit. Publica **1** track de áudio alimentado pelo ffmpeg (via `RTCAudioSource` do SDK do LiveKit, não do `@roamhq/wrtc`). Todos assinam. Fan-out feito pelo SFU → o bug "só alguns ouvem" morre. |
| **Spectate / hover-preview** | Espectador entra na room com token `canSubscribe:true, canPublish:false` e assina só o track de tela do dono (camada baixa do simulcast). **Some** o caminho especial (`spectatorPeers`, "o dono inicia"). Precisa decidir se dá pra assinar sem "entrar" na room visível — LiveKit permite participant "hidden" (`hidden:true` no token) que não aparece no roster mas assina. |
| **`relay_rtc` + `rtc.offer/answer/ice`** | **Deletados.** Sinalização é cliente↔LiveKit. |
| **`voice.roster` / `voice.rooms`** | Continuam saindo do `tupi-server` (broadcast p/ comunidade), alimentados por webhooks do LiveKit + o `CallRegistry` (que vira um espelho leve do estado da room). |
| **`call.state.update` (mute/deafen)** | Mute local = `setMicrophoneEnabled`. O estado "mudo/surdo" para o roster: publicar via participant metadata/attributes do LiveKit **ou** manter o `call.state.update` no `tupi-server` só como sinal de UI (mais simples manter). Deafen é 100% local (não assinar áudio) — já é. |
| **`voice.move_member` / `voice.disconnect_member`** | Continuam no `tupi-server`: "mover" = pedir ao cliente para reconectar em outra room; "desconectar" = `RoomServiceClient.removeParticipant()` (API do LiveKit). |
| **Credenciais TURN** (`routes/turn.rs`) | LiveKit gerencia seus próprios ICE servers (pode usar o coturn de vocês). O endpoint `rtc.turn_credentials` deixa de ser usado pelo cliente novo. |

## Fonte da verdade / quem decide o quê

| Responsabilidade | Dono no alvo |
|---|---|
| Quem PODE entrar numa call, com que permissão | `tupi-server` (gera o token com os grants certos) |
| Quem ESTÁ na call agora (roster, sharing, mute) | `tupi-server` `CallRegistry`, atualizado por webhooks do LiveKit; continua fazendo `voice.roster`/`voice.rooms` para a comunidade |
| Transporte/encaminhamento da mídia, keyframe, banda, simulcast, reconexão | LiveKit |
| Captura (tela/câmera/mic), RNNoise, seleção de device | Cliente (inalterado) |
| Fila de música, resolução de provider, yt-dlp/ffmpeg | `music-bot` (inalterado; só a saída de áudio muda de SDK) |
| Chat, presença, atividade, DMs, anexos, perfis | `tupi-server` (inalterado) |

## O que encolhe / some no código

- `client/ui/src/rtc.ts`: some ~60–70% — todo offer/answer/ICE/glare/
  `restartIce`/`*Slots`/`*NeedsOffer`/`pendingCandidates`/sinks manuais de
  `<audio>`/amostragem de qualidade e speaking. Fica: seleção de device,
  captura de tela (ponte nativa), RNNoise, e finas camadas de "publica/assina".
- `server/src/ws/handler.rs`: some `relay_rtc` e todo o roteamento
  `rtc.*`/`stream.subscription_requested`/`stream.unsubscribed`. `CallRegistry`
  vira espelho de webhook em vez de estado autoritativo mexido por op.
- `music-bot/index.js`: some `peer`/`offer`/`newMusicTrack`/`iceServers`/
  `restartPeerIce`/todo o handling `rtc.*`/`call.snapshot` reconcile. Fica: a
  fila, o feeder, e `publishTrack` no LiveKit.
- `client/native/.../MusicPlayback.cs` + `nativeMusic.ts` + `rtc.playMusic`/
  `stopMusic`/`playMusic`: **deletar** (já eram mortos).
