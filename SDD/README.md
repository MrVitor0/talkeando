# Talkeando — Software Design Documentation (SDD)

Status: Living document set — v1 baseline
Owner/Domain: Whole product
Fonte canônica: as decisões técnicas neste conjunto de documentos derivam de
um único documento de decisões canônicas (`sdd-canon.md`, mantido fora do
repositório pelo autor original da arquitetura). Nenhum arquivo aqui pode
contradizer essa fonte. Onde uma decisão do canon é citada, ela é tratada
como definitiva, não como sugestão.

## O que é este conjunto de documentos

Talkeando é um app desktop Windows, tipo Discord, privado, para uma
comunidade fixa de até ~10 pessoas. Backend em Rust/Axum (plano de controle
apenas — nunca toca bytes de mídia), cliente nativo em C#/.NET 6 + WebView2,
UI em React/TypeScript, voz/vídeo/tela P2P via SIPSorcery (mesh completo,
sem SFU). Este diretório é a documentação de design de software completa:
qualquer engenheiro (ou LLM) deve conseguir implementar qualquer parte do
sistema lendo os documentos relevantes aqui, sem precisar redescobrir a
arquitetura por conta própria.

## Como navegar

Os documentos numerados (`00`–`30`) na raiz de `SDD/` formam a espinha
dorsal, na ordem recomendada de leitura para quem está chegando ao projeto
pela primeira vez. Os subdiretórios contêm material de referência mais
denso, referenciado a partir dos documentos numerados:

- `contracts/` — contratos de interface exatos (REST, WebSocket, IPC
  nativo↔UI, contratos de banco de dados). Estes são a fonte normativa de
  payloads; os documentos numerados (`08`, `09`) explicam o *porquê* e
  remetem a estes para o *shape* exato.
- `state-machines/` — máquinas de estado formais (conexão WebSocket, call,
  peer/negociação perfeita, stream publish/subscribe).
- `testing/` — estratégia de testes detalhada por camada (unit, integration,
  RTC multi-cliente, falhas de rede, UX, aceitação).

### Ordem de leitura sugerida

1. `00-product-overview.md`, `01-scope.md` — o que é o produto e o que não é.
2. `02-requirements.md` — catálogo mestre de requisitos com IDs estáveis
   (raiz de rastreabilidade — todo outro documento cita IDs daqui).
3. `03-non-functional-requirements.md`.
4. `04-system-architecture.md` → `05-client-architecture.md` →
   `06-backend-architecture.md` — visão geral de sistema, depois cada lado.
5. `07-database-design.md`, `08-api-design.md`, `09-websocket-protocol.md` —
   contratos de dados e de rede do lado "app normal" (auth, chat, presence).
6. `10-webrtc-architecture.md` → `11-call-state-machine.md` →
   `12-stream-subscription-model.md` → `13-audio-pipeline.md` →
   `14-screen-share-pipeline.md` → `15-quality-adaptation.md` — a pilha de
   voz/vídeo/tela P2P, do mais estrutural ao mais específico.
7. `16-security.md`, `17-ui-architecture.md`, `18-ux-spec.md`,
   `19-design-system.md` — segurança e camada de apresentação.
8. `20-error-handling.md`, `21-observability.md`, `22-testing-strategy.md`.
9. `23-local-development.md`, `24-deployment.md` — como rodar e como shippar.
10. `25-roadmap.md`, `26-risks-and-tradeoffs.md`, `27-decisions.md`,
    `28-open-questions.md`, `29-definition-of-done.md`,
    `30-v1-delivery-plan.md` — encerramento,
    histórico de decisões (ADR-style) e o que falta decidir de fato.

## Índice completo

| # | Arquivo | Conteúdo |
|---|---------|----------|
| — | `README.md` | Este índice |
| 00 | `00-product-overview.md` | O que é o Talkeando, para quem, por quê |
| 01 | `01-scope.md` | Escopo v1 e fora de escopo, por fase |
| 02 | `02-requirements.md` | Catálogo mestre de requisitos (raiz de rastreabilidade) |
| 03 | `03-non-functional-requirements.md` | Performance, segurança, confiabilidade, observabilidade |
| 04 | `04-system-architecture.md` | Diagrama de topologia cliente/servidor/RTC |
| 05 | `05-client-architecture.md` | C# host + WebView2 + React UI |
| 06 | `06-backend-architecture.md` | Axum, camadas, CallRegistry, WS handler |
| 07 | `07-database-design.md` | Schema completo (SQL + prosa), migrations |
| 08 | `08-api-design.md` | Endpoints REST |
| 09 | `09-websocket-protocol.md` | Catálogo completo de mensagens WS |
| 10 | `10-webrtc-architecture.md` | Mesh P2P, PeerConnection por peer, TURN/STUN |
| 11 | `11-call-state-machine.md` | Estados de uma call/participante |
| 12 | `12-stream-subscription-model.md` | **A spec mais crítica do projeto** |
| 13 | `13-audio-pipeline.md` | Captura, codec, mute/deafen, dispositivos |
| 14 | `14-screen-share-pipeline.md` | WGC, publish/unpublish, janela some |
| 15 | `15-quality-adaptation.md` | Adaptação de bitrate/resolução |
| 16 | `16-security.md` | Auth, TLS/DTLS-SRTP, TURN creds, ameaças |
| 17 | `17-ui-architecture.md` | Estrutura React, estado, roteamento |
| 18 | `18-ux-spec.md` | Fluxos de usuário, estados vazios/erro |
| 19 | `19-design-system.md` | Tokens visuais (cores, fontes, espaçamento) |
| 20 | `20-error-handling.md` | Taxonomia de erros, propagação, retry |
| 21 | `21-observability.md` | Logs, métricas, tracing |
| 22 | `22-testing-strategy.md` | Pirâmide de testes e ferramentas |
| 23 | `23-local-development.md` | docker-compose, rodar server/client/ui |
| 24 | `24-deployment.md` | Deploy do backend, Caddy, coturn, cliente |
| 25 | `25-roadmap.md` | Fases 00–11, P0/P1/P2 |
| 26 | `26-risks-and-tradeoffs.md` | Riscos conhecidos e trade-offs aceitos |
| 27 | `27-decisions.md` | Log ADR de todas as decisões do canon |
| 28 | `28-open-questions.md` | O que genuinamente falta decidir |
| 29 | `29-definition-of-done.md` | Checklist formal de DoD |
| 30 | `30-v1-delivery-plan.md` | Plano executável para a v1 instalável |
| — | `contracts/rest-api.md` | Contrato REST exato |
| — | `contracts/websocket-events.md` | Contrato WS exato |
| — | `contracts/ipc-native-ui.md` | Contrato IPC C# ↔ React |
| — | `contracts/database-contracts.md` | DB-backed vs. efêmero em memória |
| — | `state-machines/websocket.md` | Máquina de estado da conexão WS |
| — | `state-machines/call.md` | Máquina de estado da call |
| — | `state-machines/peer.md` | Perfect negotiation (polite/impolite) |
| — | `state-machines/stream.md` | Publish/subscribe/unsubscribe/unpublish |
| — | `testing/unit.md` | Testes unitários por módulo |
| — | `testing/integration.md` | Testes de integração server↔client |
| — | `testing/rtc.md` | Harness multi-cliente local (A/B/C/D) |
| — | `testing/network-failure.md` | Matriz de falhas de rede e comportamento esperado |
| — | `testing/ux.md` | Testes de UX/usabilidade |
| — | `testing/acceptance.md` | Mapeamento para a lista de aceitação de 21 pontos |

## Convenções usadas em todo o SDD

- **IDs de requisito**: prefixos fixos definidos em `02-requirements.md`
  (ex.: `AUTH-FR-001`, `SUB-FR-003`). Todo requisito, teste e critério de
  aceitação cita um ID; nenhum documento introduz um prefixo novo fora da
  lista canônica.
- **Idioma**: cabeçalhos de seção em português (Status, Objetivo, Contexto,
  Escopo, Fora de escopo, Modelo de dados, etc.), conteúdo técnico em inglês
  onde for mais natural (nomes de tipos, payloads JSON, trechos de código).
  Consistente em todos os arquivos.
- **Sem SFU, sem multi-instância de backend**: todo documento que toca RTC ou
  o `CallRegistry` deve respeitar que há exatamente um processo de backend e
  que mídia nunca passa pelo servidor.
- **Modelo de assinatura de stream é não-negociável**: qualquer documento que
  toque streams de tela/câmera deve ser consistente com
  `12-stream-subscription-model.md` e `state-machines/stream.md` —
  0 assinantes ⇒ 0 envio, sempre.
- **Datas/versões**: este conjunto documenta a v1 (fases 00–11, ver
  `25-roadmap.md`). Não é um contrato "para sempre" — mudanças de decisão
  passam por um novo ADR em `27-decisions.md`, nunca por edição silenciosa de
  uma decisão anterior.
