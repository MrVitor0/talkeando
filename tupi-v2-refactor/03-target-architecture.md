# 03 — Arquitetura alvo (v2.0)

## 1. A resposta à pergunta central

> **Qual é a única fonte de verdade do estado de sala, e como todo cliente
> converge para ela após qualquer evento anômalo?**

**O LiveKit é a única fonte de verdade sobre quem está em uma sala e quais
tracks existem.** Ele é a única entidade que sabe para quem os pacotes estão
sendo encaminhados. Qualquer estado que discorde dele está errado por
definição, porque o usuário ouve o que o LiveKit encaminha, não o que a sidebar
mostra.

Isso produz uma hierarquia estrita de três camadas:

```
                    LiveKit (SFU)
                    ── autoridade ──
      quem está na sala · quais tracks existem · quais SIDs
                          │
        ┌─────────────────┴──────────────────┐
        │ webhooks (rápido, não confiável)   │ ListRooms/ListParticipants
        │                                    │ (lento, confiável)
        ▼                                    ▼
              tupi-server: VoiceRegistry
              ── projeção replicável ──
   cache convergente do estado do LiveKit + estado que só o Tupi conhece
   (mute, deafen, quem é bot, música). Versionado por canal.
                          │
                          │ voice.room.state (snapshot versionado)
                          │ voice.room.delta  (delta versionado)
                          ▼
              Cliente: dois estados distintos
   ┌──────────────────────────┬───────────────────────────────┐
   │ Canais em que NÃO estou  │ Canal em que ESTOU            │
   │ fonte: voice.room.state  │ fonte: o próprio Room LiveKit │
   │ (projeção do servidor)   │ + overlay de mute/deafen do   │
   │                          │   servidor                    │
   └──────────────────────────┴───────────────────────────────┘
```

O ponto essencial da terceira camada: **para a call em que estou, a lista de
participantes é derivada de `room.remoteParticipants`, não do roster do
servidor.** É impossível ver um fantasma, porque a lista exibida é a mesma
estrutura de dados de onde sai o áudio. O roster do servidor entra apenas como
overlay de metadados (mute, deafen, é bot) e como fonte para os canais em que
não estou.

Isso mata o sintoma 1 estruturalmente, não por correção pontual: a divergência
deixa de ser possível porque as duas listas passam a ser a mesma lista.

## 2. Convergência após evento anômalo

Todo caminho de recuperação leva ao mesmo lugar, com prazo declarado:

| Evento anômalo | Mecanismo de convergência | Prazo máximo |
|---|---|---|
| Webhook perdido | Reconcile periódico (`ListRooms` + `ListParticipants`) | 15 s |
| Servidor reiniciado | Reconcile no boot (3 s) e por conexão | 5 s |
| WebSocket caiu e voltou | Cliente pede `voice.room.state` no `connection.state = connected` | imediato ao reconectar |
| Sessão LiveKit caiu e voltou | `RoomEvent.Reconnected` reconstrói a lista local do `Room`; cliente reanuncia sids | imediato |
| Cliente com versão de estado atrasada | Detecta lacuna em `version` e pede snapshot completo | 1 RTT |
| App fechado abruptamente | Timeout do LiveKit remove da sala, webhook ou reconcile propaga | 15 s |
| Update aplicado | Teardown gracioso antes de sair (SPEC-012); se falhar, cai no caso acima | 15 s |
| OOM/redeploy do servidor | Reconcile no boot reconstrói tudo do LiveKit | 5 s após subir |

**Nenhum caminho de convergência depende do cliente ter enviado algo.** Essa é
a diferença central em relação a hoje, onde `voice.presence.enter` é
tratado como autoridade (`server/src/ws/handler.rs:574-581`).

## 3. `VoiceRegistry` v2 — o que muda no servidor

Substitui `CallRegistry` (`server/src/ws/call_registry.rs`). Estrutura alvo:

```rust
pub struct VoiceRegistry {
    rooms: HashMap<ChannelId, VoiceRoom>,
}

pub struct VoiceRoom {
    /// Incrementa a cada mutação aceita. Clientes detectam lacunas.
    pub version: u64,
    /// Chave: identidade Tupi. Valor inclui o sid da sessão LiveKit atual.
    pub participants: HashMap<UserId, VoiceParticipant>,
    /// Chave: track_sid do LiveKit. NUNCA um UUID inventado.
    pub tracks: HashMap<TrackSid, VoiceTrack>,
    /// Última vez que este canal foi confirmado contra o LiveKit.
    pub reconciled_at: Instant,
}

pub struct VoiceParticipant {
    pub user_id: UserId,
    /// sid da sessão LiveKit. Eventos com sid mais antigo são descartados.
    pub sid: ParticipantSid,
    pub joined_at: DateTime<Utc>,
    /// Estado que só o Tupi conhece; sobrevive a reconciles.
    pub muted: bool,
    pub deafened: bool,
    pub is_bot: bool,
}

pub struct VoiceTrack {
    pub sid: TrackSid,
    pub owner: UserId,
    pub owner_sid: ParticipantSid,
    pub source: TrackSource,   // Microphone | Camera | ScreenShare | ScreenShareAudio
}
```

Três mudanças estruturais:

1. **Endereçamento por SID.** Participantes carregam o `participant_sid` da
   sessão; tracks são indexadas pelo `track_sid`. Um evento tardio referente a
   uma sessão anterior é reconhecível e descartável (mata RC-06). Uma track
   republicada tem SID novo e nunca colide com a antiga (mata RC-03).
2. **Versão por sala.** Cada mutação aceita incrementa `version`. Todo delta
   enviado ao cliente carrega `version`, e o cliente que recebe `version`
   diferente de `local + 1` pede um snapshot. Isso torna a perda de mensagem
   **detectável**, coisa que hoje é impossível.
3. **Separação entre fatos do LiveKit e fatos do Tupi.** `participants` e
   `tracks` são projeção do LiveKit e podem ser reescritos por qualquer
   reconcile. `muted`, `deafened` e `is_bot` são do Tupi e sobrevivem
   (comportamento que `reconcile` já tem hoje, `call_registry.rs:197-210`, e
   que é preservado).

### Quem pode escrever

| Origem | Pode criar/remover participante? | Pode criar/remover track? | Pode mudar mute/deafen? |
|---|---|---|---|
| Webhook do LiveKit | Sim | Sim | Não |
| Reconcile (`ListParticipants`) | Sim, autoritativo | Sim, autoritativo | Não |
| Cliente via WS (`voice.*`) | **Não** | **Não** | Sim, só do próprio usuário |
| Queda de WS | **Não** | **Não** | Não |
| `voice.disconnect_member` | Sim, via `RemoveParticipant` no LiveKit, e só depois reflete | Não | Não |

A linha "cliente não escreve presença" é a inversão central em relação a hoje.
O `voice.presence.enter` deixa de ser um upsert e vira uma **dica de
antecipação** (ver abaixo).

### Antecipação otimista sem perda de autoridade

Remover totalmente o caminho do cliente pioraria a latência percebida: hoje o
`voice.presence.enter` faz a linha aparecer na sidebar antes do webhook. A v2
mantém a antecipação, mas marcada:

- `voice.presence.enter` insere o participante com `sid = None` e
  `provisional = true`;
- um participante provisório expira em 10 s se nenhum webhook nem reconcile o
  confirmar, e some sozinho;
- qualquer reconcile substitui o provisório pelo real (ou o remove).

Assim a UI continua respondendo em menos de 100 ms, mas um cliente mentiroso ou
um `enter` que nunca virou conexão real não deixa fantasma permanente.

## 4. Protocolo v2 — princípios

Detalhe completo em `05-protocol-spec.md`. Princípios:

1. **Toda mensagem de estado de sala carrega `version` e `channel_id`.**
2. **Snapshot e delta são a mesma forma de dado**, com `full: true|false`.
3. **Ops v1 continuam funcionando** para clientes antigos, servidas pelo mesmo
   registry, sem `version` (ver `08-rollout-plan.md`).
4. **O cliente declara sua versão no `auth.hello`**; o servidor decide qual
   dialeto falar com aquela conexão.
5. **Todo evento de mídia referencia SIDs do LiveKit**, nunca UUIDs
   inventados pelo Tupi.

## 5. Cliente — as três camadas novas

### 5.1 `callSession` — máquina de estados explícita

Substitui as variáveis de módulo soltas de `client/ui/src/rtc.ts:11-19`
(`active`, `connecting`, `connectAttempt`, `presentChannelId`).

```
        ┌──────┐  join(ch)   ┌────────────┐  ok   ┌───────────┐
        │ idle ├────────────►│ connecting ├──────►│ connected │
        └──────┘             └─────┬──────┘       └─────┬─────┘
           ▲                       │ erro/cancel        │ leave / kick
           │                       ▼                    ▼
           │                 ┌───────────┐        ┌──────────────┐
           └─────────────────┤ tearing   │◄───────┤ reconnecting │
                             │   down    │        └──────────────┘
                             └───────────┘         (SDK do LiveKit)
```

Regras invioláveis da máquina:

- Toda transição carrega um `sessionId` (número monotônico). Qualquer callback,
  promise ou evento que chegue com `sessionId` diferente do atual é
  **descartado sem efeito colateral**. Isso mata RC-09 e RC-10 na raiz.
- `join` sempre passa por `tearing_down` da sessão anterior e **aguarda** o
  teardown terminar antes de criar a sala nova. Nada de `disconnect()` sem
  `await`.
- `tearing_down` é idempotente e libera todos os recursos: microfone, monitor
  de fala, `AudioContext`, elementos de mídia, captura nativa.
- `RoomEvent.Disconnected` só produz efeito visível ao usuário quando o motivo
  **não** é `CLIENT_INITIATED` (mata o sintoma 5).

### 5.2 `voiceStore` — estado de voz fora do React

Módulo com um único listener de IPC, montado uma vez no boot, com API de
assinatura (`subscribe(selector)`). Substitui os `useState` de
`App.tsx:1049-1063` e `:1103`.

Mata RC-19 (nenhum listener recriado por troca de canal, nenhuma janela sem
listener) e permite que componentes assinem apenas a fatia que usam, o que
elimina o re-render global de RC-11.

Conteúdo:

```ts
type VoiceStoreState = {
  // Canais em que NÃO estou: projeção do servidor, por channel_id.
  rooms: Map<ChannelId, { version: number; participants: RosterEntry[]; tracks: TrackEntry[] }>;
  // Canal em que ESTOU: derivado do Room do LiveKit + overlay do servidor.
  session: { state: CallState; channelId: string | null; participants: LiveParticipant[] };
  // Assinaturas de tela desejadas, com estado real reportado pelo SDK.
  watching: Map<UserId, { trackSid: string; desired: boolean; actual: SubscriptionStatus }>;
};
```

### 5.3 Renderização de vídeo com `adaptiveStream` honesto

O elemento `<video>` que o usuário vê passa a ser o elemento que o SDK conhece.
A UI deixa de criar `<video>` próprios com `srcObject` manual e passa a chamar
`track.attach(elementDoReact)` no elemento montado (e `track.detach(el)` ao
desmontar). Mata RC-12.

Consequência positiva: `adaptiveStream` volta a funcionar como projetado — uma
tela fora da viewport realmente para de consumir banda, o que importa numa VM
de 2 GB com upload limitado.

## 6. Fluxo alvo: dar tela e ver tela

```
Publicador                     Servidor                  Espectador
    │                             │                          │
    │ 1. publishScreen()          │                          │
    │    captura nativa inicia    │                          │
    │    LiveKit publica          │                          │
    │    -> track_sid S           │                          │
    │                             │                          │
    │ 2. voice.track.published    │                          │
    │    {track_sid: S}  ────────►│ dica; grava provisório    │
    │                             │                          │
    │        webhook track_published {sid: S} ───────────────►│
    │                             │ autoritativo             │
    │                             │ version++                │
    │                             │ voice.room.delta ───────►│ mostra AO VIVO
    │                             │                          │
    │                             │◄── setSubscribed(S) ─────┤ 3. clicou assistir
    │                             │  (direto no LiveKit)     │
    │                             │                          │
    │◄──── SFU pede keyframe ─────┤                          │
    │                             │                          │
    │────── frames ───────────────────────────────────────► TrackSubscribed
    │                             │                    track.attach(<video> real)
    │                             │                    adaptiveStream: visível
    │                             │                          │
    │ 4. stopSharing()            │                          │
    │    unpublish AUDIO, depois VÍDEO                       │
    │    voice.track.unpublished{track_sid: S} ─────────────►│
    │        webhook track_unpublished {sid: S} ────────────►│ remove S por SID
    │                             │ version++                │
    │                             │ voice.room.delta ───────►│ tira AO VIVO
    │                             │                          │
    │ 5. publishScreen() de novo  │                          │
    │    -> track_sid S' (novo)   │                          │
    │    nunca colide com S       │                          │
```

O passo 5 é o que hoje quebra: com `Uuid::new_v4()` por track
(`call_registry.rs:120`) e `msid` que só é preenchido se estiver vazio
(`:124`), a linha antiga sobrevive e envenena a nova. Com endereçamento por
SID, republicar é trivialmente correto.

## 7. O que **não** muda

Decisões deliberadamente preservadas, para manter o plano incremental:

- LiveKit continua sendo o SFU; nenhuma troca de stack.
- A captura nativa (GDI/WGC, shared buffer, canvas) continua como está. Os
  bugs de tela são de ciclo de vida, não de captura.
- O `music-bot` continua publicando como `Microphone`.
- O WebSocket continua sendo o canal de controle; nenhum protocolo novo de
  transporte.
- O estado de voz continua **em memória, em um processo**. Persistir em
  Postgres não resolveria nada: o LiveKit já é a fonte durável o suficiente, e
  o reconcile reconstrói tudo em segundos. Ver
  `09-alternatives-rejected.md` §3.
- Presença online/offline, chat, atividade e anexos ficam intocados.

## 8. Orçamento de recursos em 2 GB

O plano adiciona ao servidor: um `u64` por sala, um `String` de sid por
participante (cerca de 20 bytes) e um `HashMap` de tracks por sala em vez do
atual. Para 20 canais e 10 pessoas por canal, o delta de memória é da ordem de
dezenas de kilobytes. Irrelevante.

O custo real a controlar é o de CPU do reconcile: `ListRooms` seguido de um
`ListParticipants` **por sala** (`server/src/livekit.rs:341-351`) a cada 15 s.
Com 20 canais isso são 21 requisições HTTP a cada 15 s, mesmo com todos vazios.
A v2 corrige isso pulando salas cujo `reconciled_at` é recente e que não
tiveram eventos, e agrupando a chamada por sala ativa apenas (SPEC-004 §5).

Limites explícitos de memória por container entram em SPEC-016, para que um
pico do `music-bot` nunca escolha o `livekit-server` ou o `tupi-server` como
vítima do OOM killer.
