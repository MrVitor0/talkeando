# 10 — WebRTC Architecture

Status: Decidido
Owner/Domain: Cliente nativo (RTC)
Requisitos: `RTC-FR-*`, `CALL-FR-*`, `AUDIO-FR-004`, `SEC-NFR-002/003`
Ver também: `04-system-architecture.md`, `11-call-state-machine.md`,
`state-machines/peer.md`, `12-stream-subscription-model.md`, `16-security.md`

## Objetivo

Especificar exatamente como o mesh P2P é construído e mantido: quantas
`RTCPeerConnection`s existem, como são criadas/destruídas, como ICE/TURN
funcionam, e como a negociação evita glare (colisão de oferta/resposta
simultânea).

## Contexto

Biblioteca: **SIPSorcery** (`RTCPeerConnection`) + `SIPSorceryMedia.Windows`
para captura/render WASAPI e encode/decode H.264 via Media Foundation.
Codec de áudio: Opus. Codec de vídeo primário: H.264 (fallback documentado
para VP8 se o encoder MF de hardware não estiver disponível na máquina —
preferência de codec configurável, não hard-coded).

## Topologia: uma PeerConnection por peer, não por track

Cada cliente mantém **uma única `RTCPeerConnection` por peer remoto** que
está na mesma call ativa — nunca uma conexão separada por track ou por
stream. Áudio do microfone, vídeo de câmera (se publicado) e tela
compartilhada (se publicada) trafegam todos como tracks adicionais **na
mesma** PeerConnection entre dois peers (`RTC-FR-001`).

Com N participantes em uma call, o número total de PeerConnections no mesh
é `N*(N-1)/2`; cada cliente individual mantém `N-1` conexões. Para N=4:
6 PeerConnections no mesh, 3 por cliente.

```
        A ────────── B
         \          /
          \        /
           \      /
             C ── D      (N=4: A-B, A-C, A-D, B-C, B-D, C-D = 6 total)
```

Publicar uma stream nova (tela ou câmera) para peers já conectados **nunca**
cria uma nova PeerConnection — adiciona um `RTCRtpSender` à PeerConnection
já existente com aquele peer, ativado seletivamente por assinatura (ver
`12-stream-subscription-model.md`).

## Ciclo de vida de uma PeerConnection

1. **Criação**: disparada quando `call.peer_joined` chega (para o peer que
   já estava na call) ou quando o próprio cliente processa seu
   `call.snapshot` ao entrar (para cada participante já presente). A cada
   par de peers, exatamente um lado inicia a oferta primeiro (decidido pelo
   papel polite/impolite, ver abaixo) — mas ambos criam a estrutura
   `PeerController` localmente ao detectar o novo peer.
2. **Negociação inicial**: troca de `rtc.offer`/`rtc.answer`/`rtc.ice` via
   servidor (relay opaco). Tracks de áudio local são adicionadas antes da
   primeira oferta sempre (mesmo mutado — mute é uma flag de aplicação, não
   ausência de track, ver `13-audio-pipeline.md`).
3. **Renegociação**: disparada por qualquer mudança de tracks (publish de
   tela/câmera, ativação de sender por subscribe) ou por ICE restart.
   Sempre serializada pelo `PeerController` daquele peer (nunca duas
   renegociações concorrentes para o mesmo peer).
4. **Falha/perda de conexão**: `iceconnectionstatechange` → `disconnected`
   dispara um timer de graça (ver `RTC-FR-004`/`005`); `failed` dispara ICE
   restart imediato.
5. **Destruição**: `call.leave`/`call.peer_left` (próprio ou do peer),
   fechamento explícito do `RTCPeerConnection`, remoção do `PeerController`
   correspondente.

## Perfect Negotiation (glare-free) — resumo (detalhe completo em `state-machines/peer.md`)

Cada par de peers tem um papel fixo e determinístico, decidido por
comparação de UUID: o peer com o UUID **menor** é `polite`, o outro é
`impolite` (`RTC-FR-002`). Isso resolve o problema clássico de "os dois
lados mandam oferta ao mesmo tempo" (glare) sem precisar de coordenação
adicional pelo servidor: o lado `polite` recua sua própria oferta pendente
e aceita a oferta recebida; o lado `impolite` ignora ofertas recebidas
enquanto tem uma oferta própria em voo. Ver `state-machines/peer.md` para a
máquina de estado completa (`stable`/`have-local-offer`/
`have-remote-offer`, e as transições de rollback).

## `PeerController`: um ator serializado por peer (`RTC-FR-003`)

Nenhuma outra parte do código toca um `RTCPeerConnection` diretamente. Toda
intenção (publicar stream, mutar, responder a um subscribe, processar um
`rtc.ice` recebido) vira uma mensagem enfileirada no `PeerController`
daquele peer específico, processada uma de cada vez. Isso elimina
condições de corrida como "subscribe chegando durante um ICE restart em
andamento" por construção, não por sorte de timing.

## ICE, STUN, TURN

- Descoberta de candidatos: host candidates (interfaces locais) sempre;
  `srflx` via STUN (endereço público refletido); `relay` via TURN quando
  necessário.
- STUN/TURN server: coturn (`infra/coturn/`), acessível publicamente na
  porta 3478 (STUN/TURN) e 5349 (TURNS/TLS).
- Credenciais TURN: de curta duração, emitidas pelo backend por HMAC
  (`RTC-FR-006`, `16-security.md`), obtidas via REST ou incluídas no
  `call.snapshot`/resposta de `call.join` — o cliente as busca no momento
  de entrar em uma call, nunca as tem hard-coded ou de longa duração.
- Ordem de prioridade ICE segue o algoritmo padrão (RFC 8445): candidatos
  host/srflx são preferidos por menor custo/latência; relay (TURN) só é
  usado quando nenhum par direto funciona — mas está **sempre disponível**
  como fallback, nunca desabilitado (`RTC-FR-007`). Isso cobre o caso comum
  de dois peers atrás de CGNAT simétrico onde hairpinning direto é
  impossível.

## Recuperação de rede: ICE restart antes de recriar (`RTC-FR-004/005`)

Mudança de rede local (Wi-Fi→Ethernet, troca de IP, adaptador de rede
trocando) é detectada pelo estado da PeerConnection transicionando para
`disconnected`/`failed`. Resposta em duas camadas:

1. **ICE restart** (`peerConnection.restartIce()` / renegociação com
   `iceRestart: true` na próxima oferta): tenta re-estabelecer conectividade
   sem descartar codecs negociados, streams ativos ou estado de assinatura.
   Até 2 tentativas consecutivas por evento de queda.
2. **Recriação completa**: se 2 ICE restarts falharem em sequência para o
   mesmo peer, o `PeerController` fecha e recria a `RTCPeerConnection` do
   zero, re-adiciona tracks locais, e restaura o estado de assinatura de
   stream (o que este peer estava enviando/recebendo é re-derivado do
   `CallRegistry` via um novo `call.snapshot` implícito ou do estado local
   retido pelo `StreamManager` do cliente).

Este comportamento é o mesmo, independente da causa raiz (troca de rede,
STUN temporariamente inacessível, perda de pacote severa) — o cliente não
tenta diagnosticar a causa antes de agir, apenas segue a escada
restart→recriar. Ver `testing/network-failure.md` para a matriz completa
de cenários testados.

## Por que não simulcast/SVC em v1

Fora de escopo v1 (`QUAL-FR-003`) — mesh P2P com H.264 single-encode já
atende ≤4 participantes; simulcast adicionaria complexidade de codificação
múltipla sem benefício claro nessa escala. Ver `15-quality-adaptation.md`.
