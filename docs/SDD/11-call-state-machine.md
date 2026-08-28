# 11 — Call State Machine

Status: Decidido
Owner/Domain: Backend (`CallRegistry`) + Cliente
Requisitos: `CALL-FR-*`, `WS-FR-002`, `RTC-FR-008`
Ver também: `06-backend-architecture.md`, `state-machines/call.md` (máquina
de estado formal, diagrama de transições), `09-websocket-protocol.md`

## Objetivo

Definir os estados possíveis de uma call (a nível de canal de voz) e de um
participante dentro dela, e as regras de transição — em particular como
uma call sobrevive a reconexão de WS sem duplicar ou perder participantes.

## Contexto

Uma "call" existe apenas enquanto há ≥1 participante em um canal de voz;
não há conceito de call "agendada" ou "vazia mas existente" — o
`CallRegistry.calls` (`HashMap<ChannelId, ActiveCall>`) simplesmente não
tem uma entrada para um canal sem ninguém dentro. A entrada é criada no
primeiro `call.join` e removida no `call.leave` que zera os participantes.

## Estados de uma `ActiveCall` (nível canal)

```
[inexistente] ──call.join (1º participante)──▶ [ativa, N participantes]
[ativa, N participantes] ──call.join (N+1)──▶ [ativa, N+1 participantes]
[ativa, N participantes] ──call.leave (último)──▶ [inexistente]
[ativa, N participantes] ──call.leave (não-último)──▶ [ativa, N-1 participantes]
```

Não há estado "pausada" ou "encerrada com histórico" — calls não deixam
rastro persistido (`DB-FR-002`). O único "histórico" observável é o que
já foi dito no chat de texto do canal, que é uma entidade separada.

## Estados de um `ParticipantState`

```
                    call.join
                       │
                       ▼
             ┌──────────────────┐
             │   connecting      │  (RTC handshake em andamento com os demais peers)
             └──────┬───────────┘
                     │ pelo menos 1 PeerConnection chega a "connected"
                     ▼
             ┌──────────────────┐   call.self_update (muted/deafened toggles)
             │     joined        │◀──────────────────────────────────┐
             │ (muted?, deafened?)│───────────────────────────────────┘
             └──────┬───────────┘
                     │ WS drop (sem call.leave explícito)
                     ▼
             ┌──────────────────┐
             │  grace_period     │  (participante continua listado; RTC pode
             │  (timeout curto)  │   seguir tentando ICE restart independente)
             └──────┬───────────┘
           reconecta dentro       excede o timeout
           do grace period              │
                     │                  ▼
                     ▼           ┌──────────────────┐
             volta a "joined"    │   removido        │──▶ call.peer_left broadcast
             (sem novo            │ (equivalente a    │
              peer_joined         │  call.leave       │
              broadcast)          │  implícito)       │
                                  └──────────────────┘
```

`connecting` é um estado observado principalmente pela UI local (barra de
"conectando..." por peer, `UX-FR-005`) — o servidor não modela
"connecting" vs "joined" separadamente no `ParticipantState`; a distinção é
inteiramente local ao cliente, derivada do estado agregado das suas
`RTCPeerConnection`s com os demais participantes.

## Reconexão de WS não duplica nem perde participante (`WS-FR-002`, `CALL-FR-005`)

Este é o comportamento mais importante deste documento. Regras exatas:

1. Quando um `WsConnId` cai, o servidor **não remove imediatamente** o
   participante correspondente de nenhuma `ActiveCall` — apenas marca
   internamente que aquela conexão está "possivelmente morta" e inicia um
   timer de graça (default documentado em `18-ux-spec.md`, ex. 15s — tempo
   suficiente para cobrir uma reconexão de WS rápida sem esperar tanto que
   o call pareça travado para os outros).
2. Se o cliente reconecta com **a mesma sessão** (mesmo `user_id`) dentro
   do timer, o servidor apenas atualiza o `connection_id` no
   `ParticipantState` existente — nenhum `call.peer_left`/`call.peer_joined`
   é emitido, e o cliente que reconectou recebe um `call.snapshot` fresco
   para resincronizar seu estado local (streams podem ter mudado enquanto
   ele estava caído).
3. Se o timer expira sem reconexão, **então** o participante é removido
   de verdade e `call.peer_left` é emitido aos demais — equivalente a um
   `call.leave` implícito.
4. O cliente que caiu e reconectou também precisa resincronizar seu lado
   RTC: as `RTCPeerConnection`s com os demais peers não são fechadas só
   porque o WS de sinalização caiu (elas são independentes do WS, ver
   `10-webrtc-architecture.md`) — mas se o ICE também caiu por conta da
   mesma causa de rede, o mecanismo de ICE restart cuida disso
   independentemente (`RTC-FR-004`). O que a reconexão de WS resincroniza é
   **o estado de aplicação** (quem está na call, quais streams existem),
   não necessariamente a conectividade de mídia em si.

## Autorização de toda transição (`CALL-FR-006`)

Toda mensagem que causa uma transição acima é validada contra o
`CallRegistry` antes de ser aplicada:
- `call.join`: usuário deve ser membro da comunidade e o canal deve ser
  `kind = voice`.
- `call.leave`/`call.self_update`: usuário deve já ser um participante da
  call referenciada.
- Qualquer falha vira `error` tipado, nunca um panic e nunca um estado
  parcialmente aplicado (mutações no `CallRegistry` são funções puras que
  retornam `Result` — ver `06-backend-architecture.md`).

## Ver também

`state-machines/call.md` traz o diagrama de estado formal completo,
incluindo o cruzamento com o estado de stream (o que acontece com streams
publicados quando o dono do stream cai e volta dentro do grace period —
resposta curta: o stream permanece publicado, pois `PublishedStream`
pertence à `ActiveCall`, não ao `WsConnId`).
