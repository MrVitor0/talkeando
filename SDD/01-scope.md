# 01 — Scope

Status: Decidido (v1 baseline)
Owner/Domain: Produto
Ver também: `00-product-overview.md`, `25-roadmap.md`, `26-risks-and-tradeoffs.md`

## Objetivo

Definir precisamente o que a v1 do Talkeando entrega e o que fica de fora,
para que nenhum engenheiro (humano ou LLM) reintroduza escopo não decidido
"porque o Discord tem" nem corte silenciosamente algo que já foi decidido.

## Escopo v1 (o que É entregue)

Mapeado às fases em `25-roadmap.md` (phase-00 a phase-07 + fatia de
reconexão da phase-10 = P0 / "feature base"):

- Autenticação usuário+senha, sessão de 30 dias, registro por convite
  (`AUTH-FR-*`).
- Uma única comunidade (`communities` com 1 linha seed), categorias e
  canais de texto/voz (`CHAN-FR-*`).
- Chat persistente: enviar, editar, excluir (soft-delete), histórico
  paginado, indicador de digitação efêmero (`CHAT-FR-*`).
- Anexos de arquivo em mensagens (`ATTACH-FR-*`).
- Presença online/idle/offline em tempo real (`PRES-FR-*`).
- Voz P2P em mesh completo, com mute/deafen, TURN como fallback
  obrigatório, ICE restart em troca de rede (`CALL-FR-*`, `RTC-FR-*`,
  `AUDIO-FR-*`).
- Compartilhamento de tela com o modelo de assinatura explícito e real
  (publish não implica envio; subscribe é obrigatório) (`SCREEN-FR-*`,
  `SUB-FR-*`).
- Reconexão de WebSocket sem corromper estado de call/presença
  (`WS-FR-002`).
- Tema escuro único, seguindo os tokens visuais extraídos do mock
  (`19-design-system.md`).

## Escopo P1 (entregue após o feature base, mesma v1)

- Câmera como stream publicável, no mesmo modelo de assinatura da tela
  (`CAM-FR-*`, phase-08).
- Adaptação de qualidade além de um baseline ingênuo — ajuste de
  bitrate/resolução sob perda de pacote/RTT alto (`QUAL-FR-*`, phase-09).

## Escopo P2 (polimento/release, mesma v1)

- Hardening restante (reconexão sob falhas mais exóticas, ver
  `testing/network-failure.md`) e empacotamento/release (phase-11,
  `24-deployment.md`).

## Fora de escopo (v1) — cortes explícitos, não ausências acidentais

Cada item abaixo é uma decisão registrada, não uma lacuna:

| Item cortado | Onde fica documentado | Observação |
|---|---|---|
| SFU / mixagem de mídia no servidor | `10-webrtc-architecture.md`, `26-risks-and-tradeoffs.md` | Mesh P2P puro; servidor nunca toca bytes de mídia |
| Cliente mobile/macOS/Linux | `00-product-overview.md` | Windows-only v1 |
| Troca entre múltiplas comunidades na UI | `07-database-design.md` (`communities` existe, mas v1 opera 1 linha) | Modelo de dados já suporta; UI não |
| Permissões granulares por canal (UI) | `07-database-design.md` (`channel_members` existe, não é aplicado) | Enforcement é só "é membro da comunidade" |
| Busca de mensagens | `CHAT-FR-*` (não incluído) | — |
| Push notification para celular | `NOTIF-FR-*` | Apenas indicadores in-app |
| E2EE além de TLS + DTLS-SRTP | `16-security.md` | Transporte seguro, não E2EE de aplicação |
| Escala horizontal / múltiplas instâncias de backend | `06-backend-architecture.md`, `26-risks-and-tradeoffs.md` | `CallRegistry` é in-memory de processo único — restrição dura de v1 |
| Read receipts | `CHAT-FR-*` | — |
| UI de reações a mensagem | `07-database-design.md` (`reactions` existe) | Tabela existe para uso futuro; sem UI em v1 |
| Fallback GDI `BitBlt` para captura de tela | `14-screen-share-pipeline.md` | Apenas documentado como seam futuro; WGC é o único caminho implementado |
| Chrome de janela customizado (titlebar do mock) | `19-design-system.md`, `17-ui-architecture.md` | Titlebar nativo padrão (WPF/Win32) com dark mode via DWM; visual customizado é polimento futuro |

## Critérios de saída de escopo (quando algo "fora de escopo" pode entrar)

Um item da tabela acima só entra em uma fase futura via um novo ADR em
`27-decisions.md` que referencie explicitamente esta linha e explique o que
mudou (ex.: "multi-instância de backend" só faria sentido se o produto
deixasse de ser uma implantação única de ~10 pessoas — mudança de
identidade de produto, não um ajuste incremental).
