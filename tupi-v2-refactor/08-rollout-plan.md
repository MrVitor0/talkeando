# 08 — Plano de rollout

## 1. Princípio

O servidor sobe primeiro e sozinho, falando os dois dialetos. Só depois o
cliente muda. Em nenhum momento existe uma janela em que uma versão do servidor
exige uma versão do cliente.

Isso é obrigatório aqui porque o auto-update do Velopack não é instantâneo: um
usuário que não abrir o app por uma semana continua na versão antiga. O
servidor precisa servir os dois indefinidamente até que os dados de
`GET /api/debug/voice` mostrem que ninguém mais usa v1.

## 2. Ordem de deploy

```
Fase A — servidor (specs 001 a 006)
  │  push em main dispara .github/workflows/deploy-production.yml
  │  clientes existentes (v1) continuam funcionando sem alteração
  │  ganho imediato: correções de RC-01/04/05/06/07 já aplicam ao v1
  ▼
Fase B — cliente beta (specs 007 a 014)
  │  tag v1.x.y-beta.N dispara release-windows-client.yml canal beta
  │  2 ou 3 testadores; convivência real de v1 e v2 exercitada
  ▼
Fase B2 — cliente stable
  │  tag v1.x.y dispara canal stable após M-01 a M-10 aprovados
  ▼
Fase C — periféricos e limpeza (specs 015 a 018)
     bot, infra, harness e remoção do código v1 só depois que
     GET /api/debug/voice não listar mais nenhuma conexão v1 por 14 dias
```

### Por que a Fase A já entrega valor sozinha

Mesmo com todos os clientes ainda em v1, a Fase A corrige:

- RC-04: `room_finished` deixa de apagar canais com gente dentro;
- RC-05: a queda do WebSocket deixa de evictar da voz, o que resolve o
  "sumiu todo mundo depois do deploy";
- RC-06: eventos de webhook obsoletos deixam de remover quem está presente;
- RC-07: espectadores deixam de virar participantes fantasmas;
- RC-03 parcialmente: o `stream_id` projetado para v1 passa a ser
  determinístico e o `msid` passa a refletir a track atual, o que já melhora o
  caso "dei tela duas vezes" mesmo em cliente antigo.

Ou seja, os sintomas 1 e 4 melhoram antes de qualquer cliente ser atualizado.
Isso é deliberado: reduz risco e dá sinal antecipado.

## 3. Compatibilidade de protocolo, decisão por decisão

| Mudança | Estratégia de skew | Risco residual |
|---|---|---|
| `auth.hello` ganha campos | Campos opcionais com `#[serde(default)]`. Cliente v1 não envia; servidor assume `protocol_version: 1` | Nenhum |
| `auth.ok` ganha campos | Cliente v1 ignora campos desconhecidos (`JSON.parse` do JS) | Nenhum |
| `voice.room.state` / `.delta` novas | Só enviadas para conexões com `negotiated == 2` | Nenhum |
| `voice.rooms` / `voice.roster` mantidas | Emitidas para conexões v1, derivadas do mesmo registry | Divergência de projeção; coberto por I-13 e I-15 |
| `voice.presence.enter/leave` v1 | Traduzidas para `voice.presence.hint` | **`leave` deixa de remover imediatamente.** Ver §4 |
| `voice.track.published/unpublished` v1 sem `track_sid` | Descartadas com log | Cliente v1 muito antigo que não mandava `track_sid` perde a projeção rápida de "está compartilhando"; o webhook cobre em menos de 1 s |
| `stream.publish/unpublish` do bot | Inalteradas | Nenhum |
| `POST /api/livekit/token` passa a poder devolver `409` | Cliente v1 mostra a mensagem de erro genérica do `ReadJsonAsync` (`NetworkClient.cs:644-654`), que já lê `message` | Mensagem em português já vem pronta do servidor |

### 3.1 Onde o cliente v1 fica pior temporariamente

Um único ponto: ao sair de um canal, a linha do usuário some da sidebar dos
outros em até 2 s (reconcile agendado) em vez de instantaneamente.

Isso é aceito conscientemente. A alternativa (manter `leave` como remoção
autoritativa para v1) preservaria o sintoma 1 exatamente como está hoje para
todos os clientes v1, que serão a maioria durante toda a Fase A. Trocar
"instantâneo mas às vezes fantasma" por "2 segundos e sempre correto" é o ponto
inteiro deste plano.

Mitigação implementada em SPEC-005: quando o servidor recebe uma dica de
`leaving` de um participante confirmado, ele agenda o reconcile daquele canal
para 2 s **e** chama `RemoveParticipant` no LiveKit se o cliente enviou
`participant_sid`. Como o cliente v1 não envia sid, ele fica no caminho de 2 s.

## 4. Feature flags

Duas flags, ambas por variável de ambiente no servidor, ambas com default
seguro. Nenhuma flag no cliente: o cliente é versionado pelo instalador, e uma
flag lá só criaria uma matriz de estados a mais para testar.

| Flag | Default | Efeito | Quando desligar |
|---|---|---|---|
| `TUPI_VOICE_PROTOCOL_V2` | `true` | Quando `false`, `MAX_SERVER_PROTOCOL` vira 1 e nenhuma conexão negocia v2 | Se a Fase B revelar um problema no dialeto v2, sem precisar de rollback do servidor |
| `TUPI_VOICE_LEAVE_HINT_AUTHORITATIVE` | `false` | Quando `true`, restaura o comportamento v1 de `leave` remover imediatamente | Escotilha de emergência se o atraso de 2 s se mostrar inaceitável antes da Fase B |

Ambas lidas em `server/src/config.rs` no mesmo padrão das existentes
(`env::var(...).ok().filter(...)`), e ambas expostas em
`GET /api/debug/voice` para que o operador saiba o estado real.

Nota deliberada: **não** há flag para o reconcile nem para o endereçamento por
SID. Essas mudanças são a correção; torná-las opcionais criaria dois caminhos
de código para manter e testar, exatamente o problema que o plano ataca.

## 5. Rollback

| Fase | Como reverter | Tempo | Perda |
|---|---|---|---|
| A | `git revert` do merge e push em `main`; o workflow reconstrói e redeploya | ~12 min (build do server) | Volta aos bugs atuais |
| A, emergência | `TUPI_VOICE_PROTOCOL_V2=false` em `/opt/talkeando/infra/livekit.env` e `docker compose up -d tupi-server` | ~1 min | Só desliga o dialeto v2 |
| B | Publicar de novo a tag anterior no canal beta; Velopack faz downgrade pelo feed | ~15 min | Testadores voltam |
| B2 | Publicar de novo a versão anterior como stable | ~15 min | Todos voltam na próxima abertura do app |
| C | `git revert`; a Fase C só remove código morto e ajusta infra | ~12 min | Nenhuma |

Ponto de atenção no rollback da Fase B2: o Velopack aplica o que o feed indica
como mais recente. Republicar a versão anterior exige incrementar o SemVer
(por exemplo, se v1.5.0 quebrou, publicar v1.5.1 com o código de v1.4.x), não
apagar a release ruim. O workflow atual
(`.github/workflows/release-windows-client.yml`) já suporta isso via
`workflow_dispatch` com `version` explícito.

## 6. Critérios de promoção entre fases

### A para B

- [ ] `cargo test --locked` verde, incluindo os 21 testes de `voice_test.rs`.
- [ ] Deploy em produção há pelo menos 48 h.
- [ ] `GET /api/debug/voice` acessível e mostrando estado coerente.
- [ ] Taxa de drift do reconcile abaixo de 0,10 nas últimas 24 h
      (`06-observability.md` §2).
- [ ] Nenhum relato novo de "sumiu todo mundo" no período.
- [ ] `?live=1` mostrando diferença vazia entre LiveKit e registry em três
      amostras aleatórias.

### B para B2

- [ ] Roteiros M-01 a M-10 executados e aprovados com a build beta.
- [ ] Pelo menos 3 dias de uso real por 2 ou mais testadores.
- [ ] Zero ocorrências de `watch.stalled` nos logs de cliente coletados.
- [ ] Zero banners "client initiated disconnect" reportados.
- [ ] M-10 (convivência de versões) aprovado explicitamente.

### B2 para C

- [ ] 14 dias corridos sem nenhuma conexão com `protocol_version: 1` em
      `GET /api/debug/voice`.
- [ ] Nenhum relato aberto dos sintomas 1 a 5.

## 7. Comunicação com os usuários

Duas mensagens no canal de texto da comunidade, escritas pelo operador:

1. Antes da Fase B: "vamos publicar uma versão beta que muda como o Tupi
   controla quem está em cada canal; se você notar alguém demorando 2 segundos
   a mais para sumir da lista ao sair, é esperado".
2. Antes da Fase B2: "a atualização de estabilidade sai hoje; se algo de voz
   ou tela ficar estranho, use Configurações e Enviar diagnóstico antes de
   reiniciar o app" (o botão vem de SPEC-014).

O segundo aviso é operacionalmente importante: reiniciar o app apaga o ring
buffer de diagnóstico.

## 8. Riscos de rollout e mitigação

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| A projeção v1 diverge da v2 e clientes antigos veem coisa errada | Média | Alto | Testes I-13, I-15; a projeção é derivada do mesmo estado, não paralela |
| O reconcile de 15 s não é rápido o bastante e o usuário percebe o atraso de saída | Média | Médio | Reconcile dirigido de 2 s em `leaving`; flag de emergência |
| O `?live=1` sobrecarrega o LiveKit se alguém ficar chamando | Baixa | Baixo | Restrito a owner; rate limit de 1 por 10 s |
| Velopack aplica update no meio de um roteiro de teste e invalida o resultado | Média | Baixo | `TUPI_DISABLE_AUTO_UPDATE=1` durante os testes (`IpcBridge.cs:46`) |
| A VM de 2 GB não aguenta os testes de 10 pessoas (M-09) | Média | Alto | SPEC-016 antes de M-09; monitorar `docker stats` durante o roteiro |
