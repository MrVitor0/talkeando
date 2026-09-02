# 07 — Plano de testes

Três camadas: unidade (rápida, roda em todo commit), integração (roda no CI com
Postgres real e LiveKit falso ou real) e manual multiusuário (roda antes de
cada promoção de beta para stable).

## 1. Unidade — servidor (`server/src/ws/voice_registry.rs`, `#[cfg(test)]`)

Rodam com `cargo test --locked`. Sem I/O, sem banco.

| # | Teste | Verifica |
|---|---|---|
| U-01 | `webhook_join_then_stale_left_keeps_participant` | INV-B2: `participant_left` com sid antigo é ignorado |
| U-02 | `webhook_left_with_current_sid_removes_participant_and_tracks` | remoção completa e correta |
| U-03 | `republish_track_uses_new_sid_and_old_is_removed` | INV-B1, RC-03 |
| U-04 | `track_unpublished_for_unknown_sid_is_noop` | não corrompe estado |
| U-05 | `hidden_participant_from_reconcile_is_filtered` | INV-B3, RC-07 |
| U-06 | `provisional_expires_after_ten_seconds` | INV-A2 |
| U-07 | `provisional_is_confirmed_by_webhook_without_duplicating` | não cria duas linhas |
| U-08 | `leaving_hint_does_not_remove_confirmed_participant` | INV-A1, o núcleo do sintoma 1 |
| U-09 | `leaving_hint_removes_provisional_participant` | a exceção permitida |
| U-10 | `reconcile_preserves_mute_deafen_and_viewers` | estado só do Tupi sobrevive |
| U-11 | `reconcile_removes_participants_livekit_no_longer_lists` | convergência |
| U-12 | `reconcile_is_noop_when_in_sync_and_does_not_bump_version` | INV-C2: versão não infla à toa |
| U-13 | `version_increases_by_one_per_accepted_mutation` | INV-C2 |
| U-14 | `room_finished_does_not_clear_room` | RC-04 |
| U-15 | `duplicate_webhook_event_id_is_ignored` | dedupe |
| U-16 | `music_row_survives_track_reconcile` | não quebrar o bot |
| U-17 | `v1_stream_dto_projection_is_stable_across_broadcasts` | `stream_id` determinístico (protocolo §6) |
| U-18 | `channel_full_is_computed_from_confirmed_non_bot_participants` | INV-F2 |

## 2. Unidade — cliente (`client/ui/src/*.test.ts`, vitest)

| # | Arquivo | Teste | Verifica |
|---|---|---|---|
| U-20 | `voiceStore.test.ts` | `applies delta in fixed order` | protocolo §2.2 |
| U-21 | `voiceStore.test.ts` | `requests snapshot on version gap` | INV-C2 |
| U-22 | `voiceStore.test.ts` | `accepts lower version as server restart` | armadilha do protocolo §2.1 |
| U-23 | `voiceStore.test.ts` | `ignores duplicate delta` | idempotência |
| U-24 | `callSession.test.ts` | `superseded join does not emit error` | INV-C3, INV-C4, RC-09 |
| U-25 | `callSession.test.ts` | `teardown releases every registered resource` | INV-D1 |
| U-26 | `callSession.test.ts` | `join failure after connect still tears down and resets channel` | RC-10 |
| U-27 | `callSession.test.ts` | `client initiated disconnect never surfaces` | INV-C4, sintoma 5 |
| U-28 | `screenPublisher.test.ts` | `stop then start serializes and bumps capture generation` | INV-D2, RC-16 |
| U-29 | `screenPublisher.test.ts` | `unpublish removes audio before video and both complete` | RC-15 |
| U-30 | `spectator.test.ts` | `spectate room is never assigned to the call room` | INV-D3, RC-08 |
| U-31 | `spectator.test.ts` | `stopSpectate disconnects the spectator room` | RC-08 |

Os testes de cliente usam um duplo de `Room` do LiveKit (objeto com
`EventEmitter` e os métodos usados), não a biblioteca real. Definido em
`client/ui/src/testing/fakeRoom.ts`, criado em SPEC-007.

## 3. Integração — servidor (`server/tests/voice_test.rs`)

Usa o harness existente (`server/tests/common/mod.rs`), que já sobe o router
real contra um Postgres real. Precisa de duas capacidades novas, criadas em
SPEC-006:

1. `TestApp::send_webhook(event)` — monta um corpo de webhook e assina com o
   `livekit_api_secret` de teste (`server/tests/common/mod.rs:70`), exatamente
   como `livekit::verify_webhook` espera (`server/src/livekit.rs:224-240`).
2. `TestApp::with_fake_livekit(rooms)` — um servidor HTTP local que responde
   `ListRooms` e `ListParticipants` com um estado controlado pelo teste, com o
   `livekit_url` do config apontando para ele.

| # | Teste | Cenário e asserção |
|---|---|---|
| I-01 | `webhook_join_appears_in_roster_for_whole_community` | webhook `participant_joined`; outro membro recebe `voice.room.delta` com o participante |
| I-02 | `ws_disconnect_keeps_voice_presence` | cliente A entra por webhook, fecha o WS, espera 10 s; B ainda vê A. **INV-A3, sintoma 1** |
| I-03 | `leave_hint_does_not_evict_confirmed_participant` | A confirmado manda `voice.presence.hint leaving`; B ainda vê A até o reconcile confirmar a saída. **INV-A1** |
| I-04 | `reconcile_removes_participant_livekit_dropped` | fake LiveKit deixa de listar A; em um tick, B recebe delta de remoção |
| I-05 | `reconcile_restores_state_after_registry_wipe` | limpa o registry, roda reconcile, roster volta idêntico. **Sintoma 2** |
| I-06 | `stale_participant_left_is_ignored` | join sid2, depois left sid1; A continua. **INV-B2** |
| I-07 | `republish_screen_swaps_track_sid` | `track_published` S1, `track_unpublished` S1, `track_published` S2; roster final tem só S2. **Sintoma 4** |
| I-08 | `out_of_order_republish_keeps_new_track` | `track_published` S2 chega **antes** de `track_unpublished` S1; final tem só S2 |
| I-09 | `hidden_participant_never_in_roster` | fake LiveKit lista participante com `permission.hidden`; roster não o inclui. **INV-B3** |
| I-10 | `room_finished_triggers_reconcile_not_wipe` | `room_finished` com participantes ainda listados no fake; roster permanece. **RC-04** |
| I-11 | `duplicate_webhook_is_idempotent` | mesmo evento duas vezes; `version` sobe uma vez só |
| I-12 | `version_gap_request_returns_full_snapshot` | cliente pede `voice.room.request`; recebe `full: true` |
| I-13 | `v1_client_receives_voice_rooms_and_roster` | conexão sem `protocol_version` recebe ops v1 e nenhuma op v2. **INV-E3** |
| I-14 | `v2_client_receives_only_v2_room_ops` | conexão v2 não recebe `voice.roster` |
| I-15 | `v1_stream_id_is_stable_across_two_broadcasts` | mesmo compartilhamento, dois eventos, mesmo `stream_id`. **Protocolo §6** |
| I-16 | `track_hint_from_non_owner_is_rejected` | A tenta despublicar track de B; erro e estado intacto. **INV-F1, A1** |
| I-17 | `presence_hint_for_foreign_channel_is_rejected` | usuário fora da comunidade; `forbidden`. **A2** |
| I-18 | `token_refused_when_channel_full` | 10 confirmados; 11º recebe `409 channel_full`. **INV-F2** |
| I-19 | `disconnect_member_calls_remove_participant_and_waits_for_webhook` | verifica que o registry não remove localmente antes do webhook |
| I-20 | `move_member_schedules_reconcile_of_both_channels` | ambos os canais aparecem no próximo reconcile |
| I-21 | `debug_endpoint_requires_owner` | membro comum recebe `403` |

## 4. Integração ponta a ponta — `integration/sfu/run.cjs` v2

Roda contra servidor local e LiveKit local em Docker (`infra/docker-compose.yml`
já tem o serviço). Fora do CI, executado manualmente antes de cada release
(SPEC-017 reescreve o runner).

| # | Roteiro | Asserção |
|---|---|---|
| E-01 | Três contas entram no mesmo canal em sequência | cada uma vê as outras em `voice.room.state`, e `room.remoteParticipants` bate com a lista |
| E-02 | A sai fechando o WS abruptamente (`terminate`) sem sair do LiveKit | B e C **continuam** vendo A. Antes da v2 este teste falharia |
| E-03 | A desconecta a mídia do LiveKit sem avisar o WS | B e C deixam de ver A em até 20 s (reconcile) |
| E-04 | A publica tela, despublica, publica de novo, 5 vezes | após cada publicação, o `track_sid` no roster é o atual, e B consegue assinar e receber frames |
| E-05 | Servidor é reiniciado com 3 pessoas em call | após o boot, todos voltam ao roster em até 20 s, sem ninguém reenviar nada |
| E-06 | A troca de canal 10 vezes em 5 segundos | estado final consistente; nenhum erro emitido; A aparece em exatamente um canal |
| E-07 | Cliente v1 simulado (sem `protocol_version`) junto de dois v2 | todos convergem para o mesmo conjunto de participantes |

## 5. Roteiros manuais multiusuário

Executados com pessoas reais, em máquinas reais, antes de promover beta para
stable. Cada roteiro tem passos numerados e critério objetivo. Anotar
versão do cliente e horário para cruzar com os logs.

### M-01 — Fantasma de canal (sintoma 1) — 3 pessoas

1. A, B e C abrem o app. A entra no canal Alpha.
2. B entra em Alpha. C observa a sidebar sem entrar.
3. A confirma que ouve B; B confirma que ouve A.
4. A **sai** de Alpha pelo botão de desconectar.
5. Em até 3 s: a linha de A some da sidebar de B e de C.
6. B fala. A **não** ouve nada. C não vê A em canal nenhum.
7. A entra de novo em Alpha. Em até 3 s, todos veem A de novo.
8. Repetir 5 vezes seguidas.

**Aprovado se:** em nenhuma repetição alguém ouve uma pessoa que não está na
lista, nem vê alguém que não está na call. **Este é o critério de aceite do
sintoma 1.**

### M-02 — Compartilhamento repetido (sintoma 4) — 3 pessoas

1. A, B, C no canal Alpha.
2. A compartilha a tela inteira, com áudio.
3. B clica em assistir. Em até 3 s vê a tela de A em movimento.
4. C clica em assistir. Em até 3 s vê a mesma coisa.
5. A para de compartilhar. B e C veem a tela sumir em até 3 s.
6. A compartilha de novo, **outra fonte** (uma janela).
7. B clica em assistir. Em até 3 s vê a nova janela.
8. Repetir os passos 5 a 7 **cinco vezes**.
9. Durante uma das repetições, B minimiza a janela do app por 10 s e restaura.

**Aprovado se:** nenhuma repetição resulta em tela preta permanente, overlay de
carregamento que não sai, ou botão de assistir que não faz nada. No passo 9, o
vídeo volta em até 3 s após restaurar.

### M-03 — Rede e sono — 2 pessoas

1. A e B no canal Alpha, conversando.
2. A desliga o Wi-Fi por 20 s e religa.
3. A volta a ouvir B em até 15 s, sem clicar em nada.
4. B vê A sair e voltar, ou não vê A sair. Nunca vê A permanentemente ausente.
5. A fecha a tampa do notebook por 2 minutos e reabre.
6. Em até 30 s, o estado de ambos é consistente e o áudio funciona.

**Aprovado se:** nenhum passo exige reiniciar o app, e ao fim os dois se ouvem.

### M-04 — Preview "AO VIVO" (sintoma 4) — 3 pessoas

1. A e B no canal Alpha. A compartilha tela.
2. C **não entra** em canal nenhum. C passa o mouse sobre a linha de A.
3. Em até 3 s aparece o preview com a tela de A em movimento.
4. C tira o mouse. O preview some.
5. C **não** aparece na sidebar de A nem de B, em momento nenhum. **INV-B3**
6. C repete o hover 5 vezes.
7. C clica em "AO VIVO". C entra no canal e vê a tela no palco em até 5 s.
8. C sai do canal. Volta ao passo 2 e repete o hover: ainda funciona.

**Aprovado se:** o passo 5 nunca falha e o passo 8 funciona depois do ciclo.

### M-05 — Troca rápida de canal (sintoma 5) — 2 pessoas

1. A abre o app. B está no canal Alpha.
2. A clica em Alpha, Beta, Gamma, Alpha, Beta em sequência rápida, sem esperar
   a conexão completar.
3. Ao parar, A está conectado exatamente em Beta e ouve quem estiver lá.
4. Nenhum banner de erro apareceu, em particular nenhum com o texto
   "client initiated disconnect". **INV-C4**
5. B vê A em exatamente um canal, o correto.
6. Repetir 5 vezes.

### M-06 — Mover e desconectar membro — 3 pessoas, uma delas owner

1. A (owner), B e C. B em Alpha, C em Beta.
2. A arrasta B para Beta. Em até 3 s, B está em Beta na tela de todos, e B
   ouve C.
3. A arrasta C para Alpha. Mesmo critério.
4. A desconecta B pelo menu de contexto. Em até 3 s, B saiu na tela de todos e
   B não ouve mais ninguém.
5. B entra de novo sozinho. Funciona normalmente.

### M-07 — Restart do app com call ativa (sintoma 2) — 3 pessoas

1. A, B e C em Alpha, conversando.
2. A fecha o app pelo X da janela.
3. B e C veem A sair em até 20 s. Enquanto A não sai da lista, ninguém ouve A.
4. A reabre o app.
5. Ao terminar de carregar, A vê B e C listados em Alpha na sidebar, **sem
   entrar no canal**. Este é o passo que falha hoje.
6. A entra em Alpha. Ouve B e C imediatamente. Todos veem A.

### M-08 — Auto-update com call ativa — 2 pessoas

1. A e B em Alpha. Publicar uma versão beta nova.
2. A recebe a notificação, baixa e clica em reiniciar.
3. B vê A sair em até 20 s.
4. A volta com a versão nova, entra em Alpha, e tudo funciona.
5. Nenhum erro "A conexão de voz foi encerrada" aparece para A depois do
   restart. **RC-18**

### M-09 — Carga (10 pessoas) — o teste de flicker (sintoma 3)

1. 10 pessoas entram em Alpha, uma a cada 2 s.
2. Cada uma observa a sidebar durante todo o processo.
3. Duas pessoas ligam a câmera. Uma compartilha tela. Três assistem.
4. Uma pessoa sai e entra 5 vezes.

**Aprovado se:** nenhum tile de vídeo pisca ou volta ao estado de carregamento
enquanto o vídeo está fluindo; a sidebar não "salta"; o uso de CPU do app fica
abaixo de 25% em uma máquina típica.

### M-10 — Convivência de versões (version skew)

1. A com a build atual de produção (v1). B e C com a build v2.
2. Todos entram em Alpha.
3. Cada um vê os outros dois corretamente.
4. B compartilha tela. A consegue assistir. C consegue assistir.
5. A sai. B e C veem A sair em até 5 s.
6. A compartilha tela. B e C conseguem assistir.

**Aprovado se:** nenhuma combinação de versões produz roster divergente.

## 6. Checklist de revisão por spec

Antes de aprovar qualquer PR deste plano, o revisor confirma:

- [ ] Todo recurso criado no diff tem destruição garantida em todos os
      caminhos, inclusive `catch` e early return (INV-D1).
- [ ] Nenhum `Uuid::new_v4()` novo no caminho de tracks de mídia (INV-B1).
- [ ] Nenhuma mutação de presença confirmada fora de `apply_webhook` e
      `apply_reconcile` (INV-A1).
- [ ] Todo campo novo de protocolo é opcional na leitura (INV-E2).
- [ ] Toda mutação do registry loga com os campos obrigatórios (INV-G1).
- [ ] Nenhum callback assíncrono altera estado sem checar `sessionId` ou
      `version` (INV-C3, INV-C2).
- [ ] `cargo test --locked` verde; `npm run build` e `npm test` em
      `client/ui` verdes; `dotnet test` verde quando o diff toca o nativo.

## 7. Ordem de execução dos testes no CI

`deploy-production.yml` já roda `cargo test --locked` e `npm test` do music-bot
no job `validate`. SPEC-006 adiciona `voice_test.rs` ao mesmo job (não precisa
de LiveKit real: usa o fake HTTP local).

SPEC-007 adiciona um passo novo ao mesmo job: `npm ci && npm test` em
`client/ui`. Hoje o build do UI só roda em `release-windows-client.yml`, o que
significa que um erro de tipo em `client/ui` só é descoberto na hora de gerar
release. Corrigir isso é parte do plano.
