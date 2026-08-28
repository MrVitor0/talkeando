# 12 — Stream Subscription Model

Status: Decidido — **esta é a especificação mais importante e mais
não-negociável de todo o projeto.** Qualquer implementação que desvie do
que está aqui está errada, independente de "funcionar" no caso feliz.
Owner/Domain: Cliente (RtcEngine/StreamManager) + Backend (CallRegistry)
Requisitos: `SUB-FR-001` a `SUB-FR-008`, `SCREEN-FR-*`, `CAM-FR-*`
Ver também: `10-webrtc-architecture.md`, `state-machines/stream.md`,
`09-websocket-protocol.md` (§`stream.*`), `14-screen-share-pipeline.md`

## Objetivo

Especificar, sem ambiguidade, a regra que governa todo compartilhamento de
tela/câmera no sistema:

> **Publicar um stream nunca, em nenhuma circunstância, envia um único
> byte de mídia para ninguém. Mídia só flui de um publisher para um
> viewer específico depois que esse viewer pediu explicitamente aquele
> stream via `stream.subscribe`. Se o número de subscribers de um stream
> cai a zero, o envio daquele stream para de existir — sempre, sem
> exceção, sem período de graça "só por via das dúvidas".**

Isso é o oposto de "todo mundo na call recebe automaticamente o vídeo de
quem compartilha tela", que é o modelo ingênuo e **errado** para este
sistema.

## Contexto

Por que isso importa tanto: em mesh P2P (`10-webrtc-architecture.md`),
enviar mídia para um peer que não está olhando é puro desperdício de CPU
(encode) e banda (upload) do publisher — em uma call de 4 pessoas
compartilhando tela para 3 espectadores, sem esse controle o publisher
estaria codificando e enviando 3 streams de vídeo simultâneos mesmo que só
1 pessoa esteja de fato olhando a tela naquele momento. O modelo de
assinatura existe para que o custo de publicar escale com **atenção real**,
não com **presença na call**.

## Modelo de dados (canon §4, já em `06-backend-architecture.md`)

```rust
struct PublishedStream {
    id: StreamId,             // UUID opaco
    owner: UserId,
    kind: StreamKind,          // Screen | Camera (v1); extensível
    call_id: CallId,
    metadata: StreamMetadata,  // { label: Option<String>, has_audio: bool }
    viewers: HashSet<UserId>,  // quem assinou — a fonte de verdade de "quem deveria estar recebendo"
}
```

`viewers` vive **só no servidor**, dentro do `CallRegistry` — é o estado
autoritativo de quem tem direito de receber aquele stream. O cliente
publisher mantém seu próprio espelho local (`activeSenders: Map<UserId,
RTCRtpSender>`) que deve estar sempre consistente com o que o servidor diz
que `viewers` contém; toda mudança nesse espelho é disparada por uma
mensagem de servidor (`stream.subscription_requested`/
`stream.unsubscribe_requested`), nunca decidida unilateralmente pelo
cliente.

## O fluxo completo, passo a passo

### 1. Publish (`SUB-FR-001`)

```
Publisher                          Servidor                         Viewers (na mesma call)
    │  stream.publish                 │                                   │
    │  {kind, metadata}                │                                   │
    │ ────────────────────────────────▶│                                   │
    │                                  │ cria PublishedStream               │
    │                                  │ (viewers = {} vazio)                │
    │                                  │  stream.published                   │
    │                                  │ ─────────────────────────────────▶ │
    │                                  │  (broadcast a todos na call)        │
    │                                  │                                    │
    │      NENHUM RTP É ENVIADO NESTE MOMENTO — nem sequer um RTCRtpSender  │
    │      para aquele track é adicionado às PeerConnections existentes    │
```

O publisher, ao processar sua própria confirmação de publish, cria o track
(ex. via `ScreenCapturePipeline`) mas **não** o adiciona a nenhum
`RTCPeerConnection` ainda — o track existe "pronto para enviar", desconectado
de qualquer sender ativo (`SUB-FR-005` explica a escolha de implementação
exata abaixo).

### 2. Subscribe (`SUB-FR-002`)

```
Viewer                              Servidor                          Publisher
   │  stream.subscribe                 │                                  │
   │  {stream_id}                       │                                   │
   │ ──────────────────────────────────▶│                                   │
   │                                    │ valida: viewer está na mesma call │
   │                                    │ do stream (SUB-FR-006)             │
   │                                    │ adiciona viewer a .viewers          │
   │                                    │  stream.subscription_requested      │
   │                                    │  {stream_id, viewer_user_id}         │
   │                                    │ ────────────────────────────────▶  │
   │                                    │                                    │
   │                                    │           publisher's PeerController │
   │                                    │           (fila serializada, ver     │
   │                                    │            state-machines/peer.md)    │
   │                                    │           ativa o RTCRtpSender desse  │
   │                                    │           track NA PeerConnection      │
   │                                    │           específica com esse viewer   │
   │                                    │                                        │
   │              (se necessário, renegociação rtc.offer/rtc.answer             │
   │               naquela PeerConnection específica — só ela, não as demais)   │
   │                                                                            │
   │◀════════════ RTP flui agora, apenas Publisher→este Viewer ════════════════│
```

Ponto crítico: a ativação do sender é **por PeerConnection**, isto é,
**por par (publisher, viewer)**. Se o mesmo stream tem 2 viewers, o
publisher ativa 2 senders independentes (um por PeerConnection), cada um
controlável e desligável de forma completamente independente do outro.

### 3. Unsubscribe (`SUB-FR-003`)

```
Viewer                              Servidor                          Publisher
   │  stream.unsubscribe               │                                  │
   │  {stream_id}                       │                                  │
   │ ──────────────────────────────────▶│                                  │
   │                                    │ remove viewer de .viewers          │
   │                                    │  stream.unsubscribe_requested       │
   │                                    │ ────────────────────────────────▶  │
   │                                    │                          publisher desativa │
   │                                    │                          o sender APENAS    │
   │                                    │                          para essa PeerConnection │
   │                                    │                          (outros viewers do mesmo │
   │                                    │                          stream continuam recebendo)│
```

### 4. Invariante central (`SUB-FR-004`)

> `stream.viewers.is_empty() == true` implica, sempre e imediatamente, que
> **nenhuma** `RTCRtpSender` daquele track está ativo em nenhuma
> PeerConnection do publisher.

Isso deve valer em todo instante observável — inclusive nos casos de borda:
- Todos os viewers saem da call (`call.leave`) → servidor remove cada um de
  `viewers` como parte do processamento de `call.leave`, e dispara os
  mesmos `stream.unsubscribe_requested` equivalentes.
- O último viewer perde a conexão (grace period de `state-machines/call.md`)
  e não volta → tratado como unsubscribe implícito quando o timer expira.

### 5. Unpublish cascade (`SUB-FR-008`)

```
Publisher                          Servidor                         Todos os Viewers
   │ stream.unpublish                   │                                  │
   │ {stream_id}                         │                                  │
   │ ──────────────────────────────────▶│                                  │
   │                                    │ remove PublishedStream            │
   │                                    │ (implicitamente esvazia .viewers)  │
   │                                    │  stream.unpublished                  │
   │                                    │ ─────────────────────────────────▶ │
```
Cada viewer, ao receber `stream.unpublished`, remove sua expectativa
daquele `stream_id` — não há um `stream.unsubscribe` explícito por viewer
nesse caso, o unpublish já cobre todos de uma vez.

### 6. Subscribe tardio (`SUB-FR-007`)

Um viewer que entra na call *depois* que o stream já foi publicado recebe o
stream via `call.snapshot` (que lista `streams` ativos, ver
`09-websocket-protocol.md`). O fluxo de `stream.subscribe` a partir daí é
**idêntico** ao caso "just published" — não existe um caminho de código
separado para "assinar algo que já existia há tempo" vs. "assinar algo
recém-publicado". Isso é deliberado: menos casos especiais, menos chance de
bug.

## Decisão de implementação: desabilitar sender vs. renegociar a track para fora (`SUB-FR-005`)

Duas estratégias possíveis para "parar de enviar para este peer":

- **(A) Renegociar a track para fora** — remover completamente o
  `RTCRtpTransceiver`/sender da PeerConnection a cada unsubscribe, e
  readicionar a cada subscribe. Mais "limpo" em teoria (a PeerConnection
  reflete exatamente o que está fluindo), mas **cada** subscribe/unsubscribe
  de **qualquer** viewer dispara uma renegociação SDP completa daquela
  PeerConnection. Em uma call onde múltiplos viewers entram/saem de olhar a
  tela com frequência (comum — pessoas alternam entre focar no jogo e na
  tela compartilhada), isso vira uma tempestade de renegociações,
  aumentando risco de glare e latência perceptível de "start" a cada vez.

- **(B) Desabilitar o RTP sender, mantendo a track/transceiver presente**
  (`sender.replaceTrack(null)` ou pausar o encode e não enviar pacotes,
  dependendo do que a API do SIPSorcery expõe de forma mais direta) —
  **decisão v1**. A PeerConnection já tem a "capacidade" de enviar aquele
  track desde a primeira negociação (feita uma vez, na entrada do peer na
  call ou na publicação inicial do stream, o que vier depois), e
  subscribe/unsubscribe apenas ligam/desligam o fluxo de pacotes sem tocar
  em SDP. Trade-off aceito: a PeerConnection carrega transceivers "latentes"
  mesmo quando ninguém está assistindo (leve overhead de estado, zero
  overhead de banda real porque nenhum pacote RTP é gerado/enviado enquanto
  desativado) — mas evita completamente a tempestade de renegociação.

Ambas cumprem o invariante de "`0` subscribers ⇒ `0` bytes de mídia
enviados" — a diferença é puramente sobre *como* a PeerConnection representa
esse estado internamente, não sobre o comportamento de rede observável. Se
a experiência com (B) mostrar problemas (ex.: overhead real de manter
transceivers ociosos com muitos streams simultâneos), migrar para (A) é uma
mudança de implementação isolada dentro do `StreamManager`/`PeerController`,
não uma mudança de protocolo (`stream.subscribe`/`unsubscribe` continuam
exatamente os mesmos do ponto de vista do servidor e do outro peer).

## Autorização (`SUB-FR-006`)

Todo `stream.subscribe`/`unsubscribe` é validado: o `stream_id` deve
existir no `CallRegistry`, e o remetente deve ser um participante da mesma
`ActiveCall` a que o stream pertence. Um `stream_id` de outra call, ou de
um usuário que já saiu da call, resulta em `error { code: "stream_not_found" }`
ou `error { code: "not_participant" }` — nunca um subscribe silenciosamente
ignorado nem um panic.

## O que NÃO fazer (erros comuns a evitar na implementação)

- **Não** ativar o sender para todos os peers da call ao publicar "para
  economizar uma mensagem depois". Viola `SUB-FR-001` diretamente.
- **Não** manter o sender ativo para um viewer que já mandou
  `stream.unsubscribe` só porque "ele provavelmente vai reassinar logo".
  Viola `SUB-FR-004`.
- **Não** tratar "viewer saiu da call" como diferente de "viewer mandou
  unsubscribe explícito" — o resultado observável (parar de enviar para
  aquele peer) deve ser idêntico nos dois casos.
- **Não** implementar subscribe como uma operação em lote por publisher
  (ex. "recalcula todos os senders do publisher sempre que qualquer coisa
  muda") — cada assinatura é por (stream, viewer) e deve ser possível
  ativar/desativar independentemente sem afetar outros viewers do mesmo
  stream.

## Ver também

`state-machines/stream.md` traz o diagrama de estado formal (publish →
published → subscribed(N) → unpublished, com as transições de viewer
individual) e os testes de comportamento correspondentes vivem em
`testing/rtc.md` e `testing/acceptance.md`.
