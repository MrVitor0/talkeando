# Tupi v2.0 — Plano de refatoração para confiabilidade de conexão

> Escopo: voz, tela, câmera, roster de canais de voz, mover/desconectar membros,
> reconexão (rede, sleep, restart do app, auto-update). Formato SDD: este diretório
> é o contrato de execução; nada aqui depende de "avaliar na hora".

## Como usar este plano

1. Leia `01-current-architecture.md` para entender o que existe hoje (com
   caminhos de arquivo e linhas). Não pule: as specs assumem esse vocabulário.
2. Leia `02-root-cause-analysis.md`. Cada causa raiz tem um ID (`RC-nn`) que
   as specs referenciam. Sintomas do usuário mapeados em `RC` no final do doc.
3. Leia `03-target-architecture.md` e `04-invariants.md`. Eles respondem "quem é
   a fonte de verdade" e o que nunca pode ser violado. Toda spec cita os
   invariantes que passa a garantir.
4. Execute as specs de `specs/` **na ordem numérica**. Cada uma é um PR
   separado, mergeável sozinho, com o produto funcionando entre elas.
5. `05-protocol-spec.md` é a referência única de payloads. Se uma spec e o
   protocolo divergirem, o protocolo vence e a spec deve ser corrigida.
6. `06-observability.md`, `07-test-plan.md`, `08-rollout-plan.md` são
   transversais; cada spec aponta para as seções relevantes.
7. `09-alternatives-rejected.md` registra o que foi considerado e descartado.
   Não reabra essas decisões durante a execução.

## Ordem de execução e fases

| Fase | Specs | Alvo | Deploy |
|---|---|---|---|
| A — servidor (aditivo, compatível com clientes antigos) | 001, 002, 003, 004, 005, 006 | Rust `server/` | `deploy-production.yml` (push em `main`) |
| B — cliente (canal beta primeiro) | 007, 008, 009, 010, 011, 012, 013, 014 | `client/ui`, `client/native` | `release-windows-client.yml` canal `beta`, depois `stable` |
| C — periféricos e limpeza | 015, 016, 017, 018 | music-bot, infra, harness, remoção de legado | conforme cada spec |

Dependências estão declaradas em cada spec (campo **Dependências**). Nenhuma
spec depende de uma posterior.

## Lista de specs

| ID | Título | Prioridade | Resolve |
|---|---|---|---|
| SPEC-001 | Handshake de protocolo v2 e versão do cliente no `auth.hello` | P0 | RC-14 (base para skew) |
| SPEC-002 | Observabilidade do servidor de voz (eventos, métricas, endpoint de debug) | P0 | RC-13 |
| SPEC-003 | `VoiceRegistry` v2: estado endereçado por SID do LiveKit e versionado | P0 | RC-01, RC-02, RC-03, RC-05 |
| SPEC-004 | Webhook v2: sids, dedupe, `room_finished` via reconcile dirigido, participantes ocultos | P0 | RC-01, RC-04, RC-06, RC-07 |
| SPEC-005 | Ops de socket v2 (`participant_sid`, payloads versionados, desconexão WS não mexe em voz) | P0 | RC-01, RC-05, RC-08 |
| SPEC-006 | Testes de integração do servidor para voz (webhook assinado falso + WS) | P0 | verificação de 003–005 |
| SPEC-007 | Cliente: máquina de estados `callSession` (join/leave/reconexão sem races) | P0 | RC-09, RC-10 |
| SPEC-008 | Cliente: `voiceState` versionado + roster da própria call derivado do `Room` | P0 | RC-01, RC-02, RC-11 |
| SPEC-009 | Cliente: pipeline de vídeo remoto sem `adaptiveStream` oculto (assistir tela/câmera) | P0 | RC-12 |
| SPEC-010 | Cliente: máquina de estados do publicador de tela (start/stop/restart/trocar fonte) | P0 | RC-03, RC-15, RC-16 |
| SPEC-011 | Cliente: ciclo de vida do spectator (preview "AO VIVO") | P0 | RC-17 |
| SPEC-012 | Cliente+nativo: shutdown gracioso, apply de update, reanúncio pós-reconexão com sids | P1 | RC-08, RC-18 |
| SPEC-013 | Cliente: performance de render e flicker (speaking, memo, chaves estáveis) | P1 | RC-11, RC-19 |
| SPEC-014 | Cliente: diagnóstico local (ring buffer) e `POST /api/client-logs` | P1 | RC-13 |
| SPEC-015 | Music bot alinhado ao protocolo v2 | P1 | RC-05 (bot) |
| SPEC-016 | Infra: LiveKit/compose/limites de memória em 2 GB | P1 | RC-20 |
| SPEC-017 | Harness de integração `integration/sfu` v2 | P1 | verificação ponta a ponta |
| SPEC-018 | Remoção do caminho legado + atualização de docs | P2 | dívida |

## Critério de sucesso da v2.0

Com 2 a 10 pessoas, repetidamente e em sequência, sem reiniciar nada:

- entrar/sair/trocar de canal: todo cliente mostra exatamente quem está em
  cada canal em até 2 s (rede saudável) e converge em até 30 s após qualquer
  anomalia (queda de rede, sleep, restart do app, update, redeploy do servidor);
- se um cliente ouve alguém, esse alguém está na lista da call desse cliente
  (invariante `INV-C1`);
- dar tela / parar / dar de novo, N vezes: todo espectador vê a nova tela em
  até 3 s após clicar em assistir; nunca "carregando" indefinido;
- preview "AO VIVO" funciona de fora e de dentro do canal, e nunca cria
  participante fantasma;
- mover/desconectar membro: efeito visível em todos os clientes em até 2 s;
- nenhum erro "Client initiated disconnect" exibido ao usuário em fluxos de
  sair/entrar.

## Verificação do plano

Checagens feitas antes de considerar este plano pronto para execução.

### Cobertura dos sintomas relatados

| Sintoma | Causas raiz mapeadas | Specs que resolvem |
|---|---|---|
| **1 [P0]** Fantasmas na UI, áudio continua | RC-01, RC-02, RC-04, RC-05, RC-06, RC-07, RC-10, RC-19 | 003, 004, 005, 007, 008, 011 |
| **2 [P1]** Estado perdido após restart | RC-05, RC-18, RC-01 | 003, 005, 012 |
| **3 [P1]** Flicker ao entrar e sair | RC-11, RC-19, RC-02, RC-04 | 005, 008, 013 |
| **4 [P0]** Screenshare quebrado | RC-12, RC-03, RC-15, RC-16, RC-17, RC-07, RC-08 | 003, 004, 009, 010, 011 |
| **5 [P1]** "client initiated disconnect" | RC-09, RC-08, RC-10, RC-18 | 007, 011, 012 |

Os 20 IDs `RC-01` a `RC-20` de `02-root-cause-analysis.md` estão todos
referenciados em pelo menos uma spec. Os 20 invariantes `INV-A1` a `INV-G2` de
`04-invariants.md` estão todos atribuídos a specs na tabela de rastreabilidade
daquele documento.

### Grafo de dependências

Toda dependência aponta para uma spec anterior; não há ciclo nem dependência
para a frente.

```
001 ← 002 ← 003 ← 004 ← 006
  ↖   ↖     ↖     ↖
   \   \     005 ←┘
    \   \     ↑
     \   \    ├── 007 ← 009 ← 010
      \   \   │      ↖     ↖
       \   \  │       └ 011 ← 012
        \   \ │            ↖
         \   └┴── 008 ← 013
          \        ↖
           └────── 014
                   015, 017 (← 005)
016 e 018: sem dependência técnica de código
```

`SPEC-016` não tem dependência técnica, mas deve rodar antes do roteiro manual
M-09. `SPEC-018` depende de um critério operacional (14 dias sem clientes v1),
não de código.

### Version skew

Toda mudança de protocolo tem estratégia declarada em `08-rollout-plan.md` §3,
com uma linha por mudança. O mecanismo é `SPEC-001` (negociação no
`auth.hello`) mais projeção dupla no servidor (`SPEC-005` §4.5), e o servidor
fala os dois dialetos até o critério de `SPEC-018` ser satisfeito.

A única regressão funcional aceita para clientes antigos está documentada em
`08-rollout-plan.md` §3.1: sair de um canal passa a levar até 2 s em vez de ser
instantâneo.

### Fonte de verdade

Respondida em `03-target-architecture.md` §1: **o LiveKit**, com o servidor
como projeção convergente e o cliente derivando a call ativa do próprio `Room`.
Os caminhos de convergência e seus prazos estão na tabela de §2 do mesmo
documento.

## Convenções

- Caminhos são relativos à raiz do repositório.
- "Servidor" = `server/` (Rust, axum). "UI" = `client/ui` (React). "Nativo" =
  `client/native/Talkeando.Client` (WPF/WebView2). "SFU" = LiveKit
  `livekit/livekit-server:v1.9.12` (`infra/docker-compose.production.yml`).
- `MUSIC_BOT_ID = 00000000-0000-0000-0000-000000000001`.
- Todo novo campo de protocolo é opcional na leitura (serde `#[serde(default)]`,
  TypeScript `?:`) para conviver com versões antigas (ver `08-rollout-plan.md`).
