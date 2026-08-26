# 04 — System Architecture

Status: Decidido
Owner/Domain: Arquitetura geral
Requisitos: transversal — ver `02-requirements.md`
Ver também: `05-client-architecture.md`, `06-backend-architecture.md`,
`10-webrtc-architecture.md`

## Objetivo

Dar a visão de topologia completa: quais processos existem, o que fala com
o quê, e — mais importante — deixar claro que o backend é **plano de
controle apenas**: nenhum byte de mídia (áudio/vídeo/tela) passa pelo
servidor Rust em nenhuma circunstância de v1.

## Contexto

Cada um dos ~10 usuários roda um cliente Windows (C#/.NET host + WebView2 +
React) na própria máquina, em redes domésticas distintas (potencialmente
atrás de CGNAT). Existe um único servidor (VM/host) rodando o backend Rust,
Postgres, coturn e Caddy — tipicamente na mesma máquina ou LAN.

## Diagrama de topologia

```
                                   ┌─────────────────────────────────────────┐
                                   │              SERVER HOST                 │
                                   │                                           │
                                   │   ┌───────────┐        ┌──────────────┐  │
  HTTPS/WSS  ───────────────────▶ │   │   Caddy    │──────▶ │   Axum       │  │
  (porta 443)                     │   │ (TLS term.)│  :8080 │   backend    │  │
                                   │   └───────────┘        │  (Rust/Tokio)│  │
                                   │                         │              │  │
                                   │                         │  ┌────────┐  │  │
                                   │                         │  │  REST  │  │  │
                                   │                         │  │ handlers│ │  │
                                   │                         │  └────────┘  │  │
                                   │                         │  ┌────────┐  │  │
                                   │                         │  │   WS   │  │  │
                                   │                         │  │ hub    │  │  │
                                   │                         │  └────────┘  │  │
                                   │                         │  ┌────────┐  │  │
                                   │                         │  │  Call  │  │  │
                                   │                         │  │Registry│  │  │
                                   │                         │  │(in-mem)│  │  │
                                   │                         │  └────────┘  │  │
                                   │                         └──────┬───────┘  │
                                   │                                │ SQL      │
                                   │                         ┌──────▼───────┐  │
                                   │                         │  PostgreSQL  │  │
                                   │                         │      16      │  │
                                   │                         └──────────────┘  │
                                   │                                           │
                                   │   ┌────────────────┐                     │
                                   │   │     coturn      │◀── STUN/TURN ──┐   │
                                   │   │ (UDP 3478/5349,  │                │   │
                                   │   │  relay ports)    │                │   │
                                   │   └────────────────┘                  │   │
                                   └───────────────────────────────────────┼───┘
                                                                            │
                    control plane: REST + WSS (JSON envelopes)             │ media relay
                    (auth, chat, presence, invites, signaling)             │ (only when P2P fails)
                                                                            │
        ┌───────────────────────────────────────────────────────────────┐ │
        │                                                                │ │
┌───────▼────────┐        ┌─────────────────┐        ┌─────────────────▼─▼───┐
│  Client A (Win) │        │  Client B (Win)  │        │  Client C (Win)       │
│ ┌─────────────┐ │        │ ┌──────────────┐ │        │ ┌────────────────┐   │
│ │ React UI    │ │        │ │  React UI     │ │        │ │  React UI      │   │
│ │ (WebView2)  │ │        │ │  (WebView2)   │ │        │ │  (WebView2)    │   │
│ └──────┬──────┘ │        │ └───────┬──────┘ │        │ └────────┬───────┘   │
│        │ IPC    │        │         │ IPC     │        │          │ IPC       │
│ ┌──────▼──────┐ │        │ ┌───────▼──────┐ │        │ ┌────────▼───────┐   │
│ │ C# host      │ │        │ │  C# host     │ │        │ │  C# host       │   │
│ │ + SIPSorcery │ │        │ │ + SIPSorcery  │ │        │ │ + SIPSorcery   │   │
│ └──────┬──────┘ │        │ └───────┬──────┘ │        │ └────────┬───────┘   │
└────────┼────────┘        └─────────┼────────┘        └──────────┼───────────┘
         │                            │                            │
         │◀════════ RTCPeerConnection A↔B (Opus/H.264, DTLS-SRTP) ═▶│
         │◀══════════════════════ RTCPeerConnection A↔C ════════════▶
                      │◀═══════════════════ RTCPeerConnection B↔C ══▶│

  Legenda: ═══ mídia P2P direta (ou via TURN relay quando ICE direto falha)
           ─── controle (REST/WSS), nunca carrega mídia
```

Com 4 participantes em uma call, o mesh forma 6 `RTCPeerConnection`s no
total (cada cliente mantém 3). O servidor nunca aparece nesse grafo de
mídia — ele apenas: (1) autentica e autoriza quem pode entrar em qual call,
(2) faz relay de `rtc.offer`/`rtc.answer`/`rtc.ice` como mensagens de
sinalização opacas, (3) emite credenciais TURN de curta duração, (4)
mantém o `CallRegistry` em memória (`06-backend-architecture.md`).

## Componentes e responsabilidades

| Componente | Responsabilidade | Nunca faz |
|---|---|---|
| Caddy | Terminação TLS, proxy reverso para Axum | Lógica de aplicação |
| Axum backend | Auth, REST, WS hub, `CallRegistry`, autorização de sinalização, persistência via SQLx | Tocar bytes de mídia; decodificar RTP/RTCP |
| PostgreSQL | Persistência durável (`07-database-design.md`) | Guardar estado de call/stream/peer (isso é in-memory, `06-backend-architecture.md` §CallRegistry) |
| coturn | STUN (descoberta de endereço público) e TURN (relay de mídia quando P2P direto falha) | Autenticar usuários da aplicação (usa apenas credenciais HMAC de curta duração emitidas pelo backend) |
| Cliente C# host | Ciclo de vida da janela, WebView2, pilha SIPSorcery, captura de áudio/vídeo/tela, IPC com a UI | Renderizar UI (isso é responsabilidade do React) |
| React UI | Toda a apresentação, estado de UI, chamadas de IPC para ações nativas | Falar diretamente com a rede (WS/REST) fora do que o host expõe via IPC — ver `contracts/ipc-native-ui.md` para o desenho exato dessa fronteira |

## Fronteiras de confiança

- Cliente ↔ Servidor: fronteira de confiança real. Todo dado vindo do
  cliente é validado/autorizado no servidor (`CALL-FR-006`, `SEC-NFR-006`).
- C# host ↔ React UI (dentro do mesmo processo cliente): não é uma
  fronteira de segurança (mesma máquina, mesmo usuário), mas é uma
  fronteira de contrato — ver `contracts/ipc-native-ui.md`.
- Cliente ↔ Cliente (mídia P2P): autenticado indiretamente — um peer só
  troca SDP/ICE com outro se o servidor autorizou o relay da sinalização
  (ambos são participantes da mesma call); a criptografia DTLS-SRTP em si
  não depende de identidade de aplicação, mas o *roteamento* da sinalização
  sim (`RTC-FR-008`).

## Por que P2P mesh e não SFU (referência rápida)

Ver `10-webrtc-architecture.md` e `26-risks-and-tradeoffs.md` para a
justificativa completa. Resumo: com ≤10 pessoas e tipicamente ≤4-5
participantes simultâneos em voz, o custo de operar/manter uma SFU não se
paga; mesh completo é mais simples de implementar corretamente e mantém o
servidor sem qualquer responsabilidade de mídia (menor superfície, menor
custo de infra, sem transcoding).
