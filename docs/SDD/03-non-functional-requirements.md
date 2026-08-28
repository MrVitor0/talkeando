# 03 — Non-Functional Requirements

Status: Decidido
Owner/Domain: Transversal
Requisitos: `PERF-NFR-*`, `SEC-NFR-*`, `OBS-NFR-*`, `AUTH-NFR-*`, `AUDIO-NFR-*`, `CHAT-NFR-*`
Ver também: `02-requirements.md` (definições formais dos IDs), `16-security.md`,
`21-observability.md`, `26-risks-and-tradeoffs.md`

## Objetivo

Detalhar o "como medir" e "o que fazer quando não cumprido" para os
requisitos não-funcionais listados em `02-requirements.md`. Este documento
não redefine IDs — apenas os explica em profundidade.

## Contexto

Talkeando opera em escala fixa e pequena (≤10 usuários, ≤4 participantes por
call de voz/vídeo simultânea, um único processo de backend). Isso significa
que os NFRs aqui **não são sobre escalar**, são sobre **correção sob
condições de rede ruins** (Wi-Fi doméstico, CGNAT, quedas de conexão) e
sobre **não vazar segredos nem estado inconsistente**.

## Performance (`PERF-NFR-*`)

| Métrica | Alvo | Medido em |
|---|---|---|
| Round-trip de chat (`PERF-NFR-001`) | <300ms p95 | tempo entre `chat.message.create` recebido pelo servidor e `chat.message.created` entregue a todos os outros clientes conectados |
| Latência de áudio (`PERF-NFR-002`, `AUDIO-NFR-001`) | <150ms end-to-end p95 | captura→rede→playback, P2P direto (sem TURN relay); com TURN relay, alvo relaxa para <250ms — documentar diferença na UI apenas como qualidade de conexão, não como erro |
| Responsividade de UI (`PERF-NFR-003`) | sem frame >50ms bloqueado na thread de UI do WebView2 | negociação RTC e uploads rodam fora da thread de renderização (workers/async no lado C# e no lado React) |
| Capacidade (`PERF-NFR-004`) | 10 usuários concorrentes, 4 participantes de call simultânea, mesh de 6 PeerConnections | sem requisito de escala horizontal — é um teto de projeto, não uma meta a otimizar além disso |

Não há orçamento de performance para compartilhamento de tela em resolução
4K a 60fps — v1 assume até 1080p30 como caso comum; ver `15-quality-adaptation.md`
para o que acontece acima disso (adaptação para baixo, nunca travamento).

## Confiabilidade e recuperação

- **Reconexão de WS não corrompe estado** (`WS-FR-002`): um cliente que
  reconecta com a mesma sessão nunca aparece duplicado na presença nem no
  `CallRegistry`. Ver `state-machines/websocket.md` para a máquina de estado
  exata e `testing/network-failure.md` para os cenários testados.
- **ICE restart antes de recriar** (`RTC-FR-004`/`005`): a primeira resposta
  a uma mudança de rede é sempre ICE restart; recriação completa da
  `RTCPeerConnection` só ocorre após 2 falhas consecutivas de restart para o
  mesmo peer, para evitar descartar uma call inteira por uma falha
  transitória de ICE.
- **Backend é processo único** — não há requisito de alta disponibilidade
  do backend em v1; um restart do backend derruba todas as calls ativas
  (estado é in-memory, `DB-FR-002`) mas não corrompe dados persistidos
  (chat, membros, canais). Isso é um trade-off aceito, não um bug — ver
  `26-risks-and-tradeoffs.md`.

## Segurança (`SEC-NFR-*`, `AUTH-NFR-*`)

Detalhado em `16-security.md`. Resumo dos alvos mensuráveis:
- TLS 1.2+ obrigatório em toda superfície REST/WS pública (`SEC-NFR-001`).
- DTLS-SRTP obrigatório em toda mídia RTC — não há modo "sem criptografia"
  configurável (`SEC-NFR-002`).
- Credenciais TURN expiram em ≤24h (parâmetro configurável, default
  documentado em `16-security.md`) e são derivadas por HMAC-SHA1 do usuário
  autenticado no momento da entrada na call (`SEC-NFR-003`).
- Rate limit de login: 10 tentativas/min por combinação IP+username
  (`AUTH-NFR-004`); acima disso, HTTP 429 com corpo de erro genérico.

## Observabilidade (`OBS-NFR-*`)

Detalhado em `21-observability.md`. Todo NFR de observabilidade é verificado
por inspeção de log em ambiente de dev/staging, não por métrica automatizada
em v1 (não há requisito de dashboard/alerting em v1 — ver
`28-open-questions.md` para se isso deve mudar em P2).

## Manutenibilidade

- Migrations SQLx são a única forma de alterar schema — nunca `ALTER TABLE`
  manual em produção (`DB-FR-001`).
- Toda mensagem WS nova ou alterada precisa atualizar simultaneamente
  `09-websocket-protocol.md`, `contracts/websocket-events.md` e os schemas em
  `protocol/` — os três são a mesma fonte de verdade em três formatos
  (prosa, contrato, schema versionado) e não podem divergir.

## Compatibilidade

- Windows 10 1809+ / Windows 11 (requisito mínimo do WebView2 Runtime e do
  `Windows.Graphics.Capture`). Não há suporte a versões de Windows anteriores
  em v1 — se `Windows.Graphics.Capture` não estiver disponível, screen share
  fica indisponível com mensagem explícita na UI (o fallback GDI é
  documentado como seam futuro em `14-screen-share-pipeline.md`, não
  implementado).
