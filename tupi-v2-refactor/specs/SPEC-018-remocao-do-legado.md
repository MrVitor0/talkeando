# SPEC-018 — Remoção do caminho legado e atualização da documentação

## 1. Problema

**Causa raiz:** A4 (mais de 600 linhas de código morto de mesh comentadas em
`server/src/ws/handler.rs`), mais a dívida acumulada pelas specs anteriores
(dois registries coexistindo, projeção v1, documentação descrevendo um sistema
que não existe mais).

Estado ao chegar aqui:

- `server/src/ws/call_registry.rs` (650 linhas) não é mais escrito por ninguém
  desde SPEC-004, mas continua compilando e confundindo;
- blocos comentados em `handler.rs` (`:364-447`, `:1090-1201`, `:1514-1752`)
  descrevem o mesh, removido em `104faea`;
- `server/src/ws/projection.rs` existe só para clientes v1;
- `docs/SDD/` descreve o protocolo pré-SFU: `09-websocket-protocol.md` lista
  `call.join`, `rtc.offer`, `stream.subscribe`, todos inexistentes;
- `docs/SDD/12-stream-subscription-model.md` se declara "a especificação mais
  importante e mais não-negociável de todo o projeto" e descreve o modelo de
  `viewers` do mesh, que o SFU tornou obsoleto.

Documentação errada é pior que ausente: ela é lida e seguida.

## 2. Prioridade e dependências

- **Prioridade:** P2
- **Dependências:** todas as anteriores, mais o critério de rollout de
  `08-rollout-plan.md` §6: **14 dias sem nenhuma conexão com
  `protocol_version: 1` em `GET /api/debug/voice`.**

Não iniciar antes de verificar esse critério. Remover a projeção v1 cedo demais
quebra quem não abriu o app por duas semanas.

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `server/src/ws/call_registry.rs` | remover |
| `server/src/ws/handler.rs` | remover blocos comentados e ops v1 |
| `server/src/ws/hub.rs` | remover o campo `calls` |
| `server/src/ws/projection.rs` | remover |
| `server/src/ws/protocol.rs` | remover DTOs v1 de voz |
| `server/src/ws/mod.rs` | ajustar módulos |
| `client/ui/src/voiceStore.ts` | remover o caminho v1 |
| `music-bot/index.js` | remover o fallback v1 |
| `docs/SDD/09-websocket-protocol.md` | reescrever |
| `docs/SDD/12-stream-subscription-model.md` | substituir por nota de obsolescência |
| `docs/SDD/10-webrtc-architecture.md`, `11-call-state-machine.md`, `14-screen-share-pipeline.md` | atualizar |
| `docs/SDD/contracts/websocket-events.md` | reescrever |
| `docs/SDD/flows/*.md` | atualizar `join-call`, `leave-call`, `reconnect` |
| `docs/sfu-migration/` | marcar como histórico |
| `README.md` | atualizar a seção de arquitetura |
| `protocol/README.md` | apontar para a spec v2 |

## 4. Mudança especificada

### 4.1 Ordem de remoção

Executar nesta ordem, cada passo compilando e com testes verdes:

1. **Blocos comentados de `handler.rs`.** Puramente textual, sem risco.
   Remover `:364-447` (`teardown_call_membership`,
   `teardown_spectator_subscriptions`), `:1090-1201` (`handle_call_join`) e
   `:1514-1752` (`relay_rtc`, `handle_stream_*`).
2. **Ops v1 de entrada.** Remover os braços de tradução de SPEC-005 §4.2:
   `voice.presence.enter`, `voice.presence.leave`, `voice.track.published`,
   `voice.track.unpublished`, `voice.rooms.request`. Passam a cair no
   `unknown_op`, que o cliente já ignora silenciosamente
   (`client/ui/src/App.tsx:1542`).
3. **Ops v1 de saída.** Remover `broadcast_to_max_version` do `publish_room_change`
   e `send_voice_room_state`, mais os DTOs `VoiceRoster`, `VoiceRoomsSnapshot`,
   `VoiceRosterEntry` e `StreamDto` de `protocol.rs`.
4. **`projection.rs`.** Some junto com o passo 3.
5. **`call_registry.rs`.** Remover o arquivo, o campo `calls` do `Hub`
   (`hub.rs:19`) e o `pub mod call_registry` de `mod.rs`.
6. **Caminho v1 do cliente.** Em `voiceStore.ts`, remover `applyV1Rooms`,
   `applyV1Roster` e `fromV1`; `hasFeature("voice.room.v2")` passa a ser
   assumido.
7. **Fallback v1 do bot.** Em `sendPresenceHint` (SPEC-015 §4.2), remover o
   ramo `else`.
8. **`MAX_SERVER_PROTOCOL`.** Continua em 2. A negociação permanece: ela é o
   mecanismo para a **próxima** mudança de protocolo, não um artefato desta.

Os passos 6 e 7 só valem se o servidor tiver o passo 3 aplicado, o que exige
que servidor e clientes sejam promovidos juntos. Como o critério de entrada
desta spec já garante que não há clientes v1, é seguro.

### 4.2 Verificação de que nada quebrou

Depois de cada passo:

```bash
cd server && cargo test --locked
cd client/ui && npm run build && npm test
cd music-bot && npm test
```

E, ao final, o harness completo de SPEC-017.

Uma verificação extra vale a pena no passo 5: `grep -rn "call_registry\|CallRegistry" server/`
precisa devolver zero linhas fora de comentários históricos.

### 4.3 Documentação: o que reescrever e o que aposentar

A regra: **um documento que descreve um sistema que não existe é apagado ou
marcado, nunca deixado como está.**

| Documento | Ação | Por quê |
|---|---|---|
| `docs/SDD/09-websocket-protocol.md` | Substituir o conteúdo por um apontador para `tupi-v2-refactor/05-protocol-spec.md` | O protocolo v2 já está especificado; duas fontes divergem |
| `docs/SDD/contracts/websocket-events.md` | Idem | Lista `rtc.offer`, `call.join`, `stream.subscribe`, todos inexistentes |
| `docs/SDD/12-stream-subscription-model.md` | Cabeçalho de obsolescência, conteúdo preservado abaixo | Descreve o invariante "0 viewers, 0 bytes" do mesh; no SFU quem faz isso é o `dynacast`. Vale preservar como registro de decisão histórica |
| `docs/SDD/10-webrtc-architecture.md` | Cabeçalho de obsolescência mais apontador para `03-target-architecture.md` | Descreve a malha P2P |
| `docs/SDD/11-call-state-machine.md` | Reescrever com a máquina de `callSession` (SPEC-007 §5.1) | A máquina mudou de verdade |
| `docs/SDD/14-screen-share-pipeline.md` | Atualizar a seção de publicação e assinatura | A captura nativa continua igual; o transporte mudou |
| `docs/SDD/flows/join-call.md`, `leave-call.md`, `reconnect.md` | Reescrever | Descrevem offer/answer/ICE e `call.join` |
| `docs/SDD/state-machines/peer.md`, `stream.md` | Remover | Descrevem entidades do mesh que não existem |
| `docs/SDD/state-machines/websocket.md` | Manter, adicionar a negociação de versão | Continua correto |
| `docs/sfu-migration/` | Adicionar `README.md` com cabeçalho "Concluída em `104faea`; mantida como registro histórico" | É um plano executado, não uma especificação viva |
| `docs/SDD/31-implementation-status.md` | Atualizar com o estado real pós-v2 | Está datado de 2026-08-26 e descreve marcos do mesh |

Modelo do cabeçalho de obsolescência, para consistência:

```markdown
> **OBSOLETO.** Este documento descreve a arquitetura de malha P2P, substituída
> pelo SFU (LiveKit) em `104faea` e revista na v2.0. Mantido como registro da
> decisão original. Para o sistema atual, ver
> `tupi-v2-refactor/03-target-architecture.md` e
> `tupi-v2-refactor/05-protocol-spec.md`.
```

### 4.4 O destino de `tupi-v2-refactor/`

Ao concluir esta spec, o plano deixa de ser um plano e vira a documentação do
sistema. Duas opções foram consideradas; a escolhida:

**Mover `01-current-architecture.md`, `03-target-architecture.md`,
`04-invariants.md`, `05-protocol-spec.md` e `06-observability.md` para
`docs/SDD/`, renomeando `03` para descrever o presente (não mais "alvo").**
Os demais (`00`, `02`, `07`, `08`, `09` e `specs/`) permanecem em
`tupi-v2-refactor/` como registro de execução, com um cabeçalho de conclusão no
`00-README.md`.

Justificativa: invariantes e protocolo precisam estar onde alguém procura
documentação do sistema, não em uma pasta com nome de projeto. A análise de
causa raiz e as specs são história e devem continuar acessíveis, mas não são
referência corrente.

Renomeações concretas:

| De | Para |
|---|---|
| `tupi-v2-refactor/03-target-architecture.md` | `docs/SDD/04-system-architecture.md` (substituindo o atual) |
| `tupi-v2-refactor/04-invariants.md` | `docs/SDD/15-invariants.md` (novo) |
| `tupi-v2-refactor/05-protocol-spec.md` | `docs/SDD/09-websocket-protocol.md` (substituindo) |
| `tupi-v2-refactor/06-observability.md` | `docs/SDD/16-observability.md` (novo) |
| `tupi-v2-refactor/01-current-architecture.md` | permanece, com cabeçalho "estado anterior à v2.0" |

Ao mover, corrigir os links relativos internos. Um `grep -rn "tupi-v2-refactor/"`
no repositório mostra todos os pontos a ajustar, incluindo os comentários de
código que as specs mandaram escrever (por exemplo o de
`voice_registry.rs`, SPEC-003 §4.1).

### 4.5 `README.md` da raiz

A seção "Architecture" (linhas 33 a 48) descreve a estrutura de diretórios e
está correta. A lista de features menciona "LiveKit SFU voice", correto.

Adicionar uma linha na seção de arquitetura apontando para os documentos de
referência:

```markdown
Documentação de referência: `docs/SDD/04-system-architecture.md` (arquitetura),
`docs/SDD/09-websocket-protocol.md` (protocolo), `docs/SDD/15-invariants.md`
(invariantes que qualquer mudança precisa preservar).
```

### 4.6 `protocol/README.md`

Cinco linhas hoje. Adicionar o apontador para o protocolo v2 e a nota de que os
schemas de envelope continuam válidos (o envelope não mudou, só o conteúdo).

## 5. Contratos de dados

Nenhum novo. Esta spec **remove** os contratos v1, o que é uma mudança
incompatível deliberada, protegida pelo critério de entrada de §2.

## 6. Casos de borda a tratar

1. Um cliente v1 aparecendo depois dos 14 dias (alguém que não abriu o app por
   um mês): ele recebe `unknown_op` para as ops v1 e não vê roster nenhum. A
   sidebar de voz fica vazia, o resto do app funciona, e o auto-update o
   atualiza na próxima abertura. Degradação aceitável e explicitada.
2. Rollback do servidor para antes desta spec com clientes v2: funciona, porque
   o servidor anterior fala os dois dialetos.
3. Rollback **desta** spec depois de um mês: o `git revert` restaura a projeção
   v1 sem problema, já que ela não depende de estado.
4. Links quebrados após mover os documentos: verificar com um `grep` de
   `](.*\.md)` nos arquivos movidos e nos que os referenciam.
5. Comentários de código apontando para caminhos que mudaram: o mesmo `grep` de
   `tupi-v2-refactor/` cobre.
6. `docs/SDD/README.md` (índice) listando documentos removidos: atualizar.

## 7. Critérios de aceite

- **Dado** o critério de entrada, **então** `GET /api/debug/voice` mostrou zero
  conexões `protocol_version: 1` por 14 dias corridos, e isso está registrado
  no PR.
- **Dado** `grep -rn "CallRegistry" server/src`, **então** zero resultados.
- **Dado** `grep -rn "voice.roster\|voice.rooms" server/src`, **então** zero
  resultados fora de comentários históricos.
- **Dado** `cargo test --locked`, `npm run build`, `npm test` e o harness de
  SPEC-017, **então** todos verdes.
- **Dado** qualquer documento em `docs/SDD/`, **então** ele descreve o sistema
  atual ou traz o cabeçalho de obsolescência.
- **Dado** um desenvolvedor novo lendo `docs/SDD/09-websocket-protocol.md`,
  **então** ele encontra o protocolo v2, não o do mesh.
- **Dado** `handler.rs`, **então** ele tem menos de 1100 linhas (hoje 1752, com
  cerca de 650 comentadas).

## 8. Como testar

### Automatizado

Nenhum teste novo. A suíte existente é a verificação: se remover código morto
quebra um teste, o código não estava morto.

Verificação mecânica:

```bash
# Nada deve restar do registry antigo.
grep -rn "CallRegistry\|call_registry" server/ --include=*.rs

# Nenhuma op v1 de voz no servidor.
grep -rn '"voice.presence.enter"\|"voice.roster"\|"voice.rooms"' server/src

# Nenhum link quebrado nos documentos movidos.
grep -rn "tupi-v2-refactor/" --include=*.md --include=*.rs --include=*.ts .
```

### Manual

1. Rodar o app completo em desenvolvimento (`dev.cmd`) com dois clientes e
   exercitar M-01, M-02 e M-05 de `07-test-plan.md` §5. Nada pode ter
   regredido.
2. Ler `docs/SDD/09-websocket-protocol.md` do começo ao fim e conferir contra
   o comportamento real de duas ou três ops. Documentação só vale se for
   verificada.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| Remover cedo demais e quebrar um cliente esquecido | Critério de entrada de 14 dias, verificado por dado, não por suposição |
| Remover código que parecia morto mas não estava | Suíte de testes; remoção em passos separados, cada um com testes verdes |
| Perder registro de decisões históricas ao apagar documentos | Cabeçalho de obsolescência em vez de exclusão, exceto para `state-machines/peer.md` e `stream.md`, que descrevem entidades inexistentes |
| Mover documentos quebrar links | `grep` obrigatório nos critérios de aceite |

**Rollback:** `git revert`. Como o servidor anterior falava os dois dialetos,
reverter é seguro em qualquer momento.

## 10. Fora de escopo

- Não remover a negociação de versão (ela serve a mudanças futuras).
- Não remover `GET /api/debug/voice` nem a observabilidade.
- Não refatorar `App.tsx` além do que as specs anteriores já fizeram.
- Não tocar em chat, presença, atividade, anexos, música ou importação do
  Discord.
- Não remover `docs/investigations/` nem `docs/discord-*`, que são registros de
  outros assuntos.
