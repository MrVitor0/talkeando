# 14 — Screen Share Pipeline

Status: Implementado (v1 scope), pendente validação manual em duas máquinas
Owner/Domain: Cliente nativo (`RtcEngine`, `ScreenShareViewerWindow`)
Requisitos: `SCREEN-FR-*`, `SUB-FR-*`
Ver também: `12-stream-subscription-model.md`, `specs/screen-share.md`,
`27-decisions.md` (ADR-003 — leia primeiro: várias decisões aqui foram
corrigidas em relação ao plano original, com a razão verificada).

## Objetivo

Especificar, com precisão de implementação real, como uma tela é capturada,
codificada, e enviada **apenas** para quem pediu para assistir — e como a
recepção decodifica e renderiza.

## Pipeline de publicação (captura → rede)

```
stream.publish (IPC, UI → nativo)
    │
    ▼
RtcEngine.PublishScreen(streamId, monitorIndex, fps=15)
    │
    ├── WindowsVideoEndPoint(new VpxVideoEncoder(), "", 0, 0, 0)
    │   (device id vazio: nunca abre câmera, só usado como pipeline
    │   externo-raw-sample → encode)
    │
    ▼
Loop de captura (Task.Delay entre frames, não event-driven):
    System.Drawing.Graphics.CopyFromScreen(monitor.Bounds)
        │
        ▼
    Bitmap.LockBits (Format32bppArgb == BGRA em memória)
        │
        ▼
    endpoint.ExternalVideoSourceRawSample(durationRtpUnits=90000/fps,
        width, height, bgraBytes, VideoPixelFormatsEnum.Bgra)
        │
        ▼
    (dentro do WindowsVideoEndPoint) VpxVideoEncoder.EncodeVideo(...) → VP8
        │
        ▼
    endpoint.OnVideoSourceEncodedSample(durationRtpUnits, vp8Bytes)
        │
        ├── para cada subscriberId em share.Subscribers:
        │     peer.SendVideo(durationRtpUnits, vp8Bytes)
        │
        └── nenhum subscriber ⇒ este loop não chama SendVideo em ninguém
            (zero bytes de vídeo saem do processo) — **isto é o invariante
            SUB-FR-001, implementado como um gate no envio, não uma pausa
            na captura/codificação**
```

Este stream_id é anunciado ao servidor via `stream.publish` (WS) que
responde `stream.published` a todos os participantes da call — nenhum deles
recebe mídia ainda, só o anúncio (canon §5/§6, `12-stream-subscription-model.md`).

## Pipeline de assinatura (subscribe → primeiro frame)

```
UI clica "Assistir" (React) → IPC "stream.watch" { channel_id, stream_id, owner_user_id }
    │
    ▼
IpcBridge:
    1. cria/reaproveita uma ScreenShareViewerWindow para owner_user_id
    2. envia WS "stream.subscribe" { channel_id, stream_id }
    │
    ▼
Servidor valida (é participante da call? stream existe?) e roteia
"stream.subscription_requested" { stream_id, subscriber } ao DONO do stream
    │
    ▼
IpcBridge do dono recebe "stream.subscription_requested" via HandleNetworkEvent
    → RtcEngine.SetScreenSubscription(streamId, subscriberUserId, true)
    → o loop de captura já rodando começa a enviar para esse peer no
      próximo frame codificado (nenhuma renegociação SDP acontece)
```

## Pipeline de recepção (rede → janela)

```
RTCPeerConnection.OnVideoFrameReceived (frame VP8 já reagrupado pelo
SIPSorcery a partir dos pacotes RTP — não há depacketização manual aqui)
    │
    ▼
VpxVideoEncoder.DecodeVideo(payload, Bgra, VP8) → IEnumerable<VideoSample>
    (uma instância de decoder por peer remoto, nunca compartilhada — VP8 é
    stateful entre frames)
    │
    ▼
RtcEngine.RemoteVideoFrameReceived(peerUserId, width, height, bgraBytes)
    │
    ▼
IpcBridge roteia pelo peerUserId (não pelo stream_id — ver ADR-003 para a
simplificação aceita) para a ScreenShareViewerWindow correspondente
    │
    ▼
WriteableBitmap (PixelFormats.Bgra32 — mesmo layout de bytes, sem
conversão) .WritePixels(...)
```

## Encerramento

- **Dono para de compartilhar** (`stream.unpublish` IPC → WS): captura para
  (`CancellationTokenSource.Cancel`), `WindowsVideoEndPoint` fecha e é
  descartado, servidor remove o `PublishedStream` do `CallRegistry` e
  transmite `stream.unpublished` a todos os participantes da call.
- **Viewer recebe `stream.unpublished`**: `IpcBridge` resolve o `owner`
  daquele `stream_id` (aprendido antes via `stream.published`, já que
  `stream.unpublished` só carrega `stream_id` — ver protocolo) e fecha a
  `ScreenShareViewerWindow` correspondente.
- **Viewer clica "Parar de assistir"** (`stream.stop_watching` IPC): fecha
  a janela, o que dispara `Closed` → envia `stream.unsubscribe` ao servidor
  → servidor roteia `stream.unsubscribed` ao dono → dono remove o
  subscriber do gate de envio.
- **Peer publicador sai da call/desconecta**: `CallRegistry.leave` no
  servidor já remove os streams que ele possuía e transmite
  `stream.unpublished` para quem restou — o cliente trata isso pelo mesmo
  caminho do encerramento normal.
- **Monitor desconecta durante a captura**: o loop de captura trata
  qualquer exceção do GDI como fonte desaparecida, para o loop e não tenta
  se recuperar sozinho — republicar exige um novo `PublishScreen` (uma nova
  ação explícita do usuário), não uma retomada automática.

## Fora de escopo do v1 (ver ADR-003 para a razão)

- Seleção de janela individual (só monitor inteiro).
- `Windows.Graphics.Capture` (WGC) — GDI é o método de captura do v1.
- Renderização embutida como tile na janela principal — v1 usa uma janela
  WPF dedicada por stream assistido.
- H.264 (v1 é VP8-only).
- Múltiplos streams simultâneos do mesmo publisher (câmera + tela ao mesmo
  tempo) — o roteamento de frames recebidos é por peer, não por stream_id.

## Pendências conhecidas (registradas, não escondidas)

- Nenhuma validação em duas máquinas Windows reais foi possível nesta
  sessão (sem hardware disponível) — apenas compilação e verificação de
  API por reflexão foram feitas.
- Sem adaptação de qualidade (`QUAL-FR-*`) — fps e resolução são fixos por
  escolha do monitor, sem reação a perda de pacote/RTT.
- Sem UI de "compartilhando para N pessoas" nem indicador de fullscreen —
  a UI atual é o mínimo funcional (botão compartilhar/parar, lista de quem
  está compartilhando, botão assistir/parar de assistir).
