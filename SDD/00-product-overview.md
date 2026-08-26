# 00 — Product Overview

Status: Decidido (v1 baseline)
Owner/Domain: Produto (todos os domínios)
Ver também: `01-scope.md`, `25-roadmap.md`, `27-decisions.md`

## Objetivo

Talkeando é um aplicativo desktop Windows, no estilo Discord, para uma
**comunidade privada fixa de até ~10 pessoas** (amigos, guilda de jogo,
equipe pequena). Ele resolve o mesmo problema central que o Discord resolve
— texto persistente organizado por canais + voz/vídeo/compartilhamento de
tela em tempo real — mas como um sistema auto-hospedado, de implantação
única, sem as preocupações de escala, moderação em massa ou multi-tenant de
uma plataforma pública.

## Contexto

O grupo-alvo já usa ferramentas como Discord, mas quer um sistema que:
- Rode com infraestrutura própria (um servidor Rust + Postgres + coturn +
  Caddy, tipicamente uma única VM/host).
- Não dependa de uma SFU de terceiros para mídia — voz e vídeo trafegam
  P2P entre os próprios participantes (ver `10-webrtc-architecture.md`).
- Tenha uma superfície de ataque pequena e auditável: sem multi-tenant real,
  sem cadastro público, convites controlados.

Não é um produto para adquirir usuários externos; é uma ferramenta interna
para um grupo fechado e conhecido. Isso simplifica (e restringe
deliberadamente) várias decisões de arquitetura — ver `01-scope.md` e
`26-risks-and-tradeoffs.md`.

## Quem usa

- **Membro comum**: participa de canais de texto e voz, envia mensagens e
  anexos, entra em calls, compartilha tela/câmera.
- **Owner da comunidade**: além do acima, cria canais/categorias e convites
  (ver `CHAN-FR-*`, `AUTH-FR-005`). Em v1 há apenas os papéis
  `owner`/`member` (`community_members.role`), sem granularidade adicional.

## Pilares do produto (o que não pode quebrar)

1. **Persistência de chat correta** — mensagens, edições e exclusões
   (soft-delete) sobrevivem a reconexões e restarts do servidor
   (`CHAT-FR-*`, `07-database-design.md`).
2. **Presença confiável** — todo cliente sabe quem está online/idle/offline
   em tempo real (`PRES-FR-*`).
3. **Voz P2P que realmente funciona atrás de NAT/CGNAT** — via STUN, e
   quando necessário, TURN com credenciais de curta duração
   (`RTC-FR-*`, `16-security.md`).
4. **Modelo de assinatura de stream é exato** — nenhum byte de vídeo/tela
   trafega para um peer que não pediu explicitamente para ver aquele stream
   (`SUB-FR-*`, `12-stream-subscription-model.md`). Esta é a regra mais
   importante de todo o sistema — ver essa seção antes de tocar em qualquer
   código de streaming.
5. **Reconexão não corrompe estado** — perda de WebSocket, troca de
   rede (Wi-Fi→Ethernet), ou crash do processo do peer nunca deixam o
   `CallRegistry` ou os `PeerConnection`s em estado inconsistente
   (`WS-FR-002`, `state-machines/websocket.md`, `testing/network-failure.md`).

## Stack (referência rápida — decisão completa em `04`–`06` e `27-decisions.md`)

| Camada | Tecnologia |
|---|---|
| Backend | Rust, Tokio, Axum, SQLx, Postgres 16, Tracing, UUID v4 |
| Cliente nativo | C#/.NET 6, WPF host, `Microsoft.Web.WebView2` |
| UI | TypeScript + React + Vite, rodando dentro do WebView2 |
| Mídia RTC | SIPSorcery + `SIPSorceryMedia.Windows` (Opus, H.264/VP8, WGC) |
| Infra | Caddy (TLS reverso), coturn (TURN) |

## Não-objetivos explícitos

Ver `01-scope.md` para a lista completa "Fora de escopo". Em resumo:
não é SaaS, não é multi-plataforma (Windows only v1), não tem SFU, não tem
E2EE além de TLS/DTLS-SRTP, não escala horizontalmente (um único processo de
backend é uma restrição de v1, não um bug).
