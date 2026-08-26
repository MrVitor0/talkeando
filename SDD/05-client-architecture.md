# 05 — Client Architecture

Status: Decidido
Owner/Domain: Cliente (nativo + UI)
Requisitos: `UX-FR-*`, `RTC-FR-*`, `AUDIO-FR-*`, `SCREEN-FR-*`, `DEV-FR-*`
Ver também: `04-system-architecture.md`, `contracts/ipc-native-ui.md`,
`17-ui-architecture.md`, `10-webrtc-architecture.md`

## Objetivo

Descrever como o processo cliente Windows é composto internamente: o host
C#/.NET, o WebView2 embutido rodando a UI React, e a divisão de
responsabilidades entre "o que roda nativo" e "o que roda em web".

## Contexto

O cliente é um único processo Windows (`.exe`) com uma janela WPF cujo
conteúdo principal é um controle `Microsoft.Web.WebView2`. Não há processos
separados para UI vs. núcleo nativo — é um único processo com duas
"metades" logicamente separadas (host C# e conteúdo web), comunicando-se
por IPC via `postMessage` (ver `contracts/ipc-native-ui.md`).

## Estrutura de camadas

```
┌─────────────────────────────────────────────────────────────┐
│  Processo .exe (WPF)                                          │
│                                                                 │
│  ┌───────────────────────────────────────────────────────┐    │
│  │ MainWindow (WPF)                                        │    │
│  │  - janela nativa, titlebar padrão (ver 19-design-system) │    │
│  │  - hospeda o controle WebView2                           │    │
│  └───────────────────────┬───────────────────────────────┘    │
│                            │                                    │
│  ┌─────────────────────────▼─────────────────────────────┐    │
│  │ WebView2 control                                         │    │
│  │  - carrega o build Vite da UI React (arquivo local em    │    │
│  │    dev; empacotado em release, ver 24-deployment.md)      │    │
│  │  - window.chrome.webview.postMessage <-> host             │    │
│  └───────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌───────────────────────────────────────────────────────┐    │
│  │ Core nativo (C# libs, mesmo processo)                    │    │
│  │                                                            │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐    │    │
│  │  │ IpcBridge    │  │ SessionStore  │  │ NetworkClient │    │    │
│  │  │ (postMessage │  │ (DPAPI token   │  │ (REST+WS      │    │    │
│  │  │  dispatch)   │  │  storage)      │  │  cliente)     │    │    │
│  │  └─────────────┘  └──────────────┘  └──────────────┘    │    │
│  │                                                            │    │
│  │  ┌─────────────────────────────────────────────────┐     │    │
│  │  │ RtcEngine                                          │     │    │
│  │  │  - PeerControllerManager (um PeerController por    │     │    │
│  │  │    peer remoto ativo — ver state-machines/peer.md) │     │    │
│  │  │  - StreamManager (publish/subscribe local)         │     │    │
│  │  │  - AudioPipeline (captura/render WASAPI)            │     │    │
│  │  │  - ScreenCapturePipeline (Windows.Graphics.Capture) │     │    │
│  │  │  - DeviceMonitor (hot-plug de dispositivos)         │     │    │
│  │  └─────────────────────────────────────────────────┘     │    │
│  └───────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Responsabilidades por módulo

- **`IpcBridge`**: única porta de entrada/saída entre React e C#. Desserializa
  comandos vindos da UI (`System.Text.Json`), despacha para o módulo core
  correto, serializa eventos de volta. Contrato exato em
  `contracts/ipc-native-ui.md`.
- **`SessionStore`**: guarda o token de sessão via
  `System.Security.Cryptography.ProtectedData` (DPAPI, escopo
  usuário+máquina). É o único lugar que lê/escreve o arquivo de sessão local.
  Nunca expõe o token bruto para a camada React — a UI pede ações
  ("login", "logout"), nunca lê o token diretamente (`AUTH-FR-002`).
- **`NetworkClient`**: cliente HTTP (REST) e WS. Mantém a conexão WS viva,
  reencaminha `auth.hello` na reconexão, expõe eventos de alto nível para o
  `IpcBridge` traduzir em eventos de UI.
- **`RtcEngine`**: dono de toda a pilha SIPSorcery. Ver `10-webrtc-architecture.md`
  para o desenho completo. Cada `PeerController` roda sua própria fila de
  comandos serializada — a UI nunca toca um `RTCPeerConnection` diretamente,
  só emite intents ("mute", "publish screen", "subscribe to stream X") que
  o `RtcEngine` traduz em ações de protocolo.
- **`AudioPipeline`**: captura via WASAPI (`SIPSorceryMedia.Windows`),
  encoda Opus, entrega frames ao `RtcEngine`; no sentido inverso, decodifica
  e renderiza áudio recebido. Aplica mute/deafen localmente antes de
  qualquer envio/render (`AUDIO-FR-001/002`).
- **`ScreenCapturePipeline`**: usa `Windows.Graphics.Capture` via projeções
  CsWinRT para capturar um monitor ou janela; entrega frames ao encoder
  H.264 (Media Foundation) para virar uma track de vídeo publicável
  (`SCREEN-FR-003`).
- **`DeviceMonitor`**: escuta eventos de hot-plug de dispositivo de áudio via
  WASAPI (`IMMNotificationClient` ou equivalente gerenciado), notifica o
  `AudioPipeline` e a UI (`DEV-FR-003`, `AUDIO-FR-005/006`).

## Por que WebView2 + React, e não WPF puro

Decisão de canon (stack fixa, não reaberta): a UI é toda em React/TS porque
a equipe de produto/design trabalha em web (o mock de design é HTML/CSS),
e reaproveitar esse investimento é mais barato que portar para XAML. O
custo é a fronteira IPC — mitigado mantendo essa fronteira estreita e bem
tipada (`contracts/ipc-native-ui.md`).

## Threading model (visão geral — detalhe em `10-webrtc-architecture.md` e
`state-machines/peer.md`)

- Thread de UI do WebView2: só renderização e handlers de evento React. Não
  bloqueia em nenhuma chamada de rede — toda operação assíncrona vira uma
  promise resolvida por um evento IPC vindo do host.
- Cada `PeerController` roda em sua própria task assíncrona com uma fila de
  comandos (mailbox) — serializa todo acesso ao `RTCPeerConnection`
  correspondente, prevenindo condições de corrida entre, por exemplo, um
  `subscribe` recebido e um ICE restart em andamento (`RTC-FR-003`).
- `AudioPipeline`/`ScreenCapturePipeline` rodam em threads dedicadas
  (real-time-ish) para não sofrer com o GC do resto do app nem com jank da
  UI (`PERF-NFR-003`).

## Empacotamento e distribuição

Ver `24-deployment.md` para o processo completo de build/instalação. Em
resumo: `dotnet publish` self-contained para `.exe`, com o build de
produção do Vite (`npm run build`) embutido como assets locais carregados
pelo WebView2 (sem servidor de dev, sem dependência de rede para carregar a
própria UI).
