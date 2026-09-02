# 04 — Invariantes do sistema

Um invariante é uma afirmação que precisa ser verdadeira em todo instante
observável, em todo caminho de execução, inclusive nos caminhos de erro. Cada
um tem um ID, o local onde é imposto, e como é verificado. Specs referenciam
esses IDs.

Regra de ouro para o executor: **se uma mudança sua pode tornar um invariante
falso em algum caminho, a mudança está errada, mesmo que os testes passem.**

---

## Grupo A — Autoridade e fonte de verdade

### INV-A1 — O LiveKit é a única autoridade sobre presença de mídia

Nenhum caminho de código pode remover ou inserir um participante **confirmado**
no `VoiceRegistry` sem que essa mudança tenha origem em um webhook do LiveKit,
em um reconcile contra o LiveKit, ou em uma chamada `RemoveParticipant` feita
pelo próprio servidor.

- **Imposto em:** `server/src/ws/voice_registry.rs` (novo), que só expõe
  mutação de presença por `apply_webhook` e `apply_reconcile`.
- **Proibido:** qualquer op de WebSocket chamar diretamente uma função que
  remova participante confirmado.
- **Verificação:** teste `ws_leave_does_not_evict_confirmed_participant`
  (SPEC-006). Revisão: `grep` por chamadas de mutação fora dos dois métodos.
- **Violado hoje em:** `server/src/ws/handler.rs:592`, `:234-236`,
  `routes/livekit.rs:53`.

### INV-A2 — Um participante provisório nunca sobrevive mais de 10 segundos sem confirmação

Um participante inserido por `voice.presence.enter` (`provisional = true`,
`sid = None`) precisa ser confirmado por webhook ou reconcile em até 10 s, ou é
removido automaticamente.

- **Imposto em:** varredura no mesmo tick do reconcile (a cada 15 s, com
  verificação de idade), mais verificação a cada `apply_reconcile`.
- **Verificação:** teste `provisional_participant_expires_without_confirmation`
  (SPEC-006).

### INV-A3 — A perda de um WebSocket nunca altera presença de mídia

Fechar, perder ou dar timeout em um WebSocket não pode remover ninguém de
nenhuma sala de voz. Só afeta presença online/offline e estado de atividade.

- **Imposto em:** `handler.rs`, removendo o laço de `evict_voice_participant`
  do caminho de desconexão.
- **Verificação:** teste `ws_disconnect_keeps_voice_presence` (SPEC-006).
- **Violado hoje em:** `server/src/ws/handler.rs:234-236`.

---

## Grupo B — Identidade e endereçamento

### INV-B1 — Toda track é endereçada pelo `track_sid` do LiveKit

O `VoiceRegistry` nunca gera identificador próprio para uma track de mídia. A
chave do mapa de tracks é o `track_sid`. Nenhum `Uuid::new_v4()` no caminho de
tracks de mídia.

- **Exceção única e explícita:** a linha de música do bot (`kind: "music"`), que
  é uma marcação de UI sem track correspondente, mantém um id sintético
  documentado como tal.
- **Verificação:** revisão de código; teste
  `republish_screen_produces_new_sid_and_removes_old` (SPEC-006).
- **Violado hoje em:** `server/src/ws/call_registry.rs:120`, `:128`, `:552`.

### INV-B2 — Toda sessão de participante é endereçada pelo `participant_sid`

Um evento (webhook ou dica de cliente) que se refira a um `participant_sid`
diferente do sid atualmente registrado para aquele usuário é **descartado**, não
aplicado.

- **Exceção:** um evento de `join` com sid novo substitui o registro anterior
  (é uma reconexão legítima).
- **Verificação:** teste `stale_participant_left_is_ignored` (SPEC-006).
- **Violado hoje em:** `server/src/livekit.rs:211-217` (o sid nem é decodificado).

### INV-B3 — Espectadores nunca aparecem em nenhum roster

Um participante do LiveKit com `permission.hidden == true` é filtrado em todos
os caminhos: reconcile, webhook e projeção para o cliente.

- **Verificação:** teste `hidden_participant_is_never_in_roster` (SPEC-006);
  roteiro manual M-04 (`07-test-plan.md`).
- **Violado hoje em:** `server/src/livekit.rs:352-373`.

---

## Grupo C — Consistência cliente/servidor

### INV-C1 — Se eu ouço alguém, essa pessoa está na minha lista de participantes

Para o canal em que o cliente está, a lista exibida é derivada de
`room.remoteParticipants` mais o próprio usuário. Não existe caminho em que a
UI mostre uma lista construída de outra fonte para a call ativa.

Este é o invariante que mata o sintoma 1. Ele é garantido **por construção**:
as duas coisas passam a ser a mesma estrutura de dados.

- **Imposto em:** `client/ui/src/voiceStore.ts` (novo), campo `session.participants`.
- **Verificação:** roteiro manual M-01; teste de unidade
  `session participants mirror room.remoteParticipants` (SPEC-008).
- **Violado hoje em:** `client/ui/src/App.tsx:1380-1383`.

### INV-C2 — Toda mensagem de estado de sala é versionada e a perda é detectável

Todo `voice.room.state` e `voice.room.delta` carrega `version: u64` monotônico
por canal. O cliente que receber um delta cujo `version` não seja
`versãoLocal + 1` descarta o delta e pede snapshot completo.

- **Verificação:** teste `client requests snapshot on version gap` (SPEC-008);
  teste de servidor `version increases monotonically per room` (SPEC-006).

### INV-C3 — Toda operação de sessão carrega um `sessionId`, e resultados obsoletos são descartados

Nenhum callback, `then`, `catch` ou handler de evento do LiveKit pode alterar
estado global sem verificar que o `sessionId` que ele carrega ainda é o atual.

- **Imposto em:** `client/ui/src/callSession.ts` (novo).
- **Verificação:** teste `superseded join does not surface an error` (SPEC-007);
  roteiro manual M-05 (trocar de canal rapidamente 10 vezes).
- **Violado hoje em:** `client/ui/src/rtc.ts:288-321`.

### INV-C4 — O usuário nunca vê erro causado por uma ação própria de desconexão

Um `RoomEvent.Disconnected` com `reason == CLIENT_INITIATED`, ou uma rejeição de
`connect()` causada por um `disconnect()` que nós mesmos pedimos, nunca produz
banner de erro.

- **Verificação:** roteiro manual M-05; teste de unidade em SPEC-007.
- **Violado hoje em:** `client/ui/src/App.tsx:2177-2185` combinado com
  `client/ui/src/rtc.ts:280`.

---

## Grupo D — Ciclo de vida de recursos

### INV-D1 — Todo recurso criado tem exatamente um caminho de destruição, alcançável em todos os caminhos de saída

Aplica-se a: `Room` do LiveKit, `MediaStreamTrack`, `AudioContext`,
`AnalyserNode`, `requestAnimationFrame` pendente, elementos de mídia no DOM,
`MediaStreamTrackGenerator`, `WritableStreamDefaultWriter`, threads de captura
nativa (`ScreenCapture`, `AudioCapture`), e o `HTMLCanvasElement` de captura.

Regra concreta: o único lugar que destrói é `callSession.teardown(sessionId)`, e
ele é chamado em: leave explícito, erro de join, kick, `Disconnected` não
solicitado, troca de canal e shutdown do app.

- **Verificação:** teste `teardown releases every tracked resource` (SPEC-007);
  checklist de revisão em `07-test-plan.md` §5.
- **Violado hoje em:** `client/ui/src/rtc.ts:315-321` (não limpa `active` nem
  `presentChannelId`), `:181-199` (elementos órfãos), `:314` (AudioContext).

### INV-D2 — Parar de compartilhar tela libera captura nativa antes de qualquer nova captura começar

`stopSharing` só retorna depois que o host nativo confirmou parada, e uma nova
`publishScreen` não pode iniciar enquanto a anterior não terminou.

- **Imposto em:** uma promessa serializada no publicador de tela (SPEC-010),
  com `captureGeneration` incrementado a cada início.
- **Verificação:** roteiro manual M-02 (dar/parar tela 5 vezes seguidas).
- **Violado hoje em:** `client/ui/src/nativeScreen.ts:167-177` combinado com
  `client/native/Talkeando.Client/ScreenCapture.cs:244-251`.

### INV-D3 — A sala de espectador nunca é a sala da call

A referência de sala usada para publicar (microfone, câmera, tela) nunca pode
apontar para uma sala conectada com token `mode: "spectator"`.

- **Imposto em:** duas referências separadas em `callSession`, com tipos
  distintos.
- **Verificação:** teste `spectate never becomes the active call room` (SPEC-011).
- **Violado hoje em:** `client/ui/src/rtc.ts:404`.

---

## Grupo E — Protocolo e compatibilidade

### INV-E1 — Nenhuma op existente muda de semântica sem mudar de nome

Se o comportamento de uma op v1 precisa mudar, cria-se uma op v2 nova. A op v1
mantém exatamente o comportamento que os clientes já instalados esperam, até a
janela de compatibilidade expirar (`08-rollout-plan.md`).

- **Verificação:** revisão de `05-protocol-spec.md` na tabela de compatibilidade.

### INV-E2 — Todo campo novo é opcional na leitura

Serde com `#[serde(default)]` no servidor, `?:` no TypeScript. Um payload sem o
campo novo precisa ser processável.

- **Verificação:** teste `v1 client payloads still parse` (SPEC-006).

### INV-E3 — O servidor conhece a versão de protocolo de cada conexão

`auth.hello` carrega `protocol_version` e `client_version`; a conexão guarda
esses valores e todo envio de estado de sala respeita o dialeto correspondente.

- **Verificação:** teste `v1 hello receives v1 ops only` (SPEC-006).

---

## Grupo F — Autorização

### INV-F1 — Nenhuma op de voz altera estado de outro usuário sem verificação de permissão

Especificamente: `voice.track.unpublished` só pode afetar tracks cujo dono é o
remetente; `voice.presence.*` só afeta o próprio remetente; `voice.move_member`
e `voice.disconnect_member` exigem owner (exceto o bot, que qualquer membro
pode desconectar).

- **Verificação:** testes `track_unpublish_by_non_owner_is_rejected` e
  `presence_leave_for_foreign_channel_is_rejected` (SPEC-006).
- **Violado hoje em:** `server/src/ws/handler.rs:615-624` (nenhuma verificação),
  `:584-593` (nenhuma verificação de membership).

### INV-F2 — O limite de participantes por canal é aplicado na emissão do token

O servidor recusa emitir token de `participant` para um canal que já tem o
número máximo de participantes não-bot confirmados.

- **Nota:** o limite hoje existe no código morto (`call_registry.rs:303`,
  chamado só de `handler.rs:1120`, dentro de bloco comentado) e o LiveKit tem
  `room.max_participants: 12` (`infra/livekit/livekit.yaml.tmpl:16`). A v2
  aplica no token para dar erro claro em vez de falha de conexão opaca.
- **Verificação:** teste `token_is_refused_when_channel_is_full` (SPEC-004).

---

## Grupo G — Observabilidade

### INV-G1 — Toda mutação do `VoiceRegistry` é logada com contexto suficiente para reconstruir a sequência

Campos obrigatórios: `channel_id`, `user_id`, `participant_sid` quando houver,
`source` (webhook, reconcile, ws, admin), `version_antes`, `version_depois`,
`resultado` (applied, ignored_stale, ignored_duplicate).

- **Verificação:** revisão de código; SPEC-002.

### INV-G2 — O estado corrente do `VoiceRegistry` é inspecionável em produção sem redeploy

Existe um endpoint autenticado que devolve o registry inteiro em JSON.

- **Verificação:** SPEC-002.

---

## Tabela de rastreabilidade

| Invariante | Specs que passam a garantir |
|---|---|
| INV-A1 | 003, 004, 005 |
| INV-A2 | 003, 005 |
| INV-A3 | 005 |
| INV-B1 | 003, 004 |
| INV-B2 | 003, 004 |
| INV-B3 | 004 |
| INV-C1 | 008 |
| INV-C2 | 003, 005, 008 |
| INV-C3 | 007 |
| INV-C4 | 007 |
| INV-D1 | 007, 009 |
| INV-D2 | 010 |
| INV-D3 | 011 |
| INV-E1 | 001, 005 |
| INV-E2 | 001, 005 |
| INV-E3 | 001 |
| INV-F1 | 005 |
| INV-F2 | 004 |
| INV-G1 | 002 |
| INV-G2 | 002 |
